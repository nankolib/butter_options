// =============================================================================
// bids.test.ts — C0 gate matrix for the dependent-quote bid module.
// =============================================================================
// The eight gates from the writer-bids proposal. All pure — no RPC, no chain.
//   run: npx ts-node --transpile-only src/bids.test.ts
//
// The load-bearing one is gate 2 (no-cross). There is NO on-chain cross check —
// post_order never inspects other orders and the self-trade guard (6023) only
// stops the writer filling its OWN order, not a third party round-tripping a
// crossed book. This module is the entire defence.
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bidSpreadBps,
  withinAtmBand,
  bidPriceFrom,
  roundsToZero,
  crossesAsk,
  bidDepth,
  bidBudgetRemaining,
  decideBid,
  decideRelist,
  CROSS_GUARD_BPS,
  TICK_USDC,
  type BidDecisionInput,
  type BidPolicy,
} from "./bids";

// ---- fixtures ---------------------------------------------------------------

const policy = (over: Partial<BidPolicy> = {}): BidPolicy => ({
  enabled: true,
  atmRungs: 0,
  maxNotionalPerAsset: 250,
  maxNotionalGlobal: 2500,
  reserveUsdc: 5000,
  maxCells: 0,
  maxLongPerSeries: 10,
  depthFrac: 0.25,
  driftBps: 300,
  maxAgeMs: 30 * 60 * 1000,
  ...over,
});

/** A healthy cell: ask resting at 1.05, mark 1.00, everything open and fresh. */
const inp = (over: Partial<BidDecisionInput> = {}): BidDecisionInput => ({
  policy: policy(),
  askOutcome: "held",
  rungIndex: 0,
  restingAskPrice: 1.05,
  mark: 1.0,
  askSpreadBps: 500,
  askQty: 100,
  existingBid: null,
  heldLong: 0,
  assetBidNotional: 0,
  globalBidNotional: 0,
  freeUsdcAfterAsks: 100_000,
  liveBidCells: 0,
  marketOpen: true,
  quoteFails: 0,
  oracleReady: true,
  nowMs: 1_000_000,
  ...over,
});

// =============================================================================
// GATE 1 — spread derivation per class, including the +200bps floor
// =============================================================================

test("gate 1: bidSpread = max(ask x 1.5, ask + 200bps), per live tier", () => {
  // The four spreads classifyTier actually emits today (ladder.ts:40-50).
  assert.equal(bidSpreadBps(500), 750, "crypto major 500 -> 750 (x1.5 wins)");
  assert.equal(bidSpreadBps(1000), 1500, "meme 1000 -> 1500 (x1.5 wins)");
  assert.equal(bidSpreadBps(400), 600, "metal 400 -> 600 (x1.5 wins)");
  assert.equal(bidSpreadBps(600), 900, "equity/fx/etf 600 -> 900 (x1.5 wins)");
});

test("gate 1: the +200bps floor binds on tight ask spreads", () => {
  // x1.5 would be 150 — too thin to cover a 100bps round-trip fee.
  assert.equal(bidSpreadBps(100), 300, "100 -> 300 (floor wins over x1.5=150)");
  assert.equal(bidSpreadBps(300), 500, "300 -> 500 (floor wins over x1.5=450)");
  // 400 is the crossover: x1.5 = 600 == 400+200. Both agree.
  assert.equal(bidSpreadBps(400), 600, "400 is the crossover point");
});

test("gate 1: bid is always strictly BELOW the mark, ask always above", () => {
  const mark = 0.02;
  const bid = bidPriceFrom(mark, 500);
  assert.ok(bid < mark, "bid below mark");
  assert.equal(+bid.toFixed(9), +(mark * (1 - 750 / 10_000)).toFixed(9));
});

