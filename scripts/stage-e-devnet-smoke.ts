// =============================================================================
// scripts/stage-e-devnet-smoke.ts — Stage E post-deploy devnet smoke
// =============================================================================
// (1) SAFETY CANARY: simulate an American create_shared_vault → MUST revert
//     AmericanVaultsDisabled (6052 / 0x17a4). Proves the deployed build is
//     feature-free (AMERICAN_ENABLED = false), not the test build.
// (2) EUR SMOKE: create a fresh EUR Custom vault → deposit → mint 1 contract
//     (created AFTER this deploy), then getTokenMetadata on the new mint and
//     confirm additionalMetadata carries ["exercise_style","european"] plus
//     the 8 prior pairs.
//
// Reads the Helius RPC from ~/.opta-rpc-helius (never printed). Operator =
// ~/.config/solana/id.json (also USDC mint authority on devnet).
// Run: npx ts-node --transpile-only scripts/stage-e-devnet-smoke.ts
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
  mintTo, getTokenMetadata,
} from "@solana/spl-token";
import BN from "bn.js";
import fs from "fs";
import path from "path";
import os from "os";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const HOOK_PROGRAM_ID = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");
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

  console.log("=== Stage E devnet smoke ===");
  console.log("operator:", operator.publicKey.toBase58());

  const [protocolStatePda] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], PROGRAM_ID);
  const protocolState: any = await program.account.protocolState.fetch(protocolStatePda);
  const usdcMint: PublicKey = protocolState.usdcMint;
  console.log("usdc_mint:", usdcMint.toBase58());

  // Pick a market whose VolOracle PDA already exists (EUR mint needs the
  // account present even though it never reads it). Derive known asset market
  // PDAs directly + fetch individually — `.all()` blows up on stale-schema
  // orphan accounts with colliding discriminators (known trap).
  const deriveVolOracle = (feed: Buffer) =>
    PublicKey.findProgramAddressSync([Buffer.from("vol_oracle"), feed], PROGRAM_ID)[0];
  let chosen: { market: PublicKey; feed: Buffer; volOracle: PublicKey; asset: string } | null = null;
  const CANDIDATES = ["SOL", "BTC", "ETH", "XRP", "AAPL", "TSLA", "NVDA", "XAU", "XAG", "WTI", "MSTR"];
  for (const asset of CANDIDATES) {
    const [mPda] = PublicKey.findProgramAddressSync([Buffer.from("market"), Buffer.from(asset)], PROGRAM_ID);
    if (!(await conn.getAccountInfo(mPda))) continue;
    let acc: any;
    try { acc = await program.account.optionsMarket.fetch(mPda); } catch { continue; }
    const feed = Buffer.from(acc.pythFeedId as number[]);
    const vo = deriveVolOracle(feed);
    if (await conn.getAccountInfo(vo)) {
      chosen = { market: mPda, feed, volOracle: vo, asset };
      break;
    }
  }
  if (!chosen) throw new Error("No candidate market with an initialized VolOracle found — cannot mint.");
  console.log(`chosen market: ${chosen.asset} ${chosen.market.toBase58()} (volOracle ${chosen.volOracle.toBase58()})`);

  const now = Math.floor(Date.now() / 1000);

  // ---------------------------------------------------------------------------
  // (1) SAFETY CANARY — American create_shared_vault must revert 6052
  // ---------------------------------------------------------------------------
  console.log("\n--- (1) 6052 safety canary (American create_shared_vault, simulate) ---");
  {
    const strike = usdc(777);
    const expiry = new BN(now + 86_400);
    const [amerVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("shared_vault_american"), chosen.market.toBuffer(),
       strike.toArrayLike(Buffer, "le", 8), expiry.toArrayLike(Buffer, "le", 8), Buffer.from([0])],
      PROGRAM_ID);
    const [amerVaultUsdc] = PublicKey.findProgramAddressSync(
      [Buffer.from("vault_usdc"), amerVault.toBuffer()], PROGRAM_ID);
    let reverted6052 = false, raw = "";
    try {
      await program.methods
        .createSharedVault(strike, expiry, { call: {} }, { custom: {} }, usdcMint, 0, { american: {} })
        .accountsStrict({
          creator: operator.publicKey, market: chosen.market, sharedVault: amerVault,
          vaultUsdcAccount: amerVaultUsdc, usdcMint, protocolState: protocolStatePda,
          epochConfig: null, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
        })
        .simulate();
    } catch (e: any) {
      raw = JSON.stringify(e.simulationResponse?.logs ?? e.logs ?? String(e));
      reverted6052 = /AmericanVaultsDisabled|6052|0x17a4/i.test(raw + String(e));
    }
    console.log("  reverted with 6052/AmericanVaultsDisabled:", reverted6052);
    if (!reverted6052) {
      console.error("  CANARY FAILED — deployed build is NOT feature-free. Logs:", raw);
      process.exit(2);
    }
    console.log("  ✓ canary passed (feature-free build confirmed)");
  }

  // ---------------------------------------------------------------------------
  // (2) EUR SMOKE — fresh vault → deposit → mint → read metadata
  // ---------------------------------------------------------------------------
  console.log("\n--- (2) EUR on-chain smoke ---");
  // Fund operator USDC (operator is the devnet USDC mint authority).
  const opUsdc = getAssociatedTokenAddressSync(usdcMint, operator.publicKey, false, TOKEN_PROGRAM_ID);
  await provider.sendAndConfirm(new Transaction().add(
    createAssociatedTokenAccountIdempotentInstruction(
      operator.publicKey, opUsdc, operator.publicKey, usdcMint, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID),
  ));
  await mintTo(conn, operator, usdcMint, opUsdc, operator.publicKey, 200 * 1_000_000);

  const strike = usdc(50);
  const expiry = new BN(now + 86_400);
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("shared_vault"), chosen.market.toBuffer(),
     strike.toArrayLike(Buffer, "le", 8), expiry.toArrayLike(Buffer, "le", 8), Buffer.from([0])],
    PROGRAM_ID);
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
      .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
      .rpc();
    console.log("  ✓ EUR vault created:", vault.toBase58());
  } else {
    console.log("  EUR vault already exists, reusing:", vault.toBase58());
  }

  await program.methods
    .depositToVault(usdc(100))
    .accountsStrict({
      writer: operator.publicKey, sharedVault: vault, writerPosition: writerPos,
      writerUsdcAccount: opUsdc, vaultUsdcAccount: vaultUsdc, protocolState: protocolStatePda,
      tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
    })
    .rpc();
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

  const mintSig = await program.methods
    .mintFromVault(new BN(1), usdc(1), createdAt)
    .accountsStrict({
      writer: operator.publicKey, sharedVault: vault, writerPosition: writerPos,
      market: chosen.market, volOracle: chosen.volOracle, protocolState: protocolStatePda,
      optionMint, purchaseEscrow: escrow, vaultMintRecord, transferHookProgram: HOOK_PROGRAM_ID,
      extraAccountMetaList: extraMetas, hookState, systemProgram: SystemProgram.programId,
      token2022Program: TOKEN_2022_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY,
    })
    .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 })])
    .rpc();
  await conn.confirmTransaction(mintSig, "confirmed");
  console.log("  ✓ EUR contract minted");
  console.log("  MINT_TX:", mintSig);
  console.log("  OPTION_MINT:", optionMint.toBase58());

  const meta = await getTokenMetadata(conn, optionMint, "confirmed", TOKEN_2022_PROGRAM_ID);
  if (!meta) throw new Error("no metadata on minted EUR option");
  console.log("  DECODED_METADATA:", JSON.stringify({
    name: meta.name, symbol: meta.symbol, additionalMetadata: meta.additionalMetadata,
  }));
  const get = (k: string) => meta.additionalMetadata.find(([kk]) => kk === k)?.[1];
  const expectedKeys = ["asset_name","asset_class","strike_price","expiry","option_type","collateral_per_token","market_pda","vault_pda","exercise_style"];
  const present = expectedKeys.filter((k) => get(k) !== undefined);
  console.log("  pairs present:", present.length, "/", expectedKeys.length, present);
  console.log("  exercise_style =", JSON.stringify(get("exercise_style")));
  if (get("exercise_style") !== "european") { console.error("  SMOKE FAILED: exercise_style != european"); process.exit(3); }
  if (present.length !== expectedKeys.length) { console.error("  SMOKE FAILED: missing prior pairs"); process.exit(4); }
  console.log("\n=== STAGE_E_SMOKE_OK ===");
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
