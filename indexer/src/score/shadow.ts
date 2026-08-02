// =============================================================================
// shadow.ts — SHADOW MODE output. Appends to shadow.md, mirrors opta-tweet's
// shadow lane. No API, no frontend, nothing user-visible in Phase 1.
// =============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

import type { DB } from "../db";
import { isInternal, labelFor } from "../registry";
import { DEFAULT_QUESTS } from "./quests/evaluator";
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

  L.push(...renderPhase2a(result));

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

const usd = (micro: number | bigint) => `$${(Number(micro) / 1e6).toFixed(2)}`;
const short = (w: string) => `${w.slice(0, 6)}…${w.slice(-4)}`;

/** Phase 2a sections: 5 boards, chain funnel, multipliers, provenance, PnL. */
function renderPhase2a(r: RecomputeResult): string[] {
  const L: string[] = [];
  const ext = (w: string) => !isInternal(w);
  const metrics = [...r.pnl.byWallet.values()].filter((m) => ext(m.wallet));

  // ---- 1. RECONCILIATION — the number, whatever it is --------------------
  const rec = r.pnl.reconciliation;
  L.push("### PnL reconciliation");
  L.push("");
  L.push("`[W] wallets + [V] vaults + [F] treasury + [U] unattributed == 0`");
  L.push("");
  L.push(
    "Every tape event is a transfer between wallets, vault PDAs, and the treasury, " +
      "so the books must close exactly. [U] is a NAMED term: HoldersFinalized / " +
      "WritersFinalized carry only aggregate totals, so those dollars land in wallets " +
      "the tape cannot identify.",
  );
  L.push("");
  L.push("| term | value |");
  L.push("|---|---:|");
  L.push(`| [W] wallets net | ${usd(rec.walletNet)} |`);
  L.push(`| [V] vault balances | ${usd(rec.vaultBalance)} |`);
  L.push(`| [F] fees + dust to treasury | ${usd(rec.fees)} |`);
  L.push(`| [U] unattributed batch payouts | ${usd(rec.unattributedPayouts)} |`);
  L.push(`| **residual (W+V+F+U)** | **${usd(rec.residual)}** |`);
  L.push(`| Σ\\|flows\\| | ${usd(rec.grossFlows)} |`);
  L.push(`| **residual / Σ\\|flows\\|** | **${(rec.residualRatio * 100).toFixed(4)}%** |`);
  L.push(`| Σ realized_pnl | ${usd(rec.totalRealizedPnl)} |`);
  L.push(`| vault balance not attributable to a depositor | ${usd(rec.unattributedVaultBalance)} |`);
  L.push("");
  L.push(
    rec.residual === 0n
      ? "Identity balances exactly."
      : "_Non-zero residual is reported as-is. It is a measurement, not a tolerance to tune._",
  );
  L.push("");

  // ---- 2. PROFIT board ---------------------------------------------------
  L.push("### Board 1 — Profit (ROI, faucet-funded only)");
  L.push("");
  const eligible = metrics
    .filter((m) => r.provenance.get(m.wallet)?.eligible)
    .map((m) => ({ m, p: r.provenance.get(m.wallet)! }))
    .sort((a, b) => {
      const ra = Number(a.m.realizedPnl) / Math.max(1, a.p.faucetIn);
      const rb = Number(b.m.realizedPnl) / Math.max(1, b.p.faucetIn);
      return rb - ra || (a.m.wallet < b.m.wallet ? -1 : 1);
    });
  if (eligible.length === 0) {
    L.push("_no eligible wallets_");
  } else {
    L.push("| # | wallet | realized PnL | deployed | faucet in | ROI |");
    L.push("|---:|---|---:|---:|---:|---:|");
    eligible.slice(0, 20).forEach((e, i) => {
      const roi = e.p.faucetIn > 0 ? Number(e.m.realizedPnl) / e.p.faucetIn : 0;
      L.push(
        `| ${i + 1} | \`${short(e.m.wallet)}\` | ${usd(e.m.realizedPnl)} | ${usd(e.m.deployed)} | ${usd(e.p.faucetIn)} | ${(roi * 100).toFixed(2)}% |`,
      );
    });
  }
  L.push("");
  const excluded = metrics.filter((m) => !r.provenance.get(m.wallet)?.eligible);
  L.push(`**Excluded from the profit board (${excluded.length})** — reason recorded, never silent:`);
  L.push("");
  L.push("| wallet | reason |");
  L.push("|---|---|");
  for (const m of excluded.slice(0, 25)) {
    L.push(`| \`${short(m.wallet)}\` | ${r.provenance.get(m.wallet)?.ineligibleReason ?? "unknown"} |`);
  }
  L.push("");

  // ---- 3. VOLUME + 4. WRITER --------------------------------------------
  L.push("### Board 2 — Volume");
  L.push("");
  L.push("| # | wallet | premium traded |");
  L.push("|---:|---|---:|");
  [...metrics]
    .sort((a, b) => Number(b.volumeUsdc - a.volumeUsdc) || (a.wallet < b.wallet ? -1 : 1))
    .slice(0, 10)
    .forEach((m, i) => L.push(`| ${i + 1} | \`${short(m.wallet)}\` | ${usd(m.volumeUsdc)} |`));
  L.push("");

  L.push("### Board 3 — Writer (premium earned)");
  L.push("");
  L.push("| # | wallet | premium earned |");
  L.push("|---:|---|---:|");
  const writers = [...metrics]
    .filter((m) => m.writerPremium > 0n)
    .sort((a, b) => Number(b.writerPremium - a.writerPremium) || (a.wallet < b.wallet ? -1 : 1));
  if (writers.length === 0) L.push("| — | _none_ | — |");
  writers.slice(0, 10).forEach((m, i) => L.push(`| ${i + 1} | \`${short(m.wallet)}\` | ${usd(m.writerPremium)} |`));
  L.push("");

  // ---- 5. REFERRALS + 6. SOCIAL (empty until Phase 2b) ------------------
  L.push("### Board 4 — Referrals");
  L.push("");
  L.push(
    `_write path is Phase 2b; table currently holds ${r.referrals.bound} bindings, ${r.referrals.activated} activated_`,
  );
  L.push("");
  L.push("### Board 5 — Social");
  L.push("");
  L.push("_write path is Phase 2b; table empty_");
  L.push("");

  // ---- Chain funnel ------------------------------------------------------
  L.push("### Onboarding chain funnel (external wallets)");
  L.push("");
  // Read the steps from the catalog, never a local copy — D16 moved O5 out of
  // the chain and a hardcoded 7-step list would have silently mislabelled every
  // row below it.
  const steps = DEFAULT_QUESTS.chain.map((q) => `${q.id} ${q.name}`);
  const reached = new Array(steps.length + 1).fill(0);
  for (const [w, step] of r.quests.funnel) {
    if (!ext(w)) continue;
    for (let i = 1; i <= step; i++) reached[i] += 1;
  }
  L.push("| step | wallets |");
  L.push("|---|---:|");
  steps.forEach((s, i) => L.push(`| ${s} | ${reached[i + 1]} |`));
  const complete = [...r.quests.funnel.entries()].filter(([w, s]) => ext(w) && s === steps.length).length;
  L.push(`| **chain complete** | **${complete}** |`);
  L.push("");

  // Standalone bonuses sit outside the funnel by construction (D16), so the
  // funnel table above cannot show them. Count them from the completions.
  const bonusIds = DEFAULT_QUESTS.bonuses.flatMap((b) => [b.id, ...(b.bonus ? [b.bonus.id] : [])]);
  L.push("| standalone bonus | wallets |");
  L.push("|---|---:|");
  for (const id of bonusIds) {
    const n = new Set(r.quests.completions.filter((c) => c.questId === id && ext(c.wallet)).map((c) => c.wallet)).size;
    L.push(`| ${id} | ${n} |`);
  }
  L.push("");

  // ---- Multiplier distribution ------------------------------------------
  L.push("### Multiplier distribution (external)");
  L.push("");
  const dist = new Map<string, number>();
  for (const [w, st] of r.multipliers.state) {
    if (!ext(w)) continue;
    const k = st.multiplier.toFixed(1);
    dist.set(k, (dist.get(k) ?? 0) + 1);
  }
  L.push("| multiplier | wallets |");
  L.push("|---:|---:|");
  for (const k of [...dist.keys()].sort()) L.push(`| ${k}× | ${dist.get(k)} |`);
  if (dist.size === 0) L.push("| — | 0 |");
  const shieldsEarned = r.multipliers.shieldEvents.filter((e) => e.action === "earned" && ext(e.wallet)).length;
  const shieldsUsed = r.multipliers.shieldEvents.filter((e) => e.action === "consumed" && ext(e.wallet)).length;
  L.push("");
  L.push(`Shields — earned ${shieldsEarned}, consumed ${shieldsUsed}.`);
  L.push("");

  // ---- Provenance --------------------------------------------------------
  L.push("### Capital provenance");
  L.push("");
  L.push(
    `Faucet claims on record: **${r.faucetClaimCount}** across **${r.faucetClaimWallets}** wallets. Markets known: ${r.marketsKnown}.`,
  );
  L.push("");
  L.push("| wallet | faucet in | external in | external out | % faucet |");
  L.push("|---|---:|---:|---:|---:|");
  const prov = [...r.provenance.values()]
    .filter((p) => ext(p.wallet) && (p.faucetIn > 0 || p.externalIn > 0 || p.externalOut > 0))
    .sort((a, b) => b.faucetIn - a.faucetIn || (a.wallet < b.wallet ? -1 : 1));
  if (prov.length === 0) L.push("| _no capital flows indexed_ | — | — | — | — |");
  for (const p of prov.slice(0, 25)) {
    L.push(
      `| \`${short(p.wallet)}\` | ${usd(p.faucetIn)} | ${usd(p.externalIn)} | ${usd(p.externalOut)} | ${p.pctFaucet == null ? "—" : (p.pctFaucet * 100).toFixed(1) + "%"} |`,
    );
  }
  L.push("");

  return L;
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
