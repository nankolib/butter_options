// =============================================================================
// tenors.ts — expiry timestamp generators.
// =============================================================================
// Crypto/memes: Friday 08:00 UTC epoch boundaries (Epoch vaults), vendored from
// app/src/utils/tenors.ts (is_valid_epoch_expiry accepts these).
//
// Equity/ETF: Friday ~19:45 UTC, inside the NYSE regular session (CUSTOM vaults,
// per the Gate-1 amendment) so settlement lands on-hours — never at an 08:00Z
// epoch that would settle off-session and stick the vault (quotes-proxy 503 /
// 180s FRESH_MAX). 19:45Z sits inside session in BOTH DST (13:30-20:00Z) and
// standard time (14:30-21:00Z). Closed/early-close Fridays are skipped.
// =============================================================================

import { isNyseClosedDay, isNyseEarlyCloseDay } from "./marketHours";

const DAY = 86400;
const WEEK = 7 * DAY;

// ---- Crypto epoch tenors (Friday 08:00Z) -----------------------------------

function lastFridayUtc8(year: number, month0: number): number {
  const d = new Date(Date.UTC(year, month0 + 1, 0, 8, 0, 0, 0));
  const back = (d.getUTCDay() - 5 + 7) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return Math.floor(d.getTime() / 1000);
}

/** Next Friday 08:00 UTC strictly more than `minLeadSecs` away. */
export function weeklyEpoch(nowMs: number, minLeadSecs = 0): number {
  const threshold = Math.floor(nowMs / 1000) + minLeadSecs;
  const d = new Date(nowMs);
  d.setUTCHours(8, 0, 0, 0);
  const delta = (5 - d.getUTCDay() + 7) % 7;
  d.setUTCDate(d.getUTCDate() + delta);
  let ts = Math.floor(d.getTime() / 1000);
  while (ts <= threshold) ts += WEEK;
  return ts;
}

/** Last Friday of a month 08:00 UTC, rolling to later months until > threshold. */
export function monthlyEpoch(nowMs: number, minLeadSecs = 0): number {
  const threshold = Math.floor(nowMs / 1000) + minLeadSecs;
  const d = new Date(nowMs);
  let y = d.getUTCFullYear();
  let m = d.getUTCMonth();
  let ts = lastFridayUtc8(y, m);
  while (ts <= threshold) {
    m += 1;
    if (m > 11) { m = 0; y += 1; }
    ts = lastFridayUtc8(y, m);
  }
  return ts;
}

// ---- Equity custom tenors (Friday 19:45Z, inside NYSE session) --------------

const EQUITY_CLOSE_H = 19;
const EQUITY_CLOSE_M = 45;

/** 19:45:00 UTC on the calendar day containing `unixSecOnDay`. */
function at1945Z(unixSecOnDay: number): number {
  const d = new Date(unixSecOnDay * 1000);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), EQUITY_CLOSE_H, EQUITY_CLOSE_M, 0) / 1000);
}

/** A Friday 19:45Z is usable iff the exchange holds a FULL session that day
 *  (not closed, not an early-close half-day — 19:45Z is after the 17/18:00Z
 *  half-day close). */
function isUsableEquityFriday(ts1945: number): boolean {
  return !isNyseClosedDay(ts1945) && !isNyseEarlyCloseDay(ts1945);
}

/** Next usable Friday 19:45Z strictly more than `minLeadSecs` away. Rolls
 *  forward a week past closed/early-close Fridays. */
export function weeklyEquity(nowMs: number, minLeadSecs = 0): number {
  const threshold = Math.floor(nowMs / 1000) + minLeadSecs;
  const d = new Date(nowMs);
  const delta = (5 - d.getUTCDay() + 7) % 7; // to the coming Friday
  let ts = at1945Z(Math.floor(d.getTime() / 1000) + delta * DAY);
  // Roll forward until strictly beyond the lead window AND a usable session.
  for (let guard = 0; guard < 60; guard++) {
    if (ts > threshold && isUsableEquityFriday(ts)) return ts;
    ts += WEEK;
  }
  return ts; // fail-safe: caller validates with isMarketHours before use
}

/** Last usable Friday 19:45Z of the earliest month whose last-usable-Friday is
 *  beyond the lead window. Rolls the last Friday BACK past a closed/early-close
 *  day, then advances a month if nothing usable remains beyond the threshold. */
export function monthlyEquity(nowMs: number, minLeadSecs = 0): number {
  const threshold = Math.floor(nowMs / 1000) + minLeadSecs;
  const start = new Date(nowMs);
  let y = start.getUTCFullYear();
  let m = start.getUTCMonth();
  for (let months = 0; months < 18; months++) {
    // Last Friday of (y, m) at 19:45Z, walked back past unusable sessions.
    const lastDay = new Date(Date.UTC(y, m + 1, 0));
    const back = (lastDay.getUTCDay() - 5 + 7) % 7;
    let ts = at1945Z(Math.floor(Date.UTC(y, m, lastDay.getUTCDate() - back) / 1000));
    for (let w = 0; w < 4 && !isUsableEquityFriday(ts); w++) ts -= WEEK;
    if (ts > threshold && isUsableEquityFriday(ts)) return ts;
    m += 1;
    if (m > 11) { m = 0; y += 1; }
  }
  return threshold + 30 * DAY; // unreachable fail-safe; caller validates
}
