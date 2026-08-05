// =============================================================================
// settleTuples.test.ts — gates the SB settle unlock (recon 2026-08-05).
// run: node app/scripts/run-settle-tuples-tests.mjs
// =============================================================================
//
// The RED case is the real one: the shipped BLK-9 filter gated on
// `oracleSource === 0`, which hid all 45 Switchboard tuples that already had a
// SettlementRecord and were settleable via the oracle-free fan-out. Every
// fixture below is drawn from measured devnet state on 2026-08-05.
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  classifySettleTuples,
  actionable,
  unsettleable,
  SB_SETTLE_WINDOW_SECS,
  PYTH_MAX_AGE_SECS,
  type MarketRow,
  type VaultRow,
  type RecordRow,
} from "./settleTuples";

const NOW = Date.parse("2026-08-05T12:00:00Z") / 1000;
const D = 86_400;

// Real markets, real oracle sources.
const MARKETS: MarketRow[] = [
  { pda: "mSOL", assetName: "SOL", feedIdHex: "e01f", oracleSource: 1 },
  { pda: "mAAPL", assetName: "AAPL", feedIdHex: "d0ab", oracleSource: 1 },
  { pda: "mNVDA", assetName: "NVDA", feedIdHex: "5378", oracleSource: 1 },
  { pda: "mXAG", assetName: "XAG", feedIdHex: "f2fb", oracleSource: 0 },
  { pda: "mLEGACY", assetName: "LEG", feedIdHex: "aaaa", oracleSource: undefined as unknown as number },
];

// SOL 2026-07-31 — SB, 5 days past expiry, SettlementRecord EXISTS.
const SOL_EXPIRY = Date.parse("2026-07-31T08:00:00Z") / 1000;
// NVDA 2026-05-15 — SB, 82 days past, NO record. Permanently dark.
const NVDA_EXPIRY = Date.parse("2026-05-15T08:00:00Z") / 1000;

const v = (pda: string, market: string, expiry: number, isSettled = false): VaultRow => ({ pda, market, expiry, isSettled });

const VAULTS: VaultRow[] = [
  v("s1", "mSOL", SOL_EXPIRY), v("s2", "mSOL", SOL_EXPIRY), v("s3", "mSOL", SOL_EXPIRY, true),
  v("n1", "mNVDA", NVDA_EXPIRY),
];
const RECORDS: RecordRow[] = [{ assetName: "SOL", expiry: SOL_EXPIRY }];

// ---------------------------------------------------------------------------
// The defect the BLK-9 filter caused.
// ---------------------------------------------------------------------------

test("RED: a Switchboard tuple with a SettlementRecord is settleable", () => {
  const t = classifySettleTuples(VAULTS, MARKETS, RECORDS, NOW);
  const sol = t.find((x) => x.asset === "SOL")!;
  assert.equal(sol.oracleSource, 1, "fixture must be Switchboard");
  assert.ok(NOW - sol.expiry > SB_SETTLE_WINDOW_SECS, "fixture must be past the SB window");
  assert.equal(sol.hasRecord, true);
  // The whole point: past the SB window, Switchboard-sourced, and STILL settleable,
  // because settle_vault reads the record and touches no oracle.
  assert.equal(sol.cls, "settleable");
  assert.ok(actionable(t).some((x) => x.asset === "SOL"));
});

test("RED: settled vaults are excluded but the tuple survives for its siblings", () => {
  const t = classifySettleTuples(VAULTS, MARKETS, RECORDS, NOW);
  const sol = t.find((x) => x.asset === "SOL")!;
  assert.deepEqual(sol.vaultPdas.sort(), ["s1", "s2"]);
});

// ---------------------------------------------------------------------------
// The dark class — must never reach a quest-earnable list.
// ---------------------------------------------------------------------------

test("a Switchboard tuple with no record, past the window, is permanently dark", () => {
  const t = classifySettleTuples(VAULTS, MARKETS, RECORDS, NOW);
  const nvda = t.find((x) => x.asset === "NVDA")!;
  assert.equal(nvda.hasRecord, false);
  assert.equal(nvda.cls, "dark");
  assert.equal(actionable(t).some((x) => x.asset === "NVDA"), false, "dark tuples must not be actionable");
  assert.ok(unsettleable(t).some((x) => x.asset === "NVDA"));
});

test("a Switchboard tuple inside the 300s window is crankOnly, not actionable", () => {
  const exp = NOW - 100;
  const t = classifySettleTuples([v("x1", "mSOL", exp)], MARKETS, [], NOW);
  assert.equal(t[0].cls, "crankOnly");
  assert.equal(actionable(t).length, 0, "the FE cannot post an SB quote — never promise it");
  assert.equal(unsettleable(t).length, 0, "and it is not dark either — the crank can still take it");
});

test("the SB window boundary is inclusive", () => {
  const at = classifySettleTuples([v("a", "mSOL", NOW - SB_SETTLE_WINDOW_SECS)], MARKETS, [], NOW);
  const past = classifySettleTuples([v("b", "mSOL", NOW - SB_SETTLE_WINDOW_SECS - 1)], MARKETS, [], NOW);
  assert.equal(at[0].cls, "crankOnly");
  assert.equal(past[0].cls, "dark");
});

// ---------------------------------------------------------------------------
// Pyth is untouched.
// ---------------------------------------------------------------------------

test("a Pyth tuple with no record stays settleable inside the 30-day backstop", () => {
  const t = classifySettleTuples([v("p1", "mXAG", NOW - 10 * D)], MARKETS, [], NOW);
  assert.equal(t[0].cls, "pyth");
  assert.equal(actionable(t).length, 1);
});

test("a Pyth tuple past the 30-day backstop is dark", () => {
  const t = classifySettleTuples([v("p2", "mXAG", NOW - PYTH_MAX_AGE_SECS - 1)], MARKETS, [], NOW);
  assert.equal(t[0].cls, "dark");
});

test("a legacy market with no oracle_source byte is treated as Pyth", () => {
  const t = classifySettleTuples([v("l1", "mLEGACY", NOW - D)], MARKETS, [], NOW);
  assert.equal(t[0].oracleSource, 0);
  assert.equal(t[0].cls, "pyth");
});

// ---------------------------------------------------------------------------
// Zero-row discipline + ordering.
// ---------------------------------------------------------------------------

test("unexpired and orphan vaults are ignored", () => {
  const t = classifySettleTuples(
    [v("f1", "mSOL", NOW + D), v("o1", "mGHOST", NOW - D)],
    MARKETS, [], NOW,
  );
  assert.equal(t.length, 0);
});

test("empty inputs yield empty output, not a throw", () => {
  assert.deepEqual(classifySettleTuples([], [], [], NOW), []);
  assert.deepEqual(actionable([]), []);
  assert.deepEqual(unsettleable([]), []);
});

test("tuples are ordered oldest expiry first", () => {
  const t = classifySettleTuples(
    [v("a", "mSOL", NOW - D), v("b", "mAAPL", NOW - 5 * D)],
    MARKETS, [], NOW,
  );
  assert.deepEqual(t.map((x) => x.asset), ["AAPL", "SOL"]);
});

test("a record for a different expiry does not make a tuple settleable", () => {
  const t = classifySettleTuples(
    [v("s1", "mSOL", SOL_EXPIRY)], MARKETS,
    [{ assetName: "SOL", expiry: SOL_EXPIRY - D }], NOW,
  );
  assert.equal(t[0].hasRecord, false);
  assert.equal(t[0].cls, "dark");
});
