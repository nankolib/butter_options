// =============================================================================
// scripts/smoke-pass-2-mint.ts -- Phase 2 Stage C Pass 2 post-deploy smoke
// =============================================================================
//
// Runs against devnet after the Pass 2 program is deployed. Verifies:
//   AMER smoke: fresh AMER vault + mint -> reverts with VolOracleWarmup
//                (expected; no devnet oracle is past 168-sample warmup as of
//                 2026-05-22; first 4 unlock 2026-05-24)
//   EUR smoke:  fresh EUR vault + mint -> succeeds, premium = arg verbatim
//                (proves uniform vol_oracle context doesn't regress EUR)
//
// Usage:
//   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
//   ANCHOR_WALLET=~/.config/solana/id.json \
//   npx ts-node scripts/smoke-pass-2-mint.ts
//
// Requires: deployer has >= ~810 devnet USDC ($400 + $401 collateral + slack)
//           and the SOL market's VolOracle is initialized on devnet.
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import BN from "bn.js";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const HOOK_PROGRAM_ID = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");
const DEVNET_USDC = new PublicKey("AytU5HUQRew9VdUdrzQuZvZ7s14pHLiYjAF5WqdK3oxL");
// SOL Pyth feed_id (mainnet hex from scripts/pyth-feed-ids.csv).
const SOL_FEED_ID_HEX = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";

const SOL_FEED = Buffer.from(SOL_FEED_ID_HEX, "hex");
const SOL_FEED_ARR = Array.from(SOL_FEED);

