// =============================================================================
// tests/bankrun/exercise-american-stageg.test.ts
// Ported from tests/zzz-exercise-american.ts describe.skip "Stage G deferrals".
//   (i)  post-expiry exercise_american reverts OptionExpired (setClock past expiry)
//   (ii) American exercise_from_vault end-to-end (post-settlement holder claim,
//        proves the Stage-F vault_namespace_seed American signer path)
// =============================================================================

import { assert } from "chai";
import {
  setupEnv, createVault, deposit, mint, purchase, settle, exerciseAmerican,
  exerciseFromVault, usdc, bal, actor, getClockUnix, setClockUnix, BN,
} from "./helpers";

describe("bankrun: exercise-american Stage-G deferrals", function () {
  this.timeout(180_000);

  it("(i) post-expiry → exercise_american reverts OptionExpired", async () => {
    const e = await setupEnv("AMEREXPIRE", "amer-expire");
    const writer = actor(e), buyer = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "american", usdc(100), expiry, { call: {} }, writer);
    const wp = await deposit(e, vault, vaultUsdc, writer, 2000);
    const m = await mint(e, vault, wp, writer, 10, now, true);
    const { buyerOptionAta, buyerUsdc } = await purchase(e, vault, wp, m, vaultUsdc, buyer, 5);

    // Advance clock PAST expiry → the now<expiry gate fires.
    await setClockUnix(e.h.context, expiry.toNumber() + 30);
    let reverted = false, err = "";
    try {
      await exerciseAmerican(e, vault, m, buyer, buyerOptionAta, buyerUsdc, 1, 150, expiry.toNumber() + 5);
    } catch (ex: any) { reverted = true; err = String(ex).slice(0, 140); }
    console.log(`    (i) post-expiry reverted=${reverted} (${err})`);
    assert.isTrue(reverted, "must revert");
    assert.match(err, /OptionExpired/, "must be OptionExpired");
  });

  it("(ii) American exercise_from_vault end-to-end (post-settlement holder claim)", async () => {
    const e = await setupEnv("AMERXFV", "amer-xfv");
    const writer = actor(e), buyer = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "american", usdc(100), expiry, { call: {} }, writer);
    const wp = await deposit(e, vault, vaultUsdc, writer, 2000);
    const m = await mint(e, vault, wp, writer, 10, now, true);
    const { buyerOptionAta, buyerUsdc } = await purchase(e, vault, wp, m, vaultUsdc, buyer, 5);

    // Settle the American vault at $150 (CALL ITM by $50/contract).
    await settle(e, vault, expiry, 150);
    const v: any = await e.opta.account.sharedVault.fetch(vault);
    assert.isTrue(v.isSettled, "vault settled");

    // Holder claims post-settlement via exercise_from_vault (American PDA signer).
    const before = await bal(e, buyerUsdc);
    await exerciseFromVault(e, vault, m, buyer, buyerOptionAta, buyerUsdc, 5);
    const paid = (await bal(e, buyerUsdc)) - before;
    const burned = await bal(e, buyerOptionAta);
    console.log(`    (ii) exercise_from_vault paid=${paid} remaining_tokens=${burned}`);
    assert.equal(paid, 250_000_000n, "holder paid 5×$50 = $250 (settlement $150 − strike $100)");
    assert.equal(burned, 0n, "5 tokens burned");
  });
});
