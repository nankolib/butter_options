// Tests for the account-scan SWR cache — WS2 item 1.
//
//   run (from crank/): node node_modules/ts-node/dist/bin.js --transpile-only \
//                      -r tsconfig-paths/register accountScanCache.test.ts
//
// Lives in crank/ for the same reason numericInput.test.ts does: app/ is
// "type": "module" with no wired runner, so a test placed there would never run.
//
// WHAT THESE PROTECT
//   A cache that serves the wrong thing is worse than no cache. The dangerous
//   direction is not "slow" — it is a stale BOOK (a filled order shown as live)
//   or a stale POSITION (a wrong balance). Those types must never be cacheable,
//   and a cached entry must never outlive the mutation that invalidated it.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  FRESH_MS, MAX_STALE_MS, claimRevalidation, clearScanCache, invalidateScanCache,
  isCacheableScan, lookupScan, releaseRevalidation, storeScan,
} from "@app/utils/accountScanCache";

const PROG = "CtzJ4MJYrsYbCLcvvVLEXqrQvXvKq7RaJvCJcCC7Jbcj";
const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ publicKey: i as any, account: { i } }));

const beforeEach = () => clearScanCache();

// ---------------------------------------------------------------------------
// THE RED TEST: the never-cache set
// ---------------------------------------------------------------------------

test("RED: book and position account types are NEVER cacheable", () => {
  // If someone adds any of these to the allowlist to "speed things up", this
  // fails. A stale RestingOrder renders a filled order as live and a user trades
  // against something that is already gone; a stale WriterPosition misstates
  // what someone owns. Neither is worth a page load.
  for (const name of [
    "restingOrder", "writerAskPosition", "writerAskPot",
    "vaultResaleListing", "writerPosition", "settlementRecord",
  ]) {
    assert.equal(isCacheableScan(name), false, `${name} must NOT be cacheable`);
  }
});

test("an unknown/new account type is uncached by default (opt-in allowlist)", () => {
  // The failure mode of forgetting to classify a new type must be a slow page,
  // never a wrong one.
  assert.equal(isCacheableScan("someFutureAccount"), false);
});

test("storing an uncacheable type is a no-op, not a silent cache", () => {
  beforeEach();
  storeScan(PROG, "restingOrder", rows(3));
  assert.equal(lookupScan(PROG, "restingOrder").hit, false, "the book must never be served from cache");
});

test("market/series structure IS cacheable — otherwise this change does nothing", () => {
  for (const name of ["optionsMarket", "vaultMint", "sharedVault", "epochConfig"]) {
    assert.equal(isCacheableScan(name), true, `${name} should be cached`);
  }
});

// ---------------------------------------------------------------------------
// STALE-AFTER-MUTATION
// ---------------------------------------------------------------------------

test("invalidateScanCache drops the entry — a cached snapshot must not outlive its mutation", () => {
  beforeEach();
  storeScan(PROG, "sharedVault", rows(2));
  assert.equal(lookupScan(PROG, "sharedVault").hit, true);
  invalidateScanCache(PROG, "sharedVault");
  assert.equal(lookupScan(PROG, "sharedVault").hit, false, "post-mutation read must not be served a pre-mutation entry");
});

// ---------------------------------------------------------------------------
// SWR TIMING
// ---------------------------------------------------------------------------

test("inside FRESH_MS the entry is served and NOT marked stale (no network)", () => {
  beforeEach();
  const t0 = 1_000_000;
  storeScan(PROG, "sharedVault", rows(5), t0);
  const r = lookupScan(PROG, "sharedVault", t0 + FRESH_MS - 1);
  assert.equal(r.hit, true);
  assert.equal(r.hit && r.stale, false);
});

test("past FRESH_MS the entry is still SERVED, but flagged for background refresh", () => {
  beforeEach();
  const t0 = 1_000_000;
  storeScan(PROG, "sharedVault", rows(5), t0);
  const r = lookupScan(PROG, "sharedVault", t0 + FRESH_MS + 1);
  assert.equal(r.hit, true, "stale-while-revalidate SERVES the stale entry — that is the point");
  assert.equal(r.hit && r.stale, true);
});

test("past MAX_STALE_MS the entry is discarded and the caller waits for real data", () => {
  beforeEach();
  const t0 = 1_000_000;
  storeScan(PROG, "sharedVault", rows(5), t0);
  assert.equal(lookupScan(PROG, "sharedVault", t0 + MAX_STALE_MS + 1).hit, false);
});

