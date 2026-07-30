// Budget accounting tests.
//   run: npx ts-node --transpile-only src/budget.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { utcDay, headroom, bindingConstraint, nextFloat, type BudgetLimits } from "./budget";

const LIMITS: BudgetLimits = {
  maxPerWalletDayUsdc: 250,
  maxGlobalDayUsdc: 2000,
  maxFloatUsdc: 10_000,
};

test("utcDay is UTC, not local", () => {
  // 2026-07-30T23:30:00Z. In any timezone east of UTC this is already the 31st
  // locally — a bot that rolled its day on local time would hand a seller two
  // daily budgets on one calendar day.
  assert.equal(utcDay(Date.UTC(2026, 6, 30, 23, 30, 0) / 1000), "2026-07-30");
  assert.equal(utcDay(Date.UTC(2026, 6, 31, 0, 0, 0) / 1000), "2026-07-31");
  assert.equal(utcDay(Date.UTC(2026, 6, 30, 0, 0, 0) / 1000), "2026-07-30");
});

test("utcDay rolls exactly at midnight UTC, not a second early or late", () => {
  const midnight = Date.UTC(2026, 6, 31, 0, 0, 0) / 1000;
  assert.equal(utcDay(midnight - 1), "2026-07-30");
  assert.equal(utcDay(midnight), "2026-07-31");
});

test("headroom is never negative, even when a limit is already exceeded", () => {
  // Overspend is possible in principle (a limit lowered mid-day). It must clamp
  // to zero rather than produce a negative that would read as "budget available"
  // once something subtracts it.
  const h = headroom(LIMITS, { walletSpentTodayUsdc: 400, globalSpentTodayUsdc: 3000, floatUsdc: 12_000 });
  assert.deepEqual(h, { wallet: 0, global: 0, float: 0 });
});

test("headroom subtracts each limit independently", () => {
  const h = headroom(LIMITS, { walletSpentTodayUsdc: 100, globalSpentTodayUsdc: 500, floatUsdc: 2500 });
  assert.deepEqual(h, { wallet: 150, global: 1500, float: 7500 });
});

test("bindingConstraint is null while everything has room", () => {
  assert.equal(bindingConstraint(LIMITS, { walletSpentTodayUsdc: 1, globalSpentTodayUsdc: 1, floatUsdc: 1 }), null);
});

test("bindingConstraint names each limit", () => {
  assert.equal(bindingConstraint(LIMITS, { walletSpentTodayUsdc: 250, globalSpentTodayUsdc: 0, floatUsdc: 0 }), "wallet");
  assert.equal(bindingConstraint(LIMITS, { walletSpentTodayUsdc: 0, globalSpentTodayUsdc: 2000, floatUsdc: 0 }), "global");
  assert.equal(bindingConstraint(LIMITS, { walletSpentTodayUsdc: 0, globalSpentTodayUsdc: 0, floatUsdc: 10_000 }), "float");
});

test("bindingConstraint reports FLOAT first when several bind together", () => {
  // Float is the one that does not reset at midnight, so it is the one an
  // operator needs to see.
  assert.equal(
    bindingConstraint(LIMITS, { walletSpentTodayUsdc: 250, globalSpentTodayUsdc: 2000, floatUsdc: 10_000 }),
    "float",
  );
});

test("float RISES on spend and FALLS on recovery", () => {
  // Without the recovery term the bot ratchets itself shut after $10k of
  // lifetime volume, even if every position closed profitably.
  assert.equal(nextFloat(0, 100, 0), 100);
  assert.equal(nextFloat(100, 0, 40), 60);
  assert.equal(nextFloat(100, 50, 25), 125);
});

test("float never goes negative", () => {
  // Recovering more than was spent is legitimate — a profitable exit — and must
  // not manufacture phantom headroom above the cap.
  assert.equal(nextFloat(100, 0, 500), 0);
});
