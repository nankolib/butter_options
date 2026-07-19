// =============================================================================
// engine.ts — per-tick reconcile: post / reprice / pull, with caps + strand.
// =============================================================================
// Target-cell driven. Each tick: enumerate markets + my resting asks, then for
// each in-scope, quote-ready cell either post a new WriterAsk (ensuring the
// canonical series + 0-pool vault exist first, bundled all-or-nothing) or
// reprice an existing one (cancel+repost on >driftBps or >maxAge). A cell whose
// quote fails N times, or an equity cell whose market has closed, has its ask
// pulled (cancel → escrow back to the bot). Full-board runs also sweep orphan
// asks whose series left the target set (expiry rolled). Caps: per-asset,
// global, and per-run (canary).
// =============================================================================

import BN from "bn.js";
import { PublicKey } from "@solana/web3.js";
import type { WriterConfig } from "./env";
import type { Chain } from "./chain";
import { getBalanceSol, getFreeUsdc, sendTx, accountExists } from "./chain";
import { log, Heartbeat } from "./log";
import { enumerateMarkets, readOracle, enumerateMyOrders, type MarketInfo, type MyOrder } from "./discovery";
import { buildLadder, classifyTier, type TargetCell } from "./ladder";
import { seriesMintPda, mintRecordPda, vaultAmericanPda } from "./ids";
import { fetchQuote, applySpread, toUsdcBN, QuoteFailure } from "./pricing";
import {
  createSeriesIx, createSharedVaultIx, postWriterAskIx, cancelOrderIx, CU, type BuildCtx,
} from "./builders";
import { isMarketHours } from "./marketHours";

const EQUITY_MIN_LEAD_SECS = 24 * 3600; // don't post an equity ask expiring within a day

/** Resting asks whose vault resolves to `marketPk58` — the asks to PULL when that
 *  market's oracle is not fresh (see reconcile's !oracle.ready branch). Pure +
 *  map-driven so it unit-tests without RPC. */
export function ordersOnMarket(
  orders: MyOrder[],
  marketPk58: string,
  vaultToMarket: Map<string, string>,
): MyOrder[] {
  return orders.filter((o) => vaultToMarket.get(o.vault.toBase58()) === marketPk58);
}

export class WriterEngine {
  private readonly failCounts = new Map<string, number>(); // seriesMint58 -> consecutive quote failures
  private readonly vaultMarket = new Map<string, string>(); // vault58 -> market58 (immutable; cached across ticks)
  private readonly buildCtx: BuildCtx;

  constructor(
    private readonly cfg: WriterConfig,
    private readonly chain: Chain,
    private readonly hb: Heartbeat,
  ) {
    this.buildCtx = {
      program: chain.program,
      owner: chain.wallet.publicKey,
      protocolState: chain.protocolState,
      usdcMint: chain.usdcMint,
      epochConfig: chain.epochConfig,
    };
  }

  private inScope(m: MarketInfo): boolean {
    return this.cfg.assets == null || this.cfg.assets.includes(m.assetName.toUpperCase());
  }

  /** Populate the vault58 -> market58 cache for any orders whose vault we have not
   *  resolved yet. One batched read per tick (only NEW vaults); a vault's market is
   *  immutable, so it is cached for the process lifetime. */
  private async resolveVaultMarkets(orders: MyOrder[]): Promise<void> {
    const missing = [...new Set(orders.map((o) => o.vault.toBase58()))].filter((v) => !this.vaultMarket.has(v));
    if (missing.length === 0) return;
    try {
      const accts = await (this.chain.program.account as any).sharedVault.fetchMultiple(missing.map((v) => new PublicKey(v)));
      missing.forEach((v, i) => {
        const a: any = accts[i];
        if (a?.market) this.vaultMarket.set(v, new PublicKey(a.market).toBase58());
      });
    } catch (e: any) {
      log.warn("resolve-vault-markets-fail", { err: String(e?.message ?? e).slice(0, 160) });
    }
  }

