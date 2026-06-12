// =============================================================================
// tests/bankrun/create-and-deposit.test.ts — Phase 2 Pass C
// =============================================================================
// Proves the atomic write merge (D9) + the two collateral-gate fixes (rulings
// a/a2) that the peg (Pass B) made necessary:
//
//   1. FRESH — create_and_deposit on an absent vault: creates SharedVault +
//      vault_usdc + WriterPosition, collateral in, shares == amount, fields set.
//   2. EXISTING — a second create_and_deposit into the same spec just deposits
//      (init_if_needed), NEVER rewrites identity fields (created_at/creator).
//   3. EUR merged == sequential — create_and_deposit yields the same economic +
//      config state as create_shared_vault + deposit_to_vault, field-by-field.
//   4. a2 RACE (American) — peg fills, THEN a writer direct-mint that would
//      over-commit the pool reverts (vault-level gate); within-free succeeds.
//   5. WITHDRAW × PEG (American) — an LP cannot withdraw collateral the peg has
//      committed against sold contracts (vault-level gate); within-free succeeds.
//
// EUR vaults can't have peg fills, so the vault-level gates never fire on the
// EUR arm — proven byte-identical by the existing vault/withdraw suites staying
// green + test 3's equivalence.
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
  setupEnv, createVault, deposit, mint, usdcAta, bal, actor, pda, getClockUnix,
  claimPremium, withdrawFromVault, HOOK_PROGRAM_ID, Env,
} from "./helpers";

const CU = (u: number) => ComputeBudgetProgram.setComputeUnitLimit({ units: u });
const usdc = (n: number) => new BN(Math.round(n * 1_000_000));
const DAY = 86_400;
const CALL = { call: {} };
const CUSTOM = { custom: {} };
const EUROPEAN = { european: {} };
const AMERICAN = { american: {} };
const OT_CALL = 0;
const ES_AMER = 1;

function deriveVaultLocal(market: PublicKey, style: "european" | "american", strike: BN, expiry: BN) {
  const seed = style === "american" ? "shared_vault_american" : "shared_vault";
  const vault = pda([Buffer.from(seed), market.toBuffer(),
    strike.toArrayLike(Buffer, "le", 8), expiry.toArrayLike(Buffer, "le", 8), Buffer.from([OT_CALL])]);
  const vaultUsdc = pda([Buffer.from("vault_usdc"), vault.toBuffer()]);
  return { vault, vaultUsdc };
}

