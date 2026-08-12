// =============================================================================
// askRows.ts — SLICE 2B: the writes that were invisible. READ-ONLY.
// =============================================================================
//
// THE BUG THIS EXISTS FOR. Portfolio → WRITTEN is built from `WriterPosition`
// accounts (writerRows.ts). A modern `/write` — epoch, American, the default
// path — does not create one. It creates a **`WriterAskPosition`**, and nothing
// in this app read that account type: it appeared only in `orderFlows.ts` as a
// PDA to pass into a transaction.
//
// So every writer on the current path saw "Nothing written." Measured on chain
// 2026-08-11: the ORE writer had ZERO WriterPosition accounts and ONE
// WriterAskPosition ($124 committed, 2 contracts). 16 such accounts existed
// across 11 distinct backers. It was never about new assets — it was about
// which write path you used.
//
// WHY THIS FILE IS READ-ONLY (the A(ii) ruling). A WriterAskPosition is not a
// pooled-vault position: it has no shares, no premium-per-share accumulator and
// no claim/withdraw lifecycle. Folding it into `WriterRow` would mean teaching
// the claim/withdraw state machine a second shape — and that machine moves
// money. Showing the truth and moving money are separable, so this slice does
// the first one only. Actions (cancel the order, reclaim residual) are a
// follow-up slice.
//
// The honest consequence, stated rather than hidden: these rows have no
// "claimable premium" figure, because for a resting ask there is no premium
// until someone fills it. They are collateral committed to an offer.
// =============================================================================

import type { PublicKey } from "@solana/web3.js";
import { usdcToNumber } from "../../utils/format";

/** One resting writer-ask, as the ledger shows it. */
export interface AskRow {
  /** WriterAskPosition PDA. */
  publicKey: string;
  /** Vault PDA this ask backs. */
  vault: string;
  /** Canonical asset symbol, or "?" when the market could not be resolved. */
  asset: string;
  /** Strike in dollars, or null when the vault is unknown to this page. */
  strike: number | null;
  /** Expiry unix seconds, or null. */
  expiry: number | null;
  side: "call" | "put" | null;
  /** USDC committed to back the offer. */
  collateral: number;
  /** Contracts the ask is good for. */
  contracts: number;
  createdAt: number;
}

interface RawAccount {
  publicKey: PublicKey;
  account: {
    backer: PublicKey;
    optionMint: PublicKey;
    vault: PublicKey;
    collateralCommitted: unknown;
    contractsWritten: unknown;
    createdAt: unknown;
  };
}

interface VaultLike {
  publicKey: PublicKey;
  account: {
    market: PublicKey;
    strikePrice: unknown;
    expiry: unknown;
    optionType: unknown;
    isSettled?: boolean;
  };
}

const num = (v: unknown): number => {
  if (typeof v === "number") return v;
  const n = (v as { toNumber?: () => number })?.toNumber?.();
  return typeof n === "number" ? n : 0;
};

/**
 * Build the ASKS POSTED rows for one wallet.
 *
 * PURE — no React, no RPC, mirroring writerRows.ts structurally so the two can
 * be read side by side.
 *
 * Unlike `buildWriterRows`, a row is NOT dropped when its vault is missing from
 * `vaults`. The vault lookup only decorates the row (asset / strike / expiry);
 * the collateral and contract count come from the ask account itself and are
 * true regardless. Dropping on a missing vault is what made the original bug so
 * total — an invisible row is a worse answer than a partially-labelled one.
 */
export function buildAskRows(
  asks: readonly RawAccount[],
  vaults: readonly VaultLike[],
  wallet: PublicKey | null,
  assetByMarket: ReadonlyMap<string, string>,
): AskRow[] {
  if (!wallet) return [];
  const walletB58 = wallet.toBase58();
  const vaultByKey = new Map<string, VaultLike>();
  for (const v of vaults) vaultByKey.set(v.publicKey.toBase58(), v);

  const out: AskRow[] = [];
  for (const a of asks) {
    if (a.account.backer.toBase58() !== walletB58) continue;
    const contracts = num(a.account.contractsWritten);
    // A fully-consumed or cancelled ask carries no commitment; showing it would
    // pad the ledger with rows that are not offers.
    if (contracts <= 0) continue;

    const vaultKey = a.account.vault.toBase58();
    const v = vaultByKey.get(vaultKey);
    const optType = v ? num(v.account.optionType) : null;
    out.push({
      publicKey: a.publicKey.toBase58(),
      vault: vaultKey,
      asset: v ? (assetByMarket.get(v.account.market.toBase58()) ?? "?") : "?",
      strike: v ? num(v.account.strikePrice) / 1e6 : null,
      expiry: v ? num(v.account.expiry) : null,
      side: optType === null ? null : optType === 1 ? "put" : "call",
      collateral: usdcToNumber(a.account.collateralCommitted as never),
      contracts,
      createdAt: num(a.account.createdAt),
    });
  }
  // Newest first — a writer looking for what they just posted looks at the top.
  return out.sort((x, y) => y.createdAt - x.createdAt);
}

/** Total USDC committed to resting asks. Folded into the portfolio's collateral
 *  figure so the summary stops under-reporting what the wallet has at work. */
export function askCollateralTotal(rows: readonly AskRow[]): number {
  return rows.reduce((s, r) => s + r.collateral, 0);
}

/** Per-asset committed collateral, for the BY ASSET column. */
export function askCollateralByAsset(rows: readonly AskRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.asset, (m.get(r.asset) ?? 0) + r.collateral);
  return m;
}
