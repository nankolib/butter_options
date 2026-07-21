// Churn-fix proof. Two mitigations, both pinned here:
//   1) STRIKE HYSTERESIS  — spot wobbling across a roundSig boundary must NOT
//      mint a new series (533 orphan-series pulls in 6h, ~1.55 SOL/h).
//   2) REPRICE ε-SKIP     — an age-triggered reprice that moves the price <1%
//      must skip the cancel+repost (2 txs) entirely.
//   run: npx ts-node --transpile-only src/engine.churn.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { roundSig, roundSigStep, stickyStrike } from "./ladder";
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

test("genuine move beyond the deadband ADOPTS the fresh strike (both directions)", () => {
  // 1.09 + 0.0075 band → 1.0976 is still inside; 1.0985 is outside.
  assert.equal(stickyStrike(1.0985, [1.09]), 1.1);   // up and out
  assert.equal(stickyStrike(1.0915, [1.1]), 1.09);   // down and out
});

test("nearest live strike wins when several are held", () => {
  assert.equal(stickyStrike(1.0951, [1.09, 1.1]), 1.1);  // 0.0049 vs 0.0051
  assert.equal(stickyStrike(1.0949, [1.09, 1.1]), 1.09); // 0.0049 vs 0.0051
});

test("cold board (no live strikes) falls back to plain rounding", () => {
  assert.equal(stickyStrike(1.0951, []), 1.1);
  assert.equal(stickyStrike(1.0949, []), 1.09);
});

test("hysteresis holds at other magnitudes (BTC-scale step=100)", () => {
  assert.equal(roundSigStep(65_000, 3), 100);
  assert.equal(stickyStrike(65_040, [65_000]), 65_000); // inside 75 band
  assert.equal(stickyStrike(65_120, [65_000]), 65_100); // outside → fresh
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
