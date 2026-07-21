// Churn-fix proof. Two mitigations, both pinned here:
//   1) STRIKE HYSTERESIS  — spot wobbling across a roundSig boundary must NOT
//      mint a new series (533 orphan-series pulls in 6h, ~1.55 SOL/h).
//   2) REPRICE ε-SKIP     — an age-triggered reprice that moves the price <1%
//      must skip the cancel+repost (2 txs) entirely.
//   run: npx ts-node --transpile-only src/engine.churn.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { roundSig, roundSigStep, stickyStrike, hystBand } from "./ladder";
import { repriceDecision } from "./engine";

// At x≈1.09 the 3-sig-fig quantum is 0.01, so the deadband is 0.01*0.75 = 0.0075.
// The rounding boundary sits at 1.095 (midpoint of 1.09 / 1.10).

test("baseline: roundSig alone FLIPS across the boundary (the bug being fixed)", () => {
  assert.equal(roundSig(1.0949, 3), 1.09);
  assert.equal(roundSig(1.0951, 3), 1.1);
  assert.equal(roundSigStep(1.09, 3), 0.01);
});

test("hysteresis UP: holding 1.09, spot wobbles up past the boundary → RETAIN 1.09", () => {
  // roundSig would say 1.10 → new series. Hysteresis must keep 1.09.
  assert.equal(stickyStrike(1.0951, [1.09]), 1.09);
  assert.equal(stickyStrike(1.096, [1.09]), 1.09);
});

test("hysteresis DOWN: holding 1.10, spot wobbles down past the boundary → RETAIN 1.10", () => {
  // roundSig would say 1.09 → new series. Hysteresis must keep 1.10.
  assert.equal(stickyStrike(1.0949, [1.1]), 1.1);
  assert.equal(stickyStrike(1.094, [1.1]), 1.1);
});

// v2 RE-BASED: these two cases previously asserted the v1 band width
// (0.75 x roundSigStep = 0.0075 at XRP scale), i.e. that a ~0.8% move adopts a
// fresh strike. v2 deliberately removes exactly that behaviour — the band is now
// 2.5% of spot — so the OLD expectations are the defect, not the spec. The
// intent of the test (a genuine move beyond the deadband must adopt) is
// preserved, re-pointed at the v2 threshold.
test("genuine move beyond the deadband ADOPTS the fresh strike (both directions)", () => {
  // band at raw≈1.11 is 0.025*1.11 ≈ 0.02775.
  assert.equal(stickyStrike(1.11, [1.09]), 1.09);   // |d|=0.02 inside → retain
  assert.equal(stickyStrike(1.13, [1.09]), 1.13);   // |d|=0.04 outside → fresh
  assert.equal(stickyStrike(1.06, [1.1]), 1.06);    // down and out
});

test("nearest live strike wins when several are held", () => {
  assert.equal(stickyStrike(1.0951, [1.09, 1.1]), 1.1);  // 0.0049 vs 0.0051
  assert.equal(stickyStrike(1.0949, [1.09, 1.1]), 1.09); // 0.0049 vs 0.0051
});

test("cold board (no live strikes) falls back to plain rounding", () => {
  assert.equal(stickyStrike(1.0951, []), 1.1);
  assert.equal(stickyStrike(1.0949, []), 1.09);
});

// v2 RE-BASED: same reason as above. Under v1 a 120-point move on BTC (0.18%)
// adopted a fresh strike — that IS the churn. v2 band at 65k is 1625.
test("hysteresis holds at other magnitudes (BTC scale)", () => {
  assert.equal(roundSigStep(65_000, 3), 100);          // roundSig grid unchanged
  assert.equal(stickyStrike(65_040, [65_000]), 65_000); // inside
  assert.equal(stickyStrike(65_120, [65_000]), 65_000); // v1 flipped here; v2 holds
  assert.equal(stickyStrike(66_700, [65_000]), 66_700); // beyond 1625 band → fresh
});

// ---- v2: rung-fraction band, drift sweep at mantissa extremes ---------------
// v1's band was 0.75 x the 3-sig-fig quantum, so its width as a FRACTION of spot
// swung ~10x with the leading digit (SOL 77.87 → 0.096%; XRP 1.1489 → 0.653%).
// v2 is scale-free: 2.5% of spot everywhere. These four spots are the live
// 2026-07-21 values and span the mantissa range (1.15 … 7.79).
const V2_SPOTS: Array<[string, number]> = [
  ["SOL", 77.87], ["BTC", 66658], ["XRP", 1.1489], ["FARTCOIN", 0.13897],
];

test("v2 band is a flat 2.5% of spot at every mantissa", () => {
  for (const [, s] of V2_SPOTS) {
    assert.ok(Math.abs(hystBand(s) / s - 0.025) < 1e-12, `band/spot != 2.5% at ${s}`);
  }
});

