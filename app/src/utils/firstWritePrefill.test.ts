// =============================================================================
// firstWritePrefill.test.ts — SLICE 3: legality and rung alignment
// =============================================================================
//   run: node app/scripts/run-first-write-tests.mjs
//
// TWO JOBS.
//
// 1. LEGALITY. A prefilled expiry that cannot settle is worse than no prefill:
//    the user signs, posts collateral, and finds out weeks later. Equity is the
//    sharp case — epoch weeklies are Friday 08:00 UTC and NYSE opens 13:30 UTC,
//    so the naive weekly is illegal EVERY week of the year (F4's finding).
//
// 2. RUNG ALIGNMENT, pinned by LITERALS. The strike helpers here are copies of
//    writer/src/ladder.ts (canonical). The tier boundaries below are the same
//    literals writer/src/ladder.grid.test.ts asserts, so if either table moves,
//    that side's suite breaks. That mutual pin is the whole condition on which
//    the duplication was accepted.
// =============================================================================

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildFirstWritePrefill,
  gridStep,
  prefillExpiry,
  prefillStrike,
  roundSigStep,
  snapToGrid,
} from "./firstWritePrefill";
import { isFxTradingWeek, isMarketHours } from "./marketHours";

const CRYPTO = 0, COMMODITY = 1, EQUITY = 2, FX = 3, ETF = 4;
const at = (y: number, m: number, d: number, h = 0, min = 0) => Date.UTC(y, m - 1, d, h, min);

// ===========================================================================
// STRIKE TABLE — literals mirrored from writer/src/ladder.grid.test.ts
// ===========================================================================

test("gridStep tier boundaries — SAME LITERALS as the writer's own suite", () => {
  assert.equal(gridStep(49.99), 1);
  assert.equal(gridStep(50), 2.5);
  assert.equal(gridStep(99.99), 2.5);
  assert.equal(gridStep(100), 5);
  assert.equal(gridStep(249.99), 5);
  assert.equal(gridStep(250), 10);
  assert.equal(gridStep(499.99), 10);
  assert.equal(gridStep(500), 25);
  assert.equal(gridStep(999.99), 25);
  assert.equal(gridStep(1000), 50);
});

test("roundSigStep quanta — SAME LITERALS as the writer's churn suite", () => {
  assert.equal(roundSigStep(1.09, 3), 0.01);
  assert.equal(roundSigStep(65_000, 3), 100);
});

test("snapToGrid rounds half-up and is a no-op on a zero step", () => {
  assert.equal(snapToGrid(387, 10), 390);
  assert.equal(snapToGrid(384.9, 10), 380);
  assert.equal(snapToGrid(385, 10), 390); // half-up
  assert.equal(snapToGrid(42, 0), 42);
});

// ---- golden spot -> strike cases -------------------------------------------

test("GOLDEN: equity strikes land on the absolute grid", () => {
  // AAPL-ish, TSLA-ish, MSTR-ish, and a sub-$50 name.
  assert.equal(prefillStrike(232.17, EQUITY), 230); // step 5  -> 230
  assert.equal(prefillStrike(387.4, EQUITY), 390); // step 10 -> 390
  assert.equal(prefillStrike(1234.5, EQUITY), 1250); // step 50 -> 1250
  assert.equal(prefillStrike(41.2, EQUITY), 41); // step 1  -> 41
  assert.equal(prefillStrike(72.5, EQUITY), 72.5); // step 2.5 -> exact grid point
});

test("GOLDEN: ETF uses the same absolute grid as equity", () => {
  assert.equal(prefillStrike(232.17, ETF), prefillStrike(232.17, EQUITY));
});

test("GOLDEN: crypto strikes land on the 3-sig-fig rung", () => {
  // ORE at its measured seed price, plus BTC/SOL/XRP magnitudes.
  assert.equal(prefillStrike(62.212987, CRYPTO), 62.2); // step 0.1
  assert.equal(prefillStrike(1.1489, CRYPTO), 1.15); // step 0.01
  assert.equal(prefillStrike(64_812, CRYPTO), 64_800); // step 100
  // Sub-cent memes: the 3-sig-fig rung (0.0000232) is FINER than the chain can
  // represent, so it snaps to the tick. See the tick test below.
  assert.equal(prefillStrike(0.00002317, CRYPTO), 0.000023);
});

test("commodity and FX use the crypto convention, not the equity grid", () => {
  assert.equal(prefillStrike(2410.5, COMMODITY), prefillStrike(2410.5, CRYPTO));
  assert.equal(prefillStrike(1.0842, FX), prefillStrike(1.0842, CRYPTO));
  assert.notEqual(prefillStrike(2410.5, COMMODITY), prefillStrike(2410.5, EQUITY));
});

test("strikes are snapped to the on-chain tick — u64 micro-dollars", () => {
  // create_series.rs stores strike as u64 at 1e6 (strike_dollars = strike/1e6),
  // so $0.000001 is the finest representable strike. For very cheap tokens the
  // 3-sig-fig rung is finer than that and MUST be snapped, or the value we show
  // is not the value that reaches the chain.
  //
  // The writer bot converts through the same u64, so both sides truncate
  // identically and the rungs still agree.
  const micro = (x: number) => Math.round(x * 1e6);
  for (const spot of [0.00002317, 0.0000001234, 1.1489, 62.212987, 64_812]) {
    const k = prefillStrike(spot, CRYPTO)!;
    assert.equal(k * 1e6, micro(k), `${spot} -> ${k} is not an exact micro-dollar value`);
  }
});

test("a missing or nonsense spot yields no strike rather than a guess", () => {
  for (const bad of [0, -1, NaN, Infinity]) {
    assert.equal(prefillStrike(bad, CRYPTO), null, String(bad));
    assert.equal(prefillStrike(bad, EQUITY), null, String(bad));
  }
});

