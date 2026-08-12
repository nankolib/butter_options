// =============================================================================
// marketHours.ts — NYSE regular-session calendar + isMarketHours gate
// =============================================================================
//
// Source-of-truth for "is this timestamp inside NYSE regular session" used by:
//   - Write form (gates equity / ETF expiries client-side; see WriterForm.tsx)
//   - Crank (deferred follow-up — short-circuit settle attempts on equities
//            outside hours to reduce Hermes-404 log noise)
//   - Future on-chain port (Phase 3, deferred — would require a calendar
//            account written by an admin instruction or a Rust mirror of
//            this calendar with annual sync burden)
//
// SCOPE (v1):
//   - asset_class 2 (Equity) → NYSE gated
//   - asset_class 4 (ETF) → NYSE gated (same hours)
//   - asset_class 0 (Crypto), 1 (Commodity), 3 (FX) → no gate
//
// Commodities (CME, LBMA) and FX (weekend rollovers) gates are TRACKED
// AS FOLLOW-UP work. The realistic stuck-vault rate for those classes is
// much lower than NYSE equities; not worth the user friction of blocking
// working flows. See the W3 design memo and admin-fallback scope doc §9
// for stuck-vault incident handling.
//
// CALENDAR MAINTENANCE:
//   NYSE_HOLIDAYS_BY_YEAR and NYSE_EARLY_CLOSE_BY_YEAR must be extended
//   each year before exhaustion. The calendar is treated as exhausted for
//   any year not present in NYSE_HOLIDAYS_BY_YEAR — `isMarketHours` returns
//   ok:false with a clear "Market-hours calendar exhausted" reason rather
//   than silently passing or silently rejecting. A CI build-time check
//   that fails when `today + 90d` exceeds the latest covered date is a
//   recommended follow-up but not blocking for v1.
// =============================================================================

export type AssetClass = 0 | 1 | 2 | 3 | 4;

export const ASSET_CLASS_CRYPTO = 0 as const;
export const ASSET_CLASS_COMMODITY = 1 as const;
export const ASSET_CLASS_EQUITY = 2 as const;
export const ASSET_CLASS_FX = 3 as const;
export const ASSET_CLASS_ETF = 4 as const;

const NYSE_GATED_CLASSES: ReadonlySet<AssetClass> = new Set<AssetClass>([
  ASSET_CLASS_EQUITY,
  ASSET_CLASS_ETF,
]);

// ----------------------------------------------------------------------------
// Calendar data
// ----------------------------------------------------------------------------
// Dates are OBSERVED dates (YYYY-MM-DD interpreted as 00:00–23:59:59 UTC of
// that day). When a US holiday falls on Sunday NYSE observes the following
// Monday; when on Saturday, the preceding Friday — entries below already
// reflect this shift.

const NYSE_HOLIDAYS_BY_YEAR: Record<number, readonly string[]> = {
  2026: [
    "2026-01-01", // New Year's Day (Thu)
    "2026-01-19", // MLK Day (3rd Mon Jan)
    "2026-02-16", // Presidents Day (3rd Mon Feb)
    "2026-04-03", // Good Friday (Easter Apr 5 2026)
    "2026-05-25", // Memorial Day (last Mon May)
    "2026-06-19", // Juneteenth (Fri)
    "2026-07-03", // Independence Day observed (Jul 4 2026 = Sat → Fri Jul 3)
    "2026-09-07", // Labor Day (1st Mon Sep)
    "2026-11-26", // Thanksgiving (4th Thu Nov)
    "2026-12-25", // Christmas Day (Fri)
  ],
  2027: [
    "2027-01-01", // New Year's Day (Fri)
    "2027-01-18", // MLK Day
    "2027-02-15", // Presidents Day
    "2027-03-26", // Good Friday (Easter Mar 28 2027)
    "2027-05-31", // Memorial Day
    "2027-06-18", // Juneteenth observed (Jun 19 2027 = Sat → Fri Jun 18)
    "2027-07-05", // Independence Day observed (Jul 4 2027 = Sun → Mon Jul 5)
    "2027-09-06", // Labor Day
    "2027-11-25", // Thanksgiving (Thu)
    "2027-12-24", // Christmas observed (Dec 25 2027 = Sat → Fri Dec 24)
  ],
};

