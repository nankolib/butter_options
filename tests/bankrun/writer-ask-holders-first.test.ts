// =============================================================================
// tests/bankrun/writer-ask-holders-first.test.ts — Run-8 H-2 regression
// =============================================================================
// H-2 (High): the holders-first EXERCISE_WINDOW gate in withdraw_post_settlement
// and auto_finalize_writers only fired when total_options_sold > 0. But
// fill_writer_ask NEVER bumps total_options_sold (Slice B isolation) — it funds a
// separate pot. So a settled American vault with writer-ask-minted ITM holders
// but ZERO pool sales (total_options_sold == 0, writer_ask_collateral_swept > 0)
// skipped the window entirely, letting a pool writer front-run those holders and
// drain the merged collateral against the full pre-exercise balance.
//
// Fix: gate on `total_options_sold > 0 || writer_ask_collateral_swept > 0` in
// both paths. This test builds exactly that vault shape:
//   - pool writer (deposit only; never sold via the pool → total_options_sold==0)
//   - writer-ask backer whose ask is filled → ITM holder + swept > 0 at settle
//
//   blocked   — inside the window, withdraw_post_settlement AND
//               auto_finalize_writers both revert HolderExerciseWindowOpen.
//   protected — the writer-ask ITM holder exercises inside the window.
//   normal    — after the window, the pool writer withdraws.
//   control   — a pool-only vault (no writer-ask, no pool sale) still fast-paths.
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
  setupEnv, createVault, deposit, createSeries, usdcAta, bal, actor, pda,
  getClockUnix, setClockUnix, settle, exerciseFromVault, withdrawPostSettlement,
  autoFinalizeWriters, HOOK_PROGRAM_ID, CU, usdc, EXERCISE_WINDOW, Env,
} from "./helpers";

const RESTING_ORDER_SEED = Buffer.from("resting_order");
const RESTING_ORDER_ESCROW_SEED = Buffer.from("resting_order_escrow");
const WRITER_ASK_POT_SEED = Buffer.from("writer_ask_pot");
const WRITER_ASK_POT_USDC_SEED = Buffer.from("writer_ask_pot_usdc");
const WRITER_ASK_POSITION_SEED = Buffer.from("writer_ask_position");
const WRITER_ASK = { writerAsk: {} };
const wUsdcAta = (mint: PublicKey, o: PublicKey) => getAssociatedTokenAddressSync(mint, o, false, TOKEN_PROGRAM_ID);

