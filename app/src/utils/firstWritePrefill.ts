// =============================================================================
// firstWritePrefill.ts — SLICE 3: the one decision a first write should be
// =============================================================================
//
// THE FUNNEL EXIT THIS CLOSES. Measured on chain 2026-08-11: of 31 registered
// assets, 21 had NEVER traded a contract and 6 had never had a vault at all.
// The create flow ends with a market nobody can trade, and the only route on
// was /write — a four-gate form asking a first-time user for a strike, an
// expiry, a contract count and full collateral, immediately after telling them
// the thing they just made is worthless until they do.
//
// So this module answers those questions FOR them, legally, with values they
// can then edit. Everything here is PURE — no React, no RPC, no clock unless
// injected — so every prefill is testable against a fixed instant.
//
// ── STRIKE CONVENTION: DUPLICATED, DELIBERATELY, WITH A NAMED OWNER ─────────
// `gridStep` / `snapToGrid` / `roundSigStep` below are COPIES of
// writer/src/ladder.ts, which is CANONICAL. The app cannot import from writer/
// (the @app/* alias runs the other way — writer imports FROM app), so matching
// the bot's rungs means either a copy here or moving the originals into app/
// and having the writer import them.
//
// This slice takes the copy, on the stated grounds that a signing format drifts
// SILENTLY into 401s while a strike table drifts VISIBLY into an off-rung
// strike, and this is six numbers and a rounding rule. The mitigation is that
// both copies are pinned by literal tests — writer/src/ladder.grid.test.ts
// asserts the same tier boundaries — so whichever side moves breaks its own
// suite. The real fix (writer imports from app) is filed for the next
// deliberate writer deploy.
//
// WHY MATCH THE BOT AT ALL: rungs are PDA addresses. A user strike that lands
// on a bot rung reuses an existing (market, strike, expiry, side) series and
// vault instead of minting new ones — cheaper for the user, and no new shells
// on a board that has already been through one churn incident.
// =============================================================================

import {
  ASSET_CLASS_EQUITY,
  ASSET_CLASS_ETF,
  isMarketHours,
  type AssetClass,
} from "./marketHours";
import { weeklyExpiry } from "./tenors";

// ---- strike grid (copies — writer/src/ladder.ts is canonical) ---------------

/** Absolute size of one 3-significant-figure quantum at magnitude x.
 *  x≈1.09 → 0.01; x≈65000 → 100. Copy of writer/src/ladder.ts. */
export function roundSigStep(x: number, sig = 3): number {
  if (x <= 0) return 0;
  return Math.pow(10, Math.floor(Math.log10(x)) - (sig - 1));
}

/** Deterministic per-ticker grid step, keyed to spot magnitude.
 *  Copy of writer/src/ladder.ts — pinned by literal test on both sides. */
export function gridStep(spot: number): number {
  if (spot < 50) return 1;
  if (spot < 100) return 2.5;
  if (spot < 250) return 5;
  if (spot < 500) return 10;
  if (spot < 1000) return 25;
  return 50;
}

/** Snap to the nearest grid point (half-up, JS Math.round). Copy. */
export function snapToGrid(x: number, step: number): number {
  if (step <= 0) return x;
  return Math.round(x / step) * step;
}

/**
 * The ATM strike a first write should default to, matched to the writer bot's
 * convention for this asset class.
 *
 * equity / ETF → the ABSOLUTE grid. The bot moved equities off spot-relative
 *   strikes because the cancel-at-close / repost-at-open cycle recentred the
 *   whole ladder on the overnight spot and minted a fresh series+vault per cell
 *   (~+260 shells, ~5.6 SOL per NYSE open, measured 2026-07-22). A user strike
 *   on the absolute grid lands on the same PDAs the bot already uses.
 *
 * everything else → spot-relative ATM at 3 significant figures, which is the
 *   bot's `STRIKE_MULTIPLIERS[0] = 1.0` rung.
 */
export function prefillStrike(spot: number, assetClass: number): number | null {
  if (!(spot > 0) || !Number.isFinite(spot)) return null;
  if (assetClass === ASSET_CLASS_EQUITY || assetClass === ASSET_CLASS_ETF) {
    const snapped = snapToGrid(spot, gridStep(spot));
    return snapped > 0 ? +snapped.toFixed(4) : null;
  }
  const step = roundSigStep(spot);
  const snapped = step > 0 ? Math.round(spot / step) * step : spot;
  // toFixed(6) clears float artifacts (0.1+0.2 territory) without changing the
  // value at any magnitude the collateral math cares about.
  return snapped > 0 ? +snapped.toFixed(6) : null;
}