  async reconcile(nowMs: number): Promise<void> {
    this.hb.onTick();
    const nowSec = Math.floor(nowMs / 1000);

    // --- balances (fail-fast on zero SOL only when writing) ---
    const sol = await getBalanceSol(this.chain);
    if (sol === 0) {
      if (this.writable()) { log.fatal("wallet-zero-sol", {}); process.exit(1); }
      log.warn("wallet-zero-sol", { note: "observe/dry-run — continuing" });
    }
    const freeUsdc = await getFreeUsdc(this.chain);
    if (sol < this.cfg.lowBalanceWarnSol) log.warn("low-sol", { sol, warnAt: this.cfg.lowBalanceWarnSol });
    if (this.cfg.minFreeUsdc > 0 && freeUsdc < this.cfg.minFreeUsdc) log.warn("low-usdc", { freeUsdc, warnAt: this.cfg.minFreeUsdc });

    // --- discovery ---
    const markets = (await enumerateMarkets(this.chain.program)).filter((m) => this.inScope(m));
    const myOrders = await enumerateMyOrders(this.chain.program, this.chain.wallet.publicKey);
    const ordersBySeries = new Map<string, MyOrder>();
    for (const o of myOrders) {
      const k = o.optionMint.toBase58();
      const prev = ordersBySeries.get(k);
      if (!prev || o.nonce > prev.nonce) ordersBySeries.set(k, o); // keep the newest per series
    }
    // Resolve order -> vault -> market so a stale market's asks can be pulled below.
    await this.resolveVaultMarkets(myOrders);

    let liveGlobal = myOrders.length;
    let postedThisRun = 0;
    const perAssetLive = new Map<string, number>();
    const targetSeries = new Set<string>();
    // In dry-run the preview shows intended asks unconstrained by current USDC
    // (funding lands just before go-live); live runs enforce the real balance.
    let quoteBudget = this.cfg.dryRun ? Infinity : freeUsdc;

    for (const market of markets) {
      // HARD GUARD (permanent policy): freeze ALL new activity on Pyth-source
      // markets (oracle_source=0). New positions on a Pyth market create
      // live-holder drag on its SB cutover. No vaults/series/asks/fills there
      // until its SB migration completes. This is code, not just env.
      if (market.oracleSource === 0) { log.info("pyth-frozen-skip", { asset: market.assetName }); continue; }
      const oracle = await readOracle(this.chain.program, market.pythFeedId, nowSec);
      if (!oracle.ready) {
        // STALE-PULL (fix): a not-ready oracle means the rested ask price can't be
        // trusted AND takers can't fill it (get_option_price gate) — but
        // fill_writer_ask does NOT read the oracle, so an ask left resting off a
        // dead/stale oracle is free money for a picker-off (e.g. a Friday-priced
        // equity ask over a weekend gap). PULL this market's resting asks; don't
        // just skip. Idempotent: once cancelled the orders are gone, so subsequent
        // stale ticks find nothing → no per-tick churn (cancel confirms in ~2s, well
        // under the tick interval). Equity boards go oracle-stale nightly by design
        // (proxy 503) → this is the intended cancel-at-close / repost-at-open cadence.
        const toPull = ordersOnMarket(myOrders, market.publicKey.toBase58(), this.vaultMarket);
        for (const o of toPull) await this.pull(o.optionMint, o, `oracle-not-ready:${oracle.reason}`);
        log.info("market-skip", { asset: market.assetName, reason: oracle.reason, samples: oracle.samples, pulledStale: toPull.length });
        continue;
      }
      const tier = classifyTier(market, this.cfg);
      const cells = buildLadder({
        market, spot: oracle.spot, tier, nowMs,
        epochMinLeadSecs: this.chain.epochMinLeadSecs,
        equityMinLeadSecs: EQUITY_MIN_LEAD_SECS,
      });

      let assetLive = perAssetLive.get(market.assetName) ?? 0;

      for (const cell of cells) {
        const seriesMint = seriesMintPda(market.publicKey, BigInt(cell.strikeMicro.toString()), cell.expiryTs, cell.optIdx);
        const s58 = seriesMint.toBase58();
        targetSeries.add(s58);
        const existing = ordersBySeries.get(s58);

        // Equity/ETF market-hours gate: never post off-session; pull any resting
        // ask so it can't be filled at a stale off-hours price.
        if (cell.vaultKind === "custom") {
          const hrs = isMarketHours(nowSec, market.assetClass);
          if (!hrs.ok) {
            if (existing) await this.pull(seriesMint, existing, "market-closed");
            continue;
          }
        }

        // Quote (authoritative premium). On failure: count, pull existing past threshold.
        let askPremium: number;
        try {
          const q = await fetchQuote(this.chain.program, { publicKey: market.publicKey, pythFeedId: market.pythFeedId },
            { strike: cell.strikeDollars, expiryTs: cell.expiryTs, side: cell.side, carryRateBps: 0 }, this.cfg.simPayer);
          askPremium = applySpread(q.premiumPerContract, cell.spreadBps);
          this.failCounts.delete(s58);
        } catch (e) {
          const kind = e instanceof QuoteFailure ? e.kind : "unknown";
          const n = (this.failCounts.get(s58) ?? 0) + 1;
          this.failCounts.set(s58, n);
          this.hb.onQuoteFail();
          if (existing && n >= this.cfg.quoteFailPullThreshold) await this.pull(seriesMint, existing, `quote-fail:${kind}`);
          continue;
        }
        if (askPremium <= 0) continue;
        const askMicro = toUsdcBN(askPremium);

        if (existing) {
          // Reprice on drift or age.
          const restPrice = Number(existing.priceMicro) / 1e6;
          const drift = restPrice > 0 ? Math.abs(askPremium - restPrice) / restPrice : 1;
          const age = existing.createdAtMs > 0 ? nowMs - existing.createdAtMs : Infinity;
          if (drift * 10_000 > this.cfg.repriceDriftBps || age > this.cfg.repriceMaxAgeMs) {
            await this.reprice(cell, market, seriesMint, existing, askMicro, nowSec);
          }
          continue;
        }

        // New post — respect caps + USDC budget.
        if (liveGlobal >= this.cfg.globalVaultCap) { log.info("cap-global", { cap: this.cfg.globalVaultCap }); continue; }
        if (assetLive >= this.cfg.maxCellsPerAsset) continue;
        // MAX_CELLS caps TOTAL live asks (existing on-chain + new), not per-tick
        // new posts — else the ladder grows every tick. liveGlobal starts at the
        // wallet's current order count and increments per post, so once the cap
        // is reached the bot only reprices, never adds.
        if (this.cfg.maxCellsThisRun > 0 && liveGlobal >= this.cfg.maxCellsThisRun) continue;
        const collateral = cell.strikeDollars * cell.qty;
        if (collateral > quoteBudget) { log.warn("usdc-budget-skip", { asset: cell.assetName, need: collateral, free: quoteBudget }); continue; }

        const ok = await this.post(cell, market, seriesMint, askMicro, nowSec);
        if (ok) {
          postedThisRun++; liveGlobal++; assetLive++; quoteBudget -= collateral;
          perAssetLive.set(market.assetName, assetLive);
        }
      }
      perAssetLive.set(market.assetName, assetLive);
    }

    // --- orphan sweep (full-board only): cancel asks whose series left the target set ---
    if (this.cfg.assets == null) {
      for (const o of myOrders) {
        if (!targetSeries.has(o.optionMint.toBase58())) {
          await this.pull(o.optionMint, o, "orphan-series");
        }
      }
    }

    this.hb.maybeEmit(nowMs, { markets: markets.length, liveOrders: liveGlobal, freeUsdc, sol });
  }

