// =============================================================================
// shadow.ts — SHADOW MODE output. Appends to shadow.md, mirrors opta-tweet's
// shadow lane. No API, no frontend, nothing user-visible in Phase 1.
// =============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

import type { DB } from "../db";
import { isInternal, labelFor } from "../registry";
import type { RecomputeResult } from "./recompute";

export interface TapeStats {
  txs: number;
  txsOk: number;
  txsTruncated: number;
  events: number;
  histogram: { name: string; n: number }[];
  uniqueExternal: number;
  uniqueInternal: number;
  firstBlockTime: number | null;
  lastBlockTime: number | null;
  backfillDone: boolean;
  cursorSig: string | null;
}

export function collectTapeStats(db: DB): TapeStats {
  const one = <T>(sql: string): T => db.prepare(sql).get() as T;

  const t = one<{ n: number; ok: number; trunc: number; lo: number | null; hi: number | null }>(
    `SELECT COUNT(*) AS n,
            COALESCE(SUM(ok), 0) AS ok,
            COALESCE(SUM(truncated), 0) AS trunc,
            MIN(block_time) AS lo,
            MAX(block_time) AS hi
     FROM txs`,
  );
  const e = one<{ n: number }>("SELECT COUNT(*) AS n FROM events");
  const histogram = db
    .prepare("SELECT name, COUNT(*) AS n FROM events GROUP BY name ORDER BY n DESC, name ASC")
    .all() as { name: string; n: number }[];
  const w = one<{ ext: number; int: number }>(
    "SELECT SUM(CASE WHEN is_internal = 0 THEN 1 ELSE 0 END) AS ext, SUM(is_internal) AS int FROM wallets",
  );
  const meta = (k: string) =>
    (db.prepare("SELECT value FROM meta WHERE key = ?").get(k) as { value: string } | undefined)?.value ?? null;

  return {
    txs: t.n,
    txsOk: t.ok,
    txsTruncated: t.trunc,
    events: e.n,
    histogram,
    uniqueExternal: w.ext ?? 0,
    uniqueInternal: w.int ?? 0,
    firstBlockTime: t.lo,
    lastBlockTime: t.hi,
    backfillDone: meta("backfill_done") === "1",
    cursorSig: meta("cursor_sig"),
  };
}

const iso = (ts: number | null) => (ts == null ? "—" : new Date(ts * 1000).toISOString());

/** Render one shadow block. PURE — `asOf` and `rss` are injected. */
export function renderShadow(stats: TapeStats, result: RecomputeResult, rssBytes: number): string {
  const L: string[] = [];
  const spanDays =
    stats.firstBlockTime && stats.lastBlockTime
      ? Math.max(1, (stats.lastBlockTime - stats.firstBlockTime) / 86400)
      : 1;

  L.push(`## ${new Date(result.asOf * 1000).toISOString()} · rules ${result.rulesVersion}`);
  L.push("");
  L.push("### Tape");
  L.push("");
  L.push("| metric | value |");
  L.push("|---|---:|");
  L.push(`| txs indexed | ${stats.txs} |`);
  L.push(`| txs ok | ${stats.txsOk} |`);
  L.push(`| txs log-truncated | ${stats.txsTruncated} |`);
  L.push(`| events | ${stats.events} |`);
  L.push(`| span | ${iso(stats.firstBlockTime)} → ${iso(stats.lastBlockTime)} |`);
  L.push(`| tx/day (observed) | ${(stats.txs / spanDays).toFixed(0)} |`);
  L.push(`| unique wallets — external | ${stats.uniqueExternal} |`);
  L.push(`| unique wallets — internal | ${stats.uniqueInternal} |`);
  L.push(`| backfill complete | ${stats.backfillDone} |`);
  L.push(`| RSS | ${(rssBytes / 1024 / 1024).toFixed(1)} MB |`);
  L.push("");

  L.push("### Event histogram");
  L.push("");
  L.push("| event | count |");
  L.push("|---|---:|");
  for (const h of stats.histogram) L.push(`| ${h.name} | ${h.n} |`);
  L.push("");

  L.push("### Leaderboard — top 20 (external only)");
  L.push("");
  const external = result.scores.filter((s) => !isInternal(s.wallet)).slice(0, 20);
  if (external.length === 0) {
    L.push("_no external wallets scored yet_");
  } else {
    L.push("| # | wallet | points | capped | breakdown |");
    L.push("|---:|---|---:|---:|---|");
    external.forEach((s, i) => {
      const bd = Object.entries(s.breakdown)
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      L.push(`| ${i + 1} | \`${s.wallet}\` | ${s.points} | ${s.pointsCapped} | ${bd} |`);
    });
  }
  L.push("");

  L.push("### Sanity — internal wallets (EXCLUDED from leaderboard)");
  L.push("");
  const internal = result.scores.filter((s) => isInternal(s.wallet));
  if (internal.length === 0) {
    L.push("_none scored_");
  } else {
    L.push("| label | wallet | points | capped |");
    L.push("|---|---|---:|---:|");
    for (const s of internal) {
      L.push(`| ${labelFor(s.wallet) ?? "?"} | \`${s.wallet}\` | ${s.points} | ${s.pointsCapped} |`);
    }
  }
  L.push("");

  L.push("### Diagnostics");
  L.push("");
  L.push("| metric | value | meaning |");
  L.push("|---|---:|---|");
  L.push(
    `| negativePositions | ${result.diagnostics.negativePositions} | (wallet,vault) pairs that went negative — invisible Token-2022 inflow (D4 blind spot) |`,
  );
  L.push(
    `| holderCountDelta | ${result.diagnostics.holderCountDelta} | Σ\\|derived holders − HoldersFinalized.holders_processed\\| over ${result.diagnostics.holderCountComparisons} settled vaults |`,
  );
  L.push(`| selfTradesZeroed | ${result.diagnostics.selfTradesZeroed} | maker == taker fills, scored 0 both sides |`);
  L.push(
    `| pegMakerCreditsSkipped | ${result.diagnostics.pegMakerCreditsSkipped} | kind==3 fills where maker is a PDA (D3 hard rule) |`,
  );
  L.push("");
  L.push("---");
  L.push("");

  return L.join("\n");
}

export function appendShadow(shadowPath: string, block: string): void {
  fs.mkdirSync(path.dirname(shadowPath), { recursive: true });
  if (!fs.existsSync(shadowPath)) {
    fs.writeFileSync(
      shadowPath,
      "# opta-indexer — SHADOW MODE\n\nPhase 1. Nothing here is user-visible. Rules are being tuned against a live tape.\n\n---\n\n",
    );
  }
  fs.appendFileSync(shadowPath, block);
}
