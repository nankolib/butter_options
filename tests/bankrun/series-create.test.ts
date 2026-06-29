// =============================================================================
// tests/bankrun/series-create.test.ts — Phase 2 Pass A: create_series + record
// =============================================================================
// Covers the canonical per-spec series mint (D5), American-only gate (D12), the
// series record sentinels, book mint-agnosticism interop, the legacy
// purchase_from_vault natural-block, and the exchange-fields schema migration.
//
// The test build carries `american-enabled`, so American vaults can be created
// here (createVault "american").
// =============================================================================

import {
  PublicKey, Keypair, SystemProgram, SYSVAR_RENT_PUBKEY, ComputeBudgetProgram,
  Transaction, TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import BN from "bn.js";
import { assert } from "chai";
import {
  setupEnv, createVault, usdcAta, bal, exists, pda, actor,
  getClockUnix, HOOK_PROGRAM_ID, Env,
} from "./helpers";

const CU = (u: number) => ComputeBudgetProgram.setComputeUnitLimit({ units: u });
const usdc = (n: number) => new BN(Math.round(n * 1_000_000));
const CALL = { call: {} };
const AMERICAN = { american: {} };
const EUROPEAN = { european: {} };
const OT_CALL = 0;
const ES_AMERICAN = 1;

function deriveSeries(market: PublicKey, strike: BN, expiry: BN, otByte: number, esByte: number) {
  const seedMint = Buffer.from("vault_option_mint");
  const mint = pda([seedMint, market.toBuffer(), strike.toArrayLike(Buffer, "le", 8), expiry.toArrayLike(Buffer, "le", 8), Buffer.from([otByte]), Buffer.from([esByte])]);
  const record = pda([Buffer.from("vault_mint_record"), mint.toBuffer()]);
  const extraMetas = pda([Buffer.from("extra-account-metas"), mint.toBuffer()], HOOK_PROGRAM_ID);
  const hookState = pda([Buffer.from("hook-state"), mint.toBuffer()], HOOK_PROGRAM_ID);
  const vaultPda = pda([Buffer.from("shared_vault_american"), market.toBuffer(), strike.toArrayLike(Buffer, "le", 8), expiry.toArrayLike(Buffer, "le", 8), Buffer.from([otByte])]);
  return { mint, record, extraMetas, hookState, vaultPda };
}

describe("create_series (Phase 2 Pass A)", function () {
  this.timeout(120_000);

  let e: Env;
  let now: number;

  async function createSeries(strike: BN, expiry: BN, optionType: any, exerciseStyle: any, expectError = false) {
    const otByte = "put" in optionType ? 1 : 0;
    const esByte = "american" in exerciseStyle ? 1 : 0;
    const s = deriveSeries(e.market, strike, expiry, otByte, esByte);
    const build = () => e.opta.methods.createSeries(strike, expiry, optionType, exerciseStyle).accountsStrict({
      caller: e.admin.publicKey, market: e.market, protocolState: e.protocolState,
      optionMint: s.mint, vaultMintRecord: s.record, transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList: s.extraMetas, hookState: s.hookState,
      systemProgram: SystemProgram.programId, token2022Program: TOKEN_2022_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(800_000)]).rpc();
    if (expectError) {
      let threw = false, msg = "";
      try { await build(); } catch (err: any) { threw = true; msg = String(err); }
      assert.isTrue(threw, "expected create_series to revert");
      return { ...s, err: msg };
    }
    await build();
    return { ...s, err: "" };
  }

  before(async () => {
    e = await setupEnv("SERIES", "series-feed", 100);
    now = await getClockUnix(e.h.context);
  });

  it("1 — happy path: mint (3 ext, dec 0, protocol authority), metadata, hook PDAs, record sentinels", async () => {
    const strike = usdc(150);
    const expiry = new BN(now + 7200);
    const s = await createSeries(strike, expiry, CALL, AMERICAN);

    const mintAcc = await e.h.context.banksClient.getAccount(s.mint);
    assert.ok(mintAcc, "series mint exists");
    assert.ok(mintAcc!.owner.equals(TOKEN_2022_PROGRAM_ID), "owned by Token-2022");
    assert.isAbove(mintAcc!.data.length, 82, "has Token-2022 extensions (> base mint)");
    const data = Buffer.from(mintAcc!.data);
    assert.equal(data[44], 0, "decimals = 0");
    assert.equal(data[0], 1, "mint authority present (COption=1)");
    assert.ok(new PublicKey(data.subarray(4, 36)).equals(e.protocolState), "mint authority = protocol_state");
    // Spec-derived metadata written as UTF-8 TLV strings.
    assert.isTrue(data.includes(Buffer.from("exercise_style")), "exercise_style key in metadata");
    assert.isTrue(data.includes(Buffer.from("american")), "exercise_style value 'american' in metadata");
    assert.isTrue(data.includes(Buffer.from("OPTA-SERIES-150C")), "spec-derived name in metadata");

    assert.isTrue(await exists(e, s.extraMetas), "extra-account-metas PDA initialized");
    assert.isTrue(await exists(e, s.hookState), "hook-state PDA initialized");

    const rec: any = await e.opta.account.vaultMint.fetch(s.record);
    assert.ok((rec.vault as PublicKey).equals(s.vaultPda), "record.vault = derived American vault PDA");
    assert.ok((rec.optionMint as PublicKey).equals(s.mint), "record.option_mint = series mint");
    assert.ok((rec.writer as PublicKey).equals(PublicKey.default), "writer sentinel = default");
    assert.equal((rec.premiumPerContract as BN).toString(), "0", "premium sentinel = 0");
    assert.equal((rec.createdAt as BN).toString(), "0", "created_at sentinel = 0");
    assert.equal((rec.quantityMinted as BN).toString(), "0");
    assert.equal((rec.quantitySold as BN).toString(), "0");
  });

  it("2 — idempotency: second create_series on same spec fails (record PDA init)", async () => {
    const strike = usdc(160);
    const expiry = new BN(now + 7200);
    await createSeries(strike, expiry, CALL, AMERICAN);
    const r = await createSeries(strike, expiry, CALL, AMERICAN, true);
    assert.isTrue(r.err.length > 0, "second create reverted");
  });

  it("3 — rejects: expiry ≤ now, strike = 0, European (D12)", async () => {
    const exp = new BN(now + 7200);
    const past = await createSeries(usdc(170), new BN(now - 100), CALL, AMERICAN, true);
    assert.isTrue(past.err.length > 0, "expiry in past rejected");
    const zero = await createSeries(new BN(0), exp, CALL, AMERICAN, true);
    assert.isTrue(zero.err.length > 0, "strike 0 rejected");
    const eur = await createSeries(usdc(170), exp, CALL, EUROPEAN, true);
    assert.isTrue(eur.err.includes("SeriesMustBeAmerican") || eur.err.includes("6055"), `European rejected with SeriesMustBeAmerican (${eur.err.slice(0, 120)})`);
  });

  it("4 — book interop: post_order Bid on a fresh series mint succeeds (mint-agnostic, zero-supply bid legal)", async () => {
    const strike = usdc(180);
    const expiry = new BN(now + 7200);
    const writer = actor(e);
    await usdcAta(e, writer.publicKey);
    // The series vault must exist for post_order's guards; create it (American).
    const { vault } = await createVault(e, "american", strike, expiry, CALL, writer);
    const s = await createSeries(strike, expiry, CALL, AMERICAN);
    assert.ok(s.vaultPda.equals(vault), "series record vault == created American vault");

    const bidder = actor(e);
    const bidderUsdc = await usdcAta(e, bidder.publicKey);
    const bidderOpt = pda([Buffer.from("x")]); // unused placeholder on a bid (owner_option_account)
    const nonce = new BN(1);
    const order = pda([Buffer.from("resting_order"), s.mint.toBuffer(), bidder.publicKey.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)]);
    const escrow = pda([Buffer.from("resting_order_escrow"), order.toBuffer()]);
    const ix = await e.opta.methods.postOrder({ bid: {} }, usdc(2), new BN(3), nonce).accountsStrict({
      owner: bidder.publicKey, sharedVault: vault, market: e.market, vaultMintRecord: s.record, optionMint: s.mint,
      order, escrow, protocolState: e.protocolState, ownerOptionAccount: bidderOpt, ownerUsdcAccount: bidderUsdc,
      usdcMint: e.usdcMint, transferHookProgram: HOOK_PROGRAM_ID, extraAccountMetaList: s.extraMetas, hookState: s.hookState,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
    }).instruction();
    const tx = new Transaction().add(CU(400_000), ix);
    tx.feePayer = bidder.publicKey; tx.recentBlockhash = e.h.context.lastBlockhash; tx.sign(bidder);
    const res = await e.h.context.banksClient.tryProcessTransaction(tx);
    assert.isNull(res.result, "post_order Bid on series mint succeeded: " + JSON.stringify(res.result));
    assert.equal((await bal(e, escrow)).toString(), usdc(2).muln(3).toString(), "bid escrow holds price×qty USDC");
  });

  it("5 — legacy block: purchase_from_vault against a series record fails account validation", async () => {
    const strike = usdc(190);
    const expiry = new BN(now + 7200);
    const writer = actor(e);
    await usdcAta(e, writer.publicKey);
    const { vault, vaultUsdc } = await createVault(e, "american", strike, expiry, CALL, writer);
    const s = await createSeries(strike, expiry, CALL, AMERICAN);

    // Sentinel-derived per-writer accounts that create_series never creates.
    const writerPos = pda([Buffer.from("writer_position"), vault.toBuffer(), PublicKey.default.toBuffer()]);
    const purchaseEscrow = pda([Buffer.from("vault_purchase_escrow"), vault.toBuffer(), PublicKey.default.toBuffer(), new BN(0).toArrayLike(Buffer, "le", 8)]);
    const buyer = actor(e);
    const buyerUsdc = await usdcAta(e, buyer.publicKey);
    const buyerOpt = pda([Buffer.from("y")]);

    let threw = false, msg = "";
    try {
      await e.opta.methods.purchaseFromVault(new BN(1), usdc(100)).accountsStrict({
        buyer: buyer.publicKey, sharedVault: vault, writerPosition: writerPos, vaultMintRecord: s.record,
        protocolState: e.protocolState, market: e.market, optionMint: s.mint, purchaseEscrow,
        buyerOptionAccount: buyerOpt, buyerUsdcAccount: buyerUsdc, vaultUsdcAccount: vaultUsdc, treasury: e.treasury,
        tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID, transferHookProgram: HOOK_PROGRAM_ID,
        extraAccountMetaList: s.extraMetas, hookState: s.hookState, systemProgram: SystemProgram.programId,
      }).preInstructions([CU(400_000)]).signers([buyer]).rpc();
    } catch (err: any) { threw = true; msg = String(err); }
    assert.isTrue(threw, "purchase_from_vault against a series record must fail (natural block — no per-writer escrow/position): " + msg.slice(0, 160));
  });

  it("6 — migration: truncate to 257 → migrate → 268 with spread_bps=0/voided=false; idempotent", async () => {
    const strike = usdc(200);
    const expiry = new BN(now + 7200);
    const writer = actor(e);
    await usdcAta(e, writer.publicKey);
    const { vault } = await createVault(e, "american", strike, expiry, CALL, writer);

    // Simulate a legacy pre-Pass-A vault: truncate to 257 (post-Stage-F). The
    // Pass-A migration grows short vaults to the CURRENT INIT_SPACE — now 268
    // after the Slice D1 writer_ask_collateral_swept append (was 260) — zero-
    // filling spread_bps + voided + writer_ask_collateral_swept.
    const acc = await e.h.context.banksClient.getAccount(vault);
    assert.equal(acc!.data.length, 268, "fresh vault is 268 bytes (new schema)");
    const truncated = Buffer.from(acc!.data).subarray(0, 257);
    e.h.context.setAccount(vault, { lamports: acc!.lamports, data: truncated, owner: acc!.owner, executable: acc!.executable, rentEpoch: Number(acc!.rentEpoch) });
    assert.equal((await e.h.context.banksClient.getAccount(vault))!.data.length, 257, "truncated to 257");

    await e.opta.methods.migrateSharedVaultExchangeFields().accountsStrict({
      admin: e.admin.publicKey, protocolState: e.protocolState, systemProgram: SystemProgram.programId,
    }).remainingAccounts([{ pubkey: vault, isSigner: false, isWritable: true }]).preInstructions([CU(800_000)]).rpc();

    assert.equal((await e.h.context.banksClient.getAccount(vault))!.data.length, 268, "grown to 268");
    const v: any = await e.opta.account.sharedVault.fetch(vault);
    assert.equal((v.spreadBps as number), 0, "spread_bps = 0 after migration");
    assert.equal((v.voided as boolean), false, "voided = false after migration");

    // Idempotent: second touch skips (stays 268). Distinct CU limit so the tx
    // bytes differ from the first migrate — otherwise an identical message on the
    // same (un-advanced) bankrun blockhash is rejected as a duplicate signature.
    await e.opta.methods.migrateSharedVaultExchangeFields().accountsStrict({
      admin: e.admin.publicKey, protocolState: e.protocolState, systemProgram: SystemProgram.programId,
    }).remainingAccounts([{ pubkey: vault, isSigner: false, isWritable: true }]).preInstructions([CU(810_000)]).rpc();
    assert.equal((await e.h.context.banksClient.getAccount(vault))!.data.length, 268, "still 268 after idempotent re-touch");
  });
});
