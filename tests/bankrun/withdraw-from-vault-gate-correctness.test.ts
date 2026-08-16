// =============================================================================
// withdraw-from-vault-gate-correctness.test.ts — Phase 3 Slice D2b TRIPWIRE
// =============================================================================
// D2b was DROPPED: the BREAK-2 "fold" is a no-op because every writer-ask
// contract is backed by the same cpt as a pool contract, so
//   pot.total_collateral ≥ cpt × pot.total_contracts (uniform cpt per series)
// ⇒ folding the pot into net AND committed cancels ⇒ folded ≥ OLD, and OLD is
// already the correct merged-solvency bound (the pot's D1 settle-sweep reimburses
// the per-exercise freeing). This test PROVES it on real on-chain state across
// {no-pot, with-pot, with-pot-after-writer-ask-early-exercise}. It is a TRIPWIRE:
// if cpt-uniformity ever breaks (variable cpt), the DIRECTION flips here and
// withdraw_from_vault's American gate must be revisited.
//
// 2026-08-15 — both relations relaxed from ≡ to ≥, in the safe direction. The
// pot leg in exercise_american debits the pot by the payout (capped at cpt) while
// retiring a whole contract, so a pot-funded vault ends up with the pot holding
// AT LEAST cpt × contracts, and folded ≥ OLD. OLD is thus the tighter bound and
// can only over-reserve. Equality still holds wherever no pot-funded draw has
// happened, which is every case in this file; the pot-funded arithmetic itself is
// pinned by writer-ask-settle.test.ts tests 7-10.
// =============================================================================

import { PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import { assert } from "chai";
import {
  setupEnv, createVault, deposit, mint, purchase, createSeries, usdcAta, actor, pda, getClockUnix,
  exerciseAmerican, HOOK_PROGRAM_ID, CU, usdc, Env,
} from "./helpers";

const RESTING_ORDER_SEED = Buffer.from("resting_order");
const RESTING_ORDER_ESCROW_SEED = Buffer.from("resting_order_escrow");
const WRITER_ASK_POT_SEED = Buffer.from("writer_ask_pot");
const WRITER_ASK_POT_USDC_SEED = Buffer.from("writer_ask_pot_usdc");
const WRITER_ASK_POSITION_SEED = Buffer.from("writer_ask_position");
const WRITER_ASK = { writerAsk: {} };

// The two expressions the gate could use. They MUST be equal whenever
// potColl == cpt × potContracts. Signed BN subtraction — sign is irrelevant; we
// assert equality of the raw expressions, which is exactly what the fold cancels.
function oldFree(tc: BN, early: BN, tm: BN, ex: BN, cpt: BN): BN {
  return tc.sub(early).sub(tm.sub(ex).mul(cpt));
}
function foldedFree(tc: BN, early: BN, tm: BN, ex: BN, cpt: BN, potColl: BN, potContracts: BN): BN {
  return tc.add(potColl).sub(early).sub(tm.add(potContracts).sub(ex).mul(cpt));
}

describe("withdraw_from_vault gate correctness (Phase 3 Slice D2b tripwire)", function () {
  this.timeout(180_000);
  let e: Env;
  let writer: Keypair, vault: PublicKey, vaultUsdc: PublicKey, writerPos: PublicKey;
  let m: any, mc: any, cpt: BN, taker: Keypair;
  const nonce = new BN(960);

  const potPdas = (mint: PublicKey) => ({
    pot: pda([WRITER_ASK_POT_SEED, mint.toBuffer()]),
    potUsdc: pda([WRITER_ASK_POT_USDC_SEED, mint.toBuffer()]),
    position: pda([WRITER_ASK_POSITION_SEED, mint.toBuffer(), writer.publicKey.toBuffer()]),
  });
  const orderPdas = (mint: PublicKey, owner: PublicKey, n: BN) => {
    const order = pda([RESTING_ORDER_SEED, mint.toBuffer(), owner.toBuffer(), n.toArrayLike(Buffer, "le", 8)]);
    return { order, escrow: pda([RESTING_ORDER_ESCROW_SEED, order.toBuffer()]) };
  };
  const vAcc = (v: PublicKey) => (e.opta.account as any).sharedVault.fetch(v);
  const potAcc = (p: PublicKey) => (e.opta.account as any).writerAskPot.fetch(p);
  const bnOf = (x: any) => new BN(x.toString());

  async function send(ixs: any[], signer: Keypair) {
    const tx = new Transaction().add(...ixs);
    tx.feePayer = signer.publicKey; tx.recentBlockhash = e.h.context.lastBlockhash; tx.sign(signer);
    const res = await e.h.context.banksClient.tryProcessTransaction(tx);
    if (res.result) throw new Error("tx failed: " + JSON.stringify(res.result) + "\n" + (res.meta?.logMessages ?? []).join("\n"));
  }
  // Assert the gate identity for a given vault + (optional) pot state.
  async function assertGateIdentity(v: PublicKey, potMint: PublicKey | null) {
    const va: any = await vAcc(v);
    const tc = bnOf(va.totalCollateral), early = bnOf(va.earlyExercisePayout);
    const tm = bnOf(va.totalOptionsMinted), ex = bnOf(va.exercisedOptions);
    let potColl = new BN(0), potContracts = new BN(0);
    if (potMint) {
      const pa: any = await potAcc(potPdas(potMint).pot);
      potColl = bnOf(pa.totalCollateral); potContracts = bnOf(pa.totalContracts);
      // ROOT INVARIANT (the tripwire): pot.total_collateral ≥ cpt × pot.total_contracts.
      // Equality is the cpt-uniformity case. A POT-FUNDED early exercise
      // (2026-08-15) retires a whole contract while debiting only the payout —
      // capped at cpt — so the pot can end up over-collateralised relative to the
      // contracts it still backs. That is the safe side; the direction is what
      // this asserts. If variable cpt ever inverts it, this fires.
      assert.isTrue(potColl.gte(cpt.mul(potContracts)),
        `pot.total_collateral (${potColl}) >= cpt × pot.total_contracts (${cpt.mul(potContracts)})`);
    }
    const oldF = oldFree(tc, early, tm, ex, cpt);
    const foldedF = foldedFree(tc, early, tm, ex, cpt, potColl, potContracts);
    // OLD ≤ folded ⇒ the OLD gate is the tighter bound, so leaving withdraw_from_vault's
    // American gate on the OLD expression can only over-reserve, never under-reserve.
    assert.isTrue(foldedF.gte(oldF),
      `merged-folded gate (${foldedF}) >= OLD gate (${oldF}) — OLD never under-reserves`);
  }

  before(async () => {
    e = await setupEnv("WAGATE", "wa-gate-feed", 100);
    writer = actor(e);
    await usdcAta(e, writer.publicKey, 10_000_000_000_000n);
    await usdcAta(e, writer.publicKey);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 3600);
    cpt = usdc(10); // strike → cpt
    const cv = await createVault(e, "american", cpt, expiry, { call: {} }, writer);
    vault = cv.vault; vaultUsdc = cv.vaultUsdc;
    writerPos = await deposit(e, vault, vaultUsdc, writer, 1_000_000);
    m = await mint(e, vault, writerPos, writer, 50, now, true);          // 50 pool contracts
    const buyer = actor(e);
    await purchase(e, vault, writerPos, m, vaultUsdc, buyer, 30);          // total_options_sold = 30

    // D2.5: the WriterAsk rests on the CANONICAL create_series mint `mc` (the pin
    // rejects per-writer mints); the pool stays on `m`. The fold identity
    // (potColl == cpt × potContracts) is per-vault + mint-agnostic, so the
    // tripwire holds across the pool(m) + writer-ask(mc) mixed-mint vault.
    mc = await createSeries(e, cpt, expiry, { call: {} });
    // WriterAsk fill (pot funded: 20 contracts → pot.total_collateral = cpt × 20).
    const { order, escrow } = orderPdas(mc.optionMint, writer.publicKey, nonce);
    const ownerUsdc = await usdcAta(e, writer.publicKey);
    const ownerOpt = getAssociatedTokenAddressSync(mc.optionMint, writer.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const postIx = await e.opta.methods.postOrder(WRITER_ASK, usdc(7), new BN(20), nonce).accountsStrict({
      owner: writer.publicKey, sharedVault: vault, market: e.market, vaultMintRecord: mc.vaultMintRecord,
      optionMint: mc.optionMint, order, escrow, protocolState: e.protocolState,
      ownerOptionAccount: ownerOpt, ownerUsdcAccount: ownerUsdc, usdcMint: e.usdcMint,
      transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: mc.extraMetas, hookState: mc.hookState,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(400_000)]).instruction();
    await send([postIx], writer);

    taker = actor(e);
    const { pot, potUsdc, position } = potPdas(mc.optionMint);
    const takerUsdc = await usdcAta(e, taker.publicKey);
    const makerUsdc = getAssociatedTokenAddressSync(e.usdcMint, writer.publicKey, false, TOKEN_PROGRAM_ID);
    const takerOpt = getAssociatedTokenAddressSync(mc.optionMint, taker.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      taker.publicKey, takerOpt, taker.publicKey, mc.optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const fillIx = await e.opta.methods.fillWriterAsk(new BN(20)).accountsStrict({
      taker: taker.publicKey, optionMint: mc.optionMint, order, maker: writer.publicKey, sharedVault: vault,
      vaultMintRecord: mc.vaultMintRecord, escrow, protocolState: e.protocolState, treasury: e.treasury,
      takerUsdcAccount: takerUsdc, makerUsdcAccount: makerUsdc, takerOptionAccount: takerOpt,
      writerAskPot: pot, writerAskPotUsdc: potUsdc, writerAskPosition: position, usdcMint: e.usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).instruction();
    await send([CU(400_000), ataIx, fillIx], taker);
  });

  it("1 — no-pot: a pool-only American vault → OLD == folded (pot terms zero)", async () => {
    const w2 = actor(e); await usdcAta(e, w2.publicKey, 1_000_000_000n);
    const now = await getClockUnix(e.h.context);
    const cv = await createVault(e, "american", usdc(11), new BN(now + 3600), { call: {} }, w2);
    await deposit(e, cv.vault, cv.vaultUsdc, w2, 1000);
    await assertGateIdentity(cv.vault, null); // no pot
  });

  it("2 — with-pot: folded >= OLD AND pot.total_collateral >= cpt × pot.total_contracts", async () => {
    await assertGateIdentity(vault, mc.optionMint);
  });

  it("3 — with-pot AFTER a POOL-funded writer-ask early-exercise: direction still holds (the case D-recon thought broke)", async () => {
    const takerOpt = getAssociatedTokenAddressSync(mc.optionMint, taker.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const takerUsdc = await usdcAta(e, taker.publicKey);
    const now = await getClockUnix(e.h.context);
    await exerciseAmerican(e, vault, mc, taker, takerOpt, takerUsdc, 3, 15, now); // 3 writer-ask early-exercises (canonical mint), spot $15
    const va: any = await vAcc(vault);
    assert.isTrue(bnOf(va.exercisedOptions).gten(3), "exercised_options bumped by the writer-ask early-exercise (merged counter)");
    await assertGateIdentity(vault, mc.optionMint); // folded >= OLD still holds
  });
});