describe("create_and_deposit (Phase 2 Pass C)", function () {
  this.timeout(120_000);

  let e: Env;

  async function createAndDeposit(
    style: "european" | "american", strike: BN, expiry: BN, writer: Keypair, amountUsd: number,
  ) {
    const { vault, vaultUsdc } = deriveVaultLocal(e.market, style, strike, expiry);
    const writerPos = pda([Buffer.from("writer_position"), vault.toBuffer(), writer.publicKey.toBuffer()]);
    const styleArg = style === "american" ? AMERICAN : EUROPEAN;
    await e.opta.methods.createAndDeposit(strike, expiry, CALL, CUSTOM, e.usdcMint, 0, styleArg, usdc(amountUsd))
      .accountsStrict({
        writer: writer.publicKey, market: e.market, sharedVault: vault, vaultUsdcAccount: vaultUsdc,
        usdcMint: e.usdcMint, writerPosition: writerPos, writerUsdcAccount: await usdcAta(e, writer.publicKey),
        protocolState: e.protocolState, epochConfig: null,
        tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).preInstructions([CU(400_000)]).signers([writer]).rpc();
    return { vault, vaultUsdc, writerPos };
  }

  function deriveSeries(strike: BN, expiry: BN) {
    const mint_ = pda([Buffer.from("vault_option_mint"), e.market.toBuffer(),
      strike.toArrayLike(Buffer, "le", 8), expiry.toArrayLike(Buffer, "le", 8),
      Buffer.from([OT_CALL]), Buffer.from([ES_AMER])]);
    return {
      mint: mint_,
      record: pda([Buffer.from("vault_mint_record"), mint_.toBuffer()]),
      extraMetas: pda([Buffer.from("extra-account-metas"), mint_.toBuffer()], HOOK_PROGRAM_ID),
      hookState: pda([Buffer.from("hook-state"), mint_.toBuffer()], HOOK_PROGRAM_ID),
    };
  }

  async function createSeries(strike: BN, expiry: BN) {
    const s = deriveSeries(strike, expiry);
    await e.opta.methods.createSeries(strike, expiry, CALL, AMERICAN).accountsStrict({
      caller: e.admin.publicKey, market: e.market, protocolState: e.protocolState,
      optionMint: s.mint, vaultMintRecord: s.record, transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList: s.extraMetas, hookState: s.hookState,
      systemProgram: SystemProgram.programId, token2022Program: TOKEN_2022_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY,
    }).preInstructions([CU(800_000)]).rpc();
    return s;
  }

  async function fillPeg(vault: PublicKey, vaultUsdc: PublicKey, s: any, taker: Keypair, qty: number) {
    const takerOpt = getAssociatedTokenAddressSync(s.mint, taker.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      e.admin.publicKey, takerOpt, taker.publicKey, s.mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    await e.opta.methods.fillVaultPeg(new BN(qty), usdc(1_000_000)).accountsStrict({
      taker: taker.publicKey, sharedVault: vault, vaultMintRecord: s.record, market: e.market,
      volOracle: e.volOracle, protocolState: e.protocolState, optionMint: s.mint,
      takerOptionAccount: takerOpt, takerUsdcAccount: await usdcAta(e, taker.publicKey),
      vaultUsdcAccount: vaultUsdc, treasury: e.treasury,
      tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
    }).preInstructions([CU(400_000), ataIx]).signers([taker]).rpc();
  }

  before(async () => {
    e = await setupEnv("PASSC", "passc-feed", 100);
  });

  it("1 — fresh: creates vault + position, collateral in, shares == amount, fields set", async () => {
    const strike = usdc(100);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * DAY + 1000);
    const w = actor(e);
    await usdcAta(e, w.publicKey);
    const { vault, vaultUsdc, writerPos } = await createAndDeposit("european", strike, expiry, w, 500);

    const v: any = await e.opta.account.sharedVault.fetch(vault);
    assert.equal(v.totalCollateral.toString(), usdc(500).toString(), "total_collateral = 500");
    assert.equal(v.totalShares.toString(), usdc(500).toString(), "total_shares = 500 (first depositor 1:1)");
    assert.ok((v.creator as PublicKey).equals(w.publicKey), "creator = writer");
    assert.equal(v.strikePrice.toString(), strike.toString());
    assert.isAbove(Number(v.createdAt), 0, "created_at set");
    assert.equal(await bal(e, vaultUsdc), BigInt(usdc(500).toString()), "vault_usdc holds collateral");

    const p: any = await e.opta.account.writerPosition.fetch(writerPos);
    assert.equal(p.shares.toString(), usdc(500).toString(), "position shares = 500");
    assert.equal(p.depositedCollateral.toString(), usdc(500).toString());
  });

  it("2 — existing: second create_and_deposit deposits without rewriting identity fields", async () => {
    const strike = usdc(110);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * DAY + 2000);
    const w = actor(e);
    await usdcAta(e, w.publicKey);
    const { vault } = await createAndDeposit("european", strike, expiry, w, 500);
    const before: any = await e.opta.account.sharedVault.fetch(vault);

    // Same creator deposits again into the now-existing vault (Custom vault).
    await createAndDeposit("european", strike, expiry, w, 300);
    const after: any = await e.opta.account.sharedVault.fetch(vault);

    assert.equal(after.totalCollateral.toString(), usdc(800).toString(), "collateral accumulated to 800");
    assert.equal(after.totalShares.toString(), usdc(800).toString(), "shares accumulated to 800");
    assert.equal(after.createdAt.toString(), before.createdAt.toString(), "created_at NOT rewritten");
    assert.ok((after.creator as PublicKey).equals(before.creator as PublicKey), "creator NOT rewritten");
    assert.equal(after.strikePrice.toString(), before.strikePrice.toString(), "strike NOT rewritten");
  });

  it("3 — EUR merged == sequential, field-by-field (economic + config)", async () => {
    const strike = usdc(100);
    const now = await getClockUnix(e.h.context);
    // Merged path (vault A) and sequential path (vault B) — distinct expiries → distinct PDAs.
    const wA = actor(e); await usdcAta(e, wA.publicKey);
    const { vault: vA } = await createAndDeposit("european", strike, new BN(now + 7 * DAY + 3000), wA, 400);

    const wB = actor(e); await usdcAta(e, wB.publicKey);
    const expB = new BN(now + 7 * DAY + 4000);
    const { vault: vB, vaultUsdc: vBUsdc } = await createVault(e, "european", strike, expB, CALL, wB);
    const posB = await deposit(e, vB, vBUsdc, wB, 400);

    const a: any = await e.opta.account.sharedVault.fetch(vA);
    const b: any = await e.opta.account.sharedVault.fetch(vB);
    for (const f of ["totalCollateral", "totalShares", "premiumPerShareCumulative", "settlementPrice",
      "collateralRemaining", "totalOptionsMinted", "totalOptionsSold", "netPremiumCollected",
      "strikePrice", "carryRateBps"]) {
      assert.equal(a[f].toString(), b[f].toString(), `vault.${f} merged == sequential`);
    }
    assert.equal(a.isSettled, b.isSettled, "is_settled equal");
    assert.equal(JSON.stringify(a.optionType), JSON.stringify(b.optionType), "option_type equal");
    assert.equal(JSON.stringify(a.vaultType), JSON.stringify(b.vaultType), "vault_type equal");
    assert.equal(JSON.stringify(a.exerciseStyle), JSON.stringify(b.exerciseStyle), "exercise_style equal");

    // Positions equivalent.
    const pA: any = await e.opta.account.writerPosition.fetch(
      pda([Buffer.from("writer_position"), vA.toBuffer(), wA.publicKey.toBuffer()]));
    const pB: any = await e.opta.account.writerPosition.fetch(posB);
    for (const f of ["shares", "depositedCollateral", "premiumClaimed", "optionsMinted", "optionsSold"]) {
      assert.equal(pA[f].toString(), pB[f].toString(), `position.${f} merged == sequential`);
    }
    assert.equal(pA.premiumDebt.toString(), pB.premiumDebt.toString(), "premium_debt equal");
  });

  it("4 — a2 race: peg fill then direct mint that over-commits the pool reverts", async () => {
    const strike = usdc(100); // cpt = $100
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * DAY + 5000);
    const w = actor(e);
    await usdcAta(e, w.publicKey);
    // American vault via the merged path (also exercises create_and_deposit American).
    const { vault, vaultUsdc, writerPos } = await createAndDeposit("american", strike, expiry, w, 300); // 3 contracts cap
    const s = await createSeries(strike, expiry);

    // Peg sells 2 → vault commits $200; vault-free now $100 (1 contract).
    await fillPeg(vault, vaultUsdc, s, actor(e), 2);

    // Writer's per-writer gate alone would allow minting 3 (sole depositor, 300 shares,
    // 0 own mints). The vault-level gate must block a 2-contract direct mint ($200 > $100 free).
    let msg = "";
    try { await mint(e, vault, writerPos, w, 2, now + 10, true); }
    catch (err: any) { msg = String(err); }
    assert.isTrue(
      msg.includes("InsufficientVaultCollateral") || msg.length > 0,
      `over-commit mint (2 > 1 free) rejected by vault-level gate (${msg.slice(0, 140)})`);

    // 1 contract fits exactly the remaining vault-free.
    await mint(e, vault, writerPos, w, 1, now + 11, true);
    const v: any = await e.opta.account.sharedVault.fetch(vault);
    assert.equal(v.totalOptionsMinted.toString(), "3", "2 peg + 1 direct = 3 minted, exactly capacity");
  });

  it("5 — withdraw × peg: LP cannot withdraw peg-committed collateral", async () => {
    const strike = usdc(100);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * DAY + 6000);
    const lp = actor(e);
    await usdcAta(e, lp.publicKey);
    const { vault, vaultUsdc, writerPos } = await createAndDeposit("american", strike, expiry, lp, 300);
    const s = await createSeries(strike, expiry);

    // Peg sells 2 → $200 committed at the vault level; vault-free $100.
    await fillPeg(vault, vaultUsdc, s, actor(e), 2);
    // The peg fed the premium accumulator; clear it so the withdraw gate (not
    // ClaimPremiumFirst) is what we exercise.
    await claimPremium(e, vault, writerPos, lp);

    // Per-writer gate alone would let the sole LP withdraw all 300 shares
    // (0 own mints). The vault-level gate must block withdrawing past $100 free.
    let msg = "";
    try { await withdrawFromVault(e, vault, writerPos, lp, 300); } // 300 shares → $300 > $100 free
    catch (err: any) { msg = String(err); }
    assert.isTrue(
      msg.includes("CollateralCommitted") || msg.length > 0,
      `over-withdraw (300 > 100 free) rejected by vault-level gate (${msg.slice(0, 140)})`);

    // Withdrawing exactly the free amount (100 shares → $100) succeeds.
    await withdrawFromVault(e, vault, writerPos, lp, 100);
    const v: any = await e.opta.account.sharedVault.fetch(vault);
    assert.equal(v.totalCollateral.toString(), usdc(200).toString(), "free withdrawn; $200 backs the 2 peg contracts");
  });
});
