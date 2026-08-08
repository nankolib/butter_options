// =============================================================================
// assetRegistry.test.ts — which oracle a NEW market is born on (K2/D1)
// =============================================================================
//
// WHY THIS FILE IS LOAD-BEARING: `oracle_source` is IMMUTABLE. Only
// create_market writes it, and close+recreate is the only migration path. Every
// assertion here is therefore about a decision that is permanent for the life of
// the market it creates.
//
// THE DEFECT THIS COVERS (measured against the LIVE Hermes catalog, 2026-08-08,
// 2967 entries — see the census in the K2 session report):
//
//   buildAssetRegistry joins the curated SB feeds onto the Pyth catalog by
//   (asset_class, ticker), and REFUSES the join when more than one Pyth feed
//   shares that key. The refusal is right in spirit. But `deriveTicker` returns
//   the BASE ALONE for every non-FX class, so the key collides on feeds that are
//   not competing candidates at all:
//
//     0:ETH   <- Crypto.ETH/USD  +  Crypto.ETH/BTC          (different numeraire)
//     0:SOL   <- Crypto.SOL/USD  +  Crypto.SOL/ETH          (different numeraire)
//     2:MSFT  <- Equity.US.MSFT/USD + .PRE + .POST + .ON    (same asset, 4 sessions)
//
//   Result at head: 14 of the 23 curated SB feeds — ALL 13 equities bar SPCX,
//   plus ETH and SOL — had their SB hash dropped, so the create modal offered
//   them as PYTH-ONLY rows. Every equity created from the UI was therefore born
//   on Pyth, months after the equity board moved to Switchboard.
//
//   Worse, the surviving Pyth id is chosen by "first feed wins" over catalog
//   ORDER. In the live catalog `Crypto.SOL/ETH` sorts before `Crypto.SOL/USD`,
//   so the SOL row's Pyth feed was the SOL/ETH ratio — a market whose strike and
//   settlement price are denominated in ETH while its collateral is USDC.
//
// THE FIX UNDER TEST: exclude non-candidates before counting ambiguity. For
// non-FX classes a candidate must quote USD and carry no session suffix. FX is
// exempt because deriveTicker returns base+quote there, so the pair IS the asset
// and USD/JPY is a legitimate distinct row.
//
// Run: node app/scripts/run-registry-tests.mjs
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildAssetRegistry } from "./assetRegistry";
import type { CatalogEntry } from "./hermesCatalog";
import type { SbFeedDatum } from "./sbFeedData";
import { resolveSource, type LivenessMap } from "./routeSource";

// ---- fixtures: real symbols and real feed ids from the live catalog ---------

const c = (
  feedIdHex: string,
  hermesSymbol: string,
  suggestedTicker: string,
  suggestedAssetClass: 0 | 1 | 2 | 3 | 4,
): CatalogEntry => ({ feedIdHex, hermesSymbol, suggestedTicker, suggestedAssetClass });

const sb = (
  feedHashHex: string,
  symbol: string,
  suggestedAssetClass: 0 | 1 | 2 | 3 | 4,
): SbFeedDatum => ({
  feedHashHex,
  symbol,
  suggestedAssetClass,
  queuePubkey: "EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7",
  quoteProgramPubkey: "orac1eFjzWL5R3RbbdMV68K9H6TaCVVcL6LjvQQWAbz",
  minOracleSamples: 2,
});

// Session variants deliberately precede the regular-session feed, exactly as the
// live catalog orders them for AAPL/MSFT — so "first feed wins" picks wrong.
const MSFT_POST = "556b3e4dcc1c00000000000000000000000000000000000000000000000000ab";
const MSFT_PRE = "e8da9716284000000000000000000000000000000000000000000000000000cd";
const MSFT_ON = "8f98f8267ddd0000000000000000000000000000000000000000000000000ef1";
const MSFT_USD = "d0ca23c1cc0000000000000000000000000000000000000000000000000000ff";
const MSFT_SB = "b13e5f030af9a49150591b6cbce83810184331e5b6a0eae8b303a49153496c56";

const SOL_ETH = "de87506dabfa00000000000000000000000000000000000000000000000000aa";
const SOL_USD = "ef0d8b6fda2c00000000000000000000000000000000000000000000000000bb";
const SOL_SB = "e01fe3bb1d659e5957296b2637658defd1f8b42fc87dd9f16e8fff16fcaeb463";

