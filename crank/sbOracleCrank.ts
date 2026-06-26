// ============================================================================
// crank/sbOracleCrank.ts — Stage 3 1c-ii-A: Switchboard VolOracle warming crank
// ============================================================================
//
// The 5th crank side-loop. Structural sibling of volOracleCrank.ts: hourly,
// wall-clock-aligned, per-feed-isolated. Warms SB-sourced VolOracles by posting
// fresh signed Switchboard quotes through push_vol_sample's SB arm (the path
// proven live by the 1c-i-A devnet smoke).
//
// PER TICK: safeFetchAll("optionsMarket") → filter oracle_source==1 → dedup
// feedHashes → filter to registry-supported → per-feed init-or-push.
//   - if no VolOracle yet: birth via initialize_vol_oracle(feedHash, source=1),
//     price_update=null (the deployed 1c-i-A path — no SB accounts at birth, the
//     SB proof was deferred to the first push).
//   - else: warming push — resolve jobs (registry) → fetch fresh quote via
//     buildManagedQuoteUpdateIxs (self-packed ed25519) → build
//     [CU, ed25519Ix, push_vol_sample(+SB accounts, price_update:null)] →
//     simulate-gate → (dry-run) log + STOP / (live) send + confirm.
//
// GATES (mirror the trigger keeper):
//   OPTA_SB_CRANK_DISABLED=1  → bot.ts skips spawning this loop entirely.
//   OPTA_SB_DRY_RUN (default "1" = ON) → build + simulate + log, NEVER send.
//   OPTA_SB_FORCE_FEED=<hex[,hex]>  → dev/ops hook: process these feedHashes even
//     if no on-chain SB market references them yet (used to dry-run the push path
//     against the 1c-i-A unlisted gold VolOracle before create-SB-market deploys).
//
// SCOPE: warming push ONLY (writes VolOracle.last_spot_price). SB settle-at-expiry
// is 1c-ii-B — this loop never touches the settle path.
//
// Single-tick smoke: TICK_ONCE=1 runs one tick and returns.
// ============================================================================

import * as anchor from "@coral-xyz/anchor";
import {
  Connection, PublicKey, ComputeBudgetProgram, SystemProgram, Ed25519Program,
  TransactionMessage, VersionedTransaction, TransactionInstruction,
} from "@solana/web3.js";
import {
  Queue, AnchorUtils, ON_DEMAND_DEVNET_PID, ON_DEMAND_DEVNET_QUEUE,
  SPL_SYSVAR_SLOT_HASHES_ID, SPL_SYSVAR_INSTRUCTIONS_ID,
} from "@switchboard-xyz/on-demand";
import { CrossbarClient } from "@switchboard-xyz/common";

import type { Opta } from "@app/idl/opta";
import { safeFetchAll } from "@app/hooks/useFetchAccounts";
import { hexFromBytes } from "@app/utils/format";
import { VOL_ORACLE_SEED } from "@app/utils/constants";

import { buildManagedQuoteUpdateIxs } from "./switchboardQuotePost";
import {
  lookupSbFeed, isSupportedSbFeed, listSupportedFeeds, buildOracleFeed,
  normFeedHash, type SbFeedEntry,
} from "./sbFeedRegistry";
import { msUntilNextHourBoundary } from "./volOracleCrank";

// ---- Types -----------------------------------------------------------------

export type SbCrankLogLevel = "info" | "warn" | "error" | "fatal";
export type SbCrankLogger = (
  level: SbCrankLogLevel,
  msg: string,
  fields?: Record<string, unknown>,
) => void;

export interface SbOracleCrankContext {
  connection: Connection;
  /** anchor.Wallet — needs `.payer` (live send) + `.publicKey`. */
  wallet: anchor.Wallet;
  program: anchor.Program<Opta>;
  log: SbCrankLogger;
  shouldShutdown: () => boolean;
  /** OPTA_SB_DRY_RUN — when true, build + simulate + log, NEVER send. */
  dryRun: boolean;
  /** OPTA_SB_FORCE_FEED — extra feedHashes to process regardless of discovery. */
  forceFeeds: string[];
}