function usdc(n: number): BN { return new BN(Math.floor(n * 1_000_000)); }
function pda(seeds: (Buffer | Uint8Array)[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
}

// Public devnet RPC ("api.devnet.solana.com") frequently returns
// "Blockhash not found" due to read-replica desync. Retry 3x with a small
// backoff and a re-fetched blockhash each iteration.
async function withRetry<T>(label: string, fn: () => Promise<T>, tries = 3): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < tries; i++) {
    try { return await fn(); } catch (err: any) {
      lastErr = err;
      const s = String(err);
      if (s.includes("Blockhash not found") || s.includes("block height exceeded")) {
        console.warn(`  [retry ${i + 1}/${tries}] ${label}: transient blockhash err, retrying...`);
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.opta as anchor.Program<any>;
  const signer = provider.wallet.publicKey;

  console.log("=== Pass 2 post-deploy smoke ===");
  console.log("RPC:    ", provider.connection.rpcEndpoint);
  console.log("Signer: ", signer.toBase58());

  const protocolStatePda = pda([Buffer.from("protocol_v2")]);
  const marketPda = pda([Buffer.from("market"), Buffer.from("SOL")]);
  const volOraclePda = pda([Buffer.from("vol_oracle"), SOL_FEED]);
  const writerUsdc = await getAssociatedTokenAddress(DEVNET_USDC, signer);

  console.log("Market:    ", marketPda.toBase58());
  console.log("VolOracle: ", volOraclePda.toBase58());

  const oracleInfo = await provider.connection.getAccountInfo(volOraclePda);
  if (!oracleInfo) {
    console.error("✗ SOL VolOracle missing on devnet; aborting smoke.");
    process.exit(1);
  }

  async function attemptMint(label: "AMER" | "EUR", strike: number) {
    console.log(`\n--- ${label} smoke: strike $${strike} ---`);
    const strikeBN = usdc(strike);
    const expiryBN = new BN(Math.floor(Date.now() / 1000) + 7200); // +2h
    const styleArg = label === "AMER" ? { american: {} } : { european: {} };
    const seedName = label === "AMER" ? "shared_vault_american" : "shared_vault";

    const vaultPda = pda([
      Buffer.from(seedName),
      marketPda.toBuffer(),
      strikeBN.toArrayLike(Buffer, "le", 8),
      expiryBN.toArrayLike(Buffer, "le", 8),
      Buffer.from([0]), // Call
    ]);
    const vaultUsdcPda = pda([Buffer.from("vault_usdc"), vaultPda.toBuffer()]);
    const writerPosPda = pda([Buffer.from("writer_position"), vaultPda.toBuffer(), signer.toBuffer()]);

    // Create vault (idempotent: if PDA already exists from a prior failed run, skip)
    let createSig = "(reused existing vault)";
    const vaultExisting = await provider.connection.getAccountInfo(vaultPda);
    if (!vaultExisting) {
      createSig = await withRetry("createSharedVault", () => (program.methods as any)
        .createSharedVault(strikeBN, expiryBN, { call: {} }, { custom: {} }, DEVNET_USDC, 0, styleArg)
        .accountsStrict({
          creator: signer,
          market: marketPda,
          sharedVault: vaultPda,
          vaultUsdcAccount: vaultUsdcPda,
          usdcMint: DEVNET_USDC,
          protocolState: protocolStatePda,
          epochConfig: null,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })])
        .rpc({ commitment: "confirmed" }));
    }
    console.log(`  vault created: ${vaultPda.toBase58()}  tx=${createSig}`);

    // Deposit (check if already deposited; depositToVault is additive so we
    // can deposit even if a position exists — but for smoke clarity we only
    // deposit once)
    let depositSig = "(reused existing deposit)";
    const posExisting = await provider.connection.getAccountInfo(writerPosPda);
    if (!posExisting) {
      depositSig = await withRetry("depositToVault", () => (program.methods as any)
        .depositToVault(strikeBN)
        .accountsStrict({
          writer: signer,
          sharedVault: vaultPda,
          writerPosition: writerPosPda,
          writerUsdcAccount: writerUsdc,
          vaultUsdcAccount: vaultUsdcPda,
          protocolState: protocolStatePda,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc({ commitment: "confirmed" }));
    }
    console.log(`  deposited $${strike}  tx=${depositSig}`);

    // Mint
    const createdAt = new BN(Math.floor(Date.now() / 1000));
    const optMint = pda([
      Buffer.from("vault_option_mint"),
      vaultPda.toBuffer(),
      signer.toBuffer(),
      createdAt.toArrayLike(Buffer, "le", 8),
    ]);
    const escrow = pda([
      Buffer.from("vault_purchase_escrow"),
      vaultPda.toBuffer(),
      signer.toBuffer(),
      createdAt.toArrayLike(Buffer, "le", 8),
    ]);
    const vaultMintRec = pda([Buffer.from("vault_mint_record"), optMint.toBuffer()]);
    const extraMeta = PublicKey.findProgramAddressSync(
      [Buffer.from("extra-account-metas"), optMint.toBuffer()],
      HOOK_PROGRAM_ID,
    )[0];
    const hookState = PublicKey.findProgramAddressSync(
      [Buffer.from("hook-state"), optMint.toBuffer()],
      HOOK_PROGRAM_ID,
    )[0];
    const premiumArg = label === "AMER" ? usdc(1) : usdc(42); // AMER ignored; EUR verbatim

    try {
      const mintSig = await withRetry("mintFromVault", () => (program.methods as any)
        .mintFromVault(new BN(1), premiumArg, createdAt)
        .accountsStrict({
          writer: signer,
          sharedVault: vaultPda,
          writerPosition: writerPosPda,
          market: marketPda,
          volOracle: volOraclePda,
          protocolState: protocolStatePda,
          optionMint: optMint,
          purchaseEscrow: escrow,
          vaultMintRecord: vaultMintRec,
          transferHookProgram: HOOK_PROGRAM_ID,
          extraAccountMetaList: extraMeta,
          hookState,
          systemProgram: SystemProgram.programId,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          rent: SYSVAR_RENT_PUBKEY,
        })
        .preInstructions([ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 })])
        .rpc({ commitment: "confirmed" }));

      if (label === "AMER") {
        console.error(`  ✗ AMER mint UNEXPECTEDLY succeeded (should have been VolOracleWarmup); tx=${mintSig}`);
        return { label, status: "UNEXPECTED_SUCCESS", tx: mintSig };
      } else {
        const rec = await (program.account as any).vaultMint.fetch(vaultMintRec);
        console.log(`  ✓ EUR mint OK  tx=${mintSig}  premium_per_contract=${rec.premiumPerContract.toString()}`);
        const ok = rec.premiumPerContract.toString() === premiumArg.toString();
        return { label, status: ok ? "OK_VERBATIM" : "OK_BUT_NOT_VERBATIM", tx: mintSig, premium: rec.premiumPerContract.toString() };
      }
    } catch (err: any) {
      const errStr = String(err);
      const sigMatch = errStr.match(/Signature ([1-9A-HJ-NP-Za-km-z]{43,88})/);
      const sig = sigMatch ? sigMatch[1] : (err?.signature || err?.txid || "(no-sig)");
      const isWarmup = errStr.includes("VolOracleWarmup");
      if (label === "AMER" && isWarmup) {
        console.log(`  ✓ AMER revert as expected: VolOracleWarmup  tx=${sig}`);
        return { label, status: "WARMUP_OK", tx: sig };
      }
      console.error(`  ✗ ${label} unexpected error: ${errStr.slice(0, 300)}`);
      return { label, status: "FAIL", tx: sig, error: errStr.slice(0, 300) };
    }
  }

  // Allow CLI override so we can re-run with fresh strikes when an earlier
  // attempt left a partial vault behind.
  const onlyArg = process.argv[2] || "BOTH";
  const amerStrike = parseInt(process.env.AMER_STRIKE || "400", 10);
  const eurStrike = parseInt(process.env.EUR_STRIKE || "401", 10);
  const amer = onlyArg === "EUR" ? { label: "AMER", status: "SKIPPED", tx: "" } : await attemptMint("AMER", amerStrike);
  const eur  = onlyArg === "AMER" ? { label: "EUR",  status: "SKIPPED", tx: "" } : await attemptMint("EUR", eurStrike);

  console.log("\n=== smoke summary ===");
  console.log(JSON.stringify({ amer, eur }, null, 2));

  const amerOk = amer.status === "WARMUP_OK" || amer.status === "SKIPPED";
  const eurOk = eur.status === "OK_VERBATIM" || eur.status === "SKIPPED";
  if (!amerOk || !eurOk) {
    console.error("✗ smoke failed");
    process.exit(1);
  }
  console.log("\n✓ smokes passed (SKIPPED counts as pass when explicitly skipped via CLI)");
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  if (err.logs) console.error("Logs:", err.logs.slice(-8).join("\n  "));
  process.exit(1);
});
