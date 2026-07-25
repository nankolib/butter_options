// Quest engine: chain sequencing, period boundaries, internal exclusion.
// run: npx ts-node --transpile-only src/score/quests/evaluator.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import type { EventRow } from "../../db";
import { computeMultipliers } from "../multiplier";
import { DEFAULT_QUESTS, evaluate, isoWeek } from "./evaluator";
import { isInternal } from "../../registry";

const A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const VAULT = "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";
const CRANK = "5sHZETYzbbdBQnFLmDCG3gyCikew39pL8kAE5xroGfqa";
const DAY = 86_400;
const D0 = Date.parse("2026-06-01T12:00:00Z") / 1000;
const USDC = 1_000_000;

let n = 0;
const evt = (over: Partial<EventRow>): EventRow => ({
  id: `S${++n}:0`, sig: `S${n}`, ordinal: 0, ix_index: null, source: "log",
  name: "OrderFilled", wallet: null, counterparty: null, vault: VAULT,
  option_mint: null, kind: 2, amount_usdc: 0, quantity: 1,
  fields_json: "{}", block_time: D0, ...over,
});

function run(tape: EventRow[], faucetClaims: { wallet: string; block_time: number | null }[] = [], underlying = new Map()) {
  const asOf = D0 + 30 * DAY;
  return evaluate({
    tape: () => tape,
    faucetClaims,
    underlyingOf: underlying,
    multipliers: computeMultipliers(() => tape, asOf),
    cfg: DEFAULT_QUESTS,
    asOf,
  });
}

const has = (r: ReturnType<typeof run>, wallet: string, id: string) =>
  r.completions.some((c) => c.wallet === wallet && c.questId === id);

test("D12 STRICT SEQUENCING: an out-of-order action does not retroactively count", () => {
  // Wallet mints (O2) BEFORE its first fill (O1). Strict order means O2 needs a
  // mint at-or-after O1, and there is none, so the chain stops at O1.
  const r = run([
    evt({ name: "VaultMinted", wallet: A, block_time: D0 }),
    evt({ name: "OrderFilled", wallet: A, block_time: D0 + DAY }),
  ]);
  assert.equal(has(r, A, "O1"), true);
  assert.equal(has(r, A, "O2"), false, "the earlier mint must NOT satisfy O2");
  assert.equal(r.funnel.get(A), 1);
});

test("in-order chain completes and pays the completion bonus", () => {
  const r = run([
    evt({ name: "OrderFilled", wallet: A, block_time: D0 + 1 * DAY }),
    evt({ name: "VaultMinted", wallet: A, block_time: D0 + 2 * DAY }),
    evt({ name: "OrderFilled", wallet: B, counterparty: A, kind: 2, block_time: D0 + 3 * DAY }),
    evt({ name: "VaultExercised", wallet: A, block_time: D0 + 4 * DAY }),
    evt({ name: "TriggerPlaced", wallet: A, block_time: D0 + 5 * DAY }),
    evt({ name: "OrderFilled", wallet: A, kind: 2, quantity: 5, block_time: D0 + 6 * DAY }),
    evt({ name: "VaultSettled", wallet: null, block_time: D0 + 7 * DAY }),
    evt({ name: "IxSettleExpiry", source: "ix", wallet: A, block_time: D0 + 8 * DAY }),
  ]);
  assert.equal(r.funnel.get(A), 7);
  assert.equal(has(r, A, "OC"), true, "chain-complete bonus");
});

test("O5 bonus only pays when the trigger actually fires afterwards", () => {
  const base = [
    evt({ name: "OrderFilled", wallet: A, block_time: D0 + 1 * DAY }),
    evt({ name: "VaultMinted", wallet: A, block_time: D0 + 2 * DAY }),
    evt({ name: "OrderFilled", wallet: B, counterparty: A, kind: 2, block_time: D0 + 3 * DAY }),
    evt({ name: "VaultExercised", wallet: A, block_time: D0 + 4 * DAY }),
    evt({ name: "TriggerPlaced", wallet: A, block_time: D0 + 5 * DAY }),
  ];
  assert.equal(has(run(base), A, "O5b"), false);
  assert.equal(has(run([...base, evt({ name: "TriggerExecuted", wallet: A, block_time: D0 + 6 * DAY })]), A, "O5b"), true);
});

test("crank-gas is INTERNAL and must be excluded from boards — it cannot farm W2", () => {
  const settles = Array.from({ length: 20 }, (_, i) =>
    evt({ name: "IxSettleExpiry", source: "ix", wallet: CRANK, block_time: D0 + i * DAY }),
  );
  const r = run(settles);
  // The evaluator computes it (for sanity), but the registry marks it internal
  // and every board filters on that.
  assert.equal(isInternal(CRANK), true, "crank-gas MUST be in the internal registry");
  const w2 = r.completions.filter((c) => c.wallet === CRANK && c.questId === "W2");
  assert.ok(w2.length > 0, "computed…");
  for (const c of w2) assert.ok(c.points <= 60 * 3, "…but capped at 3/week regardless");
});

