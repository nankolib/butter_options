// =============================================================================
// tests/bankrun/american-settlement-cap.test.ts  (AM-MED-1 + Run-9 EUR strike-cap)
// =============================================================================
// Proves the settlement per-contract cap on the two holder payout paths
// (exercise_from_vault, auto_finalize_holders).
//
// Deep-ITM CALL: strike $100, settle $250 (spot > 2×strike). collateral_per_token
// = strike = $100.
//   per-contract = min(250−100, 100) = $100   (CAPPED at 1× collateral)
//
// -----------------------------------------------------------------------------
// AUDIT TRAIL — ASSERTION INVERTED (Run-9 EUR strike-cap)
// -----------------------------------------------------------------------------
// PRE-Run-9 the two EUROPEAN cases in this file asserted the opposite:
//     "EUROPEAN … deep-ITM CALL UNCAPPED (byte-identical to pre-cap)"
//     assert paid == 5 × $150   /   4 × $150     (UNCAP_PC = $150 = 250−100)
// i.e. European settlement paid the FULL uncapped intrinsic per contract. That
// was the insolvency vector (Phase-0 recon, finding "EUROPEAN STRIKE-CAP"): a
// European vault locks only 1× strike ($100) of collateral per contract, so a
// deep-ITM CALL paying $150/contract let the FIRST first-come-first-served
// claimant over-draw the shared pool and STRAND later claimants (the aggregate
// collateral_remaining clamp only prevents underflow, not per-claimant
// over-draw). The Run-9 fix collapses the European match-arm into the SAME
// exercise_capped_intrinsic helper the American arm already used, at both binding
// sites (exercise_from_vault.rs, auto_finalize_holders.rs). The two European
// assertions therefore FLIP from UNCAP_PC ($150) → CAP_PC ($100).
//
// The two AMERICAN cases are UNCHANGED and now serve as the explicit
// AMERICAN-UNCHANGED GATE: their payout numbers ($100/contract) MUST be
// byte-identical pre/post bundle — the fix must not perturb the American path
// (it re-uses the identical helper + args). See also the dedicated conservation/
// boundary matrix in european-strike-cap.test.ts.
// =============================================================================

import { assert } from "chai";
import {
  setupEnv, createVault, deposit, mint, purchase, settle,
  exerciseFromVault, autoFinalizeHolders, usdc, bal, actor, getClockUnix, BN,
} from "./helpers";

const STRIKE = 100, DEEP = 250;          // deep-ITM: 250 > 2×100
const CAP_PC = usdc(100);                 // min(250−100,100)=100  (BOTH styles now)
const UNCAP_PC = usdc(150);               // 250−100=150  — pre-Run-9 European value (now forbidden)