// ===========================================================================
// EXPIRY LEGALITY — the part that stops a user posting collateral into a
// contract whose settlement venue is shut.
// ===========================================================================

test("RED: an equity prefill is NEVER the Friday-08:00 epoch weekly", () => {
  // The naive weekly is illegal every week of the year: NYSE opens 13:30 UTC.
  // A prefill that proposed it would be a guaranteed stuck vault.
  const now = at(2026, 8, 12, 10, 0); // Wednesday
  const e = prefillExpiry(EQUITY, now)!;
  assert.ok(e !== null, "a legal equity expiry must exist");
  const d = new Date(e * 1000);
  assert.ok(
    !(d.getUTCDay() === 5 && d.getUTCHours() === 8),
    `prefill landed on the illegal Friday 08:00 UTC weekly (${d.toISOString()})`,
  );
  assert.equal(isMarketHours(e, EQUITY).ok, true, "and it must be inside a session");
});

test("equity prefill is inside an NYSE session from any starting hour", () => {
  for (const h of [0, 6, 10, 13, 14, 18, 21, 23]) {
    const e = prefillExpiry(EQUITY, at(2026, 8, 12, h, 0));
    assert.ok(e !== null, `no expiry from hour ${h}`);
    assert.equal(isMarketHours(e!, EQUITY).ok, true, `hour ${h} -> ${new Date(e! * 1000).toISOString()}`);
  }
});

test("equity prefill starting on a WEEKEND still lands in a session", () => {
  for (const day of [15, 16]) { // Sat, Sun
    const e = prefillExpiry(EQUITY, at(2026, 8, day, 12, 0));
    assert.ok(e !== null);
    assert.equal(isMarketHours(e!, EQUITY).ok, true);
    assert.ok(new Date(e! * 1000).getUTCDay() >= 1 && new Date(e! * 1000).getUTCDay() <= 5);
  }
});

test("equity prefill is always in the FUTURE and respects minLead", () => {
  const now = at(2026, 8, 12, 10, 0);
  const nowSec = Math.floor(now / 1000);
  const e = prefillExpiry(EQUITY, now)!;
  assert.ok(e > nowSec, "must be ahead of now");
  const lead = 3 * 86_400;
  const withLead = prefillExpiry(EQUITY, now, lead)!;
  assert.ok(withLead >= nowSec + lead, "must respect minLeadSecs");
  assert.equal(isMarketHours(withLead, EQUITY).ok, true);
});

test("crypto prefill is the epoch weekly — Friday 08:00 UTC", () => {
  const e = prefillExpiry(CRYPTO, at(2026, 8, 12, 10, 0))!;
  const d = new Date(e * 1000);
  assert.equal(d.getUTCDay(), 5, "Friday");
  assert.equal(d.getUTCHours(), 8, "08:00 UTC");
});

test("RED: an FX prefill is inside the FX trading week", () => {
  // Friday 08:00 UTC is inside the week (it closes 21:00/22:00 UTC Friday), so
  // the weekly IS legal here — but the code ASKS the gate rather than assuming,
  // and this test is what would catch it if the gate ever moved.
  for (const day of [10, 11, 12, 13, 14, 15, 16]) {
    const e = prefillExpiry(FX, at(2026, 8, day, 12, 0));
    assert.ok(e !== null, `no FX expiry from day ${day}`);
    assert.equal(isFxTradingWeek(e!), true, `day ${day} -> ${new Date(e! * 1000).toISOString()}`);
    assert.equal(isMarketHours(e!, FX).ok, true);
  }
});

test("FX prefill starting mid-weekend still lands inside the week", () => {
  // Saturday and Sunday-before-open: the weekly ahead is still Friday, which is
  // legal — the assertion is that we never propose a closed instant.
  for (const t of [at(2026, 8, 15, 12, 0), at(2026, 8, 16, 3, 0)]) {
    const e = prefillExpiry(FX, t)!;
    assert.equal(isFxTradingWeek(e), true);
  }
});

test("commodity prefill is ungated and always legal", () => {
  for (const day of [10, 15, 16]) {
    const e = prefillExpiry(COMMODITY, at(2026, 8, day, 12, 0))!;
    assert.equal(isMarketHours(e, COMMODITY).ok, true);
  }
});

// ===========================================================================
// The assembled prefill
// ===========================================================================

test("the full prefill is 1 contract, American, call, with a legal expiry", () => {
  const p = buildFirstWritePrefill({ spot: 62.212987, assetClass: CRYPTO, nowMs: at(2026, 8, 12, 10, 0) });
  assert.equal(p.contracts, 1);
  assert.equal(p.exerciseStyle, "american");
  assert.equal(p.side, "call");
  assert.equal(p.strike, 62.2);
  assert.equal(isMarketHours(p.expiry!, CRYPTO).ok, true);
});

test("no spot yet (Pyth arm still warming) → no strike, but the expiry stands", () => {
  // The panel renders during warming with the expiry already chosen; only the
  // strike waits on the oracle.
  const p = buildFirstWritePrefill({ spot: null, assetClass: CRYPTO, nowMs: at(2026, 8, 12, 10, 0) });
  assert.equal(p.strike, null);
  assert.ok(p.expiry !== null, "expiry does not depend on spot");
});

test("an equity prefill assembles legally end to end", () => {
  const p = buildFirstWritePrefill({ spot: 232.17, assetClass: EQUITY, nowMs: at(2026, 8, 12, 10, 0) });
  assert.equal(p.strike, 230);
  assert.equal(isMarketHours(p.expiry!, EQUITY).ok, true);
});
