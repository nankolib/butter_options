// fGvpt9Ao drain (greenlit 2026-07-18): GkG burn_unsold + withdraw_from_vault.
// Live PUT $70 American, GkG sole writer, no buyers. burn_unsold removes the
// outstanding (unsold) options so the $70 becomes free collateral, then
// withdraw_from_vault returns it to GkG. DRY-RUN (sim only) by default; --execute
// signs with gkg.json and sends. Verifies vault_usdc -> $0 after.
import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";
import type { Opta } from "@app/idl/opta";
import { safeFetchAll } from "@app/hooks/useFetchAccounts";

const VAULT_OPTION_MINT_SEED = "vault_option_mint", VAULT_MINT_RECORD_SEED = "vault_mint_record";
const VAULT_PURCHASE_ESCROW_SEED = "vault_purchase_escrow", WRITER_POSITION_SEED = "writer_position", PROTOCOL_SEED = "protocol_v2";
const GKG_EXPECTED = "GkG1UX8ML4UzNSGUtJxBWfRRWCdH7YejdhfuxFWTRFAx";
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const VAULT = "fGvpt9AoSAxkeXgdD6fEyw8j6DGNZErobk7CcmJYt8E";
const bal = async (c: Connection, a: PublicKey) => { const ai = await c.getAccountInfo(a); return ai && ai.data.length >= 72 ? ai.data.readBigUInt64LE(64) : -1n; };

(async () => {
  const execute = process.argv.includes("--execute");
  const rpc = process.env.OPTA_RPC_URL || fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim();
  const conn = new Connection(rpc, { commitment: "confirmed" });
  const gkg = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(process.env.GKG_KEYPAIR ?? path.join(os.homedir(), ".config/solana/gkg.json"), "utf-8"))));
  if (gkg.publicKey.toBase58() !== GKG_EXPECTED) { console.error(`ABORT: keypair ${gkg.publicKey.toBase58()} != GkG`); process.exit(1); }
  const program = new Program<Opta>(
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf-8")) as Opta,
    new anchor.AnchorProvider(conn, new anchor.Wallet(gkg), { commitment: "confirmed" }));

  const vaults = await safeFetchAll<any>(program, "sharedVault");
  const gRec = vaults.find((v) => v.publicKey.toBase58() === VAULT)!;
  const g = gRec.account, mpda = (g.market as PublicKey).toBase58();
  if (g.isSettled || g.voided) { console.error(`ABORT: expected live vault (settled=${g.isSettled} voided=${g.voided})`); process.exit(1); }
  const [gMint] = PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_OPTION_MINT_SEED), new PublicKey(mpda).toBuffer(),
     g.strikePrice.toArrayLike(Buffer, "le", 8), g.expiry.toArrayLike(Buffer, "le", 8),
     Buffer.from([1]), Buffer.from([1])], program.programId); // PUT(1) AMERICAN(1)
  const [vmr] = PublicKey.findProgramAddressSync([Buffer.from(VAULT_MINT_RECORD_SEED), gMint.toBuffer()], program.programId);
  let vm: any = null;
  try { vm = await program.account.vaultMint.fetch(vmr); } catch { /* no mint record → no options ever minted → nothing to burn */ }
  const [wpos] = PublicKey.findProgramAddressSync([Buffer.from(WRITER_POSITION_SEED), gRec.publicKey.toBuffer(), gkg.publicKey.toBuffer()], program.programId);
  const wp: any = await program.account.writerPosition.fetch(wpos);
  const [ps] = PublicKey.findProgramAddressSync([Buffer.from(PROTOCOL_SEED)], program.programId);
  const collMint = new PublicKey(g.collateralMint);
  const gkgUsdc = getAssociatedTokenAddressSync(collMint, gkg.publicKey, true, TOKEN_PROGRAM_ID);

  let escrow: PublicKey | null = null, unsold = 0n;
  if (vm) {
    [escrow] = PublicKey.findProgramAddressSync(
      [Buffer.from(VAULT_PURCHASE_ESCROW_SEED), gRec.publicKey.toBuffer(), (vm.writer as PublicKey).toBuffer(), new BN(vm.createdAt).toArrayLike(Buffer, "le", 8)], program.programId);
    const escrowAcct = await conn.getAccountInfo(escrow);
    unsold = escrowAcct && escrowAcct.data.length >= 72 ? escrowAcct.data.readBigUInt64LE(64) : 0n;
  }
  const vBefore = await bal(conn, g.vaultUsdcAccount as PublicKey);
  const gkgBefore = await bal(conn, gkgUsdc);
  console.log(`fGvpt9Ao: vault_usdc=$${(Number(vBefore) / 1e6).toFixed(2)} shares=${wp.shares} options_minted(wp)=${wp.optionsMinted} vaultMint=${vm ? "EXISTS" : "ABSENT (no options minted)"} escrow_unsold=${unsold}`);
  console.log(`option_mint=${gMint.toBase58()} (expect 97qnsbUpm…) GkG_usdc=${gkgBefore >= 0n ? "$" + (Number(gkgBefore) / 1e6).toFixed(2) : "no-ATA"}`);

  const ixs: any[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 })];
  if (gkgBefore < 0n) ixs.push(createAssociatedTokenAccountIdempotentInstruction(gkg.publicKey, gkgUsdc, gkg.publicKey, collMint, TOKEN_PROGRAM_ID));
  if (vm && unsold > 0n && escrow) ixs.push(await program.methods.burnUnsoldFromVault()
    .accountsPartial({ writer: gkg.publicKey, sharedVault: gRec.publicKey, writerPosition: wpos, vaultMintRecord: vmr,
      protocolState: ps, optionMint: gMint, purchaseEscrow: escrow, token2022Program: TOKEN_2022 }).instruction());
  ixs.push(await program.methods.withdrawFromVault(new BN(wp.shares.toString()))
    .accountsPartial({ writer: gkg.publicKey, sharedVault: gRec.publicKey, writerPosition: wpos,
      vaultUsdcAccount: g.vaultUsdcAccount, writerUsdcAccount: gkgUsdc, protocolState: ps, tokenProgram: TOKEN_PROGRAM_ID }).instruction());

  const bh = await conn.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: gkg.publicKey, recentBlockhash: bh.blockhash, instructions: ixs }).compileToV0Message());
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) { console.error(`SIM ERR ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).slice(-8).join("\n")}`); process.exit(1); }
  console.log(`SIM OK (${ixs.length} ix: ${unsold > 0n ? "burn_unsold + " : ""}withdraw ${wp.shares} shares)`);
  if (!execute) { console.log("(dry-run — re-run with --execute to send)"); process.exit(0); }

  tx.sign([gkg]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: false });
  await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
  const vAfter = await bal(conn, g.vaultUsdcAccount as PublicKey);
  const gkgAfter = await bal(conn, gkgUsdc);
  console.log(`SENT + confirmed: ${sig}`);
  console.log(`POST: fGvpt9Ao vault_usdc=$${(Number(vAfter) / 1e6).toFixed(2)} ${vAfter === 0n ? "✅ ZERO" : "‼"}  GkG_usdc +$${(Number(gkgAfter - (gkgBefore < 0n ? 0n : gkgBefore)) / 1e6).toFixed(2)}`);
  console.log(`solscan: https://solscan.io/tx/${sig}?cluster=devnet`);
  process.exit(vAfter === 0n ? 0 : 2);
})().catch((e) => { console.error("FAILED:", e.stack ?? e.message ?? e); process.exit(1); });
