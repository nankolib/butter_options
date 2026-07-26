// =============================================================================
// tests/bankrun/auto-finalize-writers.test.ts
// Ported (representative) from tests/zzz-auto-finalize-writers.ts describe.skip.
//   - ITM call, 2 writers (Bob-deposits-first trick) → 50/50 pro-rata, both
//     positions closed, vault USDC closed (last-writer branch).
//   - single writer → last-writer branch, full collateral back.
//   - pre-settlement call → reverts VaultNotSettled.
// No buyers (total_options_sold == 0) → the 24h EXERCISE_WINDOW gate is bypassed.
// =============================================================================

import { assert } from "chai";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  setupEnv, createVault, deposit, mint, purchase, settle, autoFinalizeWriters,
  usdc, bal, exists, actor, getClockUnix, BN, pda,
} from "./helpers";
const wAta = (m: any, o: any) => getAssociatedTokenAddressSync(m, o, false, TOKEN_PROGRAM_ID);
const wpPda = (vault: any, w: any) => pda([Buffer.from("writer_position"), vault.toBuffer(), w.publicKey.toBuffer()]);

// Decode → mutate → re-encode an on-chain account, preserving length/owner/lamports.
// Used to install the exact drained-vault + zero-share-orphan state that the
// division guard targets (no clean instruction path produces it).
async function patchAccount(e: any, addr: any, nameHint: string, mutate: (o: any) => void) {
  const norm = (s: string) => s.toLowerCase().replace(/_/g, "");
  const idlName: string = e.opta.idl.accounts.find((a: any) => norm(a.name) === norm(nameHint)).name;
  const acc = await e.h.context.banksClient.getAccount(addr);
  const dec = e.opta.coder.accounts.decode(idlName, Buffer.from(acc.data));
  mutate(dec);
  const enc: Buffer = await e.opta.coder.accounts.encode(idlName, dec);
  const data = Buffer.alloc(acc.data.length);
  enc.copy(data);
  e.h.context.setAccount(addr, {
    lamports: acc.lamports, data, owner: acc.owner, executable: acc.executable, rentEpoch: Number(acc.rentEpoch),
  });
}

describe("bankrun: auto_finalize_writers", function () {
  this.timeout(180_000);

  it("ITM call, 2 writers → 50/50 pro-rata; positions + vault USDC closed", async () => {
    const e = await setupEnv("AFWITM", "afw-itm");
    const alice = actor(e), bob = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    // creator = alice; Bob deposits FIRST (total_shares==0 → gate exempt), then alice.
    const { vault, vaultUsdc } = await createVault(e, "european", usdc(80), expiry, { call: {} }, alice);
    const bobPos = await deposit(e, vault, vaultUsdc, bob, 500);
    const alicePos = await deposit(e, vault, vaultUsdc, alice, 500);

    await settle(e, vault, expiry, 250); // no buyers → no holder payout
    const aliceUsdc = wAta(e.usdcMint, alice.publicKey), bobUsdc = wAta(e.usdcMint, bob.publicKey);
    const aB = await bal(e, aliceUsdc), bB = await bal(e, bobUsdc);
    await autoFinalizeWriters(e, vault, vaultUsdc, [
      [bobPos, bobUsdc, bob.publicKey],
      [alicePos, aliceUsdc, alice.publicKey],
    ]);
    const aP = (await bal(e, aliceUsdc)) - aB, bP = (await bal(e, bobUsdc)) - bB;
    console.log(`    2-writer payouts: alice=${aP} bob=${bP}`);
    assert.equal(aP, 500_000_000n, "alice 50% = $500");
    assert.equal(bP, 500_000_000n, "bob 50% = $500");
    assert.isFalse(await exists(e, vaultUsdc), "vault USDC closed (last-writer branch)");
    assert.isFalse(await exists(e, bobPos), "bob position closed");
    assert.isFalse(await exists(e, alicePos), "alice position closed");
  });

  it("single writer → last-writer branch, full collateral back", async () => {
    const e = await setupEnv("AFWSINGLE", "afw-single");
    const alice = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "european", usdc(81), expiry, { call: {} }, alice);
    const alicePos = await deposit(e, vault, vaultUsdc, alice, 800);
    await settle(e, vault, expiry, 50); // OTM, no buyers
    const aliceUsdc = wAta(e.usdcMint, alice.publicKey);
    const before = await bal(e, aliceUsdc);
    await autoFinalizeWriters(e, vault, vaultUsdc, [[alicePos, aliceUsdc, alice.publicKey]]);
    const paid = (await bal(e, aliceUsdc)) - before;
    console.log(`    single-writer payout=${paid}`);
    assert.equal(paid, 800_000_000n, "full collateral back ($800)");
    assert.isFalse(await exists(e, vaultUsdc), "vault USDC closed");
  });

  it("drained vault (total_shares==0) + zero-share orphan → guard no-ops, closes orphan, no 6017", async () => {
    const e = await setupEnv("AFWORPH", "afw-orph");
    const alice = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "european", usdc(90), expiry, { call: {} }, alice);
    const alicePos = await deposit(e, vault, vaultUsdc, alice, 700);
    await settle(e, vault, expiry, 50); // OTM, no buyers → holder window bypassed

    // Install the on-chain orphan state the fix targets: vault fully drained
    // (total_shares / collateral zeroed by an earlier path) while a residual
    // zero-share WriterPosition and the vault USDC account both linger. Pre-fix,
    // finalize here hit checked_div(total_shares=0) → MathOverflow (6017) and
    // reverted forever, so the crank re-detected and retried it every tick.
    await patchAccount(e, vault, "SharedVault", (v: any) => {
      v.totalShares = new BN(0);
      v.collateralRemaining = new BN(0);
      v.totalCollateral = new BN(0);
    });
    await patchAccount(e, alicePos, "WriterPosition", (p: any) => {
      p.shares = new BN(0);
    });

    assert.isTrue(await exists(e, alicePos), "orphan position present before finalize");
    const aliceUsdc = wAta(e.usdcMint, alice.publicKey);
    const before = await bal(e, aliceUsdc);

    // Must NOT revert (the guard) and must dispose the orphan via the step-8 close.
    await autoFinalizeWriters(e, vault, vaultUsdc, [[alicePos, aliceUsdc, alice.publicKey]]);

    const paid = (await bal(e, aliceUsdc)) - before;
    console.log(`    drained-orphan payout=${paid} (expect 0)`);
    assert.equal(paid, 0n, "no-op payout on a drained vault");
    assert.isFalse(await exists(e, alicePos), "orphan position disposed (closed)");
    assert.isFalse(await exists(e, vaultUsdc), "vault USDC closed (post-loop total_shares==0)");
  });

  it("pre-settlement call → reverts VaultNotSettled", async () => {
    const e = await setupEnv("AFWPRE", "afw-pre");
    const alice = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "european", usdc(100), expiry, { call: {} }, alice);
    const alicePos = await deposit(e, vault, vaultUsdc, alice, 100);
    let reverted = false, err = "";
    try {
      await autoFinalizeWriters(e, vault, vaultUsdc, [[alicePos, wAta(e.usdcMint, alice.publicKey), alice.publicKey]]);
    } catch (ex: any) { reverted = true; err = String(ex).slice(0, 140); }
    console.log(`    pre-settle reverted=${reverted} (${err})`);
    assert.isTrue(reverted && /VaultNotSettled/.test(err), "must revert VaultNotSettled");
  });
});
