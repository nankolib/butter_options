// =============================================================================
// splDecode.ts — SPL Token transfer decoding (PURE)
// =============================================================================
//
// Decodes plain `Transfer` (ix tag 3) and `TransferChecked` (tag 12) of the
// devnet USDC mint out of a raw transaction. Used by both Part A loops:
// the faucet-wallet loop and the per-ATA external-flow loop.
//
// The MINT IS INJECTED, never hardcoded here — env.ts resolves it from config
// and main.ts asserts it on chain at boot. (A one-character-off mint address is
// exactly the kind of thing that silently produces an empty, plausible-looking
// tape.)
//
// `Transfer` (tag 3) carries NO mint in its accounts, so a transfer is only
// attributable to our mint when we already know the token account's mint —
// which the caller supplies via `knownAtas`. TransferChecked (tag 12) names the
// mint directly and is self-verifying.
// =============================================================================

import bs58 from "bs58";

export const TOKEN_PROGRAM_ID = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const IX_TRANSFER = 3;
const IX_TRANSFER_CHECKED = 12;

export interface SplTransfer {
  /** Source token account (an ATA, not a wallet). */
  source: string;
  /** Destination token account. */
  destination: string;
  /** Authority that signed the transfer (usually the source owner). */
  authority: string;
  amount: bigint;
  /** Position among all decoded transfers in the tx — the id ordinal. */
  ordinal: number;
  /** True when decoded from TransferChecked, i.e. the mint was verified inline. */
  mintVerified: boolean;
}

export interface RawIx {
  programIdIndex: number;
  accounts: number[];
  data: string;
}

/**
 * Extract USDC transfers from a transaction's instruction list.
 *
 * `knownAtas` maps token-account -> mint for accounts we have already resolved.
 * A plain Transfer is accepted only when its source or destination is a known
 * ATA of `usdcMint`; a TransferChecked is accepted whenever its mint account
 * equals `usdcMint`.
 */
export function decodeUsdcTransfers(
  ixs: readonly RawIx[],
  keys: readonly string[],
  usdcMint: string,
  knownAtas: ReadonlyMap<string, string>,
): SplTransfer[] {
  const out: SplTransfer[] = [];
  let ordinal = -1;

  for (const ix of ixs) {
    if (keys[ix.programIdIndex] !== TOKEN_PROGRAM_ID) continue;
    let data: Uint8Array;
    try {
      data = bs58.decode(ix.data);
    } catch {
      continue;
    }
    if (data.length < 1) continue;
    const tag = data[0];
    if (tag !== IX_TRANSFER && tag !== IX_TRANSFER_CHECKED) continue;
    if (data.length < 9) continue;

    const amount = Buffer.from(data.subarray(1, 9)).readBigUInt64LE(0);
    const acc = ix.accounts.map((i) => keys[i]).filter((k): k is string => k != null);

    if (tag === IX_TRANSFER) {
      // [source, destination, authority]
      if (acc.length < 3) continue;
      const [source, destination, authority] = acc;
      const isOurs = knownAtas.get(source) === usdcMint || knownAtas.get(destination) === usdcMint;
      if (!isOurs) continue;
      ordinal += 1;
      out.push({ source, destination, authority, amount, ordinal, mintVerified: false });
    } else {
      // [source, mint, destination, authority]
      if (acc.length < 4) continue;
      const [source, mint, destination, authority] = acc;
      if (mint !== usdcMint) continue;
      ordinal += 1;
      out.push({ source, destination, authority, amount, ordinal, mintVerified: true });
    }
  }
  return out;
}
