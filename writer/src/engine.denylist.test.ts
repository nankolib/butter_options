// Proves the HARD denylist precondition: an exclusion must survive dropping the
// allow-list (assets=null / full board). The SBXAU exclusion previously lived in
// OPTA_WRITER_ASSETS, so flipping to full-board would have silently re-admitted
// it (double-XAU exposure). These tests pin that it cannot return.
//   run: npx ts-node --transpile-only src/engine.denylist.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { denyReason, scopeReason } from "./engine";

const SBXAU = { assetName: "SBXAU", assetClass: 1 };
const BTC = { assetName: "BTC", assetClass: 0 };
// BTC/ETH/XAU are BUILD-EXCLUDED from 2026-08-27 (see leash.ts), so they can no
// longer stand in for "a normal asset". SOL/JUP carry that role now; the BTC
// fixture is kept because the build-exclusion itself is worth pinning.
const SOL = { assetName: "SOL", assetClass: 0 };
const JUP = { assetName: "JUP", assetClass: 0 };
const NVDA = { assetName: "NVDA", assetClass: 2 }; // equity
const SPY = { assetName: "SPY", assetClass: 4 };   // etf

const EXCL = ["SBXAU"];
const NO_CLASSES: number[] = [];
const EQUITY_CLASSES = [2, 4];

test("SBXAU stays excluded when the allow-list is dropped (assets=null)", () => {
  assert.equal(scopeReason(SBXAU, null, EXCL, NO_CLASSES), "ticker-denylist");
});

test("denylist WINS over the allow-list (even if someone re-adds SBXAU to it)", () => {
  assert.equal(scopeReason(SBXAU, ["SBXAU", "BTC"], EXCL, NO_CLASSES), "ticker-denylist");
});

test("normal SB crypto passes on full board", () => {
  assert.equal(scopeReason(SOL, null, EXCL, NO_CLASSES), null);
  // ...and a build-excluded major does NOT, even on a full board.
  assert.equal(scopeReason(BTC, null, EXCL, NO_CLASSES), "build-excluded");
});

test("equity/ETF classes are excluded by class denylist on full board", () => {
  assert.equal(scopeReason(NVDA, null, EXCL, EQUITY_CLASSES), "class-denylist:2");
  assert.equal(scopeReason(SPY, null, EXCL, EQUITY_CLASSES), "class-denylist:4");
});

test("equities pass once the class denylist is lifted (post-funding cap raise)", () => {
  assert.equal(scopeReason(NVDA, null, EXCL, NO_CLASSES), null);
});

test("allow-list still narrows scope when no denylist hit", () => {
  assert.equal(scopeReason(SOL, ["JUP"], EXCL, NO_CLASSES), "not-in-allowlist");
  assert.equal(scopeReason(SOL, ["SOL"], EXCL, NO_CLASSES), null);
});

test("denyReason is case-insensitive on ticker", () => {
  assert.equal(denyReason({ assetName: "sbxau", assetClass: 1 }, EXCL, NO_CLASSES), "ticker-denylist");
});

test("empty denylists are a no-op", () => {
  assert.equal(scopeReason(SBXAU, null, [], []), null);
});
