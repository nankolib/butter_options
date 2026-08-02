// =============================================================================
// scripts/recompute.ts — one-shot recompute + leaderboard print
// =============================================================================
//
// Two uses:
//   1. Ops: rebuild SCORE after a rules change without touching the tape.
//        node dist/scripts/recompute.js
//   2. Determinism check: run twice on a frozen tape and diff the output.
//        node dist/scripts/recompute.js --json --as-of 1785685388 > a.json
//        node dist/scripts/recompute.js --json --as-of 1785685388 > b.json
//        diff a.json b.json
//
// `--as-of <unix>` pins the timestamp so the JSON is byte-comparable (asOf is
// the ONLY impure input to the score layer).
//
// THE --json PAYLOAD COVERS THE WHOLE SCORED SURFACE.
//   It used to emit rulesVersion / asOf / diagnostics / scores and nothing else,
//   so the "determinism check" would have passed unchanged while the quest
//   catalog, the multiplier ladder, the referral schedule or the final totals
//   moved underneath it — the harness could not see the layers most likely to be
//   edited. Quests, multipliers, shields, referrals and finalPoints are all in
//   the hash now. Adding a scored layer means adding it here too.
// =============================================================================

import { loadConfig } from "../src/env";
import { logToStderr } from "../src/log";
import { openDb } from "../src/db";
import { recompute } from "../src/score/recompute";
import { QUESTS_VERSION } from "../src/score/quests/evaluator";
import { isInternal } from "../src/registry";

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

/** Drain a Map to a plain object through an explicit key sort — never insertion order. */
function sortedObject<V>(m: ReadonlyMap<string, V>): Record<string, V> {
  const out: Record<string, V> = {};
  for (const k of [...m.keys()].sort()) out[k] = m.get(k)!;
  return out;
}

function main(): void {
  // stdout is the payload in --json mode; the log stream must not share it.
  // A one-time schema-migration line on the first of three runs is enough to
  // make the harness report drift that is not there.
  if (process.argv.includes("--json")) logToStderr();

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
          questsVersion: QUESTS_VERSION,
          asOf: result.asOf,
          externalCount: result.externalCount,
          internalCount: result.internalCount,
          diagnostics: result.diagnostics,
          scores: result.scores.map((s) => ({
            wallet: s.wallet,
            points: s.points,
            pointsCapped: s.pointsCapped,
            internal: isInternal(s.wallet),
            breakdown: s.breakdown,
            perDay: s.perDay,
          })),
          quests: {
            totals: sortedObject(result.quests.totals),
            funnel: sortedObject(result.quests.funnel),
            completions: result.quests.completions,
          },
          multipliers: {
            state: [...result.multipliers.state.keys()].sort().map((w) => result.multipliers.state.get(w)!),
            shieldEvents: result.multipliers.shieldEvents,
          },
          referrals: {
            bound: result.referrals.bound,
            activated: result.referrals.activated,
            bondPoints: sortedObject(result.referrals.bondPoints),
            commission: sortedObject(result.referrals.commission),
            capForfeited: sortedObject(result.referrals.capForfeited),
          },
          points: result.pointRows,
          faucetClaimCount: result.faucetClaimCount,
          faucetClaimWallets: result.faucetClaimWallets,
          marketsKnown: result.marketsKnown,
        },
        null,
        2,
      ) + "\n",
    );
  } else {
    console.log(
      `rules=${result.rulesVersion} quests=${QUESTS_VERSION} external=${result.externalCount} internal=${result.internalCount}`,
    );
    console.log("       final     base(x mult)      quests  wallet");
    for (const p of result.pointRows
      .filter((x) => !isInternal(x.wallet))
      .sort((a, b) => b.finalPoints - a.finalPoints || (a.wallet < b.wallet ? -1 : 1))
      .slice(0, 20)) {
      console.log(
        `${p.finalPoints.toFixed(4).padStart(12)}  ${p.baseMultiplied.toFixed(4).padStart(14)}  ${p.questPoints
          .toFixed(4)
          .padStart(10)}  ${p.wallet}`,
      );
    }
    console.log("diagnostics:", JSON.stringify(result.diagnostics));
  }
  db.close();
}

main();