describe("writer-ask holders-first bypass (Run-8 H-2)", function () {
  this.timeout(180_000);

  let e: Env;
  let writer: Keypair, taker: Keypair;
  let vault: PublicKey, vaultUsdc: PublicKey, writerPos: PublicKey;
  let m: any; // canonical series with the writer-ask pot
  let expiry: BN;
  const nonce = new BN(920);

  async function sendTx(ixs: any[], signer: Keypair) {
    const tx = new Transaction().add(...ixs);
    tx.feePayer = signer.publicKey; tx.recentBlockhash = e.h.context.lastBlockhash; tx.sign(signer);
    const res = await e.h.context.banksClient.tryProcessTransaction(tx);
    const logs = (res.meta?.logMessages ?? []) as string[];
    if (res.result) throw new Error("tx failed: " + JSON.stringify(res.result) + "\n" + logs.join("\n"));
  }

  async function postWriterAsk(price: BN, qty: number) {
    const order = pda([RESTING_ORDER_SEED, m.optionMint.toBuffer(), writer.publicKey.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)]);
    const escrow = pda([RESTING_ORDER_ESCROW_SEED, order.toBuffer()]);
    const ownerUsdc = await usdcAta(e, writer.publicKey);
    const ownerOpt = getAssociatedTokenAddressSync(m.optionMint, writer.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const ix = await e.opta.methods.postOrder(WRITER_ASK, price, new BN(qty), nonce).accountsStrict({
      owner: writer.publicKey, sharedVault: vault, market: e.market, vaultMintRecord: m.vaultMintRecord,
      optionMint: m.optionMint, order, escrow, protocolState: e.protocolState,
      ownerOptionAccount: ownerOpt, ownerUsdcAccount: ownerUsdc, usdcMint: e.usdcMint,
      transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: m.extraMetas, hookState: m.hookState,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(400_000)]).instruction();
    await sendTx([ix], writer);
    return { order, escrow };
  }

  async function fillWriterAsk(order: PublicKey, escrow: PublicKey, fillQty: number) {
    const pot = pda([WRITER_ASK_POT_SEED, m.optionMint.toBuffer()]);
    const potUsdc = pda([WRITER_ASK_POT_USDC_SEED, m.optionMint.toBuffer()]);
    const position = pda([WRITER_ASK_POSITION_SEED, m.optionMint.toBuffer(), writer.publicKey.toBuffer()]);
    const takerUsdc = await usdcAta(e, taker.publicKey);
    const makerUsdc = wUsdcAta(e.usdcMint, writer.publicKey);
    const takerOpt = getAssociatedTokenAddressSync(m.optionMint, taker.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      taker.publicKey, takerOpt, taker.publicKey, m.optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const ix = await e.opta.methods.fillWriterAsk(new BN(fillQty)).accountsStrict({
      taker: taker.publicKey, optionMint: m.optionMint, order, maker: writer.publicKey, sharedVault: vault,
      vaultMintRecord: m.vaultMintRecord, escrow, protocolState: e.protocolState, treasury: e.treasury,
      takerUsdcAccount: takerUsdc, makerUsdcAccount: makerUsdc, takerOptionAccount: takerOpt,
      writerAskPot: pot, writerAskPotUsdc: potUsdc, writerAskPosition: position, usdcMint: e.usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).instruction();
    await sendTx([CU(400_000), ataIx, ix], taker);
    return takerOpt;
  }

  let takerOpt: PublicKey;

  before(async () => {
    e = await setupEnv("H2WA", "h2-wa-feed", 100);
    writer = actor(e); taker = actor(e);
    await usdcAta(e, writer.publicKey, 10_000_000_000_000n);
    await usdcAta(e, taker.publicKey, 10_000_000_000_000n);
    const now = await getClockUnix(e.h.context);
    expiry = new BN(now + 3600);
    const strike = usdc(10);

    // American vault + pool writer (deposit only; NO purchase_from_vault → total_options_sold == 0).
    ({ vault, vaultUsdc } = await createVault(e, "american", strike, expiry, { call: {} }, writer));
    writerPos = await deposit(e, vault, vaultUsdc, writer, 100_000);

    // Canonical series + writer-ask fill → ITM holder (taker) + funded pot.
    m = await createSeries(e, strike, expiry, { call: {} });
    const { order, escrow } = await postWriterAsk(usdc(7), 4);
    takerOpt = await fillWriterAsk(order, escrow, 4); // pot = cpt($10)×4
  });

  it("settle (ITM $15) sweeps the pot → total_options_sold==0 but writer_ask_collateral_swept>0", async () => {
    await settle(e, vault, expiry, 15); // clock = expiry+30, within EXERCISE_WINDOW
    const v: any = await (e.opta.account as any).sharedVault.fetch(vault);
    assert.isTrue(v.isSettled, "settled");
    assert.equal(v.totalOptionsSold.toString(), "0", "no pool sales → total_options_sold == 0 (the H-2 trap)");
    assert.isTrue(new BN(v.writerAskCollateralSwept.toString()).gt(new BN(0)), "writer-ask pot swept > 0");
  });

  it("blocked — withdraw_post_settlement inside window reverts HolderExerciseWindowOpen (H-2 fix)", async () => {
    let err = "";
    try { await withdrawPostSettlement(e, vault, writerPos, writer); }
    catch (ex: any) { err = String(ex); }
    assert.match(err, /HolderExerciseWindowOpen/, "pool writer is blocked while writer-ask holders can still exercise");
  });

  it("blocked — auto_finalize_writers inside window reverts HolderExerciseWindowOpen (H-2 fix)", async () => {
    let err = "";
    try {
      await autoFinalizeWriters(e, vault, vaultUsdc, [[writerPos, wUsdcAta(e.usdcMint, writer.publicKey), writer.publicKey]]);
    } catch (ex: any) { err = String(ex); }
    assert.match(err, /HolderExerciseWindowOpen/, "batched writer finalize is blocked too");
  });

  it("protected — the writer-ask ITM holder exercises inside the window", async () => {
    const takerUsdc = await usdcAta(e, taker.publicKey);
    const before = await bal(e, takerUsdc);
    // CALL strike $10, settle $15 → capped intrinsic $5/contract, 4 contracts.
    await exerciseFromVault(e, vault, m, taker, takerOpt, takerUsdc, 4);
    const paid = (await bal(e, takerUsdc)) - before;
    assert.equal(paid.toString(), usdc(5).muln(4).toString(), "holder paid $5×4 from merged collateral (not front-run)");
  });

  it("normal — after the window the pool writer withdraws", async () => {
    await setClockUnix(e.h.context, expiry.toNumber() + EXERCISE_WINDOW + 60);
    const wusdc = wUsdcAta(e.usdcMint, writer.publicKey);
    const before = await bal(e, wusdc);
    await withdrawPostSettlement(e, vault, writerPos, writer);
    assert.isTrue((await bal(e, wusdc)) - before > 0n, "pool writer withdraws remaining collateral after the window");
  });

  it("control — a pool-only vault (no writer-ask, no pool sale) still fast-paths immediately", async () => {
    const alice = actor(e);
    await usdcAta(e, alice.publicKey, 1_000_000_000_000n);
    const now = await getClockUnix(e.h.context);
    const exp2 = new BN(now + 3600);
    const { vault: v2, vaultUsdc: vu2 } = await createVault(e, "american", usdc(20), exp2, { call: {} }, alice);
    const wp2 = await deposit(e, v2, vu2, alice, 500);
    await settle(e, v2, exp2, 15); // total_options_sold==0, swept==0 → gate bypassed at expiry+30
    const aUsdc = wUsdcAta(e.usdcMint, alice.publicKey);
    const before = await bal(e, aUsdc);
    await withdrawPostSettlement(e, v2, wp2, alice); // clock still expiry+30, must succeed
    assert.isTrue((await bal(e, aUsdc)) - before > 0n, "no-holder vault: writer withdraws immediately (fast path intact)");
  });
});
