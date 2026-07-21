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

// ---- STRIKE HYSTERESIS v2 ---------------------------------------------------
// v1 anchored the deadband to `roundSigStep` — the 3-SIG-FIG DISPLAY-ROUNDING
// QUANTUM. That is the wrong unit. Rungs are spaced at 5% of spot, so the band
// came out 8x-53x NARROWER than one rung, and its width as a fraction of spot
// swung ~10x with the leading digit of the price (0.096% for SOL at 77.87 vs
// 0.653% for XRP at 1.1489). It suppressed the quantum wobble it was tested
// against and nothing else: any ordinary ~0.1% drift re-centred BTC's and SOL's
// whole ladder, minting a new series+vault per rung at ~0.0201 SOL each,
// permanently (+52 shells/h, ~0.95 SOL/h measured 2026-07-21 13:32-15:30Z).
//
// v2 anchors the band to the RUNG SPACING instead, so it is scale-free and
// identical in percentage terms on every asset:
//   rungSpacing = RUNG_FRAC * spot          (the STRIKE_MULTIPLIERS gap)
//   band        = HYST_FRAC * rungSpacing   = 0.025 * spot  → flips at ~+/-2.5%
// `roundSig` still quantizes the strike grid; it just no longer sets the band.
export const RUNG_FRAC = 0.05;
export const HYST_FRAC = 0.5;

/** Hysteresis deadband in absolute price units: HYST_FRAC of one 5% rung. */
export function hystBand(spot: number): number {
  return spot > 0 ? HYST_FRAC * RUNG_FRAC * spot : 0;
}

/**
 * STRIKE HYSTERESIS. Keep an EXISTING strike whenever the raw target is still
 * within the deadband of it; only adopt the freshly-rounded strike on a genuine
 * move. `spot` sizes the band (defaults to rawTarget, exact for the ATM rung) so
 * every rung on an asset shares one band rather than scaling with the wing.
 */
export function stickyStrike(
  rawTarget: number,
  existingStrikes: readonly number[],
  spot: number = rawTarget,
): number {
  const fresh = roundSig(rawTarget, 3);
  if (existingStrikes.length === 0) return fresh;
  const band = hystBand(spot);
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
  /** Strikes this market ALREADY has live asks on, KEYED BY EXPIRY. Enables
   *  strike hysteresis without cross-tenor aliasing: a series PDA is
   *  (market, strike, expiry, side), so an anchor held only on the MONTHLY must
   *  never satisfy the WEEKLY's target — v1 collapsed both tenors into one set,
   *  reported "kept" and then minted anyway because the expiry differed.
   *  Empty/omitted = no hysteresis (cold board). */
  existingStrikesByExpiry?: ReadonlyMap<number, readonly number[]>;
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
  const byExpiry = inp.existingStrikesByExpiry;
  for (const mult of STRIKE_MULTIPLIERS) {
    const rawTarget = spot * mult;
    for (const t of tenors) {
      if (t.ts <= Math.floor(nowMs / 1000)) continue; // defensive
      // Hysteresis is resolved PER EXPIRY: only anchors on THIS tenor can
      // retain a strike, because the series PDA is keyed by expiry too.
      const anchors = byExpiry?.get(t.ts) ?? [];
      const strikeDollars = stickyStrike(rawTarget, anchors, spot);
      if (strikeDollars <= 0) continue;
      const strikeMicro = toUsdcBN(strikeDollars);
      const qty = clampQty(strikeDollars, tier.targetNotional);
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
