// =============================================================================
// tests/bankrun/crit1-holders-first.test.ts
// Ported from tests/zzz-crit1-holders-first-gate.ts (describe.skip + 3 it.skip).
// The 24h EXERCISE_WINDOW "holders-first" gate: when total_options_sold > 0,
// writers cannot finalize until clock >= expiry + 24h. setClock makes the
// before/after-window boundary deterministic (the whole reason it was skipped).
// =============================================================================

import { assert } from "chai";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  setupEnv, createVault, deposit, mint, purchase, settle, withdrawPostSettlement,
  autoFinalizeWriters, usdc, bal, actor, getClockUnix, setClockUnix, BN, EXERCISE_WINDOW,
} from "./helpers";
const wAta = (m: any, o: any) => getAssociatedTokenAddressSync(m, o, false, TOKEN_PROGRAM_ID);

describe("bankrun: CRIT-1 holders-first 24h window gate", function () {
  this.timeout(180_000);

  it("BEFORE window + buyer exists → withdraw_post_settlement reverts HolderExerciseWindowOpen", async () => {
    const e = await setupEnv("CRIT1BW", "crit1-bw");
    const alice = actor(e), buyer = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "european", usdc(200), expiry, { call: {} }, alice);
    const wp = await deposit(e, vault, vaultUsdc, alice, 1000);
    const m = await mint(e, vault, wp, alice, 2, now, false);
    await purchase(e, vault, wp, m, vaultUsdc, buyer, 1); // total_options_sold = 1
    await settle(e, vault, expiry, 50); // clock = expiry+30 (< window)
    let reverted = false, err = "";
    try { await withdrawPostSettlement(e, vault, wp, alice); }
    catch (ex: any) { reverted = true; err = String(ex); } // full string — bankrun surfaces the AnchorError name in logs, not the head
    console.log(`    before-window reverted=${reverted} (${err})`);
    assert.isTrue(reverted && /HolderExerciseWindowOpen/.test(err), "must revert HolderExerciseWindowOpen");
  });

  it("AFTER window → withdraw_post_settlement succeeds", async () => {
    const e = await setupEnv("CRIT1AW", "crit1-aw");
    const alice = actor(e), buyer = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "european", usdc(200), expiry, { call: {} }, alice);
    const wp = await deposit(e, vault, vaultUsdc, alice, 1000);
    const m = await mint(e, vault, wp, alice, 2, now, false);
    await purchase(e, vault, wp, m, vaultUsdc, buyer, 1);
    await settle(e, vault, expiry, 50);
    await setClockUnix(e.h.context, expiry.toNumber() + EXERCISE_WINDOW + 60); // past 24h
    const aUsdc = wAta(e.usdcMint, alice.publicKey);
    const before = await bal(e, aUsdc);
    await withdrawPostSettlement(e, vault, wp, alice);
    const paid = (await bal(e, aUsdc)) - before;
    console.log(`    after-window payout=${paid}`);
    assert.isTrue(paid > 0n, "after window, writer withdraws");
  });

  it("no-buyer fast path → withdraw_post_settlement succeeds immediately (gate bypassed)", async () => {
    const e = await setupEnv("CRIT1NB", "crit1-nb");
    const alice = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "european", usdc(200), expiry, { call: {} }, alice);
    const wp = await deposit(e, vault, vaultUsdc, alice, 500);
    await settle(e, vault, expiry, 50); // total_options_sold == 0 → gate bypassed
    const aUsdc = wAta(e.usdcMint, alice.publicKey);
    const before = await bal(e, aUsdc);
    await withdrawPostSettlement(e, vault, wp, alice); // clock still expiry+30, succeeds
    const paid = (await bal(e, aUsdc)) - before;
    console.log(`    no-buyer fast-path payout=${paid}`);
    assert.equal(paid, 500_000_000n, "full collateral back immediately");
  });

  it("BEFORE window + buyer exists → auto_finalize_writers (batch) reverts HolderExerciseWindowOpen", async () => {
    const e = await setupEnv("CRIT1AFW", "crit1-afw");
    const alice = actor(e), buyer = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "european", usdc(200), expiry, { call: {} }, alice);
    const wp = await deposit(e, vault, vaultUsdc, alice, 1000);
    const m = await mint(e, vault, wp, alice, 2, now, false);
    await purchase(e, vault, wp, m, vaultUsdc, buyer, 1);
    await settle(e, vault, expiry, 50);
    let reverted = false, err = "";
    try {
      await autoFinalizeWriters(e, vault, vaultUsdc, [[wp, wAta(e.usdcMint, alice.publicKey), alice.publicKey]]);
    } catch (ex: any) { reverted = true; err = String(ex); } // full string — bankrun surfaces the AnchorError name in logs, not the head
    console.log(`    auto_finalize_writers before-window reverted=${reverted} (${err})`);
    assert.isTrue(reverted && /HolderExerciseWindowOpen/.test(err), "batch reverts HolderExerciseWindowOpen");
  });
});
