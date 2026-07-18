// READ-ONLY single-shot check: are BTC EaV3yxWb + GtoM6B7f settled?
// exit 0 = both settled; 2 = still waiting (pre-expiry or settle in-flight);
// 3 = ALERT (>20min past expiry, still unsettled). Signs nothing.
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";
import type { Opta } from "@app/idl/opta";

const SETTLEMENT_SEED = "settlement";
const MARKET_SEED = "market";
const TARGETS = [
  { pk: "EaV3yxWbredBKL2XNaBzE4Vm8MLxSo8iJo7KpSb4GnW7", exp: 1784394969 }, // 17:16:09Z
  { pk: "GtoM6B7foehhLisAVYANEPWuLT2fjTfBokorFA39eUKW", exp: 1784393892 }, // 16:58:12Z
];
const LATER = Math.max(...TARGETS.map((t) => t.exp));

(async () => {
  const rpc = process.env.OPTA_RPC_URL || fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim();
  const conn = new Connection(rpc, { commitment: "confirmed" });
  const program = new Program<Opta>(
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf-8")) as Opta,
    new anchor.AnchorProvider(conn, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" }));
  const now = (await conn.getBlockTime(await conn.getSlot()))!;
  let allSettled = true;
  for (const t of TARGETS) {
    const [mktPda] = PublicKey.findProgramAddressSync([Buffer.from(MARKET_SEED), Buffer.from("BTC")], program.programId);
    void mktPda;
    const [srec] = PublicKey.findProgramAddressSync(
      [Buffer.from(SETTLEMENT_SEED), Buffer.from("BTC"), new anchor.BN(t.exp).toArrayLike(Buffer, "le", 8)], program.programId);
    const has = await conn.getAccountInfo(srec);
    console.log(`${t.pk.slice(0, 8)} exp=${new Date(t.exp * 1000).toISOString()} record=${has ? "PRESENT" : "absent"}`);
    if (!has) allSettled = false;
  }
  console.log(`cluster now ${new Date(now * 1000).toISOString()}`);
  if (allSettled) { console.log("RESULT: BOTH SETTLED ✅"); process.exit(0); }
  if (now > LATER + 1200) { console.log("RESULT: ALERT ‼ >20min past expiry, unsettled — MANUAL SETTLE"); process.exit(3); }
  console.log("RESULT: waiting (pre-expiry or settle in-flight)"); process.exit(2);
})().catch((e) => { console.error("FATAL:", e?.message ?? e); process.exit(1); });
