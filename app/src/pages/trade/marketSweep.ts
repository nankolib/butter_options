// =============================================================================
// marketSweep.ts — market sweep (Phase 1) + marketable-limit crossing (Phase 2)
// =============================================================================
//
// The single-level router stranded depth behind the best level. planSweep walks
// the book across levels; executeSweep composes up to 4 fills into ONE legacy tx
// (Phase-0: legacy, max 4 levels, no v0/LUT, no sequential chaining; >4 or a
// ceiling breach = honest partial, never auto-post residual).
//
// Phase 2 adds crossLimit: a marketable Buy·Limit (limit ≥ best ask) crosses —
// sweeps every level with price ≤ the LIMIT (the limit IS the ceiling, no
// separate slippage), then the caller rests the residual at the limit. TWO-TX
// model. RIDER: before the residual rests, re-check the (refetched) book once;
// if it moved and the residual is marketable again, run ONE more sweep, then rest
// whatever remains (no infinite loop). Symmetric for Sell·Limit.
//
// Self-trade: level builders drop the taker's OWN orders (Phase-0 FE policy;
// fill_writer_ask also blocks self-buy on-chain).
// =============================================================================

import { Program, BN } from "@coral-xyz/anchor";
import { Transaction, ComputeBudgetProgram, type TransactionInstruction } from "@solana/web3.js";
import { fetchBook, invalidateBookCache, type BookOrder } from "../../utils/exchangeData";
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

// ---- Level builders (shared by market sweep + limit crossing) ---------------
const asFillable = (o: BookOrder): FillableOrder =>
  ({ pubkey: o.pubkey, owner: o.owner, optionMint: o.optionMint, vault: o.vault, kind: o.kind });

/** Ask side (buy): resting resale+writer asks (not the taker's) + the vault peg
 *  when priced with capacity. */
export function buildAskLevels(
  orders: BookOrder[], optionMint: string, taker: string,
  pegAsk: number | null, pegCapacity: number,
): SweepLevel[] {
  const levels: SweepLevel[] = orders
    .filter((o) => o.optionMint === optionMint && o.kind !== "bid" && o.owner !== taker)
    .map((o) => ({ source: o.kind === "writerAsk" ? "writerAsk" : "resaleAsk", price: o.price, capacity: o.qty, order: asFillable(o) }));
  if (pegAsk != null && pegCapacity > 0) levels.push({ source: "peg", price: pegAsk, capacity: pegCapacity });
  return levels;
}

/** Bid side (sell): resting bids (not the taker's). No peg on the sell side. */
export function buildBidLevels(orders: BookOrder[], optionMint: string, taker: string): SweepLevel[] {
  return orders
    .filter((o) => o.optionMint === optionMint && o.kind === "bid" && o.owner !== taker)
    .map((o) => ({ source: "bid", price: o.price, capacity: o.qty, order: asFillable(o) }));
}

/** Pure planner: order the levels, walk them under the ceiling, cap at 4 levels.
 *  `priceCeiling` (marketable limits) is an absolute per-contract cap; otherwise
 *  the ceiling derives from `slippagePct` vs the best level. */
export function planSweep(args: {
  side: "buy" | "sell";
  qty: number;
  levels: SweepLevel[];
  slippagePct: number;
  priceCeiling?: number;
}): SweepPlan {
  const { side, qty, slippagePct, priceCeiling } = args;
  const sorted = [...args.levels]
    .filter((l) => l.capacity > 0 && l.price > 0)
    .sort((a, b) => (side === "buy" ? a.price - b.price : b.price - a.price));

  const ref = sorted[0]?.price ?? null;
  const ceiling = priceCeiling != null
    ? priceCeiling
    : ref == null ? null
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
  const avgPrice = filledQty > 0 ? legs.reduce((s, l) => s + l.price * l.qty, 0) / filledQty : null;
  return { legs, requestedQty: qty, filledQty, avgPrice, stop };
}

/** Compose the plan's legs into ONE legacy tx (deduped ATA pre-ixs + a single CU
 *  limit) and send. The peg leg's max_premium is the TOTAL ceiling (qty ×
 *  per-contract), micro. `pegMaxPerContract` overrides it (marketable limit = the
 *  limit price); otherwise it's the leg price + slippage. */
