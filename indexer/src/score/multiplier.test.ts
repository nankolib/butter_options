// Consistency multiplier: streaks, shields, boundaries.
// run: npx ts-node --transpile-only src/score/multiplier.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import type { EventRow } from "../db";
import { computeMultipliers, multiplierFor, MULTIPLIER_CAP, activeDays } from "./multiplier";

const A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const VAULT = "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";
const DAY = 86_400;
const D0 = Date.parse("2026-06-01T12:00:00Z") / 1000;

let n = 0;
const evt = (over: Partial<EventRow>): EventRow => ({
  id: `S${++n}:0`, sig: `S${n}`, ordinal: 0, ix_index: null, source: "log",
  name: "OrderFilled", wallet: null, counterparty: null, vault: VAULT,
  option_mint: null, kind: 2, amount_usdc: 0, quantity: 1,
  fields_json: "{}", block_time: D0, ...over,
});

const fillsOn = (wallet: string, dayOffsets: number[]) =>
  dayOffsets.map((d) => evt({ wallet, block_time: D0 + d * DAY }));

test("multiplier grows 0.1 per consecutive day and caps at 2.0", () => {
  const tape = fillsOn(A, [0, 1, 2]);
  const r = computeMultipliers(() => tape, D0 + 2 * DAY);
  assert.equal(r.state.get(A)!.currentStreak, 3);
  assert.equal(r.state.get(A)!.multiplier, 1.3);

  const long = fillsOn(A, Array.from({ length: 30 }, (_, i) => i));
  const r2 = computeMultipliers(() => long, D0 + 29 * DAY);
  assert.equal(r2.state.get(A)!.multiplier, MULTIPLIER_CAP);
});

test("a missed day with no shield resets to 1.0", () => {
  // active days 0,1 then a gap at 2, active again at 3
  const tape = fillsOn(A, [0, 1, 3]);
  const r = computeMultipliers(() => tape, D0 + 3 * DAY);
  assert.equal(r.state.get(A)!.currentStreak, 1);
  assert.equal(r.state.get(A)!.multiplier, 1.1);
  assert.equal(r.state.get(A)!.longestStreak, 2);
  assert.equal(multiplierFor(r, A, "2026-06-03"), 1, "the missed day itself is 1.0");
});

test("a 7-day streak banks a shield, and the shield absorbs the next miss", () => {
  // 7 consecutive active days (0..6), miss day 7, active day 8
  const tape = fillsOn(A, [0, 1, 2, 3, 4, 5, 6, 8]);
  const r = computeMultipliers(() => tape, D0 + 8 * DAY);
  const st = r.state.get(A)!;
  assert.equal(st.shieldsConsumed, 1, "the miss consumed the banked shield");
  assert.equal(st.shieldsBanked, 0);
  assert.equal(st.currentStreak, 8, "streak SURVIVES the shielded miss");
  assert.ok(r.shieldEvents.some((e) => e.action === "earned"));
  assert.ok(r.shieldEvents.some((e) => e.action === "consumed"));
});

test("shield bank is capped at 2", () => {
  const tape = fillsOn(A, Array.from({ length: 28 }, (_, i) => i));
  const r = computeMultipliers(() => tape, D0 + 27 * DAY);
  assert.equal(r.state.get(A)!.shieldsBanked, 2, "4 completed weeks, bank capped at 2");
});

test("faucet claims are NOT activity — only the listed events count", () => {
  const days = activeDays(() => [
    evt({ name: "VaultDeposited", wallet: A }), // not an activity event
    evt({ name: "OrderPosted", wallet: A }), // posting is not filling
  ]);
  assert.equal(days.has(A), false);

  const days2 = activeDays(() => [evt({ name: "VaultMinted", wallet: A })]);
  assert.equal(days2.get(A)!.size, 1);
});

test("maker side counts for activity only when kind != 3", () => {
  const peg = activeDays(() => [evt({ name: "OrderFilled", wallet: A, counterparty: B, kind: 3 })]);
  assert.equal(peg.has(B), false, "a VaultPeg PDA maker is not an active user");
  assert.equal(peg.has(A), true);

  const real = activeDays(() => [evt({ name: "OrderFilled", wallet: A, counterparty: B, kind: 2 })]);
  assert.equal(real.has(B), true);
});

test("streak is evaluated up to asOf — a stale wallet decays to 1.0", () => {
  const tape = fillsOn(A, [0, 1, 2]);
  // asOf is 10 days after the last activity: the gap days reset the streak.
  const r = computeMultipliers(() => tape, D0 + 12 * DAY);
  assert.equal(r.state.get(A)!.currentStreak, 0);
  assert.equal(r.state.get(A)!.multiplier, 1);
});

test("multiplier replay is deterministic", () => {
  const tape = fillsOn(A, [0, 1, 2, 4, 5, 6, 7, 8, 9, 10]);
  const a = JSON.stringify([...computeMultipliers(() => tape, D0 + 10 * DAY).state]);
  const b = JSON.stringify([...computeMultipliers(() => tape, D0 + 10 * DAY).state]);
  assert.equal(a, b);
});
