/**
 * Safe account fetching that handles old-format accounts from previous deployments.
 *
 * Uses memcmp on the 8-byte Anchor discriminator to filter by account type,
 * then decodes each individually — skipping any that fail to deserialize.
 * Also validates decoded data to filter out stale accounts.
 */
import { PublicKey } from "@solana/web3.js";
import { Program } from "@coral-xyz/anchor";
import { coalescedProgramAccounts, invalidateProgramAccounts } from "../utils/programAccounts";
import {
  claimRevalidation, invalidateScanCache, lookupScan, releaseRevalidation, storeScan,
} from "../utils/accountScanCache";
import { getIndexerReader } from "../utils/indexerRegistry";

// Account discriminators from the current IDL
const DISCRIMINATORS: Record<string, number[]> = {
  optionsMarket: [67, 30, 90, 36, 130, 219, 166, 8],
  protocolState: [33, 51, 173, 134, 35, 140, 195, 248],
  // V2 vault accounts
  sharedVault: [195, 36, 66, 128, 41, 62, 161, 142],
  writerPosition: [195, 252, 56, 77, 221, 13, 8, 69],
  vaultMint: [219, 139, 146, 175, 62, 90, 224, 254],
  epochConfig: [190, 66, 87, 197, 214, 153, 144, 193],
  // Stage P2 — per-(asset, expiry) settlement record
  settlementRecord: [172, 159, 67, 74, 96, 85, 37, 205],
  // Stage Secondary 1 — V2 secondary listing record
  vaultResaleListing: [122, 137, 187, 45, 94, 125, 117, 110],
  // Phase 1 exchange book — RestingOrder
  restingOrder: [125, 151, 65, 43, 90, 207, 190, 104],
  // Phase 3 writer-asks — the account a modern /write actually produces.
  // SLICE 2B: absent here until now, which is why Portfolio → WRITTEN read
  // "Nothing written" for every user on the writer-ask path.
  writerAskPosition: [153, 60, 106, 50, 105, 8, 111, 54],
  // Phase 3 writer-asks — the per-series COLLATERAL pot. Absent here until
  // 2026-08-15, which is why the early-exercise gate rendered the unfunded copy
  // on every writer-ask series: the loader had no way to look a pot up, so
  // earlyExerciseAvailability was called without one and stayed conservative.
  writerAskPot: [144, 146, 126, 56, 17, 59, 177, 215],
};

export type AccountName =
  | "optionsMarket" | "protocolState"
  | "sharedVault" | "writerPosition" | "vaultMint" | "epochConfig"
  | "settlementRecord" | "vaultResaleListing" | "restingOrder"
  | "writerAskPosition" | "writerAskPot";

export interface FetchScope {
  /**
   * Fetch only this market's board. RENDERING CONTEXT ONLY — it comes from
   * which board is on screen, never from anything assembling a transaction.
   * Narrowing a read that feeds tx assembly would hand the builder a partial
   * view of the world, which is how you sign against a series you cannot see.
   *
   * Advisory: the chain fallback cannot filter, so a caller must still tolerate
   * receiving every board.
   */
  market?: string;
}

export async function safeFetchAll<T>(
  program: Program<any>,
  accountName: AccountName,
  scope?: FetchScope,
): Promise<{ publicKey: PublicKey; account: T }[]> {
  const discriminator = DISCRIMINATORS[accountName];
  if (!discriminator) throw new Error(`Unknown account: ${accountName}`);

  const programId = program.programId.toBase58();
  const market = scope?.market ?? "";

  // INDEXER READ PATH. Structural types can be served pre-decoded over HTTP
  // instead of pulling ~5.4MB of raw accounts through getProgramAccounts. It is
  // an ACCELERATOR, never a dependency: fetchFromIndexer returns null for any
  // reason at all — flag off, unreachable, stale, wrong shape — and the code
  // below then does exactly what it did before. Degraded costs the user the old
  // load time; it must never cost them the page.
  // Cacheable types are served with NO network call inside FRESH_MS — that is
  // what removes the repeat scan waves measured at 3.1s / 6.0s / 7.1s. Book and
  // position types never get here: isCacheableScan is an opt-in allowlist, so
  // they fall straight through to a fresh scan every time.
  const cached = lookupScan<T>(programId, accountName, Date.now(), market);
  if (cached.hit) {
    if (cached.stale && claimRevalidation(programId, accountName, market)) {
      // Refresh BEHIND the render, deliberately not awaited — the caller already
      // holds usable data, and blocking on this would defeat the cache entirely.
      void fetchAndDecodeScan<T>(program, accountName, discriminator)
        .then((rows) => storeScan(programId, accountName, rows, Date.now(), ""))
        .catch(() => {
          // A failed background refresh leaves the existing entry alone: it gets
          // retried on the next read, or aged out by MAX_STALE_MS. Throwing here
          // would surface as an unhandled rejection with no caller to catch it.
        })
        .finally(() => releaseRevalidation(programId, accountName, market));
    }
    return cached.rows;
  }

  // ORDER MATTERS. This sits AFTER the cache lookup, not before it: an earlier
  // version asked the indexer first, so every caller hit the network and the
  // cache never got a chance — measured as /api/chain/vaults being fetched twice
  // per load (3.74MB each) even with in-flight dedup, because the second wave
  // arrives seconds later once the first has settled.
  // The reader is REGISTERED by the FE at startup and is absent in the crank,
  // which therefore reads chain directly — correct, since a keeper deciding
  // whether to fire must never act on an index. See utils/indexerRegistry.ts for
  // why this is not a plain import.
  const indexer = getIndexerReader();
  if (indexer) {
    const viaIndexer = (await indexer(accountName, market ? { market } : undefined)) as
      | { rows: { publicKey: PublicKey; account: T }[]; slot: number; ageSec: number }
      | null;
    if (viaIndexer) {
      // Cached under the scope ACTUALLY fetched, so a one-board result can never
      // be served to a caller that asked for every board.
      storeScan(programId, accountName, viaIndexer.rows, Date.now(), market);
      return viaIndexer.rows;
    }
  }

  // The chain scan cannot filter, so it always yields every board and is cached
  // under the unfiltered scope regardless of what was asked for.
  const rows = await fetchAndDecodeScan<T>(program, accountName, discriminator);
  storeScan(programId, accountName, rows, Date.now(), "");
  return rows;
}

