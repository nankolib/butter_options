// ============================================================================
// crank/sbOracleCrank.dryrun.ts — LIVE devnet dry-run harness (Stage 3 1c-ii-A)
// ============================================================================
// Runs the REAL runSbOracleCrank() against LIVE devnet in TICK_ONCE + DRY_RUN,
// forcing the gold feedHash (OPTA_SB_FORCE_FEED) so the push path is exercised
// even though no on-chain SB market exists yet (create-SB-market is held
// undeployed). Real RPC + real SB gateway fetch + real simulate — NO send.
//
// Proves: the loop discovers SB markets (0 today, correct), the registry gate
// resolves gold, the loop builds [CU, ed25519, push_vol_sample] for the 1c-i-A
// unlisted gold VolOracle (AK8M6Z…), simulates CLEAN (err null), logs WOULD-SEND,
// and NEVER sends.
//
// Loads the FRESH target/idl/opta.json (has push_vol_sample's SB trailing
// accounts) — the production bot.ts loads app/src/idl/opta.json which is stale
// for push (the deferred IDL sync, see the report).
//
// Run (from crank/, RPC + keypair off-repo):
//   OPTA_RPC_URL="$(cat ~/.opta-rpc-helius)" \
//   ts-node --transpile-only -r tsconfig-paths/register sbOracleCrank.dryrun.ts
// ============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { Opta } from "@app/idl/opta";
import { runSbOracleCrank, type SbOracleCrankContext } from "./sbOracleCrank";

const GOLD_FEEDHASH = "6c3c5cc720d1ffd8108aca22bf7834d659612b7e1a4e5f623b76846d1167355e";
const FRESH_IDL_PATH = path.resolve(__dirname, "../target/idl/opta.json");
const DEFAULT_KEYPAIR = path.join(os.homedir(), ".config/solana/id.json");

function redact(url: string): string {
  return url.replace(/([?&]api-key=)[^&]*/i, "$1<redacted>");
}

async function main(): Promise<void> {
  const rpcUrl =
    process.env.OPTA_RPC_URL ||
    (fs.existsSync(path.join(os.homedir(), ".opta-rpc-helius"))
      ? fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim()
      : "https://api.devnet.solana.com");
  const keypairPath = process.env.OPTA_CRANK_KEYPAIR ?? DEFAULT_KEYPAIR;

  const connection = new Connection(rpcUrl, "confirmed");
  const secret = JSON.parse(fs.readFileSync(keypairPath, "utf-8")) as number[];
  const wallet = new anchor.Wallet(Keypair.fromSecretKey(Uint8Array.from(secret)));
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(FRESH_IDL_PATH, "utf-8")) as Opta;
  const program = new anchor.Program<Opta>(idl, provider);

  console.log(JSON.stringify({ ev: "dryrun-boot", rpc: redact(rpcUrl), wallet: wallet.publicKey.toBase58(), idl: "target/idl/opta.json (fresh)" }));

  // Forced SETTLE target: a synthetic (asset, expiry) for the gold feed, expiry
  // just past so it's inside the 300s window. No real SB market exists, so the
  // settle sim is EXPECTED to revert at market-load — proving the tx is well-formed
  // (SB accounts + ed25519 wired) up to the missing market.
  const forcedExpiry = Math.floor(Date.now() / 1000) - 30;

  const logs: any[] = [];
  const ctx: SbOracleCrankContext = {
    connection,
    wallet,
    program,
    log: (level, msg, fields) => {
      const e = { level, msg, ...(fields ?? {}) };
      logs.push(e);
      console.log(JSON.stringify(e));
    },
    shouldShutdown: () => false,
    dryRun: true,
    forceFeeds: [GOLD_FEEDHASH], // exercise the push path without a discoverable SB market
    forceSettles: [{ asset: "XAUSB", expiry: forcedExpiry, feedHashHex: GOLD_FEEDHASH }],
  };

  await runSbOracleCrank(ctx, { tickOnce: true });

  console.log("\n--- DRY-RUN ASSERTIONS ---");
  const wouldSend = logs.filter((l) => l.msg === "WOULD-SEND sb push (dry-run, NOT sent)");
  const wouldBirth = logs.filter((l) => l.msg === "WOULD-BIRTH sb vol-oracle (dry-run, NOT sent)");
  const settleProof = logs.filter((l) => l.msg.startsWith("sb-oracle settle FORCED-PROOF"));
  const settleWouldSend = logs.filter((l) => l.msg === "WOULD-SEND sb settle (dry-run, NOT sent)");
  const actuallySent = logs.filter((l) =>
    ["sb-oracle push sent", "sb-oracle birthed", "sb-oracle settle sent"].includes(l.msg));
  const settleWiringBug = logs.filter((l) => l.msg === "sb-oracle settle WIRING bug (SB accounts/ed25519)");

  let ok = true;
  const check = (cond: boolean, label: string) => { console.log(`${cond ? "✓" : "✗"} ${label}`); ok = ok && cond; };

  // -- Push path --
  check(actuallySent.length === 0, "NOTHING was sent (dry-run short-circuits send)");
  check(wouldSend.length === 1 || wouldBirth.length === 1,
    `gold push processed: 1 WOULD-SEND OR 1 WOULD-BIRTH (push=${wouldSend.length} birth=${wouldBirth.length})`);
  if (wouldSend.length === 1) check(wouldSend[0].simOk === true, "gold push simulated CLEAN (err null)");

  // -- Settle path (forced) --
  check(settleWiringBug.length === 0, "settle has NO SB-account/ed25519 wiring bug");
  check(settleProof.length === 1 || settleWouldSend.length === 1,
    `forced settle processed: tx well-formed (proof=${settleProof.length} wouldSend=${settleWouldSend.length})`);
  const sp = settleProof[0] ?? settleWouldSend[0];
  if (sp) {
    check(sp.accounts === 8, `settle tx has 8 accounts (caller/market/priceUpdate/settlementRecord/system + 3 SB) (got ${sp.accounts})`);
    check(sp.ed25519Bytes > 0, `settle tx carries the ed25519 ix (${sp.ed25519Bytes}B)`);
  }

  console.log(`\n${ok ? "DRY-RUN PASS" : "DRY-RUN FAIL"} — push:{would=${wouldSend.length},birth=${wouldBirth.length}} settle:{proof=${settleProof.length},would=${settleWouldSend.length},wiringBug=${settleWiringBug.length}} sent=${actuallySent.length}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error("sb dry-run harness crashed:", err); process.exit(1); });
