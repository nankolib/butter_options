// =============================================================================
// tests/bankrun/writer-ask-cancel.test.ts — Phase 3 Slice C: cancel + sweep
// =============================================================================
// WriterAsk exits: cancel (owner-only) and sweep_expired_orders (permissionless,
// post-expiry). Both refund ONLY the unfilled escrow remainder (cpt ×
// quantity_remaining) and MUST NOT touch the pot / WriterAskPosition (those back
// the already-minted contracts, settled in Slice D). Also proves the sweep
// owner_asset owner-pin closes the permissionless refund-redirect theft vector.
// Testing build (WRITER_ASKS_ENABLED true). cpt = strike = 10 USDC, fee = 50bps.
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
  setupEnv, createVault, createSeries, usdcAta, bal, exists, bumpTokenAmount,
  actor, pda, getClockUnix, setClockUnix, HOOK_PROGRAM_ID, CU, usdc, Env,
} from "./helpers";

const RESTING_ORDER_SEED = Buffer.from("resting_order");
const RESTING_ORDER_ESCROW_SEED = Buffer.from("resting_order_escrow");
const WRITER_ASK_POT_SEED = Buffer.from("writer_ask_pot");
const WRITER_ASK_POT_USDC_SEED = Buffer.from("writer_ask_pot_usdc");
const WRITER_ASK_POSITION_SEED = Buffer.from("writer_ask_position");
const WRITER_ASK = { writerAsk: {} };

