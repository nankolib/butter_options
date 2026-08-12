// =============================================================================
// askRows.test.ts — SLICE 2B: the writes that were invisible
// =============================================================================
//   run: node app/scripts/run-ask-rows-tests.mjs
//
// THE BUG. Portfolio → WRITTEN was built only from `WriterPosition`. A modern
// /write (epoch, American — the default) creates a `WriterAskPosition` instead,
// and nothing in the app read that account type. Measured on chain 2026-08-11:
// the ORE writer had ZERO WriterPosition accounts and ONE WriterAskPosition
// ($124 committed, 2 contracts), across 16 such accounts held by 11 backers.
// Every one of those writers was told "Nothing written."
// =============================================================================

import assert from "node:assert/strict";
import { test } from "node:test";

import BN from "bn.js";

import { askCollateralByAsset, askCollateralTotal, buildAskRows } from "./askRows";

const key = (s: string) => ({ toBase58: () => s }) as never;
const WALLET = key("Awi8u6PigydVN4XRBQzmiPEdyyVmtnwf1H7Gmrf5ARu5");
const OTHER = key("HgafDv195BtNc8X4uvNoRuGcUra5PuUwDJgHeKHvgFiS");
const VAULT = "HbZmKpaN000000000000000000000000000000000000";
const MARKET = "JDgD9LPtTcqPKJcpcWUSg3oxJ6peMQ93tpgsdAHpeEWi";

const ask = (over: Record<string, unknown> = {}) =>
  ({
    publicKey: key("ABAX4nX3000000000000000000000000000000000000"),
    account: {
      backer: WALLET,
      optionMint: key("mint1"),
      vault: key(VAULT),
      collateralCommitted: 124_000_000, // $124
      contractsWritten: 2,
      createdAt: 1_786_400_000,
      ...over,
    },
  }) as never;

const vault = () =>
  ({
    publicKey: key(VAULT),
    account: {
      market: key(MARKET),
      strikePrice: 62_000_000, // $62
      expiry: 1_786_780_800,
      optionType: 0, // call
    },
  }) as never;

const ASSETS = new Map([[MARKET, "ORE"]]);

// ---- the core regression ----------------------------------------------------

test("RED: a WriterAskPosition produces a row (this is the whole bug)", () => {
  const rows = buildAskRows([ask()], [vault()], WALLET, ASSETS);
  assert.equal(rows.length, 1, "the ORE write must be visible");
  assert.equal(rows[0].asset, "ORE");
  assert.equal(rows[0].strike, 62);
  assert.equal(rows[0].side, "call");
  assert.equal(rows[0].collateral, 124);
  assert.equal(rows[0].contracts, 2);
});

test("only the connected wallet's asks are shown", () => {
  const rows = buildAskRows([ask(), ask({ backer: OTHER })], [vault()], WALLET, ASSETS);
  assert.equal(rows.length, 1);
});

test("no wallet → no rows (never leak someone else's book)", () => {
  assert.deepEqual(buildAskRows([ask()], [vault()], null, ASSETS), []);
});

test("a fully-consumed or cancelled ask (0 contracts) is not a row", () => {
  assert.equal(buildAskRows([ask({ contractsWritten: 0 })], [vault()], WALLET, ASSETS).length, 0);
});

// ---- the filter that caused the original blackout ---------------------------

test("RED: a MISSING vault does NOT drop the row — it degrades the labels", () => {
  // buildWriterRows drops a position whose vault is absent. Copying that here
  // would reproduce the very failure this file exists to fix: the collateral and
  // contract count come from the ask account itself and are true regardless of
  // whether this page happened to load the vault.
  const rows = buildAskRows([ask()], [], WALLET, ASSETS);
  assert.equal(rows.length, 1, "an unlabelled row beats an invisible one");
  assert.equal(rows[0].collateral, 124, "the money is still known");
  assert.equal(rows[0].contracts, 2);
  assert.equal(rows[0].asset, "?");
  assert.equal(rows[0].strike, null);
  assert.equal(rows[0].expiry, null);
  assert.equal(rows[0].side, null);
});

test("an unknown market degrades the asset to ? without dropping the row", () => {
  const rows = buildAskRows([ask()], [vault()], WALLET, new Map());
  assert.equal(rows.length, 1);
  assert.equal(rows[0].asset, "?");
  assert.equal(rows[0].strike, 62, "vault-derived fields still resolve");
});

// ---- shape ------------------------------------------------------------------

test("puts are labelled as puts", () => {
  const v = vault() as unknown as { account: { optionType: number } };
  v.account.optionType = 1;
  assert.equal(buildAskRows([ask()], [v as never], WALLET, ASSETS)[0].side, "put");
});

test("REAL BN values decode — this is the shape Anchor actually returns", () => {
  // An earlier version of this test used a hand-rolled { toNumber } stub and
  // passed for the wrong reason: usdcToNumber calls .gt(), which a stub does not
  // have. Using a real BN tests the production shape instead of a convenient one.
  const rows = buildAskRows(
    [
      ask({
        collateralCommitted: new BN(50_000_000),
        contractsWritten: new BN(3),
        createdAt: new BN(99),
      }),
    ],
    [vault()],
    WALLET,
    ASSETS,
  );
  assert.equal(rows[0].collateral, 50);
  assert.equal(rows[0].contracts, 3);
  assert.equal(rows[0].createdAt, 99);
});

test("rows are newest-first — a writer looks for what they just posted", () => {
  const rows = buildAskRows(
    [
      ask({ createdAt: 100 }),
      ask({ createdAt: 300 }),
      ask({ createdAt: 200 }),
    ],
    [vault()],
    WALLET,
    ASSETS,
  );
  assert.deepEqual(rows.map((r) => r.createdAt), [300, 200, 100]);
});

// ---- aggregation (the summary + BY ASSET under-report) ----------------------

test("RED: ask collateral totals — the summary said $0 while USDC was committed", () => {
  const rows = buildAskRows([ask(), ask({ collateralCommitted: 76_000_000 })], [vault()], WALLET, ASSETS);
  assert.equal(askCollateralTotal(rows), 200);
});

test("ask collateral splits by asset for the BY ASSET column", () => {
  const otherVault = {
    publicKey: key("VAULT2"),
    account: { market: key("MKT2"), strikePrice: 1_000_000, expiry: 1, optionType: 0 },
  } as never;
  const rows = buildAskRows(
    [ask(), ask({ vault: key("VAULT2"), collateralCommitted: 10_000_000 })],
    [vault(), otherVault],
    WALLET,
    new Map([
      [MARKET, "ORE"],
      ["MKT2", "SOL"],
    ]),
  );
  const m = askCollateralByAsset(rows);
  assert.equal(m.get("ORE"), 124);
  assert.equal(m.get("SOL"), 10);
});

test("totals of an empty book are zero, not NaN", () => {
  assert.equal(askCollateralTotal([]), 0);
  assert.equal(askCollateralByAsset([]).size, 0);
});
