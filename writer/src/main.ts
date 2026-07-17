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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const cfg = loadConfig();
  log.info("boot", {
    rpc: redactRpc(cfg.rpcUrl),
    wallet: cfg.wallet.publicKey.toBase58(),
    mode: cfg.dryRun ? "DRY-RUN" : cfg.enabled ? "LIVE" : "OBSERVE-ONLY",
    assets: cfg.assets ?? "all",
    maxCellsThisRun: cfg.maxCellsThisRun || "uncapped",
    tickMs: cfg.tickMs,
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
