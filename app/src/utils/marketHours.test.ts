// =============================================================================
// marketHours.test.ts — SLICE 2B: the FX trading-week gate (item 8)
// =============================================================================
//   run: node app/scripts/run-market-hours-tests.mjs
//
// WHY THIS GATE EXISTS. FX has no exchange session, but it has a WEEK: the
// market closes ~17:00 New York on Friday and reopens ~17:00 New York on Sunday.
// Between those two moments there is no price to settle against.
//
// v1 tracked this as follow-up and never built it, on the argument that the
// stuck-vault rate for FX is "much lower than NYSE equities". True, and
// irrelevant: the rate for a WEEKEND FX EXPIRY specifically is 100%. Until this
// gate, a user could write EURUSD expiring on a Saturday — a contract whose
// settlement source is shut for the entire window in which it expires.
//
// All timestamps below are constructed with Date.UTC so the suite has no local
// timezone dependence.
// =============================================================================

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ASSET_CLASS_COMMODITY,
  ASSET_CLASS_CRYPTO,
  ASSET_CLASS_FX,
  isFxTradingWeek,
  isMarketHours,
  nextOpenLabel,
} from "./marketHours";

/** Unix seconds for a UTC wall-clock instant. */
const at = (y: number, m: number, d: number, h = 0, min = 0): number =>
  Math.floor(Date.UTC(y, m - 1, d, h, min) / 1000);

// August 2026 is US DST, so the FX boundary is 21:00 UTC (17:00 New York).
// 2026-08-14 is a Friday; 08-15 Sat; 08-16 Sun; 08-17 Mon.
const FRI = [2026, 8, 14] as const;
const SAT = [2026, 8, 15] as const;
const SUN = [2026, 8, 16] as const;
const MON = [2026, 8, 17] as const;

// ---- the closed window ------------------------------------------------------

test("RED: a Saturday FX expiry is BLOCKED", () => {
  const r = isMarketHours(at(...SAT, 12, 0), ASSET_CLASS_FX);
  assert.equal(r.ok, false, "Saturday has no FX market to settle against");
});

test("RED: Friday AFTER the 21:00 UTC close is BLOCKED", () => {
  assert.equal(isMarketHours(at(...FRI, 21, 0), ASSET_CLASS_FX).ok, false, "exactly at the close");
  assert.equal(isMarketHours(at(...FRI, 23, 30), ASSET_CLASS_FX).ok, false, "after the close");
});

test("RED: Sunday BEFORE the 21:00 UTC open is BLOCKED", () => {
  assert.equal(isMarketHours(at(...SUN, 3, 0), ASSET_CLASS_FX).ok, false);
  assert.equal(
    isMarketHours(at(...SUN, 20, 59), ASSET_CLASS_FX).ok,
    false,
    "one minute before the open",
  );
});

// ---- the open window --------------------------------------------------------

test("Friday BEFORE the close is allowed", () => {
  assert.equal(isMarketHours(at(...FRI, 20, 59), ASSET_CLASS_FX).ok, true);
  assert.equal(isMarketHours(at(...FRI, 12, 0), ASSET_CLASS_FX).ok, true);
});

test("Sunday AT and after the open is allowed", () => {
  assert.equal(isMarketHours(at(...SUN, 21, 0), ASSET_CLASS_FX).ok, true, "the open itself");
  assert.equal(isMarketHours(at(...SUN, 23, 0), ASSET_CLASS_FX).ok, true);
});

test("midweek is allowed at any hour — FX is 24h inside its week", () => {
  for (const h of [0, 6, 12, 18, 23]) {
    assert.equal(isMarketHours(at(...MON, h, 0), ASSET_CLASS_FX).ok, true, `Monday ${h}:00`);
  }
});

// ---- the recovery hint ------------------------------------------------------

test("a blocked FX expiry reports the NEXT week open, not just a refusal", () => {
  const r = isMarketHours(at(...SAT, 12, 0), ASSET_CLASS_FX);
  assert.equal(r.ok, false);
  const next = (r as { nextValidUnixSec?: number }).nextValidUnixSec;
  assert.equal(next, at(...SUN, 21, 0), "must land exactly on the Sunday open");
});

test("the next-open is always in the future and always inside the week", () => {
  for (const t of [at(...FRI, 22, 0), at(...SAT, 0, 1), at(...SAT, 23, 59), at(...SUN, 0, 0)]) {
    const r = isMarketHours(t, ASSET_CLASS_FX) as { ok: false; nextValidUnixSec?: number };
    assert.equal(r.ok, false);
    assert.ok(r.nextValidUnixSec! > t, "next open must be strictly ahead");
    assert.equal(isFxTradingWeek(r.nextValidUnixSec!), true, "and must itself be inside the week");
  }
});

// ---- DST boundary -----------------------------------------------------------

test("the boundary follows US DST — 22:00 UTC in winter, 21:00 UTC in summer", () => {
  // 2026-01-16 is a Friday, in US standard time → close at 22:00 UTC.
  assert.equal(isFxTradingWeek(at(2026, 1, 16, 21, 30)), true, "21:30 UTC is still open in winter");
  assert.equal(isFxTradingWeek(at(2026, 1, 16, 22, 0)), false, "22:00 UTC is the winter close");
  // August is DST → close at 21:00 UTC.
  assert.equal(isFxTradingWeek(at(...FRI, 21, 30)), false, "21:30 UTC is already shut in summer");
});

// ---- the gate must not leak into other classes ------------------------------

test("crypto is NEVER gated — it trades through the weekend", () => {
  assert.equal(isMarketHours(at(...SAT, 12, 0), ASSET_CLASS_CRYPTO).ok, true);
  assert.equal(isMarketHours(at(...SUN, 3, 0), ASSET_CLASS_CRYPTO).ok, true);
});

test("commodity is unchanged by this slice (its own gate is still follow-up)", () => {
  assert.equal(isMarketHours(at(...SAT, 12, 0), ASSET_CLASS_COMMODITY).ok, true);
});

// ---- nextOpenLabel (item 7) -------------------------------------------------

test("nextOpenLabel states an absolute time, never a relative one", () => {
  // Relative time ("in 14 hours") goes stale the moment it is rendered next to a
  // disabled button the user may look at again later.
  assert.equal(nextOpenLabel(at(...SUN, 21, 0)), "opens 21:00 UTC Sun");
  assert.equal(nextOpenLabel(at(2026, 8, 18, 13, 30)), "opens 13:30 UTC Tue");
});

test("nextOpenLabel zero-pads and stays UTC", () => {
  assert.equal(nextOpenLabel(at(2026, 8, 17, 9, 5)), "opens 09:05 UTC Mon");
  assert.equal(nextOpenLabel(at(2026, 8, 17, 0, 0)), "opens 00:00 UTC Mon");
});

// ---- NYSE regression guard --------------------------------------------------

test("NYSE gating still behaves — the FX branch must not shadow it", () => {
  // 2026-08-18 is a Tuesday. 08:00 UTC is before the 13:30 UTC DST open.
  const early = isMarketHours(at(2026, 8, 18, 8, 0), 2);
  assert.equal(early.ok, false, "an 08:00 UTC equity expiry is still outside NYSE hours");
  // ...and inside the session it passes.
  assert.equal(isMarketHours(at(2026, 8, 18, 15, 0), 2).ok, true);
});