describe("bankrun: settlement per-contract cap (AM-MED-1 + Run-9 EUR)", function () {
  this.timeout(180_000);

  // ---- AMERICAN-UNCHANGED GATE (numbers must not move pre/post bundle) -------
  it("[AMER-GATE] exercise_from_vault: deep-ITM CALL capped at collateral_per_token — UNCHANGED", async () => {
    const e = await setupEnv("AMCAPXFV", "amcap-xfv");
    const writer = actor(e), buyer = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "american", usdc(STRIKE), expiry, { call: {} }, writer);
    const wp = await deposit(e, vault, vaultUsdc, writer, 2000);
    const m = await mint(e, vault, wp, writer, 10, now, true);
    const { buyerOptionAta, buyerUsdc } = await purchase(e, vault, wp, m, vaultUsdc, buyer, 5);

    await settle(e, vault, expiry, DEEP);
    const before = await bal(e, buyerUsdc);
    await exerciseFromVault(e, vault, m, buyer, buyerOptionAta, buyerUsdc, 5);
    const paid = (await bal(e, buyerUsdc)) - before;
    const perContract = paid / 5n;
    console.log(`    AMER xfv: paid=${paid} perContract=${perContract} (cap=${CAP_PC} uncapped_would_be=${UNCAP_PC})`);
    // GATE: this exact number ($100/contract, $500 total) MUST be unchanged by the bundle.
    assert.equal(paid, 5n * BigInt(CAP_PC), "AMERICAN unchanged: 5 × capped $100, NOT 5 × uncapped $150");
    assert.equal(perContract, BigInt(CAP_PC), "settlement cap equals early-exercise cap — hold-to-settlement edge gone");
    const v: any = await e.opta.account.sharedVault.fetch(vault);
    assert.isTrue(BigInt(v.collateralRemaining.toString()) >= 0n, "collateral_remaining non-negative");
  });

  it("[AMER-GATE] auto_finalize_holders: deep-ITM CALL capped per contract (2 holders) — UNCHANGED", async () => {
    const e = await setupEnv("AMCAPAFH", "amcap-afh");
    const writer = actor(e), b1 = actor(e), b2 = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "american", usdc(STRIKE), expiry, { call: {} }, writer);
    const wp = await deposit(e, vault, vaultUsdc, writer, 2000);
    const m = await mint(e, vault, wp, writer, 10, now, true);
    const h1 = await purchase(e, vault, wp, m, vaultUsdc, b1, 3);
    const h2 = await purchase(e, vault, wp, m, vaultUsdc, b2, 3);

    await settle(e, vault, expiry, DEEP);
    const b1Before = await bal(e, h1.buyerUsdc), b2Before = await bal(e, h2.buyerUsdc);
    await autoFinalizeHolders(e, vault, m, vaultUsdc, [
      [h1.buyerOptionAta, h1.buyerUsdc],
      [h2.buyerOptionAta, h2.buyerUsdc],
    ]);
    const p1 = (await bal(e, h1.buyerUsdc)) - b1Before, p2 = (await bal(e, h2.buyerUsdc)) - b2Before;
    console.log(`    AMER afh: p1=${p1} p2=${p2} (each cap=${3 * CAP_PC})`);
    assert.equal(p1, 3n * BigInt(CAP_PC), "AMERICAN unchanged: h1 capped at 3×$100");
    assert.equal(p2, 3n * BigInt(CAP_PC), "AMERICAN unchanged: h2 capped at 3×$100");
  });

  // ---- EUROPEAN — INVERTED: now CAPPED at collateral_per_token (was uncapped) -
  it("[EUR-INVERTED] exercise_from_vault: deep-ITM CALL now CAPPED at $100 (was uncapped $150)", async () => {
    const e = await setupEnv("EUCAPXFV", "eucap-xfv");
    const writer = actor(e), buyer = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "european", usdc(STRIKE), expiry, { call: {} }, writer);
    const wp = await deposit(e, vault, vaultUsdc, writer, 2000);
    const m = await mint(e, vault, wp, writer, 10, now, false);
    const { buyerOptionAta, buyerUsdc } = await purchase(e, vault, wp, m, vaultUsdc, buyer, 5);

    await settle(e, vault, expiry, DEEP);
    const before = await bal(e, buyerUsdc);
    await exerciseFromVault(e, vault, m, buyer, buyerOptionAta, buyerUsdc, 5);
    const paid = (await bal(e, buyerUsdc)) - before;
    console.log(`    EUR xfv: paid=${paid} (now capped 5×$100=${5 * CAP_PC}; pre-Run-9 was 5×$150=${5 * UNCAP_PC})`);
    // FLIPPED: was `assert.equal(paid, 5n * UNCAP_PC)` — European is now capped like American.
    assert.equal(paid, 5n * BigInt(CAP_PC), "EUR now capped at 1× collateral: 5 × $100, NOT the old 5 × $150");
    assert.notEqual(paid, 5n * BigInt(UNCAP_PC), "must NOT pay the old uncapped $150/contract");
  });

  it("[EUR-INVERTED] auto_finalize_holders: deep-ITM CALL now CAPPED at $100 (was uncapped $150)", async () => {
    const e = await setupEnv("EUCAPAFH", "eucap-afh");
    const writer = actor(e), b1 = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "european", usdc(STRIKE), expiry, { call: {} }, writer);
    const wp = await deposit(e, vault, vaultUsdc, writer, 2000);
    const m = await mint(e, vault, wp, writer, 10, now, false);
    const h1 = await purchase(e, vault, wp, m, vaultUsdc, b1, 4);

    await settle(e, vault, expiry, DEEP);
    const before = await bal(e, h1.buyerUsdc);
    await autoFinalizeHolders(e, vault, m, vaultUsdc, [[h1.buyerOptionAta, h1.buyerUsdc]]);
    const paid = (await bal(e, h1.buyerUsdc)) - before;
    console.log(`    EUR afh: paid=${paid} (now capped 4×$100=${4 * CAP_PC}; pre-Run-9 was 4×$150=${4 * UNCAP_PC})`);
    // FLIPPED: was `assert.equal(paid, 4n * UNCAP_PC)`.
    assert.equal(paid, 4n * BigInt(CAP_PC), "EUR now capped: 4 × $100, NOT the old 4 × $150");
    assert.notEqual(paid, 4n * BigInt(UNCAP_PC), "must NOT pay the old uncapped $150/contract");
  });
});