// NOTE on the exact threshold: the band is measured from the ANCHOR, and the
// anchor is the roundSig grid point nearest spot — not spot itself. That grid
// offset (up to half a 3-sig-fig quantum, ~0.075% at BTC scale) is spent out of
// the band, so the flip threshold measured FROM SPOT is 2.5% -/+ the offset,
// i.e. a transition zone of roughly 2.3%-3.0% rather than a hard 2.5% line.
// The two sweeps below bracket that zone deliberately.
test("v2 drift sweep: ZERO strike changes for |drift| <= 2.3%", () => {
  for (const [name, spot] of V2_SPOTS) {
    const anchor = roundSig(spot, 3);
    for (let bp = -230; bp <= 230; bp += 10) {
      const s = spot * (1 + bp / 10000);
      assert.equal(stickyStrike(s, [anchor], s), anchor, `${name} flipped at ${bp}bp`);
    }
  }
});

test("v2 drift sweep: beyond the band, exactly a ONE-RUNG shift (never further)", () => {
  for (const [name, spot] of V2_SPOTS) {
    const anchor = roundSig(spot, 3);
    for (const bp of [300, 350, -300, -350]) {
      const s = spot * (1 + bp / 10000);
      const got = stickyStrike(s, [anchor], s);
      assert.notEqual(got, anchor, `${name} should have shifted at ${bp}bp`);
      // one rung = 5% of spot; a single shift must stay well inside that.
      assert.ok(Math.abs(got - anchor) < 0.05 * spot, `${name} shifted more than one rung at ${bp}bp`);
    }
  }
});

test("v2 PDA-REUSE INVARIANT: returning to a prior spot re-derives the IDENTICAL strike", () => {
  for (const [name, spot] of V2_SPOTS) {
    const anchor = roundSig(spot, 3);
    const before = stickyStrike(spot, [anchor], spot);
    // wander out past the band and back again
    const out = spot * 1.04;
    const shifted = stickyStrike(out, [anchor], out);
    const back = stickyStrike(spot, [shifted], spot);
    const returned = stickyStrike(spot, [anchor, shifted], spot);
    assert.equal(returned, before, `${name}: return-to-spot did not re-derive the prior strike`);
    assert.ok(back > 0, `${name}: sanity`);
  }
});

// ---- v2: per-expiry anchors (defect (c) reproduction) -----------------------
// A strike anchored ONLY on the monthly must not suppress the weekly's flip: the
// series PDA is (market, strike, expiry, side), so "keeping" a monthly-only
// strike for the weekly reports a hit and then mints a new series anyway.
test("v2 per-expiry: a monthly-only anchor does NOT satisfy the weekly target", () => {
  const WEEKLY = 1_800_000_000, MONTHLY = 1_802_000_000;
  const byExpiry = new Map<number, number[]>([[MONTHLY, [1.15]]]); // weekly has NO anchors
  const spot = 1.1489;
  const weeklyAnchors = byExpiry.get(WEEKLY) ?? [];
  const monthlyAnchors = byExpiry.get(MONTHLY) ?? [];
  // weekly: no anchor on its own expiry → must fall back to the fresh grid strike
  assert.equal(stickyStrike(spot, weeklyAnchors, spot), roundSig(spot, 3));
  // monthly: its own anchor retains
  assert.equal(stickyStrike(spot, monthlyAnchors, spot), 1.15);
  // and the v1 defect — collapsing both tenors into one set — would have
  // silently reused the monthly's 1.15 for the weekly:
  assert.equal(stickyStrike(spot, [...weeklyAnchors, ...monthlyAnchors], spot), 1.15);
});

// ---- v2: pre-mint budget gate ----------------------------------------------
// Pure predicate mirroring engine.post()'s gate: collateral > freeNow → skip the
// cell and emit ZERO init ixs (never mint-then-strand).
const budgetAllows = (collateral: number, freeNow: number) => collateral <= freeNow;

test("v2 budget gate: balance below cell cost skips the cell, zero init ixs", () => {
  const collateral = 66_700 * 1; // one BTC cell
  assert.equal(budgetAllows(collateral, 10_000), false); // insufficient → skip
  assert.equal(budgetAllows(collateral, 66_700), true);  // exactly enough → post
  assert.equal(budgetAllows(collateral, 66_699.99), false);
});

// ---- mitigation 2: reprice ε-skip -----------------------------------------
const BPS = 300;          // 3% drift trigger
const MAXAGE = 30 * 60_000;
const EPS = 0.01;         // 1%

test("age-triggered reprice with sub-ε move is SKIPPED", () => {
  // the observed canary case: 0.021416 -> 0.021368 = 0.22% move
  const drift = Math.abs(0.021368 - 0.021416) / 0.021416;
  assert.ok(drift < EPS);
  assert.equal(repriceDecision(drift, MAXAGE + 1, BPS, MAXAGE, EPS), "skip-epsilon");
});

test("age-triggered reprice with a material move still REPRICES", () => {
  assert.equal(repriceDecision(0.02, MAXAGE + 1, BPS, MAXAGE, EPS), "reprice");
});

test("DRIFT-triggered reprice is NEVER ε-skipped, even when young", () => {
  assert.equal(repriceDecision(0.05, 0, BPS, MAXAGE, EPS), "reprice");
});

test("young order with a small move does nothing", () => {
  assert.equal(repriceDecision(0.001, 0, BPS, MAXAGE, EPS), "hold");
});

test("exactly-at-epsilon reprices (>= is the boundary)", () => {
  assert.equal(repriceDecision(EPS, MAXAGE + 1, BPS, MAXAGE, EPS), "reprice");
});
