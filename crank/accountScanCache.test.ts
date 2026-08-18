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
