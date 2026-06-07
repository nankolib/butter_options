// =============================================================================
// scripts/stage-f-devnet-smoke.ts — Stage F post-deploy devnet smoke
// =============================================================================
// (1) SAFETY CANARY: simulate American create_shared_vault → MUST revert
//     AmericanVaultsDisabled (6052). Proves the deployed build is feature-free.
// (2) EUR REGRESSION: create→deposit→mint a fresh EUR option on the new program.
//     Asserts the new vault is born at the 257-byte schema and the EUR premium
//     is stored verbatim (zero regression from the Stage F schema change).
//
// Reads Helius RPC from ~/.opta-rpc-helius (never printed). Operator =
// ~/.config/solana/id.json (also USDC mint authority on devnet).
// Run: npx ts-node --transpile-only scripts/stage-f-devnet-smoke.ts
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Connection, PublicKey, Keypair, SystemProgram,
  ComputeBudgetProgram, SYSVAR_RENT_PUBKEY, Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
  mintTo,
} from "@solana/spl-token";
import BN from "bn.js";
import fs from "fs";
import path from "path";
import os from "os";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const HOOK_PROGRAM_ID = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");
const EXPECTED_VAULT_SIZE = 257; // 8 disc + 249 INIT_SPACE (Stage F)
const usdc = (n: number) => new BN(Math.round(n * 1_000_000));

