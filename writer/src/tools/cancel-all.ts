// =============================================================================
// tools/cancel-all.ts — cancel the writer's resting orders (manual unwind).
// =============================================================================
// One-shot maintenance CLI. Enumerates every RestingOrder owned by the bot
// wallet and cancels each (cancel_order → full escrow back to the wallet, order
// + escrow closed, rent → wallet). Used to unwind asks when retargeting or
// freezing an asset. Ignores OPTA_WRITER_ENABLED/DRY_RUN — it is an explicit,
// deliberately-invoked unwind, never automatic.
//
// Optionally pass order pubkeys as args to cancel only those; with no args it
// cancels ALL of the wallet's WriterAsks.
//   node dist/tools/cancel-all.js [<orderPubkey> ...]
// =============================================================================

import { loadConfig } from "../env";
import { initChain, sendTx, getBalanceSol, getFreeUsdc } from "../chain";
import { enumerateMyOrders } from "../discovery";
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
  const all = await enumerateMyOrders(chain.program, chain.wallet.publicKey);
  const targets = filter.size ? all.filter((o) => filter.has(o.pubkey.toBase58())) : all;

  log.info("cancel-all-start", {
    wallet: chain.wallet.publicKey.toBase58(),
    ordersTotal: all.length,
    toCancel: targets.length,
    solBefore: await getBalanceSol(chain),
    freeUsdcBefore: await getFreeUsdc(chain),
  });

  let cancelled = 0, failed = 0;
  for (const o of targets) {
    try {
      const ix = await cancelOrderIx(ctx, o.optionMint, o.pubkey);
      const sig = await sendTx(chain, [CU(400_000), ix]);
      cancelled++;
      log.info("cancel-ok", { order: o.pubkey.toBase58(), optionMint: o.optionMint.toBase58(), sig });
    } catch (e: any) {
      failed++;
      log.error("cancel-fail", { order: o.pubkey.toBase58(), err: String(e?.message ?? e).slice(0, 200) });
    }
  }

  const remaining = await enumerateMyOrders(chain.program, chain.wallet.publicKey);
  log.info("cancel-all-done", {
    cancelled, failed, remaining: remaining.length,
    solAfter: await getBalanceSol(chain),
    freeUsdcAfter: await getFreeUsdc(chain),
  });
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => { log.fatal("cancel-all-crashed", { err: String(e?.message ?? e).slice(0, 300) }); process.exit(1); });
