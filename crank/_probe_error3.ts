// Reproduce the real preflight: simulate the EXACT bytes the :8788 endpoint
// serves, WITHOUT replaceRecentBlockhash. Every earlier probe passed
// replaceRecentBlockhash:true, which substitutes a fresh blockhash and can mask
// failures that depend on the transaction being evaluated as-served.
import * as anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, VersionedTransaction, Ed25519Program,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { getAssociatedTokenAddress, getAssociatedTokenAddressSync } from "@solana/spl-token";
import path from "path";

const ENDPOINT = process.env.ENDPOINT ?? "http://localhost:8788";
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const VAULT = new PublicKey(process.env.VAULT ?? "6tq9Ueck1F7d9y1n3v9c6NbU5mhxTXshHKkR8y6YZ83V");
const MINT = new PublicKey(process.env.MINT ?? "DrcqMdCKMeELEcDCe4ioNLHUjUAwUhe4apfa3qaePefg");
const HOLDER = new PublicKey("Awi8u6PigydVN4XRBQzmiPEdyyVmtnwf1H7Gmrf5ARu5");
const QTY = Number(process.env.QTY ?? 3);

const KNOWN: Record<string, string> = {
  "CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq": "opta",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": "token-2022",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA": "spl-token",
  "ComputeBudget111111111111111111111111111111": "compute-budget",
  "Ed25519SigVerify111111111111111111111111111": "ed25519-precompile",
  "SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv": "switchboard-on-demand",
  "83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG": "opta-transfer-hook",
};

(async () => {
  const conn = new Connection(process.env.OPTA_RPC_URL!, "confirmed");
  const wallet = new anchor.Wallet(Keypair.generate());
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  const idl = require(path.resolve(__dirname, "../app/src/idl/opta.json"));
  const program = new anchor.Program(idl as any, provider) as any;
  const PID: PublicKey = program.programId;

  const v: any = await program.account.sharedVault.fetch(VAULT);
  const ps: any = await program.account.protocolState.fetch(
    PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], PID)[0]);

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
    quantity: QTY,
  };
  const r = await fetch(`${ENDPOINT}/sb-exercise-american`, {
    method: "POST", headers: { "content-type": "application/json", origin: process.env.ORIGIN ?? "http://localhost:5173" },
    body: JSON.stringify(body),
  });
  const j: any = await r.json();
  if (!r.ok) { console.log("endpoint HTTP", r.status, JSON.stringify(j)); return; }
  const tx = VersionedTransaction.deserialize(Buffer.from(j.transactionBase64, "base64"));

  // ---- what did we actually get served? ----
  const keys = tx.message.getAccountKeys();
  console.log("=== SERVED TX LAYOUT ===");
  tx.message.compiledInstructions.forEach((ix, i) => {
    const pid = keys.get(ix.programIdIndex)!.toBase58();
    console.log(`  ix[${i}] program=${KNOWN[pid] ?? pid}  accounts=${ix.accountKeyIndexes.length}  dataBytes=${ix.data.length}`);
  });
  console.log(`  fee payer   : ${keys.get(0)!.toBase58()}`);
  console.log(`  blockhash   : ${tx.message.recentBlockhash}`);
  console.log(`  quoteExpires: ${j.quoteExpiresAtSlot}   currentSlot: ${await conn.getSlot("confirmed")}`);

  for (const [label, replace] of [["replaceRecentBlockhash:TRUE (what my earlier probes did)", true],
                                  ["replaceRecentBlockhash:FALSE (what preflight does)", false]] as const) {
    console.log(`\n=== SIM — ${label} ===`);
    const sim = await conn.simulateTransaction(tx, {
      sigVerify: false, replaceRecentBlockhash: replace, commitment: "confirmed",
    });
    console.log("  err :", JSON.stringify(sim.value.err));
    console.log("  logs:");
    for (const l of sim.value.logs ?? []) console.log("    " + l);
  }
})().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });
