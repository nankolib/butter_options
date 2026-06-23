// ============================================================================
// crank/triggerCrank.test.ts — unit tests for the PURE trigger decision logic
// ============================================================================
// Vanilla TS + node:assert (no framework), same shape as volOracleCrank.test.ts.
// Covers evaluateTrigger across every branch + the batched-feed dedupe/query.
// No RPC: the impure reads (Hermes batch, get_option_price sim) are mocked into
// the pure fn's params, exactly as the tick feeds them.
// ============================================================================

import assert from "node:assert/strict";

import {
  evaluateTrigger,
  spotToUsdc6,
  applySpreadFloor,
  uniqueFeedHexes,
  buildHermesMultiUrl,
  DEFAULT_FIRE_MARGIN_BPS,
  type TriggerView,
} from "./triggerCrank";

// ---- Tiny runner -----------------------------------------------------------
type Test = { name: string; fn: () => void | Promise<void> };
const tests: Test[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

// ---- Fixtures --------------------------------------------------------------
const usd = (n: number) => BigInt(Math.round(n * 1_000_000)); // USDC 6-dec
const NOW = 1_800_000_000;
const FRESH = NOW - 10; // within 120s
const STALE = NOW - 600; // older than 120s

function mkView(over: Partial<TriggerView> = {}): TriggerView {
  return {
    pubkey: "Trig111", owner: "Own111", market: "Mkt111", vault: "Vlt111",
    optionMint: "Mnt111", holderOptionAta: "Ata111",
    kind: "buy", comparator: "ge", thresholdUsdc: usd(100),
    quantity: 3n, maxPremiumPerContract: usd(5),
    ...over,
  };
}
const baseOpts = { nowSec: NOW, maxStaleSecs: 120, fireMarginBps: DEFAULT_FIRE_MARGIN_BPS };
const spot = (price: number, publishTime = FRESH) => ({ priceFloat: price, publishTime });

// DEFAULT_FIRE_MARGIN_BPS = 50 → margin on $100 threshold = $0.50 →
// GE fires ≥ $100.50, LE fires ≤ $99.50 (boundary cases below track the default)

// ---- conversions -----------------------------------------------------------
test("spotToUsdc6: float USD → USDC 6-dec, rounded", () => {
  assert.equal(spotToUsdc6(100.3), 100_300_000n);
  assert.equal(spotToUsdc6(99.7), 99_700_000n);
  assert.equal(spotToUsdc6(1.234567), 1_234_567n);
});

test("applySpreadFloor: mirrors fill_vault_peg apply_spread (floored)", () => {
  assert.equal(applySpreadFloor(1_000_000n, 0), 1_000_000n);
  assert.equal(applySpreadFloor(1_000_000n, 500), 1_050_000n); // +5%
  assert.equal(applySpreadFloor(999n, 1), 999n); // floor
});

// ---- stale / missing feed --------------------------------------------------
test("missing feed → stale_feed (never Eligible)", () => {
  const d = evaluateTrigger(mkView(), { ...baseOpts, spot: undefined });
  assert.deepEqual(d, { eligible: false, reason: "stale_feed" });
});
test("stale feed (publishTime too old) → stale_feed", () => {
  const d = evaluateTrigger(mkView(), { ...baseOpts, spot: spot(100.5, STALE), pegPremiumTotalUsdc: usd(1) });
  assert.deepEqual(d, { eligible: false, reason: "stale_feed" });
});

// ---- GreaterOrEqual --------------------------------------------------------
test("GE: spot below threshold → condition_not_met", () => {
  const d = evaluateTrigger(mkView({ comparator: "ge" }), { ...baseOpts, spot: spot(99.9), pegPremiumTotalUsdc: usd(1) });
  assert.deepEqual(d, { eligible: false, reason: "condition_not_met" });
});
test("GE: spot past threshold but INSIDE margin → within_margin", () => {
  // $100.40 ≥ $100 but < $100.50 (50bps band)
  const d = evaluateTrigger(mkView({ comparator: "ge" }), { ...baseOpts, spot: spot(100.4), pegPremiumTotalUsdc: usd(1) });
  assert.deepEqual(d, { eligible: false, reason: "within_margin" });
});
test("GE: spot beyond margin + within budget → Eligible", () => {
  // $100.60 ≥ $100.50 (clears the 50bps margin)
  const d = evaluateTrigger(mkView({ comparator: "ge" }), { ...baseOpts, spot: spot(100.6), pegPremiumTotalUsdc: usd(12) });
  assert.deepEqual(d, { eligible: true });
});

// ---- LessOrEqual -----------------------------------------------------------
test("LE: spot above threshold → condition_not_met", () => {
  const d = evaluateTrigger(mkView({ kind: "sell", comparator: "le", maxPremiumPerContract: 0n }), { ...baseOpts, spot: spot(100.1) });
  assert.deepEqual(d, { eligible: false, reason: "condition_not_met" });
});
test("LE: spot past threshold but INSIDE margin → within_margin", () => {
  // $99.60 ≤ $100 but > $99.50 (50bps band)
  const d = evaluateTrigger(mkView({ kind: "sell", comparator: "le", maxPremiumPerContract: 0n }), { ...baseOpts, spot: spot(99.6) });
  assert.deepEqual(d, { eligible: false, reason: "within_margin" });
});
test("LE: spot beyond margin (sell, no budget) → Eligible", () => {
  // $99.40 ≤ $99.50 (clears the 50bps margin)
  const d = evaluateTrigger(mkView({ kind: "sell", comparator: "le", maxPremiumPerContract: 0n }), { ...baseOpts, spot: spot(99.4) });
  assert.deepEqual(d, { eligible: true });
});

// ---- BUY budget ------------------------------------------------------------
test("BUY: condition met but quote missing → quote_unavailable (still-live signal)", () => {
  const d = evaluateTrigger(mkView({ kind: "buy" }), { ...baseOpts, spot: spot(100.6), pegPremiumTotalUsdc: undefined });
  assert.deepEqual(d, { eligible: false, reason: "quote_unavailable" });
});
test("BUY: premium over budget → over_budget (order stays live, no send)", () => {
  // budget = $5 × 3 = $15; premium $20 > budget
  const d = evaluateTrigger(mkView({ kind: "buy" }), { ...baseOpts, spot: spot(100.6), pegPremiumTotalUsdc: usd(20) });
  assert.deepEqual(d, { eligible: false, reason: "over_budget" });
});
test("BUY: premium within budget → Eligible", () => {
  const d = evaluateTrigger(mkView({ kind: "buy" }), { ...baseOpts, spot: spot(100.6), pegPremiumTotalUsdc: usd(15) });
  assert.deepEqual(d, { eligible: true }); // exactly at budget passes (<=)
});

// ---- SELL OTM pre-skip -----------------------------------------------------
test("SELL CALL OTM (condition met, spot ≤ strike) → otm", () => {
  // threshold $90 (condition met at $95), strike $100 → 95 < 100 = OTM call
  const v = mkView({ kind: "sell", comparator: "ge", thresholdUsdc: usd(90), maxPremiumPerContract: 0n });
  const d = evaluateTrigger(v, { ...baseOpts, spot: spot(95), strikeUsdc: usd(100), isCall: true });
  assert.deepEqual(d, { eligible: false, reason: "otm" });
});
test("SELL CALL ITM (spot > strike) → Eligible", () => {
  const v = mkView({ kind: "sell", comparator: "ge", thresholdUsdc: usd(100), maxPremiumPerContract: 0n });
  const d = evaluateTrigger(v, { ...baseOpts, spot: spot(120), strikeUsdc: usd(100), isCall: true });
  assert.deepEqual(d, { eligible: true });
});
test("SELL PUT ITM (spot < strike) → Eligible", () => {
  const v = mkView({ kind: "sell", comparator: "le", thresholdUsdc: usd(100), maxPremiumPerContract: 0n });
  const d = evaluateTrigger(v, { ...baseOpts, spot: spot(80), strikeUsdc: usd(100), isCall: false });
  assert.deepEqual(d, { eligible: true });
});

// ---- dedupe + batched query ------------------------------------------------
test("dedupe: 5 orders across 3 unique feeds → exactly 3 ids in the batched query", () => {
  const marketFeed = new Map<string, string>([
    ["mA", "aa".repeat(32)], ["mB", "bb".repeat(32)], ["mC", "cc".repeat(32)],
  ]);
  const orders = [{ market: "mA" }, { market: "mA" }, { market: "mB" }, { market: "mC" }, { market: "mB" }];
  const feeds = uniqueFeedHexes(orders, marketFeed);
  assert.equal(feeds.length, 3, "3 unique feeds");
  const url = buildHermesMultiUrl("https://hermes.test", feeds);
  const idCount = (url.match(/ids\[\]=/g) ?? []).length;
  assert.equal(idCount, 3, "exactly 3 ids[] in the single batched URL");
  assert.ok(url.includes("encoding=base64"), "base64 encoding requested");
});
test("dedupe: order whose market has no feed is excluded from the batch", () => {
  const marketFeed = new Map<string, string>([["mA", "aa".repeat(32)]]);
  const feeds = uniqueFeedHexes([{ market: "mA" }, { market: "mUNKNOWN" }], marketFeed);
  assert.equal(feeds.length, 1, "unknown-feed order contributes no id");
});

// ---- Runner ----------------------------------------------------------------
async function main(): Promise<void> {
  let passed = 0, failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
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
main().catch((err) => { console.error("test runner crashed:", err); process.exit(1); });
