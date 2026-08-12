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
};

export type AccountName =
  | "optionsMarket" | "protocolState"
  | "sharedVault" | "writerPosition" | "vaultMint" | "epochConfig"
  | "settlementRecord" | "vaultResaleListing" | "restingOrder"
  | "writerAskPosition";

export async function safeFetchAll<T>(
  program: Program<any>,
  accountName: AccountName,
): Promise<{ publicKey: PublicKey; account: T }[]> {
  const discriminator = DISCRIMINATORS[accountName];
  if (!discriminator) throw new Error(`Unknown account: ${accountName}`);

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
