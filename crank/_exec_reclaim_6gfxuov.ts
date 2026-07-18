// EXECUTE (greenlit 2026-07-18): withdraw_writer_ask_residual — backer DnExEYnZ
// reclaims their post-settlement residual (~$400) from settled vault 6GfxUov.
// Permissionless + recipient-pinned (funds can only land in the backer's ATA);
// signed here by DnExEYnZ (WALLET_PRIVATE_KEY env, base58). Re-verifies + sims
// before sending; verifies vault_usdc -> $0 after.
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import bs58 from "bs58";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";
import type { Opta } from "@app/idl/opta";
import { safeFetchAll } from "@app/hooks/useFetchAccounts";

const VAULT_OPTION_MINT_SEED = "vault_option_mint", WRITER_ASK_POSITION_SEED = "writer_ask_position";
const BACKER_EXPECTED = "DnExEYnZGuEu7xgpmNupJVXJLbMbkNdf3E7f28Zv6LUQ";
const VAULT = "6GfxUovAaPKrGh5PaqdesXEdeAQuWAavKNSuiWz2fuuK";
const bal = async (c: Connection, a: PublicKey) => { const ai = await c.getAccountInfo(a); return ai && ai.data.length >= 72 ? ai.data.readBigUInt64LE(64) : -1n; };

(async () => {
  const rpc = process.env.OPTA_RPC_URL || fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim();
  const conn = new Connection(rpc, { commitment: "confirmed" });
  const sk = (process.env.WALLET_PRIVATE_KEY || "").trim();
  if (!sk) { console.error("ABORT: WALLET_PRIVATE_KEY not in env"); process.exit(1); }
  const backer = Keypair.fromSecretKey(sk.startsWith("[") ? Uint8Array.from(JSON.parse(sk)) : bs58.decode(sk));
  if (backer.publicKey.toBase58() !== BACKER_EXPECTED) { console.error(`ABORT: env key ${backer.publicKey.toBase58()} != DnExEYnZ`); process.exit(1); }
  const program = new Program<Opta>(
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf-8")) as Opta,
    new anchor.AnchorProvider(conn, new anchor.Wallet(backer), { commitment: "confirmed" }));

  const vaults = await safeFetchAll<any>(program, "sharedVault");
  const gRec = vaults.find((v) => v.publicKey.toBase58() === VAULT)!;
  const g = gRec.account, mpda = (g.market as PublicKey).toBase58();
  if (!g.isSettled || g.voided) { console.error(`ABORT: not settled-non-void (settled=${g.isSettled} voided=${g.voided})`); process.exit(1); }
  const [gMint] = PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_OPTION_MINT_SEED), new PublicKey(mpda).toBuffer(),
     g.strikePrice.toArrayLike(Buffer, "le", 8), g.expiry.toArrayLike(Buffer, "le", 8),
     Buffer.from([0]), Buffer.from([1])], program.programId);
  const [waPos] = PublicKey.findProgramAddressSync(
    [Buffer.from(WRITER_ASK_POSITION_SEED), gMint.toBuffer(), backer.publicKey.toBuffer()], program.programId);
  const collMint = new PublicKey(g.collateralMint);
  const backerUsdc = getAssociatedTokenAddressSync(collMint, backer.publicKey, true, TOKEN_PROGRAM_ID);

  const vBefore = await bal(conn, g.vaultUsdcAccount as PublicKey);
  const bBefore = await bal(conn, backerUsdc);
  console.log(`PRE: 6GfxUov vault_usdc=$${(Number(vBefore) / 1e6).toFixed(2)}  DnExEYnZ_usdc=${bBefore >= 0n ? "$" + (Number(bBefore) / 1e6).toFixed(2) : "no-ATA (will create)"}`);

  const ixs: any[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 })];
  if (bBefore < 0n) ixs.push(createAssociatedTokenAccountIdempotentInstruction(backer.publicKey, backerUsdc, backer.publicKey, collMint, TOKEN_PROGRAM_ID));
  ixs.push(await program.methods.withdrawWriterAskResidual()
    .accountsPartial({ cranker: backer.publicKey, sharedVault: gRec.publicKey, writerAskPosition: waPos,
      vaultUsdcAccount: g.vaultUsdcAccount, writerUsdcAccount: backerUsdc, tokenProgram: TOKEN_PROGRAM_ID })
    .instruction());

  const bh = await conn.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: backer.publicKey, recentBlockhash: bh.blockhash, instructions: ixs }).compileToV0Message());
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) { console.error(`ABORT: sim ERR ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).slice(-6).join("\n")}`); process.exit(1); }
  console.log("pre-send sim OK — sending...");
  tx.sign([backer]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: false });
  await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
  console.log(`SENT + confirmed: ${sig}`);

  const vAfter = await bal(conn, g.vaultUsdcAccount as PublicKey);
  const bAfter = await bal(conn, backerUsdc);
  console.log(`POST: 6GfxUov vault_usdc=$${(Number(vAfter) / 1e6).toFixed(2)} ${vAfter === 0n ? "✅ ZERO" : "‼ non-zero"}   DnExEYnZ_usdc=$${(Number(bAfter) / 1e6).toFixed(2)} (+$${(Number(bAfter - (bBefore < 0n ? 0n : bBefore)) / 1e6).toFixed(2)})`);
  console.log(`solscan: https://solscan.io/tx/${sig}?cluster=devnet`);
  process.exit(vAfter === 0n ? 0 : 2);
})().catch((e) => { console.error("FAILED:", e.stack ?? e.message ?? e); process.exit(1); });