  // ---- actions (no-op in dry-run / disabled) --------------------------------

  private writable(): boolean {
    if (this.cfg.dryRun) return false;
    if (!this.cfg.enabled) return false;
    return true;
  }

  private async post(cell: TargetCell, market: MarketInfo, seriesMint: PublicKey, askMicro: BN, nowSec: number): Promise<boolean> {
    // Defense-in-depth: never post on a Pyth-source market even if the loop
    // guard is bypassed (see pyth-frozen-skip). Permanent freeze policy.
    if (market.oracleSource === 0) { log.error("pyth-guard-block", { asset: cell.assetName }); return false; }
    const vault = vaultAmericanPda(market.publicKey, BigInt(cell.strikeMicro.toString()), cell.expiryTs, cell.optIdx);
    const record = mintRecordPda(seriesMint);
    const collateral = cell.strikeDollars * cell.qty;
    const plan = {
      asset: cell.assetName, side: cell.side, strike: cell.strikeDollars,
      tenor: cell.tenorLabel, expiry: cell.expiryTs, qty: cell.qty,
      askPremium: Number(askMicro) / 1e6, spreadBps: cell.spreadBps, collateral, vaultKind: cell.vaultKind,
    };
    // Dry-run: log the intended ask and count it (so caps shape the preview).
    if (!this.writable()) { log.info("dry-run-post", plan); return true; }

    const needSeries = !(await accountExists(this.chain, record));
    const needVault = !(await accountExists(this.chain, vault));
    let nonce = BigInt(nowSec);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const cu = (needSeries ? 180_000 : 0) + (needVault ? 40_000 : 0) + 140_000;
      const { ix: postIx, order } = await postWriterAskIx(this.buildCtx, market.publicKey, vault, seriesMint, askMicro, cell.qty, nonce);
      const ixs = [CU(Math.max(200_000, cu))];
      if (needSeries) ixs.push(await createSeriesIx(this.buildCtx, market.publicKey, seriesMint, cell.strikeMicro, new BN(cell.expiryTs), cell.side));
      if (needVault) ixs.push(await createSharedVaultIx(this.buildCtx, market.publicKey, vault, cell.strikeMicro, new BN(cell.expiryTs), cell.side, cell.vaultKind));
      ixs.push(postIx);
      try {
        const sig = await sendTx(this.chain, ixs);
        this.hb.onPost();
        log.info("post-ok", { ...plan, sig, order: order.toBase58() });
        return true;
      } catch (e: any) {
        if (await accountExists(this.chain, order)) { this.hb.onPost(); log.info("post-ok-recheck", { ...plan, order: order.toBase58() }); return true; }
        if (attempt === 2) { log.error("post-fail", { ...plan, err: String(e?.message ?? e).slice(0, 200) }); return false; }
        nonce += 1n; // fresh nonce for the retry
      }
    }
    return false;
  }

  private async reprice(cell: TargetCell, market: MarketInfo, seriesMint: PublicKey, existing: MyOrder, askMicro: BN, nowSec: number): Promise<void> {
    const plan = { asset: cell.assetName, side: cell.side, strike: cell.strikeDollars, from: Number(existing.priceMicro) / 1e6, to: Number(askMicro) / 1e6 };
    if (!this.writable()) { log.info("dry-run-reprice", plan); return; }
    // Cancel the old ask (escrow → owner), then repost at the new price.
    if (!(await this.pull(seriesMint, existing, "reprice-cancel"))) return;
    const vault = vaultAmericanPda(market.publicKey, BigInt(cell.strikeMicro.toString()), cell.expiryTs, cell.optIdx);
    const { ix: postIx, order } = await postWriterAskIx(this.buildCtx, market.publicKey, vault, seriesMint, askMicro, cell.qty, BigInt(nowSec));
    try {
      const sig = await sendTx(this.chain, [CU(200_000), postIx]);
      this.hb.onReprice();
      log.info("reprice-ok", { ...plan, sig, order: order.toBase58() });
    } catch (e: any) {
      log.error("reprice-repost-fail", { ...plan, err: String(e?.message ?? e).slice(0, 200) });
    }
  }

  /** Cancel an ask, returning escrow to the bot. Returns true on success. */
  private async pull(seriesMint: PublicKey, order: MyOrder, reason: string): Promise<boolean> {
    if (!this.writable()) { log.info("dry-run-pull", { order: order.pubkey.toBase58(), reason }); return false; }
    try {
      const ix = await cancelOrderIx(this.buildCtx, seriesMint, order.pubkey);
      const sig = await sendTx(this.chain, [CU(400_000), ix]);
      this.hb.onCancel();
      log.info("pull-ok", { order: order.pubkey.toBase58(), reason, sig });
      return true;
    } catch (e: any) {
      // A cancel that keeps failing = collateral stranded in the escrow → alert.
      this.hb.onStrand();
      log.error("writer-strand", { order: order.pubkey.toBase58(), reason, err: String(e?.message ?? e).slice(0, 200) });
      return false;
    }
  }
}
