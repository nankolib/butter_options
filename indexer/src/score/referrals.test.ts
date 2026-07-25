// Referral rules: bond, activation gate, 10% rate, 25% cap.
// run: npx ts-node --transpile-only src/score/referrals.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import { computeReferrals, type ReferralRow } from "./referrals";
import { DEFAULT_QUESTS } from "./quests/evaluator";
import { computeProvenance } from "./provenance";

const CFG = DEFAULT_QUESTS.referral;
const R = "RRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRRR";
const E = "EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE";

const row = (over: Partial<ReferralRow> = {}): ReferralRow => ({
  code: "CODE1", referrer_wallet: R, referee_wallet: E, bound_at: 1000, activated_at: null, ...over,
});

test("empty table is handled gracefully — Phase 2a ships with no rows", () => {
  const r = computeReferrals([], new Map(), () => 0, CFG);
  assert.equal(r.bound, 0);
  assert.equal(r.activated, 0);
  assert.equal(r.commission.size, 0);
  assert.equal(r.bondPoints.size, 0);
});

test("referee gets +25 at bind; referrer gets nothing until activation", () => {
  const r = computeReferrals([row()], new Map([[R, 1000]]), () => 500, CFG);
  assert.equal(r.bondPoints.get(E), 25);
  assert.equal(r.commission.get(R), undefined, "no commission before activation");
  assert.equal(r.bound, 1);
  assert.equal(r.activated, 0);
});

test("after activation the referrer earns 10% of the referee's post-activation points", () => {
  const r = computeReferrals([row({ activated_at: 2000 })], new Map([[R, 10_000]]), () => 500, CFG);
  assert.equal(r.commission.get(R), 50, "10% of 500");
  assert.equal(r.activated, 1);
});

test("commission is capped at 25% of the referrer's SELF-earned points", () => {
  // Referrer self-earned 100 -> cap 25. Referee earned 1000 -> raw 100.
  const r = computeReferrals([row({ activated_at: 2000 })], new Map([[R, 100]]), () => 1000, CFG);
  assert.equal(r.commission.get(R), 25, "capped");
  assert.equal(r.capForfeited.get(R), 75, "forfeiture is recorded, not hidden");
});

test("cap is NON-CIRCULAR: commission never inflates the base it is capped against", () => {
  const selfEarned = new Map([[R, 400]]);
  const first = computeReferrals([row({ activated_at: 1 })], selfEarned, () => 10_000, CFG);
  assert.equal(first.commission.get(R), 100, "25% of 400");
  // Feeding the result back in must NOT raise the cap — selfEarned is fixed.
  const second = computeReferrals([row({ activated_at: 1 })], selfEarned, () => 10_000, CFG);
  assert.equal(second.commission.get(R), 100, "stable, not 25% of 500");
});

test("a referrer with zero self-earned points earns zero commission", () => {
  const r = computeReferrals([row({ activated_at: 1 })], new Map(), () => 10_000, CFG);
  assert.equal(r.commission.get(R), 0);
});

test("multiple referees aggregate before the cap applies", () => {
  const rows: ReferralRow[] = [
    row({ code: "C1", referee_wallet: "E1", activated_at: 1 }),
    row({ code: "C2", referee_wallet: "E2", activated_at: 1 }),
  ];
  const uncapped = computeReferrals(rows, new Map([[R, 100_000]]), () => 300, CFG);
  assert.equal(uncapped.commission.get(R), 60, "10% of 300, twice");
});

test("results are order-independent (rows sorted by code)", () => {
  const rows: ReferralRow[] = [
    row({ code: "Z", referee_wallet: "E2", activated_at: 1 }),
    row({ code: "A", referee_wallet: "E1", activated_at: 1 }),
  ];
  const a = computeReferrals(rows, new Map([[R, 1e6]]), () => 100, CFG);
  const b = computeReferrals([...rows].reverse(), new Map([[R, 1e6]]), () => 100, CFG);
  assert.equal(JSON.stringify([...a.commission]), JSON.stringify([...b.commission]));
});

// ---- provenance -----------------------------------------------------------

test("profit eligibility needs faucet_in > 0 AND pct_faucet >= 90%", () => {
  const p = computeProvenance(
    [
      { wallet: "W1", direction: "in", source: "faucet", amount_usdc: 1000 },
      { wallet: "W2", direction: "in", source: "faucet", amount_usdc: 800 },
      { wallet: "W2", direction: "in", source: "external", amount_usdc: 200 },
      { wallet: "W3", direction: "in", source: "external", amount_usdc: 500 },
    ],
    ["W1", "W2", "W3", "W4"],
  );
  assert.equal(p.get("W1")!.eligible, true);
  assert.equal(p.get("W2")!.eligible, false, "80% faucet < 90%");
  assert.match(p.get("W2")!.ineligibleReason!, /80\.0% < 90%/);
  assert.equal(p.get("W3")!.eligible, false);
  assert.equal(p.get("W4")!.ineligibleReason, "no faucet claim on record");
});

test("exactly 90% faucet qualifies (boundary is inclusive)", () => {
  const p = computeProvenance(
    [
      { wallet: "W", direction: "in", source: "faucet", amount_usdc: 900 },
      { wallet: "W", direction: "in", source: "external", amount_usdc: 100 },
    ],
    ["W"],
  );
  assert.equal(p.get("W")!.eligible, true);
});
