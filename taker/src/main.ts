// =============================================================================
// main.ts — opta-taker service loop (service #8)
// =============================================================================
//
// The treasury's standing bid of last resort: it buys USER ASKS — both kinds —
// at a discount to model fair value, so a tester who wants out has somewhere to
// go on a book that is otherwise ~309/323 our own orders.
//
//   resaleAsk  a holder exiting contracts they own    -> fill_order
//   writerAsk  a user writing new contracts to sell   -> fill_writer_ask (MINTS)
//
// Both complete quest O3. The writerAsk side creates open interest rather than
// transferring it, so it carries its own cap (maxOiUsd) on top of the cash
// budgets — see eligibility.ts.
//
// POSTURE. Ships DRY_RUN=1 and unarmed. Shadow mode runs the ENTIRE path —
// scan, price, evaluate, build the fill, simulate it — and stops one step short
// of signing. That is deliberate: a shadow that skips the hard parts proves the
// easy parts work.
//
// FAILURE POSTURE. The loop never throws. Every tick is wrapped, and a failed
// tick logs and waits for the next one. A taker that crashes on an RPC blip and
// gets restarted by systemd re-reads its budget from SQLite and carries on, but
// a crash loop is still noise, and noise is how a real failure gets missed.
// =============================================================================

import { PublicKey } from "@solana/web3.js";
import { loadConfig, redactRpc, type TakerConfig } from "./env";
import { initChain, getBalanceSol, getFreeUsdc, type Chain } from "./chain";
import {
  openDb, walletSpentToday, globalSpentToday, readFloat, readOi,
  seeOrder, recordFill, pruneSeen, type Db,
} from "./db";
import { enumerateUserAsks, loadSeriesTerms, classifyWallets, type UserAsk, type SeriesTerms } from "./scan";
import { fetchQuote, QuoteFailure } from "./pricing";
import {
  evaluate, preScreen, identityGate, delayForOrder,
  type TakerLimits, type Candidate, type Decision,
} from "./eligibility";
import { ShadowTally } from "./shadow";
import { buildFillIxs, simulateFill, sendFill, confirmStillRestingUnchanged } from "./fill";
import { log, Heartbeat } from "./log";
import { isInternal, INTERNAL_WALLETS } from "../../indexer/src/registry";

/** Quoting every candidate every tick is the expensive part; cache within a tick. */
type QuoteKey = string;

function limitsOf(cfg: TakerConfig): TakerLimits {
  return {
    minDiscountBps: cfg.minDiscountBps,
    maxDiscountBps: cfg.maxDiscountBps,
    minTteSecs: cfg.minTteSecs,
    maxFillUsdc: cfg.maxFillUsdc,
    maxPerWalletDayUsdc: cfg.maxPerWalletDayUsdc,
    maxGlobalDayUsdc: cfg.maxGlobalDayUsdc,
    maxFloatUsdc: cfg.maxFloatUsdc,
    maxOiUsd: cfg.maxOiUsd,
  };
}

