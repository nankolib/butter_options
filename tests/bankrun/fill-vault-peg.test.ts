// =============================================================================
// tests/bankrun/fill-vault-peg.test.ts — Phase 2 Pass B: fill_vault_peg
// =============================================================================
// Proves the converged-architecture vault peg: a taker fills against an American
// series' shared vault at a price computed at fill time (BS-2002 + spread_bps),
// contracts mint-on-fill from pooled vault collateral.
//
//   1. HAPPY PATH — premium > 0, USDC conservation (total = vault_share + fee),
//      fee = floor(total × fee_bps/10000), buyer receives `qty` contracts,
//      commitment counters (vault + series record) advance by qty, premium
//      accumulator grows.
//   2. SPREAD — at a frozen clock, premium scales exactly:
//      premium(spread=500) == floor(premium(spread=0) × 10500/10000).
//   3. NEGATIVES — voided (6056), settled, expired, qty=0, slippage, and the
//      free-collateral commitment cap.
//
// The test build carries `american-enabled` so American vaults/series exist and
// the peg prices live. Dark-launch (feature-free) is structural: create_shared_vault
// itself blocks American without the flag, so no peg target can be built —
// proven by the feature-free build gate, not a runtime assert here.
//
// Distinct (strike, expiry) per test ⇒ distinct vault PDAs (no collisions).
// 7-day expiries + ~79% planted vol keep ATM/near-ATM premiums comfortably > 0.
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
  setupEnv, createVault, deposit, usdcAta, bal, actor, pda, getClockUnix, setClockUnix,
  settle, HOOK_PROGRAM_ID, Env,
} from "./helpers";

const CU = (u: number) => ComputeBudgetProgram.setComputeUnitLimit({ units: u });
const usdc = (n: number) => new BN(Math.round(n * 1_000_000));
const DAY = 86_400;
const CALL = { call: {} };
const AMERICAN = { american: {} };
const OT_CALL = 0;
const ES_AMERICAN = 1;

// On-disk SharedVault layout (8 disc + 252): spread_bps u16 @ data[257..259],
// voided bool @ data[259]. See state/shared_vault.rs INIT_SPACE = 252.
const SPREAD_OFF = 257;
const VOIDED_OFF = 259;

function deriveSeries(market: PublicKey, strike: BN, expiry: BN) {
  const mint = pda([Buffer.from("vault_option_mint"), market.toBuffer(),
    strike.toArrayLike(Buffer, "le", 8), expiry.toArrayLike(Buffer, "le", 8),
    Buffer.from([OT_CALL]), Buffer.from([ES_AMERICAN])]);
  const record = pda([Buffer.from("vault_mint_record"), mint.toBuffer()]);
  const extraMetas = pda([Buffer.from("extra-account-metas"), mint.toBuffer()], HOOK_PROGRAM_ID);
  const hookState = pda([Buffer.from("hook-state"), mint.toBuffer()], HOOK_PROGRAM_ID);
  return { mint, record, extraMetas, hookState };
}

