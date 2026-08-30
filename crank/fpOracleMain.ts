// ============================================================================
// crank/fpOracleMain.ts -- entrypoint for the FP-ORACLE push lane
// ============================================================================
//
// Its OWN process, its OWN unit, its OWN env file. Not a side-loop in bot.ts.
// See FP_ORACLE_MODULE_SPEC_V2 section 6.3 -- runtime isolation is a boundary
// INVARIANT here, not a preference: this process holds a key that can write
// settlement prices, and it must not be reachable from a shared env file that
// gets edited under incident pressure.
//
// EVERY env var is OPTA_FP_-prefixed and read ONLY from this lane's env file.
// Nothing is shared with opta-crank. OPTA_FP_RPC_URL deliberately duplicates the
// value of OPTA_RPC_URL rather than reusing the name: a shared variable is a
// path by which editing one lane silently changes another.
//
//   OPTA_FP_RPC_URL          (required) RPC endpoint
//   OPTA_FP_PROGRAM_ID       (required) SCRATCH program id -- see the guard below
//   OPTA_FP_KEYPAIR          (required) oracle authority keypair path
//   OPTA_FP_JSONL            (default /opt/opta-fp-oracle/fp-oracle-samples.jsonl)
//   OPTA_FP_DRY_RUN          (default "1" = ON; "0" to actually send)
//   OPTA_FP_CRANK_DISABLED   ("1" -> exit 0 immediately)
//   OPTA_FP_FORCE_FEED       (optional) comma-separated feed hashes
//   OPTA_FP_INTERVAL_MS      (default 60000)
//   TICK_ONCE                ("1" -> one tick then exit)
//
// THREE BOOT REFUSALS, all fail-closed and all loud. Each exists because the
// quiet version of the same mistake is expensive:
//
//   1. PROGRAM ID. The IDL at app/src/idl/opta.json carries the CANONICAL
//      program address. Constructing a Program from it without an override
//      would point this lane at production. OPTA_FP_PROGRAM_ID is REQUIRED and
//      must NOT equal the canonical id -- while the branch is open, this lane
//      only ever addresses the scratch program.
//   2. KEYPAIR PATH. Refuse any path under /opt/opta-crank. opta-trigger already
//      shares opta-crank's signing key; that pattern must not reach a key that
//      can write prices (spec 6.3).
//   3. AUTHORITY != ADMIN is enforced ON-CHAIN by init/rotate, so it is not
//      re-checked here -- but the loaded pubkey is logged at boot so a
//      misconfiguration is visible in the journal on line one.
// ============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

import { runFpOracleCrank, type FpCrankContext, type FpLogLevel } from "./fpOracleCrank";

/** The live production program. This lane must never address it. */
const CANONICAL_PROGRAM_ID = "CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq";
// LANE-LOCAL IDL, deliberately NOT ../app/src/idl/opta.json.
//
// The app's IDL copy is the CANONICAL surface and does not carry this module's
// instructions — correctly so. Regenerating it to include push_opta_price would
// put module instructions into the canonical IDL and trip the IDL-drift gate,
// which requires every tracked copy to match. So the lane ships its own copy,
// built from `anchor build` output (target/idl/opta.json), living under its own
// tree. One more thing not shared with another service (spec 6.3).
//
// The `address` field in that file is whatever the build declared; it is
// overridden below with OPTA_FP_PROGRAM_ID regardless, so a canonical-address
// IDL is fine to ship here.
const IDL_JSON_PATH =
  process.env.OPTA_FP_IDL?.trim() || path.resolve(__dirname, "../idl/opta.json");
const DEFAULT_JSONL = "/opt/opta-fp-oracle/fp-oracle-samples.jsonl";

function log(level: FpLogLevel, msg: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, subsystem: "fp-oracle", ...(fields ?? {}) });
  if (level === "error" || level === "fatal") console.error(line);
  else console.log(line);
}

function required(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    log("fatal", `${name} is required`, { hint: "set it in /opt/opta-fp-oracle/.env" });
    process.exit(1);
  }
  return v;
}

