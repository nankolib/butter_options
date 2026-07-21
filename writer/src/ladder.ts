// =============================================================================
// ladder.ts — target-cell generation per asset (spec §e).
// =============================================================================
// Strikes: spot × {0.90, 0.95, 1.00, 1.05, 1.10}, 3-sig-fig rounded (percentage
// steps → asset-agnostic across BONK..BTC). Tenors: nearest weekly + monthly.
// Both Call and Put. qty = clamp(round(targetNotional/strike), 1, HARD_MAX);
// collateral locked per cell = strike × qty. Cells are emitted ATM-first so a
// canary cell cap (OPTA_WRITER_MAX_CELLS) takes the most central quotes.
//
// Tier (spread + notional) is a display classification: asset_class, with a meme
// ticker override. It is NOT a discovery gate — an unclassified new asset falls
// back to its asset_class tier and still trades.
// =============================================================================

import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import type { AssetClass } from "./marketHours";
import type { MarketInfo } from "./discovery";
import { toUsdcBN } from "./pricing";
import { weeklyEpoch, monthlyEpoch, weeklyEquity, monthlyEquity } from "./tenors";
import { OPT_CALL, OPT_PUT } from "./ids";
import type { VaultKind } from "./builders";

const HARD_MAX_QTY = 100_000_000;
// ATM-first ordering by |mult - 1|.
const STRIKE_MULTIPLIERS = [1.0, 0.95, 1.05, 0.9, 1.1];

/** Meme override set — pricing tier only (wider spread / smaller notional). */
const MEME_TICKERS = new Set(["BONK", "WIF", "JUP", "JTO", "FARTCOIN", "POPCAT", "MEW", "PENGU"]);

export interface TierPolicy {
  spreadBps: number;
  targetNotional: number;
}

export function classifyTier(
  m: MarketInfo,
  cfg: { targetNotionalMajor: number; targetNotionalMeme: number },
): TierPolicy {
  if (m.assetClass === 0 && MEME_TICKERS.has(m.assetName)) {
    return { spreadBps: 1000, targetNotional: cfg.targetNotionalMeme };
  }
  switch (m.assetClass) {
    case 0: return { spreadBps: 500, targetNotional: cfg.targetNotionalMajor }; // crypto major
    case 1: return { spreadBps: 400, targetNotional: cfg.targetNotionalMajor }; // commodity/metal
    case 2: return { spreadBps: 600, targetNotional: cfg.targetNotionalMajor }; // equity
    case 3: return { spreadBps: 600, targetNotional: cfg.targetNotionalMajor }; // fx
    case 4: return { spreadBps: 600, targetNotional: cfg.targetNotionalMajor }; // etf
    default: return { spreadBps: 600, targetNotional: cfg.targetNotionalMajor };
  }
}

export const vaultKindFor = (assetClass: AssetClass): VaultKind =>
  assetClass === 2 || assetClass === 4 ? "custom" : "epoch";

/** Round to `sig` significant figures (keeps strikes clean across price scales). */
export function roundSig(x: number, sig = 3): number {
  if (x <= 0) return x;
  const mag = Math.pow(10, sig - 1 - Math.floor(Math.log10(x)));
  return Math.round(x * mag) / mag;
}

/** The absolute size of one `roundSig` quantum at magnitude x (3 sig figs →
 *  x≈1.09 ⇒ 0.01; x≈65000 ⇒ 100). */
export function roundSigStep(x: number, sig = 3): number {
  if (x <= 0) return 0;
  return Math.pow(10, Math.floor(Math.log10(x)) - (sig - 1));
}

// STRIKE HYSTERESIS deadband, as a fraction of one roundSig step.
// WHY NOT 0.5: the rounding boundary ALREADY sits at half a step (1.095 is the
// midpoint between 1.09 and 1.10), so a ±half-step band reproduces the rounding
// decision exactly and yields NO hysteresis — the wobble still flips. 0.75 of a
// step puts the switch threshold beyond the midpoint, creating a real deadband:
// an existing strike is retained until spot moves 0.75 of a step away from it.
const STICKY_BAND_STEPS = 0.75;

