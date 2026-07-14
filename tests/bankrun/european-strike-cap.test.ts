// =============================================================================
// tests/bankrun/european-strike-cap.test.ts — Run-9 EUROPEAN strike-cap matrix
// =============================================================================
// New in Run-9. Proves the European per-contract settlement cap (Phase-0 finding
// "EUROPEAN STRIKE-CAP"): both binding holder-payout paths now clamp each
// contract at collateral_per_token (= 1× strike) via exercise_capped_intrinsic,
// closing the FCFS insolvency vector where a deep-ITM European CALL paid
// settlement−strike (> collateral) per contract and stranded later claimants.
//
// Boundary matrix (European CALL, strike $100, collateral_per_token = $100):
//   • ATM        settle $100 → intrinsic $0    → pays 0            (auto-finalize)
//   • shallow    settle $150 → intrinsic $50   → pays $50   (cap does NOT bind)
//   • == 2×K     settle $200 → intrinsic $100  → pays $100  (boundary equality)
//   • deep single settle $250 → min($150,$100) → pays $100  (cap binds)
//   • deep MULTI settle $250, 2 claimants → BOTH paid $100/contract, no strand;
//     Σ payouts + residual == collateral, to the micro-USDC (CONSERVATION)
//   • PUT        strike $100, settle $40 → $60 (< cap) → UNCHANGED (cap never
//     binds a PUT: strike−settle ≤ strike for all settle ≥ 0)
// =============================================================================

import { assert } from "chai";
import {
  setupEnv, createVault, deposit, mint, purchase, settle,
  exerciseFromVault, autoFinalizeHolders, usdc, bal, actor, getClockUnix, BN,
} from "./helpers";

const K = 100;                    // strike $100 → collateral_per_token = $100
const CPT = usdc(100);            // the per-contract cap (= 1× strike)

async function euCallVault(tag: string, feed: string, depositUsd: number, mintQty: number) {
  const e = await setupEnv(tag, feed);
  const writer = actor(e);
  const now = await getClockUnix(e.h.context);
  const expiry = new BN(now + 7 * 86_400);
  const { vault, vaultUsdc } = await createVault(e, "european", usdc(K), expiry, { call: {} }, writer);
  const wp = await deposit(e, vault, vaultUsdc, writer, depositUsd);
  const m = await mint(e, vault, wp, writer, mintQty, now, false);
  return { e, writer, wp, vault, vaultUsdc, m, expiry };
}

const collatRemaining = async (e: any, vault: any): Promise<bigint> => {
  const v: any = await e.opta.account.sharedVault.fetch(vault);
  return BigInt(v.collateralRemaining.toString());
};