/**
 * The scan itself, plus the decode/validation rules. Split out of safeFetchAll so
 * the background revalidation above runs the identical path — a second, subtly
 * different decoder is exactly how a cache starts serving a different shape than
 * the fresh path.
 */
async function fetchAndDecodeScan<T>(
  program: Program<any>,
  accountName: AccountName,
  discriminator: number[],
): Promise<{ publicKey: PublicKey; account: T }[]> {
  const connection = program.provider.connection;

  // Fetch all accounts owned by our program with matching discriminator.
  // Coalesced + timeout-bounded (see programAccounts.ts) so concurrent identical
  // scans across hooks collapse into one request and can't hang indefinitely.
  const rawAccounts = await coalescedProgramAccounts(
    connection,
    program.programId,
    discriminator,
  );

  // Decode each account individually, skipping decode failures
  const decoded: { publicKey: PublicKey; account: T }[] = [];
  const seen = new Set<string>(); // deduplicate by key

  for (const raw of rawAccounts) {
    try {
      const account = program.coder.accounts.decode(
        accountName,
        raw.account.data,
      ) as any;

      // Extra validation: skip accounts that decoded but have wrong shape
      if (accountName === "optionsMarket") {
        // Current format has assetName (string). Old format had underlyingAsset (enum).
        if (typeof account.assetName !== "string" || !account.assetName) continue;
        // Post-migration markets have assetClass 0-4. Old markets read garbage (249-255).
        if (typeof account.assetClass !== "number" || account.assetClass > 4) continue;
      }

      // Deduplicate — same PDA from different fetches shouldn't appear twice
      const key = raw.pubkey.toBase58();
      if (seen.has(key)) continue;
      seen.add(key);

      decoded.push({ publicKey: raw.pubkey, account: account as T });
    } catch {
      // Skip old-format accounts that can't be decoded
    }
  }

  return decoded;
}

/**
 * invalidateAccountScans — drop the in-flight coalesced scan for each named
 * account type, so the NEXT safeFetchAll starts a FRESH getProgramAccounts
 * instead of joining a snapshot taken before a just-confirmed mutation.
 *
 * The invalidate-before-refetch primitive behind the Portfolio settle/claim
 * mutation-refresh fix: Portfolio reads every ledger via safeFetchAll (coalesced,
 * no TTL) and useVaults does NOT subscribe to the mutationBus, so a post-action
 * refetch could otherwise be served a pre-mutation scan (the stale-until-reload
 * bug fixed on Trade). Call this with the account types the refetch reads, then
 * refetch. Unknown names are skipped defensively.
 */
export function invalidateAccountScans(
  program: Program<any>,
  accountNames: readonly AccountName[],
): void {
  for (const name of accountNames) {
    const disc = DISCRIMINATORS[name];
    if (disc) invalidateProgramAccounts(program.programId, disc);
    // The cached snapshot must die with the in-flight one. Dropping only the
    // in-flight scan would leave a cached pre-mutation entry to be served for up
    // to MAX_STALE_MS — the stale-UI-after-cancel bug this primitive was written
    // to fix, with a far longer window.
    invalidateScanCache(program.programId.toBase58(), name);
  }
}

/** Encode bytes as base58 for RPC memcmp filter. */
function bs58Encode(bytes: Buffer): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let str = "";
  for (const byte of bytes) {
    if (byte !== 0) break;
    str += "1";
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    str += ALPHABET[digits[i]];
  }
  return str;
}
