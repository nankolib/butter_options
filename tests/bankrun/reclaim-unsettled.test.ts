// =============================================================================
// tests/bankrun/reclaim-unsettled.test.ts — Phase 2 Pass D dead-feed hatch
// =============================================================================
// reclaim_unsettled: writers reclaim pooled collateral pro-rata from a vault
// whose settlement price NEVER landed (no SettlementRecord), once the 7-day
// GRACE_WINDOW past expiry has elapsed. setClock makes the grace boundary
// deterministic. Also exercises the four defensive `!voided` guards (settle_vault,
// withdraw_from_vault, exercise_from_vault, auto_finalize_holders).
// =============================================================================

import { assert } from "chai";
import { SystemProgram, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
  setupEnv, createVault, deriveVault, deposit, mint, purchase, settleExpiry, settlementRecordPda,
  exerciseFromVault, exerciseAmerican, autoFinalizeHolders, withdrawFromVault, claimPremium,
  usdcAta, usdc, bal, actor, getClockUnix, setClockUnix, pda, BN, Keypair,
} from "./helpers";

const GRACE_WINDOW = 604_800; // 7 days — mirrors state/shared_vault.rs::GRACE_WINDOW
const wAta = (m: any, o: any) => getAssociatedTokenAddressSync(m, o, false, TOKEN_PROGRAM_ID);
const CU = (u: number) => ComputeBudgetProgram.setComputeUnitLimit({ units: u });
const EPOCH_DAY = 5, EPOCH_HOUR = 8; // Friday 08:00 UTC (initialize_epoch_config defaults)

/** Next Friday-08:00-UTC boundary ≥ ~2 days out (min_epoch_duration_days = 1). */
function nextFridayExpiry(from: number): number {
  const SPD = 86400, SPH = 3600;
  const d = Math.floor(from / SPD);
  const dow = (d + 4) % 7;
  const daysUntil = dow <= EPOCH_DAY ? EPOCH_DAY - dow : 7 - dow + EPOCH_DAY;
  let t = (d + daysUntil) * SPD + EPOCH_HOUR * SPH;
  while (t < from + 2 * SPD) t += 7 * SPD;
  return t;
}

/** One-time epoch schedule (Friday 08:00 UTC) so Epoch (multi-writer) vaults are legal. */
async function initEpochConfig(e: any) {
  const epochConfig = pda([Buffer.from("epoch_config")]);
  await e.opta.methods.initializeEpochConfig(EPOCH_DAY, EPOCH_HOUR, true).accountsStrict({
    admin: e.admin.publicKey, protocolState: e.protocolState, epochConfig,
    systemProgram: SystemProgram.programId,
  }).rpc();
  return epochConfig;
}

