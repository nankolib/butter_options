// Fallback verification series — MAKER side, run from CLI with the admin key.
// SOL American CALL, strike $70, expiry 2026-08-28T08:00Z, 3-contract WriterAsk.
// Recon by default; SEND=1 actually creates + posts.
//
// Maker is admin 5YRMuuoY because fill_writer_ask.rs:239 forbids self-fill
// (CannotBuyOwnOption) — the taker must be a different key, and the taker is the
// burner that will exercise. $210 of admin USDC rests in the per-order escrow
// until filled; cancel_order refunds it.
import * as anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY,
  Transaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import fs from "fs";
import os from "os";
import path from "path";

const RPC = process.env.OPTA_RPC_URL || "https://api.devnet.solana.com";
const SEND = process.env.SEND === "1";
const HOOK = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");

const STRIKE = Number(process.env.STRIKE_MICRO ?? 70_000_000); // 6dp
const EXPIRY = Math.floor(Date.parse("2026-08-28T08:00:00Z") / 1000);
const QTY = Number(process.env.QTY ?? 3);
const PRICE = Number(process.env.PRICE_MICRO ?? 7_000_000);  // premium per contract, 6dp
const ASSET = "SOL";

const le8 = (v: number | bigint) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };
const usd = (n: any) => `$${(Number(n) / 1e6).toFixed(2)}`;