export interface SbOracleCrankOptions {
  tickOnce?: boolean;
}

export interface SbTickReport {
  marketsScanned: number;
  sbMarketsFound: number;
  feedsSupported: number;
  feedsSkippedUnsupported: number;
  feedsInitialized: number;     // birthed (or would-birth in dry-run)
  feedsPushed: number;          // pushed (or would-push in dry-run)
  feedsErrored: number;
  durationMs: number;
}

/** SB-SDK clients, bootstrapped once per run. */
interface SbClients {
  qObj: Queue;
  crossbar: CrossbarClient;
}

// ---- Constants -------------------------------------------------------------

const SHUTDOWN_CHECK_MS = 5000;
const PUSH_CU_LIMIT = 400_000;
/** Bounded retry per feed: the SB gateway is ~3/15 clean (root-cause doc). Each
 *  attempt RE-FETCHES a fresh quote (a quote past ~512 slots / ~3.5 min is
 *  unrecoverable). After this many misses we log-and-continue so one bad feed
 *  never stalls the whole tick. */
const SB_PUSH_MAX_ATTEMPTS = 4;
const CROSSBAR_URL = "https://crossbar.switchboard.xyz";

// ---- Bootstrap -------------------------------------------------------------

async function bootstrapSbClients(ctx: SbOracleCrankContext): Promise<SbClients> {
  const sbProgram = await AnchorUtils.loadProgramFromConnection(
    ctx.connection,
    ctx.wallet,
    ON_DEMAND_DEVNET_PID,
  );
  const qObj = new Queue(sbProgram, ON_DEMAND_DEVNET_QUEUE);
  const crossbar = new CrossbarClient(CROSSBAR_URL);
  return { qObj, crossbar };
}

// ---- Main loop -------------------------------------------------------------

export async function runSbOracleCrank(
  ctx: SbOracleCrankContext,
  options: SbOracleCrankOptions = {},
): Promise<void> {
  ctx.log("info", "sb-oracle crank started", {
    dryRun: ctx.dryRun,
    tickOnce: !!options.tickOnce,
    supportedFeeds: listSupportedFeeds().map((f) => `${f.symbol}:${f.feedHashHex.slice(0, 8)}`),
    forceFeeds: ctx.forceFeeds.map((f) => f.slice(0, 8)),
  });

  let sb: SbClients;
  try {
    sb = await bootstrapSbClients(ctx);
  } catch (err) {
    ctx.log("error", "sb-oracle bootstrap failed (SB SDK / RPC)", { err: String(err) });
    throw err;
  }

  if (options.tickOnce) {
    try {
      const report = await tickOnce(ctx, sb);
      ctx.log("info", "sb-oracle crank exiting (TICK_ONCE)", { ...report });
    } catch (err) {
      ctx.log("error", "sb-oracle TICK_ONCE crashed", { err: String(err) });
      throw err;
    }
    return;
  }

  await runTickWithGuard(ctx, sb);
  while (!ctx.shouldShutdown()) {
    const sleepMs = msUntilNextHourBoundary(Date.now());
    ctx.log("info", "sb-oracle crank sleeping until next hour boundary", {
      sleepMs, wakeAt: new Date(Date.now() + sleepMs).toISOString(),
    });
    await sleepInterruptibly(sleepMs, ctx.shouldShutdown);
    if (ctx.shouldShutdown()) break;
    await runTickWithGuard(ctx, sb);
  }
  ctx.log("info", "sb-oracle crank stopped cleanly");
}

async function runTickWithGuard(ctx: SbOracleCrankContext, sb: SbClients): Promise<void> {
  try {
    await tickOnce(ctx, sb);
  } catch (err) {
    ctx.log("error", "sb-oracle tick crashed (will retry next hour)", {
      err: String(err), stack: (err as any)?.stack,
    });
  }
}

