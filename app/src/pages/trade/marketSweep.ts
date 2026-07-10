// =============================================================================
// marketSweep.ts — multi-level Buy·Market / Sell·Market sweep (Phase 1)
// =============================================================================
//
// The single-level router (fill the best ask OR the peg, whole qty) stranded
// depth behind the best level (peg-1 + writerAsk-9 → filled 1). This walks the
// book across levels and composes up to 4 fills into ONE legacy tx (Phase-0
// decision: legacy, max 4 levels, no v0/LUT, no sequential chaining; >4 or a
// slippage breach = honest partial fill, never auto-post residual).
//
// Level ordering: buy = ascending price (peg + resting asks); sell = descending
// (resting bids; the vault peg is buy-only / American-only on-chain). Each level
// fills min(remaining, capacity). Stops when filled, the next level breaches
// max-slippage vs the best (reference) level, or 4 levels are used.
//
// Self-trade: the caller filters the taker's OWN resting orders OUT of `levels`
// (Phase-0: FE filter; the on-chain fill_order guard is deferred to the next
// program upgrade). fill_writer_ask already blocks self-buy on-chain.
// =============================================================================

import { Program, BN } from "@coral-xyz/anchor";
import { Transaction, ComputeBudgetProgram, type TransactionInstruction } from "@solana/web3.js";
import {
  loadOrderCtx, buildFillOrderIx, buildFillWriterAskIx, buildPegFillIx,
  type SeriesRef, type FillableOrder, type FillIxs,
} from "./orderFlows";

export type SweepSource = "peg" | "resaleAsk" | "writerAsk" | "bid";

export interface SweepLevel {
  source: SweepSource;
  price: number;          // per-contract USDC
  capacity: number;       // contracts fillable at this level
  order?: FillableOrder;  // resting levels only (resaleAsk / writerAsk / bid)
}
export interface SweepLeg extends SweepLevel { qty: number }

export type SweepStop = "filled" | "slippage" | "maxLevels" | "depth";
export interface SweepPlan {
  legs: SweepLeg[];
  requestedQty: number;
  filledQty: number;
  avgPrice: number | null;
  stop: SweepStop;
}

const MAX_LEVELS = 4;

/** Pure planner: order the levels, walk them under the slippage ceiling, cap at
 *  MAX_LEVELS. `avgPrice` weights each leg's price by its filled qty (peg price
 *  is the pre-trade estimate; resting-ask prices are exact). */
export function planSweep(args: {
  side: "buy" | "sell";
  qty: number;
  levels: SweepLevel[];
  slippagePct: number;
}): SweepPlan {
  const { side, qty, slippagePct } = args;
  const sorted = [...args.levels]
    .filter((l) => l.capacity > 0 && l.price > 0)
    .sort((a, b) => (side === "buy" ? a.price - b.price : b.price - a.price));

  const ref = sorted[0]?.price ?? null;
  const ceiling = ref == null ? null
    : side === "buy" ? ref * (1 + slippagePct / 100) : ref * (1 - slippagePct / 100);

  let remaining = qty;
  const legs: SweepLeg[] = [];
  let stop: SweepStop = "depth";
  for (const lvl of sorted) {
    if (legs.length >= MAX_LEVELS) { stop = "maxLevels"; break; }
    const breach = ceiling != null &&
      (side === "buy" ? lvl.price > ceiling * (1 + 1e-9) : lvl.price < ceiling * (1 - 1e-9));
    if (breach) { stop = "slippage"; break; }
    const legQty = Math.min(remaining, lvl.capacity);
    if (legQty <= 0) continue;
    legs.push({ ...lvl, qty: legQty });
    remaining -= legQty;
    if (remaining <= 0) { stop = "filled"; break; }
  }

  const filledQty = qty - remaining;
  const avgPrice = filledQty > 0
    ? legs.reduce((s, l) => s + l.price * l.qty, 0) / filledQty
    : null;
  return { legs, requestedQty: qty, filledQty, avgPrice, stop };
}

/** Compose the plan's legs into ONE legacy tx (deduped ATA pre-ixs + a single CU
 *  limit) and send. The peg leg's max_premium is the TOTAL ceiling (qty ×
 *  per-contract × (1+slip)), micro — the on-chain check is on the total. */
export async function executeSweep(
  program: Program<any>, ref: SeriesRef, plan: SweepPlan, slippagePct: number,
): Promise<string> {
  const ctx = await loadOrderCtx(program);
  const built: FillIxs[] = [];
  for (const leg of plan.legs) {
    if (leg.source === "peg") {
      const ceilPerContract = leg.price * (1 + slippagePct / 100);
      const maxTotalMicro = new BN(Math.ceil(ceilPerContract * leg.qty * 1_000_000));
      built.push(await buildPegFillIx(program, ref, leg.qty, maxTotalMicro, ctx));
    } else if (leg.source === "writerAsk") {
      built.push(await buildFillWriterAskIx(program, leg.order!, leg.qty, ctx));
    } else {
      // resaleAsk (buy) or bid (sell) — both go through fill_order.
      built.push(await buildFillOrderIx(program, leg.order!, leg.qty, ctx));
    }
  }

  // Dedupe idempotent ATA pre-ixs by the ATA they create (keys[1]).
  const seen = new Set<string>();
  const pre: TransactionInstruction[] = [];
  for (const b of built) {
    for (const ix of b.pre) {
      const key = ix.keys[1]?.pubkey.toBase58();
      if (key && seen.has(key)) continue;
      if (key) seen.add(key);
      pre.push(ix);
    }
  }
  const fills = built.map((b) => b.fill);

  // One CU limit for the whole tx (~220K/leg + headroom), capped at the 1.4M max.
  const cu = Math.min(1_400_000, 220_000 * plan.legs.length + 120_000);
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ...pre, ...fills);
  return await (program.provider as any).sendAndConfirm(tx);
}
