// =============================================================================
// tests/bankrun/exchange-book.test.ts — Phase 1 RestingOrder limit book
// =============================================================================
// Covers post_order / fill_order / cancel_order / sweep_expired_orders against
// the live V2-vault stack. Bootstraps off the lifecycle-smoke pattern: fresh
// bankrun env → European vault → mint → purchase (to seed token-holders) →
// post / fill / cancel / sweep. Clock is warped past expiry once, near the end,
// for the expiry-gated cases (post FIRST while clock < expiry).
//
// Coverage (build-prompt 8 items):
//   1  post ask + post bid (escrow invariants)
//   2a partial ask fill → full fill (decrement, close, rent → maker)
//   2b fee floored to treasury + zero-fee short-circuit
//   3  bid fill end-to-end (tokens → bidder, USDC−fee → taker, fee → treasury)
//   4  cancel ask + cancel bid (pre-expiry) + cancel ask AFTER expiry (hook permits)
//   5  rejects: WriterAsk, qty 0, over-qty, nonce collision, non-owner cancel,
//      post on expired, fill on expired
//   6  self-fill succeeds
//   7  sweep returns both kinds + closes PDAs; zero-balance grace path (pre-burn)
//   8  events: OrderPosted / OrderFilled / OrderCancelled / OrderSwept fields
// =============================================================================

import { Program } from "@coral-xyz/anchor";
import {
  PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction, ComputeBudgetProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import { assert } from "chai";
import {
  setupEnv, createVault, deposit, mint, purchase, usdcAta, bal, exists,
  bumpTokenAmount, actor, pda, setClockUnix, getClockUnix,
  HOOK_PROGRAM_ID, Env,
} from "./helpers";

const RESTING_ORDER_SEED = Buffer.from("resting_order");
const RESTING_ORDER_ESCROW_SEED = Buffer.from("resting_order_escrow");
const CU = (u: number) => ComputeBudgetProgram.setComputeUnitLimit({ units: u });
const usdc = (n: number) => new BN(Math.round(n * 1_000_000));

const BID = { bid: {} };
const RESALE_ASK = { resaleAsk: {} };
const WRITER_ASK = { writerAsk: {} };

interface BookM {
  optionMint: PublicKey;
  vaultMintRecord: PublicKey;
  extraMetas: PublicKey;
  hookState: PublicKey;
}

function deriveOrder(optionMint: PublicKey, owner: PublicKey, nonce: BN) {
  const order = pda([RESTING_ORDER_SEED, optionMint.toBuffer(), owner.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)]);
  const escrow = pda([RESTING_ORDER_ESCROW_SEED, order.toBuffer()]);
  return { order, escrow };
}

function decodeEvents(opta: Program<any>, logs: string[]): { name: string; data: any }[] {
  const out: { name: string; data: any }[] = [];
  for (const line of logs ?? []) {
    if (!line.startsWith("Program data: ")) continue;
    try {
      const d = (opta.coder as any).events.decode(line.slice("Program data: ".length));
      if (d) out.push(d);
    } catch { /* non-event program-data line */ }
  }
  return out;
}

/** Build → sign → tryProcessTransaction. Throws on unexpected failure; with
 * expectError=true returns the result+logs for assertion. Returns decoded events. */
async function send(
  e: Env, ixs: TransactionInstruction[], signers: Keypair[], feePayer: PublicKey,
  expectError = false,
): Promise<{ result: any; events: { name: string; data: any }[]; logs: string[] }> {
  const tx = new Transaction().add(...ixs);
  tx.feePayer = feePayer;
  tx.recentBlockhash = e.h.context.lastBlockhash;
  tx.sign(...signers);
  const res = await e.h.context.banksClient.tryProcessTransaction(tx);
  const logs = (res.meta?.logMessages ?? []) as string[];
  if (!expectError && res.result) {
    throw new Error("tx failed: " + JSON.stringify(res.result) + "\n" + logs.join("\n"));
  }
  return { result: res.result, events: decodeEvents(e.opta, logs), logs };
}

