// =============================================================================
// env.ts — configuration + kill switches, parsed once at boot (fail-fast)
// =============================================================================
// Mirrors the writer's env discipline: required vars fail-fast, secrets are file
// paths (never inline), RPC redacted in logs.
//
// THE TWO SWITCHES ARE NOT THE SAME THING and both default to the safe side:
//   OPTA_TAKER_DRY_RUN=1 (default)   evaluate everything, send nothing
//   OPTA_TAKER_ARMED=0   (default)   the second, independent consent
// A fill requires DRY_RUN=0 AND ARMED=1. One flag would mean one typo, or one
// stale unit file, is all that stands between shadow mode and live treasury
// spend — two flags that must disagree with their defaults simultaneously
// cannot be tripped by accident.
// =============================================================================

import * as fs from "fs";
import * as path from "path";
import { Keypair, PublicKey } from "@solana/web3.js";

export interface TakerConfig {
  rpcUrl: string;
  idlPath: string;
  dbPath: string;
  wallet: Keypair;

  // --- consent ---
  dryRun: boolean;
  armed: boolean;

  // --- the band (bps of discount to model fair value) ---
  minDiscountBps: number;
  maxDiscountBps: number;

  // --- budgets (human USDC) ---
  maxPerWalletDayUsdc: number;
  maxGlobalDayUsdc: number;
  maxFloatUsdc: number;
  maxFillUsdc: number;

  // --- timing ---
  minDelaySecs: number;
  maxDelaySecs: number;
  minTteSecs: number;
  tickMs: number;

  /** Fee-payer for the read-only get_option_price simulation (sigVerify:false). */
  simPayer: PublicKey | null;
  lowBalanceWarnSol: number;
}

const bool = (v: string | undefined, dflt: boolean): boolean => {
  if (v === undefined || v === "") return dflt;
  return v === "1" || v.toLowerCase() === "true";
};
const num = (v: string | undefined, dflt: number): number => {
  if (v === undefined || v === "") return dflt;
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
};

export const redactRpc = (u: string): string => u.replace(/([?&]api-key=)[^&]*/i, "$1<redacted>");

function die(msg: string): never {
  console.error(JSON.stringify({ ev: "fatal", msg }));
  process.exit(1);
}

function loadKeypair(p: string): Keypair {
  let raw: string;
  try {
    raw = fs.readFileSync(p, "utf-8");
  } catch {
    die(`OPTA_TAKER_KEYPAIR file not readable: ${p}`);
  }
  let arr: number[];
  try {
    arr = JSON.parse(raw);
  } catch {
    die(`OPTA_TAKER_KEYPAIR is not a JSON byte array: ${p}`);
  }
  if (!Array.isArray(arr) || arr.length !== 64) {
    die(`OPTA_TAKER_KEYPAIR must be a 64-byte array (got ${Array.isArray(arr) ? arr.length : "non-array"})`);
  }
  try {
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  } catch {
    die(`OPTA_TAKER_KEYPAIR bytes are not a valid secret key: ${p}`);
  }
}

function parseSimPayer(v: string | undefined): PublicKey | null {
  if (!v || !v.trim()) return null;
  try {
    return new PublicKey(v.trim());
  } catch {
    die(`OPTA_TAKER_SIM_PAYER is not a valid pubkey: ${v}`);
  }
}

export function loadConfig(): TakerConfig {
  const rpcUrl = process.env.OPTA_RPC_URL || die("OPTA_RPC_URL is required");
  const kpPath = process.env.OPTA_TAKER_KEYPAIR || die("OPTA_TAKER_KEYPAIR is required (file path, never inline)");
  const wallet = loadKeypair(kpPath);

  // Candidates, in order. TWO layouts must both work: ts-node from src/
  // (__dirname = taker/src) and the built tree (__dirname = dist/taker/src —
  // one level deeper, because rootDir is the repo root so the indexer registry
  // compiles in). A single "../idl" resolves correctly in exactly one of them.
  const idlCandidates = [
    path.resolve(__dirname, "../idl/opta.json"),          // ts-node: taker/idl
    path.resolve(__dirname, "../../../idl/opta.json"),    // built:   taker/idl
    path.resolve(__dirname, "../../app/src/idl/opta.json"), // local dev tree
  ];
  const idlPath = process.env.OPTA_TAKER_IDL || idlCandidates.find((p) => fs.existsSync(p)) || idlCandidates[0];
  if (!fs.existsSync(idlPath)) {
    die(`IDL not found (set OPTA_TAKER_IDL). Tried: ${idlCandidates.join(", ")}`);
  }

  const cfg: TakerConfig = {
    rpcUrl,
    idlPath,
    dbPath: process.env.OPTA_TAKER_DB || "/opt/opta-taker/taker.db",
    wallet,

    dryRun: bool(process.env.OPTA_TAKER_DRY_RUN, true), // safe side
    armed: bool(process.env.OPTA_TAKER_ARMED, false),   // safe side

    minDiscountBps: num(process.env.OPTA_TAKER_MIN_DISCOUNT_BPS, 500),
    maxDiscountBps: num(process.env.OPTA_TAKER_MAX_DISCOUNT_BPS, 5000),

    maxPerWalletDayUsdc: num(process.env.OPTA_TAKER_MAX_WALLET_DAY_USDC, 250),
    maxGlobalDayUsdc: num(process.env.OPTA_TAKER_MAX_GLOBAL_DAY_USDC, 2000),
    maxFloatUsdc: num(process.env.OPTA_TAKER_MAX_FLOAT_USDC, 10_000),
    maxFillUsdc: num(process.env.OPTA_TAKER_MAX_FILL_USDC, 100),

    minDelaySecs: num(process.env.OPTA_TAKER_MIN_DELAY_SECS, 30),
    maxDelaySecs: num(process.env.OPTA_TAKER_MAX_DELAY_SECS, 180),
    minTteSecs: num(process.env.OPTA_TAKER_MIN_TTE_SECS, 24 * 3600),
    tickMs: Math.max(5_000, num(process.env.OPTA_TAKER_TICK_MS, 60_000)),

    simPayer: parseSimPayer(process.env.OPTA_TAKER_SIM_PAYER),
    lowBalanceWarnSol: num(process.env.OPTA_TAKER_LOW_BALANCE_WARN_SOL, 1.0),
  };

  // A band whose lower bound sits above its upper accepts NOTHING while looking
  // configured. Refuse to boot rather than run a silently inert bot.
  if (cfg.minDiscountBps >= cfg.maxDiscountBps) {
    die(`band is empty: MIN_DISCOUNT_BPS (${cfg.minDiscountBps}) must be < MAX_DISCOUNT_BPS (${cfg.maxDiscountBps})`);
  }
  if (cfg.minDelaySecs > cfg.maxDelaySecs) {
    die(`MIN_DELAY_SECS (${cfg.minDelaySecs}) must be <= MAX_DELAY_SECS (${cfg.maxDelaySecs})`);
  }
  // Per-fill above the daily wallet cap is not an error, but it does mean the
  // per-fill cap can never bind — say so rather than let it look enforced.
  if (cfg.maxFillUsdc > cfg.maxPerWalletDayUsdc) {
    console.error(JSON.stringify({
      ev: "config-warn",
      msg: `MAX_FILL_USDC (${cfg.maxFillUsdc}) exceeds MAX_WALLET_DAY_USDC (${cfg.maxPerWalletDayUsdc}); the wallet cap binds first`,
    }));
  }
  return cfg;
}
