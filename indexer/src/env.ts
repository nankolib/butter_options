// =============================================================================
// env.ts — config load + validation
// =============================================================================
//
// All knobs are env-tunable with conservative defaults (D6). The RPC URL is the
// same private endpoint the crank uses (`OPTA_RPC_URL` in the box's .env); it is
// NEVER logged.
// =============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

export interface Config {
  rpcUrl: string;
  programId: string;
  dbPath: string;
  shadowPath: string;
  idlPath: string;
  /** Unix seconds. Backfill walks signatures back to this floor, then stops. */
  backfillFloor: number;
  /** Live-tail tick interval (ms). */
  tickMs: number;
  /** getTransaction calls per JSON-RPC batch. */
  batchSize: number;
  /** JSON-RPC requests per second (batches, not individual txs). */
  rps: number;
  /** Hourly shadow render interval (ms). */
  shadowMs: number;

  // ---- Phase 2a ----------------------------------------------------------
  /**
   * Devnet USDC mint. Read from CONFIG, never from prose — the canonical value
   * is in app/src/utils/constants.ts and app/api/faucet.ts. main.ts asserts it
   * on chain at boot, because a one-character-wrong mint yields an empty,
   * entirely plausible-looking provenance tape.
   */
  usdcMint: string;
  /** Server-side faucet wallet (payer + authority for every claim). */
  faucetWallet: string;
  /** D9 hard cap on per-ATA polling. Overflow is logged, never silent. */
  ataMax: number;
  /** External-flow / markets refresh interval (ms). */
  capitalTickMs: number;
  marketsRefreshMs: number;
}

function req(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

function num(name: string, dflt: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return dflt;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Env ${name} is not a number: ${raw}`);
  return n;
}

/** Default IDL location: the copy made self-contained by scripts/copy-idl.js. */
function defaultIdlPath(): string {
  const bundled = path.resolve(__dirname, "../idl/opta.json");
  if (fs.existsSync(bundled)) return bundled;
  // dist/ layout: dist/src/env.js -> ../../idl/opta.json
  return path.resolve(__dirname, "../../idl/opta.json");
}

export function loadConfig(): Config {
  const stateDir = process.env.OPTA_INDEXER_STATE_DIR?.trim() || "/opt/opta-indexer";
  return {
    rpcUrl: req("OPTA_RPC_URL"),
    programId: process.env.OPTA_PROGRAM_ID?.trim() || "CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq",
    dbPath: process.env.OPTA_INDEXER_DB?.trim() || path.join(stateDir, "points.db"),
    shadowPath: process.env.OPTA_INDEXER_SHADOW?.trim() || path.join(stateDir, "shadow.md"),
    idlPath: process.env.OPTA_INDEXER_IDL?.trim() || defaultIdlPath(),
    // 2026-07-01T00:00:00Z
    backfillFloor: num("OPTA_INDEXER_BACKFILL_FLOOR", 1782864000),
    tickMs: num("OPTA_INDEXER_TICK_MS", 60_000),
    batchSize: num("OPTA_INDEXER_BATCH_SIZE", 10),
    rps: num("OPTA_INDEXER_RPS", 5),
    shadowMs: num("OPTA_INDEXER_SHADOW_MS", 3_600_000),

    // Phase 2a. Defaults are the verified canonical values; env can override.
    usdcMint: process.env.OPTA_USDC_MINT?.trim() || "AytU5HUQRew9VdUdrzQuZvZ7s14pHLiYjAF5WqdK3oxL",
    faucetWallet: process.env.OPTA_FAUCET_WALLET?.trim() || "J8Kct5tS5SvbmNj8fiuND94D4ZL5Cvip1MXsJLFRpEPz",
    ataMax: num("OPTA_INDEXER_ATA_MAX", 500),
    capitalTickMs: num("OPTA_INDEXER_CAPITAL_TICK_MS", 600_000),
    marketsRefreshMs: num("OPTA_INDEXER_MARKETS_MS", 1_800_000),
  };
}