// ---- One tick --------------------------------------------------------------

export async function tickOnce(
  ctx: SbOracleCrankContext,
  sb: SbClients,
): Promise<SbTickReport> {
  const startMs = Date.now();
  const report: SbTickReport = {
    marketsScanned: 0, sbMarketsFound: 0, feedsSupported: 0,
    feedsSkippedUnsupported: 0, feedsInitialized: 0, feedsPushed: 0,
    feedsErrored: 0, durationMs: 0,
  };

  // Discover on-chain SB markets (oracle_source == 1) → dedup feedHashes.
  const markets = await safeFetchAll<any>(ctx.program, "optionsMarket");
  report.marketsScanned = markets.length;
  const sbMarkets = markets.filter((m) => m.account.oracleSource === 1);
  report.sbMarketsFound = sbMarkets.length;

  const seen = new Set<string>();
  const feedHashes: string[] = [];
  const pushFeed = (hex: string) => {
    const k = normFeedHash(hex);
    if (k.length !== 64 || seen.has(k)) return;
    seen.add(k);
    feedHashes.push(k);
  };
  for (const m of sbMarkets) pushFeed(hexFromBytes(m.account.pythFeedId as number[]));
  // OPTA_SB_FORCE_FEED — dev/ops hook (process even with no discoverable market).
  for (const f of ctx.forceFeeds) pushFeed(f);

  // Allow-gate: registry-supported only.
  const supported = feedHashes.filter((h) => isSupportedSbFeed(h));
  const unsupported = feedHashes.filter((h) => !isSupportedSbFeed(h));
  report.feedsSupported = supported.length;
  report.feedsSkippedUnsupported = unsupported.length;
  for (const h of unsupported) {
    ctx.log("warn", "sb-oracle skip: feedHash not in registry", { feed: h.slice(0, 10) });
  }

  ctx.log("info", "sb-oracle tick: discovered SB feeds", {
    markets: markets.length, sbMarkets: sbMarkets.length,
    supported: supported.length, unsupported: unsupported.length,
    forced: ctx.forceFeeds.length,
  });

  for (const feedHashHex of supported) {
    if (ctx.shouldShutdown()) break;
    await processOneSbFeed(ctx, sb, feedHashHex, report);
  }

  report.durationMs = Date.now() - startMs;
  ctx.log("info", "sb-oracle tick complete", { ...report });
  return report;
}

export async function processOneSbFeed(
  ctx: SbOracleCrankContext,
  sb: SbClients,
  feedHashHex: string,
  report: SbTickReport,
): Promise<void> {
  const entry = lookupSbFeed(feedHashHex);
  if (!entry) {
    // Defensive: tickOnce already filtered to supported, but keep isolation.
    report.feedsSkippedUnsupported += 1;
    return;
  }
  const feedShort = entry.feedHashHex.slice(0, 10);
  const feedIdBytes = Array.from(Buffer.from(entry.feedHashHex, "hex"));
  const [oraclePda] = PublicKey.findProgramAddressSync(
    [Buffer.from(VOL_ORACLE_SEED), Buffer.from(feedIdBytes)],
    ctx.program.programId,
  );

  let existing: Awaited<ReturnType<Connection["getAccountInfo"]>>;
  try {
    existing = await ctx.connection.getAccountInfo(oraclePda);
  } catch (err) {
    ctx.log("error", "sb-oracle existence check failed", {
      feed: feedShort, pda: oraclePda.toBase58(), err: String(err),
    });
    report.feedsErrored += 1;
    return;
  }

  if (!existing) {
    await birthSbOracle(ctx, entry, feedIdBytes, oraclePda, feedShort, report);
    return;
  }
  await warmingPushWithRetry(ctx, sb, entry, oraclePda, feedShort, report);
}

