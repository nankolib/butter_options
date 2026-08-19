// Persistent (IndexedDB) scan cache — policy tests.
//   run (from crank/): node node_modules/ts-node/dist/bin.js --transpile-only \
//                      -r tsconfig-paths/register persistentScanCache.test.ts
//
// The policy is pure so every rejection path is testable without a browser.
// The dangerous direction throughout is ACCEPTING a record we should refuse:
// persistence turns a seconds-long staleness window into a days-long one, so
// everything that was merely wrong in memory becomes wrong on disk, survives a
// reload, and is served to a page that looks fully loaded.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  NEVER_PERSIST, PERSIST_FRESH_MS, PERSIST_MAX_AGE_MS, PERSIST_SCHEMA_VERSION,
  evaluateEnvelope, isPersistable,
} from "@app/utils/persistentScanCache";

const LINEAGE = "CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq:485057525";
const expected = { lineage: LINEAGE, accountName: "sharedVault", scope: "" };
const envelope = (over: Record<string, unknown> = {}) => ({
  v: PERSIST_SCHEMA_VERSION, lineage: LINEAGE, accountName: "sharedVault",
  scope: "", storedAt: 1_000_000, slot: 42, rows: [{}], ...over,
});

// ---------------------------------------------------------------------------
// THE RED TEST: what may never reach disk
// ---------------------------------------------------------------------------

test("RED: books, positions, balances and triggers are NEVER persistable", () => {
  // The never-cache rule does not soften because the storage changed — it gets
  // stricter. A stale in-memory book lives for seconds; a stale PERSISTED book
  // can be served tomorrow, to someone who has since traded, by a page that
  // looks fully loaded. If anyone adds one of these to the persist list to
  // "speed things up", this fails.
  for (const name of NEVER_PERSIST) {
    assert.equal(isPersistable(name), false, `${name} must never be written to disk`);
  }
});

test("only the structural set is persistable", () => {
  for (const name of ["optionsMarket", "vaultMint", "sharedVault", "epochConfig"]) {
    assert.equal(isPersistable(name), true, `${name} should persist`);
  }
});

test("an unclassified new account type does not persist by default", () => {
  // Forgetting must yield a slow page, never a wrong one.
  assert.equal(isPersistable("someFutureAccount"), false);
});

// ---------------------------------------------------------------------------
// LINEAGE — the layout guarantee
// ---------------------------------------------------------------------------

test("RED: a record from a different deploy lineage is REFUSED", () => {
  // A program upgrade can move fields inside an account. A record from the
  // previous deploy is not stale, it is garbage that rehydrates into plausible
  // wrong numbers — which is far worse than a slow load.
  const r = evaluateEnvelope(envelope({ lineage: LINEAGE.replace("485057525", "999999999") }), expected, 1_000_100);
  assert.equal(r.usable, false);
});

test("an empty or missing lineage is refused", () => {
  assert.equal(evaluateEnvelope(envelope({ lineage: "" }), expected, 1_000_100).usable, false);
  assert.equal(evaluateEnvelope(envelope({ lineage: undefined }), expected, 1_000_100).usable, false);
});

// ---------------------------------------------------------------------------
// SCHEMA + SHAPE
// ---------------------------------------------------------------------------

test("RED: a record written by a previous envelope version is refused", () => {
  assert.equal(evaluateEnvelope(envelope({ v: PERSIST_SCHEMA_VERSION - 1 }), expected, 1_000_100).usable, false);
});

test("corrupt or unreadable records read as a MISS, never a throw", () => {
  for (const bad of [null, undefined, 42, "x", {}, [], { v: 1 }, envelope({ rows: "no" }),
                     envelope({ storedAt: "soon" })]) {
    const r = evaluateEnvelope(bad as never, expected, 1_000_100);
    assert.equal(r.usable, false, `${JSON.stringify(bad)} must be a miss`);
  }
});

test("a record for a different account type or scope is refused", () => {
  assert.equal(evaluateEnvelope(envelope({ accountName: "vaultMint" }), expected, 1_000_100).usable, false);
  assert.equal(evaluateEnvelope(envelope({ scope: "SomeMarket" }), expected, 1_000_100).usable, false);
});

test("scope matching is exact — one board must not answer for another", () => {
  // `now` is passed explicitly: envelope() stamps a fixed storedAt, so letting
  // `now` default to Date.now() ages every fixture out and makes this pass for
  // the wrong reason (it failed for the wrong reason first).
  const scoped = { lineage: LINEAGE, accountName: "sharedVault", scope: "MarketAAA" };
  const now = 1_000_000 + 1_000;
  assert.equal(evaluateEnvelope(envelope({ scope: "MarketBBB" }), scoped, now).usable, false);
  assert.equal(evaluateEnvelope(envelope({ scope: "MarketAAA" }), scoped, now).usable, true);
});

// ---------------------------------------------------------------------------
// SWR BOUNDS
// ---------------------------------------------------------------------------

test("a recent record is usable and NOT stale — the reload can skip the network", () => {
  const r = evaluateEnvelope(envelope(), expected, 1_000_000 + PERSIST_FRESH_MS - 1);
  assert.equal(r.usable, true);
  assert.equal(r.usable && r.stale, false);
});

test("past the fresh bound it is still SERVED, but flagged for revalidation", () => {
  const r = evaluateEnvelope(envelope(), expected, 1_000_000 + PERSIST_FRESH_MS + 1);
  assert.equal(r.usable, true, "stale-while-revalidate SERVES — that is the point");
  assert.equal(r.usable && r.stale, true);
});

test("RED: past the hard age bound it is discarded, not served", () => {
  // "Stale while revalidate" is not "forever if the network is down". A board
  // from days ago rendered as current is a lie the user cannot detect.
  assert.equal(evaluateEnvelope(envelope(), expected, 1_000_000 + PERSIST_MAX_AGE_MS + 1).usable, false);
});

test("a backwards clock does not make a record immortal", () => {
  assert.equal(evaluateEnvelope(envelope(), expected, 1_000_000 - 60_000).usable, false);
});
