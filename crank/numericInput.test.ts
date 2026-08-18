// Red-first tests for the numeric typing state machine — FE UX blocker arc.
//
//   run (from crank/): node node_modules/ts-node/dist/bin.js --transpile-only \
//                      -r tsconfig-paths/register numericInput.test.ts
//
// Lives in crank/ for the same reason triggerBundle.test.ts does: app/ is
// "type": "module" with no wired runner, so a test placed there would never run.
//
// THE TEST THAT WOULD HAVE CAUGHT IT
//   Typing a sub-$1 price is not one event, it is six. The old code was correct
//   for the final string and wrong for four of the five intermediate ones, so any
//   test that only checked the finished value passed. These type one character at
//   a time and assert survival at EVERY keystroke.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  applyNumericInput, commitNumericInput, numericStateFrom, submittedValue,
} from "@app/utils/numericInput";

/** Type a string one character at a time, asserting nothing is eaten. */
function typeOut(s: string, opts = {}) {
  let state = { raw: "", value: Number.NaN };
  const seen: string[] = [];
  for (let i = 1; i <= s.length; i++) {
    const next = s.slice(0, i);
    const r = applyNumericInput(next, opts);
    assert.ok(r !== null, `keystroke ${i} ("${next}") was REJECTED`);
    state = r!;
    seen.push(state.raw);
    assert.equal(state.raw, next, `after keystroke ${i} the field shows "${state.raw}", expected "${next}"`);
  }
  return { state, seen };
}

// ---------------------------------------------------------------------------
// THE JTO BLOCKER
// ---------------------------------------------------------------------------

test('"0.0158" survives every keystroke (the JTO price that stalled the walkthrough)', () => {
  const { state, seen } = typeOut("0.0158");
  assert.deepEqual(seen, ["0", "0.", "0.0", "0.01", "0.015", "0.0158"]);
  assert.equal(state.value, 0.0158);
});

test('"0" alone is a legal state — the old code rendered it as empty', () => {
  const r = applyNumericInput("0");
  assert.ok(r);
  assert.equal(r!.raw, "0", 'typing "0" must leave "0" on screen');
  assert.equal(r!.value, 0);
});

test('"0." is holdable — it is where every sub-$1 price passes through', () => {
  const r = applyNumericInput("0.");
  assert.ok(r);
  // The property that matters is that the RAW string survives, so the trailing
  // dot stays on screen and the next digit can land. Number("0.") is 0 in JS and
  // that is the honest numeric reading, so `value` is 0 here — harmless, because
  // it only feeds the live estimate.
  assert.equal(r!.raw, "0.", "the trailing dot must stay, or the next digit has nowhere to go");
  assert.equal(r!.value, 0);
  // The dangerous conflation is EMPTY-as-zero, and that one is kept apart.
  assert.ok(Number.isNaN(applyNumericInput("")!.value), "empty must NOT read as 0");
});

test('".5" is typeable without a leading zero', () => {
  const { state } = typeOut(".5");
  assert.equal(state.value, 0.5);
});

// ---------------------------------------------------------------------------
// THE QUANTITY BLOCKER
// ---------------------------------------------------------------------------

test("the field can be EMPTIED — no snap-back", () => {
  const r = applyNumericInput("");
  assert.ok(r, "clearing must be allowed");
  assert.equal(r!.raw, "");
  assert.ok(Number.isNaN(r!.value), "empty is not 0 — conflating them is the snap-back bug");
});

test('clear-then-"2" yields 2, without typing "12" and deleting the "1"', () => {
  let s = numericStateFrom(1);
  assert.equal(s.raw, "1");
  s = applyNumericInput("", { integer: true })!;
  assert.equal(s.raw, "");
  s = applyNumericInput("2", { integer: true })!;
  assert.equal(s.raw, "2");
  assert.equal(submittedValue(s, { integer: true, min: 1 }), 2);
});

// ---------------------------------------------------------------------------
// Rejection is still real
// ---------------------------------------------------------------------------

test("letters, signs and a second decimal point are refused", () => {
  for (const bad of ["a", "1a", "-1", "1.2.3", "1e5", " 1"]) {
    assert.equal(applyNumericInput(bad), null, `"${bad}" must be rejected`);
  }
});

test("an integer field refuses a decimal point outright", () => {
  assert.equal(applyNumericInput("1.", { integer: true }), null);
  assert.ok(applyNumericInput("1.")); // but a decimal field allows it
});

// ---------------------------------------------------------------------------
// SUBMIT-TIME VALIDATION MUST NOT HAVE WEAKENED
// ---------------------------------------------------------------------------

test("commit clamps to min/max — validation moved, it did not soften", () => {
  assert.equal(commitNumericInput({ raw: "0", value: 0 }, { min: 1 }).value, 1);
  assert.equal(commitNumericInput({ raw: "999", value: 999 }, { max: 100 }).value, 100);
  assert.equal(commitNumericInput({ raw: "2.7", value: 2.7 }, { integer: true }).value, 2);
});

test("an unparseable field commits to its fallback, not to NaN", () => {
  assert.equal(commitNumericInput({ raw: "", value: Number.NaN }, {}, 0).value, 0);
  assert.equal(commitNumericInput({ raw: "0.", value: Number.NaN }, { min: 1 }, 1).value, 1);
  assert.ok(!Number.isNaN(commitNumericInput({ raw: ".", value: Number.NaN }).value));
});

test("commit rewrites the raw string so the user sees what will be sent", () => {
  const c = commitNumericInput({ raw: "0007", value: 7 }, { min: 1 });
  assert.equal(c.raw, "7");
  assert.equal(c.value, 7);
});

test("a VALID value is submitted byte-identically to before the change", () => {
  // The whole point of the fix is that only the typing experience changes.
  for (const n of [1, 2, 0.0158, 12.5, 100]) {
    const s = numericStateFrom(n);
    assert.equal(submittedValue(s), n, `${n} must round-trip unchanged`);
  }
});

test("RED: a weakened clamp fails this suite", () => {
  // If someone later makes commit pass values through untouched, min/max stop
  // being enforced anywhere — validation was moved to commit, so commit is now
  // the only thing standing between a typo and a transaction.
  const clamped = commitNumericInput({ raw: "0", value: 0 }, { min: 1 });
  assert.notEqual(clamped.value, 0, "min must be enforced at commit or nothing enforces it");
});
