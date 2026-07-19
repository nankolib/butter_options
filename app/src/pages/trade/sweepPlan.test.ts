// =============================================================================
// marketSweep.test.ts — buyRoutesToPeg predicate (FE over-gate fix).
// Run: npx ts-node --transpile-only -r tsconfig-paths/register app/src/pages/trade/marketSweep.test.ts
// =============================================================================
// The over-gate bug: needsFreshAmerQuote gated EVERY American buy on a fresh
// model quote, including a fill that lands entirely on a resting WRITER-ASK at
// the maker's fixed price (no model quote needed). buyRoutesToPeg is the pure
// predicate that distinguishes a maker-priced book fill (→ false, un-gated) from
// a peg-minting buy that needs the model quote (→ true). Tested against the REAL
// planSweep / buildAskLevels — no mocks.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buyRoutesToPeg } from "./sweepPlan";
import type { BookOrder } from "../../utils/exchangeData";

const MINT = "So1optionMint1111111111111111111111111111111";
const MAKER = "Maker1111111111111111111111111111111111111111";
const TAKER = "Taker1111111111111111111111111111111111111111";

const ask = (price: number, qty: number, owner = MAKER, kind: BookOrder["kind"] = "writerAsk"): BookOrder => ({
  pubkey: `ask-${price}-${qty}-${owner}`, owner, optionMint: MINT, vault: "vault11111111111111111111111111111111111111",
  kind, price, qty, qtyInitial: qty, nonce: "1", createdAt: 0, collateralPerContract: kind === "writerAsk" ? 5 : 0,
});
const base = { orders: [] as BookOrder[], optionMint: MINT, taker: TAKER, slippagePct: 5 };

// ---- THE FIX: a book fill on resting writer-asks does NOT route to the peg ----
test("market buy fully covered by a resting writer-ask ⇒ NOT peg-routed (un-gated)", () => {
  const orders = [ask(1.0, 10)];
  assert.equal(buyRoutesToPeg({ ...base, orders, type: "market", limitPrice: 0, qty: 5 }), false);
});

// ---- book too thin ⇒ spills to the peg ⇒ needs the model quote ---------------
test("market buy exceeding resting depth ⇒ peg-routed (gated)", () => {
  const orders = [ask(1.0, 3)];
  assert.equal(buyRoutesToPeg({ ...base, orders, type: "market", limitPrice: 0, qty: 5 }), true);
});

// ---- empty book ⇒ only source is the peg ⇒ gated -----------------------------
test("market buy with no resting liquidity ⇒ peg-routed (gated)", () => {
  assert.equal(buyRoutesToPeg({ ...base, orders: [], type: "market", limitPrice: 0, qty: 1 }), true);
});

// ---- the taker's own ask is not fillable liquidity → peg-routed --------------
test("only the taker's own ask on the book ⇒ peg-routed (self-trade filtered)", () => {
  const orders = [ask(1.0, 10, TAKER)];
  assert.equal(buyRoutesToPeg({ ...base, orders, type: "market", limitPrice: 0, qty: 5 }), true);
});

// ---- resale asks are maker-priced too ---------------------------------------
test("resale-ask liquidity covering qty ⇒ NOT peg-routed", () => {
  const orders = [ask(1.2, 8, MAKER, "resaleAsk")];
  assert.equal(buyRoutesToPeg({ ...base, orders, type: "market", limitPrice: 0, qty: 5 }), false);
});

// ---- limit BELOW best ask just rests a bid ⇒ no fill ⇒ NOT peg-routed --------
test("non-marketable limit (below best ask) ⇒ rests a bid ⇒ NOT peg-routed", () => {
  const orders = [ask(2.0, 10)];
  assert.equal(buyRoutesToPeg({ ...base, orders, type: "limit", limitPrice: 1.5, qty: 5 }), false);
});

// ---- marketable limit covered by the book ⇒ NOT peg-routed -------------------
test("marketable limit fully covered by resting asks ⇒ NOT peg-routed", () => {
  const orders = [ask(1.0, 10)];
  assert.equal(buyRoutesToPeg({ ...base, orders, type: "limit", limitPrice: 1.5, qty: 5 }), false);
});

// ---- marketable limit that outruns book depth ⇒ peg-routed -------------------
test("marketable limit exceeding resting depth ⇒ peg-routed", () => {
  const orders = [ask(1.0, 2)];
  assert.equal(buyRoutesToPeg({ ...base, orders, type: "limit", limitPrice: 1.5, qty: 5 }), true);
});
