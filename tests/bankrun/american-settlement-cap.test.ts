// =============================================================================
// tests/bankrun/american-settlement-cap.test.ts  (AM-MED-1)
// Proves the American settlement per-contract cap added to the two holder
// payout paths (exercise_from_vault, auto_finalize_holders), and that EUROPEAN
// settlement is byte-identical (uncapped, pool-clamped) on both paths.
//
// Deep-ITM CALL: strike $100, settle $250 (spot > 2×strike). collateral_per_token
// = strike = $100.
//   AMERICAN  per-contract = min(250−100, 100) = $100  (CAPPED at collateral)
//   EUROPEAN  per-contract =     250−100       = $150  (uncapped, pool-clamped)
// The pool is sized large (deposit $2000) so the per-contract cap — not the
// aggregate collateral_remaining clamp — is what binds.
// =============================================================================

import { assert } from "chai";
import {
  setupEnv, createVault, deposit, mint, purchase, settle,
  exerciseFromVault, autoFinalizeHolders, usdc, bal, actor, getClockUnix, BN,
} from "./helpers";

const STRIKE = 100, DEEP = 250;          // deep-ITM: 250 > 2×100
const CAP_PC = usdc(100);                 // min(250−100,100)=100  (American)
const UNCAP_PC = usdc(150);               // 250−100=150           (European)

describe("bankrun: American settlement per-contract cap (AM-MED-1)", function () {
  this.timeout(180_000);

  it("AMERICAN exercise_from_vault: deep-ITM CALL capped at collateral_per_token (= early-exercise cap)", async () => {
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
    assert.equal(paid, 5n * BigInt(CAP_PC), "5 × capped $100, NOT 5 × uncapped $150");
    // consistency: settlement per-contract == early-exercise cap min(intrinsic, collateral_per_token)
    assert.equal(perContract, BigInt(CAP_PC), "settlement cap equals early-exercise cap — hold-to-settlement edge gone");
    // solvency: vault never paid more than it held
    const v: any = await e.opta.account.sharedVault.fetch(vault);
    assert.isTrue(BigInt(v.collateralRemaining.toString()) >= 0n, "collateral_remaining non-negative");
  });

  it("AMERICAN auto_finalize_holders: deep-ITM CALL capped per contract (2 holders)", async () => {
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
    assert.equal(p1, 3n * BigInt(CAP_PC), "h1 capped at 3×$100");
    assert.equal(p2, 3n * BigInt(CAP_PC), "h2 capped at 3×$100");
  });

  it("EUROPEAN exercise_from_vault: deep-ITM CALL UNCAPPED (byte-identical to pre-cap)", async () => {
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
    console.log(`    EUR xfv: paid=${paid} (uncapped 5×$150=${5 * UNCAP_PC})`);
    assert.equal(paid, 5n * BigInt(UNCAP_PC), "EUR pays full uncapped 5×$150 — unchanged");
  });

  it("EUROPEAN auto_finalize_holders: deep-ITM CALL UNCAPPED (byte-identical)", async () => {
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
    console.log(`    EUR afh: paid=${paid} (uncapped 4×$150=${4 * UNCAP_PC})`);
    assert.equal(paid, 4n * BigInt(UNCAP_PC), "EUR pays full uncapped 4×$150 — unchanged");
  });
});
