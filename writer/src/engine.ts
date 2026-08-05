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
import {
  enumerateMarkets, readOracle, enumerateMyOrders, enumerateMyBids, enumerateMyLongs,
  type MarketInfo, type MyOrder, type MyBid,
} from "./discovery";
import { buildLadder, classifyTier, type TargetCell } from "./ladder";
import { seriesMintPda, mintRecordPda, vaultAmericanPda } from "./ids";
import { fetchQuote, applySpread, toUsdcBN, QuoteFailure } from "./pricing";
import {
  createSeriesIx, createSharedVaultIx, postWriterAskIx, postBidIx, cancelOrderIx, CU, type BuildCtx,
} from "./builders";
import { isMarketHours } from "./marketHours";
import { decideBid, seedLiveBidExposure, type AskOutcome, type BidPolicy } from "./bids";

/**
 * What the ask loop did to one cell this tick, plus the market context the bid
 * pass needs. The bid is a DEPENDENT quote — it is derived from this record and
 * from nothing else, which is what keeps the no-cross invariant true by
 * construction rather than by periodic re-check.
 */
interface AskCellOutcome {
  cell: TargetCell;
  market: MarketInfo;
  seriesMint: PublicKey;
  outcome: AskOutcome;
  /** The ask price actually RESTING on chain after the ask loop acted. */
  restingAskPrice: number | null;
  mark: number;
  marketOpen: boolean;
  quoteFails: number;
  oracleReady: boolean;
}

const EQUITY_MIN_LEAD_SECS = 24 * 3600; // don't post an equity ask expiring within a day

/** REPRICE ε-SKIP threshold: an AGE-triggered reprice whose new price moves less
 *  than this fraction of the resting premium is not worth 2 txs of gas. 1%. */
const REPRICE_EPSILON = 0.01;

export type RepriceAction = "reprice" | "skip-epsilon" | "hold";

/**
 * Pure reprice decision. A DRIFT-triggered reprice is never skipped — that is a
 * real price move the book must reflect. Only the AGE path is ε-gated: the
 * canary was burning 2 txs per cycle to move 0.021416 → 0.021368 (0.05%).
 */
export function repriceDecision(
  drift: number, ageMs: number, driftBps: number, maxAgeMs: number, epsilon: number,
): RepriceAction {
  if (drift * 10_000 > driftBps) return "reprice";
  if (ageMs > maxAgeMs) return drift >= epsilon ? "reprice" : "skip-epsilon";
  return "hold";
}

/**
 * A cancel that fails because the order is ALREADY GONE is a benign no-op, not a
 * strand. Diagnosed 2026-07-24: the tick enumerates myOrders fresh at its start,
 * then reprices/cancels across a long tick; an order that expires and is swept
 * mid-tick is cancelled from a now-stale work-list and fails with 3012
 * AccountNotInitialized (0xbc4). Confirmed a WITHIN-TICK RACE, not a persistent
 * queue: across two 30-min windows 78 vs 73 stranded orders with ZERO overlap —
 * each is a one-shot already-closed PDA, never retried. Its escrow was already
 * returned at close, so nothing is stranded; the writer-strand alert was a false
 * alarm running ~90/hr. Anchor emits 3012 as custom error 0xbc4 = 3012.
 */
export function isTerminalCancelError(err: unknown): boolean {
  const s = String((err as any)?.message ?? err ?? "");
  return (
    /\b3012\b/.test(s) ||
    /0xbc4\b/i.test(s) ||
    /AccountNotInitialized/i.test(s)
  );
}

export type PullOutcome = "noop-gone" | "sent" | "strand";

/**
 * Pure pull decision. `orderExists` is the pre-cancel existence check;
 * `sendError` is null on a landed cancel, else the thrown error.
 *   - order gone before the cancel        → noop-gone (skip, no tx, no alert)
 *   - cancel landed                        → sent
 *   - cancel threw a terminal "gone" (3012)→ noop-gone (race, benign)
 *   - cancel threw anything else           → strand (real: collateral live)
 */
