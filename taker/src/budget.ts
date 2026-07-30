// =============================================================================
// budget.ts — spend accounting (PURE over rows; the DB layer just supplies them)
// =============================================================================
//
// Three independent limits, and each answers a different failure:
//   per-wallet/day  one seller farming the treasury (the points-farm vector)
//   global/day      a coordinated group, or a model bug hitting many orders
//   float           total capital at risk, regardless of how fast it got there
//
// Days are UTC and derived from an INJECTED timestamp — a bot that rolls its
// own day boundary off local time gives a seller two budgets on one calendar
// day, twice a year.
// =============================================================================

export interface BudgetLimits {
  maxPerWalletDayUsdc: number;
  maxGlobalDayUsdc: number;
  maxFloatUsdc: number;
  /** Open-interest notional ceiling. See TakerLimits.maxOiUsd. */
  maxOiUsd: number;
}

export interface SpendRows {
  walletSpentTodayUsdc: number;
  globalSpentTodayUsdc: number;
  floatUsdc: number;
  oiUsd: number;
}

export const utcDay = (unixSecs: number): string => new Date(unixSecs * 1000).toISOString().slice(0, 10);

/** Remaining headroom under each limit. Never negative. */
export function headroom(limits: BudgetLimits, spend: SpendRows) {
  return {
    wallet: Math.max(0, limits.maxPerWalletDayUsdc - spend.walletSpentTodayUsdc),
    global: Math.max(0, limits.maxGlobalDayUsdc - spend.globalSpentTodayUsdc),
    float: Math.max(0, limits.maxFloatUsdc - spend.floatUsdc),
    oi: Math.max(0, limits.maxOiUsd - spend.oiUsd),
  };
}

/**
 * The binding constraint, for shadow output. Null when nothing binds.
 *
 * Ordered by how hard the constraint is to clear, not by severity of outcome:
 * OI and float both persist until a position closes, and OI is reported first
 * because on the writerAsk side it binds long before float does.
 */
export function bindingConstraint(
  limits: BudgetLimits, spend: SpendRows,
): "wallet" | "global" | "float" | "oi" | null {
  const h = headroom(limits, spend);
  if (Math.min(h.wallet, h.global, h.float, h.oi) > 0) return null;
  if (h.oi === 0) return "oi";
  if (h.float === 0) return "float";
  if (h.global === 0) return "global";
  return "wallet";
}

/**
 * Float is spend MINUS recovery, so a position that settles or is resold frees
 * capacity. Without the recovery term the bot would ratchet itself shut after
 * $10k of lifetime volume even if every position had closed profitably.
 */
export function nextFloat(currentFloat: number, spentUsdc: number, recoveredUsdc: number): number {
  return Math.max(0, currentFloat + spentUsdc - recoveredUsdc);
}

/**
 * Open interest moves on exactly the same shape as float: created by minting
 * fills, released when the position leaves (exercise, settlement, resale-out).
 * Kept as its own function rather than reusing nextFloat so the two can never be
 * accidentally fed each other's units — one is premium, the other is strike.
 */
export function nextOi(currentOi: number, createdUsd: number, releasedUsd: number): number {
  return Math.max(0, currentOi + createdUsd - releasedUsd);
}