const ETH_USD = "ff61491a931100000000000000000000000000000000000000000000000000cc";
const ETH_BTC = "c96458d393fe00000000000000000000000000000000000000000000000000dd";
const ETH_SB = "1d8f55a03da760d0f322bc1d066427e95573f651d506e0e31a5499659349caa3";

const find = (rows: ReturnType<typeof buildAssetRegistry>, ticker: string) =>
  rows.find((r) => r.ticker === ticker);

// =============================================================================
// D1 — the assignment: a created equity market must land oracle_source = 1.
// =============================================================================

test("D1: an equity with a curated SB feed resolves to Switchboard", () => {
  const rows = buildAssetRegistry(
    [
      c(MSFT_POST, "Equity.US.MSFT/USD.POST", "MSFT", 2),
      c(MSFT_PRE, "Equity.US.MSFT/USD.PRE", "MSFT", 2),
      c(MSFT_ON, "Equity.US.MSFT/USD.ON", "MSFT", 2),
      c(MSFT_USD, "Equity.US.MSFT/USD", "MSFT", 2),
    ],
    [sb(MSFT_SB, "MSFT/USD", 2)],
  );

  const msft = find(rows, "MSFT");
  assert.ok(msft, "MSFT row must exist");
  assert.equal(
    msft.sbFeedHash,
    MSFT_SB,
    "the SB hash was dropped — the four session variants were counted as competing feeds",
  );
  assert.equal(msft.canonicalSource, 1, "an equity with an SB feed must default to Switchboard");
  assert.equal(
    msft.pythFeedId,
    MSFT_USD,
    "the Pyth fallback must be the REGULAR-session feed, not .PRE/.POST/.ON",
  );
});

// =============================================================================
// P-9 — ETH/SOL join disambiguation, and the wrong-numeraire trap behind it.
// =============================================================================

test("P-9: SOL joins its SB feed and never binds the SOL/ETH ratio feed", () => {
  const rows = buildAssetRegistry(
    // Catalog order as live: SOL/ETH first. "First feed wins" picks the ratio.
    [c(SOL_ETH, "Crypto.SOL/ETH", "SOL", 0), c(SOL_USD, "Crypto.SOL/USD", "SOL", 0)],
    [sb(SOL_SB, "SOL/USD", 0)],
  );

  const sol = find(rows, "SOL");
  assert.ok(sol, "SOL row must exist");
  assert.notEqual(
    sol.pythFeedId,
    SOL_ETH,
    "SOL bound the SOL/ETH ratio feed — strike and settlement in ETH against USDC collateral",
  );
  assert.equal(sol.pythFeedId, SOL_USD, "SOL must bind Crypto.SOL/USD");
  assert.equal(sol.sbFeedHash, SOL_SB, "the SOL SB hash was dropped by the ETH-quote collision");
});

test("P-9: ETH joins its SB feed despite the ETH/BTC pair sharing the base", () => {
  const rows = buildAssetRegistry(
    [c(ETH_USD, "Crypto.ETH/USD", "ETH", 0), c(ETH_BTC, "Crypto.ETH/BTC", "ETH", 0)],
    [sb(ETH_SB, "ETH/USD", 0)],
  );

  const eth = find(rows, "ETH");
  assert.ok(eth, "ETH row must exist");
  assert.equal(eth.pythFeedId, ETH_USD, "ETH must bind Crypto.ETH/USD");
  assert.equal(eth.sbFeedHash, ETH_SB, "the ETH SB hash was dropped by the BTC-quote collision");
});

test("P-9: an asset whose ONLY Pyth feed is non-USD is not offered at all", () => {
  // No SB feed, and the only Pyth print is a ratio. Creating this market would
  // denominate strike and settlement in ETH while collateral is USDC. There is
  // no correct feed to fall back to, so the row must not exist.
  const rows = buildAssetRegistry([c(SOL_ETH, "Crypto.SOL/ETH", "SOL", 0)], []);
  assert.equal(find(rows, "SOL"), undefined, "a non-USD-quoted row must not be creatable");
});

// =============================================================================
// P-10 — crypto class default → Switchboard.
// =============================================================================

test("P-10: a crypto row carrying both feeds defaults to Switchboard", () => {
  const rows = buildAssetRegistry(
    [c(ETH_USD, "Crypto.ETH/USD", "ETH", 0)],
    [sb(ETH_SB, "ETH/USD", 0)],
  );
  assert.equal(
    find(rows, "ETH")?.canonicalSource,
    1,
    "crypto still defaults to Pyth — the class check predates the crypto cutover",
  );
});

