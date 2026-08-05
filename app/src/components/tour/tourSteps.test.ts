// =============================================================================
// tourSteps.test.ts — gates for the shaded tutorial's state machine.
// run: node app/scripts/run-tour-tests.mjs
// =============================================================================
// The two rules worth protecting are the ones that are easy to regress into a
// plain counter: progression comes from what the wallet has COMPLETED (not from
// how many times "next" was pressed), and no step may ask the user to wait days.
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TOUR_STEPS,
  resolveStep,
  shouldAutoOpen,
  advanceFrom,
  progressOf,
  stepById,
  type TourState,
} from "./tourSteps";

const S = (over: Partial<TourState> = {}): TourState => ({
  connected: true,
  completed: new Set<string>(),
  dismissed: false,
  loaded: true,
  ...over,
});

// ---------------------------------------------------------------------------
// Not a linear index.
// ---------------------------------------------------------------------------

test("out-of-order: a wallet that wrote before it filled is NOT walked back", () => {
  // O2 (write) done, O1 (fill) not. A counter-based tour would show "write";
  // this must show the first genuinely incomplete step, which is the fill.
  const step = resolveStep(S({ completed: new Set(["D3", "O2"]) }));
  assert.equal(step?.id, "trade", "must land on the first INCOMPLETE step");
});

test("out-of-order: completed steps are skipped when clicking through too", () => {
  const s = S({ completed: new Set(["O1"]) });
  // From faucet, the next incomplete gated step is portfolio's successor `write`
  // — `trade` is done and must be skipped rather than re-shown.
  const next = advanceFrom("faucet", s);
  assert.notEqual(next?.id, "trade", "a finished step must never be re-offered");
});

test("a wallet with everything done lands on the hand-off, not a dead end", () => {
  const step = resolveStep(S({ completed: new Set(["D3", "O1", "O2", "O3"]) }));
  assert.equal(step?.id, "handoff");
});

// ---------------------------------------------------------------------------
// No step may ask the user to wait.
// ---------------------------------------------------------------------------

test("no step is gated on a long-horizon quest — those are handed off", () => {
  // O4 exercise, O6 hold-to-settlement, O7 settle/create. O6 in particular
  // cannot be completed in a session; a step gated on it would stall for days.
  const LONG = new Set(["O4", "O6", "O7", "OC"]);
  for (const s of TOUR_STEPS) {
    assert.ok(
      !s.completedBy || !LONG.has(s.completedBy),
      `${s.id} is gated on ${s.completedBy}, which cannot be finished promptly`,
    );
  }
});

test("the hand-off is the last step and points at where the rest lives", () => {
  assert.equal(TOUR_STEPS[TOUR_STEPS.length - 1].id, "handoff");
  const body = stepById("handoff")!.body;
  for (const mention of ["exercise", "settle", "quest panel", "leaderboard"]) {
    assert.ok(body.includes(mention), `hand-off must mention ${mention}`);
  }
  assert.equal(advanceFrom("handoff", S()), null, "nothing follows the hand-off");
});

// ---------------------------------------------------------------------------
// Auto-open, dismiss.
// ---------------------------------------------------------------------------

test("auto-opens ONLY for a connected wallet with zero completions", () => {
  assert.equal(shouldAutoOpen(S()), true);
  assert.equal(shouldAutoOpen(S({ completed: new Set(["D3"]) })), false, "any activity -> no interruption");
  assert.equal(shouldAutoOpen(S({ connected: false })), false);
  assert.equal(shouldAutoOpen(S({ loaded: false })), false, "never guess before quest state loads");
});

test("an explicit dismiss is permanent and beats every other condition", () => {
  assert.equal(shouldAutoOpen(S({ dismissed: true })), false);
  assert.equal(resolveStep(S({ dismissed: true })), null);
  assert.equal(resolveStep(S({ dismissed: true, connected: false })), null);
});

test("disconnected shows the welcome card, not a mid-chain step", () => {
  assert.equal(resolveStep(S({ connected: false, completed: new Set(["O1"]) }))?.id, "welcome");
});

test("nothing is shown before the wallet's quest state has loaded", () => {
  assert.equal(resolveStep(S({ loaded: false })), null);
});

// ---------------------------------------------------------------------------
// Shape.
// ---------------------------------------------------------------------------

test("every step has an anchor or is a centred card, and copy is lowercase", () => {
  for (const s of TOUR_STEPS) {
    assert.ok(s.title.length > 0 && s.body.length > 0, `${s.id} needs copy`);
    assert.equal(s.title, s.title.toLowerCase(), `${s.id} title must be terminal register`);
    assert.ok(s.anchor === null || s.anchor.length > 0);
  }
});

test("progress never reads 0 of n or exceeds the total", () => {
  for (const s of TOUR_STEPS) {
    if (s.id === "welcome") continue;
    const p = progressOf(s);
    assert.ok(p.index >= 1 && p.index <= p.total, `${s.id}: ${p.index}/${p.total}`);
  }
});

test("anchored steps name a route so the overlay knows where to send the user", () => {
  for (const s of TOUR_STEPS) {
    if (s.anchor && !["connect-wallet", "faucet-usdc"].includes(s.anchor)) {
      assert.ok(s.route, `${s.id} anchors ${s.anchor} but names no route`);
    }
  }
});
