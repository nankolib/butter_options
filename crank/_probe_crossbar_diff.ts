// READ-ONLY crossbar differential: is the SB devnet gateway problem UPSTREAM
// (no oracles on the queue — SB operators down) or LOCAL (our container)?
//   (1) fetchOracleByLatestVersion() — crossbar-INDEPENDENT on-chain oracle read.
//   (2) fetchGatewayFromCrossbar(HOSTED) — the crank's exact path vs hosted crossbar.
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import { Queue, AnchorUtils, ON_DEMAND_DEVNET_PID, ON_DEMAND_DEVNET_QUEUE } from "@switchboard-xyz/on-demand";
import { CrossbarClient } from "@switchboard-xyz/common";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";

(async () => {
  const rpc = process.env.OPTA_RPC_URL || fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim();
  const conn = new Connection(rpc, { commitment: "confirmed" });
  const wallet = new anchor.Wallet(Keypair.generate());
  console.log(`SB devnet queue: ${ON_DEMAND_DEVNET_QUEUE.toBase58()}  PID: ${ON_DEMAND_DEVNET_PID.toBase58()}`);
  const sbProgram = await AnchorUtils.loadProgramFromConnection(conn, wallet as any, ON_DEMAND_DEVNET_PID);
  const qObj = new Queue(sbProgram, ON_DEMAND_DEVNET_QUEUE);

  console.log("\n=== (1) ON-CHAIN oracles on the devnet queue (crossbar-INDEPENDENT) ===");
  let oraclesExist = false;
  try {
    const o: any = await qObj.fetchOracleByLatestVersion();
    oraclesExist = true;
    console.log(`  ✅ oracle FOUND: ${o?.pubkey?.toBase58?.() ?? o?.oracle?.toBase58?.() ?? JSON.stringify(o).slice(0, 120)}`);
  } catch (e: any) {
    console.log(`  ❌ fetchOracleByLatestVersion THREW: ${e?.message ?? e}`);
  }
  // Also enumerate the queue's oracle set directly if available.
  try {
    const oracles: any[] = await (qObj as any).fetchOracleKeys?.() ?? [];
    if (oracles.length) console.log(`  queue oracle keys: ${oracles.length}`);
  } catch { /* optional */ }

  console.log("\n=== (2) HOSTED crossbar gateway resolution + liveness ===");
  const hosted = new CrossbarClient("https://crossbar.switchboard.xyz");
  const q: any = qObj;
  const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(qObj)).filter((m) => /gateway/i.test(m));
  console.log(`  Queue gateway methods: ${methods.join(", ")}`);
  let gwUrl: string | null = null;
  for (const m of ["fetchGatewayByLatestVersion", "fetchGatewayFromCrossbar", "fetchGateway"]) {
    if (typeof q[m] !== "function") continue;
    try {
      const gw: any = await q[m](hosted);
      gwUrl = gw?.gatewayUrl ?? gw?.url ?? gw?.gateway_url ?? null;
      console.log(`  ✅ ${m}(hosted) → gateway: ${gwUrl ?? JSON.stringify(gw).slice(0, 140)}`);
      break;
    } catch (e: any) { console.log(`  ❌ ${m}(hosted) THREW: ${(e?.message ?? e).toString().slice(0, 160)}`); }
  }
  if (gwUrl) {
    try {
      const r = await fetch(gwUrl.replace(/\/$/, "") + "/gateway/api/v1/ping", { signal: AbortSignal.timeout(6000) }).catch(() => null as any);
      console.log(`  gateway ping ${gwUrl}: http=${r ? r.status : "no-response"}`);
    } catch (e: any) { console.log(`  gateway ping err: ${e?.message}`); }
  }

  console.log("\n=== VERDICT ===");
  console.log("  on-chain oracles exist: " + oraclesExist);
  console.log("  → oracles exist + hosted OK  ⇒ OUR container broken (restart it)");
  console.log("  → no oracles / hosted also fails ⇒ UPSTREAM (SB devnet operators) — do NOT churn; ping Jack");
})().catch((e) => console.log("FATAL", e?.message ?? e));
