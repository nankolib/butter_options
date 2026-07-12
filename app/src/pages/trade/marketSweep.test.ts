// ============================================================================
// marketSweep.test.ts — unit tests for the PURE sweep planner + level builders
// ============================================================================
// Vanilla TS + node:assert (no framework), same shape as crank/*.test.ts.
// Covers the self-trade skip (own orders dropped by the level builders) and the
// planSweep walk (fill / partial / maxLevels / depth). No RPC, no wallet — the
// pure functions take a plain BookOrder[] and return a deterministic plan.
//
// Run (ESM/TS): npx --yes tsx app/src/pages/trade/marketSweep.test.ts
// ============================================================================

import assert from "node:assert/strict";
import { buildAskLevels, buildBidLevels, planSweep } from "./marketSweep";
import type { BookOrder, OrderKind } from "../../utils/exchangeData";

// ---- Tiny runner -----------------------------------------------------------
type Test = { name: string; fn: () => void };
const tests: Test[] = [];
function test(name: string, fn: () => void): void {
  tests.push({ name, fn });
}

// ---- Fixtures --------------------------------------------------------------
const MINT = "MINT1";
const TAKER = "TAKER_WALLET";
let seq = 0;
function mkOrder(over: Partial<BookOrder> & { price: number; qty: number }): BookOrder {
  seq += 1;
  const kind: OrderKind = over.kind ?? "resaleAsk";
  return {
    pubkey: over.pubkey ?? `ord${seq}`,
    owner: over.owner ?? "MAKER",
    optionMint: over.optionMint ?? MINT,
    vault: over.vault ?? "vault1",
    kind,
    price: over.price,
    qty: over.qty,
    qtyInitial: over.qtyInitial ?? over.qty,
    nonce: over.nonce ?? "0",
    createdAt: over.createdAt ?? 0,
    collateralPerContract: over.collateralPerContract ?? 0,
  };
}

// ============================================================================
// (1) Own order at the BEST price is skipped; the next maker is crossed.
// ============================================================================
test("skip own best-price ask; next maker fills", () => {
  const orders = [
    mkOrder({ pubkey: "own", owner: TAKER, price: 1.0, qty: 5 }),   // taker's own — best
    mkOrder({ pubkey: "mk", owner: "MAKER_A", price: 1.1, qty: 5 }),
  ];
  const levels = buildAskLevels(orders, MINT, TAKER, null, 0);
  // Own order must not appear as a level.
  assert.equal(levels.length, 1, "own ask dropped from levels");
  assert.equal(levels[0].price, 1.1);

  const plan = planSweep({ side: "buy", qty: 3, levels, slippagePct: 100 });
  assert.equal(plan.legs.length, 1);
  assert.equal(plan.legs[0].price, 1.1, "crossed the maker, not the own best");
  assert.equal(plan.filledQty, 3);
  assert.equal(plan.stop, "filled");
  // No leg ever references the taker's own order.
  assert.ok(plan.legs.every((l) => l.order?.owner !== TAKER));
});

// Symmetric check for the bid-side builder (sell path).
test("skip own best-price bid; next maker fills (sell)", () => {
  const orders = [
    mkOrder({ pubkey: "ownb", owner: TAKER, kind: "bid", price: 1.2, qty: 5 }), // own best bid
    mkOrder({ pubkey: "mkb", owner: "MAKER_B", kind: "bid", price: 1.1, qty: 5 }),
  ];
  const levels = buildBidLevels(orders, MINT, TAKER);
  assert.equal(levels.length, 1, "own bid dropped");
  assert.equal(levels[0].price, 1.1);

  const plan = planSweep({ side: "sell", qty: 3, levels, slippagePct: 100 });
  assert.equal(plan.legs.length, 1);
  assert.equal(plan.legs[0].price, 1.1);
  assert.equal(plan.filledQty, 3);
  assert.equal(plan.stop, "filled");
});

// ============================================================================
// (2) Mixed-owner book — ONLY the taker's own orders are skipped, others fill.
//     One level == one order, so the skip is per-order.
// ============================================================================
test("mixed-owner book: only own orders skipped, others fill per-order", () => {
  const orders = [
    mkOrder({ pubkey: "a", owner: "MAKER_A", price: 1.0, qty: 2 }),
    mkOrder({ pubkey: "own", owner: TAKER, price: 1.0, qty: 2 }), // same price, own
    mkOrder({ pubkey: "b", owner: "MAKER_B", price: 1.05, qty: 2 }),
  ];
  const levels = buildAskLevels(orders, MINT, TAKER, null, 0);
  assert.equal(levels.length, 2, "only the two maker orders survive");
  assert.ok(levels.every((l) => l.order?.owner !== TAKER));

  const plan = planSweep({ side: "buy", qty: 4, levels, slippagePct: 100 });
  assert.equal(plan.filledQty, 4);
  assert.equal(plan.stop, "filled");
  const pubkeys = plan.legs.map((l) => l.order?.pubkey).sort();
  assert.deepEqual(pubkeys, ["a", "b"], "both maker orders filled; own excluded");
  assert.ok(plan.legs.every((l) => l.order?.owner !== TAKER));
});