test("gate 1: tick floor — a price under one USDC tick rounds to zero", () => {
  assert.equal(TICK_USDC, 0.000001);
  assert.ok(roundsToZero(0.0000004), "sub-tick rounds to zero");
  assert.ok(roundsToZero(0), "zero rounds to zero");
  assert.ok(!roundsToZero(0.000001), "exactly one tick is representable");
  assert.ok(!roundsToZero(0.5), "normal price fine");
});

test("gate 1: a mark so small the bid rounds to zero is SKIPPED, never posted at 0", () => {
  // post_order requires price_per_contract > 0 (InvalidContractSize) — posting a
  // zero bid would revert on-chain, so the module must refuse first.
  const d = decideBid(inp({ mark: 0.0000005, restingAskPrice: 0.000001 }));
  assert.equal(d.action, "skip");
  assert.match((d as any).reason, /rounds-to-zero/);
});

// =============================================================================
// GATE 2 — no-cross vs the RESTING ask (the drain vector)
// =============================================================================

test("gate 2: crossesAsk uses a 200bps guard over the resting ask", () => {
  assert.equal(CROSS_GUARD_BPS, 200);
  // guard: bid must be <= ask * (1 - 0.02)
  assert.ok(!crossesAsk(0.97, 1.0), "0.97 <= 0.98 — safe");
  assert.ok(!crossesAsk(0.98, 1.0), "exactly at the guard — safe (<=)");
  assert.ok(crossesAsk(0.981, 1.0), "just inside the guard — CROSSED");
  assert.ok(crossesAsk(1.2, 1.0), "outright above the ask — CROSSED");
});

test("gate 2: guard covers a full round-trip at 50bps fee with room to spare", () => {
  // An arb pays fee on both legs: buy the ask, sell into the bid. 2 x 50 = 100bps.
  // The 200bps guard must strictly exceed that or the round-trip is profitable.
  const feeBpsRoundTrip = 2 * 50;
  assert.ok(CROSS_GUARD_BPS > feeBpsRoundTrip, "guard must beat the round-trip fee");
});

test("gate 2: STALE ASK — spot ran up, fresh mark would cross the stale ask → REFUSE", () => {
  // THE attack. Ask rests at 0.021 from an old mark. Spot doubled; mark is now
  // 0.030, so the naive bid is 0.030*(1-0.075) = 0.02775 > 0.021 — an arb buys
  // the stale ask and dumps into the bid. Must refuse and flag the ask.
  const d = decideBid(inp({ restingAskPrice: 0.021, mark: 0.03 }));
  assert.equal(d.action, "skip", "must not post a crossing bid");
  assert.match((d as any).reason, /would-cross/);
});

test("gate 2: an EXISTING bid that would now cross is PULLED, not left resting", () => {
  const d = decideBid(inp({
    restingAskPrice: 0.021,
    mark: 0.03,
    existingBid: { price: 0.0205, qty: 25, createdAtMs: 999_000 },
  }));
  assert.equal(d.action, "pull", "a crossing resting bid is live drain — pull it");
  assert.match((d as any).reason, /would-cross/);
});

test("gate 2: comparison is against the RESTING ask, never the fresh one", () => {
  // Same mark, same fresh-ask price implied — but the resting ask is stale-low.
  // Using the fresh ask (mark*1.05 = 1.05) would pass; using the resting one fails.
  const freshWouldPass = inp({ restingAskPrice: 1.05, mark: 1.0 });
  const restingFails = inp({ restingAskPrice: 0.93, mark: 1.0 });
  assert.equal(decideBid(freshWouldPass).action, "post");
  assert.equal(decideBid(restingFails).action, "skip");
  assert.match((decideBid(restingFails) as any).reason, /would-cross/);
});

// =============================================================================
// GATE 3 — dependent-quote invariant: no ask anchor ⇒ no bid
// =============================================================================

test("gate 3: ask PULLED → its bid is pulled in the same pass", () => {
  const d = decideBid(inp({
    askOutcome: "pulled",
    existingBid: { price: 0.9, qty: 25, createdAtMs: 999_000 },
  }));
  assert.equal(d.action, "pull");
  assert.match((d as any).reason, /no-ask-anchor/);
});

