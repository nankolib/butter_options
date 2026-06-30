// =============================================================================
// tests/bankrun/writer-ask-residual.test.ts — Phase 3 Slice D2a
// =============================================================================
// withdraw_writer_ask_residual (PURE backer residual claim) + the D2a settle
// shares-unification bump + close_settled_writer_ask_vault (Opt-1 close).
//
// Money-conservation FIRST: an ACTUAL alternating interleave of pool-writer and
// writer-ask-backer claims (NOT happy path) proves Σ payouts ≤ CR₀ against the
// single jointly-decremented (collateral_remaining, total_shares).
//
// Coverage:
//   1  no-pot/EUR byte-identity: settle leaves total_shares unchanged + the
//      pooled withdraw_post_settlement path still pays + closes.
//   2  conservation under INTERLEAVED claims [backer1, poolW, backer2] on a mixed
//      pool+writer-ask vault; every step CR/total_shares decrement is exact;
//      Σ payouts == CR₀; total_shares lands at 0.
//   3  close exactness: close reverts while ANY claimant is owed (total_shares>0),
//      reverts on a pool-only vault (swept==0), and FIRES once total_shares==0.
//   4  pure writer-ask (total_collateral==0): equiv_total==swept (no div-by-zero),
//      merged holder exercise, residual pays the post-holder remainder, closes.
//   5  guards: holders-first window, wrong-recipient pin, double-claim.
//
// Testing build (WRITER_ASKS_ENABLED + AMERICAN_ENABLED true). cpt = strike.
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
  setupEnv, createVault, deposit, mint, purchase, usdcAta, bal, exists,
  actor, pda, getClockUnix, setClockUnix, settleExpiry, settlementRecordPda,
  withdrawPostSettlement, exerciseFromVault, EXERCISE_WINDOW,
  HOOK_PROGRAM_ID, CU, usdc, Env,
} from "./helpers";

const RESTING_ORDER_SEED = Buffer.from("resting_order");
const RESTING_ORDER_ESCROW_SEED = Buffer.from("resting_order_escrow");
const WRITER_ASK_POT_SEED = Buffer.from("writer_ask_pot");
const WRITER_ASK_POT_USDC_SEED = Buffer.from("writer_ask_pot_usdc");
const WRITER_ASK_POSITION_SEED = Buffer.from("writer_ask_position");
const WRITER_ASK = { writerAsk: {} };
const CALL = { call: {} };
const AMERICAN = { american: {} };

interface VaultCtx { vault: PublicKey; vaultUsdc: PublicKey; writerPos: PublicKey; }