// ============================================================================
// (3) Full-skip: every resting order is the taker's own → honest partial.
//     filledQty < requestedQty, stop reflects depth, no crash.
// ============================================================================
test("all-own book: honest partial, no crash", () => {
  const orders = [
    mkOrder({ pubkey: "o1", owner: TAKER, price: 1.0, qty: 2 }),
    mkOrder({ pubkey: "o2", owner: TAKER, price: 1.1, qty: 2 }),
  ];
  const levels = buildAskLevels(orders, MINT, TAKER, null, 0);
  assert.equal(levels.length, 0, "no crossable levels");

  const plan = planSweep({ side: "buy", qty: 5, levels, slippagePct: 100 });
  assert.equal(plan.legs.length, 0);
  assert.equal(plan.filledQty, 0);
  assert.ok(plan.filledQty < plan.requestedQty, "honest partial");
  assert.equal(plan.requestedQty, 5);
  assert.equal(plan.avgPrice, null);
  assert.equal(plan.stop, "depth", "ran out of depth (nothing to cross)");
});

// ============================================================================
// (4) No own orders — plan matches the deterministic baseline (regression).
//     5 maker levels, ceiling non-binding → walk caps at MAX_LEVELS (4).
// ============================================================================
test("no-own-orders: deterministic plan (maxLevels regression)", () => {
  const orders = [
    mkOrder({ pubkey: "L1", owner: "M1", price: 1.0, qty: 2 }),
    mkOrder({ pubkey: "L2", owner: "M2", price: 1.1, qty: 3 }),
    mkOrder({ pubkey: "L3", owner: "M3", price: 1.2, qty: 2 }),
    mkOrder({ pubkey: "L4", owner: "M4", price: 1.3, qty: 2 }),
    mkOrder({ pubkey: "L5", owner: "M5", price: 1.4, qty: 2 }),
  ];
  const levels = buildAskLevels(orders, MINT, TAKER, null, 0);
  assert.equal(levels.length, 5);

  const plan = planSweep({ side: "buy", qty: 20, levels, slippagePct: 100 });
  // Exactly MAX_LEVELS legs, in ascending price, then stop.
  assert.equal(plan.legs.length, 4);
  assert.deepEqual(
    plan.legs.map((l) => [l.price, l.qty]),
    [[1.0, 2], [1.1, 3], [1.2, 2], [1.3, 2]],
  );
  assert.equal(plan.filledQty, 9);
  assert.equal(plan.requestedQty, 20);
  assert.equal(plan.stop, "maxLevels");
  // avgPrice = (1.0*2 + 1.1*3 + 1.2*2 + 1.3*2) / 9 = 10.3 / 9
  assert.ok(Math.abs((plan.avgPrice ?? 0) - 10.3 / 9) < 1e-9);
});

// ============================================================================
// Bonus: the vault peg (no owner) is offered and sorts by price alongside asks.
// ============================================================================
test("peg level is offered and never treated as own", () => {
  const orders = [
    mkOrder({ pubkey: "own", owner: TAKER, price: 0.9, qty: 5 }), // own best — dropped
    mkOrder({ pubkey: "mk", owner: "MAKER_A", price: 1.2, qty: 2 }),
  ];
  const levels = buildAskLevels(orders, MINT, TAKER, /*pegAsk*/ 1.0, /*pegCapacity*/ 4);
  // own dropped, maker + peg remain
  assert.equal(levels.length, 2);
  assert.ok(levels.some((l) => l.source === "peg"));

  const plan = planSweep({ side: "buy", qty: 3, levels, slippagePct: 100 });
  // peg @1.0 (cap 4) is best after own removed → fills all 3 from peg.
  assert.equal(plan.legs.length, 1);
  assert.equal(plan.legs[0].source, "peg");
  assert.equal(plan.filledQty, 3);
  assert.equal(plan.stop, "filled");
});

// ---- Runner ----------------------------------------------------------------
function main(): void {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      t.fn();
      console.log(`✓ ${t.name}`);
      passed += 1;
    } catch (err) {
      console.error(`✗ ${t.name}`);
      console.error(`  ${err}`);
      failed += 1;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
main();
