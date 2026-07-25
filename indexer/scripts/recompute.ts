// =============================================================================
// scripts/recompute.ts — one-shot recompute + leaderboard print
// =============================================================================
//
// Two uses:
//   1. Ops: rebuild SCORE after a rules change without touching the tape.
//        node dist/scripts/recompute.js
//   2. Determinism check: run twice on a frozen tape and diff the output.
//        node dist/scripts/recompute.js --json > a.json
//        node dist/scripts/recompute.js --json > b.json && diff a.json b.json
//
// `--as-of <unix>` pins the timestamp so the JSON is byte-comparable (asOf is
// the ONLY impure input to the score layer).
// =============================================================================

import { loadConfig } from "../src/env";
import { openDb } from "../src/db";
import { recompute } from "../src/score/recompute";
import { isInternal } from "../src/registry";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

function main(): void {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  // Default to NOW. Defaulting to 0 wrote computed_at=0 into `scores`, which the
  // API then reported as the freshness stamp — running the ops recompute command
  // made every response look like it was computed at the epoch.
  const asOfArg = arg("--as-of");
  const asOf = asOfArg != null ? Number(asOfArg) : Math.floor(Date.now() / 1000);
  const result = recompute(db, asOf);

  if (process.argv.includes("--json")) {
    // Stable key order; asOf pinned by the caller. Byte-comparable across runs.
    process.stdout.write(
      JSON.stringify(
        {
          rulesVersion: result.rulesVersion,
          asOf: result.asOf,
          diagnostics: result.diagnostics,
          scores: result.scores.map((s) => ({
            wallet: s.wallet,
            points: s.points,
            pointsCapped: s.pointsCapped,
            internal: isInternal(s.wallet),
            breakdown: s.breakdown,
          })),
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    console.log(`rules=${result.rulesVersion} external=${result.externalCount} internal=${result.internalCount}`);
    for (const s of result.scores.filter((x) => !isInternal(x.wallet)).slice(0, 20)) {
      console.log(`${s.pointsCapped.toFixed(4).padStart(14)}  ${s.wallet}`);
    }
    console.log("diagnostics:", JSON.stringify(result.diagnostics));
  }
  db.close();
}

main();
