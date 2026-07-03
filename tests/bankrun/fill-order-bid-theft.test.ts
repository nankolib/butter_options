// =============================================================================
// tests/bankrun/fill-order-bid-theft.test.ts — Run-8 C-1 regression
// =============================================================================
// C-1 (Critical): on a `Bid` fill, fill_order delivers the taker's option
// tokens to `maker_option_account` and pays the taker the bidder's escrowed
// USDC. maker_option_account WAS an unpinned UncheckedAccount, so a taker could
// pass their OWN option account as the destination — a self-transfer that keeps
// the tokens while still draining the bid escrow. The fix pins
// maker_option_account to (order.owner, order.option_mint) via a raw
// owner(32..64)/mint(0..32) byte check before the transfer.
//
//   negative — taker substitutes their own option account as the maker slot →
//              reverts MakerOptionAccountInvalid (6077); bidder USDC untouched.
//   positive — taker passes the bidder's real option account → fill succeeds
//              (bidder receives tokens, taker receives USDC − fee).
// =============================================================================

import {
  PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY, Transaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import { assert } from "chai";
import {
  setupEnv, createVault, deposit, mint, purchase, usdcAta, bal, exists,
  actor, pda, getClockUnix, HOOK_PROGRAM_ID, Env,
} from "./helpers";

const RESTING_ORDER_SEED = Buffer.from("resting_order");
const RESTING_ORDER_ESCROW_SEED = Buffer.from("resting_order_escrow");
const CU = (u: number) => ComputeBudgetProgram.setComputeUnitLimit({ units: u });
const usdc = (n: number) => new BN(Math.round(n * 1_000_000));
const BID = { bid: {} };

describe("fill_order Bid theft guard (Run-8 C-1)", function () {
  this.timeout(120_000);

  let e: Env;
  let writer: Keypair, bidder: Keypair, taker: Keypair;
  let vault: PublicKey, vaultUsdc: PublicKey;
  let m: any, optionMint: PublicKey;
  let takerOptAta: PublicKey;
  let nonceCtr = 700;
  const nextNonce = () => new BN(nonceCtr++);

  async function postBid(owner: Keypair, price: BN, qty: number, nonce: BN, ownerUsdc: PublicKey) {
    const order = pda([RESTING_ORDER_SEED, optionMint.toBuffer(), owner.publicKey.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)]);
    const escrow = pda([RESTING_ORDER_ESCROW_SEED, order.toBuffer()]);
    const ownerOpt = getAssociatedTokenAddressSync(optionMint, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const ix = await e.opta.methods.postOrder(BID, price, new BN(qty), nonce).accountsStrict({
      owner: owner.publicKey, sharedVault: vault, market: e.market, vaultMintRecord: m.vaultMintRecord,
      optionMint, order, escrow, protocolState: e.protocolState,
      ownerOptionAccount: ownerOpt, ownerUsdcAccount: ownerUsdc, usdcMint: e.usdcMint,
      transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: m.extraMetas, hookState: m.hookState,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).instruction();
    const tx = new Transaction().add(CU(400_000), ix);
    tx.feePayer = owner.publicKey; tx.recentBlockhash = e.h.context.lastBlockhash; tx.sign(owner);
    const res = await e.h.context.banksClient.tryProcessTransaction(tx);
    if (res.result) throw new Error("postBid failed: " + JSON.stringify(res.result));
    return { order, escrow };
  }

  // makerOptionSlot lets the caller CHOOSE the maker_option_account (the C-1
  // knob): the honest value is the bidder's ATA; the attack value is the taker's.
  async function fillBid(
    orderInfo: { order: PublicKey; escrow: PublicKey }, bidderPk: PublicKey, qty: number,
    takerKp: Keypair, bidderUsdc: PublicKey, makerOptionSlot: PublicKey, expectError = false,
  ) {
    const takerUsdc = await usdcAta(e, takerKp.publicKey);
    const takerOpt = getAssociatedTokenAddressSync(optionMint, takerKp.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      takerKp.publicKey, makerOptionSlot, makerOptionSlot.equals(takerOpt) ? takerKp.publicKey : bidderPk,
      optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    const ix = await e.opta.methods.fillOrder(new BN(qty)).accountsStrict({
      taker: takerKp.publicKey, optionMint, order: orderInfo.order, maker: bidderPk, sharedVault: vault,
      escrow: orderInfo.escrow, protocolState: e.protocolState, treasury: e.treasury,
      takerUsdcAccount: takerUsdc, makerUsdcAccount: bidderUsdc,
      takerOptionAccount: takerOpt, makerOptionAccount: makerOptionSlot,
      transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: m.extraMetas, hookState: m.hookState,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).instruction();
    const tx = new Transaction().add(CU(400_000), ataIx, ix);
    tx.feePayer = takerKp.publicKey; tx.recentBlockhash = e.h.context.lastBlockhash; tx.sign(takerKp);
    const res = await e.h.context.banksClient.tryProcessTransaction(tx);
    const logs = (res.meta?.logMessages ?? []).join("\n");
    if (!expectError && res.result) throw new Error("fillBid failed: " + JSON.stringify(res.result) + "\n" + logs);
    return { result: res.result, logs };
  }

  before(async () => {
    e = await setupEnv("C1THEFT", "c1-theft-feed", 100);
    writer = actor(e); bidder = actor(e); taker = actor(e);
    await usdcAta(e, writer.publicKey, 100_000_000_000n);
    await usdcAta(e, bidder.publicKey, 100_000_000_000n);
    await usdcAta(e, taker.publicKey);

    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 3600);
    ({ vault, vaultUsdc } = await createVault(e, "european", usdc(10), expiry, { call: {} }, writer));
    const writerPos = await deposit(e, vault, vaultUsdc, writer, 50_000);
    m = await mint(e, vault, writerPos, writer, 100, now, false);
    optionMint = m.optionMint;
    // Give the taker option tokens to deliver on a bid fill.
    const tRes = await purchase(e, vault, writerPos, m, vaultUsdc, taker, 40);
    takerOptAta = tRes.buyerOptionAta;
  });

  it("negative — taker substitutes their own option account as maker slot → 6077, escrow intact", async () => {
    const bidderUsdc = await usdcAta(e, bidder.publicKey);
    const price = usdc(4), qty = 3;
    const bid = await postBid(bidder, price, qty, nextNonce(), bidderUsdc);
    const escrowBefore = await bal(e, bid.escrow);
    const takerUsdc = await usdcAta(e, taker.publicKey);
    const takerUsdcBefore = await bal(e, takerUsdc);
    const takerOptBefore = await bal(e, takerOptAta);

    // Attack: makerOptionSlot = taker's OWN option ATA.
    const r = await fillBid(bid, bidder.publicKey, qty, taker, bidderUsdc, takerOptAta, true);
    assert.isNotNull(r.result, "self-substitution bid fill must fail");
    assert.isTrue(r.logs.includes("MakerOptionAccountInvalid"), "error = MakerOptionAccountInvalid (6077)");

    // Nothing moved: escrow full, taker USDC + tokens unchanged, order still open.
    assert.equal((await bal(e, bid.escrow)).toString(), escrowBefore.toString(), "bid escrow untouched");
    assert.equal((await bal(e, takerUsdc)).toString(), takerUsdcBefore.toString(), "taker gained no USDC");
    assert.equal((await bal(e, takerOptAta)).toString(), takerOptBefore.toString(), "taker kept exactly their tokens (no self-transfer credit)");
    assert.isTrue(await exists(e, bid.order), "bid order still open");
  });

  it("positive — legit maker (bidder) option account fills: tokens → bidder, USDC−fee → taker", async () => {
    const bidderUsdc = await usdcAta(e, bidder.publicKey);
    const price = usdc(4), qty = 3;
    const bid = await postBid(bidder, price, qty, nextNonce(), bidderUsdc);
    const total = price.muln(qty);
    const fee = total.muln(50).divn(10_000);
    const bidderOpt = getAssociatedTokenAddressSync(optionMint, bidder.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const takerUsdc = await usdcAta(e, taker.publicKey);
    const takerUsdcBefore = await bal(e, takerUsdc);
    const takerOptBefore = await bal(e, takerOptAta);
    const treBefore = await bal(e, e.treasury);

    const r = await fillBid(bid, bidder.publicKey, qty, taker, bidderUsdc, bidderOpt, false);
    assert.isNull(r.result, "honest bid fill succeeds");
    assert.equal((await bal(e, bidderOpt)).toString(), qty.toString(), "bidder received the option tokens");
    assert.equal((takerOptBefore - await bal(e, takerOptAta)).toString(), qty.toString(), "taker delivered the tokens");
    assert.equal((await bal(e, takerUsdc) - takerUsdcBefore).toString(), total.sub(fee).toString(), "taker got USDC − fee");
    assert.equal((await bal(e, e.treasury) - treBefore).toString(), fee.toString(), "fee → treasury");
    assert.isFalse(await exists(e, bid.order), "bid order closed on full fill");
  });
});