/** create_shared_vault as an Epoch (pooled, multi-writer) vault. */
async function createEpochVault(e: any, style: "european" | "american", strike: BN, expiry: BN, optionType: any, creator: Keypair, epochConfig: any) {
  const { vault, vaultUsdc } = deriveVault(e, style, strike, expiry, optionType);
  const styleArg = style === "american" ? { american: {} } : { european: {} };
  await e.opta.methods.createSharedVault(strike, expiry, optionType, { epoch: {} }, e.usdcMint, 0, styleArg)
    .accountsStrict({
      creator: creator.publicKey, market: e.market, sharedVault: vault, vaultUsdcAccount: vaultUsdc,
      usdcMint: e.usdcMint, protocolState: e.protocolState, epochConfig,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).preInstructions([CU(400_000)]).signers([creator]).rpc();
  return { vault, vaultUsdc };
}

/** reclaim_unsettled — permissionless: `cranker` signs, payout lands in `writer`'s USDC ATA. */
async function reclaimUnsettled(e: any, vault: any, expiry: BN, writer: Keypair, cranker: Keypair) {
  const wp = pda([Buffer.from("writer_position"), vault.toBuffer(), writer.publicKey.toBuffer()]);
  const vaultUsdc = pda([Buffer.from("vault_usdc"), vault.toBuffer()]);
  const writerUsdc = await usdcAta(e, writer.publicKey);
  await e.opta.methods.reclaimUnsettled().accountsStrict({
    cranker: cranker.publicKey,
    writer: writer.publicKey,
    sharedVault: vault,
    writerPosition: wp,
    market: e.market,
    settlementRecord: settlementRecordPda(e, expiry),
    vaultUsdcAccount: vaultUsdc,
    writerUsdcAccount: writerUsdc,
    tokenProgram: TOKEN_PROGRAM_ID,
  }).signers([cranker]).rpc();
}

describe("bankrun: reclaim_unsettled (Pass D dead-feed hatch)", function () {
  this.timeout(180_000);

  it("happy path: dead-feed vault → writer reclaims pro-rata, voided=true, position zeroed", async () => {
    const e = await setupEnv("RECLAIM1", "reclaim1");
    const writer = actor(e), cranker = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "american", usdc(100), expiry, { call: {} }, writer);
    const wp = await deposit(e, vault, vaultUsdc, writer, 1000);

    // Never settle. Advance past the 7-day grace window.
    await setClockUnix(e.h.context, expiry.toNumber() + GRACE_WINDOW + 60);
    const wusdc = wAta(e.usdcMint, writer.publicKey);
    const before = await bal(e, wusdc);
    await reclaimUnsettled(e, vault, expiry, writer, cranker);
    const paid = (await bal(e, wusdc)) - before;

    const v: any = await e.opta.account.sharedVault.fetch(vault);
    const pos: any = await e.opta.account.writerPosition.fetch(wp);
    console.log(`    happy paid=${paid} voided=${v.voided} isSettled=${v.isSettled} shares=${pos.shares}`);
    assert.equal(paid, 1_000_000_000n, "full collateral reclaimed (1000 USDC)");
    assert.isTrue(v.voided, "voided set true");
    assert.isFalse(v.isSettled, "NEVER settled (invariant #6)");
    assert.equal(pos.shares.toString(), "0", "position shares zeroed");
  });

  it("European dead-feed vault → reclaim works universally (not American-gated)", async () => {
    // reclaim_unsettled is ungated by exercise_style — it signs via
    // vault_namespace_seed, which resolves the European prefix here. Proves the
    // European path ships tested even though series vaults are American.
    const e = await setupEnv("RECLAIMEUR", "reclaim-eur");
    const writer = actor(e), cranker = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "european", usdc(100), expiry, { call: {} }, writer);
    const wp = await deposit(e, vault, vaultUsdc, writer, 750);

    await setClockUnix(e.h.context, expiry.toNumber() + GRACE_WINDOW + 60);
    const wusdc = wAta(e.usdcMint, writer.publicKey);
    const before = await bal(e, wusdc);
    await reclaimUnsettled(e, vault, expiry, writer, cranker);
    const paid = (await bal(e, wusdc)) - before;

    const v: any = await e.opta.account.sharedVault.fetch(vault);
    const pos: any = await e.opta.account.writerPosition.fetch(wp);
    console.log(`    EUR paid=${paid} voided=${v.voided} isSettled=${v.isSettled} shares=${pos.shares}`);
    assert.equal(paid, 750_000_000n, "European writer reclaims full collateral (750 USDC)");
    assert.isTrue(v.voided, "voided set true on European vault");
    assert.isFalse(v.isSettled, "European voided vault NEVER settled");
    assert.equal(pos.shares.toString(), "0", "European position shares zeroed");
  });

  it("multi-writer: both reclaim; 2nd NOT blocked by voided; sum == total_collateral", async () => {
    const e = await setupEnv("RECLAIM2", "reclaim2");
    const epochConfig = await initEpochConfig(e);
    const w1 = actor(e), w2 = actor(e), cranker = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(nextFridayExpiry(now));
    const { vault, vaultUsdc } = await createEpochVault(e, "european", usdc(100), expiry, { call: {} }, w1, epochConfig);
    await deposit(e, vault, vaultUsdc, w1, 600);
    await deposit(e, vault, vaultUsdc, w2, 400);

    await setClockUnix(e.h.context, expiry.toNumber() + GRACE_WINDOW + 60);
    const u1 = wAta(e.usdcMint, w1.publicKey), u2 = wAta(e.usdcMint, w2.publicKey);
    const b1 = await bal(e, u1), b2 = await bal(e, u2);

    await reclaimUnsettled(e, vault, expiry, w1, cranker);
    const v1: any = await e.opta.account.sharedVault.fetch(vault);
    assert.isTrue(v1.voided, "first reclaim flips voided");

    // Second writer must NOT be blocked by voided (idempotency is per-position).
    await reclaimUnsettled(e, vault, expiry, w2, cranker);
    const p1 = (await bal(e, u1)) - b1, p2 = (await bal(e, u2)) - b2;
    console.log(`    p1=${p1} p2=${p2} sum=${p1 + p2}`);
    assert.equal(p1, 600_000_000n, "w1 pro-rata 600/1000");
    assert.equal(p2, 400_000_000n, "w2 pro-rata 400/1000 (last writer absorbs dust)");
    assert.equal(p1 + p2, 1_000_000_000n, "sum == total_collateral (early_exercise_payout=0)");
  });

  it("early-exercise netting: reclaim base nets early_exercise_payout", async () => {
    const e = await setupEnv("RECLAIM3", "reclaim3");
    const writer = actor(e), buyer = actor(e), cranker = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "american", usdc(100), expiry, { call: {} }, writer);
    const wp = await deposit(e, vault, vaultUsdc, writer, 2000);
    const m = await mint(e, vault, wp, writer, 10, now, true);
    const { buyerOptionAta, buyerUsdc } = await purchase(e, vault, wp, m, vaultUsdc, buyer, 5);

    // Buyer early-exercises 1 ITM contract (spot $150, strike $100 → $50 capped at strike).
    await exerciseAmerican(e, vault, m, buyer, buyerOptionAta, buyerUsdc, 1, 150, now + 5);
    const vPre: any = await e.opta.account.sharedVault.fetch(vault);
    assert.equal(vPre.earlyExercisePayout.toString(), "50000000", "early_exercise_payout = $50");

    // Writer must clear premium first (decision 4), then reclaim after grace.
    await claimPremium(e, vault, wp, writer);
    await setClockUnix(e.h.context, expiry.toNumber() + GRACE_WINDOW + 60);
    const wusdc = wAta(e.usdcMint, writer.publicKey);
    const before = await bal(e, wusdc);
    await reclaimUnsettled(e, vault, expiry, writer, cranker);
    const paid = (await bal(e, wusdc)) - before;
    console.log(`    netting paid=${paid} (expected 2000 - 50 = 1950)`);
    assert.equal(paid, 1_950_000_000n, "base = total_collateral (2000) - early_exercise_payout (50)");
  });

  it("revert: SettlementRecord exists → SettlementRecordExists (6057)", async () => {
    const e = await setupEnv("RECLAIM4", "reclaim4");
    const writer = actor(e), cranker = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "american", usdc(100), expiry, { call: {} }, writer);
    await deposit(e, vault, vaultUsdc, writer, 1000);

    await setClockUnix(e.h.context, expiry.toNumber() + GRACE_WINDOW + 60);
    await settleExpiry(e, expiry, 120, expiry.toNumber() + 5); // record now EXISTS (feed was alive)
    let reverted = false, err = "";
    try { await reclaimUnsettled(e, vault, expiry, writer, cranker); }
    catch (ex: any) { reverted = true; err = String(ex); }
    console.log(`    record-present reverted=${reverted} (${err.slice(0, 120)})`);
    assert.isTrue(reverted && /SettlementRecordExists/.test(err), "must revert SettlementRecordExists");
  });

  it("revert: grace window not elapsed → GracePeriodNotElapsed (6058)", async () => {
    const e = await setupEnv("RECLAIM5", "reclaim5");
    const writer = actor(e), cranker = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "american", usdc(100), expiry, { call: {} }, writer);
    await deposit(e, vault, vaultUsdc, writer, 1000);

    // Past expiry but BEFORE grace end.
    await setClockUnix(e.h.context, expiry.toNumber() + 30);
    let reverted = false, err = "";
    try { await reclaimUnsettled(e, vault, expiry, writer, cranker); }
    catch (ex: any) { reverted = true; err = String(ex); }
    console.log(`    pre-grace reverted=${reverted} (${err.slice(0, 120)})`);
    assert.isTrue(reverted && /GracePeriodNotElapsed/.test(err), "must revert GracePeriodNotElapsed");
  });

  it("revert: unclaimed premium → ClaimPremiumFirst", async () => {
    const e = await setupEnv("RECLAIM6", "reclaim6");
    const writer = actor(e), buyer = actor(e), cranker = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "american", usdc(100), expiry, { call: {} }, writer);
    const wp = await deposit(e, vault, vaultUsdc, writer, 2000);
    const m = await mint(e, vault, wp, writer, 10, now, true);
    await purchase(e, vault, wp, m, vaultUsdc, buyer, 5); // accrues premium to the writer

    await setClockUnix(e.h.context, expiry.toNumber() + GRACE_WINDOW + 60);
    let reverted = false, err = "";
    try { await reclaimUnsettled(e, vault, expiry, writer, cranker); } // premium NOT claimed
    catch (ex: any) { reverted = true; err = String(ex); }
    console.log(`    unclaimed-premium reverted=${reverted} (${err.slice(0, 120)})`);
    assert.isTrue(reverted && /ClaimPremiumFirst/.test(err), "must revert ClaimPremiumFirst");
  });

  it("revert: double-claim same writer → zero-shares (InsufficientCollateral)", async () => {
    const e = await setupEnv("RECLAIM7", "reclaim7");
    // Distinct crankers so the two reclaim txs have different signatures —
    // identical txs would share a signature and bankrun would treat the 2nd as
    // "already processed" (no re-execution), masking the zero-shares guard.
    const writer = actor(e), cranker = actor(e), cranker2 = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "american", usdc(100), expiry, { call: {} }, writer);
    await deposit(e, vault, vaultUsdc, writer, 1000);

    await setClockUnix(e.h.context, expiry.toNumber() + GRACE_WINDOW + 60);
    await reclaimUnsettled(e, vault, expiry, writer, cranker); // first claim: shares → 0
    let reverted = false, err = "";
    try { await reclaimUnsettled(e, vault, expiry, writer, cranker2); } // second claim (distinct signer)
    catch (ex: any) { reverted = true; err = String(ex); }
    console.log(`    double-claim reverted=${reverted} (${err.slice(0, 120)})`);
    assert.isTrue(reverted && /InsufficientCollateral/.test(err), "must revert InsufficientCollateral");
  });

  it("guards: settle_vault + withdraw_from_vault on a voided vault → VaultVoided (6056)", async () => {
    const e = await setupEnv("RECLAIM8", "reclaim8");
    const epochConfig = await initEpochConfig(e);
    const w1 = actor(e), w2 = actor(e), cranker = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(nextFridayExpiry(now));
    const { vault, vaultUsdc } = await createEpochVault(e, "european", usdc(100), expiry, { call: {} }, w1, epochConfig);
    const wp2 = pda([Buffer.from("writer_position"), vault.toBuffer(), w2.publicKey.toBuffer()]);
    await deposit(e, vault, vaultUsdc, w1, 600);
    await deposit(e, vault, vaultUsdc, w2, 400);

    await setClockUnix(e.h.context, expiry.toNumber() + GRACE_WINDOW + 60);
    await reclaimUnsettled(e, vault, expiry, w1, cranker); // voids vault; w2 still has shares

    // settle_vault: create a (late) record so the handler reaches the !voided guard.
    await settleExpiry(e, expiry, 120, expiry.toNumber() + 5);
    let svReverted = false, svErr = "";
    try {
      await e.opta.methods.settleVault().accountsStrict({
        authority: e.admin.publicKey, sharedVault: vault, market: e.market,
        settlementRecord: settlementRecordPda(e, expiry),
        vaultUsdcAccount: null, writerAskPot: null, writerAskPotUsdc: null, protocolState: null, tokenProgram: null,
      }).rpc();
    } catch (ex: any) { svReverted = true; svErr = String(ex); }
    console.log(`    settle_vault reverted=${svReverted} (${svErr.slice(0, 120)})`);
    assert.isTrue(svReverted && /VaultVoided/.test(svErr), "settle_vault → VaultVoided");

    // withdraw_from_vault: w2 still holds shares but the vault is voided.
    let wReverted = false, wErr = "";
    try { await withdrawFromVault(e, vault, wp2, w2, 100); }
    catch (ex: any) { wReverted = true; wErr = String(ex); }
    console.log(`    withdraw_from_vault reverted=${wReverted} (${wErr.slice(0, 120)})`);
    assert.isTrue(wReverted && /VaultVoided/.test(wErr), "withdraw_from_vault → VaultVoided");
  });

  it("guards: exercise_from_vault + auto_finalize_holders on a voided vault → VaultVoided (6056)", async () => {
    const e = await setupEnv("RECLAIM9", "reclaim9");
    const writer = actor(e), buyer = actor(e), cranker = actor(e);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * 86_400);
    const { vault, vaultUsdc } = await createVault(e, "american", usdc(100), expiry, { call: {} }, writer);
    const wp = await deposit(e, vault, vaultUsdc, writer, 2000);
    const m = await mint(e, vault, wp, writer, 10, now, true);
    const { buyerOptionAta, buyerUsdc } = await purchase(e, vault, wp, m, vaultUsdc, buyer, 5);

    await claimPremium(e, vault, wp, writer); // so the writer reclaim doesn't trip ClaimPremiumFirst
    await setClockUnix(e.h.context, expiry.toNumber() + GRACE_WINDOW + 60);
    await reclaimUnsettled(e, vault, expiry, writer, cranker); // voids vault

    // exercise_from_vault: holder still holds tokens but the vault is voided.
    let xReverted = false, xErr = "";
    try { await exerciseFromVault(e, vault, m, buyer, buyerOptionAta, buyerUsdc, 1); }
    catch (ex: any) { xReverted = true; xErr = String(ex); }
    console.log(`    exercise_from_vault reverted=${xReverted} (${xErr.slice(0, 120)})`);
    assert.isTrue(xReverted && /VaultVoided/.test(xErr), "exercise_from_vault → VaultVoided");

    // auto_finalize_holders: empty batch still reaches the !voided guard first.
    let afReverted = false, afErr = "";
    try { await autoFinalizeHolders(e, vault, m, vaultUsdc, []); }
    catch (ex: any) { afReverted = true; afErr = String(ex); }
    console.log(`    auto_finalize_holders reverted=${afReverted} (${afErr.slice(0, 120)})`);
    assert.isTrue(afReverted && /VaultVoided/.test(afErr), "auto_finalize_holders → VaultVoided");
  });
});
