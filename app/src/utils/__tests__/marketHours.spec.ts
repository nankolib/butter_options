// =============================================================================
// marketHours.spec.ts — standalone runnable tests for the NYSE gate
// =============================================================================
//
// No test framework needed. Run via:
//   cd app && npx tsx src/utils/__tests__/marketHours.spec.ts
// Exit code 0 = all pass, 1 = at least one failure.
//
// Mirrors the test pattern from app/scripts/test-window-walk.ts.
// =============================================================================

import {
  isMarketHours,
  buildMarketClosedTooltip,
  ASSET_CLASS_CRYPTO,
  ASSET_CLASS_COMMODITY,
  ASSET_CLASS_EQUITY,
  ASSET_CLASS_FX,
  ASSET_CLASS_ETF,
} from "../marketHours";

let passes = 0;
let fails = 0;

function assert(cond: boolean, label: string): void {
  if (cond) {
    process.stdout.write(`  PASS  ${label}\n`);
    passes++;
  } else {
    process.stdout.write(`  FAIL  ${label}\n`);
    fails++;
  }
}

function assertEq<T>(actual: T, expected: T, label: string): void {
  if (actual === expected) {
    process.stdout.write(`  PASS  ${label}\n`);
    passes++;
  } else {
    process.stdout.write(
      `  FAIL  ${label}\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}\n`,
    );
    fails++;
  }
}

function utc(
  year: number,
  month1: number,
  day: number,
  hour: number = 0,
  minute: number = 0,
  second: number = 0,
): number {
  return Math.floor(Date.UTC(year, month1 - 1, day, hour, minute, second) / 1000);
}

process.stdout.write("\n=== non-NYSE asset classes (no gate in v1) ===\n");
{
  const sat = utc(2026, 6, 27, 19, 28, 0); // user's MSTR Saturday expiry
  assert(isMarketHours(sat, ASSET_CLASS_CRYPTO).ok === true, "Crypto Saturday → ok");
  assert(
    isMarketHours(sat, ASSET_CLASS_COMMODITY).ok === true,
    "Commodity Saturday → ok (v1 gap: CME hours not gated)",
  );
  assert(
    isMarketHours(sat, ASSET_CLASS_FX).ok === true,
    "FX Saturday → ok (v1 gap: weekend rollovers not gated)",
  );
}

process.stdout.write("\n=== NYSE-gated classes blocked on weekend ===\n");
{
  const sat = utc(2026, 6, 27, 19, 28, 0);
  const sun = utc(2026, 6, 28, 12, 0, 0);

  const equitySat = isMarketHours(sat, ASSET_CLASS_EQUITY);
  assert(equitySat.ok === false, "Equity Saturday → blocked");
  if (!equitySat.ok) {
    assert(equitySat.reason.includes("weekend"), "Saturday reason mentions 'weekend'");
    // Sat Jun 27 19:28 UTC → Next NYSE session: Mon Jun 29 13:30 UTC (DST)
    assertEq(
      equitySat.nextValidUnixSec,
      utc(2026, 6, 29, 13, 30, 0),
      "Saturday → next valid Mon Jun 29 13:30 UTC (DST open)",
    );
  }
  assert(
    isMarketHours(sat, ASSET_CLASS_ETF).ok === false,
    "ETF Saturday → blocked (same gate)",
  );
  assert(isMarketHours(sun, ASSET_CLASS_EQUITY).ok === false, "Equity Sunday → blocked");
}

process.stdout.write("\n=== regular session — DST window (June 2026) ===\n");
{
  // Mon Jun 29 2026 is during DST. Open 13:30 UTC, close 20:00 UTC.
  assert(
    isMarketHours(utc(2026, 6, 29, 13, 30, 0), ASSET_CLASS_EQUITY).ok === true,
    "DST Mon 13:30:00 UTC → ok (at open)",
  );
  assert(
    isMarketHours(utc(2026, 6, 29, 13, 29, 59), ASSET_CLASS_EQUITY).ok === false,
    "DST Mon 13:29:59 UTC → blocked (pre-open)",
  );
  assert(
    isMarketHours(utc(2026, 6, 29, 19, 59, 59), ASSET_CLASS_EQUITY).ok === true,
    "DST Mon 19:59:59 UTC → ok (in session)",
  );
  assert(
    isMarketHours(utc(2026, 6, 29, 20, 0, 0), ASSET_CLASS_EQUITY).ok === false,
    "DST Mon 20:00:00 UTC → blocked (after close)",
  );
}