/**
 * STRIKE HYSTERESIS. Spot wobbling across a `roundSig` boundary used to mint a
 * NEW series every tick (1.0949→1.09, 1.0951→1.10), orphaning the old one — the
 * dominant source of writer transaction churn (533 orphan-series pulls in 6h,
 * ~1.55 SOL/h). Keep an EXISTING strike whenever the raw target is still within
 * the deadband of it; only adopt the freshly-rounded strike on a genuine move.
 */
export function stickyStrike(rawTarget: number, existingStrikes: readonly number[]): number {
  const fresh = roundSig(rawTarget, 3);
  if (existingStrikes.length === 0) return fresh;
  const band = roundSigStep(rawTarget, 3) * STICKY_BAND_STEPS;
  let best: number | null = null;
  let bestDist = Infinity;
  for (const e of existingStrikes) {
    const d = Math.abs(rawTarget - e);
    if (d <= band && d < bestDist) { best = e; bestDist = d; }
  }
  return best ?? fresh;
}

function clampQty(strikeDollars: number, targetNotional: number): number {
  const q = Math.round(targetNotional / strikeDollars);
  return Math.min(HARD_MAX_QTY, Math.max(1, q));
}

export interface TargetCell {
  assetName: string;
  market: PublicKey;
  side: "call" | "put";
  optIdx: number;
  vaultKind: VaultKind;
  strikeDollars: number;
  strikeMicro: BN;
  expiryTs: number;
  tenorLabel: "weekly" | "monthly";
  qty: number;
  spreadBps: number;
  atmDistance: number; // |mult - 1|, for ordering
}

export interface LadderInput {
  market: MarketInfo;
  spot: number;
  tier: TierPolicy;
  nowMs: number;
  epochMinLeadSecs: number; // EpochConfig.min_epoch_duration_days × 86400 (crypto)
  equityMinLeadSecs: number; // small buffer so equity asks aren't near-instant expiry
  /** Strikes this market ALREADY has live asks on. Enables strike hysteresis:
   *  a wobble across a roundSig boundary retains the existing strike instead of
   *  minting a new series. Empty/omitted = no hysteresis (cold board). */
  existingStrikes?: readonly number[];
}

/** Build the full target ladder for one asset, ATM-first. */
export function buildLadder(inp: LadderInput): TargetCell[] {
  const { market, spot, tier, nowMs } = inp;
  const kind = vaultKindFor(market.assetClass);
  const [weekly, monthly] =
    kind === "custom"
      ? [weeklyEquity(nowMs, inp.equityMinLeadSecs), monthlyEquity(nowMs, inp.equityMinLeadSecs)]
      : [weeklyEpoch(nowMs, inp.epochMinLeadSecs), monthlyEpoch(nowMs, inp.epochMinLeadSecs)];

  const tenors: { label: "weekly" | "monthly"; ts: number }[] = [
    { label: "weekly", ts: weekly },
    { label: "monthly", ts: monthly },
  ];

  const cells: TargetCell[] = [];
  const existing = inp.existingStrikes ?? [];
  for (const mult of STRIKE_MULTIPLIERS) {
    // Hysteresis: retain an existing strike while spot stays inside its deadband.
    const strikeDollars = stickyStrike(spot * mult, existing);
    if (strikeDollars <= 0) continue;
    const strikeMicro = toUsdcBN(strikeDollars);
    const qty = clampQty(strikeDollars, tier.targetNotional);
    for (const t of tenors) {
      if (t.ts <= Math.floor(nowMs / 1000)) continue; // defensive
      for (const side of ["call", "put"] as const) {
        cells.push({
          assetName: market.assetName,
          market: market.publicKey,
          side,
          optIdx: side === "call" ? OPT_CALL : OPT_PUT,
          vaultKind: kind,
          strikeDollars,
          strikeMicro,
          expiryTs: t.ts,
          tenorLabel: t.label,
          qty,
          spreadBps: tier.spreadBps,
          atmDistance: Math.abs(mult - 1),
        });
      }
    }
  }
  // ATM-first, then weekly-before-monthly, then call-before-put.
  cells.sort((a, b) =>
    a.atmDistance - b.atmDistance ||
    (a.tenorLabel === b.tenorLabel ? 0 : a.tenorLabel === "weekly" ? -1 : 1) ||
    (a.side === b.side ? 0 : a.side === "call" ? -1 : 1),
  );
  return cells;
}
