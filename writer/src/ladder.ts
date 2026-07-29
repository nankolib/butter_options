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

// ---- ABSOLUTE STRIKE GRID (equity only, asset_class 2) ----------------------
// Equity strikes were spot-relative (spot × {0.90..1.10}, roundSig-rounded), so
// the cancel-at-close / repost-at-open cycle recentred the whole ladder on the
// overnight spot and minted a fresh series+vault for every cell (~+260 shells,
// ~5.6 SOL per NYSE open, measured 2026-07-22). A fixed absolute grid makes the
// STRIKE VALUE itself stable: a move smaller than one gridStep snaps to the same
// grid points → the (market, strike, expiry, side) PDAs already exist on-chain →
// needSeries/needVault are false → the repost reuses instead of minting. Crypto
// keeps its spot-relative + stickyStrike path (untouched — see buildLadder).
export const EQUITY_LADDER_N = 5;

/** Deterministic per-ticker grid step, keyed to spot magnitude. */
export function gridStep(spot: number): number {
  if (spot < 50) return 1;
  if (spot < 100) return 2.5;
  if (spot < 250) return 5;
  if (spot < 500) return 10;
  if (spot < 1000) return 25;
  return 50;
}

/** Snap to the nearest grid point (half-up on the midpoint, JS Math.round). */
export function snapToGrid(x: number, step: number): number {
  if (step <= 0) return x;
  return Math.round(x / step) * step;
}

/**
 * The N grid points nearest ATM: the snapped-ATM grid point and (N-1)/2 steps
 * on each side. Stateless — same spot (within ±½ step) always yields the same
 * set, which is what gives cross-day PDA reuse. Drops any non-positive strike.
 */
export function equityGridStrikes(spot: number, n = EQUITY_LADDER_N): number[] {
  if (spot <= 0) return [];
  const step = gridStep(spot);
  const atm = snapToGrid(spot, step);
  const half = (n - 1) / 2;
  const out: number[] = [];
  for (let i = -half; i <= half; i++) {
    const s = +(atm + i * step).toFixed(4); // clean fp artifacts (e.g. 2.5 steps)
    if (s > 0) out.push(s);
  }
  return out;
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
  /** Integer rung distance from the ATM strike: 0 = ATM, 1 = first wing either
   *  side, 2 = second. Distinct from `atmDistance` (a fraction used only for
   *  ATM-first ORDERING) because the bid side needs an exact, scale-free band —
   *  on equity the ATM grid point is rarely exactly at spot, so its atmDistance
   *  is nonzero and cannot identify the centre rung. Consumed by the bid module's
   *  ATM filter; the ask path ignores it. */
  rungIndex: number;
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
  const nowSec = Math.floor(nowMs / 1000);

  // Shared cell emitter — identical fields on both paths; keeps them in lockstep.
  const emit = (
    strikeDollars: number, atmDistance: number, t: { label: "weekly" | "monthly"; ts: number },
    rungIndex: number,
  ) => {
    if (strikeDollars <= 0) return;
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
        atmDistance,
        rungIndex,
      });
    }
  };

  if (market.assetClass === 2) {
    // EQUITY: stateless absolute grid — N grid points nearest ATM, identical for
    // every expiry (no per-expiry hysteresis, so a cold post-cancel board still
    // re-derives the SAME strikes → cross-day PDA reuse). ATM-first by |strike−spot|.
    // The grid is symmetric around the snapped ATM point, so the rung index is
    // just the array offset from the centre — exact, and independent of how far
    // the snapped ATM sits from raw spot.
    const grid = equityGridStrikes(spot, EQUITY_LADDER_N);
    const centre = (grid.length - 1) / 2;
    grid.forEach((strikeDollars, i) => {
      const atmDistance = spot > 0 ? Math.abs(strikeDollars - spot) / spot : 0;
      const rungIndex = Math.round(Math.abs(i - centre));
      for (const t of tenors) {
        if (t.ts <= nowSec) return; // defensive
        emit(strikeDollars, atmDistance, t, rungIndex);
      }
    });
  } else {
    // NON-EQUITY (crypto/metals/fx/etf): spot-relative rungs + per-expiry strike
    // hysteresis. UNCHANGED — the just-proven 24/7 board must not move.
    const byExpiry = inp.existingStrikesByExpiry;
    for (const mult of STRIKE_MULTIPLIERS) {
      const rawTarget = spot * mult;
      // Rungs are spaced RUNG_FRAC apart, so |mult-1| / RUNG_FRAC is the exact
      // integer rung: 1.00 -> 0, 0.95/1.05 -> 1, 0.90/1.10 -> 2.
      const rungIndex = Math.round(Math.abs(mult - 1) / RUNG_FRAC);
      for (const t of tenors) {
        if (t.ts <= nowSec) continue; // defensive
        // Hysteresis is resolved PER EXPIRY: only anchors on THIS tenor can
        // retain a strike, because the series PDA is keyed by expiry too.
        const anchors = byExpiry?.get(t.ts) ?? [];
        const strikeDollars = stickyStrike(rawTarget, anchors, spot);
        emit(strikeDollars, Math.abs(mult - 1), t, rungIndex);
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
