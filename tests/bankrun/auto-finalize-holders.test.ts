// =============================================================================
// tests/bankrun/auto-finalize-holders.test.ts
// Ported (representative) from tests/zzz-auto-finalize-holders.ts describe.skip.
//   - ITM call, 2 holders → all burned + paid intrinsic (multi-holder batch)
//   - OTM call, 1 holder → burned, no USDC moves
//   - pre-settlement call → reverts VaultNotSettled
// =============================================================================

import { assert } from "chai";
import {
  setupEnv, createVault, deposit, mint, purchase, settle, autoFinalizeHolders,
  usdc, bal, actor, getClockUnix, BN,
} from "./helpers";

describe("bankrun: auto_finalize_holders", function () {
  this.timeout(180_000);

  it("ITM call, 2 holders → all burned + paid intrinsic", async () => {
    const e = await setupEnv("AFHITM", "afh-itm");
    const writer = actor(e), b1 = actor(e), b2 = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "european", usdc(200), expiry, { call: {} }, writer);
    const wp = await deposit(e, vault, vaultUsdc, writer, 1000);
    const m = await mint(e, vault, wp, writer, 4, now, false);
    const h1 = await purchase(e, vault, wp, m, vaultUsdc, b1, 2);
    const h2 = await purchase(e, vault, wp, m, vaultUsdc, b2, 2);

    await settle(e, vault, expiry, 250); // ITM call
    const b1Before = await bal(e, h1.buyerUsdc), b2Before = await bal(e, h2.buyerUsdc);
    await autoFinalizeHolders(e, vault, m, vaultUsdc, [
      [h1.buyerOptionAta, h1.buyerUsdc],
      [h2.buyerOptionAta, h2.buyerUsdc],
    ]);
    assert.equal(await bal(e, h1.buyerOptionAta), 0n, "h1 burned");
    assert.equal(await bal(e, h2.buyerOptionAta), 0n, "h2 burned");
    const p1 = (await bal(e, h1.buyerUsdc)) - b1Before, p2 = (await bal(e, h2.buyerUsdc)) - b2Before;
    console.log(`    ITM holders paid: h1=${p1} h2=${p2}`);
    assert.isTrue(p1 > 0n && p2 > 0n, "both holders paid ITM intrinsic");
  });

  it("OTM call, 1 holder → burned, no USDC payout", async () => {
    const e = await setupEnv("AFHOTM", "afh-otm");
    const writer = actor(e), b1 = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "european", usdc(300), expiry, { call: {} }, writer);
    const wp = await deposit(e, vault, vaultUsdc, writer, 1000);
    const m = await mint(e, vault, wp, writer, 3, now, false);
    const h1 = await purchase(e, vault, wp, m, vaultUsdc, b1, 3);

    await settle(e, vault, expiry, 50); // OTM call
    const before = await bal(e, h1.buyerUsdc);
    await autoFinalizeHolders(e, vault, m, vaultUsdc, [[h1.buyerOptionAta, h1.buyerUsdc]]);
    assert.equal(await bal(e, h1.buyerOptionAta), 0n, "burned");
    assert.equal((await bal(e, h1.buyerUsdc)) - before, 0n, "OTM → no payout");
  });

  it("pre-settlement call → reverts VaultNotSettled", async () => {
    const e = await setupEnv("AFHPRE", "afh-pre");
    const writer = actor(e), b1 = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "european", usdc(170), expiry, { call: {} }, writer);
    const wp = await deposit(e, vault, vaultUsdc, writer, 1000);
    const m = await mint(e, vault, wp, writer, 2, now, false);
    const h1 = await purchase(e, vault, wp, m, vaultUsdc, b1, 1);

    let reverted = false, err = "";
    try {
      await autoFinalizeHolders(e, vault, m, vaultUsdc, [[h1.buyerOptionAta, h1.buyerUsdc]]);
    } catch (ex: any) { reverted = true; err = String(ex).slice(0, 140); }
    console.log(`    pre-settle reverted=${reverted} (${err})`);
    assert.isTrue(reverted && /VaultNotSettled/.test(err), "must revert VaultNotSettled");
  });
});
