// Scoring rules proof. run: npx ts-node --transpile-only src/score/rules_v1.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import type { EventRow } from "../db";
import { DEFAULT_RULES, score } from "./rules_v1";

const A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const C = "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC";
const VAULT = "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";
const MINT = "MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM";
const DAY = 86_400;

let n = 0;
function evt(over: Partial<EventRow>): EventRow {
  n += 1;
  return {
    id: `SIG${n}:0`,
    sig: `SIG${n}`,
    ordinal: 0,
    ix_index: null,
    source: "log",
    name: "OrderFilled",
    wallet: null,
    counterparty: null,
    vault: null,
    option_mint: null,
    kind: null,
    amount_usdc: null,
    quantity: null,
    fields_json: "{}",
    block_time: DAY * 100,
    ...over,
  };
}

const pts = (r: ReturnType<typeof score>, w: string) => r.scores.find((s) => s.wallet === w)?.pointsCapped ?? 0;

test("taker 1pt/$1, maker 0.5pt/$1", () => {
  const r = score(
    [evt({ name: "OrderFilled", wallet: A, counterparty: B, kind: 2, amount_usdc: 10_000_000, quantity: 2, vault: VAULT })],
    DEFAULT_RULES,
    0,
  );
  assert.equal(pts(r, A), 10);
  assert.equal(pts(r, B), 5);
});

test("D3 HARD RULE — kind==3 (VaultPeg) gives the PDA maker ZERO", () => {
  const r = score(
    [evt({ name: "OrderFilled", wallet: A, counterparty: VAULT, kind: 3, amount_usdc: 40_000_000, quantity: 1, vault: VAULT })],
    DEFAULT_RULES,
    0,
  );
  assert.equal(pts(r, A), 40, "taker still scores");
  assert.equal(pts(r, VAULT), 0, "vault PDA must never appear");
  assert.equal(r.scores.some((s) => s.wallet === VAULT), false);
  assert.equal(r.diagnostics.pegMakerCreditsSkipped, 1);
});

test("kind==2 (WriterAsk) maker IS a wallet and DOES score", () => {
  const r = score(
    [evt({ name: "OrderFilled", wallet: A, counterparty: B, kind: 2, amount_usdc: 20_000_000, quantity: 1, vault: VAULT })],
    DEFAULT_RULES,
    0,
  );
  assert.equal(pts(r, B), 10);
  assert.equal(r.diagnostics.pegMakerCreditsSkipped, 0);
});

test("self-trade (maker == taker) scores zero on BOTH sides", () => {
  const r = score(
    [evt({ name: "OrderFilled", wallet: A, counterparty: A, kind: 1, amount_usdc: 99_000_000, quantity: 5, vault: VAULT })],
    DEFAULT_RULES,
    0,
  );
  assert.equal(pts(r, A), 0);
  assert.equal(r.diagnostics.selfTradesZeroed, 1);
});

test("exercise +25, trigger +15, settle_expiry +50", () => {
  const r = score(
    [
      evt({ name: "VaultExercised", wallet: A, vault: VAULT, quantity: 1 }),
      evt({ name: "TriggerExecuted", wallet: A }),
      evt({ name: "IxSettleExpiry", source: "ix", wallet: A }),
    ],
    DEFAULT_RULES,
    0,
  );
  assert.equal(pts(r, A), 90);
});

test("create_market diminishes 100 / 50 / 33.3333, floored at 5", () => {
  const many = Array.from({ length: 30 }, () => evt({ name: "IxCreateMarket", source: "ix", wallet: A }));
  const r = score(many.slice(0, 3), DEFAULT_RULES, 0);
  // pointsCapped is rounded to 4dp by design (round4), so compare against that.
  assert.equal(pts(r, A), Math.round((100 + 50 + 100 / 3) * 1e4) / 1e4);
  assert.equal(pts(r, A), 183.3333);

  const r30 = score(many, DEFAULT_RULES, 0);
  const b = r30.scores.find((s) => s.wallet === A)!.breakdown.create_market;
  assert.ok(b > 0);
  // the 21st market onward is floored at 5 (100/21 < 5)
  assert.equal(Math.max(DEFAULT_RULES.createMarketFirstPts / 21, 5), 5);
});