describe("exchange book (Phase 1 — RestingOrder limit book)", function () {
  this.timeout(120_000);

  let e: Env;
  let writer: Keypair, seller: Keypair, taker: Keypair, bidder: Keypair;
  let vault: PublicKey, vaultUsdc: PublicKey;
  let m: BookM;
  let optionMint: PublicKey;
  let sellerOptAta: PublicKey, takerOptAta: PublicKey;
  let expiry: BN;
  let nonceCtr = 1;
  const nextNonce = () => new BN(nonceCtr++);

  // Orders posted pre-expiry for the post-expiry cases.
  let askToCancelLate: { order: PublicKey; escrow: PublicKey; nonce: BN };
  let askToSweep: { order: PublicKey; escrow: PublicKey; nonce: BN };
  let bidToSweep: { order: PublicKey; escrow: PublicKey; nonce: BN };
  let askGrace: { order: PublicKey; escrow: PublicKey; nonce: BN };
  let askFillLate: { order: PublicKey; escrow: PublicKey; nonce: BN };

  // ---- account-list builders (uniform context; values differ per branch) ----
  function postOrderIxs(owner: Keypair, kind: any, price: BN, qty: number, nonce: BN, ownerOptAta: PublicKey, ownerUsdc: PublicKey) {
    const { order, escrow } = deriveOrder(optionMint, owner.publicKey, nonce);
    return {
      order, escrow,
      ixs: [CU(400_000)] as TransactionInstruction[],
      build: async () => e.opta.methods.postOrder(kind, price, new BN(qty), nonce).accountsStrict({
        owner: owner.publicKey, sharedVault: vault, market: e.market, vaultMintRecord: m.vaultMintRecord,
        optionMint, order, escrow, protocolState: e.protocolState,
        ownerOptionAccount: ownerOptAta, ownerUsdcAccount: ownerUsdc, usdcMint: e.usdcMint,
        transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: m.extraMetas, hookState: m.hookState,
        tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      }).instruction(),
    };
  }

  async function postOrder(owner: Keypair, kind: any, price: BN, qty: number, nonce: BN, ownerOptAta: PublicKey, ownerUsdc: PublicKey, expectError = false) {
    const p = postOrderIxs(owner, kind, price, qty, nonce, ownerOptAta, ownerUsdc);
    const ix = await p.build();
    const r = await send(e, [...p.ixs, ix], [owner], owner.publicKey, expectError);
    return { order: p.order, escrow: p.escrow, ...r };
  }

  async function fillAsk(orderInfo: { order: PublicKey; escrow: PublicKey }, sellerPk: PublicKey, qty: number, takerKp: Keypair, sellerUsdc: PublicKey, expectError = false) {
    const takerUsdc = await usdcAta(e, takerKp.publicKey);
    const takerOpt = getAssociatedTokenAddressSync(optionMint, takerKp.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const sellerOptForMakerSlot = getAssociatedTokenAddressSync(optionMint, sellerPk, false, TOKEN_2022_PROGRAM_ID);
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      takerKp.publicKey, takerOpt, takerKp.publicKey, optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const ix = await e.opta.methods.fillOrder(new BN(qty)).accountsStrict({
      taker: takerKp.publicKey, optionMint, order: orderInfo.order, maker: sellerPk, sharedVault: vault,
      escrow: orderInfo.escrow, protocolState: e.protocolState, treasury: e.treasury,
      takerUsdcAccount: takerUsdc, makerUsdcAccount: sellerUsdc,
      takerOptionAccount: takerOpt, makerOptionAccount: sellerOptForMakerSlot,
      transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: m.extraMetas, hookState: m.hookState,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).instruction();
    return send(e, [CU(400_000), ataIx, ix], [takerKp], takerKp.publicKey, expectError);
  }

  async function fillBid(orderInfo: { order: PublicKey; escrow: PublicKey }, bidderPk: PublicKey, qty: number, takerKp: Keypair, bidderUsdc: PublicKey, expectError = false) {
    const takerUsdc = await usdcAta(e, takerKp.publicKey);
    const takerOpt = getAssociatedTokenAddressSync(optionMint, takerKp.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const bidderOpt = getAssociatedTokenAddressSync(optionMint, bidderPk, false, TOKEN_2022_PROGRAM_ID);
    // Taker-funded idempotent pre-create of the BIDDER's option ATA (taker signs, bidder receives).
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      takerKp.publicKey, bidderOpt, bidderPk, optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const ix = await e.opta.methods.fillOrder(new BN(qty)).accountsStrict({
      taker: takerKp.publicKey, optionMint, order: orderInfo.order, maker: bidderPk, sharedVault: vault,
      escrow: orderInfo.escrow, protocolState: e.protocolState, treasury: e.treasury,
      takerUsdcAccount: takerUsdc, makerUsdcAccount: bidderUsdc,
      takerOptionAccount: takerOpt, makerOptionAccount: bidderOpt,
      transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: m.extraMetas, hookState: m.hookState,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).instruction();
    return send(e, [CU(400_000), ataIx, ix], [takerKp], takerKp.publicKey, expectError);
  }

  async function cancelOrder(owner: Keypair, orderInfo: { order: PublicKey; escrow: PublicKey }, ownerOptAta: PublicKey, ownerUsdc: PublicKey, signer = owner, expectError = false) {
    const ix = await e.opta.methods.cancelOrder().accountsStrict({
      owner: signer.publicKey, optionMint, order: orderInfo.order, escrow: orderInfo.escrow,
      protocolState: e.protocolState, ownerOptionAccount: ownerOptAta, ownerUsdcAccount: ownerUsdc,
      transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: m.extraMetas, hookState: m.hookState,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).instruction();
    return send(e, [CU(400_000), ix], [signer], signer.publicKey, expectError);
  }

  async function sweep(tuples: { order: PublicKey; escrow: PublicKey; ownerAsset: PublicKey; ownerWallet: PublicKey }[]) {
    const remaining = tuples.flatMap((t) => ([
      { pubkey: t.order, isSigner: false, isWritable: true },
      { pubkey: t.escrow, isSigner: false, isWritable: true },
      { pubkey: t.ownerAsset, isSigner: false, isWritable: true },
      { pubkey: t.ownerWallet, isSigner: false, isWritable: true },
    ]));
    const ix = await e.opta.methods.sweepExpiredOrders().accountsStrict({
      caller: e.admin.publicKey, sharedVault: vault, market: e.market, vaultMintRecord: m.vaultMintRecord,
      optionMint, protocolState: e.protocolState, transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList: m.extraMetas, hookState: m.hookState,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).remainingAccounts(remaining).instruction();
    return send(e, [CU(1_400_000), ix], [e.admin], e.admin.publicKey);
  }

  const orderAcct = (order: PublicKey) => e.opta.account.restingOrder.fetch(order);

  before(async () => {
    e = await setupEnv("BOOK", "book-feed", 100);
    writer = actor(e); seller = actor(e); taker = actor(e); bidder = actor(e);

    // Fund writer USDC generously BEFORE deposit (idempotent guard keeps the balance).
    await usdcAta(e, writer.publicKey, 100_000_000_000n);
    await usdcAta(e, seller.publicKey);
    await usdcAta(e, taker.publicKey);
    await usdcAta(e, bidder.publicKey);

    const now = await getClockUnix(e.h.context);
    expiry = new BN(now + 3600);
    const strike = usdc(10);
    ({ vault, vaultUsdc } = await createVault(e, "european", strike, expiry, { call: {} }, writer));
    const writerPos = await deposit(e, vault, vaultUsdc, writer, 50_000);
    m = await mint(e, vault, writerPos, writer, 100, now, false) as any;
    optionMint = m.optionMint;

    // Seed token-holders via purchase (escrow → buyer).
    const sRes = await purchase(e, vault, writerPos, m, vaultUsdc, seller, 40);
    const tRes = await purchase(e, vault, writerPos, m, vaultUsdc, taker, 40);
    sellerOptAta = sRes.buyerOptionAta;
    takerOptAta = tRes.buyerOptionAta;
  });

  it("1 — post ask + post bid: escrow invariants", async () => {
    const sellerUsdc = await usdcAta(e, seller.publicKey);
    const ask = await postOrder(seller, RESALE_ASK, usdc(5), 4, nextNonce(), sellerOptAta, sellerUsdc);
    assert.equal((await bal(e, ask.escrow)).toString(), "4", "ask escrow holds 4 contracts");
    const aAcc: any = await orderAcct(ask.order);
    assert.equal(aAcc.quantityRemaining.toString(), "4");
    assert.equal(aAcc.quantityInitial.toString(), "4");
    assert.ok("resaleAsk" in aAcc.kind, "kind = ResaleAsk");

    const bidderUsdc = await usdcAta(e, bidder.publicKey);
    const bid = await postOrder(bidder, BID, usdc(3), 5, nextNonce(), takerOptAta /*unused on bid*/, bidderUsdc);
    assert.equal((await bal(e, bid.escrow)).toString(), usdc(3).muln(5).toString(), "bid escrow holds price×qty USDC");
    const bAcc: any = await orderAcct(bid.order);
    assert.ok("bid" in bAcc.kind, "kind = Bid");
  });

  it("2a — partial ask fill → full fill: decrement, close, rent → maker", async () => {
    const sellerUsdc = await usdcAta(e, seller.publicKey);
    const ask = await postOrder(seller, RESALE_ASK, usdc(5), 4, nextNonce(), sellerOptAta, sellerUsdc);
    const takerOptBefore = await bal(e, takerOptAta);

    await fillAsk(ask, seller.publicKey, 1, taker, sellerUsdc);
    const a: any = await orderAcct(ask.order);
    assert.equal(a.quantityRemaining.toString(), "3", "remaining decremented to 3");
    assert.isTrue(await exists(e, ask.escrow), "escrow still open on partial");

    const makerLamBefore = (await e.h.context.banksClient.getAccount(seller.publicKey))!.lamports;
    await fillAsk(ask, seller.publicKey, 3, taker, sellerUsdc);
    assert.isFalse(await exists(e, ask.order), "order PDA closed on full fill");
    assert.isFalse(await exists(e, ask.escrow), "escrow closed on full fill");
    const makerLamAfter = (await e.h.context.banksClient.getAccount(seller.publicKey))!.lamports;
    assert.isAbove(Number(makerLamAfter), Number(makerLamBefore), "rent returned to maker on close");
    assert.equal((await bal(e, takerOptAta) - takerOptBefore).toString(), "4", "taker received all 4 contracts");
  });

  it("2b — fee floored to treasury + zero-fee short-circuit", async () => {
    const sellerUsdc = await usdcAta(e, seller.publicKey);
    // Flooring: total=301 micro-USDC, fee=floor(301*50/10000)=1, seller gets 300.
    const askF = await postOrder(seller, RESALE_ASK, new BN(301), 1, nextNonce(), sellerOptAta, sellerUsdc);
    const treBefore = await bal(e, e.treasury);
    const selBefore = await bal(e, sellerUsdc);
    await fillAsk(askF, seller.publicKey, 1, taker, sellerUsdc);
    assert.equal((await bal(e, e.treasury) - treBefore).toString(), "1", "fee floored to 1");
    assert.equal((await bal(e, sellerUsdc) - selBefore).toString(), "300", "seller gets total − fee");

    // Zero-fee: total=1, fee=floor(1*50/10000)=0, treasury unchanged.
    const askZ = await postOrder(seller, RESALE_ASK, new BN(1), 1, nextNonce(), sellerOptAta, sellerUsdc);
    const treBefore2 = await bal(e, e.treasury);
    await fillAsk(askZ, seller.publicKey, 1, taker, sellerUsdc);
    assert.equal((await bal(e, e.treasury) - treBefore2).toString(), "0", "zero fee → treasury unchanged");
  });

  it("3 — bid fill end-to-end: tokens → bidder, USDC−fee → taker, fee → treasury", async () => {
    const bidderUsdc = await usdcAta(e, bidder.publicKey);
    const price = usdc(4);
    const qty = 3;
    const bid = await postOrder(bidder, BID, price, qty, nextNonce(), takerOptAta, bidderUsdc);
    const total = price.muln(qty);
    const fee = total.muln(50).divn(10_000); // 600_000

    const takerUsdc = await usdcAta(e, taker.publicKey);
    const bidderOpt = getAssociatedTokenAddressSync(optionMint, bidder.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const takerOptBefore = await bal(e, takerOptAta);
    const takerUsdcBefore = await bal(e, takerUsdc);
    const treBefore = await bal(e, e.treasury);

    await fillBid(bid, bidder.publicKey, qty, taker, bidderUsdc);

    assert.equal((await bal(e, bidderOpt)).toString(), qty.toString(), "bidder received option tokens");
    assert.equal((takerOptBefore - await bal(e, takerOptAta)).toString(), qty.toString(), "taker delivered option tokens");
    assert.equal((await bal(e, takerUsdc) - takerUsdcBefore).toString(), total.sub(fee).toString(), "taker got USDC − fee");
    assert.equal((await bal(e, e.treasury) - treBefore).toString(), fee.toString(), "fee → treasury");
    assert.isFalse(await exists(e, bid.order), "bid order closed on full fill");
  });

  it("6 — self-fill succeeds (locked behavior)", async () => {
    // seller posts an ask and fills it themselves.
    const sellerUsdc = await usdcAta(e, seller.publicKey);
    const ask = await postOrder(seller, RESALE_ASK, usdc(2), 1, nextNonce(), sellerOptAta, sellerUsdc);
    const r = await fillAsk(ask, seller.publicKey, 1, seller, sellerUsdc);
    assert.isNull(r.result, "self-fill did not error");
    assert.isFalse(await exists(e, ask.order), "self-filled order closed");
  });

  it("4 — cancel ask + cancel bid (pre-expiry)", async () => {
    const sellerUsdc = await usdcAta(e, seller.publicKey);
    const ask = await postOrder(seller, RESALE_ASK, usdc(5), 2, nextNonce(), sellerOptAta, sellerUsdc);
    const sellerOptBefore = await bal(e, sellerOptAta);
    await cancelOrder(seller, ask, sellerOptAta, sellerUsdc);
    assert.equal((await bal(e, sellerOptAta) - sellerOptBefore).toString(), "2", "ask cancel returned tokens");
    assert.isFalse(await exists(e, ask.order), "ask order closed on cancel");
    assert.isFalse(await exists(e, ask.escrow), "ask escrow closed on cancel");

    const bidderUsdc = await usdcAta(e, bidder.publicKey);
    const bid = await postOrder(bidder, BID, usdc(3), 4, nextNonce(), takerOptAta, bidderUsdc);
    const bidderUsdcBefore = await bal(e, bidderUsdc);
    await cancelOrder(bidder, bid, takerOptAta /*unused*/, bidderUsdc);
    assert.equal((await bal(e, bidderUsdc) - bidderUsdcBefore).toString(), usdc(3).muln(4).toString(), "bid cancel returned USDC");
    assert.isFalse(await exists(e, bid.order), "bid order closed on cancel");
  });

  it("5 — rejects: WriterAsk, qty 0, over-qty, nonce collision, non-owner cancel", async () => {
    const sellerUsdc = await usdcAta(e, seller.publicKey);

    // WriterAsk rejected.
    const wa = await postOrder(seller, WRITER_ASK, usdc(5), 1, nextNonce(), sellerOptAta, sellerUsdc, true);
    assert.isNotNull(wa.result, "WriterAsk post must fail");
    assert.isTrue(wa.logs.join("\n").includes("WriterAsksDisabled"), "error = WriterAsksDisabled");

    // qty 0 rejected.
    const q0 = await postOrder(seller, RESALE_ASK, usdc(5), 0, nextNonce(), sellerOptAta, sellerUsdc, true);
    assert.isNotNull(q0.result, "qty 0 must fail");

    // Over-qty fill rejected (post qty 1, fill 5).
    const ask = await postOrder(seller, RESALE_ASK, usdc(5), 1, nextNonce(), sellerOptAta, sellerUsdc);
    const over = await fillAsk(ask, seller.publicKey, 5, taker, sellerUsdc, true);
    assert.isNotNull(over.result, "over-qty fill must fail");

    // Nonce collision: re-post same (mint, owner, nonce) → init fails.
    const nonce = nextNonce();
    await postOrder(seller, RESALE_ASK, usdc(5), 1, nonce, sellerOptAta, sellerUsdc);
    const dup = await postOrder(seller, RESALE_ASK, usdc(5), 1, nonce, sellerOptAta, sellerUsdc, true);
    assert.isNotNull(dup.result, "nonce collision must fail (PDA already in use)");

    // Non-owner cancel: taker tries to cancel seller's `ask`.
    const takerUsdc = await usdcAta(e, taker.publicKey);
    const badCancel = await cancelOrder(seller, ask, takerOptAta, takerUsdc, taker, true);
    assert.isNotNull(badCancel.result, "non-owner cancel must fail");
  });

  it("8 — events: OrderPosted / OrderFilled / OrderCancelled fields", async () => {
    const sellerUsdc = await usdcAta(e, seller.publicKey);
    const nonce = nextNonce();
    const posted = await postOrder(seller, RESALE_ASK, usdc(7), 3, nonce, sellerOptAta, sellerUsdc);
    const ev = posted.events.find((x) => x.name === "orderPosted");
    assert.ok(ev, "OrderPosted emitted");
    assert.equal(ev!.data.pricePerContract.toString(), usdc(7).toString());
    assert.equal(ev!.data.quantity.toString(), "3");
    assert.equal(ev!.data.nonce.toString(), nonce.toString());
    assert.equal(ev!.data.kind, 1, "kind u8 = ResaleAsk");

    const filled = await fillAsk(posted, seller.publicKey, 2, taker, sellerUsdc);
    const fe = filled.events.find((x) => x.name === "orderFilled");
    assert.ok(fe, "OrderFilled emitted");
    assert.equal(fe!.data.pricePerContract.toString(), usdc(7).toString(), "event price");
    assert.equal(fe!.data.fillQuantity.toString(), "2", "event fill qty");
    const expFee = usdc(7).muln(2).muln(50).divn(10_000);
    assert.equal(fe!.data.fee.toString(), expFee.toString(), "event fee");
    assert.equal(fe!.data.quantityRemaining.toString(), "1", "event remaining");

    const cancelled = await cancelOrder(seller, posted, sellerOptAta, sellerUsdc);
    const ce = cancelled.events.find((x) => x.name === "orderCancelled");
    assert.ok(ce, "OrderCancelled emitted");
    assert.equal(ce!.data.amountReturned.toString(), "1", "event returned the 1 remaining contract");
  });

  it("setup — post orders for the post-expiry cases (clock still < expiry)", async () => {
    const sellerUsdc = await usdcAta(e, seller.publicKey);
    const bidderUsdc = await usdcAta(e, bidder.publicKey);

    let n = nextNonce(); askToCancelLate = { ...await postOrder(seller, RESALE_ASK, usdc(5), 2, n, sellerOptAta, sellerUsdc), nonce: n };
    n = nextNonce(); askToSweep = { ...await postOrder(seller, RESALE_ASK, usdc(5), 2, n, sellerOptAta, sellerUsdc), nonce: n };
    n = nextNonce(); bidToSweep = { ...await postOrder(bidder, BID, usdc(3), 2, n, takerOptAta, bidderUsdc), nonce: n };
    n = nextNonce(); askGrace = { ...await postOrder(seller, RESALE_ASK, usdc(5), 2, n, sellerOptAta, sellerUsdc), nonce: n };
    n = nextNonce(); askFillLate = { ...await postOrder(seller, RESALE_ASK, usdc(5), 2, n, sellerOptAta, sellerUsdc), nonce: n };
    assert.isTrue(await exists(e, askToSweep.order));
  });

  it("warp — advance clock past expiry", async () => {
    await setClockUnix(e.h.context, expiry.toNumber() + 30);
    assert.isAtLeast(await getClockUnix(e.h.context), expiry.toNumber());
  });

  it("5b — reject post on expired series + fill on expired series", async () => {
    const sellerUsdc = await usdcAta(e, seller.publicKey);
    const late = await postOrder(seller, RESALE_ASK, usdc(5), 1, nextNonce(), sellerOptAta, sellerUsdc, true);
    assert.isNotNull(late.result, "post on expired series must fail");

    const lateFill = await fillAsk(askFillLate, seller.publicKey, 1, taker, sellerUsdc, true);
    assert.isNotNull(lateFill.result, "fill on expired series must fail");
  });

  it("4b — cancel ask AFTER expiry (hook permits protocol-owned source)", async () => {
    const sellerUsdc = await usdcAta(e, seller.publicKey);
    const before = await bal(e, sellerOptAta);
    const r = await cancelOrder(seller, askToCancelLate, sellerOptAta, sellerUsdc);
    assert.isNull(r.result, "cancel after expiry succeeded");
    assert.equal((await bal(e, sellerOptAta) - before).toString(), "2", "tokens returned post-expiry");
  });

  it("7 — sweep returns both kinds + closes PDAs", async () => {
    const bidderUsdc = await usdcAta(e, bidder.publicKey);
    const sellerOptBefore = await bal(e, sellerOptAta);
    const bidderUsdcBefore = await bal(e, bidderUsdc);

    const r = await sweep([
      { order: askToSweep.order, escrow: askToSweep.escrow, ownerAsset: sellerOptAta, ownerWallet: seller.publicKey },
      { order: bidToSweep.order, escrow: bidToSweep.escrow, ownerAsset: bidderUsdc, ownerWallet: bidder.publicKey },
    ]);
    assert.isNull(r.result, "sweep ok");
    assert.equal((await bal(e, sellerOptAta) - sellerOptBefore).toString(), "2", "ask tokens returned by sweep");
    assert.equal((await bal(e, bidderUsdc) - bidderUsdcBefore).toString(), usdc(3).muln(2).toString(), "bid USDC returned by sweep");
    assert.isFalse(await exists(e, askToSweep.order), "ask order closed by sweep");
    assert.isFalse(await exists(e, bidToSweep.order), "bid order closed by sweep");
    const swept = r.events.filter((x) => x.name === "orderSwept");
    assert.equal(swept.length, 2, "two OrderSwept events");
  });

  it("7b — grace path: pre-burned ask escrow → sweep closes gracefully", async () => {
    const sellerUsdc = await usdcAta(e, seller.publicKey);
    // Simulate the PermanentDelegate finalize-burn: zero the escrow's token amount.
    const escBal = await bal(e, askGrace.escrow);
    await bumpTokenAmount(e, askGrace.escrow, -Number(escBal));
    assert.equal((await bal(e, askGrace.escrow)).toString(), "0", "escrow pre-burned to 0");

    const before = await bal(e, sellerOptAta);
    const r = await sweep([
      { order: askGrace.order, escrow: askGrace.escrow, ownerAsset: sellerOptAta, ownerWallet: seller.publicKey },
    ]);
    assert.isNull(r.result, "grace sweep ok");
    assert.equal((await bal(e, sellerOptAta) - before).toString(), "0", "nothing transferred (escrow was empty)");
    assert.isFalse(await exists(e, askGrace.order), "order still closed on grace path");
    assert.isFalse(await exists(e, askGrace.escrow), "escrow still closed on grace path");
    const swept = r.events.find((x) => x.name === "orderSwept");
    assert.equal(swept!.data.amountReturned.toString(), "0", "OrderSwept amount_returned = 0 on grace");
  });
});
