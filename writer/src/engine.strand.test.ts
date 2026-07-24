// 3012 terminal-cancel fix — the writer-strand storm was a false alarm.
//
// Diagnosed 2026-07-24: the tick enumerates myOrders fresh at its start, then
// reprices/cancels across a long tick. An order that expires and is swept
// MID-TICK is cancelled from a now-stale work-list → cancel_order fails 3012
// AccountNotInitialized (0xbc4). Proven a WITHIN-TICK RACE, not a persistent
// retry queue: two 30-min windows had 78 vs 73 stranded orders with ZERO
// overlap — each is a one-shot already-closed PDA. Its escrow returned at close,
// so nothing is stranded; the ~90/hr writer-strand alert was noise.
//
// pull() now (a) existence-pre-checks right before the cancel, and (b) treats a
// 3012 on send as the same benign race. These pin the pure decision.
//   cd writer && npx ts-node --transpile-only -r tsconfig-paths/register src/engine.strand.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { isTerminalCancelError, classifyPullOutcome } from "./engine";

// ---- isTerminalCancelError: recognise "order already gone" ------------------
test("isTerminalCancelError: 3012 / 0xbc4 / AccountNotInitialized are terminal", () => {
  assert.equal(isTerminalCancelError("custom program error: 0xbc4"), true);
  assert.equal(isTerminalCancelError(new Error("Error processing Instruction 1: custom program error: 0xbc4")), true);
  assert.equal(isTerminalCancelError({ message: "AnchorError ... Error Number: 3012" }), true);
  assert.equal(isTerminalCancelError(new Error("AccountNotInitialized")), true);
});

test("isTerminalCancelError: a genuine live-order failure is NOT terminal", () => {
  assert.equal(isTerminalCancelError(new Error("Blockhash not found")), false);
  assert.equal(isTerminalCancelError(new Error("custom program error: 0x1")), false, "6014 self-trade etc. is real");
  assert.equal(isTerminalCancelError(new Error("Transaction simulation failed: insufficient funds")), false);
  assert.equal(isTerminalCancelError(undefined), false);
  // must not fire on an unrelated number that merely contains 3012 as a substring
  assert.equal(isTerminalCancelError(new Error("slot 130121 ...")), false, "word-boundary guards the match");
});

// ---- classifyPullOutcome: the full pull() decision, pure -------------------
test("prune-on-absent: order gone BEFORE the cancel → noop-gone (no tx, no strand)", () => {
  assert.equal(classifyPullOutcome(false, null), "noop-gone");
  // pre-check wins even if a (stale) error object is somehow present
  assert.equal(classifyPullOutcome(false, new Error("whatever")), "noop-gone");
});

test("closed-PDA repro: order present at pre-check, then 3012 on send → noop-gone", () => {
  assert.equal(classifyPullOutcome(true, new Error("custom program error: 0xbc4")), "noop-gone");
  assert.equal(classifyPullOutcome(true, { message: "Error Number: 3012 AccountNotInitialized" }), "noop-gone");
});

test("a LIVE order whose cancel genuinely fails → strand (real alert preserved)", () => {
  assert.equal(classifyPullOutcome(true, new Error("Blockhash not found")), "strand");
  assert.equal(classifyPullOutcome(true, new Error("custom program error: 0x6")), "strand");
});

test("a clean cancel → sent", () => {
  assert.equal(classifyPullOutcome(true, null), "sent");
});