async function tick(cfg: TakerConfig, chain: Chain, db: Db, hb: Heartbeat): Promise<void> {
  const nowSecs = Math.floor(Date.now() / 1000);
  const tally = new ShadowTally();
  const limits = limitsOf(cfg);
  const takerWallet = chain.wallet.publicKey.toBase58();

  const asks = await enumerateUserAsks(chain.program);
  hb.onScan(asks.length);

  // Prune stale sighting rows against the live set before anything else, so the
  // table cannot grow without bound across a long-running process.
  pruneSeen(db, new Set(asks.map((a) => a.pubkey.toBase58())), nowSecs);

  if (asks.length === 0) {
    tally.emit({ scanned: 0 }, !cfg.dryRun && cfg.armed);
    return;
  }

  // Batch the two chain reads that every candidate needs, once per tick.
  const uniqVaults = [...new Map(asks.map((a) => [a.vault.toBase58(), a.vault])).values()];
  const uniqOwners = [...new Map(asks.map((a) => [a.owner.toBase58(), a.owner])).values()];
  const [terms, wallets] = await Promise.all([
    loadSeriesTerms(chain.program, uniqVaults),
    classifyWallets(chain.connection, uniqOwners),
  ]);

  const quoteCache = new Map<QuoteKey, number | null>();
  let filledThisTick = 0;

  for (const ask of asks) {
    hb.onConsider();
    const orderPk = ask.pubkey.toBase58();
    const owner = ask.owner.toBase58();
    const mint = ask.optionMint.toBase58();
    const skip = (decision: Decision) =>
      tally.record({ orderPk, owner, mint, kind: ask.kind, price: ask.priceUsdc, fair: null, decision }, true);

    // IDENTITY FIRST — before any per-order chain work and before any other
    // reason can claim the refusal. The board is overwhelmingly ours, so this
    // both saves the work and keeps the tally attributing those orders to
    // `internal_owner` rather than to whatever downstream check happened to fire.
    const id = identityGate(owner, { isInternal, isWallet: (pk: string) => wallets.has(pk), takerWallet });
    if (id) { skip(id); continue; }

    const t = terms.get(ask.vault.toBase58());
    // No readable vault means no strike, no expiry, no way to price it.
    if (!t) { skip({ fill: false, reason: "no_fair_value", detail: "vault unreadable" }); continue; }
    // A settled or voided series has no forward value left to buy.
    if (t.voided) { skip({ fill: false, reason: "voided" }); continue; }
    if (t.isSettled) { skip({ fill: false, reason: "settled" }); continue; }

    // Start the delay clock on FIRST SIGHT, before any gate can skip this order.
    // If the clock only started once an order passed every other check, an order
    // that was briefly out of band would begin its wait late, and the delay
    // would become a function of our own scan timing rather than the seller's.
    const delayUntil = seeOrder(db, orderPk, nowSecs, delayForOrder(orderPk, cfg.minDelaySecs, cfg.maxDelaySecs));

    const common = {
      candidate: candidateOf(ask, t),
      limits, nowSecs, delayUntilSecs: delayUntil,
      isInternal, isWallet: (pk: string) => wallets.has(pk), takerWallet,
    };

    // Price only what survived the free gates — a quote is a simulate round-trip
    // per distinct series, and most of this board is our own orders.
    const pre = preScreen(common);
    if (pre) { skip(pre); continue; }

    const qk = `${t.market.toBase58()}|${t.strikeUsd}|${t.expiryTs}|${t.side}|${t.carryRateBps}`;
    let fair = quoteCache.get(qk);
    if (fair === undefined) {
      fair = await quoteOrNull(chain, cfg, t);
      quoteCache.set(qk, fair);
    }

    const decision = evaluate({
      ...common,
      fairUsdc: fair,
      spend: {
        walletSpentTodayUsdc: walletSpentToday(db, owner, nowSecs),
        globalSpentTodayUsdc: globalSpentToday(db, nowSecs),
        floatUsdc: readFloat(db),
        oiUsd: readOi(db),
      },
    });

    tally.record({ orderPk, owner, mint, kind: ask.kind, price: ask.priceUsdc, fair, decision }, true);
    if (!decision.fill) continue;
    hb.onEligible();

    // ---- everything past here is the money path ----------------------------
    const ixs = await buildFillIxs(chain, ask, decision.quantity);
    const sim = await simulateFill(chain, ixs);
    if (!sim.ok) {
      log.warn("fill-sim-failed", { order: orderPk, err: sim.err });
      hb.onError();
      continue;
    }

    if (cfg.dryRun || !cfg.armed) {
      log.info("shadow-would-fill", {
        order: orderPk, owner, kind: ask.kind, qty: decision.quantity,
        costUsdc: +decision.costUsdc.toFixed(2), discountBps: decision.bandBps,
        oiCreatedUsd: +decision.oiCreatedUsd.toFixed(2),
        // Measured against the 400K budget on devnet, 2026-07-30:
        //   fill_writer_ask  76.2K-85.2K CU (avg 80.3K, max 21.3% of budget)
        //   fill_order       ~114K CU
        // The minting path is CHEAPER, which is counter-intuitive and worth
        // recording: mint_to does not fire the transfer hook, and that hook CPI
        // costs more than the extra pot/position/mint-record accounts do.
        cu: sim.unitsConsumed, dryRun: cfg.dryRun, armed: cfg.armed,
      });
      continue;
    }

    // Last look. The order was read at the top of the tick and priced since;
    // if it moved, the approval no longer applies to what is on chain.
    if (!(await confirmStillRestingUnchanged(chain, ask, decision.quantity))) {
      log.info("fill-abandoned", { order: orderPk, reason: "order changed since evaluation" });
      continue;
    }
    try {
      const sig = await sendFill(chain, ixs);
      recordFill(db, {
        sig, orderPk, owner, mint, kind: ask.kind,
        qty: decision.quantity, price: ask.priceUsdc, fair: fair ?? 0,
        bandBps: decision.bandBps, oiUsd: decision.oiCreatedUsd,
        ts: Math.floor(Date.now() / 1000),
      });
      filledThisTick++;
      hb.onFill();
      log.info("fill", {
        sig, order: orderPk, owner, qty: decision.quantity,
        costUsdc: +decision.costUsdc.toFixed(2), discountBps: decision.bandBps,
      });
    } catch (e: any) {
      hb.onError();
      log.error("fill-failed", { order: orderPk, err: String(e?.message ?? e).slice(0, 300) });
    }
  }

  tally.emit({
    scanned: asks.length, filled: filledThisTick,
    floatUsdc: +readFloat(db).toFixed(2), oiUsd: +readOi(db).toFixed(2),
  }, !cfg.dryRun && cfg.armed);
}

