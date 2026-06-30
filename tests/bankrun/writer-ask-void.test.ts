// =============================================================================
// tests/bankrun/writer-ask-void.test.ts — Phase 3 Slice D3 (void-path)
// =============================================================================
// initialize_void (the sole atomic voided-setter) + reclaim_writer_ask_residual
// (backer void claim, shared core) + reclaim_unsettled (now voided-gated) + the
// extended close. The void path replicates the D2a settle-merge so both buckets
// are made whole exactly, with E socialized by share (no origin attribution).
//
//   1  void-merge CONSERVATION under interleaved [backer1, poolW, backer2] → Σ≤CR₀, T→0
//   2  socialization (BOTH numbers): pre-void early-exercise → pool payout reflects
//      (TC+swept−E), > the (TC−E) it would be without the merge
//   3  no-pot void byte-identity (pool-only American + EUR → swept=0, reclaim == today)
//   4  sole-voider/atomicity: reclaim before init → VaultNotVoided; 2nd init → VaultVoided
//   5  derived-pot un-omittable: substitute the pot → reject
//   6  pure writer-ask void (TC==0) → equiv_total==swept, backers whole, no div-by-zero
//   7  void close: fires at T==0; pot_usdc closed at init; vault_usdc closed at end (incl pool-only-voided)
//   8  double-claim (backer) → NothingToClaim
//
// Testing build. cpt = strike. GRACE_WINDOW = 7 days. NO settleExpiry is called →
// the dead-feed hatch is open (no SettlementRecord for the (asset, expiry)).
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
  setupEnv, createVault, deposit, createSeries, usdcAta, bal, exists,
  actor, pda, getClockUnix, setClockUnix, settlementRecordPda,
  exerciseAmerican, HOOK_PROGRAM_ID, CU, usdc, Env,
} from "./helpers";

const RESTING_ORDER_SEED = Buffer.from("resting_order");
const RESTING_ORDER_ESCROW_SEED = Buffer.from("resting_order_escrow");
const VAULT_OPTION_MINT_SEED = Buffer.from("vault_option_mint");
const WRITER_ASK_POT_SEED = Buffer.from("writer_ask_pot");
const WRITER_ASK_POT_USDC_SEED = Buffer.from("writer_ask_pot_usdc");
const WRITER_ASK_POSITION_SEED = Buffer.from("writer_ask_position");
const WRITER_POSITION_SEED = Buffer.from("writer_position");
const WRITER_ASK = { writerAsk: {} };
const CALL = { call: {} };
const GRACE = 604_800;

interface VaultCtx { vault: PublicKey; vaultUsdc: PublicKey; writerPos: PublicKey; }

