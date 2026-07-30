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
}

export interface SpendRows {
  walletSpentTodayUsdc: number;
  globalSpentTodayUsdc: number;
  floatUsdc: number;
}

export const utcDay = (unixSecs: number): string => new Date(unixSecs * 1000).toISOString().slice(0, 10);

/** Remaining headroom under each limit. Never negative. */
export function headroom(limits: BudgetLimits, spend: SpendRows) {
  return {
    wallet: Math.max(0, limits.maxPerWalletDayUsdc - spend.walletSpentTodayUsdc),
    global: Math.max(0, limits.maxGlobalDayUsdc - spend.globalSpentTodayUsdc),
    float: Math.max(0, limits.maxFloatUsdc - spend.floatUsdc),
  };
}

/** The binding constraint, for shadow output. Null when nothing binds. */
export function bindingConstraint(limits: BudgetLimits, spend: SpendRows): "wallet" | "global" | "float" | null {
  const h = headroom(limits, spend);
  const min = Math.min(h.wallet, h.global, h.float);
  if (min > 0) return null;
  if (h.float === 0) return "float"; // float is the most serious — report it first
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