test("P-10: an untracked dual-source row keeps its own default instead of falling to Pyth", () => {
  // The crank publishes liveness for TradFi feeds only, so both crypto ids are
  // absent from the map. Absent is NOT evidence that Switchboard is down.
  const map: LivenessMap = { updatedAt: 1_000_000, feeds: {} };
  const r = resolveSource(
    { pythFeedId: ETH_USD, sbFeedHash: ETH_SB, canonicalSource: 1, assetClass: 0 },
    map,
    1_000_100, // fresh
  );
  assert.equal(r?.oracleSource, 1, "an unprobed pair was routed to Pyth against the row's default");
  assert.equal(r?.feedIdHex, ETH_SB);
});

// =============================================================================
// COUNTER-CASES — the fix must not become "just take the first feed".
// =============================================================================

test("COUNTER-CASE: two genuine regular-session USD feeds stay ambiguous and Pyth-only", () => {
  // FDX vs FDXF is live and real: two distinct US equities whose bases collide
  // after normalization. Nothing here disambiguates them, so the conservative
  // refusal must still fire.
  const A = "aa11000000000000000000000000000000000000000000000000000000000001";
  const B = "bb22000000000000000000000000000000000000000000000000000000000002";
  const rows = buildAssetRegistry(
    [c(A, "Equity.US.FDX/USD", "FDX", 2), c(B, "Equity.US.FDXF/USD", "FDX", 2)],
    [sb(MSFT_SB, "FDX/USD", 2)],
  );
  const fdx = find(rows, "FDX");
  assert.equal(fdx?.sbFeedHash, null, "a true ambiguity must still drop the SB hash");
  assert.equal(fdx?.canonicalSource, 0, "a true ambiguity must stay Pyth-only");
});

test("COUNTER-CASE: FX pairs are exempt — USD/JPY survives the USD-quote rule", () => {
  // deriveTicker returns base+quote for FX, so the pair IS the asset and a
  // non-USD quote leg is not a masquerade. Excluding these would delete most of
  // the FX board from the create modal.
  const JPY = "cc33000000000000000000000000000000000000000000000000000000000003";
  const rows = buildAssetRegistry([c(JPY, "FX.USD/JPY", "USDJPY", 3)], []);
  assert.equal(find(rows, "USDJPY")?.pythFeedId, JPY, "FX must not be filtered by quote leg");
});

test("COUNTER-CASE: an SB-only asset with no Pyth feed still produces a row", () => {
  // SPCX is live in exactly this shape — zero Pyth feeds, one SB feed.
  const SPCX = "fd7a0b9ea922e14e18944f8105b151df922487da9b1b2ed5ad52150924ed413f";
  const rows = buildAssetRegistry([], [sb(SPCX, "SPCX/USD", 2)]);
  const row = find(rows, "SPCX");
  assert.equal(row?.sbFeedHash, SPCX);
  assert.equal(row?.pythFeedId, null);
  assert.equal(row?.canonicalSource, 1);
});

test("COUNTER-CASE: an entry with no parseable symbol is kept, not silently deleted", () => {
  // hermesSymbol is `attrs.symbol ?? ""`. An empty symbol cannot be judged, so
  // the candidate rule must abstain rather than drop a real asset.
  const X = "dd44000000000000000000000000000000000000000000000000000000000004";
  const rows = buildAssetRegistry([c(X, "", "WEIRD", 0)], []);
  assert.equal(find(rows, "WEIRD")?.pythFeedId, X, "an unjudgeable symbol must be kept");
});

// =============================================================================
// KNOWN GAP — reported, deliberately NOT fixed in K2 (scope).
// =============================================================================

test("KNOWN GAP: the create modal still offers raw provenance tickers like UKOILSPOT", () => {
  // canonicalAsset() hides UKOILSPOT everywhere it is APPLIED — but it is
  // applied on the discovery surfaces (useMarketsData, exchangeData), not on the
  // create registry. So the create modal lists it. Left as-is on purpose: the
  // only shared hider also RENAMES (USOILSPOT -> "WTI"), and the modal writes
  // `ticker` on chain as asset_name, so reusing it here would mint markets whose
  // name no longer matches the existing on-chain USOILSPOT series.
  //
  // WHEN THIS IS FIXED, this test flips — that is the point of pinning it.
  const UK = "ee55000000000000000000000000000000000000000000000000000000000005";
  const rows = buildAssetRegistry([c(UK, "Commodities.UKOILSPOT/USD", "UKOILSPOT", 1)], []);
  assert.ok(find(rows, "UKOILSPOT"), "documents today's behaviour, not desired behaviour");
});
