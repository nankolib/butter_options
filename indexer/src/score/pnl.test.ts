// PnL accounting + conservation identity.
// run: npx ts-node --transpile-only src/score/pnl.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import type { EventRow } from "../db";
import { computePnl } from "./pnl";

const A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const VAULT = "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";
const USDC = 1_000_000;

let n = 0;
function evt(over: Partial<EventRow>): EventRow {
  n += 1;
  return {
    id: `S${n}:0`, sig: `S${n}`, ordinal: 0, ix_index: null, source: "log",
    name: "OrderFilled", wallet: null, counterparty: null, vault: null,
    option_mint: null, kind: null, amount_usdc: null, quantity: null,
    fields_json: "{}", block_time: 1_783_000_000, ...over,
  };
}

test("buyer pays total, seller receives total - fee, fee is the rake", () => {
  const r = computePnl([
    evt({
      name: "OrderFilled", wallet: A, counterparty: B, kind: 2, vault: VAULT,
      amount_usdc: 100 * USDC, quantity: 1, fields_json: JSON.stringify({ fee: String(2 * USDC) }),
    }),
  ]);
  assert.equal(r.byWallet.get(A)!.usdcOut, BigInt(100 * USDC));
  assert.equal(r.byWallet.get(B)!.usdcIn, BigInt(98 * USDC));
  assert.equal(r.reconciliation.fees, BigInt(2 * USDC));
  // Zero-sum minus the rake.
  assert.equal(r.reconciliation.totalRealizedPnl, BigInt(-2 * USDC));
  assert.equal(r.reconciliation.residual, 0n, "W + V + F + U == 0");
});

test("deposited collateral is DEPLOYED, not a loss", () => {
  const r = computePnl([evt({ name: "VaultDeposited", wallet: A, vault: VAULT, amount_usdc: 100 * USDC })]);
  const f = r.byWallet.get(A)!;
  assert.equal(f.usdcOut, BigInt(100 * USDC));
  assert.equal(f.deployed, BigInt(100 * USDC));
  assert.equal(f.realizedPnl, 0n, "capital at work is not a realized loss");
});

test("deposit -> settle payout realizes the gain and clears deployed", () => {
  const r = computePnl([
    evt({ name: "VaultDeposited", wallet: A, vault: VAULT, amount_usdc: 100 * USDC }),
    evt({ name: "VaultPostSettlementWithdraw", wallet: A, vault: VAULT, amount_usdc: 105 * USDC }),
  ]);
  const f = r.byWallet.get(A)!;
  assert.equal(f.deployed, 0n);
  assert.equal(f.realizedPnl, BigInt(5 * USDC));
});

test("VaultPostSettlementWithdraw is indexed — its absence broke Phase 1 PnL", () => {
  const r = computePnl([evt({ name: "VaultPostSettlementWithdraw", wallet: A, vault: VAULT, amount_usdc: 7 * USDC })]);
  assert.equal(r.byWallet.get(A)!.usdcIn, BigInt(7 * USDC));
});

test("bid escrow: posted -> deployed; cancelled -> returned", () => {
  const posted = computePnl([
    evt({ name: "OrderPosted", wallet: A, kind: 0, amount_usdc: 50 * USDC, fields_json: JSON.stringify({ order: "ORD1" }) }),
  ]);
  assert.equal(posted.byWallet.get(A)!.deployed, BigInt(50 * USDC));
  assert.equal(posted.byWallet.get(A)!.realizedPnl, 0n);

  const cancelled = computePnl([
    evt({ name: "OrderPosted", wallet: A, kind: 0, amount_usdc: 50 * USDC, fields_json: JSON.stringify({ order: "ORD1" }) }),
    evt({ name: "OrderCancelled", wallet: A, kind: 0, amount_usdc: 50 * USDC, fields_json: JSON.stringify({ order: "ORD1" }) }),
  ]);
  assert.equal(cancelled.byWallet.get(A)!.deployed, 0n);
  assert.equal(cancelled.byWallet.get(A)!.realizedPnl, 0n);
});

test("ask-side OrderPosted escrows contracts, not USDC", () => {
  const r = computePnl([evt({ name: "OrderPosted", wallet: A, kind: 2, amount_usdc: 50 * USDC })]);
  assert.equal(r.byWallet.get(A)?.usdcOut ?? 0n, 0n);
});

