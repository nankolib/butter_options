// =============================================================================
// tests/bankrun/writer-ask-settle.test.ts — Phase 3 Slice D1: settle pot-sweep
// =============================================================================
// settle_vault folds the writer-ask pot into the waterfall: sweeps
// pot.total_collateral (the COUNTER, donation-proof) pot_usdc → vault_usdc, sets
// collateral_remaining = (total_collateral + swept) − early_exercise_payout, and
// records writer_ask_collateral_swept. The pot accounts are TRAILING OPTIONALS →
// None for EUR / pool-only vaults → byte-identical settlement (the elevated bar).
// Testing build (WRITER_ASKS_ENABLED true). cpt = strike per vault, fee 50bps.
// =============================================================================

import {
  PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import { assert } from "chai";
import {
  setupEnv, createVault, deposit, createSeries, usdcAta, bal, exists, bumpTokenAmount,
  actor, pda, getClockUnix, setClockUnix, settleExpiry, settlementRecordPda, deriveVaultUsdc,
  exerciseFromVault, HOOK_PROGRAM_ID, CU, usdc, Env, settlePotAccounts,
  deriveVault, exerciseAmerican,
} from "./helpers";
import { settlePotPdas } from "../shared/settle-pdas";

const RESTING_ORDER_SEED = Buffer.from("resting_order");
const RESTING_ORDER_ESCROW_SEED = Buffer.from("resting_order_escrow");
// Pot seeds now sourced from ../shared/settle-pdas (settlePotPdas) — single source.
const WRITER_ASK_POSITION_SEED = Buffer.from("writer_ask_position");
const WRITER_ASK = { writerAsk: {} };

interface VaultCtx { vault: PublicKey; vaultUsdc: PublicKey; writerPos: PublicKey; }

describe("writer-ask settle pot-sweep (Phase 3 Slice D1)", function () {
  this.timeout(180_000);

  let e: Env;
  let writer: Keypair;
  let expiry: BN;
  let A: VaultCtx, B: VaultCtx, C: VaultCtx, D: VaultCtx;
  let mA: any, mD: any;              // series mints with WriterAsk pots
  let takerA: Keypair, takerD: Keypair;
  const nA = new BN(910), nD = new BN(911);
  let caStamp = 7000;

  const potPdas = (m: PublicKey, backer: PublicKey) => {
    const { writerAskPot, writerAskPotUsdc } = settlePotPdas(e.opta.programId, m);
    return {
      pot: writerAskPot,
      potUsdc: writerAskPotUsdc,
      position: pda([WRITER_ASK_POSITION_SEED, m.toBuffer(), backer.toBuffer()]),
    };
  };
  const orderPdas = (m: PublicKey, owner: PublicKey, nonce: BN) => {
    const order = pda([RESTING_ORDER_SEED, m.toBuffer(), owner.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)]);
    return { order, escrow: pda([RESTING_ORDER_ESCROW_SEED, order.toBuffer()]) };
  };
  const potAcc = (p: PublicKey) => (e.opta.account as any).writerAskPot.fetch(p);
  const vaultAcc = (v: PublicKey) => (e.opta.account as any).sharedVault.fetch(v);

  async function sendTx(ixs: any[], signer: Keypair, expectError = false) {
    const tx = new Transaction().add(...ixs);
    tx.feePayer = signer.publicKey; tx.recentBlockhash = e.h.context.lastBlockhash; tx.sign(signer);
    const res = await e.h.context.banksClient.tryProcessTransaction(tx);
    const logs = (res.meta?.logMessages ?? []) as string[];
    if (!expectError && res.result) throw new Error("tx failed: " + JSON.stringify(res.result) + "\n" + logs.join("\n"));
    return { result: res.result, logs };
  }

  async function mkAmer(strike: BN): Promise<VaultCtx> {
    const cv = await createVault(e, "american", strike, expiry, { call: {} }, writer);
    const wp = await deposit(e, cv.vault, cv.vaultUsdc, writer, 100_000);
    return { vault: cv.vault, vaultUsdc: cv.vaultUsdc, writerPos: wp };
  }
  // D2.5: writer-asks rest on the CANONICAL create_series mint for the vault's
  // spec. Distinct strikes per vault (A=$10, D=$13) → distinct canonical mints.
  async function mkSeriesOn(v: VaultCtx, strike: BN): Promise<any> {
    void v;
    return createSeries(e, strike, expiry, { call: {} });
  }
  async function postWriterAskOn(v: VaultCtx, m: any, price: BN, qty: number, nonce: BN) {
    const { order, escrow } = orderPdas(m.optionMint, writer.publicKey, nonce);
    const ownerUsdc = await usdcAta(e, writer.publicKey);
    const ownerOpt = getAssociatedTokenAddressSync(m.optionMint, writer.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const ix = await e.opta.methods.postOrder(WRITER_ASK, price, new BN(qty), nonce).accountsStrict({
      owner: writer.publicKey, sharedVault: v.vault, market: e.market, vaultMintRecord: m.vaultMintRecord,
      optionMint: m.optionMint, order, escrow, protocolState: e.protocolState,
      ownerOptionAccount: ownerOpt, ownerUsdcAccount: ownerUsdc, usdcMint: e.usdcMint,
      transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: m.extraMetas, hookState: m.hookState,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(400_000)]).instruction();
    await sendTx([ix], writer);
  }
  async function fillWriterAskOn(v: VaultCtx, m: any, nonce: BN, taker: Keypair, fillQty: number) {
    const { order, escrow } = orderPdas(m.optionMint, writer.publicKey, nonce);
    const { pot, potUsdc, position } = potPdas(m.optionMint, writer.publicKey);
    const takerUsdc = await usdcAta(e, taker.publicKey);
    const makerUsdc = getAssociatedTokenAddressSync(e.usdcMint, writer.publicKey, false, TOKEN_PROGRAM_ID);
    const takerOpt = getAssociatedTokenAddressSync(m.optionMint, taker.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      taker.publicKey, takerOpt, taker.publicKey, m.optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const ix = await e.opta.methods.fillWriterAsk(new BN(fillQty)).accountsStrict({
      taker: taker.publicKey, optionMint: m.optionMint, order, maker: writer.publicKey, sharedVault: v.vault,
      vaultMintRecord: m.vaultMintRecord, escrow, protocolState: e.protocolState, treasury: e.treasury,
      takerUsdcAccount: takerUsdc, makerUsdcAccount: makerUsdc, takerOptionAccount: takerOpt,
      writerAskPot: pot, writerAskPotUsdc: potUsdc, writerAskPosition: position, usdcMint: e.usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).instruction();
    await sendTx([CU(400_000), ataIx, ix], taker);
  }
  // settle_vault — pot variant (Some) or no-pot (null). Assumes the SettlementRecord
  // already exists (created once below) and the clock is past expiry.
  // settle_vault's `authority` is permissionless — pass a distinct `auth` signer
  // to vary the tx signature (bankrun dedups byte-identical txs on the same
  // un-advanced blockhash).
  async function settleVaultOnly(v: VaultCtx, m: any | null, expectError = false, auth: Keypair = e.admin) {
    // Phase 3 retro-harden: pot is un-omittable — derive all 6 from vault identity.
    const sp = await settlePotAccounts(e, v.vault);
    if (m) {
      // Loud-fail any canonical-pin mismatch: the vault-derived pot MUST equal the
      // pot the fills funded (potPdas keys off the same canonical series mint).
      assert.isTrue(sp.optionMint.equals(m.optionMint), "derived series mint == funded series mint");
      assert.isTrue(sp.writerAskPot.equals(potPdas(m.optionMint, writer.publicKey).pot), "derived pot == funded pot");
    }
    const accs: any = {
      authority: auth.publicKey, sharedVault: v.vault, market: e.market,
      settlementRecord: settlementRecordPda(e, expiry),
      ...sp,
    };
    const ix = await e.opta.methods.settleVault().accountsStrict(accs).instruction();
    return sendTx([CU(400_000), ix], auth, expectError);
  }

  before(async () => {
    e = await setupEnv("WASETTLE", "wa-settle-feed", 100);
    writer = actor(e);
    await usdcAta(e, writer.publicKey, 10_000_000_000_000n);
    await usdcAta(e, writer.publicKey);
    const now = await getClockUnix(e.h.context);
    expiry = new BN(now + 3600);

    // A: American + pot (canonical-mint WriterAsk fill 4). strike $10. Passive LP
    // (deposit only) — the pool sale was incidental; the merge is deposit + pot.
    A = await mkAmer(usdc(10));
    mA = await mkSeriesOn(A, usdc(10));
    await postWriterAskOn(A, mA, usdc(7), 4, nA);
    takerA = actor(e);
    await fillWriterAskOn(A, mA, nA, takerA, 4); // pot = cpt($10)×4 = $40

    // B: American, pool-only (no pot). strike $11.
    B = await mkAmer(usdc(11));

    // C: European, no pot. strike $12.
    {
      const cv = await createVault(e, "european", usdc(12), expiry, { call: {} }, writer);
      const wp = await deposit(e, cv.vault, cv.vaultUsdc, writer, 100_000);
      C = { vault: cv.vault, vaultUsdc: cv.vaultUsdc, writerPos: wp };
    }

    // D: American + pot, for the donation test. strike $13.
    D = await mkAmer(usdc(13));
    mD = await mkSeriesOn(D, usdc(13));
    await postWriterAskOn(D, mD, usdc(7), 2, nD);
    takerD = actor(e);
    await fillWriterAskOn(D, mD, nD, takerD, 2); // pot = cpt($13)×2 = $26
  });

  it("1 — sweep-with-pot: pot USDC folded into vault, collateral_remaining + field correct, once", async () => {
    const { potUsdc } = potPdas(mA.optionMint, writer.publicKey);
    const before: any = await vaultAcc(A.vault);
    const potBal = await bal(e, potUsdc);
    const potRec: any = await potAcc(potPdas(mA.optionMint, writer.publicKey).pot);
    const swept = new BN(potRec.totalCollateral.toString());
    assert.equal(potBal.toString(), swept.toString(), "pot USDC == counter pre-settle (cpt×4 = $40)");
    const vaultUsdcBefore = await bal(e, A.vaultUsdc);

    // warp + create the shared SettlementRecord (ITM CALL at $15) + settle A.
    const exp = expiry.toNumber();
    await setClockUnix(e.h.context, exp + 30);
    await settleExpiry(e, expiry, 15, exp + 5);
    await settleVaultOnly(A, mA);

    const after: any = await vaultAcc(A.vault);
    assert.equal((await bal(e, A.vaultUsdc) - vaultUsdcBefore).toString(), swept.toString(), "pot USDC swept into vault_usdc");
    assert.equal((await bal(e, potUsdc)).toString(), "0", "pot_usdc drained to 0");
    assert.equal(after.writerAskCollateralSwept.toString(), swept.toString(), "writer_ask_collateral_swept == pot.total_collateral");
    const expectedCR = new BN(before.totalCollateral.toString()).add(swept).sub(new BN(before.earlyExercisePayout.toString()));
    assert.equal(after.collateralRemaining.toString(), expectedCR.toString(), "collateral_remaining = (total_collateral + swept) − early_exercise_payout");
    assert.isTrue(after.isSettled, "settled");
  });

  it("2 — merged holder exercise: a WriterAsk-minted holder is paid from merged collateral", async () => {
    // takerA holds 4 WriterAsk-minted contracts of series A. CALL strike $10,
    // settle $15 → capped intrinsic $5/contract (≤ cpt $10).
    const takerUsdc = await usdcAta(e, takerA.publicKey);
    const takerOpt = getAssociatedTokenAddressSync(mA.optionMint, takerA.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const crBefore = new BN((await vaultAcc(A.vault)).collateralRemaining.toString());
    const usdcBefore = await bal(e, takerUsdc);
    await exerciseFromVault(e, A.vault, mA, takerA, takerOpt, takerUsdc, 4);
    const paid = usdc(5).muln(4); // $5 × 4
    assert.equal((await bal(e, takerUsdc) - usdcBefore).toString(), paid.toString(), "WriterAsk holder paid capped intrinsic from merged pool");
    const crAfter = new BN((await vaultAcc(A.vault)).collateralRemaining.toString());
    assert.equal(crBefore.sub(crAfter).toString(), paid.toString(), "collateral_remaining decremented by the payout");
  });

  it("3 — no-pot byte-identity: pool-only American + EUR settle unchanged, swept == 0", async () => {
    for (const v of [B, C]) {
      const before: any = await vaultAcc(v.vault);
      await settleVaultOnly(v, null); // null optionals
      const after: any = await vaultAcc(v.vault);
      assert.equal(after.writerAskCollateralSwept.toString(), "0", "no pot → swept == 0");
      const expectedCR = new BN(before.totalCollateral.toString()).sub(new BN(before.earlyExercisePayout.toString()));
      assert.equal(after.collateralRemaining.toString(), expectedCR.toString(), "collateral_remaining == total_collateral − early_exercise (unchanged)");
      assert.isTrue(after.isSettled);
    }
  });

  it("4 — idempotent: second settle_vault reverts (VaultAlreadySettled)", async () => {
    // Fresh signer so the tx is not a byte-identical duplicate of test 1's settle
    // (bankrun dedups identical messages on the same blockhash before the program runs).
    const r = await settleVaultOnly(A, mA, true, actor(e));
    assert.isNotNull(r.result, "re-settle must fail");
    assert.isTrue(r.logs.join("\n").includes("VaultAlreadySettled"), "error = VaultAlreadySettled");
  });

  it("5 — donation-proof: donate USDC into pot_usdc → only the counter is swept, donation stranded", async () => {
    const { pot, potUsdc } = potPdas(mD.optionMint, writer.publicKey);
    const potRec: any = await potAcc(pot);
    const counter = new BN(potRec.totalCollateral.toString());
    await bumpTokenAmount(e, potUsdc, 9_000_000); // donate $9 of dust
    assert.equal((await bal(e, potUsdc)).toString(), counter.addn(9_000_000).toString(), "pot_usdc inflated by donation");
    const vaultUsdcBefore = await bal(e, D.vaultUsdc);

    await settleVaultOnly(D, mD); // record already exists (created in test 1), clock past expiry

    const after: any = await vaultAcc(D.vault);
    assert.equal(after.writerAskCollateralSwept.toString(), counter.toString(), "swept == counter, NOT the inflated balance");
    assert.equal((await bal(e, D.vaultUsdc) - vaultUsdcBefore).toString(), counter.toString(), "only counter moved into vault_usdc");
    assert.equal((await bal(e, potUsdc)).toString(), "9000000", "donation stranded in pot_usdc (acceptable)");
  });
});

// =============================================================================
// D1 addendum (2026-08-15) — settle AFTER a POT-FUNDED early exercise
// =============================================================================
// The pot leg in american_exercise_core pays the shortfall a zero-pool vault's
// own USDC account cannot, and debits WriterAskPot.total_collateral to keep the
// counter level with the token account. settle_vault then sweeps that ALREADY
// REDUCED counter — so a pot-funded payout has self-accounted by the time
// settlement runs. Subtracting it a SECOND time via early_exercise_payout
// removes the same dollars twice: CRITICAL-01's double-deduction, recurring in
// a new place. early_exercise_payout must therefore count the VAULT-funded leg
// only.
//
// Shape mirrors the live 28-Aug SOL American CALL series that surfaced this:
// an epoch vault built the way buildCreateSharedVaultIx builds them
// (VaultType::Epoch, NO deposit — the writer-ask escrows its own collateral),
// a $752 pot backing 10 contracts at cpt $75.20, one contract exercised early
// for $5 of capped intrinsic.
//   pot 752 → 747, contracts 10 → 9
//   correct   collateral_remaining = 0 + 747 − 0 = $747   (== vault_usdc)
//   defective collateral_remaining = 0 + 747 − 5 = $742   ($5 vanishes)
// =============================================================================

const EPOCH_DAY = 5, EPOCH_HOUR = 8; // initialize_epoch_config defaults: Friday 08:00 UTC

/** Next Friday-08:00-UTC boundary ≥ 2 days out (min_epoch_duration_days = 1). */
function nextFridayExpiry(from: number): number {
  const SPD = 86_400, SPH = 3_600;
  const d = Math.floor(from / SPD);
  const dow = (d + 4) % 7;
  const daysUntil = dow <= EPOCH_DAY ? EPOCH_DAY - dow : 7 - dow + EPOCH_DAY;
  let t = (d + daysUntil) * SPD + EPOCH_HOUR * SPH;
  while (t < from + 2 * SPD) t += 7 * SPD;
  return t;
}

/** Module-level order/pot derivations — the first describe keeps its own closures. */
const orderPdasOf = (m: PublicKey, owner: PublicKey, nonce: BN) => {
  const order = pda([RESTING_ORDER_SEED, m.toBuffer(), owner.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)]);
  return { order, escrow: pda([RESTING_ORDER_ESCROW_SEED, order.toBuffer()]) };
};
const potPdasOf = (programId: PublicKey, m: PublicKey, backer: PublicKey) => {
  const { writerAskPot, writerAskPotUsdc } = settlePotPdas(programId, m);
  return {
    pot: writerAskPot,
    potUsdc: writerAskPotUsdc,
    position: pda([WRITER_ASK_POSITION_SEED, m.toBuffer(), backer.toBuffer()]),
  };
};

async function sendRaw(e: Env, ixs: any[], signer: Keypair) {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = signer.publicKey; tx.recentBlockhash = e.h.context.lastBlockhash; tx.sign(signer);
  const res = await e.h.context.banksClient.tryProcessTransaction(tx);
  if (res.result) {
    throw new Error("tx failed: " + JSON.stringify(res.result) + "\n" +
      ((res.meta?.logMessages ?? []) as string[]).join("\n"));
  }
}

describe("writer-ask settle AFTER a pot-funded early exercise (D1 addendum)", function () {
  this.timeout(180_000);

  // P — the live shape: ZERO-POOL epoch vault, the pot IS the collateral.
  const P_STRIKE = usdc(75.2);  // cpt == strike (symmetric 1×) → $75.20
  const P_QTY = 10;             // pot = 75.20 × 10 = $752
  const P_SPOT = 80.2;          // capped intrinsic = 80.20 − 75.20 = $5
  // M — MIXED funding: a $2 pool that cannot cover a $5 payout, plus a $600 pot.
  const M_STRIKE = usdc(60);
  const M_QTY = 10;             // pot = 60 × 10 = $600
  const M_POOL = 2;             // $2 vault leg, $3 pot leg
  const M_SPOT = 65;            // capped intrinsic = 65 − 60 = $5

  interface PotVault {
    vault: PublicKey; vaultUsdc: PublicKey; series: any; taker: Keypair;
    pot: PublicKey; potUsdc: PublicKey;
  }

  let e: Env;
  let writer: Keypair;
  let expiry: BN;
  let epochConfig: PublicKey;
  let P: PotVault, M: PotVault;

  const vaultAcc = (v: PublicKey) => (e.opta.account as any).sharedVault.fetch(v);
  const potAcc = (p: PublicKey) => (e.opta.account as any).writerAskPot.fetch(p);
  const bnOf = (x: any) => new BN(x.toString());

  /** create_shared_vault as a real EPOCH vault — the arg set + account set
   *  buildCreateSharedVaultIx (app/src/pages/trade/orderFlows.ts) sends. */
  async function createEpochAmericanVault(strike: BN) {
    const { vault, vaultUsdc } = deriveVault(e, "american", strike, expiry, { call: {} });
    await e.opta.methods
      .createSharedVault(strike, expiry, { call: {} }, { epoch: {} }, e.usdcMint, 0, { american: {} })
      .accountsStrict({
        creator: writer.publicKey, market: e.market, sharedVault: vault, vaultUsdcAccount: vaultUsdc,
        usdcMint: e.usdcMint, protocolState: e.protocolState, epochConfig,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).preInstructions([CU(400_000)]).signers([writer]).rpc();
    return { vault, vaultUsdc };
  }

  /** Zero-pool (or thin-pool) epoch vault whose contracts are backed by a fully
   *  filled writer-ask → all/most collateral lands in the per-series pot. */
  async function buildPotBackedVault(strike: BN, qty: number, nonce: BN, poolUsd: number): Promise<PotVault> {
    const { vault, vaultUsdc } = await createEpochAmericanVault(strike);
    if (poolUsd > 0) await deposit(e, vault, vaultUsdc, writer, poolUsd);
    const series = await createSeries(e, strike, expiry, { call: {} });

    // Post the ask (escrows cpt × qty of the WRITER's own USDC — no pool draw).
    const { order, escrow } = orderPdasOf(series.optionMint, writer.publicKey, nonce);
    const ownerUsdc = await usdcAta(e, writer.publicKey);
    const ownerOpt = getAssociatedTokenAddressSync(series.optionMint, writer.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const postIx = await e.opta.methods.postOrder(WRITER_ASK, usdc(7), new BN(qty), nonce).accountsStrict({
      owner: writer.publicKey, sharedVault: vault, market: e.market, vaultMintRecord: series.vaultMintRecord,
      optionMint: series.optionMint, order, escrow, protocolState: e.protocolState,
      ownerOptionAccount: ownerOpt, ownerUsdcAccount: ownerUsdc, usdcMint: e.usdcMint,
      transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: series.extraMetas, hookState: series.hookState,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(400_000)]).instruction();
    await sendRaw(e, [postIx], writer);

    // Fill it whole → escrow drains into writer_ask_pot_usdc.
    const taker = actor(e);
    const { pot, potUsdc, position } = potPdasOf(e.opta.programId, series.optionMint, writer.publicKey);
    const takerUsdc = await usdcAta(e, taker.publicKey);
    const makerUsdc = getAssociatedTokenAddressSync(e.usdcMint, writer.publicKey, false, TOKEN_PROGRAM_ID);
    const takerOpt = getAssociatedTokenAddressSync(series.optionMint, taker.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      taker.publicKey, takerOpt, taker.publicKey, series.optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const fillIx = await e.opta.methods.fillWriterAsk(new BN(qty)).accountsStrict({
      taker: taker.publicKey, optionMint: series.optionMint, order, maker: writer.publicKey, sharedVault: vault,
      vaultMintRecord: series.vaultMintRecord, escrow, protocolState: e.protocolState, treasury: e.treasury,
      takerUsdcAccount: takerUsdc, makerUsdcAccount: makerUsdc, takerOptionAccount: takerOpt,
      writerAskPot: pot, writerAskPotUsdc: potUsdc, writerAskPosition: position, usdcMint: e.usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).instruction();
    await sendRaw(e, [CU(400_000), ataIx, fillIx], taker);

    return { vault, vaultUsdc, series, taker, pot, potUsdc };
  }

  /** Early-exercise `qty` as the taker/holder, WITH the pot arm supplied. */
  async function earlyExercise(v: PotVault, qty: number, spotUsd: number) {
    const takerOpt = getAssociatedTokenAddressSync(v.series.optionMint, v.taker.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const takerUsdc = await usdcAta(e, v.taker.publicKey);
    const now = await getClockUnix(e.h.context);
    const before = await bal(e, takerUsdc);
    await exerciseAmerican(e, v.vault, v.series, v.taker, takerOpt, takerUsdc, qty, spotUsd, now,
      { writerAskPot: v.pot, writerAskPotUsdc: v.potUsdc });
    return (await bal(e, takerUsdc)) - before;
  }

  async function settleVaultOf(v: PotVault) {
    const sp = await settlePotAccounts(e, v.vault);
    assert.isTrue(sp.optionMint.equals(v.series.optionMint), "vault-derived mint == the funded series mint");
    assert.isTrue(sp.writerAskPot.equals(v.pot), "vault-derived pot == the funded pot");
    await e.opta.methods.settleVault().accountsStrict({
      authority: e.admin.publicKey, sharedVault: v.vault, market: e.market,
      settlementRecord: settlementRecordPda(e, expiry), ...sp,
    }).preInstructions([CU(400_000)]).rpc();
  }

  before(async () => {
    e = await setupEnv("WAPOTEX", "wa-potex-feed", 100);
    writer = actor(e);
    await usdcAta(e, writer.publicKey, 10_000_000_000_000n);

    // One-time epoch schedule so VaultType::Epoch vaults are legal at all.
    epochConfig = pda([Buffer.from("epoch_config")]);
    await e.opta.methods.initializeEpochConfig(EPOCH_DAY, EPOCH_HOUR, true).accountsStrict({
      admin: e.admin.publicKey, protocolState: e.protocolState, epochConfig,
      systemProgram: SystemProgram.programId,
    }).rpc();

    const now = await getClockUnix(e.h.context);
    expiry = new BN(nextFridayExpiry(now));

    P = await buildPotBackedVault(P_STRIKE, P_QTY, new BN(920), 0);
    M = await buildPotBackedVault(M_STRIKE, M_QTY, new BN(921), M_POOL);
  });

  it("6 — pre-state: a zero-pool epoch vault holds $0; the $752 backing 10 contracts sits in the pot", async () => {
    const v: any = await vaultAcc(P.vault);
    assert.isTrue("epoch" in v.vaultType, "VaultType::Epoch (the buildCreateSharedVaultIx shape)");
    assert.equal(v.totalCollateral.toString(), "0", "zero pool — no deposit ever happened");
    assert.equal(v.totalShares.toString(), "0", "no pool writers");
    assert.equal((await bal(e, P.vaultUsdc)).toString(), "0", "vault_usdc is EMPTY pre-settlement");

    const p: any = await potAcc(P.pot);
    assert.equal(p.totalCollateral.toString(), usdc(752).toString(), "pot counter = cpt $75.20 × 10 = $752");
    assert.equal(p.totalContracts.toString(), String(P_QTY), "pot backs 10 contracts");
    assert.equal((await bal(e, P.potUsdc)).toString(), usdc(752).toString(), "pot_usdc backs the counter exactly");
  });

  it("7 — pot-funded early exercise: $5 paid wholly from the pot; early_exercise_payout stays 0", async () => {
    const paid = await earlyExercise(P, 1, P_SPOT);
    assert.equal(paid.toString(), usdc(5).toString(), "holder paid capped intrinsic $5 (80.20 − 75.20)");
    assert.equal((await bal(e, P.vaultUsdc)).toString(), "0", "vault_usdc untouched — it had nothing to give");

    const p: any = await potAcc(P.pot);
    assert.equal(p.totalCollateral.toString(), usdc(747).toString(), "pot counter 752 → 747");
    assert.equal(p.totalContracts.toString(), String(P_QTY - 1), "pot contracts 10 → 9");
    assert.equal((await bal(e, P.potUsdc)).toString(), usdc(747).toString(), "pot_usdc tracks its counter");

    const v: any = await vaultAcc(P.vault);
    assert.equal(v.exercisedOptions.toString(), "1", "exercised_options bumped");
    assert.equal(
      v.earlyExercisePayout.toString(), "0",
      "early_exercise_payout counts VAULT-funded dollars only — the pot draw self-accounts via the reduced sweep");
  });

  it("8 — mixed funding: vault pays the $2 it has, pot pays the $3 it cannot", async () => {
    const paid = await earlyExercise(M, 1, M_SPOT);
    assert.equal(paid.toString(), usdc(5).toString(), "holder paid $5 across BOTH legs");
    assert.equal((await bal(e, M.vaultUsdc)).toString(), "0", "vault_usdc drained first, to zero");

    const p: any = await potAcc(M.pot);
    assert.equal(p.totalCollateral.toString(), usdc(597).toString(), "pot counter 600 → 597 (the $3 shortfall only)");
    assert.equal(p.totalContracts.toString(), String(M_QTY - 1), "pot contracts 10 → 9");

    const v: any = await vaultAcc(M.vault);
    assert.equal(
      v.earlyExercisePayout.toString(), usdc(2).toString(),
      "early_exercise_payout == the VAULT leg ($2), not the $5 total");
  });

  it("9 — settle the pot-only vault: collateral_remaining == $747, and equals vault_usdc", async () => {
    const exp = expiry.toNumber();
    await setClockUnix(e.h.context, exp + 30);
    await settleExpiry(e, expiry, 80, exp + 5); // shared record for this (asset, expiry)
    await settleVaultOf(P);

    const v: any = await vaultAcc(P.vault);
    assert.isTrue(v.isSettled, "settled");
    assert.equal(v.writerAskCollateralSwept.toString(), usdc(747).toString(), "swept the ALREADY-REDUCED counter");
    assert.equal((await bal(e, P.vaultUsdc)).toString(), usdc(747).toString(), "$747 of real USDC landed in the vault");
    assert.equal(
      v.collateralRemaining.toString(), usdc(747).toString(),
      "collateral_remaining = 0 + 747 − 0 = $747 (a defective build double-deducts to $742)");
    // The invariant the double-deduction breaks: the writer-claimable figure must
    // equal the money actually sitting in the vault. Nothing has claimed yet.
    assert.equal(
      bnOf(v.collateralRemaining).toString(), (await bal(e, P.vaultUsdc)).toString(),
      "CONSERVATION: collateral_remaining == vault_usdc balance");
  });

  it("10 — settle the mixed vault: each leg netted exactly once → $597", async () => {
    await settleVaultOf(M); // record already exists; clock already past expiry

    const v: any = await vaultAcc(M.vault);
    assert.equal(v.writerAskCollateralSwept.toString(), usdc(597).toString(), "swept 597");
    assert.equal(
      v.collateralRemaining.toString(), usdc(597).toString(),
      "collateral_remaining = 2 + 597 − 2 = $597 (a defective build lands on $594)");
    assert.equal(
      bnOf(v.collateralRemaining).toString(), (await bal(e, M.vaultUsdc)).toString(),
      "CONSERVATION: collateral_remaining == vault_usdc balance");
  });
});
