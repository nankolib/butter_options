// Scanner kind-selection tests.
//
// This file exists because mutation testing found a hole: the line deciding
// which OrderKinds reach the fill path was inline in the scan loop, behind a
// getProgramAccounts call, so breaking it left the whole suite green. Two
// mutations survived — "sweep bids into the ask path" and "drop writerAsk
// again" — and both are exactly the bugs that matter most.
//
//   run: npx ts-node --transpile-only src/scan.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { kindOf } from "./scan";

// Anchor decodes an enum to a single-key object. OrderKind on-chain is
// 0 Bid, 1 ResaleAsk, 2 WriterAsk, 3 VaultPeg.
const BID = { bid: {} };
const RESALE_ASK = { resaleAsk: {} };
const WRITER_ASK = { writerAsk: {} };
const VAULT_PEG = { vaultPeg: {} };

test("the two user ask kinds are accepted", () => {
  assert.equal(kindOf(RESALE_ASK), "resaleAsk");
  assert.equal(kindOf(WRITER_ASK), "writerAsk");
});

test("BIDS ARE NEVER ASKS", () => {
  // Filling a bid means SELLING — delivering contracts we may not hold, on a
  // side with no inventory policy. If this ever returns non-null the taker
  // starts taking the opposite side of its own mandate.
  assert.equal(kindOf(BID), null);
});

test("the vault peg is not a user", () => {
  // VaultPeg is the protocol's own automated quote. Filling it is neither an
  // exit for a user nor an O3 completion (the quest rules exclude kind 3), so
  // it is pure cost.
  assert.equal(kindOf(VAULT_PEG), null);
});

test("selection is POSITIVE — an unknown future variant is refused by default", () => {
  // The tempting implementation is "not a bid". That admits VaultPeg today and
  // silently admits every OrderKind added later. Fail closed instead.
  assert.equal(kindOf({ someFutureKind: {} }), null);
  assert.equal(kindOf({ marketOrder: {} }), null);
});

test("malformed or absent kinds are refused rather than crashing the scan", () => {
  // A corrupt/legacy account can decode to almost anything. The scanner must
  // skip it, not throw — one bad account must not empty the whole tick.
  for (const junk of [null, undefined, {}, 42, "resaleAsk", [], true]) {
    assert.equal(kindOf(junk), null, `${JSON.stringify(junk)} refused`);
  }
});

test("a kind object carrying BOTH ask keys resolves deterministically", () => {
  // Should be impossible from a real decode, but if it ever happens the answer
  // must not depend on key iteration order.
  assert.equal(kindOf({ writerAsk: {}, resaleAsk: {} }), "resaleAsk");
  assert.equal(kindOf({ resaleAsk: {}, writerAsk: {} }), "resaleAsk");
});

test("a bid bundled with an ask key is still not silently filled as a bid", () => {
  // Defensive: the ask key wins, and the result is an ASK — we would never
  // treat this as a bid and try to sell into it.
  assert.notEqual(kindOf({ bid: {}, resaleAsk: {} }), null);
  assert.equal(kindOf({ bid: {}, resaleAsk: {} }), "resaleAsk");
});