(async () => {
  const conn = new Connection(RPC, "confirmed");
  const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))));
  const wallet = new anchor.Wallet(kp);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../app/src/idl/opta.json"), "utf-8"));
  const program = new anchor.Program(idl as any, provider) as any;
  const PID: PublicKey = program.programId;
  const pda = (seeds: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(seeds, PID)[0];

  const market = pda([Buffer.from("market"), Buffer.from(ASSET)]);
  const protocolState = pda([Buffer.from("protocol_v2")]);
  const epochConfig = pda([Buffer.from("epoch_config")]);
  const ps: any = await program.account.protocolState.fetch(protocolState);
  const usdcMint: PublicKey = ps.usdcMint;

  // Canonical series mint: [vault_option_mint, market, strike, expiry, ot=0(CALL), es=1(AMER)]
  const optionMint = pda([Buffer.from("vault_option_mint"), market.toBuffer(),
    le8(STRIKE), le8(EXPIRY), Buffer.from([0]), Buffer.from([1])]);
  const vaultMintRecord = pda([Buffer.from("vault_mint_record"), optionMint.toBuffer()]);
  const vault = pda([Buffer.from("shared_vault_american"), market.toBuffer(),
    le8(STRIKE), le8(EXPIRY), Buffer.from([0])]);
  const vaultUsdc = pda([Buffer.from("vault_usdc"), vault.toBuffer()]);
  const extraMetas = PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), optionMint.toBuffer()], HOOK)[0];
  const hookState = PublicKey.findProgramAddressSync(
    [Buffer.from("hook-state"), optionMint.toBuffer()], HOOK)[0];
  const nonce = Number(process.env.NONCE ?? 880816);
  const order = pda([Buffer.from("resting_order"), optionMint.toBuffer(), kp.publicKey.toBuffer(),
    (() => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(nonce)); return b; })()]);
  const escrow = pda([Buffer.from("resting_order_escrow"), order.toBuffer()]);
  const potRec = pda([Buffer.from("writer_ask_pot"), optionMint.toBuffer()]);
  const potUsdc = pda([Buffer.from("writer_ask_pot_usdc"), optionMint.toBuffer()]);
  const makerUsdc = getAssociatedTokenAddressSync(usdcMint, kp.publicKey, false, TOKEN_PROGRAM_ID);
  const makerOpt = getAssociatedTokenAddressSync(optionMint, kp.publicKey, false, TOKEN_2022_PROGRAM_ID);

  const ex = async (k: PublicKey) => (await conn.getAccountInfo(k)) !== null;
  console.log("=== FALLBACK SERIES ===");
  console.log(`  asset/strike/expiry : ${ASSET} $${STRIKE / 1e6} CALL AMER  ${new Date(EXPIRY * 1000).toISOString()}`);
  console.log(`  maker               : ${kp.publicKey.toBase58()}`);
  console.log(`  market              : ${market.toBase58()}  exists=${await ex(market)}`);
  console.log(`  epochConfig         : ${epochConfig.toBase58()}  exists=${await ex(epochConfig)}`);
  console.log(`  optionMint (canon)  : ${optionMint.toBase58()}  exists=${await ex(optionMint)}`);
  console.log(`  vaultMintRecord     : ${vaultMintRecord.toBase58()}  exists=${await ex(vaultMintRecord)}`);
  console.log(`  vault (AMER)        : ${vault.toBase58()}  exists=${await ex(vault)}`);
  console.log(`  order (nonce ${nonce}) : ${order.toBase58()}  exists=${await ex(order)}`);
  console.log(`  pot / pot_usdc      : ${potRec.toBase58()} / ${potUsdc.toBase58()}`);
  const bal = await conn.getTokenAccountBalance(makerUsdc).catch(() => null);
  console.log(`  maker USDC          : ${bal ? usd(bal.value.amount) : "n/a"}   need ${usd(STRIKE * QTY)} escrowed`);

  if (!SEND) { console.log("\n  RECON ONLY — set SEND=1 to create + post."); return; }

  const ixs: any[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 })];
  if (!(await ex(vaultMintRecord))) {
    ixs.push(await program.methods.createSeries(new anchor.BN(STRIKE), new anchor.BN(EXPIRY), { call: {} }, { american: {} })
      .accountsStrict({
        caller: kp.publicKey, market, protocolState, optionMint, vaultMintRecord,
        transferHookProgram: HOOK, extraAccountMetaList: extraMetas, hookState,
        systemProgram: SystemProgram.programId, token2022Program: TOKEN_2022_PROGRAM_ID, rent: SYSVAR_RENT_PUBKEY,
      }).instruction());
    console.log("  + create_series");
  }
  if (!(await ex(vault))) {
    ixs.push(await program.methods.createSharedVault(
      new anchor.BN(STRIKE), new anchor.BN(EXPIRY), { call: {} }, { epoch: {} }, usdcMint, 0, { american: {} })
      .accountsStrict({
        creator: kp.publicKey, market, sharedVault: vault, vaultUsdcAccount: vaultUsdc, usdcMint,
        protocolState, epochConfig, tokenProgram: TOKEN_PROGRAM_ID, systemProgram: SystemProgram.programId,
      }).instruction());
    console.log("  + create_shared_vault (epoch, zero-pool)");
  }
  if (ixs.length > 1) {
    const sig = await provider.sendAndConfirm(new Transaction().add(...ixs), [], { commitment: "confirmed" });
    console.log(`  infra tx: ${sig}`);
  }

  if (!(await ex(order))) {
    const postIx = await program.methods.postOrder({ writerAsk: {} }, new anchor.BN(PRICE), new anchor.BN(QTY), new anchor.BN(nonce))
      .accountsStrict({
        owner: kp.publicKey, sharedVault: vault, market, vaultMintRecord, optionMint, order, escrow,
        protocolState, ownerOptionAccount: makerOpt, ownerUsdcAccount: makerUsdc, usdcMint,
        transferHookProgram: HOOK, extraAccountMetaList: extraMetas, hookState,
        tokenProgram: TOKEN_PROGRAM_ID, token2022Program: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId, rent: SYSVAR_RENT_PUBKEY,
      }).instruction();
    const sig = await provider.sendAndConfirm(
      new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), postIx), [], { commitment: "confirmed" });
    console.log(`  post_order tx: ${sig}`);
  } else {
    console.log("  order already exists — skipping post");
  }

  const o: any = await program.account.restingOrder.fetchNullable(order);
  console.log("\n=== RESULT ===");
  console.log(`  order          : ${order.toBase58()}`);
  if (o) {
    console.log(`  kind/qty_rem   : ${JSON.stringify(o.kind)} / ${o.quantityRemaining}`);
    console.log(`  price/cpt      : ${usd(o.pricePerContract)} / ${usd(o.collateralPerContract)}`);
  }
  const eb = await conn.getTokenAccountBalance(escrow).catch(() => null);
  console.log(`  escrow holds   : ${eb ? usd(eb.value.amount) : "n/a"}  (expect ${usd(STRIKE * QTY)})`);
  console.log(`  optionMint     : ${optionMint.toBase58()}`);
  console.log(`  vault          : ${vault.toBase58()}`);
})().catch((e) => { console.error("ERROR:", e?.message ?? e); if (e?.logs) e.logs.slice(-12).forEach((l: string) => console.error("   ", l)); process.exit(1); });