function candidateOf(ask: UserAsk, t: SeriesTerms): Candidate {
  return {
    orderPk: ask.pubkey.toBase58(),
    owner: ask.owner.toBase58(),
    optionMint: ask.optionMint.toBase58(),
    kind: ask.kind,
    priceUsdc: ask.priceUsdc,
    // Strike comes from the VAULT, which is the only place it is authoritative.
    // It sizes the OI cap on writerAsk and is unused on resaleAsk.
    strikeUsd: t.strikeUsd,
    quantityRemaining: ask.quantityRemaining,
    expiryTs: t.expiryTs,
    isEuropean: t.isEuropean,
  };
}

/** Fair value, or null on any quote revert. Never a fallback number. */
async function quoteOrNull(
  chain: Chain, cfg: TakerConfig,
  t: { market: PublicKey; strikeUsd: number; expiryTs: number; side: "call" | "put"; carryRateBps: number },
): Promise<number | null> {
  // The feed id lives on the market, not the vault. Cached per market for the
  // life of the process — it never changes for a given market.
  const feedId = await marketFeedId(chain, t.market);
  if (!feedId) return null;
  try {
    const q = await fetchQuote(chain.program, {
      market: t.market, pythFeedId: feedId, strike: t.strikeUsd,
      expiryTs: t.expiryTs, side: t.side, carryRateBps: t.carryRateBps,
    }, cfg.simPayer);
    return q.premiumPerContract;
  } catch (e) {
    if (e instanceof QuoteFailure) return null;
    throw e;
  }
}

const FEED_CACHE = new Map<string, Uint8Array | null>();
async function marketFeedId(chain: Chain, market: PublicKey): Promise<Uint8Array | null> {
  const k = market.toBase58();
  const hit = FEED_CACHE.get(k);
  if (hit !== undefined) return hit;
  let feed: Uint8Array | null = null;
  try {
    const m: any = await (chain.program.account as any).optionsMarket.fetch(market);
    feed = m.pythFeedId instanceof Uint8Array ? m.pythFeedId : Uint8Array.from(m.pythFeedId as number[]);
  } catch {
    feed = null;
  }
  FEED_CACHE.set(k, feed);
  return feed;
}

