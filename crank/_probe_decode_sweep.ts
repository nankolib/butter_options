// READ-ONLY: decode the GtoM6B7f auto-sweep tx (~17:01:44Z). Identify WHICH Opta
// instruction ran (discriminator→IDL name) + confirm the $65K USDC delta to GkG.
import * as anchor from "@coral-xyz/anchor"; import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { createHash } from "crypto";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";
import type { Opta } from "@app/idl/opta";

const PROGRAM_ID = "CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq";
const GKG = "GkG1UX8ML4UzNSGUtJxBWfRRWCdH7YejdhfuxFWTRFAx";
const VAULT = "GtoM6B7foehhLisAVYANEPWuLT2fjTfBokorFA39eUKW";
const discReq = (n: string) => createHash("sha256").update(`global:${n}`).digest().subarray(0, 8).toString("hex");

(async () => {
  const rpc = process.env.OPTA_RPC_URL || fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim();
  const conn = new Connection(rpc, { commitment: "confirmed" });
  const idl: any = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf-8"));
  // discriminator hex -> instruction name (Anchor snake_case global:<name>)
  const byDisc = new Map<string, string>();
  for (const ix of idl.instructions) byDisc.set(discReq(ix.name), ix.name);

  const sigs = await conn.getSignaturesForAddress(new PublicKey(VAULT), { limit: 8 });
  // The sweep is the tx just AFTER the settle (~17:01:44Z), not the settle itself.
  const target = sigs.find((s) => s.blockTime && s.blockTime >= 1784394100 && s.blockTime <= 1784394120) // 17:01:40-17:02:00Z
    ?? sigs.find((s) => s.blockTime === 1784394104);
  const chosen = target ?? sigs[0];
  console.log(`decoding ${chosen.signature} @ ${chosen.blockTime ? new Date(chosen.blockTime * 1000).toISOString() : "?"}`);

  const tx = await conn.getTransaction(chosen.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx) { console.log("tx not found"); return; }
  const msg: any = tx.transaction.message;
  const keys = (msg.staticAccountKeys ?? msg.accountKeys).map((k: any) => k.toBase58 ? k.toBase58() : k);
  const ci = msg.compiledInstructions ?? msg.instructions;
  console.log("Opta instructions in tx:");
  for (const c of ci) {
    const pid = keys[c.programIdIndex];
    if (pid !== PROGRAM_ID) continue;
    const data: Buffer = Buffer.from(c.data);
    const name = byDisc.get(data.subarray(0, 8).toString("hex")) ?? "(unknown)";
    console.log(`  → ${name}`);
  }

  const gkgUsdc = getAssociatedTokenAddressSync(new PublicKey((idl && "" ) || "So11111111111111111111111111111111111111112"), new PublicKey(GKG), true, TOKEN_PROGRAM_ID); // placeholder
  // USDC balance deltas from meta (authoritative, mint-agnostic).
  const pre = tx.meta?.preTokenBalances ?? []; const post = tx.meta?.postTokenBalances ?? [];
  console.log("\nUSDC/token balance deltas (owner → delta):");
  for (const p of post) {
    const q = pre.find((x) => x.accountIndex === p.accountIndex);
    const preAmt = BigInt(q?.uiTokenAmount.amount ?? "0"); const postAmt = BigInt(p.uiTokenAmount.amount ?? "0");
    const d = postAmt - preAmt;
    if (d !== 0n) console.log(`  owner=${p.owner} ${p.owner === GKG ? "[GkG] " : ""}mint=${p.mint.slice(0, 8)}… delta=${d > 0n ? "+" : ""}${(Number(d) / 1e6).toFixed(2)}`);
  }
  void gkgUsdc;
})().catch((e) => console.log("ERR", e.message));