async function main() {
  const rpc = fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim();
  const conn = new Connection(rpc, { commitment: "confirmed", confirmTransactionInitialTimeout: 90_000 });
  const operator = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))),
  );
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(operator), { commitment: "confirmed" });
  anchor.setProvider(provider);
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "opta.json"), "utf-8"));
  const program = new Program(idl, provider) as Program<any>;

  console.log("=== Stage F devnet smoke ===");
  console.log("operator:", operator.publicKey.toBase58());

  const [protocolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], PROGRAM_ID);
  const protocolState: any = await program.account.protocolState.fetch(protocolStatePda);
  const usdcMint: PublicKey = protocolState.usdcMint;
  console.log("usdc_mint:", usdcMint.toBase58());
  console.log("protocol_state.admin:", protocolState.admin.toBase58(),
    operator.publicKey.equals(protocolState.admin) ? "(== operator ✓)" : "(!= operator ✗)");

  // Pick a market whose VolOracle exists (EUR mint carries the oracle account).
  const deriveVolOracle = (feed: Buffer) =>
    PublicKey.findProgramAddressSync([Buffer.from("vol_oracle"), feed], PROGRAM_ID)[0];
  let chosen: { market: PublicKey; volOracle: PublicKey; asset: string } | null = null;
  for (const asset of ["SOL", "BTC", "ETH", "XRP", "AAPL", "TSLA", "NVDA", "XAU", "XAG", "WTI", "MSTR"]) {
    const [mPda] = PublicKey.findProgramAddressSync([Buffer.from("market"), Buffer.from(asset)], PROGRAM_ID);
    if (!(await conn.getAccountInfo(mPda))) continue;
    let acc: any;
    try { acc = await program.account.optionsMarket.fetch(mPda); } catch { continue; }
    const vo = deriveVolOracle(Buffer.from(acc.pythFeedId as number[]));
    if (await conn.getAccountInfo(vo)) { chosen = { market: mPda, volOracle: vo, asset }; break; }
  }
  if (!chosen) throw new Error("No candidate market with an initialized VolOracle found.");
  console.log(`chosen market: ${chosen.asset} ${chosen.market.toBase58()}`);

  const now = Math.floor(Date.now() / 1000);

  // ---- (1) CANARY: American create_shared_vault must revert 6052 -----------
  console.log("\n--- (1) 6052 safety canary ---");
  {
    const strike = usdc(888);
    const expiry = new BN(now + 86_400);
    const [amerVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("shared_vault_american"), chosen.market.toBuffer(),
       strike.toArrayLike(Buffer, "le", 8), expiry.toArrayLike(Buffer, "le", 8), Buffer.from([0])], PROGRAM_ID);
    const [amerVaultUsdc] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_usdc"), amerVault.toBuffer()], PROGRAM_ID);
    let reverted = false, raw = "";
    try {
      await program.methods
        .createSharedVault(strike, expiry, { call: {} }, { custom: {} }, usdcMint, 0, { american: {} })
        .accountsStrict({
          creator: operator.publicKey, market: chosen.market, sharedVault: amerVault,
          vaultUsdcAccount: amerVaultUsdc, usdcMint, protocolState: protocolStatePda,
          epochConfig: null, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        }).simulate();
    } catch (e: any) {
      raw = JSON.stringify(e.simulationResponse?.logs ?? e.logs ?? String(e));
      reverted = /AmericanVaultsDisabled|6052|0x17a4/i.test(raw + String(e));
    }
    console.log("  reverted 6052/AmericanVaultsDisabled:", reverted);
    if (!reverted) { console.error("  CANARY FAILED — not feature-free. Logs:", raw); process.exit(2); }
    console.log("  ✓ canary passed");
  }

  // ---- (2) EUR regression: create → deposit → mint -------------------------
  console.log("\n--- (2) EUR regression smoke ---");
  const opUsdc = getAssociatedTokenAddressSync(usdcMint, operator.publicKey, false, TOKEN_PROGRAM_ID);
  await provider.sendAndConfirm(new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      operator.publicKey, opUsdc, operator.publicKey, usdcMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID)));
  await mintTo(conn, operator, usdcMint, opUsdc, operator.publicKey, 200 * 1_000_000);

  const strike = usdc(55);
  const expiry = new BN(now + 86_400);
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("shared_vault"), chosen.market.toBuffer(),
     strike.toArrayLike(Buffer, "le", 8), expiry.toArrayLike(Buffer, "le", 8), Buffer.from([0])], PROGRAM_ID);
  const [vaultUsdc] = PublicKey.findProgramAddressSync([Buffer.from("vault_usdc"), vault.toBuffer()], PROGRAM_ID);
  const [writerPos] = PublicKey.findProgramAddressSync(
    [Buffer.from("writer_position"), vault.toBuffer(), operator.publicKey.toBuffer()], PROGRAM_ID);

  if (!(await conn.getAccountInfo(vault))) {
    await program.methods
      .createSharedVault(strike, expiry, { call: {} }, { custom: {} }, usdcMint, 0, { european: {} })
      .accountsStrict({
        creator: operator.publicKey, market: chosen.market, sharedVault: vault,
        vaultUsdcAccount: vaultUsdc, usdcMint, protocolState: protocolStatePda,
        epochConfig: null, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      })
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })]).rpc();
    console.log("  ✓ EUR vault created:", vault.toBase58());
  } else {
    console.log("  EUR vault exists, reusing:", vault.toBase58());
  }

  // Assert the new vault is born at the Stage F 257-byte schema.
  const vaultAcct = await conn.getAccountInfo(vault);
  console.log(`  NEW_VAULT_SIZE: ${vaultAcct!.data.length} bytes (expected ${EXPECTED_VAULT_SIZE})`);
  if (vaultAcct!.data.length !== EXPECTED_VAULT_SIZE) { console.error("  SIZE MISMATCH"); process.exit(3); }

  await program.methods
    .depositToVault(usdc(100))
    .accountsStrict({
      writer: operator.publicKey, sharedVault: vault, writerPosition: writerPos,
      writerUsdcAccount: opUsdc, vaultUsdcAccount: vaultUsdc, protocolState: protocolStatePda,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    }).rpc();
  console.log("  ✓ deposited $100");

  const createdAt = new BN(Math.floor(Date.now() / 1000));
  const [optionMint] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_option_mint"), vault.toBuffer(), operator.publicKey.toBuffer(), createdAt.toArrayLike(Buffer, "le", 8)], PROGRAM_ID);
  const [escrow] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_purchase_escrow"), vault.toBuffer(), operator.publicKey.toBuffer(), createdAt.toArrayLike(Buffer, "le", 8)], PROGRAM_ID);
  const [vaultMintRecord] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_mint_record"), optionMint.toBuffer()], PROGRAM_ID);
  const [extraMetas] = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), optionMint.toBuffer()], HOOK_PROGRAM_ID);
  const [hookState] = PublicKey.findProgramAddressSync(
    [Buffer.from("hook-state"), optionMint.toBuffer()], HOOK_PROGRAM_ID);

  const PREMIUM = usdc(7); // sentinel; EUR stores verbatim
  const mintSig = await program.methods
    .mintFromVault(new BN(1), PREMIUM, createdAt)
    .accountsStrict({
      writer: operator.publicKey, sharedVault: vault, writerPosition: writerPos,
      market: chosen.market, volOracle: chosen.volOracle, protocolState: protocolStatePda,
      optionMint, purchaseEscrow: escrow, vaultMintRecord, transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList: extraMetas, hookState, systemProgram: SystemProgram.programId,
      token2022Program: TOKEN_2022_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 })]).rpc();
  await conn.confirmTransaction(mintSig, "confirmed");
  console.log("  ✓ EUR mint succeeded");
  console.log("  MINT_TX:", mintSig);

  const rec: any = await program.account.vaultMint.fetch(vaultMintRecord);
  console.log("  premium_per_contract:", rec.premiumPerContract.toString(), "(expected", PREMIUM.toString() + ")");
  if (rec.premiumPerContract.toString() !== PREMIUM.toString()) { console.error("  PREMIUM NOT VERBATIM"); process.exit(4); }
  console.log("\n=== STAGE_F_SMOKE_OK ===");
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