describe("writer-ask cancel + sweep (Phase 3 Slice C — refund unfilled remainder)", function () {
  this.timeout(180_000);

  let e: Env;
  let writer: Keypair;
  let strike: BN;
  let baseExpiry = 0;          // distinct expiry per series → distinct CANONICAL mint+vault
  let expiryCtr = 0;
  let nonceCtr = 850;
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
  const potAcc = (p: PublicKey) => (e.opta.account as any).writerAskPot.fetch(p);
  const posAcc = (p: PublicKey) => (e.opta.account as any).writerAskPosition.fetch(p);

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

  // Fresh vault + its CANONICAL create_series mint at a distinct expiry (D2.5).
  async function mkSeries(): Promise<any> {
    const exp = new BN(baseExpiry + (expiryCtr++));
    const cv = await createVault(e, "american", strike, exp, { call: {} }, writer);
    const s = await createSeries(e, strike, exp, { call: {} });
    return { ...s, vault: cv.vault, vaultUsdc: cv.vaultUsdc };
  }

  async function postWriterAsk(m: any, owner: Keypair, price: BN, qty: number, nonce: BN) {
    const { order, escrow } = orderPdas(m.optionMint, owner.publicKey, nonce);
    const ownerUsdc = await usdcAta(e, owner.publicKey);
    const ownerOpt = getAssociatedTokenAddressSync(m.optionMint, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const ix = await e.opta.methods.postOrder(WRITER_ASK, price, new BN(qty), nonce).accountsStrict({
      owner: owner.publicKey, sharedVault: m.vault, market: e.market, vaultMintRecord: m.vaultMintRecord,
      optionMint: m.optionMint, order, escrow, protocolState: e.protocolState,
      ownerOptionAccount: ownerOpt, ownerUsdcAccount: ownerUsdc, usdcMint: e.usdcMint,
      transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: m.extraMetas, hookState: m.hookState,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(400_000)]).instruction();
    return send([ix], owner);
  }

  async function fillWriterAsk(m: any, owner: PublicKey, nonce: BN, taker: Keypair, fillQty: number) {
    const { order, escrow } = orderPdas(m.optionMint, owner, nonce);
    const { pot, potUsdc, position } = potPdas(m.optionMint, owner);
    const takerUsdc = await usdcAta(e, taker.publicKey);
    const makerUsdc = getAssociatedTokenAddressSync(e.usdcMint, owner, false, TOKEN_PROGRAM_ID);
    const takerOpt = getAssociatedTokenAddressSync(m.optionMint, taker.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      taker.publicKey, takerOpt, taker.publicKey, m.optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const ix = await e.opta.methods.fillWriterAsk(new BN(fillQty)).accountsStrict({
      taker: taker.publicKey, optionMint: m.optionMint, order, maker: owner, sharedVault: m.vault,
      vaultMintRecord: m.vaultMintRecord, escrow, protocolState: e.protocolState, treasury: e.treasury,
      takerUsdcAccount: takerUsdc, makerUsdcAccount: makerUsdc, takerOptionAccount: takerOpt,
      writerAskPot: pot, writerAskPotUsdc: potUsdc, writerAskPosition: position, usdcMint: e.usdcMint,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).instruction();
    return send([CU(400_000), ataIx, ix], taker);
  }

  async function cancelWriterAsk(m: any, owner: Keypair, nonce: BN, signer = owner, expectError = false) {
    const { order, escrow } = orderPdas(m.optionMint, owner.publicKey, nonce);
    const ownerUsdc = getAssociatedTokenAddressSync(e.usdcMint, owner.publicKey, false, TOKEN_PROGRAM_ID);
    const ownerOpt = getAssociatedTokenAddressSync(m.optionMint, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const ix = await e.opta.methods.cancelOrder().accountsStrict({
      owner: signer.publicKey, optionMint: m.optionMint, order, escrow, protocolState: e.protocolState,
      ownerOptionAccount: ownerOpt, ownerUsdcAccount: ownerUsdc,
      transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: m.extraMetas, hookState: m.hookState,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).instruction();
    return send([CU(400_000), ix], signer, expectError);
  }

  async function sweep(m: any, tuples: { order: PublicKey; escrow: PublicKey; ownerAsset: PublicKey; ownerWallet: PublicKey }[], caller: Keypair, expectError = false) {
    const remaining = tuples.flatMap((t) => ([
      { pubkey: t.order, isSigner: false, isWritable: true },
      { pubkey: t.escrow, isSigner: false, isWritable: true },
      { pubkey: t.ownerAsset, isSigner: false, isWritable: true },
      { pubkey: t.ownerWallet, isSigner: false, isWritable: true },
    ]));
    const ix = await e.opta.methods.sweepExpiredOrders().accountsStrict({
      caller: caller.publicKey, sharedVault: m.vault, market: e.market, vaultMintRecord: m.vaultMintRecord,
      optionMint: m.optionMint, protocolState: e.protocolState, transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList: m.extraMetas, hookState: m.hookState,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).remainingAccounts(remaining).instruction();
    return send([CU(1_400_000), ix], caller, expectError);
  }

  // Pre-expiry orders parked for the post-expiry sweep tests.
  let sweepHappy: { m: any; nonce: BN };
  let sweepHostile: { m: any; nonce: BN };

  before(async () => {
    e = await setupEnv("WACANCEL", "wa-cancel-feed", 100);
    writer = actor(e);
    await usdcAta(e, writer.publicKey, 1_000_000_000_000n);
    const now = await getClockUnix(e.h.context);
    baseExpiry = now + 3600;     // mkSeries derives a distinct expiry+vault+canonical mint per call
    strike = usdc(10);
    await usdcAta(e, writer.publicKey);
  });

  it("1 — cancel full refund (no fills): owner restored cpt×qty_initial, escrow+order closed", async () => {
    const m = await mkSeries();
    const cpt = strike, qty = 4, nonce = nextNonce();
    await postWriterAsk(m, writer, usdc(7), qty, nonce);
    const o = orderPdas(m.optionMint, writer.publicKey, nonce);
    const ownerUsdc = await usdcAta(e, writer.publicKey);

    assert.equal((await bal(e, o.escrow)).toString(), cpt.muln(qty).toString(), "escrow seeded cpt×4");
    const before = await bal(e, ownerUsdc);
    await cancelWriterAsk(m, writer, nonce);
    assert.equal((await bal(e, ownerUsdc) - before).toString(), cpt.muln(qty).toString(), "owner refunded cpt×4");
    assert.isFalse(await exists(e, o.order), "order closed");
    assert.isFalse(await exists(e, o.escrow), "escrow closed");
  });

  it("2 — partial-fill-then-cancel (#4 invariant): refund cpt×3; pot+position UNCHANGED", async () => {
    const m = await mkSeries();
    const cpt = strike, nonce = nextNonce();
    await postWriterAsk(m, writer, usdc(7), 5, nonce);
    await fillWriterAsk(m, writer.publicKey, nonce, actor(e), 2);

    const o = orderPdas(m.optionMint, writer.publicKey, nonce);
    const { pot, position } = potPdas(m.optionMint, writer.publicKey);
    const ownerUsdc = await usdcAta(e, writer.publicKey);

    // Snapshot pot + position BEFORE the cancel.
    const potBefore: any = await potAcc(pot);
    const posBefore: any = await posAcc(position);
    assert.equal(potBefore.totalCollateral.toString(), cpt.muln(2).toString(), "pot holds cpt×2 (filled)");
    assert.equal((await bal(e, o.escrow)).toString(), cpt.muln(3).toString(), "escrow holds cpt×3 (unfilled)");

    const before = await bal(e, ownerUsdc);
    await cancelWriterAsk(m, writer, nonce);

    // Refund is ONLY the unfilled remainder.
    assert.equal((await bal(e, ownerUsdc) - before).toString(), cpt.muln(3).toString(), "owner refunded cpt×3 only");
    // Pot + position UNCHANGED by the cancel (the #4 invariant).
    const potAfter: any = await potAcc(pot);
    const posAfter: any = await posAcc(position);
    assert.equal(potAfter.totalCollateral.toString(), potBefore.totalCollateral.toString(), "pot collateral unchanged");
    assert.equal(potAfter.totalContracts.toString(), potBefore.totalContracts.toString(), "pot contracts unchanged");
    assert.equal(posAfter.collateralCommitted.toString(), posBefore.collateralCommitted.toString(), "position collateral unchanged");
    assert.equal(posAfter.contractsWritten.toString(), posBefore.contractsWritten.toString(), "position contracts unchanged");
    assert.isFalse(await exists(e, o.order), "order closed");
    assert.isFalse(await exists(e, o.escrow), "escrow closed");
  });

  it("3 — owner-only cancel: a non-owner cannot cancel", async () => {
    const m = await mkSeries();
    const nonce = nextNonce();
    await postWriterAsk(m, writer, usdc(7), 1, nonce);
    const stranger = actor(e);
    // Stranger signs; the order PDA seed embeds writer.key(), so deriving it with
    // the stranger as `owner` fails (wrong PDA / seeds-constraint).
    const r = await cancelWriterAsk(m, writer, nonce, stranger, true);
    assert.isNotNull(r.result, "non-owner cancel must fail");
    const o = orderPdas(m.optionMint, writer.publicKey, nonce);
    assert.isTrue(await exists(e, o.order), "order survives the failed cancel");
  });

  it("4 — dust recovery: donate dust into escrow → cancel refunds full balance, closes clean", async () => {
    const m = await mkSeries();
    const cpt = strike, qty = 2, nonce = nextNonce();
    await postWriterAsk(m, writer, usdc(7), qty, nonce);
    const o = orderPdas(m.optionMint, writer.publicKey, nonce);
    await bumpTokenAmount(e, o.escrow, 7); // donate 7 micro-USDC of dust
    const full = cpt.muln(qty).addn(7);
    assert.equal((await bal(e, o.escrow)).toString(), full.toString(), "escrow = cpt×2 + dust");

    const ownerUsdc = await usdcAta(e, writer.publicKey);
    const before = await bal(e, ownerUsdc);
    await cancelWriterAsk(m, writer, nonce);
    assert.equal((await bal(e, ownerUsdc) - before).toString(), full.toString(), "owner refunded full balance incl dust");
    assert.isFalse(await exists(e, o.escrow), "escrow closed clean");
    assert.isFalse(await exists(e, o.order), "order closed");
  });

  it("setup — park two WriterAsk orders for the post-expiry sweep tests (clock < expiry)", async () => {
    let m = await mkSeries(); let n = nextNonce();
    await postWriterAsk(m, writer, usdc(7), 3, n);
    sweepHappy = { m, nonce: n };
    m = await mkSeries(); n = nextNonce();
    await postWriterAsk(m, writer, usdc(7), 3, n);
    sweepHostile = { m, nonce: n };
  });

  it("warp — advance clock past every series' vault expiry", async () => {
    // mkSeries uses baseExpiry + (ctr); the sweep vaults are the last two, so
    // baseExpiry + expiryCtr + 30 is past all of them.
    const past = baseExpiry + expiryCtr + 30;
    await setClockUnix(e.h.context, past);
    assert.isAtLeast(await getClockUnix(e.h.context), baseExpiry + expiryCtr);
  });

  it("5 — sweep-at-expiry (permissionless): owner refunded full balance, order/escrow closed", async () => {
    const { m, nonce } = sweepHappy;
    const cpt = strike;
    const o = orderPdas(m.optionMint, writer.publicKey, nonce);
    const ownerUsdc = await usdcAta(e, writer.publicKey);
    const caller = actor(e); // anyone
    const before = await bal(e, ownerUsdc);
    await sweep(m, [{ order: o.order, escrow: o.escrow, ownerAsset: ownerUsdc, ownerWallet: writer.publicKey }], caller);
    assert.equal((await bal(e, ownerUsdc) - before).toString(), cpt.muln(3).toString(), "owner refunded cpt×3 by sweep");
    assert.isFalse(await exists(e, o.order), "order closed by sweep");
    assert.isFalse(await exists(e, o.escrow), "escrow closed by sweep");
  });

  it("6a — sweep redirect REJECTED: owner_asset owned by a third party → NotResaleSeller", async () => {
    const { m, nonce } = sweepHostile;
    const o = orderPdas(m.optionMint, writer.publicKey, nonce);
    const thirdParty = actor(e);
    const thirdUsdc = await usdcAta(e, thirdParty.publicKey); // valid USDC acct, owner ≠ order.owner
    const caller = actor(e);
    const r = await sweep(m, [{ order: o.order, escrow: o.escrow, ownerAsset: thirdUsdc, ownerWallet: writer.publicKey }], caller, true);
    assert.isNotNull(r.result, "redirect to a third party must fail");
    assert.isTrue(r.logs.join("\n").includes("NotResaleSeller"), "error = NotResaleSeller");
    assert.isTrue(await exists(e, o.order), "order intact after rejected sweep");
  });

  it("6b — sweep redirect REJECTED: owner_asset is the SWEEPER's own USDC (the live attack) → NotResaleSeller", async () => {
    const { m, nonce } = sweepHostile;
    const o = orderPdas(m.optionMint, writer.publicKey, nonce);
    const sweeper = actor(e);
    const sweeperUsdc = await usdcAta(e, sweeper.publicKey); // attacker's OWN valid USDC account
    // owner_wallet = the real owner (passes the rent-dest pin), owner_asset = attacker.
    const r = await sweep(m, [{ order: o.order, escrow: o.escrow, ownerAsset: sweeperUsdc, ownerWallet: writer.publicKey }], sweeper, true);
    assert.isNotNull(r.result, "sweeper stealing to their own USDC must fail");
    assert.isTrue(r.logs.join("\n").includes("NotResaleSeller"), "error = NotResaleSeller (theft vector closed)");
    assert.isTrue(await exists(e, o.escrow), "escrow intact — funds not redirected");

    // And the order is still correctly sweepable with the RIGHT owner_asset.
    const ownerUsdc = await usdcAta(e, writer.publicKey);
    const before = await bal(e, ownerUsdc);
    await sweep(m, [{ order: o.order, escrow: o.escrow, ownerAsset: ownerUsdc, ownerWallet: writer.publicKey }], actor(e));
    assert.equal((await bal(e, ownerUsdc) - before).toString(), strike.muln(3).toString(), "honest sweep still refunds the owner");
  });
});