describe("writer-ask residual + close (Phase 3 Slice D2a)", function () {
  this.timeout(300_000);

  let e: Env;
  let poolW: Keypair;            // pool LP for the mixed vault M
  let backer1: Keypair, backer2: Keypair, takerM: Keypair, buyerM: Keypair;
  let backerP: Keypair, takerP: Keypair;
  let expiry: BN;
  let M: VaultCtx, B: VaultCtx, C: VaultCtx, P: VaultCtx;
  let mM: any;                   // mixed-vault per-writer series mint
  let mP: any;                   // pure-vault canonical series mint
  let bPos: PublicKey;           // pool-only vault B writer position
  const nB1 = new BN(920), nB2 = new BN(921), nP = new BN(922);
  let caStamp = 8000;

  const potPdas = (m: PublicKey, backer: PublicKey) => ({
    pot: pda([WRITER_ASK_POT_SEED, m.toBuffer()]),
    potUsdc: pda([WRITER_ASK_POT_USDC_SEED, m.toBuffer()]),
    position: pda([WRITER_ASK_POSITION_SEED, m.toBuffer(), backer.toBuffer()]),
  });
  const orderPdas = (m: PublicKey, owner: PublicKey, nonce: BN) => {
    const order = pda([RESTING_ORDER_SEED, m.toBuffer(), owner.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)]);
    return { order, escrow: pda([RESTING_ORDER_ESCROW_SEED, order.toBuffer()]) };
  };
  const vaultAcc = (v: PublicKey) => (e.opta.account as any).sharedVault.fetch(v);
  const posAcc = (p: PublicKey) => (e.opta.account as any).writerPosition.fetch(p);
  const bn = (x: any) => new BN(x.toString());

  // Bankrun never advances lastBlockhash, and a REVERTED tx still occupies its
  // signature — so two byte-identical raw txs (e.g. a window-open residual then
  // the post-window claim, or a refused close then the real one) collide with
  // "already processed". Give every raw residual/close/settle tx a unique CU.
  let cuSeq = 390_000;
  const uCU = () => CU(cuSeq++);

  async function sendTx(ixs: any[], signer: Keypair, expectError = false) {
    const tx = new Transaction().add(...ixs);
    tx.feePayer = signer.publicKey; tx.recentBlockhash = e.h.context.lastBlockhash; tx.sign(signer);
    const res = await e.h.context.banksClient.tryProcessTransaction(tx);
    const logs = (res.meta?.logMessages ?? []) as string[];
    if (!expectError && res.result) throw new Error("tx failed: " + JSON.stringify(res.result) + "\n" + logs.join("\n"));
    return { result: res.result, logs };
  }

  async function mkAmer(strike: BN, depositUsd: number): Promise<VaultCtx> {
    const cv = await createVault(e, "american", strike, expiry, CALL, poolW);
    const wp = depositUsd > 0 ? await deposit(e, cv.vault, cv.vaultUsdc, poolW, depositUsd)
                              : pda([Buffer.from("writer_position"), cv.vault.toBuffer(), poolW.publicKey.toBuffer()]);
    return { vault: cv.vault, vaultUsdc: cv.vaultUsdc, writerPos: wp };
  }

  // Canonical series via create_series (for the PURE writer-ask vault — no pool
  // writer to mint_from_vault). Returns an mint-like object the post/fill helpers consume.
  function deriveSeries(strike: BN, exp: BN) {
    const mintPk = pda([Buffer.from("vault_option_mint"), e.market.toBuffer(),
      strike.toArrayLike(Buffer, "le", 8), exp.toArrayLike(Buffer, "le", 8), Buffer.from([0]), Buffer.from([1])]);
    return {
      optionMint: mintPk,
      vaultMintRecord: pda([Buffer.from("vault_mint_record"), mintPk.toBuffer()]),
      extraMetas: pda([Buffer.from("extra-account-metas"), mintPk.toBuffer()], HOOK_PROGRAM_ID),
      hookState: pda([Buffer.from("hook-state"), mintPk.toBuffer()], HOOK_PROGRAM_ID),
    };
  }
  async function createSeriesCanonical(strike: BN, exp: BN): Promise<any> {
    const s = deriveSeries(strike, exp);
    await e.opta.methods.createSeries(strike, exp, CALL, AMERICAN).accountsStrict({
      caller: e.admin.publicKey, market: e.market, protocolState: e.protocolState,
      optionMint: s.optionMint, vaultMintRecord: s.vaultMintRecord, transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList: s.extraMetas, hookState: s.hookState,
      systemProgram: SystemProgram.programId, token2022Program: TOKEN_2022_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(800_000)]).rpc();
    return s;
  }

  async function postWriterAskBy(v: VaultCtx, m: any, owner: Keypair, price: BN, qty: number, nonce: BN) {
    const { order, escrow } = orderPdas(m.optionMint, owner.publicKey, nonce);
    const ownerUsdc = await usdcAta(e, owner.publicKey);
    const ownerOpt = getAssociatedTokenAddressSync(m.optionMint, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const ix = await e.opta.methods.postOrder(WRITER_ASK, price, new BN(qty), nonce).accountsStrict({
      owner: owner.publicKey, sharedVault: v.vault, market: e.market, vaultMintRecord: m.vaultMintRecord,
      optionMint: m.optionMint, order, escrow, protocolState: e.protocolState,
      ownerOptionAccount: ownerOpt, ownerUsdcAccount: ownerUsdc, usdcMint: e.usdcMint,
      transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: m.extraMetas, hookState: m.hookState,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(400_000)]).instruction();
    await sendTx([ix], owner);
  }
  async function fillWriterAskBy(v: VaultCtx, m: any, owner: Keypair, nonce: BN, taker: Keypair, qty: number) {
    const { order, escrow } = orderPdas(m.optionMint, owner.publicKey, nonce);
    const { pot, potUsdc, position } = potPdas(m.optionMint, owner.publicKey);
    const takerUsdc = await usdcAta(e, taker.publicKey);
    const makerUsdc = getAssociatedTokenAddressSync(e.usdcMint, owner.publicKey, false, TOKEN_PROGRAM_ID);
    const takerOpt = getAssociatedTokenAddressSync(m.optionMint, taker.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      taker.publicKey, takerOpt, taker.publicKey, m.optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const ix = await e.opta.methods.fillWriterAsk(new BN(qty)).accountsStrict({
      taker: taker.publicKey, optionMint: m.optionMint, order, maker: owner.publicKey, sharedVault: v.vault,
      vaultMintRecord: m.vaultMintRecord, escrow, protocolState: e.protocolState, treasury: e.treasury,
      takerUsdcAccount: takerUsdc, makerUsdcAccount: makerUsdc, takerOptionAccount: takerOpt,
      writerAskPot: pot, writerAskPotUsdc: potUsdc, writerAskPosition: position, usdcMint: e.usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).instruction();
    await sendTx([CU(400_000), ataIx, ix], taker);
  }

  // settle_vault — pot variant (m) or no-pot (null). The SettlementRecord must
  // already exist + clock past expiry. Distinct `auth` varies the tx signature.
  async function settleVaultOnly(v: VaultCtx, m: any | null, backer?: PublicKey, expectError = false, auth: Keypair = e.admin) {
    const accs: any = {
      authority: auth.publicKey, sharedVault: v.vault, market: e.market,
      settlementRecord: settlementRecordPda(e, expiry),
      vaultUsdcAccount: null, writerAskPot: null, writerAskPotUsdc: null, protocolState: null, tokenProgram: null,
    };
    if (m) {
      const { pot, potUsdc } = potPdas(m.optionMint, backer!);
      accs.vaultUsdcAccount = v.vaultUsdc; accs.writerAskPot = pot; accs.writerAskPotUsdc = potUsdc;
      accs.protocolState = e.protocolState; accs.tokenProgram = TOKEN_PROGRAM_ID;
    }
    const ix = await e.opta.methods.settleVault().accountsStrict(accs).instruction();
    return sendTx([CU(400_000), ix], auth, expectError);
  }

  async function residualClaim(v: VaultCtx, optionMint: PublicKey, backer: Keypair, opts: { expectError?: boolean; recipient?: PublicKey; cu?: number } = {}) {
    const position = pda([WRITER_ASK_POSITION_SEED, optionMint.toBuffer(), backer.publicKey.toBuffer()]);
    const recipient = opts.recipient ?? await usdcAta(e, backer.publicKey);
    const ix = await e.opta.methods.withdrawWriterAskResidual().accountsStrict({
      cranker: e.admin.publicKey, sharedVault: v.vault, writerAskPosition: position,
      vaultUsdcAccount: v.vaultUsdc, writerUsdcAccount: recipient, tokenProgram: TOKEN_PROGRAM_ID,
    }).instruction();
    return sendTx([opts.cu ? CU(opts.cu) : uCU(), ix], e.admin, opts.expectError ?? false);
  }

  async function closeVault(v: VaultCtx, expectError = false) {
    const ix = await e.opta.methods.closeSettledWriterAskVault().accountsStrict({
      cranker: e.admin.publicKey, sharedVault: v.vault, vaultUsdcAccount: v.vaultUsdc,
      treasury: e.treasury, protocolState: e.protocolState, tokenProgram: TOKEN_PROGRAM_ID,
    }).instruction();
    return sendTx([uCU(), ix], e.admin, expectError);
  }

  before(async () => {
    e = await setupEnv("WARESID", "wa-resid-feed", 100);
    poolW = actor(e); backer1 = actor(e); backer2 = actor(e); takerM = actor(e); buyerM = actor(e);
    backerP = actor(e); takerP = actor(e);
    for (const k of [poolW, backer1, backer2, takerM, buyerM, backerP, takerP]) {
      await usdcAta(e, k.publicKey, 10_000_000_000_000n);
    }
    const now = await getClockUnix(e.h.context);
    expiry = new BN(now + 3600);

    // M: MIXED — pool $1000 + series(5) + pool-sale(3) + WriterAsk fills backer1(4) & backer2(3). strike $10.
    M = await mkAmer(usdc(10), 1000);
    mM = await mint(e, M.vault, M.writerPos, poolW, 5, now + (caStamp++), true);
    await purchase(e, M.vault, M.writerPos, mM, M.vaultUsdc, buyerM, 3);  // total_options_sold = 3
    await postWriterAskBy(M, mM, backer1, usdc(7), 4, nB1);
    await fillWriterAskBy(M, mM, backer1, nB1, takerM, 4);                 // pot += cpt$10 × 4 = $40
    await postWriterAskBy(M, mM, backer2, usdc(7), 3, nB2);
    await fillWriterAskBy(M, mM, backer2, nB2, takerM, 3);                 // pot += cpt$10 × 3 = $30  → pot $70

    // B: pool-only American (no pot). strike $11, pool $500, no mint/sale.
    B = await mkAmer(usdc(11), 500);
    bPos = B.writerPos;

    // C: European, pool $500 (no pot). strike $12.
    {
      const cv = await createVault(e, "european", usdc(12), expiry, CALL, poolW);
      const wp = await deposit(e, cv.vault, cv.vaultUsdc, poolW, 500);
      C = { vault: cv.vault, vaultUsdc: cv.vaultUsdc, writerPos: wp };
    }

    // P: PURE writer-ask (total_collateral == 0). American strike $20, NO deposit.
    // create_series canonical mint, backerP posts+fills 5 → pot = cpt$20 × 5 = $100.
    {
      const cv = await createVault(e, "american", usdc(20), expiry, CALL, poolW);
      P = { vault: cv.vault, vaultUsdc: cv.vaultUsdc, writerPos: pda([Buffer.from("writer_position"), cv.vault.toBuffer(), poolW.publicKey.toBuffer()]) };
    }
    mP = await createSeriesCanonical(usdc(20), expiry);
    await postWriterAskBy(P, mP, backerP, usdc(7), 5, nP);
    await fillWriterAskBy(P, mP, backerP, nP, takerP, 5);                  // pot = $100, total_collateral stays 0

    // Settle everything ITM at $25 (CALL: B/M strike $10-$12 → deep ITM; P strike $20 → $5 intrinsic).
    const exp = expiry.toNumber();
    await setClockUnix(e.h.context, exp + 30);
    await settleExpiry(e, expiry, 25, exp + 5);
    await settleVaultOnly(M, mM, backer1.publicKey);   // pot pinned by mint (backer arg only used for position pda, unused here)
    await settleVaultOnly(B, null);
    await settleVaultOnly(C, null);
    await settleVaultOnly(P, mP, backerP.publicKey);
  });

  // ---------------------------------------------------------------------------
  it("1 — no-pot/EUR byte-identity: settle leaves total_shares unchanged; pooled withdraw still pays + closes", async () => {
    for (const v of [B, C]) {
      const a: any = await vaultAcc(v.vault);
      assert.equal(a.writerAskCollateralSwept.toString(), "0", "no pot → swept 0");
      assert.equal(a.writerAskEquivShares.toString(), "0", "no pot → equiv_shares 0 (total_shares un-bumped)");
      // total_shares must equal total_collateral (pool 1:1, untouched by the D2a bump).
      assert.equal(a.totalShares.toString(), a.totalCollateral.toString(), "total_shares == total_collateral (no bump)");
    }
    // B: pool-only, total_options_sold == 0 → window bypassed → pooled withdraw pays full + closes vault USDC.
    const before = await bal(e, await usdcAta(e, poolW.publicKey));
    const crB = bn((await vaultAcc(B.vault)).collateralRemaining);
    await withdrawPostSettlement(e, B.vault, bPos, poolW);
    assert.equal((await bal(e, await usdcAta(e, poolW.publicKey)) - before).toString(), crB.toString(), "pool writer paid full collateral_remaining");
    assert.isFalse(await exists(e, B.vaultUsdc), "pooled last-writer close fired → vault USDC closed");
  });

  it("2 — CONSERVATION under interleaved [backer1, poolW, backer2]: each CR/total_shares step exact; Σ == CR₀; total_shares→0", async () => {
    // Past the holders-first window so all three claim paths are open.
    await setClockUnix(e.h.context, expiry.toNumber() + EXERCISE_WINDOW + 60);

    const v0: any = await vaultAcc(M.vault);
    const CR0 = bn(v0.collateralRemaining);
    const swept = bn(v0.writerAskCollateralSwept), equivTotal = bn(v0.writerAskEquivShares);
    // ratio-1 pool ⇒ equiv_total == swept (no floor dust).
    assert.equal(equivTotal.toString(), swept.toString(), "equiv_total == swept (1:1 pool)");

    const pos1 = potPdas(mM.optionMint, backer1.publicKey).position;
    const pos2 = potPdas(mM.optionMint, backer2.publicKey).position;
    const committed1 = bn((await (e.opta.account as any).writerAskPosition.fetch(pos1)).collateralCommitted);
    const committed2 = bn((await (e.opta.account as any).writerAskPosition.fetch(pos2)).collateralCommitted);
    const poolShares = bn((await posAcc(M.writerPos)).shares);

    let payoutSum = new BN(0);
    const step = async (label: string, weight: BN, claim: () => Promise<void>) => {
      const pre: any = await vaultAcc(M.vault);
      const CR = bn(pre.collateralRemaining), T = bn(pre.totalShares);
      const expected = weight.mul(CR).div(T); // floor
      await claim();
      const post: any = await vaultAcc(M.vault);
      assert.equal(CR.sub(bn(post.collateralRemaining)).toString(), expected.toString(), `${label}: CR decremented by floor(w·CR/T)`);
      assert.equal(T.sub(bn(post.totalShares)).toString(), weight.toString(), `${label}: total_shares decremented by weight`);
      payoutSum = payoutSum.add(expected);
    };

    // INTERLEAVE: writer-ask backer1 → pool writer → writer-ask backer2.
    const equiv1 = committed1.mul(equivTotal).div(swept);
    const equiv2 = committed2.mul(equivTotal).div(swept);
    await step("backer1", equiv1, async () => { await residualClaim(M, mM.optionMint, backer1); });
    await step("poolW",   poolShares, async () => { await withdrawPostSettlement(e, M.vault, M.writerPos, poolW); });
    await step("backer2", equiv2, async () => { await residualClaim(M, mM.optionMint, backer2); });

    const vEnd: any = await vaultAcc(M.vault);
    assert.equal(vEnd.totalShares.toString(), "0", "total_shares drained to exactly 0");
    assert.isTrue(payoutSum.lte(CR0), "Σ payouts ≤ CR₀ (conservation)");
    assert.equal(payoutSum.toString(), CR0.toString(), "Σ payouts == CR₀ exactly (ratio-1, no floor dust)");
    assert.equal(vEnd.collateralRemaining.toString(), "0", "collateral_remaining fully distributed");
  });

  it("3 — close exactness: reverts while owed, reverts on pool-only, FIRES at total_shares==0", async () => {
    // P still has an unclaimed backer position → total_shares > 0 → close refused.
    assert.isAbove(Number((await vaultAcc(P.vault)).totalShares.toString()), 0, "P not yet drained");
    let r = await closeVault(P, true);
    assert.isTrue(r.logs.join("\n").includes("VaultNotFullyDrained"), "close refused while a claimant is owed");
    // Pool-only vault C (swept == 0) is out of scope for this close.
    r = await closeVault(C, true);
    assert.isTrue(r.logs.join("\n").includes("NotAWriterAskVault"), "pool-only/EUR vault rejected (swept==0)");
    // M was fully drained in test 2 (total_shares==0) → close FIRES.
    assert.equal((await vaultAcc(M.vault)).totalShares.toString(), "0", "M drained");
    const treBefore = await bal(e, e.treasury);
    const r2 = await closeVault(M);
    assert.isNull(r2.result, "close fired on drained writer-ask vault");
    assert.isFalse(await exists(e, M.vaultUsdc), "vault USDC closed");
    assert.isTrue((await bal(e, e.treasury)) >= treBefore, "dust swept to treasury (≥, exact dust depends on premium rounding)");
  });

  it("4 — pure writer-ask (total_collateral==0): equiv_total==swept, merged holder exercise, residual pays remainder, closes", async () => {
    const v0: any = await vaultAcc(P.vault);
    assert.equal(v0.totalCollateral.toString(), "0", "pure writer-ask vault: total_collateral == 0");
    assert.equal(v0.writerAskEquivShares.toString(), v0.writerAskCollateralSwept.toString(), "equiv_total == swept (no pool ratio → 1:1)");
    assert.equal(v0.totalShares.toString(), v0.writerAskCollateralSwept.toString(), "total_shares == swept (bumped from 0)");

    // Holder (takerP) exercises 5 ITM contracts (CALL strike $20, settle $25 → $5 each = $25), paid from merged collateral.
    const takerOpt = getAssociatedTokenAddressSync(mP.optionMint, takerP.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const takerUsdc = await usdcAta(e, takerP.publicKey);
    const crBeforeEx = bn((await vaultAcc(P.vault)).collateralRemaining);
    const exBefore = await bal(e, takerUsdc);
    await exerciseFromVault(e, P.vault, mP, takerP, takerOpt, takerUsdc, 5);
    const holderPaid = await bal(e, takerUsdc) - exBefore;
    assert.equal(holderPaid.toString(), usdc(5).muln(5).toString(), "holder paid $5 × 5 from merged collateral");
    assert.equal(bn((await vaultAcc(P.vault)).collateralRemaining).toString(), crBeforeEx.sub(usdc(25)).toString(), "CR decremented by holder payout");

    // Backer residual = the full post-holder remainder (single backer, equiv_shares == total_shares).
    const vMid: any = await vaultAcc(P.vault);
    const crMid = bn(vMid.collateralRemaining), TMid = bn(vMid.totalShares);
    const backerUsdc = await usdcAta(e, backerP.publicKey);
    const bkBefore = await bal(e, backerUsdc);
    await residualClaim(P, mP.optionMint, backerP);
    assert.equal((await bal(e, backerUsdc) - bkBefore).toString(), crMid.toString(), "backer paid the full post-holder remainder");
    assert.equal((await vaultAcc(P.vault)).totalShares.toString(), "0", "P total_shares → 0");
    // div-branch sanity: TMid was the backer's equiv_shares, no div-by-zero, exact drain.
    assert.equal(TMid.toString(), bn(vMid.writerAskEquivShares).toString(), "single backer holds all equiv_shares");

    // Close fires.
    const r = await closeVault(P);
    assert.isNull(r.result, "pure writer-ask vault closed");
    assert.isFalse(await exists(e, P.vaultUsdc), "P vault USDC closed");
  });

  it("5 — guards: wrong-recipient pin + double-claim", async () => {
    // Fresh pure vault Q with one filled backer, settle ITM, advance window.
    const now = await getClockUnix(e.h.context);
    const qExpiry = new BN(now + 3600);
    const qStrike = usdc(30);
    const backerQ = actor(e); const takerQ = actor(e); const stranger = actor(e);
    for (const k of [backerQ, takerQ, stranger]) await usdcAta(e, k.publicKey, 10_000_000_000_000n);
    const cv = await createVault(e, "american", qStrike, qExpiry, CALL, poolW);
    const Q: VaultCtx = { vault: cv.vault, vaultUsdc: cv.vaultUsdc, writerPos: cv.vault };
    // create_series at the Q spec
    const mQmint = pda([Buffer.from("vault_option_mint"), e.market.toBuffer(), qStrike.toArrayLike(Buffer, "le", 8), qExpiry.toArrayLike(Buffer, "le", 8), Buffer.from([0]), Buffer.from([1])]);
    const mQ = {
      optionMint: mQmint,
      vaultMintRecord: pda([Buffer.from("vault_mint_record"), mQmint.toBuffer()]),
      extraMetas: pda([Buffer.from("extra-account-metas"), mQmint.toBuffer()], HOOK_PROGRAM_ID),
      hookState: pda([Buffer.from("hook-state"), mQmint.toBuffer()], HOOK_PROGRAM_ID),
    };
    await e.opta.methods.createSeries(qStrike, qExpiry, CALL, AMERICAN).accountsStrict({
      caller: e.admin.publicKey, market: e.market, protocolState: e.protocolState,
      optionMint: mQ.optionMint, vaultMintRecord: mQ.vaultMintRecord, transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList: mQ.extraMetas, hookState: mQ.hookState,
      systemProgram: SystemProgram.programId, token2022Program: TOKEN_2022_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(800_000)]).rpc();
    const nQ = new BN(923);
    await postWriterAskBy(Q, mQ, backerQ, usdc(7), 4, nQ);
    await fillWriterAskBy(Q, mQ, backerQ, nQ, takerQ, 4);

    const exp = qExpiry.toNumber();
    await setClockUnix(e.h.context, exp + 30);
    await settleExpiry(e, qExpiry, 35, exp + 5);
    // settle Q with the new (later) expiry's SettlementRecord — settleVaultOnly uses module `expiry`; build inline.
    const settleIx = await e.opta.methods.settleVault().accountsStrict({
      authority: e.admin.publicKey, sharedVault: Q.vault, market: e.market, settlementRecord: settlementRecordPda(e, qExpiry),
      vaultUsdcAccount: Q.vaultUsdc, writerAskPot: potPdas(mQ.optionMint, backerQ.publicKey).pot,
      writerAskPotUsdc: potPdas(mQ.optionMint, backerQ.publicKey).potUsdc, protocolState: e.protocolState, tokenProgram: TOKEN_PROGRAM_ID,
    }).instruction();
    await sendTx([uCU(), settleIx], e.admin);

    // Window still open immediately after settle → residual reverts.
    const posQ = potPdas(mQ.optionMint, backerQ.publicKey).position;
    const earlyIx = await e.opta.methods.withdrawWriterAskResidual().accountsStrict({
      cranker: e.admin.publicKey, sharedVault: Q.vault, writerAskPosition: posQ,
      vaultUsdcAccount: Q.vaultUsdc, writerUsdcAccount: await usdcAta(e, backerQ.publicKey), tokenProgram: TOKEN_PROGRAM_ID,
    }).instruction();
    let r = await sendTx([uCU(), earlyIx], e.admin, true);
    assert.isTrue(r.logs.join("\n").includes("HolderExerciseWindowOpen"), "residual blocked during holder window");

    await setClockUnix(e.h.context, exp + EXERCISE_WINDOW + 60);

    // Wrong recipient (stranger's USDC) → owner-pin revert.
    r = await residualClaim(Q, mQ.optionMint, backerQ, { expectError: true, recipient: await usdcAta(e, stranger.publicKey) });
    assert.isTrue(r.result !== null, "wrong-recipient residual reverts (NotWriter owner pin)");

    // Correct claim succeeds.
    await residualClaim(Q, mQ.optionMint, backerQ);
    assert.equal((await vaultAcc(Q.vault)).totalShares.toString(), "0", "Q drained");

    // Double-claim (distinct CU to dodge bankrun dedup) → NothingToClaim.
    r = await residualClaim(Q, mQ.optionMint, backerQ, { expectError: true });
    assert.isTrue(r.logs.join("\n").includes("NothingToClaim"), "second residual claim reverts NothingToClaim");
  });
});
