// =============================================================================
// wave1.test.ts — regression gates for the 2026-08-04 gap-audit fixes.
// run: node app/scripts/run-wave1-tests.mjs
// =============================================================================
//
// Same deal as epoch0Format.test.ts: app/ has no test runner, so the logic under
// test lives in pure modules and a tsc→CJS runner executes it under node:test.
//
// Each block below is anchored to a finding in
// FULL_SURFACE_GAP_AUDIT_2026-08-04.md and fails against the pre-fix code.
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import { tvSymbol, hasExplicitTvSymbol } from "./tvSymbol";
import { expiryCountdown } from "./expiryLabel";
import { assetClassOf } from "../../utils/assetDisplay";

// ---------------------------------------------------------------------------
// BLK-2 — every listed asset must chart.
// ---------------------------------------------------------------------------

/** The live board, 2026-08-04: 22 assets in the Trade dropdown + the commodities
 *  the Write selector lists. Keep in sync with a new listing. */
const EQUITIES = [
  "AAPL", "MSFT", "NVDA", "TSLA", "MSTR", "GOOGL", "AMZN",
  "AMD", "COIN", "META", "HOOD", "SPCX", "CRCL",
];
const CRYPTO = ["BTC", "ETH", "SOL", "XRP", "JUP", "JTO", "WIF", "BONK", "FARTCOIN"];
const COMMODITIES = ["XAU", "XAG", "WTI", "BRENT"];

test("BLK-2: every equity has an explicit TradingView symbol", () => {
  for (const t of EQUITIES) {
    assert.equal(hasExplicitTvSymbol(t), true, `${t} falls through to the Binance fallback`);
  }
});

test("BLK-2: no listed asset resolves to a fabricated BINANCE equity pair", () => {
  // The exact defect: an unmapped equity became BINANCE:<T>USDT, which does not
  // exist, and TradingView rendered "This symbol doesn't exist".
  for (const t of EQUITIES) {
    assert.notEqual(tvSymbol(t), `BINANCE:${t}USDT`, `${t} maps to a nonexistent Binance pair`);
  }
});

test("BLK-2: verified exchange prefixes — the traps that cost a re-verify", () => {
  // All three were confirmed in a live TradingView embed on 2026-08-04.
  assert.equal(tvSymbol("CRCL"), "NYSE:CRCL");       // NOT NASDAQ
  assert.equal(tvSymbol("SPCX"), "NASDAQ:SPCX");     // AMEX/OTC are invalid
  assert.equal(tvSymbol("FARTCOIN"), "MEXC:FARTCOINUSDT"); // BINANCE/BYBIT invalid
});

test("BLK-2: commodities and crypto stay mapped", () => {
  for (const t of [...COMMODITIES, ...CRYPTO]) {
    assert.equal(hasExplicitTvSymbol(t), true, `${t} is unmapped`);
  }
  assert.equal(tvSymbol("XAU"), "OANDA:XAUUSD");
});

test("BLK-2: the crypto fallback still applies to genuinely unknown tickers", () => {
  assert.equal(tvSymbol("SOMENEWTOKEN"), "BINANCE:SOMENEWTOKENUSDT");
  assert.equal(hasExplicitTvSymbol("SOMENEWTOKEN"), false);
});

test("BLK-2: lookup is case-insensitive", () => {
  assert.equal(tvSymbol("googl"), "NASDAQ:GOOGL");
});

// ---------------------------------------------------------------------------
// BLK-8 — the context-strip expiry must be UTC, matching ExpiryTabs.
// ---------------------------------------------------------------------------

// AAPL's real near expiry, read off chain 2026-08-04: 19:45 UTC. In any timezone
// at or east of UTC+04:15 the LOCAL date is 08 AUG — that was the bug.
const AAPL_EXPIRY = Date.parse("2026-08-07T19:45:00Z") / 1000;

test("BLK-8: an equity expiry renders its UTC date, not the local one", () => {
  const out = expiryCountdown(AAPL_EXPIRY, Date.parse("2026-08-04T17:04:12Z"));
  assert.ok(out.startsWith("07 AUG"), `expected UTC "07 AUG", got "${out}"`);
});

test("BLK-8: the countdown itself is unchanged", () => {
  const out = expiryCountdown(AAPL_EXPIRY, Date.parse("2026-08-04T17:04:12Z"));
  assert.equal(out, "07 AUG · 3D 2H");
});

test("BLK-8: an 08:00 UTC crypto expiry is unaffected (it never crossed midnight)", () => {
  const out = expiryCountdown(
    Date.parse("2026-08-07T08:00:00Z") / 1000,
    Date.parse("2026-08-04T17:04:12Z"),
  );
  assert.ok(out.startsWith("07 AUG"), out);
});

test("BLK-8: sub-day and expired shapes still render", () => {
  const e = Date.parse("2026-08-07T19:45:00Z") / 1000;
  assert.equal(expiryCountdown(e, Date.parse("2026-08-07T16:30:00Z")), "07 AUG · 3H 15M");
  assert.equal(expiryCountdown(e, Date.parse("2026-08-08T00:00:00Z")), "07 AUG · EXPIRED");
});

// ---------------------------------------------------------------------------
// P-4 — the Wave-1 memes are crypto, not "Other".
// ---------------------------------------------------------------------------

test("P-4: every crypto ticker on the board groups as Crypto", () => {
  for (const t of CRYPTO) {
    assert.equal(assetClassOf(t), "Crypto", `${t} grouped as ${assetClassOf(t)}`);
  }
});

test("P-4: the Write selector's extra crypto tickers group as Crypto", () => {
  // HYPE and RAY are registered with live feeds and appear in the Write selector.
  for (const t of ["HYPE", "RAY"]) {
    assert.equal(assetClassOf(t), "Crypto", `${t} grouped as ${assetClassOf(t)}`);
  }
});

test("P-4: existing groupings are untouched", () => {
  for (const t of EQUITIES) assert.equal(assetClassOf(t), "Equities", t);
  for (const t of ["XAU", "XAG", "WTI", "BRENT"]) assert.equal(assetClassOf(t), "Commodities", t);
  assert.equal(assetClassOf("EURUSD"), "FX");
  assert.equal(assetClassOf("WHATEVER"), "Other");
});