process.stdout.write("\n=== regular session — STANDARD window (December 2026) ===\n");
{
  // Mon Dec 7 2026 is during standard. Open 14:30 UTC, close 21:00 UTC.
  assert(
    isMarketHours(utc(2026, 12, 7, 14, 30, 0), ASSET_CLASS_EQUITY).ok === true,
    "Standard Mon 14:30:00 UTC → ok",
  );
  assert(
    isMarketHours(utc(2026, 12, 7, 14, 29, 59), ASSET_CLASS_EQUITY).ok === false,
    "Standard Mon 14:29:59 UTC → blocked",
  );
  assert(
    isMarketHours(utc(2026, 12, 7, 20, 59, 59), ASSET_CLASS_EQUITY).ok === true,
    "Standard Mon 20:59:59 UTC → ok",
  );
  assert(
    isMarketHours(utc(2026, 12, 7, 21, 0, 0), ASSET_CLASS_EQUITY).ok === false,
    "Standard Mon 21:00:00 UTC → blocked",
  );
}

process.stdout.write("\n=== US market holidays (full closure) ===\n");
{
  assert(
    isMarketHours(utc(2026, 12, 25, 15, 0, 0), ASSET_CLASS_EQUITY).ok === false,
    "Christmas Day 2026 (Fri) mid-day → blocked",
  );
  assert(
    isMarketHours(utc(2026, 7, 3, 14, 0, 0), ASSET_CLASS_EQUITY).ok === false,
    "Independence Day observed 2026 (Fri Jul 3) → blocked",
  );
  assert(
    isMarketHours(utc(2026, 1, 1, 15, 0, 0), ASSET_CLASS_EQUITY).ok === false,
    "New Year's Day 2026 (Thu) → blocked",
  );
  assert(
    isMarketHours(utc(2026, 11, 26, 15, 0, 0), ASSET_CLASS_EQUITY).ok === false,
    "Thanksgiving 2026 (Thu Nov 26) → blocked",
  );
}

process.stdout.write("\n=== half-day closures ===\n");
{
  // Black Friday 2026 = Fri Nov 27, standard time (DST ended Nov 1). Open
  // 14:30 UTC, normal close 21:00 UTC, half-day close 18:00 UTC.
  assert(
    isMarketHours(utc(2026, 11, 27, 17, 59, 59), ASSET_CLASS_EQUITY).ok === true,
    "Black Friday 2026 17:59:59 UTC → ok (in early-close session)",
  );
  const blackFri = isMarketHours(utc(2026, 11, 27, 18, 0, 0), ASSET_CLASS_EQUITY);
  assert(blackFri.ok === false, "Black Friday 2026 18:00 UTC → blocked (early close)");
  if (!blackFri.ok) {
    assert(blackFri.reason.includes("early-close"), "Black Friday reason mentions 'early-close'");
  }
  // Christmas Eve 2026 = Thu Dec 24, standard. Early close 18:00 UTC.
  assert(
    isMarketHours(utc(2026, 12, 24, 17, 59, 59), ASSET_CLASS_EQUITY).ok === true,
    "Christmas Eve 2026 17:59:59 UTC → ok",
  );
  assert(
    isMarketHours(utc(2026, 12, 24, 18, 0, 0), ASSET_CLASS_EQUITY).ok === false,
    "Christmas Eve 2026 18:00 UTC → blocked",
  );
}

