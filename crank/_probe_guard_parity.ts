// Guard parity: what the :8788 endpoint PUTS at the pot indices vs what the FE
// client DERIVES locally. These must match exactly or assertExerciseTxShape
// refuses — correctly. Read-only; builds a tx, signs nothing.
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAssociatedTokenAddressSync } from "@solana/spl-token";
import path from "path";

const ENDPOINT = process.env.ENDPOINT ?? "http://localhost:8788";
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const VAULT = new PublicKey(process.env.VAULT ?? "3k5vHJLh42syDK9hhbwF3PMRHn3TvMgzWCPkYL5mceAV");
const MINT = new PublicKey(process.env.MINT ?? "EDT2J7TdFYAL6Wwr1DLJjriuwodAmbM1KybVGdr3o2Mw");
const HOLDER = new PublicKey("Awi8u6PigydVN4XRBQzmiPEdyyVmtnwf1H7Gmrf5ARu5");

// EXACT byte-for-byte mirrors of app/src/utils/constants.ts. If these ever drift
// from the Rust seeds the parity check below is what fails, loudly.
const WRITER_ASK_POT_SEED = "writer_ask_pot";
const WRITER_ASK_POT_USDC_SEED = "writer_ask_pot_usdc";
const PROTOCOL_SEED = "protocol_v2";
const IDX = { writerAskPot: 14, writerAskPotUsdc: 15, protocolState: 16 };

(async () => {
  const conn = new Connection(process.env.OPTA_RPC_URL!, "confirmed");
  const wallet = new anchor.Wallet(Keypair.generate());
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  const idl = require(path.resolve(__dirname, "../app/src/idl/opta.json"));
  const program = new anchor.Program(idl as any, provider) as any;
  const PID: PublicKey = program.programId;

  const v: any = await program.account.sharedVault.fetch(VAULT);
  const ps: any = await program.account.protocolState.fetch(
    PublicKey.findProgramAddressSync([Buffer.from(PROTOCOL_SEED)], PID)[0]);

  // ---- CLIENT SIDE: what the FE now derives ----
  const derived = {
    writerAskPot: PublicKey.findProgramAddressSync(
      [Buffer.from(WRITER_ASK_POT_SEED), MINT.toBuffer()], PID)[0].toBase58(),
    writerAskPotUsdc: PublicKey.findProgramAddressSync(
      [Buffer.from(WRITER_ASK_POT_USDC_SEED), MINT.toBuffer()], PID)[0].toBase58(),
    protocolState: PublicKey.findProgramAddressSync(
      [Buffer.from(PROTOCOL_SEED)], PID)[0].toBase58(),
  };

  // ---- SERVER SIDE: what the endpoint actually builds ----
  const body = {
    holder: HOLDER.toBase58(),
    sharedVault: VAULT.toBase58(),
    market: (v.market as PublicKey).toBase58(),
    vaultMintRecord: PublicKey.findProgramAddressSync(
      [Buffer.from("vault_mint_record"), MINT.toBuffer()], PID)[0].toBase58(),
    optionMint: MINT.toBase58(),
    holderOptionAccount: getAssociatedTokenAddressSync(MINT, HOLDER, false, TOKEN_2022).toBase58(),
    vaultUsdcAccount: (v.vaultUsdcAccount as PublicKey).toBase58(),
    holderUsdcAccount: (await getAssociatedTokenAddress(ps.usdcMint as PublicKey, HOLDER)).toBase58(),
    quantity: Number(process.env.QTY ?? 1),
  };
  const r = await fetch(`${ENDPOINT}/sb-exercise-american`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: process.env.ORIGIN ?? "http://localhost:5173" },
    body: JSON.stringify(body),
  });
  if (!r.ok) { console.log("endpoint HTTP", r.status, await r.text()); return; }
  const j: any = await r.json();
  const tx = VersionedTransaction.deserialize(Buffer.from(j.transactionBase64, "base64"));
  const keys = tx.message.getAccountKeys();
  const optaIdx = keys.staticAccountKeys.findIndex((k) => k.equals(PID));
  const ex = tx.message.compiledInstructions.find((i) => i.programIdIndex === optaIdx)!;
  const at = (i: number) => keys.get(ex.accountKeyIndexes[i])!.toBase58();

  console.log(`  exercise account count: ${ex.accountKeyIndexes.length} (14=vault-only, 17=pot arm)`);
  console.log("\n  idx  label               ENDPOINT BUILT                                CLIENT DERIVED                                MATCH");
  let allMatch = true;
  for (const [label, idx] of Object.entries(IDX)) {
    const server = at(idx);
    const client = (derived as any)[label];
    const ok = server === client;
    if (!ok) allMatch = false;
    console.log(`  [${idx}] ${label.padEnd(18)} ${server.padEnd(45)} ${client.padEnd(45)} ${ok ? "OK" : "*** MISMATCH ***"}`);
  }
  console.log(`\n  GUARD PARITY: ${allMatch ? "PASS — assertExerciseTxShape will accept" : "FAIL — the guard will refuse (correctly)"}`);
  process.exit(allMatch ? 0 : 1);
})().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(2); });