async function boot(): Promise<void> {
  const cfg = loadConfig();
  const pubkey = cfg.wallet.publicKey.toBase58();

  // THE ARMING PREREQ, ENFORCED IN CODE. The taker's own wallet must be in the
  // indexer's internal registry before it can spend: an unregistered taker would
  // appear on the campaign leaderboard as a top trader and its buys would be
  // scored as organic volume. Discipline says do this first; this check means
  // forgetting it stops the bot instead of poisoning the tape.
  if (!cfg.dryRun && cfg.armed && !isInternal(pubkey)) {
    log.fatal("arming-blocked", {
      msg: "taker wallet is not in indexer INTERNAL_WALLETS — add it and re-run a recompute before arming",
      wallet: pubkey,
      registrySize: INTERNAL_WALLETS.length,
    });
    process.exit(1);
  }

  const chain = await initChain(cfg);
  const db = openDb(cfg.dbPath);
  const [sol, usdc] = await Promise.all([getBalanceSol(chain), getFreeUsdc(chain)]);

  // BOOT MARKER (RULE 1). Everything an operator would otherwise have to infer
  // from the unit file is echoed here, so "is the band what I think it is" is
  // answerable from the journal alone.
  log.info("boot", {
    svc: "opta-taker",
    wallet: pubkey,
    registered: isInternal(pubkey),
    rpc: redactRpc(cfg.rpcUrl),
    db: cfg.dbPath,
    mode: cfg.dryRun ? "DRY_RUN" : cfg.armed ? "ARMED" : "SAFE(unarmed)",
    dryRun: cfg.dryRun,
    armed: cfg.armed,
    band: { minDiscountBps: cfg.minDiscountBps, maxDiscountBps: cfg.maxDiscountBps },
    budget: {
      perWalletDayUsdc: cfg.maxPerWalletDayUsdc,
      globalDayUsdc: cfg.maxGlobalDayUsdc,
      floatUsdc: cfg.maxFloatUsdc,
      perFillUsdc: cfg.maxFillUsdc,
      maxOiUsd: cfg.maxOiUsd,
    },
    timing: { minDelaySecs: cfg.minDelaySecs, maxDelaySecs: cfg.maxDelaySecs, minTteSecs: cfg.minTteSecs, tickMs: cfg.tickMs },
    balances: { sol: +sol.toFixed(4), usdc: +usdc.toFixed(2) },
    floatUsdc: +readFloat(db).toFixed(2),
    oiUsd: +readOi(db).toFixed(2),
  });
  if (sol < cfg.lowBalanceWarnSol) log.warn("low-sol", { sol: +sol.toFixed(4), warnAt: cfg.lowBalanceWarnSol });

  const hb = new Heartbeat();
  for (;;) {
    const started = Date.now();
    try {
      await tick(cfg, chain, db, hb);
    } catch (e: any) {
      hb.onError();
      log.error("tick-failed", { err: String(e?.message ?? e).slice(0, 300) });
    }
    hb.onTick();
    hb.maybeEmit(Date.now(), {
      mode: cfg.dryRun ? "DRY_RUN" : cfg.armed ? "ARMED" : "SAFE",
      floatUsdc: +readFloat(db).toFixed(2), oiUsd: +readOi(db).toFixed(2),
    });
    const elapsed = Date.now() - started;
    await new Promise((r) => setTimeout(r, Math.max(1000, cfg.tickMs - elapsed)));
  }
}

boot().catch((e) => {
  log.fatal("boot-failed", { err: String(e?.message ?? e).slice(0, 300) });
  process.exit(1);
});