test("VaultPeg maker (kind==3) is a PDA and is credited nothing", () => {
  const r = computePnl([
    evt({
      name: "OrderFilled", wallet: A, counterparty: VAULT, kind: 3, vault: VAULT,
      amount_usdc: 40 * USDC, quantity: 1, fields_json: JSON.stringify({ fee: "0" }),
    }),
  ]);
  assert.equal(r.byWallet.has(VAULT), false, "the vault PDA must not accrue PnL");
  assert.equal(r.byWallet.get(A)!.usdcOut, BigInt(40 * USDC));
});

test("full vault round trip: books close exactly, and PnL is zero-sum minus fees", () => {
  const fee = 3 * USDC;
  const r = computePnl([
    // Writer funds the vault.
    evt({ name: "VaultDeposited", wallet: B, vault: VAULT, amount_usdc: 200 * USDC }),
    // Buyer pays 100 premium; the writer nets 97, treasury takes 3.
    evt({
      name: "OrderFilled", wallet: A, counterparty: B, kind: 2, vault: VAULT,
      amount_usdc: 100 * USDC, quantity: 1, fields_json: JSON.stringify({ fee: String(fee) }),
    }),
    // Buyer exercises for 120, drawn from vault collateral (200 -> 80).
    evt({ name: "VaultExercised", wallet: A, vault: VAULT, amount_usdc: 120 * USDC, quantity: 1 }),
    // Writer withdraws exactly what remains.
    evt({ name: "VaultPostSettlementWithdraw", wallet: B, vault: VAULT, amount_usdc: 80 * USDC }),
  ]);
  assert.equal(r.reconciliation.fees, BigInt(fee));
  assert.equal(r.reconciliation.vaultBalance, 0n, "vault fully drained");
  assert.equal(r.reconciliation.residual, 0n, "W + V + F + U == 0");
  assert.equal(r.reconciliation.residualRatio, 0);

  // A paid 100, received 120 -> +20. B received 97 + 80, deposited 200 -> -23.
  assert.equal(r.byWallet.get(A)!.realizedPnl, BigInt(20 * USDC));
  assert.equal(r.byWallet.get(B)!.realizedPnl, BigInt(-23 * USDC));
  assert.equal(r.reconciliation.totalRealizedPnl, BigInt(-fee), "zero-sum minus the rake");
});

test("aggregate finalize payouts are booked as a NAMED unattributed term", () => {
  // HoldersFinalized carries only a total — the tape cannot say who was paid.
  const r = computePnl([
    evt({ name: "VaultDeposited", wallet: B, vault: VAULT, amount_usdc: 100 * USDC }),
    evt({
      name: "HoldersFinalized", wallet: null, vault: VAULT, amount_usdc: 100 * USDC,
      fields_json: JSON.stringify({ holders_processed: 3 }),
    }),
  ]);
  assert.equal(r.reconciliation.unattributedPayouts, BigInt(100 * USDC));
  assert.equal(r.reconciliation.vaultBalance, 0n);
  assert.equal(r.reconciliation.residual, 0n, "named, not hidden in the residual");
});

test("an unmodelled outflow shows up as a NON-ZERO residual — the point of the check", () => {
  const r = computePnl([
    evt({ name: "VaultDeposited", wallet: B, vault: VAULT, amount_usdc: 100 * USDC }),
    // Pretend the withdrawal event type were missing from the allowlist: the
    // vault would still look funded and the books would not close.
  ]);
  assert.equal(r.reconciliation.vaultBalance, BigInt(100 * USDC));
  assert.equal(r.reconciliation.residual, 0n, "…balanced while the money is still IN the vault");
  assert.equal(r.byWallet.get(B)!.deployed, BigInt(100 * USDC));
});

test("writer premium is tracked separately from PnL", () => {
  const r = computePnl([
    evt({ name: "OrderFilled", wallet: A, counterparty: B, kind: 2, vault: VAULT, amount_usdc: 10 * USDC, quantity: 1, fields_json: JSON.stringify({ fee: "0" }) }),
    evt({ name: "PremiumClaimed", wallet: B, vault: VAULT, amount_usdc: 5 * USDC }),
  ]);
  assert.equal(r.byWallet.get(B)!.writerPremium, BigInt(15 * USDC));
});
