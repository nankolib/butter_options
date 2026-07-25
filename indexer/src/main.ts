// =============================================================================
// opta-indexer — tape + points engine. PHASE 1: SHADOW MODE.
// =============================================================================
//
// WHAT THIS IS
//   A single-process, in-DB-file indexer for the Opta program on devnet. It
//   maintains two strictly separated layers:
//
//     TAPE   immutable indexed facts (txs, events). Append-only, never
//            rewritten. Deterministic row ids make re-indexing a no-op.
//     SCORE  a PURE recomputable function over the tape (score/rules_v1.ts),
//            versioned. Rules change -> full recompute -> identical result on
//            an identical tape.
//
// WHAT IT IS NOT (Phase 1)
//   No API. No frontend. No on-chain writes. Nothing user-visible. The only
//   output is an hourly append to shadow.md.
//
// EVENT SOURCES
//   An EXPLICIT hand-written allowlist (tape/allowlist.ts) — NOT scaffolded
//   from the IDL, which carries 9 dead v1 event structs (incl. MarketSettled)
//   with zero emit! sites. Plus 3 ix-decoded instructions that emit nothing at
//   all (tape/ixDecode.ts): settle_expiry, create_market,
//   reclaim_writer_ask_residual.
//
// NON-THROWING BY CONSTRUCTION
//   Per-tx failures log + skip. A tick that throws logs and waits for the next
//   one. The loop does not die. (Same property as crank/settlementArchive.ts.)
// =============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

import { loadConfig } from "./env";
import { log } from "./log";
import { eventCount, openDb, txCount } from "./db";
import { readCursor } from "./tape/cursor";
import { EventDecoder } from "./tape/eventDecode";
import { Poller } from "./tape/poller";
import { RpcClient } from "./tape/rpc";
import { recompute } from "./score/recompute";
import { RULES_VERSION } from "./score/rules_v1";
import { appendShadow, collectTapeStats, renderShadow } from "./score/shadow";
import { SCHEMA_VERSION } from "./schema";

function readCommit(): string {
  for (const rel of ["../../.git", "../../../.git"]) {
    try {
      const gitDir = path.resolve(__dirname, rel);
      const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
      if (head.startsWith("ref: ")) {
        return fs.readFileSync(path.join(gitDir, head.slice(5)), "utf8").trim().slice(0, 7);
      }
      return head.slice(0, 7);
    } catch {
      /* try next */
    }
  }
  return process.env.OPTA_INDEXER_COMMIT?.trim() || "unknown";
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const idl = JSON.parse(fs.readFileSync(cfg.idlPath, "utf8"));
  const decoder = new EventDecoder(idl);
  const rpc = new RpcClient(cfg.rpcUrl, Math.max(1, Math.floor(1000 / Math.max(1, cfg.rps))));
  const poller = new Poller(db, rpc, decoder, cfg);

  const boot = readCursor(db);
  // RULE 1 boot marker — first line on stdout, asserted at deploy time.
  log.boot({
    commit: readCommit(),
    schemaVersion: SCHEMA_VERSION,
    rulesVersion: RULES_VERSION,
    cursor: boot.cursorSig,
    backfillDone: boot.backfillDone,
  });

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    log.info("shutdown requested");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);

  // ---- Backfill (resumable) ------------------------------------------------
  if (!boot.backfillDone) {
    const t0 = Date.now();
    log.info("backfill starting", {
      floor: new Date(cfg.backfillFloor * 1000).toISOString(),
      batchSize: cfg.batchSize,
      rps: cfg.rps,
    });
    try {
      const stats = await poller.backfill();
      log.info("backfill finished", {
        durationSec: Math.round((Date.now() - t0) / 1000),
        ...stats,
        txsTotal: txCount(db),
        eventsTotal: eventCount(db),
      });
    } catch (e) {
      log.error("backfill aborted — will resume next boot", { err: (e as Error).message });
    }
  }

  // ---- Shadow render -------------------------------------------------------
  const renderOnce = () => {
    try {
      const asOf = Math.floor(Date.now() / 1000);
      const result = recompute(db, asOf);
      const stats = collectTapeStats(db);
      appendShadow(cfg.shadowPath, renderShadow(stats, result, process.memoryUsage().rss));
      log.info("shadow rendered", {
        external: result.externalCount,
        internal: result.internalCount,
        rssMb: +(process.memoryUsage().rss / 1048576).toFixed(1),
      });
    } catch (e) {
      log.error("shadow render failed", { err: (e as Error).message });
    }
  };

  renderOnce(); // first render immediately after backfill
  let lastShadow = Date.now();

  // ---- Live tail -----------------------------------------------------------
  log.info("entering live tail", { tickMs: cfg.tickMs });
  while (!stopping) {
    try {
      const stats = await poller.tail();
      if (stats.txsIndexed > 0 || stats.fetchFailures > 0) {
        log.info("tick", { ...stats, txsTotal: txCount(db), eventsTotal: eventCount(db) });
      }
    } catch (e) {
      log.error("tick failed", { err: (e as Error).message });
    }

    if (Date.now() - lastShadow >= cfg.shadowMs) {
      renderOnce();
      lastShadow = Date.now();
    }

    for (let waited = 0; waited < cfg.tickMs && !stopping; waited += 500) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  db.close();
  log.info("stopped cleanly");
}

main().catch((e) => {
  log.error("fatal", { err: (e as Error).message, stack: (e as Error).stack });
  process.exit(1);
});