test("gate 3: no resting ask at all → never post a bid", () => {
  for (const over of [
    { askOutcome: "absent" as const, restingAskPrice: null },
    { restingAskPrice: null },
  ]) {
    const d = decideBid(inp(over));
    assert.equal(d.action, "skip", `no anchor => skip (${JSON.stringify(over)})`);
    assert.match((d as any).reason, /no-ask-anchor/);
  }
});

test("gate 3: a freshly posted/repriced ask DOES re-derive its bid", () => {
  for (const askOutcome of ["posted", "repriced", "held"] as const) {
    const d = decideBid(inp({ askOutcome }));
    assert.equal(d.action, "post", `${askOutcome} re-derives the bid`);
  }
});

// =============================================================================
// GATE 4 — budget: asks first, bids from the remainder, reserve floor
// =============================================================================

test("gate 4: bidBudgetRemaining subtracts the reserve and never goes negative", () => {
  assert.equal(bidBudgetRemaining(10_000, 5_000), 5_000);
  assert.equal(bidBudgetRemaining(5_000, 5_000), 0, "at the floor → nothing to bid");
  assert.equal(bidBudgetRemaining(1_000, 5_000), 0, "below the floor → clamped to 0");
});

test("gate 4: RESERVE FLOOR — free USDC at/below the reserve blocks every bid", () => {
  // Asks already consumed down to the floor; bids must not touch the reserve.
  const d = decideBid(inp({ freeUsdcAfterAsks: 5_000, policy: policy({ reserveUsdc: 5_000 }) }));
  assert.equal(d.action, "skip");
  assert.match((d as any).reason, /reserve|budget/);
});

test("gate 4: per-asset and global bid-notional caps both bind", () => {
  const perAsset = decideBid(inp({ assetBidNotional: 250, policy: policy({ maxNotionalPerAsset: 250 }) }));
  assert.equal(perAsset.action, "skip");
  assert.match((perAsset as any).reason, /asset-cap/);

  const global = decideBid(inp({ globalBidNotional: 2500, policy: policy({ maxNotionalGlobal: 2500 }) }));
  assert.equal(global.action, "skip");
  assert.match((global as any).reason, /global-cap/);
});

test("gate 4: the canary cell cap throttles new bids", () => {
  const d = decideBid(inp({ liveBidCells: 3, policy: policy({ maxCells: 3 }) }));
  assert.equal(d.action, "skip");
  assert.match((d as any).reason, /cell-cap/);
  // 0 = uncapped (mirrors OPTA_WRITER_MAX_CELLS semantics)
  assert.equal(decideBid(inp({ liveBidCells: 999, policy: policy({ maxCells: 0 }) })).action, "post");
});

test("gate 4: a reprice is budgeted on the DELTA, not the full notional", () => {
  // Existing bid worth ~24.4; near-identical new notional must not be refused
  // just because the gross would exceed the remaining headroom.
  const d = decideBid(inp({
    mark: 1.0,
    existingBid: { price: 0.80, qty: 25, createdAtMs: 0 },   // 1562bps drift → reprice
    assetBidNotional: 249,
    policy: policy({ maxNotionalPerAsset: 250 }),
  }));
  assert.equal(d.action, "reprice", "delta-budgeted reprice is allowed");
});

// =============================================================================
// GATE 5 — inventory cap (no net-off exists, so inventory must stay transient)
// =============================================================================

test("gate 5: at maxLongPerSeries the bid stops (and an existing one is pulled)", () => {
  const atCap = decideBid(inp({ heldLong: 10, policy: policy({ maxLongPerSeries: 10 }) }));
  assert.equal(atCap.action, "skip");
  assert.match((atCap as any).reason, /inventory-cap/);

  const withBid = decideBid(inp({
    heldLong: 10,
    policy: policy({ maxLongPerSeries: 10 }),
    existingBid: { price: 0.9, qty: 25, createdAtMs: 999_000 },
  }));
  assert.equal(withBid.action, "pull");
  assert.match((withBid as any).reason, /inventory-cap/);
});