// ---- expiry -----------------------------------------------------------------

/** How far ahead we are willing to walk looking for a legal expiry before
 *  giving up. NYSE closures never run this long; the bound exists so a broken
 *  calendar produces `null` rather than an infinite loop. */
const MAX_FORWARD_DAYS = 21;

/** Where inside an NYSE session to place a prefilled equity expiry.
 *  One hour after the open: comfortably inside the session on a normal day AND
 *  on a half-day (early close is 18:00/17:00 UTC, never before 14:30). */
const EQUITY_OFFSET_INTO_SESSION_SECS = 3600;

/**
 * The nearest LEGAL expiry for this asset class, at-or-after `now + minLeadSecs`.
 *
 * crypto / commodity → the epoch weekly (Friday 08:00 UTC). Ungated.
 *
 * FX → the SAME weekly, and it is legal: the FX week closes 21:00/22:00 UTC on
 *   Friday, so Friday 08:00 UTC sits inside it. Verified rather than assumed —
 *   the 2B gate is asked directly below, so if that ever changes this returns
 *   something else instead of silently proposing a dead expiry.
 *
 * equity / ETF → the weekly is ILLEGAL, every week of the year: epoch expiries
 *   are Friday 08:00 UTC and NYSE opens 13:30/14:30 UTC, so the vault would
 *   expire before its own settlement venue opened (F4's finding). We walk
 *   forward to the next session open and sit an hour inside it.
 *
 * Returns null only if no legal expiry exists within MAX_FORWARD_DAYS — a
 * broken/exhausted calendar. The caller renders that as "pick an expiry"
 * rather than proposing something that cannot settle.
 */
export function prefillExpiry(
  assetClass: number,
  nowMs: number,
  minLeadSecs = 0,
): number | null {
  const weekly = weeklyExpiry(nowMs, minLeadSecs);

  // Non-NYSE classes: the weekly is the answer IF the class's own gate agrees.
  // Asking the gate (rather than assuming) is what keeps FX honest.
  if (assetClass !== ASSET_CLASS_EQUITY && assetClass !== ASSET_CLASS_ETF) {
    if (isMarketHours(weekly, assetClass as AssetClass).ok) return weekly;
    // FX weekend or a future gate: walk forward a week at a time.
    for (let i = 1; i <= 3; i++) {
      const next = weekly + i * 7 * 86_400;
      if (isMarketHours(next, assetClass as AssetClass).ok) return next;
    }
    return null;
  }

  // NYSE classes: walk forward day by day to the next session and sit inside it.
  const floorSec = Math.floor(nowMs / 1000) + minLeadSecs;
  for (let day = 0; day <= MAX_FORWARD_DAYS; day++) {
    const probe = floorSec + day * 86_400;
    const r = isMarketHours(probe, assetClass as AssetClass);
    if (r.ok) {
      // `probe` is already inside a session — good enough, it is legal.
      if (probe > floorSec) return probe;
    }
    // Not in session: jump to the next session OPEN the gate reports, then sit
    // an hour inside it. The gate computes that boundary; we do not re-derive it.
    const nextOpen = (r as { nextValidUnixSec?: number }).nextValidUnixSec;
    if (nextOpen !== undefined) {
      const candidate = nextOpen + EQUITY_OFFSET_INTO_SESSION_SECS;
      if (candidate > floorSec && isMarketHours(candidate, assetClass as AssetClass).ok) {
        return candidate;
      }
    }
  }
  return null;
}

// ---- the whole prefill ------------------------------------------------------

export interface FirstWritePrefill {
  side: "call" | "put";
  exerciseStyle: "american";
  strike: number | null;
  expiry: number | null;
  contracts: number;
}

/**
 * Everything a first write needs, prefilled. `strike` is null until spot is
 * known (the Pyth arm learns it when the vol oracle lands); `expiry` is null
 * only if no legal one exists.
 */
export function buildFirstWritePrefill(args: {
  spot: number | null;
  assetClass: number;
  nowMs: number;
  minLeadSecs?: number;
}): FirstWritePrefill {
  return {
    side: "call",
    exerciseStyle: "american",
    strike: args.spot === null ? null : prefillStrike(args.spot, args.assetClass),
    expiry: prefillExpiry(args.assetClass, args.nowMs, args.minLeadSecs ?? 0),
    contracts: 1,
  };
}