export function classifyPullOutcome(orderExists: boolean, sendError: unknown | null): PullOutcome {
  if (!orderExists) return "noop-gone";
  if (sendError == null) return "sent";
  return isTerminalCancelError(sendError) ? "noop-gone" : "strand";
}

/** HARD denylist decision (pure). Evaluated BEFORE the allow-list so an exclusion
 *  survives dropping OPTA_WRITER_ASSETS (assets=null / full board) — a permanent
 *  exclusion must never live in the allow-list alone, or it silently returns the
 *  moment the allow-list is dropped. Returns the reason, or null if allowed. */
export function denyReason(
  m: { assetName: string; assetClass: number },
  assetsExclude: string[],
  excludeClasses: number[],
): string | null {
  if (assetsExclude.includes(m.assetName.toUpperCase())) return "ticker-denylist";
  if (excludeClasses.includes(m.assetClass)) return `class-denylist:${m.assetClass}`;
  return null;
}

/** Full scope decision (pure): denylists win, then the optional allow-list. */
export function scopeReason(
  m: { assetName: string; assetClass: number },
  assets: string[] | null,
  assetsExclude: string[],
  excludeClasses: number[],
): string | null {
  const deny = denyReason(m, assetsExclude, excludeClasses);
  if (deny) return deny;
  if (assets != null && !assets.includes(m.assetName.toUpperCase())) return "not-in-allowlist";
  return null;
}

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
  private readonly vaultStrike = new Map<string, number>(); // vault58 -> strike (human USDC); anchors strike hysteresis
  private readonly vaultExpiry = new Map<string, number>(); // vault58 -> expiry (unix s); keys the anchors PER TENOR
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

  private denied(m: MarketInfo): string | null {
    return denyReason(m, this.cfg.assetsExclude, this.cfg.excludeClasses);
  }

  private inScope(m: MarketInfo): boolean {
    return scopeReason(m, this.cfg.assets, this.cfg.assetsExclude, this.cfg.excludeClasses) === null;
  }

  /** Populate the vault58 -> market58 cache for any orders whose vault we have not
   *  resolved yet. One batched read per tick (only NEW vaults); a vault's market is
   *  immutable, so it is cached for the process lifetime. Also caches the vault's
   *  STRIKE (same fetch, no extra RPC) — that feeds strike hysteresis. */
  private async resolveVaultMarkets(orders: MyOrder[]): Promise<void> {
    const missing = [...new Set(orders.map((o) => o.vault.toBase58()))].filter((v) => !this.vaultMarket.has(v));
    if (missing.length === 0) return;
    try {
      const accts = await (this.chain.program.account as any).sharedVault.fetchMultiple(missing.map((v) => new PublicKey(v)));
      missing.forEach((v, i) => {
        const a: any = accts[i];
        if (a?.market) this.vaultMarket.set(v, new PublicKey(a.market).toBase58());
        if (a?.strikePrice != null) this.vaultStrike.set(v, Number(a.strikePrice.toString()) / 1e6);
        if (a?.expiry != null) this.vaultExpiry.set(v, Number(a.expiry.toString()));
      });
    } catch (e: any) {
      log.warn("resolve-vault-markets-fail", { err: String(e?.message ?? e).slice(0, 160) });
    }
  }

  /** Distinct strikes this market currently has live asks on, KEYED BY EXPIRY —
   *  the anchor set for strike hysteresis (see ladder.stickyStrike). Keyed per
   *  expiry because the series PDA is (market, strike, expiry, side): a strike
   *  anchored only on the monthly cannot spare the weekly a fresh mint, so
   *  letting it satisfy the weekly's target reports "kept" and mints anyway. */
  private existingStrikesFor(orders: MyOrder[], marketPk58: string): Map<number, number[]> {
    const byExpiry = new Map<number, Set<number>>();
    for (const o of orders) {
      const v = o.vault.toBase58();
      if (this.vaultMarket.get(v) !== marketPk58) continue;
      const s = this.vaultStrike.get(v);
      const e = this.vaultExpiry.get(v);
      if (s == null || !(s > 0) || e == null || !(e > 0)) continue;
      if (!byExpiry.has(e)) byExpiry.set(e, new Set());
      byExpiry.get(e)!.add(s);
    }
    return new Map([...byExpiry].map(([e, set]) => [e, [...set]]));
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
    // C1: what the ask loop did, per cell. Populated by `record` below and
    // consumed by bidPass() STRICTLY AFTER this loop finishes — never during, so
    // the ask budget is fully settled before a single bid is considered.
    const askOutcomes: AskCellOutcome[] = [];
    const record = (
      o: Omit<AskCellOutcome, "marketOpen" | "quoteFails" | "oracleReady"> &
        Partial<Pick<AskCellOutcome, "marketOpen" | "quoteFails" | "oracleReady">>,
    ) => {
      askOutcomes.push({
        marketOpen: true, quoteFails: 0, oracleReady: true, ...o,
      } as AskCellOutcome);
    };
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
        // STRIKE HYSTERESIS anchors, PER EXPIRY: retain a live strike while spot
        // stays inside the deadband (v2: half a 5% rung), instead of minting a
        // new series every tick.
        existingStrikesByExpiry: this.existingStrikesFor(myOrders, market.publicKey.toBase58()),
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
            record({
              cell, market, seriesMint, outcome: "pulled", restingAskPrice: null,
              mark: 0, marketOpen: false,
            });
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
          record({
            cell, market, seriesMint, outcome: "pulled", restingAskPrice: null,
            mark: 0, quoteFails: n,
          });
          continue;
        }
        if (askPremium <= 0) {
          record({ cell, market, seriesMint, outcome: "absent", restingAskPrice: null, mark: 0 });
          continue;
        }
        const askMicro = toUsdcBN(askPremium);

        if (existing) {
          // Reprice on drift or age.
          const restPrice = Number(existing.priceMicro) / 1e6;
          const drift = restPrice > 0 ? Math.abs(askPremium - restPrice) / restPrice : 1;
          const age = existing.createdAtMs > 0 ? nowMs - existing.createdAtMs : Infinity;
          const action = repriceDecision(
            drift, age, this.cfg.repriceDriftBps, this.cfg.repriceMaxAgeMs, REPRICE_EPSILON,
          );
          // REPRICE ε-SKIP: an AGE-triggered reprice is cancel+repost = 2 txs. When
          // the new price is materially identical (< REPRICE_EPSILON of the resting
          // premium) those 2 txs buy nothing but gas — the canary was reposting on
          // moves like 0.021416 → 0.021368 (0.05%) every cycle. Drift-triggered
          // reprices are NEVER skipped; only the age path is ε-gated.
          if (action === "reprice") {
            const ok = await this.reprice(cell, market, seriesMint, existing, askMicro, nowSec);
            record({
              cell, market, seriesMint,
              outcome: ok ? "repriced" : "absent",
              restingAskPrice: ok ? askPremium : null,
              mark: askPremium / (1 + cell.spreadBps / 10_000),
            });
          } else {
            if (action === "skip-epsilon") {
              log.info("reprice-skip-epsilon", {
                asset: cell.assetName, strike: cell.strikeDollars, side: cell.side,
                driftPct: +(drift * 100).toFixed(4), epsilonPct: REPRICE_EPSILON * 100,
              });
            }
            // Held (or ε-skipped): the OLD price is what is resting on chain.
            record({
              cell, market, seriesMint, outcome: "held", restingAskPrice: restPrice,
              mark: askPremium / (1 + cell.spreadBps / 10_000),
            });
          }
          continue;
        }

        // New post — respect caps + USDC budget. Every early-out here means NO
        // resting ask on this series, so the bid pass must see "absent" and
        // refuse to quote a bid with no anchor.
        const noAnchor = () =>
          record({ cell, market, seriesMint, outcome: "absent", restingAskPrice: null, mark: askPremium / (1 + cell.spreadBps / 10_000) });
        if (liveGlobal >= this.cfg.globalVaultCap) { log.info("cap-global", { cap: this.cfg.globalVaultCap }); noAnchor(); continue; }
        if (assetLive >= this.cfg.maxCellsPerAsset) { noAnchor(); continue; }
        // MAX_CELLS caps TOTAL live asks (existing on-chain + new), not per-tick
        // new posts — else the ladder grows every tick. liveGlobal starts at the
        // wallet's current order count and increments per post, so once the cap
        // is reached the bot only reprices, never adds.
        if (this.cfg.maxCellsThisRun > 0 && liveGlobal >= this.cfg.maxCellsThisRun) { noAnchor(); continue; }
        const collateral = cell.strikeDollars * cell.qty;
        if (collateral > quoteBudget) { log.warn("usdc-budget-skip", { asset: cell.assetName, need: collateral, free: quoteBudget }); noAnchor(); continue; }

        const ok = await this.post(cell, market, seriesMint, askMicro, nowSec);
        if (ok) {
          postedThisRun++; liveGlobal++; assetLive++; quoteBudget -= collateral;
          perAssetLive.set(market.assetName, assetLive);
        }
        record({
          cell, market, seriesMint,
          outcome: ok ? "posted" : "absent",
          restingAskPrice: ok ? askPremium : null,
          mark: askPremium / (1 + cell.spreadBps / 10_000),
        });
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

    // --- C1 DEPENDENT-QUOTE PASS -------------------------------------------
    // Runs STRICTLY AFTER the ask loop (including the orphan sweep) so the ask
    // side has already taken its budget: `quoteBudget` is now the true remainder
    // and bids draw from that, never from money an ask might still need. Wrapped
    // whole so a bid-side failure can never abort a completed ask reconcile.
    try {
      await this.bidPass(askOutcomes, quoteBudget, nowMs);
    } catch (e: any) {
      log.error("bid-pass-fail", { err: String(e?.message ?? e).slice(0, 200) });
    }

    this.hb.maybeEmit(nowMs, { markets: markets.length, liveOrders: liveGlobal, freeUsdc, sol });
  }

  // ---- C1: bids ------------------------------------------------------------

  private bidPolicy(): BidPolicy {
    return {
      enabled: this.cfg.bidEnabled,
      atmRungs: this.cfg.bidAtmRungs,
      maxNotionalPerAsset: this.cfg.bidMaxNotionalPerAsset,
      maxNotionalGlobal: this.cfg.bidMaxNotionalGlobal,
      reserveUsdc: this.cfg.bidReserveUsdc,
      maxCells: this.cfg.bidMaxCells,
      maxLongPerSeries: this.cfg.bidMaxLongPerSeries,
      depthFrac: this.cfg.bidDepthFrac,
      driftBps: this.cfg.repriceDriftBps,
      maxAgeMs: this.cfg.repriceMaxAgeMs,
    };
  }

  /**
   * Derive every bid from what the ask loop just did. A bid is NEVER quoted for
   * a series with no resting ask — that is the anchor the no-cross guard is
   * measured against, and without it there is nothing to be safely below.
   *
   * `freeUsdcAfterAsks` is the ask loop's leftover budget (Infinity in dry-run,
   * matching the ask preview's convention).
   */
  private async bidPass(outcomes: AskCellOutcome[], freeUsdcAfterAsks: number, nowMs: number): Promise<void> {
    // The flag is INERT, not a kill switch: disabled means this pass does
    // nothing at all — it does not even sweep resting bids, so flipping it off
    // leaves them for a deliberate operator unwind rather than mass-cancelling.
    if (!this.cfg.bidEnabled) return;

    const policy = this.bidPolicy();
    const myBids = await enumerateMyBids(this.chain.program, this.chain.wallet.publicKey);
    const bidsBySeries = new Map<string, MyBid>();
    for (const b of myBids) {
      const k = b.optionMint.toBase58();
      const prev = bidsBySeries.get(k);
      if (!prev || b.nonce > prev.nonce) bidsBySeries.set(k, b);
    }

    // Long inventory per series — a filled bid makes the bot a holder and there
    // is no on-chain net-off, so this is what bounds accumulation.
    const longs = await enumerateMyLongs(
      this.chain.program, this.chain.wallet.publicKey,
      [...new Set(outcomes.map((o) => o.seriesMint.toBase58()))].map((s) => new PublicKey(s)),
    );

    // A resting bid whose series the ask loop never reached (market skipped for a
    // stale oracle, or the series left the target set) has lost its anchor.
    const seen = new Set(outcomes.map((o) => o.seriesMint.toBase58()));
    for (const b of myBids) {
      if (!seen.has(b.optionMint.toBase58())) {
        await this.pullBid(b, "no-ask-anchor:orphan");
      }
    }

    // Group by asset so one asset's failure cannot stop the others.
    const byAsset = new Map<string, AskCellOutcome[]>();
    const assetBySeries = new Map<string, string>();
    for (const o of outcomes) {
      const k = o.market.assetName;
      if (!byAsset.has(k)) byAsset.set(k, []);
      byAsset.get(k)!.push(o);
      assetBySeries.set(o.seriesMint.toBase58(), k);
    }

    // Seed the notional counters from bids ALREADY RESTING (ClickUp 86eygtf17).
    // These used to start at zero every tick, so decideBid's cap checks only saw
    // notional posted within the current tick and exposure ratcheted by up to a
    // full cap per 5-minute tick, unbounded over time. `liveBidCells` was always
    // seeded correctly from myBids.length — that asymmetry WAS the bug, and it
    // stayed hidden because at 3 cells the working cell-cap masked it.
    // Gated by bids.test.ts gate 10. Do NOT reset these to 0.
    const seeded = seedLiveBidExposure(
      myBids.map((b) => ({
        optionMint: b.optionMint.toBase58(),
        priceMicro: b.priceMicro,
        quantityRemaining: b.quantityRemaining,
      })),
      assetBySeries,
    );
    let globalBidNotional = seeded.globalBidNotional;
    let liveBidCells = myBids.length;
    const perAsset = seeded.perAsset;

    log.info("bid-exposure-seed", {
      liveBids: myBids.length,
      globalBidNotional: Number(globalBidNotional.toFixed(6)),
      perAsset: Object.fromEntries(
        [...perAsset.entries()].map(([a, v]) => [a, Number(v.toFixed(6))]),
      ),
    });

    for (const [asset, cells] of byAsset) {
      try {
        for (const o of cells) {
          const s58 = o.seriesMint.toBase58();
          const existing = bidsBySeries.get(s58) ?? null;
          const assetBidNotional = perAsset.get(asset) ?? 0;

          const decision = decideBid({
            policy,
            askOutcome: o.outcome,
            rungIndex: o.cell.rungIndex,
            restingAskPrice: o.restingAskPrice,
            mark: o.mark,
            askSpreadBps: o.cell.spreadBps,
            askQty: o.cell.qty,
            existingBid: existing
              ? {
                  price: Number(existing.priceMicro) / 1e6,
                  qty: Number(existing.quantityRemaining),
                  createdAtMs: existing.createdAtMs,
                }
              : null,
            heldLong: longs.get(s58) ?? 0,
            assetBidNotional,
            globalBidNotional,
            freeUsdcAfterAsks,
            liveBidCells,
            marketOpen: o.marketOpen,
            quoteFails: o.quoteFails,
            oracleReady: o.oracleReady,
            nowMs,
          });

          const plan = {
            asset, side: o.cell.side, strike: o.cell.strikeDollars, tenor: o.cell.tenorLabel,
            expiry: o.cell.expiryTs, askResting: o.restingAskPrice, mark: o.mark,
          };

          switch (decision.action) {
            case "post": {
              const ok = await this.postBid(o, decision.price, decision.qty, plan);
              if (ok) {
                perAsset.set(asset, assetBidNotional + decision.notional);
                globalBidNotional += decision.notional;
                liveBidCells += 1;
              }
              break;
            }
            case "reprice": {
              if (!existing) break;
              const restingNotional = (Number(existing.priceMicro) / 1e6) * Number(existing.quantityRemaining);
              // Dry-run reports the reprice as ONE line, mirroring the ask side.
              // Without this the preview would show the cancel and swallow the
              // repost (pullBid is a no-op returning false when not writable),
              // under-reporting the very plan the canary decision is made on.
              if (!this.writable()) {
                log.info("dry-run-bid-reprice", {
                  ...plan, from: Number(existing.priceMicro) / 1e6, to: decision.price, qty: decision.qty,
                });
                break;
              }
              if (!(await this.pullBid(existing, "bid-reprice-cancel"))) break;
              const ok = await this.postBid(o, decision.price, decision.qty, plan);
              if (ok) {
                const delta = Math.max(0, decision.notional - restingNotional);
                perAsset.set(asset, assetBidNotional + delta);
                globalBidNotional += delta;
              }
              break;
            }
            case "pull":
              if (existing) await this.pullBid(existing, decision.reason);
              break;
            case "skip":
              log.info("bid-skip", { ...plan, reason: decision.reason });
              break;
            case "hold":
              break;
          }
        }
      } catch (e: any) {
        // Per-asset isolation: one bad asset must not stop the rest of the book.
        log.error("bid-asset-fail", { asset, err: String(e?.message ?? e).slice(0, 200) });
      }
    }
  }

  private async postBid(
    o: AskCellOutcome, price: number, qty: number, plan: Record<string, unknown>,
  ): Promise<boolean> {
    const full = { ...plan, bidPrice: price, qty, notional: +(price * qty).toFixed(6) };
    if (!this.writable()) { log.info("dry-run-bid-post", full); return true; }
    const vault = vaultAmericanPda(
      o.market.publicKey, BigInt(o.cell.strikeMicro.toString()), o.cell.expiryTs, o.cell.optIdx,
    );
    let nonce = BigInt(Math.floor(Date.now() / 1000));
    for (let attempt = 1; attempt <= 2; attempt++) {
      const { ix, order } = await postBidIx(
        this.buildCtx, o.market.publicKey, vault, o.seriesMint, toUsdcBN(price), qty, nonce,
      );
      try {
        const sig = await sendTx(this.chain, [CU(200_000), ix]);
        log.info("bid-post-ok", { ...full, sig, order: order.toBase58() });
        return true;
      } catch (e: any) {
        if (await accountExists(this.chain, order)) { log.info("bid-post-ok-recheck", { ...full, order: order.toBase58() }); return true; }
        if (attempt === 2) { log.error("bid-post-fail", { ...full, err: String(e?.message ?? e).slice(0, 200) }); return false; }
        nonce += 1n;
      }
    }
    return false;
  }

  /** Cancel a resting bid, returning its USDC escrow. Reuses the ask side's
   *  already-proven gone-order race handling (classifyPullOutcome). */
  private async pullBid(bid: MyBid, reason: string): Promise<boolean> {
    if (!this.writable()) { log.info("dry-run-bid-pull", { order: bid.pubkey.toBase58(), reason }); return false; }
    const exists = await accountExists(this.chain, bid.pubkey);
    let sendError: unknown | null = null;
    let sig: string | undefined;
    if (exists) {
      try {
        const ix = await cancelOrderIx(this.buildCtx, bid.optionMint, bid.pubkey);
        sig = await sendTx(this.chain, [CU(400_000), ix]);
      } catch (e) {
        sendError = e;
      }
    }
    switch (classifyPullOutcome(exists, sendError)) {
      case "sent":
        log.info("bid-pull-ok", { order: bid.pubkey.toBase58(), reason, sig });
        return true;
      case "noop-gone":
        log.info("bid-pull-noop-gone", { order: bid.pubkey.toBase58(), reason });
        return false;
      case "strand":
        log.error("bid-strand", {
          order: bid.pubkey.toBase58(), reason, err: String((sendError as any)?.message ?? sendError).slice(0, 200),
        });
        return false;
    }
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
    // Defense-in-depth: a denylisted market must never post even if the scope
    // filter is bypassed. Mirrors the Pyth guard.
    const deny = this.denied(market);
    if (deny) { log.error("denylist-block", { asset: cell.assetName, reason: deny }); return false; }
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

    // PRE-MINT BUDGET GATE. The tick-start `quoteBudget` is an estimate that
    // drifts as fills/cancels land mid-tick; minting a series+vault (~0.0201 SOL
    // of PERMANENT rent) and only then failing post_order on insufficient USDC
    // leaves a 0-pool shell behind forever. Re-read the balance immediately
    // before we would build ANY init ix, and skip the cell instead.
    const freeNow = await getFreeUsdc(this.chain);
    if (collateral > freeNow) {
      log.warn("usdc-budget-skip", { asset: cell.assetName, need: collateral, free: freeNow, at: "pre-mint" });
      return false;
    }

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

  /** Returns true when a NEW ask is resting at `askMicro` afterwards. (Dry-run
   *  returns true: the plan is what the diff compares, and nothing was sent.) */
  private async reprice(cell: TargetCell, market: MarketInfo, seriesMint: PublicKey, existing: MyOrder, askMicro: BN, nowSec: number): Promise<boolean> {
    const plan = { asset: cell.assetName, side: cell.side, strike: cell.strikeDollars, from: Number(existing.priceMicro) / 1e6, to: Number(askMicro) / 1e6 };
    if (!this.writable()) { log.info("dry-run-reprice", plan); return true; }
    // Cancel the old ask (escrow → owner), then repost at the new price.
    if (!(await this.pull(seriesMint, existing, "reprice-cancel"))) return false;
    const vault = vaultAmericanPda(market.publicKey, BigInt(cell.strikeMicro.toString()), cell.expiryTs, cell.optIdx);
    const { ix: postIx, order } = await postWriterAskIx(this.buildCtx, market.publicKey, vault, seriesMint, askMicro, cell.qty, BigInt(nowSec));
    try {
      const sig = await sendTx(this.chain, [CU(200_000), postIx]);
      this.hb.onReprice();
      log.info("reprice-ok", { ...plan, sig, order: order.toBase58() });
      return true;
    } catch (e: any) {
      log.error("reprice-repost-fail", { ...plan, err: String(e?.message ?? e).slice(0, 200) });
      return false;
    }
  }

  /** Cancel an ask, returning escrow to the bot. Returns true on success. */
  private async pull(seriesMint: PublicKey, order: MyOrder, reason: string): Promise<boolean> {
    if (!this.writable()) { log.info("dry-run-pull", { order: order.pubkey.toBase58(), reason }); return false; }
    // Existence pre-check RIGHT BEFORE the cancel. The work-list is enumerated at
    // tick start but consumed across a long tick; an order swept mid-tick is gone
    // by now. Checking here (not at tick start) is what catches the within-tick
    // race — a batched tick-start check would itself be stale. A getAccountInfo is
    // far cheaper than a doomed cancel tx, and skipping is a benign no-op: a gone
    // order already returned its escrow at close, so there is nothing to pull.
    const exists = await accountExists(this.chain, order.pubkey);
    let sendError: unknown | null = null;
    let sig: string | undefined;
    if (exists) {
      try {
        const ix = await cancelOrderIx(this.buildCtx, seriesMint, order.pubkey);
        sig = await sendTx(this.chain, [CU(400_000), ix]);
      } catch (e) {
        sendError = e;
      }
    }
    switch (classifyPullOutcome(exists, sendError)) {
      case "sent":
        this.hb.onCancel();
        log.info("pull-ok", { order: order.pubkey.toBase58(), reason, sig });
        return true;
      case "noop-gone":
        // Order already closed (pre-check miss, or a 3012 race one slot tighter).
        // Its escrow returned at close → nothing stranded; skip, never alert.
        log.info("pull-noop-gone", {
          order: order.pubkey.toBase58(), reason, at: exists ? "3012-on-send" : "pre-check",
        });
        return false;
      case "strand":
        // A genuine cancel failure on a LIVE order = collateral really stranded → alert.
        this.hb.onStrand();
        log.error("writer-strand", {
          order: order.pubkey.toBase58(), reason, err: String((sendError as any)?.message ?? sendError).slice(0, 200),
        });
        return false;
    }
  }
}
