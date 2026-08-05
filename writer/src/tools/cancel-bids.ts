// =============================================================================
// tools/cancel-bids.ts — cancel the writer's resting BIDS (manual unwind).
// =============================================================================
// The bid-side twin of cancel-all.ts, and the tool `engine.ts:460` has always
// pointed at without it existing:
//
//   "The flag is INERT, not a kill switch: disabled means this pass does nothing
//    at all — it does not even sweep resting bids, so flipping it off leaves them
//    for a deliberate operator unwind rather than mass-cancelling."
//
// That deliberate operator unwind had no implementation. Setting
// OPTA_WRITER_BID_ENABLED=0 freezes bids; it does not retire them. And
// cancel-all.ts cannot do it either — it drives off enumerateMyOrders, which
// filters to WriterAsk (discovery.ts:151), so a bid pubkey passed to it matches
// nothing and it reports `toCancel: 0`. Found the hard way on 2026-08-05 while
// executing the drain the 2026-08-03 handoff had specified as a flag cycle.
//
// SAFETY: this tool enumerates BIDS ONLY (enumerateMyBids), so it can never
// touch the ask board — which at the time of writing is the only sell-side depth
// users can trade against, and whose accidental cancellation is exactly what the
// 2026-08-03 "no drain" decision was protecting. Cancelling a bid returns the
// full USDC escrow, closes the order + escrow, and refunds rent to the wallet.
//
// Ignores OPTA_WRITER_ENABLED / DRY_RUN — like cancel-all, this is an explicit,
// deliberately-invoked unwind, never automatic.
//
// Pass order pubkeys to cancel only those; with no args it cancels ALL of the
// wallet's resting bids.
//   node dist/tools/cancel-bids.js [<orderPubkey> ...]
//
// Run it with the bid pass DISABLED (OPTA_WRITER_BID_ENABLED=0) — otherwise the
// engine reposts on the next tick and the drain never converges.
// =============================================================================

import { loadConfig } from "../env";
import { initChain, sendTx, getBalanceSol, getFreeUsdc } from "../chain";
import { enumerateMyBids } from "../discovery";
import { cancelOrderIx, CU, type BuildCtx } from "../builders";
import { log } from "../log";

async function main(): Promise<void> {
  const cfg = loadConfig();
  const chain = await initChain(cfg);
  const ctx: BuildCtx = {
    program: chain.program,
    owner: chain.wallet.publicKey,
    protocolState: chain.protocolState,
    usdcMint: chain.usdcMint,
    epochConfig: chain.epochConfig,
  };

  const filter = new Set(process.argv.slice(2).map((s) => s.trim()).filter(Boolean));
  const all = await enumerateMyBids(chain.program, chain.wallet.publicKey);
  const targets = filter.size ? all.filter((o) => filter.has(o.pubkey.toBase58())) : all;

  const notional = (b: (typeof all)[number]) =>
    (Number(b.priceMicro) / 1e6) * Number(b.quantityRemaining);

  log.info("cancel-bids-start", {
    wallet: chain.wallet.publicKey.toBase58(),
    bidsTotal: all.length,
    toCancel: targets.length,
    notionalToCancel: Number(targets.reduce((s, b) => s + notional(b), 0).toFixed(6)),
    solBefore: await getBalanceSol(chain),
    freeUsdcBefore: await getFreeUsdc(chain),
  });

  // A pubkey that was asked for but is not a live bid is reported, not ignored:
  // silently cancelling 0 of 16 is exactly the failure mode that wasted a step.
  if (filter.size) {
    const found = new Set(targets.map((t) => t.pubkey.toBase58()));
    const missing = [...filter].filter((k) => !found.has(k));
    if (missing.length) log.info("cancel-bids-not-found", { count: missing.length, orders: missing });
  }

  let cancelled = 0;
  let failed = 0;
  for (const o of targets) {
    try {
      const ix = await cancelOrderIx(ctx, o.optionMint, o.pubkey);
      const sig = await sendTx(chain, [CU(400_000), ix]);
      cancelled += 1;
      log.info("cancel-bid-ok", {
        order: o.pubkey.toBase58(),
        notional: Number(notional(o).toFixed(6)),
        sig,
      });
    } catch (e) {
      failed += 1;
      log.error("cancel-bid-fail", {
        order: o.pubkey.toBase58(),
        err: String((e as Error)?.message ?? e).slice(0, 200),
      });
    }
  }

  const remaining = await enumerateMyBids(chain.program, chain.wallet.publicKey);
  log.info("cancel-bids-done", {
    cancelled,
    failed,
    remainingBids: remaining.length,
    remainingNotional: Number(remaining.reduce((s, b) => s + notional(b), 0).toFixed(6)),
    solAfter: await getBalanceSol(chain),
    freeUsdcAfter: await getFreeUsdc(chain),
  });
}

main().catch((e) => {
  log.error("cancel-bids-fatal", { err: String(e?.message ?? e) });
  process.exit(1);
});