test("gate 5: bid depth is clipped so a full fill cannot breach the cap", () => {
  // held 8, cap 10 → at most 2 more contracts may be bought.
  const d = decideBid(inp({ heldLong: 8, policy: policy({ maxLongPerSeries: 10 }), askQty: 100 }));
  assert.equal(d.action, "post");
  assert.ok((d as any).qty <= 2, `depth clipped to remaining headroom, got ${(d as any).qty}`);
});

// =============================================================================
// GATE 6 — market-closed / oracle-stale / quote-fail pull (threshold 1)
// =============================================================================

test("gate 6: oracle not ready → pull an existing bid, skip a new one", () => {
  assert.equal(decideBid(inp({ oracleReady: false })).action, "skip");
  const pulled = decideBid(inp({
    oracleReady: false, existingBid: { price: 0.9, qty: 25, createdAtMs: 999_000 },
  }));
  assert.equal(pulled.action, "pull");
  assert.match((pulled as any).reason, /oracle/);
});

test("gate 6: equity market closed → pull an existing bid, skip a new one", () => {
  assert.equal(decideBid(inp({ marketOpen: false })).action, "skip");
  const pulled = decideBid(inp({
    marketOpen: false, existingBid: { price: 0.9, qty: 25, createdAtMs: 999_000 },
  }));
  assert.equal(pulled.action, "pull");
  assert.match((pulled as any).reason, /market-closed/);
});

test("gate 6: quote-fail threshold for BIDS is 1, tighter than the ask's 2", () => {
  // A resting bid is the classic pick-off target on a gap — pull on the FIRST
  // failure rather than the second.
  const pulled = decideBid(inp({
    quoteFails: 1, existingBid: { price: 0.9, qty: 25, createdAtMs: 999_000 },
  }));
  assert.equal(pulled.action, "pull");
  assert.match((pulled as any).reason, /quote-fail/);
  assert.equal(decideBid(inp({ quoteFails: 1 })).action, "skip");
});

// =============================================================================
// GATE 7 — flag off ⇒ the module emits no action at all
// =============================================================================

test("gate 7: disabled → skip everywhere, even with an existing bid resting", () => {
  const off = policy({ enabled: false });
  assert.equal(decideBid(inp({ policy: off })).action, "skip");
  const withBid = decideBid(inp({
    policy: off, existingBid: { price: 0.9, qty: 25, createdAtMs: 999_000 },
  }));
  assert.equal(withBid.action, "skip", "disabled must not even pull — it is inert");
  assert.match((withBid as any).reason, /disabled/);
});

test("gate 7: disabled wins over every other condition (checked first)", () => {
  const d = decideBid(inp({
    policy: policy({ enabled: false }),
    oracleReady: false, marketOpen: false, askOutcome: "pulled",
    restingAskPrice: null, heldLong: 999,
  }));
  assert.equal(d.action, "skip");
  assert.match((d as any).reason, /disabled/);
});

// =============================================================================
// GATE 8 — relist: filled bid → ResaleAsk, inventory decremented
// =============================================================================

test("gate 8: held inventory not yet listed → relist the unlisted remainder", () => {
  const r = decideRelist({ enabled: true, heldLong: 7, alreadyListed: 0, askPrice: 1.05 });
  assert.equal(r.action, "relist");
  assert.equal((r as any).qty, 7, "relist everything unlisted");
  assert.equal((r as any).price, 1.05, "relist at the current ask price");
});

test("gate 8: partially listed → relist only the difference (no double-listing)", () => {
  const r = decideRelist({ enabled: true, heldLong: 7, alreadyListed: 5, askPrice: 1.05 });
  assert.equal(r.action, "relist");
  assert.equal((r as any).qty, 2, "7 held − 5 listed = 2");
});