test("held-to-settle: net-long at VaultSettled earns +10, flat holder does not", () => {
  const r = score(
    [
      // A buys 5 and holds
      evt({ name: "OrderFilled", wallet: A, counterparty: B, kind: 2, amount_usdc: 0, quantity: 5, vault: VAULT }),
      // C buys 3 then sells all 3 back into a resting Bid (kind 0 = C is selling)
      evt({ name: "OrderFilled", wallet: C, counterparty: B, kind: 2, amount_usdc: 0, quantity: 3, vault: VAULT }),
      evt({ name: "OrderFilled", wallet: C, counterparty: B, kind: 0, amount_usdc: 0, quantity: 3, vault: VAULT }),
      evt({ name: "VaultSettled", wallet: null, vault: VAULT }),
    ],
    DEFAULT_RULES,
    0,
  );
  assert.equal(r.scores.find((s) => s.wallet === A)!.breakdown.held_to_settle, 10);
  assert.equal(r.scores.find((s) => s.wallet === C)?.breakdown.held_to_settle, undefined);
  // B bought 3 off C via the Bid fill, so B is net-long too
  assert.equal(r.scores.find((s) => s.wallet === B)!.breakdown.held_to_settle, 10);
});

test("held-to-settle resolves mint -> vault for VaultListingFilled (no vault field)", () => {
  const r = score(
    [
      evt({ name: "VaultListingCreated", wallet: B, vault: VAULT, option_mint: MINT, quantity: 4 }),
      evt({ name: "VaultListingFilled", wallet: A, counterparty: B, option_mint: MINT, quantity: 4 }),
      evt({ name: "VaultSettled", wallet: null, vault: VAULT }),
    ],
    DEFAULT_RULES,
    0,
  );
  assert.equal(r.scores.find((s) => s.wallet === A)!.breakdown.held_to_settle, 10);
});

test("D4 diagnostic: a wallet going net-negative is counted as invisible inflow", () => {
  const r = score(
    [
      evt({ name: "VaultExercised", wallet: A, vault: VAULT, quantity: 9 }), // never acquired on-tape
      evt({ name: "VaultSettled", wallet: null, vault: VAULT }),
    ],
    DEFAULT_RULES,
    0,
  );
  assert.equal(r.diagnostics.negativePositions, 1);
});

test("daily soft cap: full rate to 500/day, x0.1 beyond, resets next UTC day", () => {
  const big = (ts: number) =>
    evt({ name: "OrderFilled", wallet: A, counterparty: B, kind: 2, amount_usdc: 800_000_000, quantity: 1, block_time: ts });
  const r = score([big(DAY * 100)], DEFAULT_RULES, 0);
  // 800 raw -> 500 full + 300 x 0.1 = 530
  assert.equal(pts(r, A), 530);

  const r2 = score([big(DAY * 100), big(DAY * 101)], DEFAULT_RULES, 0);
  assert.equal(pts(r2, A), 1060, "cap resets on the next UTC day");
  assert.equal(r2.scores.find((s) => s.wallet === A)!.points, 1600, "raw points are uncapped");
});

test("ranking is a total order: capped DESC then wallet ASC", () => {
  const tie = (w: string) => evt({ name: "VaultExercised", wallet: w, vault: VAULT, quantity: 1 });
  const r = score([tie(C), tie(A), tie(B)], DEFAULT_RULES, 0);
  assert.deepEqual(
    r.scores.map((s) => s.wallet),
    [A, B, C],
  );
});

test("empty tape yields an empty, well-formed result", () => {
  const r = score([], DEFAULT_RULES, 123);
  assert.deepEqual(r.scores, []);
  assert.equal(r.asOf, 123);
  assert.equal(r.rulesVersion, "v1");
});