process.stdout.write("\n=== DST boundaries (2026) ===\n");
{
  // DST starts 2nd Sun March = Mar 8 2026 at 02:00 EST = 07:00 UTC.
  // Mon Mar 9 2026 → DST hours (open 13:30 UTC).
  assert(
    isMarketHours(utc(2026, 3, 9, 13, 30, 0), ASSET_CLASS_EQUITY).ok === true,
    "Mon Mar 9 2026 13:30 UTC → ok (first DST Mon)",
  );
  assert(
    isMarketHours(utc(2026, 3, 9, 13, 29, 59), ASSET_CLASS_EQUITY).ok === false,
    "Mon Mar 9 2026 13:29:59 UTC → blocked (DST pre-open)",
  );
  // Mon Mar 2 2026 = still standard (DST not yet started), open 14:30 UTC.
  assert(
    isMarketHours(utc(2026, 3, 2, 14, 30, 0), ASSET_CLASS_EQUITY).ok === true,
    "Mon Mar 2 2026 14:30 UTC → ok (still standard, at open)",
  );
  assert(
    isMarketHours(utc(2026, 3, 2, 13, 30, 0), ASSET_CLASS_EQUITY).ok === false,
    "Mon Mar 2 2026 13:30 UTC → blocked (standard, pre-open)",
  );
  // DST ends 1st Sun Nov = Nov 1 2026 at 02:00 EDT = 06:00 UTC.
  // Mon Nov 2 2026 → standard hours (open 14:30 UTC).
  assert(
    isMarketHours(utc(2026, 11, 2, 14, 30, 0), ASSET_CLASS_EQUITY).ok === true,
    "Mon Nov 2 2026 14:30 UTC → ok (first standard Mon)",
  );
  assert(
    isMarketHours(utc(2026, 11, 2, 13, 30, 0), ASSET_CLASS_EQUITY).ok === false,
    "Mon Nov 2 2026 13:30 UTC → blocked (post-DST, pre-open)",
  );
  // Fri Oct 30 2026 = DST still active (DST ends Nov 1)
  assert(
    isMarketHours(utc(2026, 10, 30, 13, 30, 0), ASSET_CLASS_EQUITY).ok === true,
    "Fri Oct 30 2026 13:30 UTC → ok (DST still active)",
  );
}

process.stdout.write("\n=== calendar exhaustion ===\n");
{
  const r2028 = isMarketHours(utc(2028, 1, 5, 15, 0, 0), ASSET_CLASS_EQUITY);
  assert(r2028.ok === false, "Equity in uncovered year (2028) → blocked");
  if (!r2028.ok) {
    assert(r2028.reason.includes("exhausted"), "exhaustion reason mentions 'exhausted'");
    assert(
      r2028.nextValidUnixSec === undefined,
      "no nextValidUnixSec when calendar exhausted",
    );
  }
}

process.stdout.write("\n=== Epoch (08:00 UTC) is ALWAYS out-of-hours for equity ===\n");
{
  // Epoch expiry semantics: nextFridayUtc8() always returns 08:00 UTC.
  // NYSE opens 13:30 UTC (DST) / 14:30 UTC (standard). So Epoch equity
  // is structurally un-settleable until the on-chain EpochConfig
  // supports a per-asset-class hour. v1 surfaces this as a blocker.
  const fri08 = utc(2026, 7, 10, 8, 0, 0); // Fri Jul 10 2026 08:00 UTC
  // Verify Fri Jul 10 is a Friday and not a holiday
  assert(
    new Date(fri08 * 1000).getUTCDay() === 5,
    "(sanity) Jul 10 2026 is a Friday",
  );
  assert(
    isMarketHours(fri08, ASSET_CLASS_EQUITY).ok === false,
    "Equity Epoch (Fri 08:00 UTC) → blocked, before NYSE opens",
  );
}

