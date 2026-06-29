// =============================================================================
// tests/bankrun/writer-ask-fill.test.ts — Phase 3 Slice B: fill_writer_ask
// =============================================================================
// Exercises mint-on-fill from personal collateral on an AMERICAN series, under
// the `testing` build (WRITER_ASKS_ENABLED + AMERICAN_ENABLED true). Each
// scenario uses a FRESH series mint (distinct createdAt) so its WriterAskPot /
// WriterAskPosition are first-touched cleanly. cpt = strike = 10 USDC, fee = 50bps.
//
// Scenarios:
//   1 full-fill: escrow debits cpt×Q→pot; taker minted Q; writer +price×Q−fee;
//                treasury +fee; pot+position counters; order+escrow closed.
//   2 partial-fill CONSERVATION: escrow==cpt×3 AND pot==cpt×2 AND cpt×2+cpt×3
//                ==original cpt×5 (the money-conservation invariant).
//   3 first-touch vs subsequent: init once (taker pays), identity stable, sum.
//   4 self-fill rejected (CannotBuyOwnOption).
//   6 pool isolation: vault.total_options_minted/sold + premium accumulator
//                unchanged by a WriterAsk fill.
// (Scenario 5 — feature-free 6054 — lives in writer-ask-fill-dark-gate.test.ts.)
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
  setupEnv, createVault, deposit, mint, usdcAta, bal, exists, actor, pda, getClockUnix,
  HOOK_PROGRAM_ID, CU, usdc, Env,
} from "./helpers";

const RESTING_ORDER_SEED = Buffer.from("resting_order");
const RESTING_ORDER_ESCROW_SEED = Buffer.from("resting_order_escrow");
const WRITER_ASK_POT_SEED = Buffer.from("writer_ask_pot");
const WRITER_ASK_POT_USDC_SEED = Buffer.from("writer_ask_pot_usdc");
const WRITER_ASK_POSITION_SEED = Buffer.from("writer_ask_position");
const WRITER_ASK = { writerAsk: {} };
const FEE_BPS = 50;
const feeOf = (total: BN) => total.muln(FEE_BPS).divn(10_000);