// ---- Birth (initialize_vol_oracle, oracle_source=1, no SB accounts) ---------

async function birthSbOracle(
  ctx: SbOracleCrankContext,
  entry: SbFeedEntry,
  feedIdBytes: number[],
  oraclePda: PublicKey,
  feedShort: string,
  report: SbTickReport,
): Promise<void> {
  try {
    // Cast to `any`: the crank's @app/idl/opta TYPE is stale for the SB surface
    // (priceUpdate-optional + push SB accounts not synced into app/src/idl) — the
    // RUNTIME-loaded IDL has them. The IDL sync is deferred deploy work (report).
    const birthIx = await (ctx.program.methods as any)
      .initializeVolOracle(feedIdBytes, 1) // oracle_source = Switchboard
      .accounts({
        initializer: ctx.wallet.publicKey,
        priceUpdate: null, // SB feed-existence proof deferred to first push
        volOracle: oraclePda,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
    const sim = await simulate(ctx, [cuLimitIx(), birthIx]);
    if (sim.err) {
      ctx.log("warn", "sb-oracle birth sim failed (retry next tick)", {
        feed: feedShort, err: JSON.stringify(sim.err),
      });
      report.feedsErrored += 1;
      return;
    }
    if (ctx.dryRun) {
      ctx.log("info", "WOULD-BIRTH sb vol-oracle (dry-run, NOT sent)", {
        feed: feedShort, pda: oraclePda.toBase58(), oracleSource: 1, simOk: true,
      });
      report.feedsInitialized += 1;
      return;
    }
    const sig = await send(ctx, [cuLimitIx(), birthIx]);
    ctx.log("info", "sb-oracle birthed", { feed: feedShort, pda: oraclePda.toBase58(), sig });
    report.feedsInitialized += 1;
  } catch (err) {
    ctx.log("error", "sb-oracle birth failed", { feed: feedShort, err: String(err) });
    report.feedsErrored += 1;
  }
}

// ---- Warming push (bounded retry-with-fresh-quote) -------------------------

async function warmingPushWithRetry(
  ctx: SbOracleCrankContext,
  sb: SbClients,
  entry: SbFeedEntry,
  oraclePda: PublicKey,
  feedShort: string,
  report: SbTickReport,
): Promise<void> {
  const feed = buildOracleFeed(entry);
  const edPid = Ed25519Program.programId.toBase58();

  for (let attempt = 1; attempt <= SB_PUSH_MAX_ATTEMPTS; attempt++) {
    if (ctx.shouldShutdown()) return;

    // (a) fetch a FRESH signed quote → corrected (self-packed) ed25519 ix.
    let edIx: TransactionInstruction;
    try {
      const { ixs } = await buildManagedQuoteUpdateIxs(
        sb.qObj, sb.crossbar, feed, ctx.wallet.publicKey,
        { numSignatures: 2, instructionIdx: 1 },
      );
      const found = ixs.find((ix) => ix.programId.toBase58() === edPid);
      if (!found) throw new Error("no ed25519 ix in managed-update output");
      edIx = found;
    } catch (err) {
      ctx.log("info", "sb-oracle quote fetch/pack failed (re-fetch fresh)", {
        feed: feedShort, attempt, err: String(err).slice(0, 140),
      });
      continue;
    }

    // (b) [CU, ed25519(idx 1), push_vol_sample(+SB accounts, price_update:null)].
    //     Cast to `any` — see birthSbOracle: the @app/idl/opta type is stale for
    //     the push SB account surface; the runtime-loaded IDL has it.
    const pushIx = await (ctx.program.methods as any)
      .pushVolSample()
      .accounts({
        signer: ctx.wallet.publicKey,
        priceUpdate: null,
        volOracle: oraclePda,
        systemProgram: SystemProgram.programId,
        sbQueue: entry.queue,
        sbSlothashes: SPL_SYSVAR_SLOT_HASHES_ID,
        sbInstructions: SPL_SYSVAR_INSTRUCTIONS_ID,
      })
      .instruction();
    const instructions = [cuLimitIx(), edIx, pushIx];

    // (c) simulate-gate.
    const sim = await simulate(ctx, instructions);
    if (sim.err) {
      ctx.log("info", "sb-oracle push sim err (re-fetch fresh)", {
        feed: feedShort, attempt, err: JSON.stringify(sim.err),
      });
      continue;
    }

    if (ctx.dryRun) {
      ctx.log("info", "WOULD-SEND sb push (dry-run, NOT sent)", {
        feed: feedShort, pda: oraclePda.toBase58(), attempt,
        cuUnits: PUSH_CU_LIMIT, ed25519Bytes: edIx.data.length, simOk: true,
      });
      report.feedsPushed += 1;
      return;
    }

    try {
      const sig = await send(ctx, instructions);
      ctx.log("info", "sb-oracle push sent", { feed: feedShort, pda: oraclePda.toBase58(), sig });
      report.feedsPushed += 1;
    } catch (err) {
      // anti-blind-retry: a failed send re-fetches a fresh quote, never resends.
      ctx.log("info", "sb-oracle push send failed (re-fetch fresh)", {
        feed: feedShort, attempt, err: String(err).slice(0, 140),
      });
      continue;
    }
    return;
  }

  ctx.log("warn", "sb-oracle push failed after max attempts (retry next tick)", {
    feed: feedShort, attempts: SB_PUSH_MAX_ATTEMPTS,
  });
  report.feedsErrored += 1;
}

// ---- Tx helpers ------------------------------------------------------------

function cuLimitIx(): TransactionInstruction {
  return ComputeBudgetProgram.setComputeUnitLimit({ units: PUSH_CU_LIMIT });
}

async function buildTx(
  ctx: SbOracleCrankContext,
  instructions: TransactionInstruction[],
): Promise<{ tx: VersionedTransaction; blockhash: string; lastValidBlockHeight: number }> {
  const bh = await ctx.connection.getLatestBlockhash();
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: ctx.wallet.publicKey,
      recentBlockhash: bh.blockhash,
      instructions,
    }).compileToV0Message(),
  );
  return { tx, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight };
}