test("a backwards clock jump does not make an entry immortal", () => {
  beforeEach();
  const t0 = 1_000_000;
  storeScan(PROG, "sharedVault", rows(5), t0);
  assert.equal(lookupScan(PROG, "sharedVault", t0 - 60_000).hit, false, "negative age must evict, not serve forever");
});

// ---------------------------------------------------------------------------
// SINGLE-FLIGHT REVALIDATION
// ---------------------------------------------------------------------------

test("N stale readers cause ONE background refresh, not N", () => {
  beforeEach();
  const t0 = 1_000_000;
  storeScan(PROG, "sharedVault", rows(5), t0);
  assert.equal(claimRevalidation(PROG, "sharedVault"), true, "first reader refreshes");
  for (let i = 0; i < 3; i++) {
    assert.equal(claimRevalidation(PROG, "sharedVault"), false, "later readers must not fan back out");
  }
  releaseRevalidation(PROG, "sharedVault");
  assert.equal(claimRevalidation(PROG, "sharedVault"), true, "after release, a later refresh may run");
});

test("claiming revalidation on a missing entry is refused", () => {
  beforeEach();
  assert.equal(claimRevalidation(PROG, "sharedVault"), false);
});

// ---------------------------------------------------------------------------
// VERSIONING
// ---------------------------------------------------------------------------

test("entries are namespaced per program id", () => {
  beforeEach();
  storeScan(PROG, "sharedVault", rows(5));
  assert.equal(lookupScan("SomeOtherProgram1111111111111111111111111111", "sharedVault").hit, false);
});

// ---------------------------------------------------------------------------
// SCOPE (filter slice): boards must not evict or impersonate each other
// ---------------------------------------------------------------------------

test("RED: two boards coexist — one must not evict the other", () => {
  beforeEach();
  const A = "MarketAAA", B = "MarketBBB";
  storeScan(PROG, "sharedVault", rows(5), 1_000_000, A);
  storeScan(PROG, "sharedVault", rows(9), 1_000_000, B);
  const a = lookupScan(PROG, "sharedVault", 1_000_001, A);
  const b = lookupScan(PROG, "sharedVault", 1_000_001, B);
  assert.equal(a.hit && a.rows.length, 5, "board A must survive board B being fetched");
  assert.equal(b.hit && b.rows.length, 9);
});

test("RED: a one-board entry must NEVER answer an all-boards request", () => {
  // The dangerous direction. Serving JTO's 638 vaults to a caller that asked for
  // every board is a silently TRUNCATED board — positions and markets pages
  // would simply lose rows, with nothing to indicate it.
  beforeEach();
  storeScan(PROG, "sharedVault", rows(5), 1_000_000, "MarketAAA");
  assert.equal(lookupScan(PROG, "sharedVault", 1_000_001, "").hit, false,
    "an unfiltered request must not be served a single board");
});

test("an all-boards entry MAY answer a one-board request — it is a superset", () => {
  beforeEach();
  storeScan(PROG, "sharedVault", rows(12), 1_000_000, "");
  const r = lookupScan(PROG, "sharedVault", 1_000_001, "MarketAAA");
  assert.equal(r.hit, true, "the full set contains that board, so it is a valid answer");
  assert.equal(r.hit && r.rows.length, 12);
});

test("invalidation clears EVERY scope, not just the one named", () => {
  // A mutation invalidates the world. Dropping only one scope would leave the
  // other boards serving pre-mutation rows.
  beforeEach();
  storeScan(PROG, "sharedVault", rows(1), 1_000_000, "");
  storeScan(PROG, "sharedVault", rows(2), 1_000_000, "MarketAAA");
  storeScan(PROG, "sharedVault", rows(3), 1_000_000, "MarketBBB");
  invalidateScanCache(PROG, "sharedVault");
  for (const scope of ["", "MarketAAA", "MarketBBB"]) {
    assert.equal(lookupScan(PROG, "sharedVault", 1_000_001, scope).hit, false, `scope "${scope}" must be cleared`);
  }
});

test("revalidation is claimed per scope, so one board does not block another", () => {
  beforeEach();
  storeScan(PROG, "sharedVault", rows(5), 1_000_000, "MarketAAA");
  storeScan(PROG, "sharedVault", rows(5), 1_000_000, "MarketBBB");
  assert.equal(claimRevalidation(PROG, "sharedVault", "MarketAAA"), true);
  assert.equal(claimRevalidation(PROG, "sharedVault", "MarketAAA"), false, "same board: single-flight");
  assert.equal(claimRevalidation(PROG, "sharedVault", "MarketBBB"), true, "different board: independent");
});
