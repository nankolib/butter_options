// =============================================================================
// tests/bankrun/contamination-premium.test.ts
// Ported from the 4 "full-suite contamination; passes standalone" skips:
//   shared-vaults.ts "5. Premium Claims" + "6. Withdrawal",
//   zzz-audit-fixes.ts MEDIUM-01 (withdraw requires premium claimed first) +
//   "Premium accrues correctly after partial share withdrawal".
//
// These are NOT clock-dependent — they net 0 / collide ONLY in the shared
// validator session (singleton protocol_state + its USDC mint + accumulated
// vault/premium state across files in one ledger). Running each in a FRESH
// bankrun SVM (one pristine protocol_state + mint per file, no other files'
// vaults) is standalone-equivalent — if they pass here, the root is confirmed
// to be session-state isolation, NOT a logic bug. (If any FAILED here, that
// would be a real bug — reported, not hidden.)
// =============================================================================

import { assert } from "chai";
import {
  setupEnv, createVault, deposit, mint, purchase, claimPremium, withdrawFromVault,
  usdc, bal, actor, getClockUnix, BN,
} from "./helpers";

describe("bankrun: premium/withdraw contamination ports (fresh SVM = standalone-equivalent)", function () {
  this.timeout(180_000);

  it("5. Premium Claims — claim_premium pays the writer after a purchase", async () => {
    const e = await setupEnv("PREMCLAIM", "prem-claim");
    const writer = actor(e), buyer = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "european", usdc(100), expiry, { call: {} }, writer);
    const wp = await deposit(e, vault, vaultUsdc, writer, 1000);
    const m = await mint(e, vault, wp, writer, 2, now, false);
    await purchase(e, vault, wp, m, vaultUsdc, buyer, 2); // premium → vault

    const wusdc = (await import("@solana/spl-token")).getAssociatedTokenAddressSync(e.usdcMint, writer.publicKey, false);
    const before = await bal(e, wusdc);
    await claimPremium(e, vault, wp, writer);
    const claimed = (await bal(e, wusdc)) - before;
    console.log(`    5: premium claimed = ${claimed}`);
    assert.isTrue(claimed > 0n, "writer receives premium (would net 0 under cross-file contamination)");
  });

  it("MEDIUM-01 / 6. Withdrawal — withdraw_from_vault requires premium claimed first", async () => {
    const e = await setupEnv("WDREQCLAIM", "wd-reqclaim");
    const writer = actor(e), buyer = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "european", usdc(100), expiry, { call: {} }, writer);
    const wp = await deposit(e, vault, vaultUsdc, writer, 1000);
    const m = await mint(e, vault, wp, writer, 2, now, false);
    await purchase(e, vault, wp, m, vaultUsdc, buyer, 2); // unclaimed premium now exists

    // Withdraw before claiming → ClaimPremiumFirst.
    let reverted = false, err = "";
    try { await withdrawFromVault(e, vault, wp, writer, 100); }
    catch (ex: any) { reverted = true; err = String(ex); }
    console.log(`    MED-01: pre-claim withdraw reverted=${reverted}`);
    assert.isTrue(reverted && /ClaimPremiumFirst/.test(err), "must revert ClaimPremiumFirst");

    // Claim, then withdraw succeeds.
    const wusdc = (await import("@solana/spl-token")).getAssociatedTokenAddressSync(e.usdcMint, writer.publicKey, false);
    await claimPremium(e, vault, wp, writer);
    const before = await bal(e, wusdc);
    await withdrawFromVault(e, vault, wp, writer, 100);
    assert.isTrue((await bal(e, wusdc)) - before > 0n, "withdraw succeeds after claiming premium");
  });

  it("premium accrues correctly after partial share withdrawal", async () => {
    const e = await setupEnv("PREMPARTIAL", "prem-partial");
    const writer = actor(e), b1 = actor(e), b2 = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "european", usdc(100), expiry, { call: {} }, writer);
    const wp = await deposit(e, vault, vaultUsdc, writer, 1000);
    const m = await mint(e, vault, wp, writer, 4, now, false);
    await purchase(e, vault, wp, m, vaultUsdc, b1, 2);

    await claimPremium(e, vault, wp, writer);          // claim round 1
    await withdrawFromVault(e, vault, wp, writer, 100); // partial share withdraw
    const posMid: any = await e.opta.account.writerPosition.fetch(wp);
    console.log(`    partial: shares after withdraw = ${posMid.shares.toString()}`);

    // A second purchase accrues fresh premium; the post-partial-withdraw writer still claims it.
    const wusdc = (await import("@solana/spl-token")).getAssociatedTokenAddressSync(e.usdcMint, writer.publicKey, false);
    await purchase(e, vault, wp, m, vaultUsdc, b2, 2);
    const before = await bal(e, wusdc);
    await claimPremium(e, vault, wp, writer);          // claim round 2 (accrual after partial withdraw)
    assert.isTrue((await bal(e, wusdc)) - before > 0n, "premium still accrues + claimable after partial withdraw");
  });
});