test("W2 is capped at 3 per ISO week", () => {
  const settles = Array.from({ length: 6 }, (_, i) =>
    evt({ name: "IxSettleExpiry", source: "ix", wallet: A, block_time: D0 + i * 3600 }),
  );
  const r = run(settles);
  const w2 = r.completions.filter((c) => c.questId === "W2" && c.wallet === A);
  assert.equal(w2.length, 1, "one row per week");
  assert.equal(w2[0].points, 180, "60 x 3, not 60 x 6");
});

test("period boundaries: daily rolls at UTC midnight, weekly on ISO weeks", () => {
  const beforeMidnight = Date.parse("2026-06-04T23:59:00Z") / 1000;
  const afterMidnight = Date.parse("2026-06-05T00:01:00Z") / 1000;
  const r = run([
    evt({ name: "OrderFilled", wallet: A, amount_usdc: 150 * USDC, block_time: beforeMidnight }),
    evt({ name: "OrderFilled", wallet: A, amount_usdc: 150 * USDC, block_time: afterMidnight }),
  ]);
  const d1 = r.completions.filter((c) => c.questId === "D1" && c.wallet === A);
  assert.equal(d1.length, 2, "two separate UTC days");
  assert.deepEqual(d1.map((c) => c.periodKey).sort(), ["2026-06-04", "2026-06-05"]);

  // ISO week boundary: Sunday and the following Monday are different weeks.
  assert.notEqual(isoWeek(Date.parse("2026-06-07T12:00:00Z") / 1000), isoWeek(Date.parse("2026-06-08T12:00:00Z") / 1000));
  assert.equal(isoWeek(Date.parse("2026-06-01T00:00:00Z") / 1000), isoWeek(Date.parse("2026-06-07T23:59:00Z") / 1000));
});

test("D1 requires >= $100 taker premium in one UTC day, aggregated", () => {
  const day = D0;
  const under = run([evt({ name: "OrderFilled", wallet: A, amount_usdc: 60 * USDC, block_time: day })]);
  assert.equal(has(under, A, "D1"), false);
  const over = run([
    evt({ name: "OrderFilled", wallet: A, amount_usdc: 60 * USDC, block_time: day }),
    evt({ name: "OrderFilled", wallet: A, amount_usdc: 50 * USDC, block_time: day + 60 }),
  ]);
  assert.equal(has(over, A, "D1"), true, "two fills aggregate to $110");
});

test("D2 needs BOTH sides on the same day, maker side kind != 3", () => {
  const pegOnly = run([
    evt({ name: "OrderFilled", wallet: A, block_time: D0 }),
    evt({ name: "OrderFilled", wallet: B, counterparty: A, kind: 3, block_time: D0 }),
  ]);
  assert.equal(has(pegOnly, A, "D2"), false, "a peg fill is not a maker action");

  const real = run([
    evt({ name: "OrderFilled", wallet: A, block_time: D0 }),
    evt({ name: "OrderFilled", wallet: B, counterparty: A, kind: 2, block_time: D0 }),
  ]);
  assert.equal(has(real, A, "D2"), true);
});

test("W3 needs 3 distinct underlyings; span bonus merges Equity+ETF (D10)", () => {
  const und = new Map([
    ["M1", { assetName: "BTC", bucket: "crypto" }],
    ["M2", { assetName: "AAPL", bucket: "equity" }],
    ["M3", { assetName: "SPY", bucket: "equity" }], // ETF collapsed into 'equity'
    ["M4", { assetName: "XAU", bucket: "commodity" }],
  ]);
  const three = run(
    [
      evt({ name: "OrderFilled", wallet: A, option_mint: "M1", block_time: D0 }),
      evt({ name: "OrderFilled", wallet: A, option_mint: "M2", block_time: D0 }),
      evt({ name: "OrderFilled", wallet: A, option_mint: "M3", block_time: D0 }),
    ],
    [],
    und,
  );
  assert.equal(has(three, A, "W3"), true, "3 distinct names");
  assert.equal(has(three, A, "W3b"), false, "only crypto+equity — no commodity");

  const span = run(
    [
      evt({ name: "OrderFilled", wallet: A, option_mint: "M1", block_time: D0 }),
      evt({ name: "OrderFilled", wallet: A, option_mint: "M3", block_time: D0 }),
      evt({ name: "OrderFilled", wallet: A, option_mint: "M4", block_time: D0 }),
    ],
    [],
    und,
  );
  assert.equal(has(span, A, "W3b"), true, "SPY (ETF) satisfies the equity bucket");
});

test("D3 fires per faucet-claim day", () => {
  const r = run([evt({ name: "OrderFilled", wallet: A })], [
    { wallet: A, block_time: D0 },
    { wallet: A, block_time: D0 + DAY },
  ]);
  assert.equal(r.completions.filter((c) => c.questId === "D3" && c.wallet === A).length, 2);
});

test("evaluator output is deterministic and stably sorted", () => {
  const tape = [
    evt({ name: "OrderFilled", wallet: A, amount_usdc: 200 * USDC, block_time: D0 }),
    evt({ name: "OrderFilled", wallet: B, counterparty: A, kind: 2, block_time: D0 }),
  ];
  assert.equal(JSON.stringify(run(tape)), JSON.stringify(run(tape)));
});