describe("bankrun: European strike-cap matrix (Run-9)", function () {
  this.timeout(180_000);

  it("ATM: settle == strike → per-contract 0 (auto_finalize pays nothing, collateral untouched)", async () => {
    const { e, wp, vault, vaultUsdc, m, expiry } = await euCallVault("EUATM", "eu-atm", 2000, 10);
    const b = actor(e);
    const h = await purchase(e, vault, wp, m, vaultUsdc, b, 4);

    await settle(e, vault, expiry, K); // settle == strike → intrinsic 0
    const c0 = await collatRemaining(e, vault);
    const before = await bal(e, h.buyerUsdc);
    await autoFinalizeHolders(e, vault, m, vaultUsdc, [[h.buyerOptionAta, h.buyerUsdc]]);
    const paid = (await bal(e, h.buyerUsdc)) - before;
    assert.equal(paid, 0n, "ATM pays 0 per contract");
    assert.equal(await collatRemaining(e, vault), c0, "collateral_remaining untouched at ATM");
  });

  it("shallow-ITM: settle $150 → pays $50/contract (cap does NOT bind — surgical)", async () => {
    const { e, wp, vault, vaultUsdc, m, expiry } = await euCallVault("EUSHAL", "eu-shal", 2000, 10);
    const b = actor(e);
    const h = await purchase(e, vault, wp, m, vaultUsdc, b, 5);

    await settle(e, vault, expiry, 150); // intrinsic $50 < $100 cap
    const before = await bal(e, h.buyerUsdc);
    await exerciseFromVault(e, vault, m, b, h.buyerOptionAta, h.buyerUsdc, 5);
    const paid = (await bal(e, h.buyerUsdc)) - before;
    assert.equal(paid, 5n * BigInt(usdc(50)), "shallow-ITM pays uncapped 5×$50 — cap doesn't bind");
  });

  it("boundary == 2×strike: settle $200 → pays exactly $100/contract (cap equality)", async () => {
    const { e, wp, vault, vaultUsdc, m, expiry } = await euCallVault("EU2XK", "eu-2xk", 2000, 10);
    const b = actor(e);
    const h = await purchase(e, vault, wp, m, vaultUsdc, b, 5);

    await settle(e, vault, expiry, 200); // intrinsic $100 == $100 cap
    const before = await bal(e, h.buyerUsdc);
    await exerciseFromVault(e, vault, m, b, h.buyerOptionAta, h.buyerUsdc, 5);
    const paid = (await bal(e, h.buyerUsdc)) - before;
    assert.equal(paid, 5n * BigInt(CPT), "at settle==2×strike the intrinsic equals the cap: 5×$100");
  });

  it("deep-ITM single claimant: settle $250 → CAPPED at $100/contract (was $150)", async () => {
    const { e, wp, vault, vaultUsdc, m, expiry } = await euCallVault("EUDEEP1", "eu-deep1", 2000, 10);
    const b = actor(e);
    const h = await purchase(e, vault, wp, m, vaultUsdc, b, 5);

    await settle(e, vault, expiry, 250); // intrinsic $150 → capped $100
    const c0 = await collatRemaining(e, vault);
    const before = await bal(e, h.buyerUsdc);
    await exerciseFromVault(e, vault, m, b, h.buyerOptionAta, h.buyerUsdc, 5);
    const paid = (await bal(e, h.buyerUsdc)) - before;
    assert.equal(paid, 5n * BigInt(CPT), "deep-ITM capped at 5×$100, not 5×$150");
    // conservation on the single-claim: exactly `paid` left collateral_remaining.
    assert.equal(await collatRemaining(e, vault), c0 - paid, "collateral_remaining decremented by exactly the payout");
  });

  // ==========================================================================
  // THE INSOLVENCY-FIX PROOF — deep-ITM, MULTIPLE claimants, conservation.
  // --------------------------------------------------------------------------
  // Sizing chosen so the pre-Run-9 uncapped path WOULD strand claimant #2:
  //   deposit $1200, mint 10, sell 5 + 5. Settle deep $250.
  //   collateral_remaining at settle = total_collateral = $1200.
  //   UNCAPPED (old): holder1 = 5 × $150 = $750 → remaining $450; holder2 wants
  //     5 × $150 = $750 but clamps to $450 → STRANDED $300 (paid only $450).
  //   CAPPED (Run-9): holder1 = 5 × $100 = $500; holder2 = 5 × $100 = $500; both
  //     FULL. residual = $1200 − $1000 = $200 (→ writer). No strand.
  // Asserts: both holders paid in full (no strand) AND
  //   Σ holder_payouts + residual == collateral_remaining_at_settle, micro-USDC.
  // ==========================================================================
  it("deep-ITM MULTI-claimant: no strand + conservation to the micro-USDC", async () => {
    const { e, wp, vault, vaultUsdc, m, expiry } = await euCallVault("EUDEEPN", "eu-deepn", 1200, 10);
    const b1 = actor(e), b2 = actor(e);
    const h1 = await purchase(e, vault, wp, m, vaultUsdc, b1, 5);
    const h2 = await purchase(e, vault, wp, m, vaultUsdc, b2, 5);

    await settle(e, vault, expiry, 250);
    const c0 = await collatRemaining(e, vault);
    assert.equal(c0, BigInt(usdc(1200)), "collateral_remaining at settle == total_collateral $1200");

    const b1Before = await bal(e, h1.buyerUsdc), b2Before = await bal(e, h2.buyerUsdc);
    // Single call finalizes BOTH holders in sequence — order-independent under the cap.
    await autoFinalizeHolders(e, vault, m, vaultUsdc, [
      [h1.buyerOptionAta, h1.buyerUsdc],
      [h2.buyerOptionAta, h2.buyerUsdc],
    ]);
    const p1 = (await bal(e, h1.buyerUsdc)) - b1Before;
    const p2 = (await bal(e, h2.buyerUsdc)) - b2Before;
    console.log(`    EUR deep multi: p1=${p1} p2=${p2} (each MUST be 5×$100=${5 * usdc(100)}; uncapped would strand #2)`);

    // No strand: BOTH holders receive the full capped amount.
    assert.equal(p1, 5n * BigInt(CPT), "holder1 paid full 5×$100 (not the uncapped $750)");
    assert.equal(p2, 5n * BigInt(CPT), "holder2 NOT stranded — paid full 5×$100");

    const c1 = await collatRemaining(e, vault);
    const residual = c1;                       // remaining collateral → writer(s)
    // CONSERVATION (to the micro-USDC): payouts + residual == collateral at settle.
    assert.equal(p1 + p2 + residual, c0, "Σ holder payouts + residual == collateral_remaining, to the micro-USDC");
    assert.equal(residual, BigInt(usdc(200)), "residual == $200 (writer's uncommitted + freed collateral)");
    assert.isTrue(residual >= 0n, "collateral_remaining never underflows");
  });

  it("PUT: cap never binds — settle $40 → pays $60/contract UNCHANGED", async () => {
    const e = await setupEnv("EUPUT", "eu-put");
    const writer = actor(e), b = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "european", usdc(K), expiry, { put: {} }, writer);
    const wp = await deposit(e, vault, vaultUsdc, writer, 2000);
    const m = await mint(e, vault, wp, writer, 10, now, false);
    const h = await purchase(e, vault, wp, m, vaultUsdc, b, 5);

    await settle(e, vault, expiry, 40); // PUT intrinsic = strike−settle = $60 < $100 cap
    const before = await bal(e, h.buyerUsdc);
    await exerciseFromVault(e, vault, m, b, h.buyerOptionAta, h.buyerUsdc, 5);
    const paid = (await bal(e, h.buyerUsdc)) - before;
    assert.equal(paid, 5n * BigInt(usdc(60)), "PUT pays uncapped 5×$60 — the cap never binds a PUT");
  });
});