export async function executeSweep(
  program: Program<any>, ref: SeriesRef, plan: SweepPlan, slippagePct: number,
  pegMaxPerContract?: number,
): Promise<string> {
  const ctx = await loadOrderCtx(program);
  const built: FillIxs[] = [];
  for (const leg of plan.legs) {
    if (leg.source === "peg") {
      const ceilPerContract = pegMaxPerContract ?? leg.price * (1 + slippagePct / 100);
      const maxTotalMicro = new BN(Math.ceil(ceilPerContract * leg.qty * 1_000_000));
      built.push(await buildPegFillIx(program, ref, leg.qty, maxTotalMicro, ctx));
    } else if (leg.source === "writerAsk") {
      built.push(await buildFillWriterAskIx(program, leg.order!, leg.qty, ctx));
    } else {
      built.push(await buildFillOrderIx(program, leg.order!, leg.qty, ctx));
    }
  }

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
  const cu = Math.min(1_400_000, 220_000 * plan.legs.length + 120_000);
  const tx = new Transaction().add(ComputeBudgetProgram.setComputeUnitLimit({ units: cu }), ...pre, ...fills);
  return await (program.provider as any).sendAndConfirm(tx);
}

// ---- Marketable-limit crossing (Phase 2) ------------------------------------
export interface CrossResult {
  sweepSigs: string[];
  filledQty: number;
  avgPrice: number | null;
  removed: string[];   // fully-consumed resting-order pubkeys (optimistic remove)
  riderRan: boolean;   // whether the extra re-check iteration executed a fill
}

/** Cross a marketable limit: sweep levels with price within the LIMIT, up to 4
 *  levels; then (RIDER) re-check the refetched book ONCE and, if it moved and the
 *  residual is still marketable, run ONE more sweep. Returns the fill outcome; the
 *  caller rests the residual (qty − filledQty) at the limit as a second tx. */
export async function crossLimit(
  program: Program<any>, ref: SeriesRef,
  args: {
    side: "buy" | "sell"; qty: number; limitPrice: number; taker: string;
    optionMint: string; orders: BookOrder[]; pegAsk: number | null; pegCapacity: number;
  },
): Promise<CrossResult> {
  const sigs: string[] = [];
  const removed: string[] = [];
  let filled = 0;
  let weighted = 0;
  let remaining = args.qty;
  let riderRan = false;

  for (let iter = 0; iter < 2 && remaining > 0; iter++) {
    // iter 0 uses the render-snapshot book; iter 1 (RIDER) refetches fresh so a
    // book that moved while tx1 confirmed can be crossed once more. The peg is
    // only offered on iter 0 (its capacity re-read needs a vault fetch); the RIDER
    // targets NEW resting orders.
    const orders = iter === 0 ? args.orders : await freshBook(program);
    const levels = args.side === "buy"
      ? buildAskLevels(orders, args.optionMint, args.taker, iter === 0 ? args.pegAsk : null, iter === 0 ? args.pegCapacity : 0)
      : buildBidLevels(orders, args.optionMint, args.taker);
    const plan = planSweep({ side: args.side, qty: remaining, levels, slippagePct: 0, priceCeiling: args.limitPrice });
    if (!plan.legs.length) break;
    try {
      const sig = await executeSweep(program, ref, plan, 0, args.limitPrice);
      sigs.push(sig);
      filled += plan.filledQty;
      remaining -= plan.filledQty;
      weighted += plan.legs.reduce((s, l) => s + l.price * l.qty, 0);
      for (const l of plan.legs) if (l.order && l.qty >= l.capacity) removed.push(l.order.pubkey);
      if (iter === 1) riderRan = true;
    } catch {
      // A RIDER re-sweep can revert on a stale order (gPA lag) — that's fine, stop
      // and let the caller rest the residual. iter-0 failures propagate.
      if (iter === 0) throw new Error("Sweep failed — book changed, please retry.");
      break;
    }
  }

  return { sweepSigs: sigs, filledQty: filled, avgPrice: filled > 0 ? weighted / filled : null, removed, riderRan };
}

async function freshBook(program: Program<any>): Promise<BookOrder[]> {
  invalidateBookCache(program.programId);
  return fetchBook(program.provider.connection, program.programId);
}
