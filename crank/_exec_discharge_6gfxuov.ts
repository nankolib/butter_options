// EXECUTE (greenlit 2026-07-18): discharge external holder 5uBcRhU6 on settled
// vault 6GfxUov. 2-ix tx: create 5uBcRhU6 USDC ATA (idempotent) + permissionless
// auto_finalize_holders (burns 5 OTM tokens, pays $0). Admin 5YRMuuoY = payer
// (permissionless caller; NO holder signature). Re-verifies + re-simulates
// before sending; verifies 5uBcRhU6 → 0 tokens after.
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";
import type { Opta } from "@app/idl/opta";
import { safeFetchAll } from "@app/hooks/useFetchAccounts";

const VAULT_OPTION_MINT_SEED = "vault_option_mint", VAULT_MINT_RECORD_SEED = "vault_mint_record", PROTOCOL_SEED = "protocol_v2";
const HOLDER = new PublicKey("5uBcRhU6Hc78w8pNRNgu1X953oRL93fgAHC348CKNajV");
const ADMIN_EXPECTED = "5YRMuuoY3P7z5GeRAAQND7BxgNdmPSa6CSPCJLca1zZk";
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const VAULT = "6GfxUovAaPKrGh5PaqdesXEdeAQuWAavKNSuiWz2fuuK";

(async () => {
  const rpc = process.env.OPTA_RPC_URL || fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim();
  const conn = new Connection(rpc, { commitment: "confirmed" });
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(process.env.OPTA_KEYPAIR ?? path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))));
  if (admin.publicKey.toBase58() !== ADMIN_EXPECTED) { console.error(`ABORT: signer ${admin.publicKey.toBase58()} != admin ${ADMIN_EXPECTED}`); process.exit(1); }
  const program = new Program<Opta>(
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf-8")) as Opta,
    new anchor.AnchorProvider(conn, new anchor.Wallet(admin), { commitment: "confirmed" }));

  const vaults = await safeFetchAll<any>(program, "sharedVault");
  const gRec = vaults.find((v) => v.publicKey.toBase58() === VAULT)!;
  const g = gRec.account, mpda = (g.market as PublicKey).toBase58();
  const strike = BigInt(g.strikePrice.toString()), settle = BigInt((g.settlementPrice ?? 0).toString());
  if (!g.isSettled || g.voided) { console.error(`ABORT: 6GfxUov not in settled-non-void state (settled=${g.isSettled} voided=${g.voided})`); process.exit(1); }

  const [gMint] = PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_OPTION_MINT_SEED), new PublicKey(mpda).toBuffer(),
     g.strikePrice.toArrayLike(Buffer, "le", 8), g.expiry.toArrayLike(Buffer, "le", 8),
     Buffer.from([0]), Buffer.from([1])], program.programId); // CALL(0) AMERICAN(1)

  // Real holder token account for 5uBcRhU6.
  const largest = await conn.getTokenLargestAccounts(gMint);
  let holderAcct: PublicKey | null = null, before = 0n;
  for (const x of largest.value) {
    if (!x.uiAmount) continue;
    const ai = await conn.getAccountInfo(x.address);
    if (ai && new PublicKey(ai.data.subarray(32, 64)).toBase58() === HOLDER.toBase58()) { holderAcct = x.address; before = BigInt(x.amount); }
  }
  if (!holderAcct) { console.log("5uBcRhU6 already holds 0 — nothing to discharge (idempotent no-op)."); process.exit(0); }
  console.log(`PRE: settlement=$${(Number(settle) / 1e6).toFixed(2)} strike=$${(Number(strike) / 1e6).toFixed(2)} → ${settle > strike ? "ITM" : "OTM (payout $0)"}; 5uBcRhU6 holds ${before} in ${holderAcct.toBase58()}`);

  const collMint = new PublicKey(g.collateralMint);
  const holderUsdc = getAssociatedTokenAddressSync(collMint, HOLDER, true, TOKEN_PROGRAM_ID);
  const usdcExists = !!(await conn.getAccountInfo(holderUsdc));
  const [vmr] = PublicKey.findProgramAddressSync([Buffer.from(VAULT_MINT_RECORD_SEED), gMint.toBuffer()], program.programId);
  const [ps] = PublicKey.findProgramAddressSync([Buffer.from(PROTOCOL_SEED)], program.programId);
  const ixs: any[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 })];
  if (!usdcExists) ixs.push(createAssociatedTokenAccountIdempotentInstruction(admin.publicKey, holderUsdc, HOLDER, collMint, TOKEN_PROGRAM_ID));
  ixs.push(await program.methods.autoFinalizeHolders()
    .accountsPartial({ caller: admin.publicKey, sharedVault: gRec.publicKey, market: new PublicKey(mpda), vaultMintRecord: vmr,
      optionMint: gMint, vaultUsdcAccount: g.vaultUsdcAccount, protocolState: ps, token2022Program: TOKEN_2022, tokenProgram: TOKEN_PROGRAM_ID })
    .remainingAccounts([{ pubkey: holderAcct, isSigner: false, isWritable: true }, { pubkey: holderUsdc, isSigner: false, isWritable: true }])
    .instruction());

  const bh = await conn.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: admin.publicKey, recentBlockhash: bh.blockhash, instructions: ixs }).compileToV0Message());
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) { console.error(`ABORT: pre-send sim ERR ${JSON.stringify(sim.value.err)}\n${(sim.value.logs ?? []).slice(-6).join("\n")}`); process.exit(1); }
  console.log(`pre-send sim OK (${ixs.length} ix${!usdcExists ? ", incl USDC-ATA create" : ""}) — sending...`);

  tx.sign([admin]);
  const sig = await conn.sendTransaction(tx, { skipPreflight: false });
  await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
  console.log(`SENT + confirmed: ${sig}`);

  // Verify post-state.
  const after = await conn.getAccountInfo(holderAcct);
  const afterAmt = after && after.data.length >= 72 ? after.data.readBigUInt64LE(64) : 0n;
  console.log(`POST: 5uBcRhU6 token acct amount = ${afterAmt} ${afterAmt === 0n ? "✅ DISCHARGED (burned)" : "‼ still non-zero"}`);
  console.log(`solscan: https://solscan.io/tx/${sig}?cluster=devnet`);
  process.exit(afterAmt === 0n ? 0 : 2);
})().catch((e) => { console.error("FAILED:", e.stack ?? e.message ?? e); process.exit(1); });
