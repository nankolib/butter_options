// =============================================================================
// utils/tenors.ts — Tenor date math + ladder snapping (pure, side-effect-free)
// =============================================================================
// Tenor is purely an FE label: weekly / monthly / quarterly all resolve to a
// Friday 08:00:00 UTC timestamp, which the program accepts as a valid Epoch
// expiry (is_valid_epoch_expiry under the live config Fri/08:00). No Rust.
// =============================================================================

export type TenorLabel = "Weekly" | "Monthly" | "Quarterly";

/** Last Friday of a given UTC year/month0 (0-11) at 08:00:00 UTC, in seconds. */
function lastFridayUtc8(year: number, month0: number): number {
  // Day 0 of the NEXT month = the last day of `month0`, at 08:00 UTC.
  const d = new Date(Date.UTC(year, month0 + 1, 0, 8, 0, 0, 0));
  const back = (d.getUTCDay() - 5 + 7) % 7; // walk back to Friday (getUTCDay Fri=5)
  d.setUTCDate(d.getUTCDate() - back);
  return Math.floor(d.getTime() / 1000);
}

/** Next Friday 08:00 UTC (rolls a week if today is Friday past 08:00). */
export function weeklyExpiry(now: number = Date.now()): number {
  const d = new Date(now);
  d.setUTCHours(8, 0, 0, 0);
  let delta = (5 - d.getUTCDay() + 7) % 7;
  if (delta === 0 && d.getTime() <= now) delta = 7;
  d.setUTCDate(d.getUTCDate() + delta);
  return Math.floor(d.getTime() / 1000);
}

/** Last Friday of this month 08:00 UTC; if already passed, last Friday of next month. */
export function monthlyExpiry(now: number = Date.now()): number {
  const nowSec = Math.floor(now / 1000);
  const d = new Date(now);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  let ts = lastFridayUtc8(y, m);
  if (ts <= nowSec) {
    m += 1;
    if (m > 11) {
      m = 0;
      y += 1;
    }
    ts = lastFridayUtc8(y, m);
  }
  return ts;
}

/** Quarter-end months (0-indexed): Mar, Jun, Sep, Dec. */
const QUARTER_END_MONTHS = [2, 5, 8, 11];

/** Last Friday of this quarter-end month 08:00 UTC; if passed, next quarter-end's. */
export function quarterlyExpiry(now: number = Date.now()): number {
  const nowSec = Math.floor(now / 1000);
  const d = new Date(now);
  let y = d.getUTCFullYear();
  const m = d.getUTCMonth();
  let qi = QUARTER_END_MONTHS.findIndex((x) => x >= m);
  if (qi === -1) {
    qi = 0;
    y += 1;
  } // only if past Dec (unreachable: Dec=11 covers m<=11)
  let ts = lastFridayUtc8(y, QUARTER_END_MONTHS[qi]);
  if (ts <= nowSec) {
    qi += 1;
    if (qi > 3) {
      qi = 0;
      y += 1;
    }
    ts = lastFridayUtc8(y, QUARTER_END_MONTHS[qi]);
  }
  return ts;
}

export function tenorExpiry(label: TenorLabel, now: number = Date.now()): number {
  switch (label) {
    case "Weekly":
      return weeklyExpiry(now);
    case "Monthly":
      return monthlyExpiry(now);
    case "Quarterly":
      return quarterlyExpiry(now);
  }
}

// -----------------------------------------------------------------------------
// Ladder snapping + collision merge
// -----------------------------------------------------------------------------

export type LadderTenorInput = { label: TenorLabel; pct: number; expiryTs: number };

export type LadderCell = {
  expiryTs: number;
  tenorLabels: TenorLabel[];
  contracts: number; // whole
  collateral: number; // human USDC = collateralPerContract x contracts
};

export type SnapResult =
  | { cells: LadderCell[]; error?: undefined }
  | { cells?: undefined; error: string };

/**
 * Snap N whole contracts across selected tenors.
 *   (a) merge tenors that resolve to the SAME Friday (sum their %),
 *   (b) reserve 1 contract per unique expiry (the min-usable guarantee),
 *   (c) split the remaining N-G by % (floor), leftover units to the largest-% group,
 *   (d) collateral = collateralPerContract x contracts (human USDC).
 * Returns { error } when N is not a positive integer or N < #unique-expiries.
 */
export function snapLadder(
  N: number,
  tenors: LadderTenorInput[],
  collateralPerContract: number,
): SnapResult {
  // (a) merge by identical expiry
  const byExp = new Map<string, { expiryTs: number; labels: TenorLabel[]; pct: number }>();
  for (const t of tenors) {
    const k = String(t.expiryTs);
    if (!byExp.has(k)) byExp.set(k, { expiryTs: t.expiryTs, labels: [], pct: 0 });
    const g = byExp.get(k)!;
    g.labels.push(t.label);
    g.pct += t.pct;
  }
  const groups = [...byExp.values()].sort((a, b) => a.expiryTs - b.expiryTs);
  const G = groups.length;

  if (!Number.isInteger(N) || N < 1) {
    return { error: "Enter a positive whole number of contracts." };
  }
  if (G === 0) {
    return { error: "Select at least one tenor." };
  }
  if (N < G) {
    return { error: `Need at least one contract per tenor (min ${G} for ${G} expiries).` };
  }

  // (b)+(c) reserve 1 each, distribute remainder by % (floor), leftover -> largest %
  const remaining = N - G;
  const base = groups.map((g) => Math.floor((remaining * g.pct) / 100));
  const leftover = remaining - base.reduce((a, b) => a + b, 0);
  const order = groups.map((g, i) => ({ i, pct: g.pct })).sort((a, b) => b.pct - a.pct);
  for (let k = 0; k < leftover; k++) base[order[k % G].i] += 1;

  const cells: LadderCell[] = groups.map((g, i) => {
    const contracts = 1 + base[i];
    return {
      expiryTs: g.expiryTs,
      tenorLabels: g.labels,
      contracts,
      collateral: collateralPerContract * contracts,
    };
  });
  return { cells };
}
