// ============================================================================
// crank/triggerCrankMain.ts — standalone entry for the trigger keeper
// ============================================================================
//
// triggerCrank.ts is a LIBRARY (it exports runTriggerCrank and has no main
// guard); in the original design bot.ts spawned it as a 4th side-loop. Phase A
// runs it as its OWN systemd unit instead — the crank carries the vol/sb oracle
// loops the whole board's freshness depends on, and a trigger-loop fault must
// not be able to take those down. This file is the missing bootstrap: build the
// ctx exactly as bot.ts does, wire signals, run the loop.
//
// Env (mirrors bot.ts so the two units read the same names):
//   OPTA_RPC_URL              required
//   OPTA_CRANK_KEYPAIR        default ~/.config/solana/id.json (gas-only keeper)
//   OPTA_HERMES_BASE          default https://hermes.pyth.network
//   OPTA_TRIGGER_SB_ENABLED   1 = watch/fire Switchboard markets (Phase A)
//   OPTA_TRIGGER_DRY_RUN      defaults ON; set 0 to actually send
//   OPTA_TRIGGER_TICK_MS / _FIRE_MARGIN_BPS / _FEED_STALE_SECS  optional
//   TICK_ONCE=1               single tick then exit (smoke)
// ============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  runTriggerCrank, type TriggerCrankContext, type TriggerCrankOptions,
} from "./triggerCrank";

const log = (level: string, msg: string, fields?: Record<string, unknown>) => {
  process.stdout.write(JSON.stringify({
    ts: new Date().toISOString(), level, msg, subsystem: "trigger", ...(fields ?? {}),
  }) + "\n");
};
const die = (msg: string, fields?: Record<string, unknown>): never => {
  log("fatal", msg, fields);
  process.exit(1);
};

function loadKeypair(p: string): Keypair {
  let raw: string;
  try { raw = fs.readFileSync(p, "utf-8"); }
  catch (err) { return die("failed to read keypair file", { path: p, err: String(err) }); }
  let secret: number[];
  try { secret = JSON.parse(raw); }
  catch (err) { return die("keypair file is not valid JSON", { path: p, err: String(err) }); }
  if (!Array.isArray(secret) || secret.length !== 64) {
    return die("keypair file must be a 64-byte JSON array", { path: p, length: (secret as any)?.length });
  }
  try { return Keypair.fromSecretKey(Uint8Array.from(secret)); }
  catch (err) { return die("invalid keypair bytes", { err: String(err) }); }
}

const numEnv = (name: string): number | undefined => {
  const v = process.env[name];
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return die(`${name} must be a positive number`, { value: v });
  return n;
};
const isTrue = (v: string | undefined) => {
  const s = (v ?? "").trim().toLowerCase();
  return s === "1" || s === "true";
};

(async () => {
  const rpcUrl = process.env.OPTA_RPC_URL;
  if (!rpcUrl) die("OPTA_RPC_URL is required");

  const keypairPath = process.env.OPTA_CRANK_KEYPAIR
    ?? path.join(os.homedir(), ".config/solana/id.json");
  const keypair = loadKeypair(keypairPath);
  const connection = new Connection(rpcUrl!, "confirmed");
  const wallet = new anchor.Wallet(keypair);
  const hermesBase = process.env.OPTA_HERMES_BASE ?? "https://hermes.pyth.network";

  // DRY RUN defaults ON — an unset/garbage value must never mean "send".
  const dryRun = (process.env.OPTA_TRIGGER_DRY_RUN ?? "1").trim() !== "0";

  let shutdownRequested = false;
  const onSignal = (sig: string) => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    log("info", "shutdown requested", { signal: sig });
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  const ctx: TriggerCrankContext = {
    connection,
    wallet,
    hermesBase,
    log: (level, msg, fields) => log(level, msg, fields),
    shouldShutdown: () => shutdownRequested,
  };
  const options: TriggerCrankOptions = {
    tickOnce: isTrue(process.env.TICK_ONCE),
    dryRun,
    tickMs: numEnv("OPTA_TRIGGER_TICK_MS"),
    fireMarginBps: numEnv("OPTA_TRIGGER_FIRE_MARGIN_BPS"),
    feedStaleSecs: numEnv("OPTA_TRIGGER_FEED_STALE_SECS"),
  };

  const lamports = await connection.getBalance(wallet.publicKey).catch(() => 0);
  log("info", "trigger keeper boot", {
    wallet: wallet.publicKey.toBase58(),
    sol: +(lamports / 1e9).toFixed(4),
    rpc: rpcUrl!.replace(/api-key=[^&]+/, "api-key=<redacted>"),
    sbEnabled: isTrue(process.env.OPTA_TRIGGER_SB_ENABLED),
    dryRun,
    tickOnce: options.tickOnce ?? false,
  });
  if (lamports === 0) log("warn", "keeper wallet has zero SOL — fires will fail", {});

  await runTriggerCrank(ctx, options);
  log("info", "trigger keeper exited cleanly", {});
})().catch((err) => {
  log("fatal", "trigger keeper crashed", { err: String(err), stack: (err as any)?.stack });
  process.exit(1);
});