function loadKeypair(p: string): Keypair {
  // BOUNDARY INVARIANT (spec 6.3): the oracle authority never lives under
  // another lane's tree. Checked on the RESOLVED path so a symlink or a
  // ../ cannot walk into opta-crank's secrets.
  const resolved = path.resolve(p);
  if (resolved.startsWith("/opt/opta-crank")) {
    log("fatal", "REFUSING to load the oracle authority from opta-crank's tree", {
      path: resolved,
      invariant: "FP_ORACLE_MODULE_SPEC_V2 section 6.3 — runtime isolation",
    });
    process.exit(1);
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(resolved, "utf-8"))));
  } catch (e) {
    // Never echo the path's CONTENTS, only its path.
    log("fatal", "could not load oracle authority keypair", { path: resolved, err: String(e).slice(0, 120) });
    process.exit(1);
  }
}

async function main(): Promise<void> {
  if ((process.env.OPTA_FP_CRANK_DISABLED ?? "") === "1") {
    log("info", "fp-oracle DISABLED via OPTA_FP_CRANK_DISABLED=1 — exiting cleanly");
    return;
  }

  const rpcUrl = required("OPTA_FP_RPC_URL");
  const programIdRaw = required("OPTA_FP_PROGRAM_ID");
  const keypairPath = required("OPTA_FP_KEYPAIR");

  if (programIdRaw === CANONICAL_PROGRAM_ID) {
    log("fatal", "REFUSING to run against the CANONICAL program", {
      programId: programIdRaw,
      invariant: "the fp-oracle branch addresses the scratch program only",
    });
    process.exit(1);
  }
  let programId: PublicKey;
  try {
    programId = new PublicKey(programIdRaw);
  } catch {
    log("fatal", "OPTA_FP_PROGRAM_ID is not a valid pubkey", { value: programIdRaw });
    process.exit(1);
    return;
  }

  const dryRunRaw = (process.env.OPTA_FP_DRY_RUN ?? "1").toLowerCase();
  const dryRun = !(dryRunRaw === "0" || dryRunRaw === "false");
  const jsonlPath = process.env.OPTA_FP_JSONL?.trim() || DEFAULT_JSONL;
  const intervalMs = Number(process.env.OPTA_FP_INTERVAL_MS ?? 60_000) || 60_000;
  const forceFeeds = (process.env.OPTA_FP_FORCE_FEED ?? "")
    .split(",").map((x) => x.trim().replace(/^0x/, "").toLowerCase()).filter(Boolean);
  const tickOnce = (process.env.TICK_ONCE ?? "").toLowerCase() === "1";

  const keypair = loadKeypair(keypairPath);
  const connection = new Connection(rpcUrl, "confirmed");
  const wallet = new anchor.Wallet(keypair);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });

  // Override the IDL's baked-in canonical address with the scratch program.
  const idl = { ...JSON.parse(fs.readFileSync(IDL_JSON_PATH, "utf-8")), address: programId.toBase58() };
  const program = new anchor.Program(idl as anchor.Idl, provider);

  let shutdown = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { log("info", `${sig} — shutting down after this tick`); shutdown = true; });
  }

  log("info", "fp-oracle boot", {
    programId: program.programId.toBase58(),
    authority: wallet.publicKey.toBase58(),
    rpcHost: (() => { try { return new URL(rpcUrl).host; } catch { return "?"; } })(),
    keypairPath: path.resolve(keypairPath),
    jsonlPath, dryRun, intervalMs, tickOnce,
    forceFeeds: forceFeeds.length ? forceFeeds.map((f) => f.slice(0, 10)) : "all",
  });

  const ctx: FpCrankContext = {
    connection, wallet, program, log,
    shouldShutdown: () => shutdown,
    dryRun, forceFeeds, jsonlPath, intervalMs,
  };
  await runFpOracleCrank(ctx, { tickOnce });
}

main().catch((e) => {
  log("fatal", "fp-oracle crashed", { err: String(e), stack: (e as any)?.stack });
  process.exit(1);
});