// Early-close days: NYSE closes at 13:00 ET = 17:00 UTC (DST) / 18:00 UTC
// (standard). Day-before-Independence-Day half-day fires only when Jul 4
// falls on Tue–Fri; in 2026 (Jul 4 = Sat) and 2027 (Jul 4 = Sun) it
// doesn't apply.
const NYSE_EARLY_CLOSE_BY_YEAR: Record<number, readonly string[]> = {
  2026: [
    "2026-11-27", // Black Friday (day after Thanksgiving)
    "2026-12-24", // Christmas Eve (Thu) — Christmas Day = Fri, half-day applies
  ],
  2027: [
    "2027-11-26", // Black Friday
    // Dec 25 2027 = Sat → Christmas observed Fri Dec 24 (full closure above);
    //   no Christmas Eve half-day in 2027.
    // Jul 4 2027 = Sun → no Independence Day half-day.
  ],
};

// NYSE regular session in UTC. Local time is 09:30–16:00 ET; UTC offset
// is +4h during DST (EDT) and +5h during standard (EST).
const SESSION_OPEN_H_DST = 13;
const SESSION_OPEN_M = 30;
const SESSION_CLOSE_H_DST = 20;
const SESSION_OPEN_H_STD = 14;
const SESSION_CLOSE_H_STD = 21;
// Early close at 13:00 ET = 17:00 UTC (DST) / 18:00 UTC (standard)
const HALF_DAY_CLOSE_H_DST = 17;
const HALF_DAY_CLOSE_H_STD = 18;

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function ymdUTC(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function nthSundayOfMonthUTC(year: number, month0: number, n: number): number {
  const first = new Date(Date.UTC(year, month0, 1));
  const firstSundayOffset = (7 - first.getUTCDay()) % 7;
  const dayOfMonth = 1 + firstSundayOffset + (n - 1) * 7;
  return Math.floor(Date.UTC(year, month0, dayOfMonth) / 1000);
}

/** US DST window: 02:00 EST on 2nd Sun March (= 07:00 UTC) through
 *  02:00 EDT on 1st Sun November (= 06:00 UTC). Computed in UTC to
 *  sidestep local-time ambiguity at the transition hours. */
function isUSDST(unixSec: number): boolean {
  const year = new Date(unixSec * 1000).getUTCFullYear();
  const dstStart = nthSundayOfMonthUTC(year, 2, 2) + 7 * 3600;
  const dstEnd = nthSundayOfMonthUTC(year, 10, 1) + 6 * 3600;
  return unixSec >= dstStart && unixSec < dstEnd;
}

function isNyseHoliday(ymd: string): boolean {
  const year = parseInt(ymd.slice(0, 4), 10);
  return NYSE_HOLIDAYS_BY_YEAR[year]?.includes(ymd) ?? false;
}

function isNyseEarlyClose(ymd: string): boolean {
  const year = parseInt(ymd.slice(0, 4), 10);
  return NYSE_EARLY_CLOSE_BY_YEAR[year]?.includes(ymd) ?? false;
}

function calendarCoversYear(year: number): boolean {
  return NYSE_HOLIDAYS_BY_YEAR[year] !== undefined;
}

function startOfDayUTC(unixSec: number): number {
  const d = new Date(unixSec * 1000);
  return Math.floor(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000,
  );
}

// ----------------------------------------------------------------------------
// FX trading week (SLICE 2B, item 8)
// ----------------------------------------------------------------------------
//
// FX has no exchange session, but it DOES have a week: the market closes ~17:00
// New York on Friday and reopens ~17:00 New York on Sunday. Between those two
// moments there is no price to settle against.
//
// This was tracked as follow-up in v1 and never built, so until now an FX expiry
// could be written for a Saturday — a contract whose settlement source is shut
// for the entire window in which it expires. The v1 note argued the stuck-vault
// rate was "much lower than NYSE equities"; that is true and irrelevant, because
// the rate for a WEEKEND FX expiry specifically is 100%.
//
// 17:00 New York is 21:00 UTC under DST and 22:00 UTC under standard time —
// reusing `isUSDST`, the same helper the NYSE session uses, so the two gates
// cannot drift apart on a DST boundary.
const FX_BOUNDARY_H_DST = 21;
const FX_BOUNDARY_H_STD = 22;

/** UTC second-of-day at which the FX week opens (Sun) and closes (Fri). */
function fxBoundarySec(unixSec: number): number {
  return (isUSDST(unixSec) ? FX_BOUNDARY_H_DST : FX_BOUNDARY_H_STD) * 3600;
}

/** Is this instant inside the FX trading week? Exported for tests. */
export function isFxTradingWeek(unixSec: number): boolean {
  const dow = new Date(unixSec * 1000).getUTCDay(); // Sun=0..Sat=6
  const secOfDay = unixSec - startOfDayUTC(unixSec);
  const boundary = fxBoundarySec(unixSec);
  if (dow === 6) return false; // all of Saturday
  if (dow === 5 && secOfDay >= boundary) return false; // Friday after the close
  if (dow === 0 && secOfDay < boundary) return false; // Sunday before the open
  return true;
}

/** First instant of the next FX week at-or-after `unixSec`. Walks forward a day
 *  at a time and lands exactly on the Sunday boundary, so the answer is the open
 *  itself rather than "some time on Sunday". */
function nextFxWeekOpen(unixSec: number): number {
  for (let i = 0; i <= 8; i++) {
    const probe = unixSec + i * 86_400;
    const dow = new Date(probe * 1000).getUTCDay();
    if (dow !== 0) continue;
    const open = startOfDayUTC(probe) + fxBoundarySec(probe);
    if (open >= unixSec) return open;
  }
  // Unreachable for any sane input (a Sunday always occurs within 8 days).
  return unixSec;
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

export type MarketHoursResult =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      /** UTC unix-second of the next NYSE session open at-or-after `unixSec`.
       *  Undefined when the calendar is exhausted within the 30-day search
       *  window — buildMarketClosedTooltip handles this case explicitly. */
      nextValidUnixSec?: number;
    };

/** Returns whether the given Unix-second timestamp falls inside a NYSE
 *  regular session for the asset class's settlement venue. */
export function isMarketHours(
  unixSec: number,
  assetClass: AssetClass,
): MarketHoursResult {
  // FX (class 3): gated on the trading WEEK, not a session. Checked before the
  // NYSE branch because FX is not in NYSE_GATED_CLASSES and would otherwise fall
  // straight through to `ok: true`, which is exactly the hole this closes.
  if (assetClass === ASSET_CLASS_FX) {
    if (isFxTradingWeek(unixSec)) return { ok: true };
    return {
      ok: false,
      reason: "FX market closed at this time (weekend).",
      nextValidUnixSec: nextFxWeekOpen(unixSec),
    };
  }

  if (!NYSE_GATED_CLASSES.has(assetClass)) {
    return { ok: true };
  }
  const year = new Date(unixSec * 1000).getUTCFullYear();
  if (!calendarCoversYear(year)) {
    return {
      ok: false,
      reason: `Market-hours calendar exhausted for year ${year}. Extend NYSE_HOLIDAYS_BY_YEAR.`,
    };
  }
  const d = new Date(unixSec * 1000);
  const dow = d.getUTCDay(); // Sun=0..Sat=6
  if (dow === 0 || dow === 6) {
    return {
      ok: false,
      reason: "NYSE closed at this time (weekend).",
      nextValidUnixSec: nextValidSessionOpen(unixSec),
    };
  }
  const ymd = ymdUTC(unixSec);
  if (isNyseHoliday(ymd)) {
    return {
      ok: false,
      reason: "NYSE closed at this time (US market holiday).",
      nextValidUnixSec: nextValidSessionOpen(unixSec),
    };
  }
  const dst = isUSDST(unixSec);
  const dayStart = startOfDayUTC(unixSec);
  const openSec =
    dayStart +
    (dst ? SESSION_OPEN_H_DST : SESSION_OPEN_H_STD) * 3600 +
    SESSION_OPEN_M * 60;
  const earlyClose = isNyseEarlyClose(ymd);
  const closeH = earlyClose
    ? dst
      ? HALF_DAY_CLOSE_H_DST
      : HALF_DAY_CLOSE_H_STD
    : dst
      ? SESSION_CLOSE_H_DST
      : SESSION_CLOSE_H_STD;
  const closeSec = dayStart + closeH * 3600;
  if (unixSec < openSec) {
    return {
      ok: false,
      reason: "NYSE not yet open at this time.",
      nextValidUnixSec: openSec,
    };
  }
  if (unixSec >= closeSec) {
    return {
      ok: false,
      reason: earlyClose
        ? "NYSE closed at this time (early-close day)."
        : "NYSE closed at this time (after regular session).",
      nextValidUnixSec: nextValidSessionOpen(unixSec),
    };
  }
  return { ok: true };
}

/** Walk forward day-by-day to find the next NYSE session open
 *  at-or-after `unixSec`. Capped at 30 days; beyond that the calendar
 *  is likely exhausted and the caller returns undefined. */
function nextValidSessionOpen(unixSec: number): number | undefined {
  const todayStart = startOfDayUTC(unixSec);
  for (let i = 1; i <= 30; i++) {
    const ref = new Date(todayStart * 1000);
    const candidateStart = Math.floor(
      Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate() + i) /
        1000,
    );
    const year = new Date(candidateStart * 1000).getUTCFullYear();
    if (!calendarCoversYear(year)) return undefined;
    const dow = new Date(candidateStart * 1000).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if (isNyseHoliday(ymdUTC(candidateStart))) continue;
    const dst = isUSDST(candidateStart);
    return (
      candidateStart +
      (dst ? SESSION_OPEN_H_DST : SESSION_OPEN_H_STD) * 3600 +
      SESSION_OPEN_M * 60
    );
  }
  return undefined;
}

