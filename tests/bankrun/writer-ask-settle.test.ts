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
