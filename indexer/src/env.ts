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
  };
}