/** Format `toUnixSec - fromUnixSec` as a "from now" human string. */
function formatDelta(fromUnixSec: number, toUnixSec: number): string {
  const deltaSec = Math.max(0, toUnixSec - fromUnixSec);
  const days = Math.floor(deltaSec / 86400);
  const hours = Math.floor((deltaSec % 86400) / 3600);
  const mins = Math.floor((deltaSec % 3600) / 60);
  if (days >= 1) return `${days}d ${hours}h from now`;
  if (hours >= 1) return mins > 0 ? `${hours}h ${mins}m from now` : `${hours}h from now`;
  return `${mins}m from now`;
}

/**
 * Build the tooltip body shown on the disabled submit button when
 * `isMarketHours` returns ok:false. Always surfaces the "from now" delta to the
 * next valid session per W3 refinement (2) — never silently shifts the user
 * forward without the delta visible.
 *
 * THE SENTENCE HAS TWO CLOCKS, AND IT MUST SAY SO (fresh-wallet smoke,
 * 2026-08-09):
 *
 *   On a Sunday, AAPL on /write read "NYSE not yet open. Next session opens
 *   Friday at 13:30 UTC (4d 22h from now)." That was reported as a broken
 *   calendar. The calendar was right. `result` describes the SELECTED EXPIRY
 *   (an epoch weekly, Friday 08:00 UTC — before that Friday's open), while the
 *   delta is measured from NOW. Two subjects in one sentence, and the reader
 *   supplied the wrong one: read as a statement about the present it says NYSE
 *   next opens on Friday, which on a Sunday is four days wrong.
 *
 * So the sentence names its subject up front. The reason still follows, because
 * WHY the expiry is out of hours (weekend / holiday / pre-open / early close)
 * is the part that tells the user how to move it.
 */