describe("writer-ask fill (Phase 3 Slice B — mint-on-fill from personal collateral)", function () {
  this.timeout(180_000);

  let e: Env;
  let writer: Keypair;          // the maker/backer for all series
  let vault: PublicKey, vaultUsdc: PublicKey, writerPos: PublicKey;
  let strike: BN;
  let caStamp = 5000;           // distinct createdAt → distinct series mint
  let nonceCtr = 800;
  const nextNonce = () => new BN(nonceCtr++);

  function orderPdas(optionMint: PublicKey, owner: PublicKey, nonce: BN) {
    const order = pda([RESTING_ORDER_SEED, optionMint.toBuffer(), owner.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)]);
    const escrow = pda([RESTING_ORDER_ESCROW_SEED, order.toBuffer()]);
    return { order, escrow };
  }
  function potPdas(optionMint: PublicKey, backer: PublicKey) {
    return {
      pot: pda([WRITER_ASK_POT_SEED, optionMint.toBuffer()]),
      potUsdc: pda([WRITER_ASK_POT_USDC_SEED, optionMint.toBuffer()]),
      position: pda([WRITER_ASK_POSITION_SEED, optionMint.toBuffer(), backer.toBuffer()]),
    };
  }

  // Fresh series: mint 1 contract from the vault → creates the series mint
  // (authority = protocol_state) + its VaultMint record + hook state.
  async function mkSeries(): Promise<any> {
    const now = await getClockUnix(e.h.context);
    return mint(e, vault, writerPos, writer, 1, now + (caStamp++), true);
  }

  async function postWriterAsk(m: any, owner: Keypair, price: BN, qty: number, nonce: BN, expectError = false) {
    const { order, escrow } = orderPdas(m.optionMint, owner.publicKey, nonce);
    const ownerUsdc = await usdcAta(e, owner.publicKey);
    const ownerOpt = getAssociatedTokenAddressSync(m.optionMint, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const ix = await e.opta.methods.postOrder(WRITER_ASK, price, new BN(qty), nonce).accountsStrict({
      owner: owner.publicKey, sharedVault: vault, market: e.market, vaultMintRecord: m.vaultMintRecord,
      optionMint: m.optionMint, order, escrow, protocolState: e.protocolState,
      ownerOptionAccount: ownerOpt, ownerUsdcAccount: ownerUsdc, usdcMint: e.usdcMint,
      transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: m.extraMetas, hookState: m.hookState,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(400_000)]).instruction();
    return send([ix], owner, expectError);
  }

  async function fillWriterAsk(m: any, owner: PublicKey, nonce: BN, taker: Keypair, fillQty: number, expectError = false) {
    const { order, escrow } = orderPdas(m.optionMint, owner, nonce);
    const { pot, potUsdc, position } = potPdas(m.optionMint, owner);
    const takerUsdc = await usdcAta(e, taker.publicKey);
    const makerUsdc = getAssociatedTokenAddressSync(e.usdcMint, owner, false, TOKEN_PROGRAM_ID);
    const takerOpt = getAssociatedTokenAddressSync(m.optionMint, taker.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      taker.publicKey, takerOpt, taker.publicKey, m.optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const ix = await e.opta.methods.fillWriterAsk(new BN(fillQty)).accountsStrict({
      taker: taker.publicKey, optionMint: m.optionMint, order, maker: owner, sharedVault: vault,
      vaultMintRecord: m.vaultMintRecord, escrow, protocolState: e.protocolState, treasury: e.treasury,
      takerUsdcAccount: takerUsdc, makerUsdcAccount: makerUsdc, takerOptionAccount: takerOpt,
      writerAskPot: pot, writerAskPotUsdc: potUsdc, writerAskPosition: position, usdcMint: e.usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).instruction();
    return send([CU(400_000), ataIx, ix], taker, expectError);
  }

  function send(ixs: any[], signer: Keypair, expectError = false) {
    return (async () => {
      const tx = new Transaction().add(...ixs);
      tx.feePayer = signer.publicKey;
      tx.recentBlockhash = e.h.context.lastBlockhash;
      tx.sign(signer);
      const res = await e.h.context.banksClient.tryProcessTransaction(tx);
      const logs = (res.meta?.logMessages ?? []) as string[];
      if (!expectError && res.result) throw new Error("tx failed: " + JSON.stringify(res.result) + "\n" + logs.join("\n"));
      return { result: res.result, logs };
    })();
  }

  const potAcc = (p: PublicKey) => (e.opta.account as any).writerAskPot.fetch(p);
  const posAcc = (p: PublicKey) => (e.opta.account as any).writerAskPosition.fetch(p);

  before(async () => {
    e = await setupEnv("WAFILL", "wa-fill-feed", 100);
    writer = actor(e);
    await usdcAta(e, writer.publicKey, 1_000_000_000_000n); // generous personal USDC for escrows
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 3600);
    strike = usdc(10);
    const cv = await createVault(e, "american", strike, expiry, { call: {} }, writer);
    vault = cv.vault; vaultUsdc = cv.vaultUsdc;
    writerPos = await deposit(e, vault, vaultUsdc, writer, 500_000);
    // Ensure the writer has a classic USDC ATA to RECEIVE premium.
    await usdcAta(e, writer.publicKey);
  });

  it("1 — full-fill: mint, premium split, pot/position counters, close", async () => {
    const m = await mkSeries();
    const { order, escrow } = orderPdas(m.optionMint, writer.publicKey, new BN(0)); void order; void escrow;
    const cpt = strike;
    const price = usdc(7);
    const qty = 3;
    const nonce = nextNonce();
    await postWriterAsk(m, writer, price, qty, nonce);

    const taker = actor(e);
    const takerOpt = getAssociatedTokenAddressSync(m.optionMint, taker.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const makerUsdc = await usdcAta(e, writer.publicKey);
    const o = orderPdas(m.optionMint, writer.publicKey, nonce);
    const { pot, potUsdc, position } = potPdas(m.optionMint, writer.publicKey);

    const total = price.muln(qty), fee = feeOf(total);
    const makerBefore = await bal(e, makerUsdc), treBefore = await bal(e, e.treasury);

    await fillWriterAsk(m, writer.publicKey, nonce, taker, qty);

    assert.equal((await bal(e, takerOpt)).toString(), qty.toString(), "taker minted Q contracts");
    assert.equal((await bal(e, makerUsdc) - makerBefore).toString(), total.sub(fee).toString(), "writer got price×Q − fee");
    assert.equal((await bal(e, e.treasury) - treBefore).toString(), fee.toString(), "treasury got fee");
    assert.equal((await bal(e, potUsdc)).toString(), cpt.muln(qty).toString(), "pot USDC holds cpt×Q");
    const potA: any = await potAcc(pot);
    assert.equal(potA.totalCollateral.toString(), cpt.muln(qty).toString());
    assert.equal(potA.totalContracts.toString(), qty.toString());
    const posA: any = await posAcc(position);
    assert.equal(posA.collateralCommitted.toString(), cpt.muln(qty).toString());
    assert.equal(posA.contractsWritten.toString(), qty.toString());
    assert.equal(posA.backer.toString(), writer.publicKey.toString(), "backer = order.owner (writer)");
    assert.isFalse(await exists(e, o.order), "order closed on full fill");
    assert.isFalse(await exists(e, o.escrow), "escrow closed on full fill");
  });

  it("2 — partial-fill: conservation cpt×2 (pot) + cpt×3 (escrow) == cpt×5 (original)", async () => {
    const m = await mkSeries();
    const cpt = strike;
    const price = usdc(7);
    const nonce = nextNonce();
    await postWriterAsk(m, writer, price, 5, nonce);
    const o = orderPdas(m.optionMint, writer.publicKey, nonce);
    const { potUsdc } = potPdas(m.optionMint, writer.publicKey);

    const originalEscrow = await bal(e, o.escrow);
    assert.equal(originalEscrow.toString(), cpt.muln(5).toString(), "escrow seeded cpt×5 at post");

    const taker = actor(e);
    await fillWriterAsk(m, writer.publicKey, nonce, taker, 2);

    const escrowAfter = await bal(e, o.escrow);
    const potAfter = await bal(e, potUsdc);
    assert.equal(escrowAfter.toString(), cpt.muln(3).toString(), "escrow retains cpt×3");
    assert.equal(potAfter.toString(), cpt.muln(2).toString(), "pot holds cpt×2");
    // MONEY-CONSERVATION INVARIANT (asserted, not implied):
    assert.equal((potAfter + escrowAfter).toString(), originalEscrow.toString(), "cpt×2 + cpt×3 == original cpt×5");
    assert.isTrue(await exists(e, o.order), "order stays open on partial");
    const orderAcc: any = await (e.opta.account as any).restingOrder.fetch(o.order);
    assert.equal(orderAcc.quantityRemaining.toString(), "3", "remaining decremented to 3");
  });

  it("3 — first-touch inits once (taker pays); subsequent accumulates, identity stable", async () => {
    const m = await mkSeries();
    const cpt = strike;
    const { pot, position } = potPdas(m.optionMint, writer.publicKey);
    assert.isFalse(await exists(e, pot), "pot does not exist before first fill");

    // First fill — inits pot + position.
    const n1 = nextNonce();
    await postWriterAsk(m, writer, usdc(7), 2, n1);
    await fillWriterAsk(m, writer.publicKey, n1, actor(e), 2);
    const pot1: any = await potAcc(pot), pos1: any = await posAcc(position);
    assert.equal(pot1.totalContracts.toString(), "2");
    assert.equal(pot1.optionMint.toString(), m.optionMint.toString(), "pot identity = series mint");
    const createdAt1 = pos1.createdAt.toString();

    // Second fill on a NEW order, same series + writer — accumulates, no re-init.
    const n2 = nextNonce();
    await postWriterAsk(m, writer, usdc(7), 3, n2);
    await fillWriterAsk(m, writer.publicKey, n2, actor(e), 3);
    const pot2: any = await potAcc(pot), pos2: any = await posAcc(position);
    assert.equal(pot2.totalContracts.toString(), "5", "pot contracts accumulated 2+3");
    assert.equal(pot2.totalCollateral.toString(), cpt.muln(5).toString(), "pot collateral accumulated");
    assert.equal(pos2.contractsWritten.toString(), "5", "position accumulated");
    assert.equal(pos2.createdAt.toString(), createdAt1, "created_at unchanged (no re-init)");
  });

  it("4 — self-fill rejected (CannotBuyOwnOption)", async () => {
    const m = await mkSeries();
    const n = nextNonce();
    await postWriterAsk(m, writer, usdc(7), 1, n);
    const r = await fillWriterAsk(m, writer.publicKey, n, writer, 1, true);
    assert.isNotNull(r.result, "self-fill must fail");
    assert.isTrue(r.logs.join("\n").includes("CannotBuyOwnOption"), "error = CannotBuyOwnOption");
  });

  it("6 — pool isolation: vault counters + premium accumulator unchanged by a WriterAsk fill", async () => {
    const m = await mkSeries();
    const n = nextNonce();
    await postWriterAsk(m, writer, usdc(7), 2, n);

    const vBefore: any = await (e.opta.account as any).sharedVault.fetch(vault);
    await fillWriterAsk(m, writer.publicKey, n, actor(e), 2);
    const vAfter: any = await (e.opta.account as any).sharedVault.fetch(vault);

    assert.equal(vAfter.totalOptionsMinted.toString(), vBefore.totalOptionsMinted.toString(), "total_options_minted unchanged");
    assert.equal(vAfter.totalOptionsSold.toString(), vBefore.totalOptionsSold.toString(), "total_options_sold unchanged");
    assert.equal(vAfter.premiumPerShareCumulative.toString(), vBefore.premiumPerShareCumulative.toString(), "premium accumulator unchanged");
  });
});
