// =============================================================================
// tests/bankrun/trigger-orders.test.ts — Phase 4 Pass 0: place_trigger / cancel
// =============================================================================
// Proves trigger PLACEMENT + CANCEL only (no execute_trigger — that is Pass 1):
//
//   a. place StopEntryBuy  → TriggerOrder exists w/ correct fields; escrow PDA
//      funded EXACTLY max_premium × quantity; dest option ATA exists; funded=true.
//   b. place TakeProfitSell → TriggerOrder exists; funded=false; no escrow
//      account; reverts when the holder balance < quantity.
//   c. cancel a funded BUY  → full escrow USDC back to owner; both PDAs closed.
//   d. cancel a SELL        → TriggerOrder closed, escrow untouched (never existed).
//   e. place with quantity == 0 → reverts.
//   f. place BUY with max_premium == 0 → reverts.
//   g. units regression: BUY max_premium=P, quantity=Q → escrow balance == P*Q.
//
// Sell holdings come from a real peg fill (the bankrun build carries
// `american-enabled`, so the peg prices live). Distinct (strike, expiry) per
// test ⇒ distinct series mint + vault ⇒ distinct trigger PDAs (no collisions).
// =============================================================================

import {
  PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import { assert } from "chai";
import {
  setupEnv, createVault, deposit, usdcAta, bal, exists, actor, pda, getClockUnix, Env,
  HOOK_PROGRAM_ID,
} from "./helpers";

const CU = (u: number) => ComputeBudgetProgram.setComputeUnitLimit({ units: u });
const usdc = (n: number) => new BN(Math.round(n * 1_000_000));
const DAY = 86_400;
const CALL = { call: {} };
const AMERICAN = { american: {} };
const OT_CALL = 0;
const ES_AMERICAN = 1;

// Enum args (Anchor variant encoding).
const BUY = { stopEntryBuy: {} };
const SELL = { takeProfitSell: {} };
const LE = { lessOrEqual: {} };
const GE = { greaterOrEqual: {} };

function deriveSeries(market: PublicKey, strike: BN, expiry: BN) {
  const mint = pda([Buffer.from("vault_option_mint"), market.toBuffer(),
    strike.toArrayLike(Buffer, "le", 8), expiry.toArrayLike(Buffer, "le", 8),
    Buffer.from([OT_CALL]), Buffer.from([ES_AMERICAN])]);
  const record = pda([Buffer.from("vault_mint_record"), mint.toBuffer()]);
  const extraMetas = pda([Buffer.from("extra-account-metas"), mint.toBuffer()], HOOK_PROGRAM_ID);
  const hookState = pda([Buffer.from("hook-state"), mint.toBuffer()], HOOK_PROGRAM_ID);
  return { mint, record, extraMetas, hookState };
}

function deriveTrigger(owner: PublicKey, mint: PublicKey, nonce: BN) {
  const order = pda([Buffer.from("trigger_order"), owner.toBuffer(), mint.toBuffer(),
    nonce.toArrayLike(Buffer, "le", 8)]);
  const escrow = pda([Buffer.from("trigger_escrow"), order.toBuffer()]);
  return { order, escrow };
}

describe("trigger orders — Pass 0 (place + cancel)", function () {
  this.timeout(120_000);

  let e: Env;

  async function createSeries(strike: BN, expiry: BN) {
    const s = deriveSeries(e.market, strike, expiry);
    await e.opta.methods.createSeries(strike, expiry, CALL, AMERICAN).accountsStrict({
      caller: e.admin.publicKey, market: e.market, protocolState: e.protocolState,
      optionMint: s.mint, vaultMintRecord: s.record, transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList: s.extraMetas, hookState: s.hookState,
      systemProgram: SystemProgram.programId, token2022Program: TOKEN_2022_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(800_000)]).rpc();
    return s;
  }

  async function setupVaultSeries(strike: BN, expiry: BN, depositUsd: number) {
    const writer = actor(e);
    await usdcAta(e, writer.publicKey);
    const { vault, vaultUsdc } = await createVault(e, "american", strike, expiry, CALL, writer);
    await deposit(e, vault, vaultUsdc, writer, depositUsd);
    const s = await createSeries(strike, expiry);
    return { vault, vaultUsdc, s };
  }

  // Real peg fill so an actor actually holds `qty` series contracts (for sells).
  async function fillPeg(vault: PublicKey, vaultUsdc: PublicKey, s: any, taker: Keypair, qty: number) {
    const takerOpt = getAssociatedTokenAddressSync(s.mint, taker.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const takerUsdc = await usdcAta(e, taker.publicKey);
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      e.admin.publicKey, takerOpt, taker.publicKey, s.mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    await e.opta.methods.fillVaultPeg(new BN(qty), usdc(1_000_000)).accountsStrict({
      taker: taker.publicKey, sharedVault: vault, vaultMintRecord: s.record, market: e.market,
      volOracle: e.volOracle, protocolState: e.protocolState, optionMint: s.mint,
      takerOptionAccount: takerOpt, takerUsdcAccount: takerUsdc, vaultUsdcAccount: vaultUsdc,
      treasury: e.treasury, tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
    }).preInstructions([CU(400_000), ataIx]).signers([taker]).rpc();
    return takerOpt;
  }

  async function placeBuy(
    owner: Keypair, s: any, vault: PublicKey, thresholdUsd: BN, qty: number, maxPremium: BN, nonce: BN,
  ) {
    const { order, escrow } = deriveTrigger(owner.publicKey, s.mint, nonce);
    const ownerUsdc = await usdcAta(e, owner.publicKey);
    const ownerOpt = getAssociatedTokenAddressSync(s.mint, owner.publicKey, false, TOKEN_2022_PROGRAM_ID);
    await e.opta.methods.placeTrigger(BUY, GE, thresholdUsd, new BN(qty), maxPremium, nonce).accountsStrict({
      owner: owner.publicKey, market: e.market, sharedVault: vault, vaultMintRecord: s.record,
      optionMint: s.mint, triggerOrder: order, triggerEscrow: escrow, protocolState: e.protocolState,
      usdcMint: e.usdcMint, ownerUsdcAccount: ownerUsdc, ownerOptionAta: ownerOpt,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(400_000)]).signers([owner]).rpc();
    return { order, escrow, ownerUsdc, ownerOpt };
  }

  async function placeSell(
    owner: Keypair, s: any, vault: PublicKey, ownerOpt: PublicKey, thresholdUsd: BN, qty: number, nonce: BN,
  ) {
    const { order, escrow } = deriveTrigger(owner.publicKey, s.mint, nonce);
    const ownerUsdc = await usdcAta(e, owner.publicKey);
    await e.opta.methods.placeTrigger(SELL, LE, thresholdUsd, new BN(qty), new BN(0), nonce).accountsStrict({
      owner: owner.publicKey, market: e.market, sharedVault: vault, vaultMintRecord: s.record,
      optionMint: s.mint, triggerOrder: order, triggerEscrow: escrow, protocolState: e.protocolState,
      usdcMint: e.usdcMint, ownerUsdcAccount: ownerUsdc, ownerOptionAta: ownerOpt,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(400_000)]).signers([owner]).rpc();
    return { order, escrow };
  }

  async function cancel(owner: Keypair, mint: PublicKey, nonce: BN) {
    const { order, escrow } = deriveTrigger(owner.publicKey, mint, nonce);
    const ownerUsdc = await usdcAta(e, owner.publicKey);
    await e.opta.methods.cancelTrigger().accountsStrict({
      owner: owner.publicKey, triggerOrder: order, triggerEscrow: escrow,
      protocolState: e.protocolState, ownerUsdcAccount: ownerUsdc, tokenProgram: TOKEN_PROGRAM_ID,
    }).signers([owner]).rpc();
    return { order, escrow };
  }

  before(async () => {
    e = await setupEnv("TRIGTEST", "trig-feed", 100); // spot $100, ~79% vol planted
  });

  it("a — place StopEntryBuy: order fields + escrow == P*Q + dest ATA + funded", async () => {
    const strike = usdc(100);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * DAY + 1000);
    const { vault, s } = await setupVaultSeries(strike, expiry, 5000);

    const owner = actor(e);
    const P = usdc(8);   // per-contract ceiling $8
    const Q = 3;
    const nonce = new BN(1);
    const { order, escrow, ownerOpt } = await placeBuy(owner, s, vault, usdc(120), Q, P, nonce);

    const t: any = await e.opta.account.triggerOrder.fetch(order);
    assert.equal(t.owner.toBase58(), owner.publicKey.toBase58(), "owner");
    assert.equal(t.market.toBase58(), e.market.toBase58(), "market");
    assert.equal(t.optionMint.toBase58(), s.mint.toBase58(), "option_mint");
    assert.equal(t.vault.toBase58(), vault.toBase58(), "vault");
    assert.isTrue("stopEntryBuy" in t.kind, "kind == StopEntryBuy");
    assert.isTrue("greaterOrEqual" in t.comparator, "comparator == GreaterOrEqual");
    assert.equal(t.thresholdUsdc.toString(), usdc(120).toString(), "threshold");
    assert.equal(t.quantity.toString(), String(Q), "quantity");
    assert.equal(t.maxPremium.toString(), P.toString(), "max_premium stored per-contract");
    assert.equal(t.holderOptionAta.toBase58(), ownerOpt.toBase58(), "dest ATA stored");
    assert.isTrue(t.escrowFunded, "escrow_funded == true");
    assert.equal(t.nonce.toString(), "1", "nonce");

    const escrowBal = await bal(e, escrow);
    assert.equal(escrowBal.toString(), P.mul(new BN(Q)).toString(), "escrow EXACTLY P*Q");
    assert.isTrue(await exists(e, ownerOpt), "destination option ATA created");
  });

  it("b — place TakeProfitSell: funded=false, no escrow; reverts if balance < qty", async () => {
    const strike = usdc(95);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * DAY + 2000);
    const { vault, vaultUsdc, s } = await setupVaultSeries(strike, expiry, 5000);

    // Give the owner 5 real contracts via a peg fill.
    const owner = actor(e);
    const ownerOpt = await fillPeg(vault, vaultUsdc, s, owner, 5);
    assert.equal(await bal(e, ownerOpt), 5n, "owner holds 5 contracts");

    // Happy sell placement (qty 5 <= balance 5).
    const nonce = new BN(7);
    const { order, escrow } = await placeSell(owner, s, vault, ownerOpt, usdc(80), 5, nonce);
    const t: any = await e.opta.account.triggerOrder.fetch(order);
    assert.isTrue("takeProfitSell" in t.kind, "kind == TakeProfitSell");
    assert.isFalse(t.escrowFunded, "escrow_funded == false");
    assert.equal(t.maxPremium.toString(), "0", "max_premium stored 0 for sell");
    assert.equal(t.holderOptionAta.toBase58(), ownerOpt.toBase58(), "source ATA stored");
    assert.isFalse(await exists(e, escrow), "no escrow account created for a sell");

    // Over-balance placement reverts (balance 5 < qty 6).
    let msg = "";
    try { await placeSell(owner, s, vault, ownerOpt, usdc(80), 6, new BN(8)); }
    catch (err: any) { msg = String(err); }
    assert.isTrue(
      msg.includes("InsufficientOptionTokens") || msg.length > 0,
      `balance < qty rejected (${msg.slice(0, 140)})`,
    );
  });

  it("c — cancel a funded BUY: full escrow refunded; both PDAs closed", async () => {
    const strike = usdc(105);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * DAY + 3000);
    const { vault, s } = await setupVaultSeries(strike, expiry, 5000);

    const owner = actor(e);
    const P = usdc(10);
    const Q = 4;
    const nonce = new BN(2);
    const { order, escrow, ownerUsdc } = await placeBuy(owner, s, vault, usdc(120), Q, P, nonce);

    const escrowBal = await bal(e, escrow);
    assert.equal(escrowBal.toString(), P.mul(new BN(Q)).toString(), "escrow funded P*Q before cancel");
    const ownerUsdcBefore = await bal(e, ownerUsdc);

    await cancel(owner, s.mint, nonce);

    const ownerUsdcAfter = await bal(e, ownerUsdc);
    assert.equal(
      (ownerUsdcAfter - ownerUsdcBefore).toString(), P.mul(new BN(Q)).toString(),
      "full escrow USDC refunded to owner",
    );
    assert.isFalse(await exists(e, order), "trigger_order closed");
    assert.isFalse(await exists(e, escrow), "trigger_escrow closed");
  });

  it("d — cancel a SELL: order closed, escrow untouched (never existed)", async () => {
    const strike = usdc(90);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * DAY + 4000);
    const { vault, vaultUsdc, s } = await setupVaultSeries(strike, expiry, 5000);

    const owner = actor(e);
    const ownerOpt = await fillPeg(vault, vaultUsdc, s, owner, 2);
    const optBefore = await bal(e, ownerOpt);

    const nonce = new BN(3);
    const { order, escrow } = await placeSell(owner, s, vault, ownerOpt, usdc(80), 2, nonce);
    assert.isTrue(await exists(e, order), "sell trigger placed");
    assert.isFalse(await exists(e, escrow), "no escrow for a sell");

    await cancel(owner, s.mint, nonce);

    assert.isFalse(await exists(e, order), "trigger_order closed");
    assert.equal(await bal(e, ownerOpt), optBefore, "owner's contracts untouched by cancel");
  });

  it("e — place with quantity == 0 reverts", async () => {
    const strike = usdc(101);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * DAY + 5000);
    const { vault, s } = await setupVaultSeries(strike, expiry, 1000);

    let msg = "";
    try { await placeBuy(actor(e), s, vault, usdc(120), 0, usdc(8), new BN(4)); }
    catch (err: any) { msg = String(err); }
    assert.isTrue(
      msg.includes("InvalidContractSize") || msg.length > 0,
      `quantity=0 rejected (${msg.slice(0, 140)})`,
    );
  });

  it("f — place BUY with max_premium == 0 reverts", async () => {
    const strike = usdc(102);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * DAY + 6000);
    const { vault, s } = await setupVaultSeries(strike, expiry, 1000);

    let msg = "";
    try { await placeBuy(actor(e), s, vault, usdc(120), 2, new BN(0), new BN(5)); }
    catch (err: any) { msg = String(err); }
    assert.isTrue(
      msg.includes("InvalidPremium") || msg.length > 0,
      `max_premium=0 rejected (${msg.slice(0, 140)})`,
    );
  });

  it("g — units regression: BUY max_premium=P, qty=Q ⇒ escrow == P*Q exactly", async () => {
    const strike = usdc(103);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * DAY + 7000);
    const { vault, s } = await setupVaultSeries(strike, expiry, 5000);

    const P = usdc(3);
    const Q = 7;
    const nonce = new BN(6);
    const { escrow } = await placeBuy(actor(e), s, vault, usdc(120), Q, P, nonce);
    assert.equal(
      (await bal(e, escrow)).toString(), P.mul(new BN(Q)).toString(),
      `escrow == P*Q (${P.toString()} × ${Q})`,
    );
  });
});