const EXPIRY_SUBJECT = "The selected expiry is outside NYSE hours.";

/**
 * "opens 13:30 UTC Tue" — a fact, for the create surface.
 *
 * Item 7 exists because a closed-market create currently fails with "Verification
 * quote unavailable — retry." That word is wrong twice over: retrying now cannot
 * work, and the user is given no idea when it could. A market that is shut until
 * Tuesday should say Tuesday.
 *
 * Deliberately short and absolute (no "in 14 hours"): this is rendered next to a
 * disabled button that the user may look at again later, and a relative time
 * would be stale the moment it is read.
 */
export function nextOpenLabel(nextValidUnixSec: number): string {
  const d = new Date(nextValidUnixSec * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const wd = d.toLocaleDateString("en-US", { weekday: "short", timeZone: "UTC" });
  return `opens ${hh}:${mm} UTC ${wd}`;
}

export function buildMarketClosedTooltip(
  result: Extract<MarketHoursResult, { ok: false }>,
  nowUnixSec: number,
): string {
  if (result.nextValidUnixSec === undefined) {
    return `${result.reason} Calendar may be out of range — contact support.`;
  }
  const next = result.nextValidUnixSec;
  const nextDate = new Date(next * 1000);
  const weekday = nextDate.toLocaleDateString("en-US", {
    weekday: "long",
    timeZone: "UTC",
  });
  const hh = String(nextDate.getUTCHours()).padStart(2, "0");
  const mm = String(nextDate.getUTCMinutes()).padStart(2, "0");
  const delta = formatDelta(nowUnixSec, next);
  return `${EXPIRY_SUBJECT} ${result.reason} Next session opens ${weekday} at ${hh}:${mm} UTC (${delta}).`;
}