describe("fill_vault_peg (Phase 2 Pass B)", function () {
  this.timeout(120_000);

  let e: Env;
  let feeBps: number;

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

  // Mutate spread_bps / voided directly (no setter instruction ships in Pass B).
  async function setVaultBytes(vault: PublicKey, opts: { spreadBps?: number; voided?: boolean }) {
    const acc = await e.h.context.banksClient.getAccount(vault);
    const data = Buffer.from(acc!.data);
    if (opts.spreadBps !== undefined) data.writeUInt16LE(opts.spreadBps, SPREAD_OFF);
    if (opts.voided !== undefined) data.writeUInt8(opts.voided ? 1 : 0, VOIDED_OFF);
    e.h.context.setAccount(vault, {
      lamports: acc!.lamports, data, owner: acc!.owner, executable: acc!.executable, rentEpoch: Number(acc!.rentEpoch),
    });
  }

  // Set up a funded American vault + its series. Returns handles.
  async function setupVaultSeries(strike: BN, expiry: BN, depositUsd: number) {
    const writer = actor(e);
    await usdcAta(e, writer.publicKey);
    const { vault, vaultUsdc } = await createVault(e, "american", strike, expiry, CALL, writer);
    await deposit(e, vault, vaultUsdc, writer, depositUsd);
    const s = await createSeries(strike, expiry);
    return { vault, vaultUsdc, s };
  }

  // Execute one peg fill; returns the taker's option ATA + USDC ATA.
  async function fillPeg(
    vault: PublicKey, vaultUsdc: PublicKey, s: any, taker: Keypair, qty: number, maxPremium: BN,
  ) {
    const takerOpt = getAssociatedTokenAddressSync(s.mint, taker.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const takerUsdc = await usdcAta(e, taker.publicKey);
    const ataIx = createAssociatedTokenAccountIdempotentInstruction(
      e.admin.publicKey, takerOpt, taker.publicKey, s.mint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
    await e.opta.methods.fillVaultPeg(new BN(qty), maxPremium).accountsStrict({
      taker: taker.publicKey, sharedVault: vault, vaultMintRecord: s.record, market: e.market,
      volOracle: e.volOracle, protocolState: e.protocolState, optionMint: s.mint,
      takerOptionAccount: takerOpt, takerUsdcAccount: takerUsdc, vaultUsdcAccount: vaultUsdc,
      treasury: e.treasury, tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
    }).preInstructions([CU(400_000), ataIx]).signers([taker]).rpc();
    return { takerOpt, takerUsdc };
  }

  before(async () => {
    e = await setupEnv("PEGTEST", "peg-feed", 100); // spot $100, ~79% vol planted
    feeBps = (await e.opta.account.protocolState.fetch(e.protocolState)).feeBps as number;
  });

  it("1 — happy path: mints qty, USDC conservation + fee floor, counters advance", async () => {
    const strike = usdc(100); // ATM
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * DAY + 1000);
    const { vault, vaultUsdc, s } = await setupVaultSeries(strike, expiry, 5000); // 50 contracts cap

    const taker = actor(e);
    const qty = 4;
    const takerUsdcAta = await usdcAta(e, taker.publicKey);
    const takerBefore = await bal(e, takerUsdcAta);
    const vaultBefore = await bal(e, vaultUsdc);
    const treasBefore = await bal(e, e.treasury);

    const { takerOpt } = await fillPeg(vault, vaultUsdc, s, taker, qty, usdc(1_000_000));

    const paid = takerBefore - (await bal(e, takerUsdcAta));
    const vaultGot = (await bal(e, vaultUsdc)) - vaultBefore;
    const treasGot = (await bal(e, e.treasury)) - treasBefore;

    assert.isTrue(paid > 0n, "taker paid a positive premium");
    assert.equal(vaultGot + treasGot, paid, "conservation: vault_share + fee == total paid");
    const expectedFee = (paid * BigInt(feeBps)) / 10_000n;
    assert.equal(treasGot, expectedFee, "fee == floor(total × fee_bps / 10000)");
    assert.equal(vaultGot, paid - expectedFee, "vault_share == total − fee");
    assert.equal(paid % BigInt(qty), 0n, "total divides evenly by qty (premium is per-contract)");

    assert.equal(await bal(e, takerOpt), BigInt(qty), "taker holds qty fresh contracts");

    const v: any = await e.opta.account.sharedVault.fetch(vault);
    assert.equal(v.totalOptionsMinted.toString(), String(qty), "vault.total_options_minted += qty");
    assert.equal(v.totalOptionsSold.toString(), String(qty), "vault.total_options_sold += qty");
    assert.isTrue((v.netPremiumCollected as BN).gt(new BN(0)), "net_premium_collected grew");
    assert.isTrue((v.premiumPerShareCumulative as BN).gt(new BN(0)), "premium accumulator grew");

    const rec: any = await e.opta.account.vaultMint.fetch(s.record);
    assert.equal(rec.quantityMinted.toString(), String(qty), "record.quantity_minted += qty");
    assert.equal(rec.quantitySold.toString(), String(qty), "record.quantity_sold += qty");
  });

  it("2 — spread: premium(500bps) == floor(premium(0) × 10500/10000) at a frozen clock", async () => {
    const strike = usdc(105);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * DAY + 2000);
    const { vault, vaultUsdc, s } = await setupVaultSeries(strike, expiry, 10_000);

    // Freeze the clock so both fills price at byte-identical TTE/spot/vol.
    await setClockUnix(e.h.context, now + 1);

    await setVaultBytes(vault, { spreadBps: 0 });
    const takerA = actor(e);
    const aUsdc = await usdcAta(e, takerA.publicKey);
    const aBefore = await bal(e, aUsdc);
    await fillPeg(vault, vaultUsdc, s, takerA, 1, usdc(1_000_000));
    const premium0 = aBefore - (await bal(e, aUsdc));

    // Distinct signer ⇒ distinct signature (no bankrun "already processed"
    // dedup); same frozen-clock model inputs ⇒ same base premium.
    await setVaultBytes(vault, { spreadBps: 500 });
    const takerB = actor(e);
    const bUsdc = await usdcAta(e, takerB.publicKey);
    const bBefore = await bal(e, bUsdc);
    await fillPeg(vault, vaultUsdc, s, takerB, 1, usdc(1_000_000));
    const premium500 = bBefore - (await bal(e, bUsdc));

    assert.isTrue(premium0 > 0n, "base premium positive");
    const expected = (premium0 * 10_500n) / 10_000n; // floored
    assert.equal(premium500, expected, `spread: ${premium500} == floor(${premium0} × 1.05) = ${expected}`);
  });

  it("3 — negative: voided vault blocks the fill (VaultVoided 6056)", async () => {
    const strike = usdc(110);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * DAY + 3000);
    const { vault, vaultUsdc, s } = await setupVaultSeries(strike, expiry, 1000);
    await setVaultBytes(vault, { voided: true });

    let msg = "";
    try { await fillPeg(vault, vaultUsdc, s, actor(e), 1, usdc(1_000_000)); }
    catch (err: any) { msg = String(err); }
    assert.isTrue(msg.includes("VaultVoided") || msg.includes("6056"), `voided fill rejected (${msg.slice(0, 140)})`);
  });

  it("4 — negative: qty=0 rejected; slippage (max_premium too low) rejected", async () => {
    const strike = usdc(100);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * DAY + 4000);
    const { vault, vaultUsdc, s } = await setupVaultSeries(strike, expiry, 1000);

    let zeroMsg = "";
    try { await fillPeg(vault, vaultUsdc, s, actor(e), 0, usdc(1_000_000)); }
    catch (err: any) { zeroMsg = String(err); }
    assert.isTrue(zeroMsg.length > 0, "qty=0 rejected");

    let slipMsg = "";
    try { await fillPeg(vault, vaultUsdc, s, actor(e), 1, new BN(1)); } // max_premium = 1 micro-USDC
    catch (err: any) { slipMsg = String(err); }
    assert.isTrue(slipMsg.includes("SlippageExceeded") || slipMsg.includes("6")
      , `slippage rejected (${slipMsg.slice(0, 140)})`);
  });

  it("5 — negative: free-collateral cap — qty beyond vault capacity reverts; boundary fits", async () => {
    const strike = usdc(100); // cpt = $100
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * DAY + 5000);
    const { vault, vaultUsdc, s } = await setupVaultSeries(strike, expiry, 300); // exactly 3 contracts cap

    let msg = "";
    try { await fillPeg(vault, vaultUsdc, s, actor(e), 4, usdc(1_000_000)); }
    catch (err: any) { msg = String(err); }
    assert.isTrue(
      msg.includes("InsufficientVaultCollateral") || msg.length > 0,
      `over-capacity (qty 4 > 3) rejected (${msg.slice(0, 140)})`,
    );
    await fillPeg(vault, vaultUsdc, s, actor(e), 3, usdc(1_000_000)); // exactly capacity
    const v: any = await e.opta.account.sharedVault.fetch(vault);
    assert.equal(v.totalOptionsMinted.toString(), "3", "exactly-capacity fill succeeded");
  });

  it("6 — negative: post-settlement / expired vault blocks the fill", async () => {
    const strike = usdc(100);
    const now = await getClockUnix(e.h.context);
    const expiry = new BN(now + 7 * DAY + 6000);
    const { vault, vaultUsdc, s } = await setupVaultSeries(strike, expiry, 1000);

    // Advance past expiry + settle → fill must revert (expired/settled gate).
    await settle(e, vault, expiry, 100);
    let msg = "";
    try { await fillPeg(vault, vaultUsdc, s, actor(e), 1, usdc(1_000_000)); }
    catch (err: any) { msg = String(err); }
    assert.isTrue(msg.length > 0, `post-settlement fill rejected (${msg.slice(0, 140)})`);
  });
});
