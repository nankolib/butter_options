// Red-first tests for the already-met exit-trigger guard — walkthrough fast-follow.
//
//   run (from crank/): node node_modules/ts-node/dist/bin.js --transpile-only \
//                      -r tsconfig-paths/register triggerGuards.test.ts
//
// THE CASE THAT WOULD HAVE CAUGHT IT
//   JTO underlying $0.5588, take-profit entered as 0.02 (a premium-scale number
//   in an underlying-scale field). TP fires at-or-above, so the condition was
//   true on arrival and the keeper would market-exit on its next tick. Both
//   directions are asserted, because the mirror bug — a stop entered ABOVE spot —
//   fails identically and is just as easy to type.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  WORTHLESS_EST_USD, alreadyMetLegs, alreadyMetMessage, isEffectivelyWorthless,
  formatSpotForLabel, spotAnchoredPlaceholder, triggerAlreadyMet,
} from "@app/utils/triggerGuards";

const JTO_SPOT = 0.5588;

// ---------------------------------------------------------------------------
// THE WALKTHROUGH BUG, BOTH DIRECTIONS
// ---------------------------------------------------------------------------

test("RED: take-profit BELOW spot is already met (the JTO 0.02 case)", () => {
  assert.equal(triggerAlreadyMet("tp", 0.02, JTO_SPOT), true,
    "TP fires at-or-above; 0.02 with spot 0.5588 is already true and would fire on the next keeper tick");
});

test("RED: stop-loss ABOVE spot is already met (the mirror bug)", () => {
  assert.equal(triggerAlreadyMet("sl", 0.9, JTO_SPOT), true,
    "SL fires at-or-below; a stop above spot is already true");
});

test("a sane take-profit ABOVE spot is not flagged", () => {
  assert.equal(triggerAlreadyMet("tp", 0.75, JTO_SPOT), false);
});

test("a sane stop-loss BELOW spot is not flagged", () => {
  assert.equal(triggerAlreadyMet("sl", 0.45, JTO_SPOT), false);
});

test("exactly AT spot counts as met — the comparators are inclusive", () => {
  // ge / le on chain. A trigger sitting exactly on spot fires, so warning about
  // it matches what the keeper will actually do.
  assert.equal(triggerAlreadyMet("tp", JTO_SPOT, JTO_SPOT), true);
  assert.equal(triggerAlreadyMet("sl", JTO_SPOT, JTO_SPOT), true);
});

// ---------------------------------------------------------------------------
// NOT-PLACED AND UNKNOWN-SPOT MUST NOT WARN
// ---------------------------------------------------------------------------

test("an empty leg is never flagged — 0 means 'do not place this leg'", () => {
  assert.equal(triggerAlreadyMet("tp", 0, JTO_SPOT), false);
  assert.equal(triggerAlreadyMet("sl", 0, JTO_SPOT), false);
});

test("unknown spot never blocks — we cannot make the claim, so we do not", () => {
  for (const s of [null, undefined, 0, Number.NaN, -1]) {
    assert.equal(triggerAlreadyMet("tp", 0.02, s as any), false, `spot ${String(s)} must not flag`);
    assert.equal(triggerAlreadyMet("sl", 9.9, s as any), false, `spot ${String(s)} must not flag`);
  }
});

test("a non-finite price is not flagged", () => {
  assert.equal(triggerAlreadyMet("tp", Number.NaN, JTO_SPOT), false);
});

// ---------------------------------------------------------------------------
// LEG COLLECTION + MESSAGE
// ---------------------------------------------------------------------------

test("both bad legs are reported together", () => {
  const legs = alreadyMetLegs({ tpPrice: 0.02, slPrice: 0.9, spot: JTO_SPOT });
  assert.deepEqual(legs, ["tp", "sl"]);
  assert.match(alreadyMetMessage(legs, JTO_SPOT), /Both triggers would fire immediately/);
});

test("a good pair reports nothing", () => {
  assert.deepEqual(alreadyMetLegs({ tpPrice: 0.75, slPrice: 0.45, spot: JTO_SPOT }), []);
  assert.equal(alreadyMetMessage([], JTO_SPOT), "");
});

test("the message names the DIRECTION — the direction is what was misread", () => {
  assert.match(alreadyMetMessage(["tp"], JTO_SPOT), /at or above/);
  assert.match(alreadyMetMessage(["sl"], JTO_SPOT), /at or below/);
});

// ---------------------------------------------------------------------------
// WORTHLESS ESTIMATE
// ---------------------------------------------------------------------------

test("a ~zero estimate is flagged so it reads as a warning, not a glitch", () => {
  assert.equal(isEffectivelyWorthless(0), true);
  assert.equal(isEffectivelyWorthless(0.0000), true);
  assert.equal(isEffectivelyWorthless(WORTHLESS_EST_USD - 0.001), true);
});

test("a real estimate is not flagged", () => {
  assert.equal(isEffectivelyWorthless(12.5), false);
  assert.equal(isEffectivelyWorthless(WORTHLESS_EST_USD), false, "the threshold itself is not worthless");
});

test("a missing estimate is not flagged as worthless", () => {
  assert.equal(isEffectivelyWorthless(null), false);
  assert.equal(isEffectivelyWorthless(undefined), false);
});

// ---------------------------------------------------------------------------
// SPOT-ANCHORED PLACEHOLDER — the thing that makes the units obvious
// ---------------------------------------------------------------------------

test("placeholders sit on the SPOT scale, above for TP and below for SL", () => {
  const tp = spotAnchoredPlaceholder("tp", JTO_SPOT);
  const sl = spotAnchoredPlaceholder("sl", JTO_SPOT);
  assert.match(tp, /^e\.g\. 0\.6/, `TP placeholder should be above spot, got ${tp}`);
  assert.match(sl, /^e\.g\. 0\.5/, `SL placeholder should be below spot, got ${sl}`);
  // The whole point: the example is nowhere near premium scale (0.02).
  assert.ok(Number(tp.replace("e.g. ", "")) > JTO_SPOT);
  assert.ok(Number(sl.replace("e.g. ", "")) < JTO_SPOT);
});

test("without spot the placeholder falls back and promises nothing", () => {
  assert.equal(spotAnchoredPlaceholder("tp", null), "leave empty to skip");
});

test("larger underlyings use 2dp, sub-dollar ones 4dp", () => {
  assert.equal(spotAnchoredPlaceholder("tp", 200), "e.g. 220.00");
  assert.match(spotAnchoredPlaceholder("sl", 0.5588), /^e\.g\. 0\.\d{4}$/);
});

test("spot in the label uses the asset's own scale, not a fixed 4dp", () => {
  // "$200.0000" on a stock is the same category of noise this change removes.
  assert.equal(formatSpotForLabel(0.5588), "$0.5588");
  assert.equal(formatSpotForLabel(200), "$200.00");
});