process.stdout.write("\n=== tooltip format (W3 refinement 2) ===\n");
{
  // MSTR user case: Sat 2026-06-27 19:28 UTC; nowUnixSec = same.
  // Next valid = Mon Jun 29 2026 13:30 UTC. Delta = 42h 02m = 1d 18h.
  const sat = utc(2026, 6, 27, 19, 28, 0);
  const r = isMarketHours(sat, ASSET_CLASS_EQUITY);
  if (!r.ok) {
    const tt = buildMarketClosedTooltip(r, sat);
    assert(tt.includes("Monday"), "tooltip includes weekday 'Monday'");
    assert(tt.includes("13:30 UTC"), "tooltip includes 'HH:MM UTC' format");
    assert(
      tt.includes("1d 18h from now"),
      `tooltip includes '1d 18h from now' (got: ${tt})`,
    );
    assert(tt.includes("weekend"), "tooltip preserves reason 'weekend'");
    assert(
      tt.startsWith("The selected expiry is outside NYSE hours."),
      `tooltip names its subject up front (got: ${tt})`,
    );
    process.stdout.write(`        verbatim: "${tt}"\n`);
  } else {
    fails++;
    process.stdout.write("  FAIL  expected r.ok=false but got true\n");
  }
  // Exhausted-calendar tooltip — no 'Next session' line.
  const r2028 = isMarketHours(utc(2028, 1, 5, 15, 0, 0), ASSET_CLASS_EQUITY);
  if (!r2028.ok) {
    const tt2028 = buildMarketClosedTooltip(r2028, utc(2028, 1, 5, 15, 0, 0));
    assert(tt2028.includes("Calendar"), "exhaustion tooltip mentions Calendar");
    assert(!tt2028.includes("Next session"), "exhaustion tooltip has no 'Next session' line");
  }
}

process.stdout.write("\n=== regression: the 2026-08-09 'wrong date' report ===\n");
{
  // The tooltip's two clocks. A founder on Sunday 2026-08-09 read
  //   "NYSE not yet open. Next session opens Friday at 13:30 UTC (4d 22h…)"
  // as a claim about NOW and filed it as a broken calendar — on a Sunday the
  // next session is MONDAY. The calendar was never wrong: the gate is fed the
  // SELECTED EXPIRY (epoch weekly = Friday 08:00 UTC, before that Friday's
  // 13:30 open), and only the delta is measured from now.
  //
  // This test pins BOTH readings so neither can drift into the other.
  const nowSun = utc(2026, 8, 9, 15, 30, 0); // Sun 2026-08-09 15:30 UTC
  const epochFri = utc(2026, 8, 14, 8, 0, 0); // Fri 2026-08-14 08:00 UTC

  assertEq(new Date(nowSun * 1000).getUTCDay(), 0, "(sanity) 2026-08-09 is a Sunday");
  assertEq(new Date(epochFri * 1000).getUTCDay(), 5, "(sanity) 2026-08-14 is a Friday");

  // (a) Fed the EXPIRY — what /write actually does.
  const rExpiry = isMarketHours(epochFri, ASSET_CLASS_EQUITY);
  assert(rExpiry.ok === false, "epoch Friday 08:00 UTC expiry → blocked");
  if (!rExpiry.ok) {
    assertEq(
      rExpiry.nextValidUnixSec,
      utc(2026, 8, 14, 13, 30, 0),
      "next valid is the SAME Friday's 13:30 open, not the following week",
    );
    const tt = buildMarketClosedTooltip(rExpiry, nowSun);
    assertEq(
      tt,
      "The selected expiry is outside NYSE hours. NYSE not yet open at this time. " +
        "Next session opens Friday at 13:30 UTC (4d 22h from now).",
      "expiry tooltip is verbatim-pinned and cannot be misread as a now-statement",
    );
  }

  // (b) Fed NOW — the reading the founder made. Must answer Monday.
  const rNow = isMarketHours(nowSun, ASSET_CLASS_EQUITY);
  assert(rNow.ok === false, "Sunday now → blocked");
  if (!rNow.ok) {
    assertEq(
      rNow.nextValidUnixSec,
      utc(2026, 8, 10, 13, 30, 0),
      "from Sunday, the next NYSE open is Monday 2026-08-10 13:30 UTC",
    );
    assert(
      buildMarketClosedTooltip(rNow, nowSun).includes("Monday"),
      "a now-fed tooltip says Monday — the calendar was never the bug",
    );
  }
}

process.stdout.write(
  `\n========================================\n  ${passes} passed, ${fails} failed\n========================================\n`,
);
process.exit(fails > 0 ? 1 : 0);
