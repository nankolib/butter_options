// =============================================================================
// marketHours.ts — VENDORED COPY of app/src/utils/marketHours.ts
// =============================================================================
// ⚠️  KEEP IN SYNC with app/src/utils/marketHours.ts. This is a verbatim copy so
// the writer package stays a standalone tsc->dist build (no cross-tree import of
// the React app). The NYSE holiday/early-close calendar is hardcoded 2026-2027;
// EXTEND BOTH FILES together before exhaustion. `isMarketHours` fails CLOSED on
// an uncovered year (returns ok:false "calendar exhausted"), which the writer
// treats as "do not write" — never as "open".
//
// Gated classes: 2 (Equity), 4 (ETF). Crypto (0) / Commodity (1) / FX (3) pass
// through {ok:true}. For the writer, XAU (class 1) is therefore NOT hours-gated
// here; off-LBMA-hours protection for XAU comes from the SB oracle going stale
// (quote fails -> cell skipped), per the signed-off spec §h.
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

const NYSE_HOLIDAYS_BY_YEAR: Record<number, readonly string[]> = {
  2026: [
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25",
    "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
  ],
  2027: [
    "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31",
    "2027-06-18", "2027-07-05", "2027-09-06", "2027-11-25", "2027-12-24",
  ],
};

const NYSE_EARLY_CLOSE_BY_YEAR: Record<number, readonly string[]> = {
  2026: ["2026-11-27", "2026-12-24"],
  2027: ["2027-11-26"],
};

const SESSION_OPEN_H_DST = 13;
const SESSION_OPEN_M = 30;
const SESSION_CLOSE_H_DST = 20;
const SESSION_OPEN_H_STD = 14;
const SESSION_CLOSE_H_STD = 21;
const HALF_DAY_CLOSE_H_DST = 17;
const HALF_DAY_CLOSE_H_STD = 18;

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
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
}

export type MarketHoursResult =
  | { ok: true }
  | { ok: false; reason: string; nextValidUnixSec?: number };

export function isMarketHours(unixSec: number, assetClass: AssetClass): MarketHoursResult {
  if (!NYSE_GATED_CLASSES.has(assetClass)) return { ok: true };
  const year = new Date(unixSec * 1000).getUTCFullYear();
  if (!calendarCoversYear(year)) {
    return { ok: false, reason: `Market-hours calendar exhausted for year ${year}. Extend NYSE_HOLIDAYS_BY_YEAR.` };
  }
  const d = new Date(unixSec * 1000);
  const dow = d.getUTCDay();
  if (dow === 0 || dow === 6) {
    return { ok: false, reason: "NYSE closed (weekend).", nextValidUnixSec: nextValidSessionOpen(unixSec) };
  }
  const ymd = ymdUTC(unixSec);
  if (isNyseHoliday(ymd)) {
    return { ok: false, reason: "NYSE closed (US market holiday).", nextValidUnixSec: nextValidSessionOpen(unixSec) };
  }
  const dst = isUSDST(unixSec);
  const dayStart = startOfDayUTC(unixSec);
  const openSec = dayStart + (dst ? SESSION_OPEN_H_DST : SESSION_OPEN_H_STD) * 3600 + SESSION_OPEN_M * 60;
  const earlyClose = isNyseEarlyClose(ymd);
  const closeH = earlyClose
    ? (dst ? HALF_DAY_CLOSE_H_DST : HALF_DAY_CLOSE_H_STD)
    : (dst ? SESSION_CLOSE_H_DST : SESSION_CLOSE_H_STD);
  const closeSec = dayStart + closeH * 3600;
  if (unixSec < openSec) return { ok: false, reason: "NYSE not yet open.", nextValidUnixSec: openSec };
  if (unixSec >= closeSec) {
    return {
      ok: false,
      reason: earlyClose ? "NYSE closed (early-close day)." : "NYSE closed (after regular session).",
      nextValidUnixSec: nextValidSessionOpen(unixSec),
    };
  }
  return { ok: true };
}

function nextValidSessionOpen(unixSec: number): number | undefined {
  const todayStart = startOfDayUTC(unixSec);
  for (let i = 1; i <= 30; i++) {
    const ref = new Date(todayStart * 1000);
    const candidateStart = Math.floor(
      Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate() + i) / 1000,
    );
    const year = new Date(candidateStart * 1000).getUTCFullYear();
    if (!calendarCoversYear(year)) return undefined;
    const dow = new Date(candidateStart * 1000).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    if (isNyseHoliday(ymdUTC(candidateStart))) continue;
    const dst = isUSDST(candidateStart);
    return candidateStart + (dst ? SESSION_OPEN_H_DST : SESSION_OPEN_H_STD) * 3600 + SESSION_OPEN_M * 60;
  }
  return undefined;
}

/**
 * Is `unixSec` a full-closure NYSE day (weekend or holiday)? Used by the equity
 * expiry generator to skip Fridays the exchange is dark, so a 19:45Z expiry
 * never lands on a closed session.
 */
export function isNyseClosedDay(unixSec: number): boolean {
  const year = new Date(unixSec * 1000).getUTCFullYear();
  if (!calendarCoversYear(year)) return true; // fail closed
  const dow = new Date(unixSec * 1000).getUTCDay();
  if (dow === 0 || dow === 6) return true;
  return isNyseHoliday(ymdUTC(unixSec));
}

/** Is this an early-close (half-day) session? A 19:45Z expiry would be AFTER a
 *  half-day close (17:00Z DST / 18:00Z std), so the generator must skip it. */
export function isNyseEarlyCloseDay(unixSec: number): boolean {
  return isNyseEarlyClose(ymdUTC(unixSec));
}