describe("writer-ask void-path reconciliation (Phase 3 Slice D3)", function () {
  this.timeout(300_000);

  let e: Env;
  let poolW: Keypair, backer1: Keypair, backer2: Keypair, taker: Keypair, backerP: Keypair;
  let expiry: BN;
  let cuSeq = 380_000;
  const uCU = () => CU(cuSeq++);

  const potPdas = (m: PublicKey, backer?: PublicKey) => ({
    pot: pda([WRITER_ASK_POT_SEED, m.toBuffer()]),
    potUsdc: pda([WRITER_ASK_POT_USDC_SEED, m.toBuffer()]),
    position: backer ? pda([WRITER_ASK_POSITION_SEED, m.toBuffer(), backer.toBuffer()]) : PublicKey.default,
  });
  const orderPdas = (m: PublicKey, owner: PublicKey, n: BN) => {
    const order = pda([RESTING_ORDER_SEED, m.toBuffer(), owner.toBuffer(), n.toArrayLike(Buffer, "le", 8)]);
    return { order, escrow: pda([RESTING_ORDER_ESCROW_SEED, order.toBuffer()]) };
  };
  // Canonical mint derived from the vault spec (es: 1=American, 0=European).
  const deriveCanon = (strike: BN, esByte: number) =>
    pda([VAULT_OPTION_MINT_SEED, e.market.toBuffer(), strike.toArrayLike(Buffer, "le", 8),
      expiry.toArrayLike(Buffer, "le", 8), Buffer.from([0]), Buffer.from([esByte])]);
  const vaultAcc = (v: PublicKey) => (e.opta.account as any).sharedVault.fetch(v);
  const bn = (x: any) => new BN(x.toString());

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
                              : pda([WRITER_POSITION_SEED, cv.vault.toBuffer(), poolW.publicKey.toBuffer()]);
    return { vault: cv.vault, vaultUsdc: cv.vaultUsdc, writerPos: wp };
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
  async function fillWriterAskBy(v: VaultCtx, m: any, owner: Keypair, nonce: BN, tk: Keypair, qty: number) {
    const { order, escrow } = orderPdas(m.optionMint, owner.publicKey, nonce);
    const { pot, potUsdc, position } = potPdas(m.optionMint, owner.publicKey);
    const takerUsdc = await usdcAta(e, tk.publicKey);
    const makerUsdc = getAssociatedTokenAddressSync(e.usdcMint, owner.publicKey, false, TOKEN_PROGRAM_ID);
    const takerOpt = getAssociatedTokenAddressSync(m.optionMint, tk.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      tk.publicKey, takerOpt, tk.publicKey, m.optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const ix = await e.opta.methods.fillWriterAsk(new BN(qty)).accountsStrict({
      taker: tk.publicKey, optionMint: m.optionMint, order, maker: owner.publicKey, sharedVault: v.vault,
      vaultMintRecord: m.vaultMintRecord, escrow, protocolState: e.protocolState, treasury: e.treasury,
      takerUsdcAccount: takerUsdc, makerUsdcAccount: makerUsdc, takerOptionAccount: takerOpt,
      writerAskPot: pot, writerAskPotUsdc: potUsdc, writerAskPosition: position, usdcMint: e.usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).instruction();
    await sendTx([CU(400_000), ataIx, ix], tk);
  }

  // initialize_void — pass the derived canonical mint/pot/pot_usdc (esByte selects
  // the mint namespace). `potOverride` forces a wrong pot (scenario 5).
  async function initVoid(v: VaultCtx, strike: BN, esByte: number, opts: { expectError?: boolean; mintOverride?: PublicKey; potOverride?: PublicKey } = {}) {
    const canon = opts.mintOverride ?? deriveCanon(strike, esByte);
    const pp = potPdas(canon);
    const ix = await e.opta.methods.initializeVoid().accountsStrict({
      cranker: e.admin.publicKey, sharedVault: v.vault, market: e.market,
      settlementRecord: settlementRecordPda(e, expiry),
      optionMint: canon, writerAskPot: opts.potOverride ?? pp.pot, writerAskPotUsdc: pp.potUsdc,
      vaultUsdcAccount: v.vaultUsdc, protocolState: e.protocolState, treasury: e.treasury,
      tokenProgram: TOKEN_PROGRAM_ID,
    }).instruction();
    return sendTx([uCU(), ix], e.admin, opts.expectError ?? false);
  }
  // reclaim_unsettled (pool) — voided-gated, no market/settlement_record.
  async function reclaimPool(v: VaultCtx, writer: Keypair, expectError = false) {
    const writerPos = pda([WRITER_POSITION_SEED, v.vault.toBuffer(), writer.publicKey.toBuffer()]);
    const wusdc = await usdcAta(e, writer.publicKey);
    const ix = await e.opta.methods.reclaimUnsettled().accountsStrict({
      cranker: e.admin.publicKey, writer: writer.publicKey, sharedVault: v.vault, writerPosition: writerPos,
      vaultUsdcAccount: v.vaultUsdc, writerUsdcAccount: wusdc, tokenProgram: TOKEN_PROGRAM_ID,
    }).instruction();
    return sendTx([uCU(), ix], e.admin, expectError);
  }
  // reclaim_writer_ask_residual (backer void).
  async function reclaimBacker(v: VaultCtx, optionMint: PublicKey, backer: Keypair, expectError = false) {
    const position = pda([WRITER_ASK_POSITION_SEED, optionMint.toBuffer(), backer.publicKey.toBuffer()]);
    const recipient = await usdcAta(e, backer.publicKey);
    const ix = await e.opta.methods.reclaimWriterAskResidual().accountsStrict({
      cranker: e.admin.publicKey, sharedVault: v.vault, writerAskPosition: position,
      vaultUsdcAccount: v.vaultUsdc, writerUsdcAccount: recipient, tokenProgram: TOKEN_PROGRAM_ID,
    }).instruction();
    return sendTx([uCU(), ix], e.admin, expectError);
  }
  async function closeVault(v: VaultCtx, expectError = false) {
    const ix = await e.opta.methods.closeSettledWriterAskVault().accountsStrict({
      cranker: e.admin.publicKey, sharedVault: v.vault, vaultUsdcAccount: v.vaultUsdc,
      treasury: e.treasury, protocolState: e.protocolState, tokenProgram: TOKEN_PROGRAM_ID,
    }).instruction();
    return sendTx([uCU(), ix], e.admin, expectError);
  }

  // Vaults (distinct strikes → distinct canonical mints; same expiry → one absent record).
  let V1: VaultCtx, m1: any;                 // mixed conservation
  let V2: VaultCtx, m2: any;                 // socialization (pre-void exercise)
  let Bpool: VaultCtx, Eur: VaultCtx;        // no-pot American + EUR
  let V4: VaultCtx, m4: any;                 // sole-voider/atomicity
  let V6: VaultCtx, m6: any;                 // pure writer-ask (TC==0)
  const n1a = new BN(930), n1b = new BN(931), n2 = new BN(932), n4 = new BN(933), n6 = new BN(934);

  before(async () => {
    e = await setupEnv("WAVOID", "wa-void-feed", 100);
    poolW = actor(e); backer1 = actor(e); backer2 = actor(e); taker = actor(e); backerP = actor(e);
    for (const k of [poolW, backer1, backer2, taker, backerP]) await usdcAta(e, k.publicKey, 10_000_000_000_000n);
    const now = await getClockUnix(e.h.context);
    expiry = new BN(now + 3600);

    // V1 mixed: pool $1000 + canonical writer-asks backer1(4)+backer2(3) → pot $70. strike $10.
    V1 = await mkAmer(usdc(10), 1000);
    m1 = await createSeries(e, usdc(10), expiry, CALL);
    await postWriterAskBy(V1, m1, backer1, usdc(7), 4, n1a); await fillWriterAskBy(V1, m1, backer1, n1a, taker, 4);
    await postWriterAskBy(V1, m1, backer2, usdc(7), 3, n1b); await fillWriterAskBy(V1, m1, backer2, n1b, taker, 3);

    // V2 socialization: pool $1000 + canonical writer-asks backer1(7) → pot $70. strike $11.
    // Pre-void EARLY-EXERCISE 1 writer-ask contract (spot $15 → $5 intrinsic) → E=$5.
    V2 = await mkAmer(usdc(11), 1000);
    m2 = await createSeries(e, usdc(11), expiry, CALL);
    await postWriterAskBy(V2, m2, backer1, usdc(7), 7, n2); await fillWriterAskBy(V2, m2, backer1, n2, taker, 7);
    {
      const takerOpt = getAssociatedTokenAddressSync(m2.optionMint, taker.publicKey, false, TOKEN_2022_PROGRAM_ID);
      const takerUsdc = await usdcAta(e, taker.publicKey);
      await exerciseAmerican(e, V2.vault, m2, taker, takerOpt, takerUsdc, 1, 15, now); // E = $5
    }

    // No-pot: pool-only American $500 (strike $12) + EUR $500 (strike $13).
    Bpool = await mkAmer(usdc(12), 500);
    { const cv = await createVault(e, "european", usdc(13), expiry, CALL, poolW);
      const wp = await deposit(e, cv.vault, cv.vaultUsdc, poolW, 500);
      Eur = { vault: cv.vault, vaultUsdc: cv.vaultUsdc, writerPos: wp }; }

    // V4 sole-voider: pool $500 + canonical writer-ask backer1(2). strike $14.
    V4 = await mkAmer(usdc(14), 500);
    m4 = await createSeries(e, usdc(14), expiry, CALL);
    await postWriterAskBy(V4, m4, backer1, usdc(7), 2, n4); await fillWriterAskBy(V4, m4, backer1, n4, taker, 2);

    // V6 pure writer-ask (TC==0): NO deposit + canonical writer-ask backerP(5). strike $15. pot $75.
    V6 = await mkAmer(usdc(15), 0);
    m6 = await createSeries(e, usdc(15), expiry, CALL);
    await postWriterAskBy(V6, m6, backerP, usdc(7), 5, n6); await fillWriterAskBy(V6, m6, backerP, n6, taker, 5);
  });

  it("4 — sole-voider/atomicity: reclaim before init → VaultNotVoided; 2nd init → VaultVoided", async () => {
    // BEFORE any grace warp / init: a pool reclaim must reject (not voided).
    let r = await reclaimPool(V4, poolW, true);
    assert.isTrue(r.logs.join("\n").includes("VaultNotVoided"), "pool reclaim before init → VaultNotVoided");
    r = await reclaimBacker(V4, m4.optionMint, backer1, true);
    assert.isTrue(r.logs.join("\n").includes("VaultNotVoided"), "backer reclaim before init → VaultNotVoided");

    // Warp past grace, then init succeeds; a SECOND init reverts (once-only).
    await setClockUnix(e.h.context, expiry.toNumber() + GRACE + 60);
    const r2 = await initVoid(V4, usdc(14), 1);
    assert.isNull(r2.result, "initialize_void succeeds past grace");
    const r3 = await initVoid(V4, usdc(14), 1, { expectError: true });
    assert.isTrue(r3.logs.join("\n").includes("VaultVoided"), "second init → VaultVoided (once-only)");
  });

  it("5 — derived-pot un-omittable: substitute the pot → reject", async () => {
    // V1 not yet voided. Pass V4's pot (wrong) as V1's pot → require_keys_eq rejects.
    const wrongPot = potPdas(m4.optionMint).pot;
    const r = await initVoid(V1, usdc(10), 1, { expectError: true, potOverride: wrongPot });
    assert.isNotNull(r.result, "substituted pot must reject");
    assert.isTrue(r.logs.join("\n").includes("InvalidVaultMint"), "error = InvalidVaultMint (pot pin)");
    // Wrong mint override likewise.
    const r2 = await initVoid(V1, usdc(10), 1, { expectError: true, mintOverride: m4.optionMint });
    assert.isTrue(r2.logs.join("\n").includes("InvalidVaultMint"), "substituted mint must reject");
  });

  it("1 — void-merge CONSERVATION under interleaved [backer1, poolW, backer2]; Σ≤CR₀; T→0", async () => {
    await initVoid(V1, usdc(10), 1);  // clock already past grace (from test 4)
    const v0: any = await vaultAcc(V1.vault);
    const CR0 = bn(v0.collateralRemaining), swept = bn(v0.writerAskCollateralSwept), equivTotal = bn(v0.writerAskEquivShares);
    assert.equal(CR0.toString(), usdc(1070).toString(), "CR₀ = TC+swept−E = 1000+70−0 = 1070");
    assert.equal(swept.toString(), usdc(70).toString(), "swept = 70");
    assert.equal(equivTotal.toString(), swept.toString(), "equiv_total == swept (1:1 pool)");
    assert.isFalse(await exists(e, potPdas(m1.optionMint).potUsdc), "pot_usdc closed at init");

    const pos1 = potPdas(m1.optionMint, backer1.publicKey).position;
    const pos2 = potPdas(m1.optionMint, backer2.publicKey).position;
    const committed1 = bn((await (e.opta.account as any).writerAskPosition.fetch(pos1)).collateralCommitted);
    const committed2 = bn((await (e.opta.account as any).writerAskPosition.fetch(pos2)).collateralCommitted);
    const poolShares = bn((await (e.opta.account as any).writerPosition.fetch(V1.writerPos)).shares);
    assert.equal(poolShares.toString(), usdc(1000).toString(), "pool shares 1000");

    let sum = new BN(0);
    const step = async (w: BN, claim: () => Promise<void>, label: string) => {
      const pre: any = await vaultAcc(V1.vault);
      const CR = bn(pre.collateralRemaining), T = bn(pre.totalShares);
      const exp = w.mul(CR).div(T);
      await claim();
      const post: any = await vaultAcc(V1.vault);
      assert.equal(CR.sub(bn(post.collateralRemaining)).toString(), exp.toString(), `${label}: CR −floor(w·CR/T)`);
      assert.equal(T.sub(bn(post.totalShares)).toString(), w.toString(), `${label}: T −w`);
      sum = sum.add(exp);
    };
    const eq1 = committed1.mul(equivTotal).div(swept), eq2 = committed2.mul(equivTotal).div(swept);
    await step(eq1, async () => { await reclaimBacker(V1, m1.optionMint, backer1); }, "backer1");
    await step(poolShares, async () => { await reclaimPool(V1, poolW); }, "poolW");
    await step(eq2, async () => { await reclaimBacker(V1, m1.optionMint, backer2); }, "backer2");

    const vEnd: any = await vaultAcc(V1.vault);
    assert.equal(vEnd.totalShares.toString(), "0", "T→0");
    assert.isTrue(sum.lte(CR0), "Σ ≤ CR₀");
    assert.equal(sum.toString(), CR0.toString(), "Σ == CR₀ (ratio-1, no dust)");

    // 7 (part): void close fires at T==0; vault_usdc closed.
    const r = await closeVault(V1);
    assert.isNull(r.result, "void close fired at T==0");
    assert.isFalse(await exists(e, V1.vaultUsdc), "vault_usdc closed");
  });

  it("2 — socialization (BOTH numbers): pool payout reflects (TC+swept−E), > (TC−E) without the merge", async () => {
    await initVoid(V2, usdc(11), 1);  // past grace
    const v0: any = await vaultAcc(V2.vault);
    // V2 strike $11 → cpt $11; 7 fills → swept $77; early-exercise CALL $11 @ spot
    // $15 → intrinsic $4. CR₀ = 1000 + 77 − 4 = 1073.
    const TC = usdc(1000), swept = usdc(77), E = usdc(4);
    const CR0 = bn(v0.collateralRemaining), T0 = bn(v0.totalShares);
    assert.equal(CR0.toString(), TC.add(swept).sub(E).toString(), "CR₀ = TC+swept−E = 1073");
    assert.equal(bn(v0.earlyExercisePayout).toString(), E.toString(), "early_exercise_payout E = 4 (the pre-void exercise)");

    const poolShares = bn((await (e.opta.account as any).writerPosition.fetch(V2.writerPos)).shares);
    const mergedPoolPayout = poolShares.mul(CR0).div(T0);                 // WITH the merge
    const withoutMerge = TC.sub(E);                                      // (TC−E)/TS×shares, ratio 1 → TC−E

    const before = await bal(e, await usdcAta(e, poolW.publicKey));
    const crBefore = bn((await vaultAcc(V2.vault)).collateralRemaining);
    await reclaimPool(V2, poolW);
    const crAfter = bn((await vaultAcc(V2.vault)).collateralRemaining);

    assert.equal(crBefore.sub(crAfter).toString(), mergedPoolPayout.toString(), "pool CR-delta == floor(shares·(TC+swept−E)/T)");
    // The pool is NOT short E_wa: the merge pays it MORE than the un-merged (TC−E).
    assert.isTrue(mergedPoolPayout.gt(withoutMerge),
      `merged pool payout ${mergedPoolPayout} > without-merge ${withoutMerge} (socialization reimburses the pool)`);
    // The exact reimbursement = E·swept/(TC+swept) = 5·70/1070.
    assert.equal(mergedPoolPayout.sub(withoutMerge).toString(),
      E.mul(swept).div(TC.add(swept)).toString(), "pool reimbursed E·swept/(TC+swept)");
  });

  it("3 — no-pot void byte-identity: pool-only American + EUR → swept=0, reclaim == TC−E", async () => {
    for (const [v, strike, esByte] of [[Bpool, usdc(12), 1], [Eur, usdc(13), 0]] as [VaultCtx, BN, number][]) {
      await initVoid(v, strike, esByte);
      const a: any = await vaultAcc(v.vault);
      assert.equal(a.writerAskCollateralSwept.toString(), "0", "no pot → swept 0");
      assert.equal(a.writerAskEquivShares.toString(), "0", "no pot → equiv 0");
      // collateral_remaining = TC − E (E=0 here) = total_collateral (byte-identical to old void).
      assert.equal(a.collateralRemaining.toString(), a.totalCollateral.toString(), "CR == TC − E (no bump)");
      assert.equal(a.totalShares.toString(), a.totalCollateral.toString(), "total_shares un-bumped (== TC, 1:1)");
      assert.isTrue(a.voided, "voided");
      // Pool reclaim pays full TC pro-rata then close fires (pool-only-voided rent-strand fix).
      const before = await bal(e, await usdcAta(e, poolW.publicKey));
      const cr = bn(a.collateralRemaining);
      await reclaimPool(v, poolW);
      assert.equal((await bal(e, await usdcAta(e, poolW.publicKey)) - before).toString(), cr.toString(), "pool reclaimed full CR");
      assert.equal((await vaultAcc(v.vault)).totalShares.toString(), "0", "T→0");
      const r = await closeVault(v);
      assert.isNull(r.result, "void close fires on pool-only/EUR voided vault (rent-strand fix)");
      assert.isFalse(await exists(e, v.vaultUsdc), "vault_usdc closed");
    }
  });

  it("6 — pure writer-ask void (TC==0): equiv_total==swept, backer whole, no div-by-zero", async () => {
    await initVoid(V6, usdc(15), 1);
    const v0: any = await vaultAcc(V6.vault);
    assert.equal(v0.totalCollateral.toString(), "0", "TC == 0 (pure writer-ask)");
    assert.equal(v0.writerAskEquivShares.toString(), v0.writerAskCollateralSwept.toString(), "equiv_total == swept");
    assert.equal(v0.collateralRemaining.toString(), usdc(75).toString(), "CR = 0 + 75 − 0 = 75");
    assert.equal(v0.totalShares.toString(), usdc(75).toString(), "total_shares = swept (bumped from 0)");

    const before = await bal(e, await usdcAta(e, backerP.publicKey));
    await reclaimBacker(V6, m6.optionMint, backerP);
    assert.equal((await bal(e, await usdcAta(e, backerP.publicKey)) - before).toString(), usdc(75).toString(), "backer paid full 75");
    assert.equal((await vaultAcc(V6.vault)).totalShares.toString(), "0", "T→0");

    // 8 — double-claim (backer): the zeroed position reverts NothingToClaim
    // (BEFORE the vault is closed — afterwards vault_usdc is gone).
    const dc = await reclaimBacker(V6, m6.optionMint, backerP, true);
    assert.isTrue(dc.logs.join("\n").includes("NothingToClaim"), "second backer reclaim → NothingToClaim");

    const r = await closeVault(V6);
    assert.isNull(r.result, "pure writer-ask voided vault closes");
  });
});