test("gate 8: fully listed or empty → nothing to do (inventory decremented to 0)", () => {
  assert.equal(decideRelist({ enabled: true, heldLong: 5, alreadyListed: 5, askPrice: 1.05 }).action, "none");
  assert.equal(decideRelist({ enabled: true, heldLong: 0, alreadyListed: 0, askPrice: 1.05 }).action, "none");
  // Over-listed (a fill landed mid-tick) must clamp, never go negative.
  assert.equal(decideRelist({ enabled: true, heldLong: 3, alreadyListed: 5, askPrice: 1.05 }).action, "none");
});

test("gate 8: relist is inert when disabled, and refuses a non-positive ask price", () => {
  assert.equal(decideRelist({ enabled: false, heldLong: 7, alreadyListed: 0, askPrice: 1.05 }).action, "none");
  assert.equal(decideRelist({ enabled: true, heldLong: 7, alreadyListed: 0, askPrice: 0 }).action, "none");
});

// =============================================================================
// sizing (shared by gates 4/5)
// =============================================================================

test("sizing: depth = max(1, round(askQty x depthFrac))", () => {
  assert.equal(bidDepth(100, 0.25), 25);
  assert.equal(bidDepth(10, 0.25), 3, "round-half-up: 2.5 → 3");
  assert.equal(bidDepth(1, 0.25), 1, "floor of 1 contract");
  assert.equal(bidDepth(0, 0.25), 1, "degenerate ask qty still yields >= 1");
});

// =============================================================================
// GATE 9 — ATM band is a CODE bound: wings never quote, whatever the caps say
// =============================================================================

test("gate 9: withinAtmBand — 0 admits only ATM, 1 admits the first wings", () => {
  assert.ok(withinAtmBand(0, 0), "ATM always in band");
  assert.ok(!withinAtmBand(1, 0), "first wing out at rungs=0");
  assert.ok(!withinAtmBand(2, 0));
  assert.ok(withinAtmBand(1, 1), "first wing in at rungs=1");
  assert.ok(!withinAtmBand(2, 1), "second wing still out at rungs=1");
});

test("gate 9: WING CELLS PRODUCE ZERO BID INTENT even with every cap wide open", () => {
  // The whole point: caps decide how much is quoted INSIDE the band, never where
  // the band is. Blow every throttle wide and the wings must still be silent.
  const wideOpen = policy({
    atmRungs: 0,
    maxNotionalPerAsset: 1e12,
    maxNotionalGlobal: 1e12,
    reserveUsdc: 0,
    maxCells: 0,               // uncapped
    maxLongPerSeries: 1e9,
    depthFrac: 1,
  });
  for (const rungIndex of [1, 2, 3]) {
    const d = decideBid(inp({ policy: wideOpen, rungIndex, freeUsdcAfterAsks: 1e12 }));
    assert.equal(d.action, "skip", `rung ${rungIndex} must not quote`);
    assert.match((d as any).reason, /out-of-atm-band/);
  }
  // ATM under the same wide-open caps DOES quote — proving the caps really were
  // open and the refusal above came from the band, not from a throttle.
  const atm = decideBid(inp({ policy: wideOpen, rungIndex: 0, freeUsdcAfterAsks: 1e12 }));
  assert.equal(atm.action, "post", "ATM still quotes with caps wide open");

  // A resting bid on a now-out-of-band wing is PULLED (unlike the inert flag):
  // a narrower band means those bids are no longer wanted.
  const pulled = decideBid(inp({
    policy: wideOpen, rungIndex: 2,
    existingBid: { price: 0.9, qty: 25, createdAtMs: 999_000 },
  }));
  assert.equal(pulled.action, "pull");
  assert.match((pulled as any).reason, /out-of-atm-band/);
});
