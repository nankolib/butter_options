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
import { CapitalPoller, emptyCapitalStats } from "./tape/capitalPoller";
import { refreshMarkets } from "./tape/marketsRefresh";
import { TokenAccountResolver } from "./tape/tokenAccounts";
import { recompute } from "./score/recompute";
import { RULES_VERSION } from "./score/rules_v1";
import { QUESTS_VERSION } from "./score/quests/evaluator";
import { appendShadow, collectTapeStats, renderShadow } from "./score/shadow";
import { SCHEMA_VERSION } from "./schema";
import { startApiServer } from "./api/server";
import { sweepNonces } from "./api/auth";

function readCommit(): string {
  // OPTA_INDEXER_COMMIT WINS over the enclosing repo's HEAD. The VPS deploy is a
  // surgical path-overlay (`git checkout <ref> -- indexer/`) into the opta-crank
  // checkout, so that checkout's HEAD is NOT the version of this code that is
  // running. Reporting it would make the boot marker confidently wrong.
  const pinned = process.env.OPTA_INDEXER_COMMIT?.trim();
  if (pinned) return pinned;

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
  return "unknown";
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const db = openDb(cfg.dbPath);
  const idl = JSON.parse(fs.readFileSync(cfg.idlPath, "utf8"));
  const decoder = new EventDecoder(idl);
  const rpc = new RpcClient(cfg.rpcUrl, Math.max(1, Math.floor(1000 / Math.max(1, cfg.rps))));
  const poller = new Poller(db, rpc, decoder, cfg);

  const resolver = new TokenAccountResolver(db, rpc);
  const capital = new CapitalPoller(db, rpc, cfg, resolver);

  // MINT ASSERT (B1). A one-character-wrong mint produces an empty, entirely
  // plausible-looking provenance tape, so verify it is a real SPL mint before
  // any provenance is indexed. Fail loudly at boot, never silently later.
  const mintInfo = await rpc
    .call<{ value: { owner?: string } | null }>("getAccountInfo", [
      cfg.usdcMint,
      { encoding: "base64", commitment: "confirmed" },
    ])
    .catch(() => null);
  const mintOwner = mintInfo?.value?.owner ?? null;
  if (mintOwner !== "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") {
    throw new Error(
      `Configured OPTA_USDC_MINT ${cfg.usdcMint} is not an SPL Token mint (owner=${mintOwner ?? "missing"}). ` +
        `Refusing to start — provenance would silently index nothing.`,
    );
  }

  const boot = readCursor(db);
  // RULE 1 boot marker — first line on stdout, asserted at deploy time.
  log.boot({
    commit: readCommit(),
    schemaVersion: SCHEMA_VERSION,
    rulesVersion: RULES_VERSION,
    questsVersion: QUESTS_VERSION,
    cursor: boot.cursorSig,
    backfillDone: boot.backfillDone,
    usdcMintOk: true,
  });

  // Loopback API. Started BEFORE the backfill so reads are available while a
  // long rebuild runs (they serve the previous recompute, with computed_at
  // telling the caller exactly how stale that is).
  const api = startApiServer(db, cfg);

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    api?.close();
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

  // ---- Part A: capital provenance + markets reference, before first render -
  const capitalTick = async () => {
    const stats = emptyCapitalStats();
    capital.resetCaches();
    try {
      await capital.faucetTick(stats);
    } catch (e) {
      log.error("faucet tick failed", { err: (e as Error).message });
    }
    try {
      await capital.ataTick(stats);
    } catch (e) {
      log.error("ata tick failed", { err: (e as Error).message });
    }
    log.info("capital tick", { ...stats });
  };

  await capitalTick();
  try {
    await refreshMarkets(db, rpc, cfg.programId);
  } catch (e) {
    log.error("markets refresh failed", { err: (e as Error).message });
  }

  renderOnce(); // first render after backfill + provenance + reference data
  let lastShadow = Date.now();
  let lastCapital = Date.now();
  let lastMarkets = Date.now();

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

    if (Date.now() - lastCapital >= cfg.capitalTickMs) {
      await capitalTick();
      lastCapital = Date.now();
    }
    if (Date.now() - lastMarkets >= cfg.marketsRefreshMs) {
      try {
        await refreshMarkets(db, rpc, cfg.programId);
      } catch (e) {
        log.error("markets refresh failed", { err: (e as Error).message });
      }
      lastMarkets = Date.now();
    }

    if (Date.now() - lastShadow >= cfg.shadowMs) {
      renderOnce();
      sweepNonces(db, Math.floor(Date.now() / 1000));
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