/** Build + simulate (sigVerify off, replace-blockhash). NEVER sends. */
async function simulate(
  ctx: SbOracleCrankContext,
  instructions: TransactionInstruction[],
): Promise<{ err: unknown; logs: string[] | null }> {
  const { tx } = await buildTx(ctx, instructions);
  const sim = await ctx.connection.simulateTransaction(tx, {
    sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed",
  });
  return { err: sim.value.err, logs: sim.value.logs ?? null };
}

/** Sign + send + confirm. Only reached when !dryRun. */
async function send(
  ctx: SbOracleCrankContext,
  instructions: TransactionInstruction[],
): Promise<string> {
  const { tx, blockhash, lastValidBlockHeight } = await buildTx(ctx, instructions);
  tx.sign([ctx.wallet.payer]);
  const sig = await ctx.connection.sendTransaction(tx, { skipPreflight: false });
  const conf = await ctx.connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight }, "confirmed",
  );
  if (conf.value.err) throw new Error(`confirm err: ${JSON.stringify(conf.value.err)} sig=${sig}`);
  return sig;
}

// ---- Misc ------------------------------------------------------------------

async function sleepInterruptibly(totalMs: number, shouldStop: () => boolean): Promise<void> {
  let remaining = totalMs;
  while (remaining > 0 && !shouldStop()) {
    const chunk = Math.min(remaining, SHUTDOWN_CHECK_MS);
    await new Promise<void>((resolve) => setTimeout(resolve, chunk));
    remaining -= chunk;
  }
}

/** Parse OPTA_SB_FORCE_FEED (comma-separated feedHashes). */
export function parseForceFeeds(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => normFeedHash(s.trim())).filter((s) => s.length === 64);
}
