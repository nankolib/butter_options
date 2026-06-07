// =============================================================================
// tests/bankrun/audit-fixes-settlement.test.ts
// Ported from tests/zzz-audit-fixes.ts settlement describe.skips:
//   CRITICAL-01 ITM  — no double-deduction (collateral_remaining starts at
//                      total_collateral), holder exercises, writer withdraws,
//                      vault USDC account closes (no stuck funds).
//   CRITICAL-01 OTM  — OTM → writers get everything back.
//   HIGH-01          — withdraw_post_settlement auto-claims unclaimed premium.
// All European (the audit fixes are EUR settlement). Clock-dependent: settle
// past expiry + the 24h EXERCISE_WINDOW writer gate (total_options_sold > 0).
// =============================================================================

import { assert } from "chai";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  setupEnv, createVault, deposit, mint, purchase, settle, exerciseFromVault,
  withdrawPostSettlement, claimPremium, bumpTokenAmount,
  usdc, bal, exists, actor, getClockUnix, setClockUnix, BN, EXERCISE_WINDOW,
} from "./helpers";
const wAta = (mint: any, owner: any) => getAssociatedTokenAddressSync(mint, owner, false, TOKEN_PROGRAM_ID);

describe("bankrun: audit-fixes settlement (CRIT-01 / HIGH-01)", function () {
  this.timeout(180_000);

  it("CRITICAL-01 ITM: collateral_remaining starts at total; holder exercises; writer withdraws; vault closes", async () => {
    const e = await setupEnv("CITM", "audit-citm");
    const writer = actor(e), buyer = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "european", usdc(100), expiry, { call: {} }, writer);
    const wp = await deposit(e, vault, vaultUsdc, writer, 1000);
    const m = await mint(e, vault, wp, writer, 5, now, false);
    const { buyerOptionAta, buyerUsdc } = await purchase(e, vault, wp, m, vaultUsdc, buyer, 5);

    await settle(e, vault, expiry, 250); // ITM call
    let v: any = await e.opta.account.sharedVault.fetch(vault);
    assert.isTrue(v.isSettled, "settled");
    assert.equal(v.collateralRemaining.toString(), v.totalCollateral.toString(),
      "CRIT-01: collateral_remaining == total_collateral at settle (no pre-deduction; EUR handshake −0)");

    const bBefore = await bal(e, buyerUsdc);
    await exerciseFromVault(e, vault, m, buyer, buyerOptionAta, buyerUsdc, 5);
    assert.equal(await bal(e, buyerOptionAta), 0n, "holder tokens burned");
    assert.isTrue((await bal(e, buyerUsdc)) - bBefore > 0n, "holder paid ITM intrinsic");

    // Writer withdraws after the 24h holder window (total_options_sold > 0).
    await setClockUnix(e.h.context, expiry.toNumber() + EXERCISE_WINDOW + 60);
    await withdrawPostSettlement(e, vault, wp, writer);
    assert.isFalse(await exists(e, vaultUsdc), "vault USDC account closed (no stuck funds)");
  });

  it("CRITICAL-01 OTM: writers get full collateral back", async () => {
    const e = await setupEnv("COTM", "audit-cotm");
    const writer = actor(e), buyer = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "european", usdc(110), expiry, { call: {} }, writer);
    const wp = await deposit(e, vault, vaultUsdc, writer, 1200);
    const m = await mint(e, vault, wp, writer, 5, now, false);
    await purchase(e, vault, wp, m, vaultUsdc, buyer, 5);

    await settle(e, vault, expiry, 50); // OTM call (50 < 110)
    const v: any = await e.opta.account.sharedVault.fetch(vault);
    assert.equal(v.collateralRemaining.toString(), v.totalCollateral.toString(), "OTM: collateral_remaining == total");

    await setClockUnix(e.h.context, expiry.toNumber() + EXERCISE_WINDOW + 60);
    const wusdc = wAta(e.usdcMint, writer.publicKey);
    const before = await bal(e, wusdc);
    await withdrawPostSettlement(e, vault, wp, writer);
    const paid = (await bal(e, wusdc)) - before;
    console.log(`    OTM writer payout=${paid} (expect >= $1200 collateral back)`);
    assert.isTrue(paid >= 1_200_000_000n, "OTM writer gets full collateral back");
  });

  it("HIGH-01: withdraw_post_settlement auto-claims unclaimed premium (no prior claim_premium)", async () => {
    const e = await setupEnv("HAUTO", "audit-hauto");
    const writer = actor(e), buyer = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "european", usdc(120), expiry, { call: {} }, writer);
    const wp = await deposit(e, vault, vaultUsdc, writer, 1300);
    const m = await mint(e, vault, wp, writer, 5, now, false);
    await purchase(e, vault, wp, m, vaultUsdc, buyer, 5); // premium accrues to vault

    await settle(e, vault, expiry, 50); // OTM → writer gets collateral + premium
    const posBefore: any = await e.opta.account.writerPosition.fetch(wp);
    assert.equal(posBefore.premiumClaimed.toString(), "0", "premium NOT yet claimed");

    await setClockUnix(e.h.context, expiry.toNumber() + EXERCISE_WINDOW + 60);
    const wusdc = wAta(e.usdcMint, writer.publicKey);
    const before = await bal(e, wusdc);
    await withdrawPostSettlement(e, vault, wp, writer); // auto-claims premium internally
    const paid = (await bal(e, wusdc)) - before;
    console.log(`    HIGH-01 writer payout=${paid} (collateral $1300 + auto-claimed premium)`);
    assert.isTrue(paid > 1_300_000_000n, "payout exceeds bare collateral → premium auto-claimed");
  });

  it("DUST: last-writer withdraw sweeps premium-rounding dust + closes vault USDC account", async () => {
    const e = await setupEnv("DUST", "audit-dust");
    const writer = actor(e), buyer = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "european", usdc(150), expiry, { call: {} }, writer);
    const wp = await deposit(e, vault, vaultUsdc, writer, 1000);
    const m = await mint(e, vault, wp, writer, 1, now, false);
    await purchase(e, vault, wp, m, vaultUsdc, buyer, 1);
    await claimPremium(e, vault, wp, writer); // vault now holds collateral + any rounding
    // Inject 3 micro-USDC dust (simulates multi-writer accumulator truncation residual).
    await bumpTokenAmount(e, vaultUsdc, 3);

    await settle(e, vault, expiry, 50); // OTM → collateral returns to writer
    await setClockUnix(e.h.context, expiry.toNumber() + EXERCISE_WINDOW + 60);
    // Without the dust-sweep fix this reverts (close_account requires exact 0 balance).
    await withdrawPostSettlement(e, vault, wp, writer);
    assert.isFalse(await exists(e, vaultUsdc), "vault USDC account closed despite the 3-micro dust residual");
  });
});
