// =============================================================================
// utils/authoritativeSeries.ts — the addresses a transaction is built from
// =============================================================================
//
// THE BOUNDARY, CONCRETELY
//
//   The grid renders from the indexer. Its rows carry display fields (strike,
//   expiry, type, bid/ask) AND identity fields (vault, optionMint) — and the
//   ticket puts those identity fields straight into `accountsStrict`. An index
//   row is a cache; a transaction is not a place for cached addresses.
//
//   So on focus, before ANY assembly, the series is re-read CHAIN-DIRECT and the
//   row's addresses are checked against it. Two accounts, on click — not a scan.
//
// THIS READ IS AUTHORITATIVE, NOT BEST-EFFORT
//
//   If it fails, times out, or disagrees with the row, the ticket BLOCKS with an
//   honest error. It must never quietly fall back to the index row's addresses,
//   because the entire reason for reading is that the row might be wrong. A
//   fallback would reintroduce exactly the risk this removes, and would do it
//   silently, on the path that signs.
//
//   "Slow or refusing" is an acceptable failure here. "Built from unverified
//   addresses" is not.
// =============================================================================

import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";

/** Identity fields as the index reported them. */
export interface RowIdentity {
  vault: string;
  optionMint: string;
}

/** What the chain says, decoded from the vault + its series record. */
export interface ChainIdentity {
  /** The vault account exists and decodes at the current layout. */
  vaultExists: boolean;
  /** optionMint from the series (VaultMint) record that backs this vault. */
  optionMint: string | null;
}

export type Verdict =
  | { ok: true; vault: string; optionMint: string }
  | { ok: false; reason: string };

/**
 * Compare what the index claimed against what the chain says.
 *
 * Pure, so every refusal path is testable without a wallet or an RPC. The
 * dangerous direction is returning ok:true on anything unverified — that is a
 * built transaction against an address nobody checked.
 */
export function verifyIdentity(row: RowIdentity, chain: ChainIdentity | null): Verdict {
  if (!row?.vault || !row?.optionMint) {
    return { ok: false, reason: "This contract is missing its on-chain address. Reload and try again." };
  }
  // A failed or timed-out read lands here. Refuse: the point of reading was that
  // the row might be wrong, so an unread row is exactly as untrusted.
  if (!chain) {
    return { ok: false, reason: "Could not confirm this contract on-chain. Nothing was submitted — try again." };
  }
  if (!chain.vaultExists) {
    return { ok: false, reason: "This contract no longer exists on-chain. Refresh the board." };
  }
  if (!chain.optionMint) {
    return { ok: false, reason: "Could not confirm this contract's series on-chain. Nothing was submitted." };
  }
  if (chain.optionMint !== row.optionMint) {
    // The poisoned-row case. The board offered one mint; the chain backs another.
    return {
      ok: false,
      reason: "This contract's on-chain details do not match the board. Refresh before trading.",
    };
  }
  return { ok: true, vault: row.vault, optionMint: chain.optionMint };
}

/** Bounded: a hung RPC must produce a refusal, not a spinner that never ends. */
export const FOCUS_READ_TIMEOUT_MS = 8_000;

/**
 * Read the vault and its series record chain-direct.
 *
 * Returns null on ANY failure so the caller refuses rather than guesses. It
 * deliberately does not retry: the user is waiting with a ticket open, and a
 * fast honest refusal beats a slow uncertain success.
 */
export async function readChainIdentity(
  connection: Connection,
  vault: PublicKey,
  seriesRecord: PublicKey | null,
  decodeSeriesOptionMint: (data: Buffer) => string | null,
  vaultIsCurrentLayout: (data: Buffer) => boolean,
): Promise<ChainIdentity | null> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), FOCUS_READ_TIMEOUT_MS));
  const work = (async (): Promise<ChainIdentity | null> => {
    try {
      const keys = seriesRecord ? [vault, seriesRecord] : [vault];
      const infos = await connection.getMultipleAccountsInfo(keys, "confirmed");
      const vaultInfo = infos[0];
      if (!vaultInfo) return { vaultExists: false, optionMint: null };
      if (!vaultIsCurrentLayout(vaultInfo.data as Buffer)) {
        // A superseded layout cannot be trusted to say anything about itself.
        return { vaultExists: false, optionMint: null };
      }
      const seriesInfo = seriesRecord ? infos[1] : null;
      const optionMint = seriesInfo ? decodeSeriesOptionMint(seriesInfo.data as Buffer) : null;
      return { vaultExists: true, optionMint };
    } catch {
      return null;
    }
  })();
  return Promise.race([work, timeout]);
}

// ---------------------------------------------------------------------------
// The call site's entry point
// ---------------------------------------------------------------------------

import { utils } from "@coral-xyz/anchor";
import { Buffer } from "buffer";

/** VaultMint layout: disc(8) | vault(32) | writer(32) | option_mint(32) | … */
const VAULT_MINT_DISC = [219, 139, 146, 175, 62, 90, 224, 254];
const VAULT_MINT_LEN = 137;
const SHARED_VAULT_LEN = 276;

/**
 * Resolve the authoritative (vault, optionMint) pair for a focused row.
 *
 * The mint is found by a memcmp on VaultMint.vault, which is what BINDS the two:
 * reading the mint account alone would prove it exists, not that it belongs to
 * this vault — and belonging is the property a transaction depends on.
 *
 * Scoped by design: one filtered lookup plus one account read, on click. Not a
 * scan, and nowhere near the cost this whole read path removed.
 */
export async function resolveAuthoritativeSeries(
  connection: Connection,
  programId: PublicKey,
  row: RowIdentity,
): Promise<Verdict> {
  const chain = await (async (): Promise<ChainIdentity | null> => {
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), FOCUS_READ_TIMEOUT_MS));
    const work = (async (): Promise<ChainIdentity | null> => {
      try {
        const vaultPk = new PublicKey(row.vault);
        const info = await connection.getAccountInfo(vaultPk, "confirmed");
        if (!info) return { vaultExists: false, optionMint: null };
        // A superseded layout cannot be trusted to describe itself.
        if (info.data.length !== SHARED_VAULT_LEN) return { vaultExists: false, optionMint: null };

        const found = await connection.getProgramAccounts(programId, {
          commitment: "confirmed",
          filters: [
            { memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(Buffer.from(VAULT_MINT_DISC)) } },
            { memcmp: { offset: 8, bytes: row.vault } },
          ],
        });
        for (const a of found) {
          const d = a.account.data as Buffer;
          if (d.length !== VAULT_MINT_LEN) continue;
          const mint = new PublicKey(d.subarray(72, 104)).toBase58();
          // The row's mint must be one this vault actually backs.
          if (mint === row.optionMint) return { vaultExists: true, optionMint: mint };
        }
        // The vault exists but backs no series matching the row. Report the
        // first real one so the mismatch message is truthful rather than "none".
        const first = found.find((a) => (a.account.data as Buffer).length === VAULT_MINT_LEN);
        return {
          vaultExists: true,
          optionMint: first ? new PublicKey((first.account.data as Buffer).subarray(72, 104)).toBase58() : null,
        };
      } catch {
        return null;
      }
    })();
    return Promise.race([work, timeout]);
  })();

  return verifyIdentity(row, chain);
}
