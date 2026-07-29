// =============================================================================
// opta-writer — autonomous devnet market-maker for Opta.
// =============================================================================
// Keeps the whole board animated: for every live, quote-ready market it writes a
// canonical American series + a 0-pool vault and rests a WriterAsk, so each cell
// shows a price and fillable liquidity. Source-agnostic discovery (Monday's
// equities auto-join). Crypto/memes 24/7 on 08:00Z epochs; equity/ETF on CUSTOM
// vaults expiring Friday 19:45Z inside the NYSE session, gated by isMarketHours.
//
// Write-only: it posts and cancels asks, never fills — so the 6014 self-trade
// guard is unreachable. A future taker bot MUST use a separate wallet.
//
// KILL SWITCHES:
//   OPTA_WRITER_ENABLED=0  → soft: keep discovering + quoting + logging plans,
//                            post/reprice/cancel NOTHING (observe-only).
//   OPTA_WRITER_DRY_RUN=1   → same no-write behavior, for the canary preview.
//   systemctl stop opta-writer → hard.
//   OPTA_WRITER_ASSETS=SOL   → scope to an allow-list (canary).
//   OPTA_WRITER_MAX_CELLS=3  → cap NEW asks per run (canary).
//
// Config + all knobs: src/env.ts. Spec: repo Gate-1 sign-off + amendment.
// =============================================================================

import { loadConfig, redactRpc } from "./env";
import { initChain, getBalanceSol } from "./chain";
import { WriterEngine } from "./engine";
import { Heartbeat, log } from "./log";
import { HYST_FRAC, RUNG_FRAC, hystBand } from "./ladder";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const cfg = loadConfig();
  log.info("boot", {
    rpc: redactRpc(cfg.rpcUrl),
    wallet: cfg.wallet.publicKey.toBase58(),
    mode: cfg.dryRun ? "DRY-RUN" : cfg.enabled ? "LIVE" : "OBSERVE-ONLY",
    assets: cfg.assets ?? "all",
    // Surfaced so a full-board flip can be verified to still carry its hard
    // exclusions (denylist wins over the allow-list and survives assets=null).
    assetsExclude: cfg.assetsExclude.length ? cfg.assetsExclude : "none",
    excludeClasses: cfg.excludeClasses.length ? cfg.excludeClasses : "none",
    maxCellsThisRun: cfg.maxCellsThisRun || "uncapped",
    tickMs: cfg.tickMs,
    // RULE-1 build marker: the deployed churn-fix generation must be assertable
    // from the boot line alone. v1 shipped without one, so a hot-patch/stale
    // build could only be caught by inference from disk HEAD + live events.
    churnFix: "v2",
    hystFrac: HYST_FRAC,
    // Band is scale-free in v2 (HYST_FRAC x RUNG_FRAC x spot), so it is a flat
    // percentage of spot on every asset — quoted here at representative spots
    // so the deployed band is legible without re-deriving it.
    bandPctOfSpot: +(HYST_FRAC * RUNG_FRAC * 100).toFixed(3),
    bandAtBoot: Object.fromEntries(
      ([["BTC", 66658], ["ETH", 1926], ["SOL", 77.87], ["XRP", 1.1489], ["FARTCOIN", 0.13897], ["XAU", 4064]] as const)
        .map(([a, s]) => [a, +hystBand(s).toPrecision(4)]),
    ),
    // BID CONFIG — RULE-1 assertable from the boot line alone.
    //
    // Added because its absence hid a live no-op: on 2026-07-29
    // OPTA_WRITER_BID_ENABLED=1 was set and the writer ran an hour posting
    // nothing, because the DEPLOYED build predated the bid feature entirely. The
    // env var reached the process; the code that reads it did not exist. With the
    // flag echoed here, `bidEnabled` missing from the boot line means "this build
    // has no bid support", and `false` means "supported and off" — two states that
    // were previously indistinguishable from the log.
    bids: {
      enabled: cfg.bidEnabled,
      atmRungs: cfg.bidAtmRungs,
      maxCells: cfg.bidMaxCells || "uncapped",
      maxNotionalPerAsset: cfg.bidMaxNotionalPerAsset,
      maxNotionalGlobal: cfg.bidMaxNotionalGlobal,
      reserveUsdc: cfg.bidReserveUsdc,
      maxLongPerSeries: cfg.bidMaxLongPerSeries,
      depthFrac: cfg.bidDepthFrac,
    },
  });

  const chain = await initChain(cfg);
  log.info("chain-ready", {
    usdcMint: chain.usdcMint.toBase58(),
    epochMinLeadSecs: chain.epochMinLeadSecs,
  });

  // Boot balance check. Fail-fast on zero SOL only when we'll actually write;
  // observe-only / dry-run must run on an unfunded wallet (nothing is signed).
  const willWrite = cfg.enabled && !cfg.dryRun;
  const sol = await getBalanceSol(chain);
  if (sol === 0 && willWrite) { log.fatal("wallet-zero-sol", { at: "boot" }); process.exit(1); }
  log.info("wallet-balance", { at: "boot", sol });

  const hb = new Heartbeat(60 * 60 * 1000);
  const engine = new WriterEngine(cfg, chain, hb);

  // Main loop. A single tick error is logged and skipped (systemd restarts hard
  // crashes); state is re-read from chain every tick, so recovery is automatic.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const started = Date.now();
    try {
      await engine.reconcile(started);
    } catch (e: any) {
      log.error("tick-error", { err: String(e?.message ?? e).slice(0, 300) });
    }
    const elapsed = Date.now() - started;
    await sleep(Math.max(1000, cfg.tickMs - elapsed));
  }
}

process.on("unhandledRejection", (e: any) => {
  log.fatal("unhandled-rejection", { err: String(e?.message ?? e).slice(0, 300) });
  process.exit(1);
});

main().catch((e) => {
  log.fatal("crashed", { err: String(e?.message ?? e).slice(0, 300) });
  process.exit(1);
});
