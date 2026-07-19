// =============================================================================
// sweepPlan.ts — PURE sweep planners (no anchor/web3 runtime deps).
// =============================================================================
// Split out of marketSweep.ts so the level builders, planSweep, and the
// buyRoutesToPeg gate predicate are unit-testable in isolation (importing
// marketSweep pulls the anchor/web3/orderFlows executor graph). marketSweep.ts
// re-exports everything here, so existing `from "./marketSweep"` imports are
// unchanged. Type-only imports (erased at runtime) keep this module dep-free.
// =============================================================================
import type { BookOrder } from "../../utils/exchangeData";
import type { FillableOrder } from "./orderFlows";

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

/** Does a BUY at these terms route to the vault PEG (model-priced) rather than
 *  filling purely on resting maker asks? Only a peg-minting fill needs a fresh
 *  on-chain quote; a fill that lands entirely on resting writer/resale asks
 *  executes at the makers' FIXED prices and needs no model quote. We plan the
 *  sweep against resting asks ONLY (peg excluded): a limit below the best resting
 *  ask just rests a bid (no fill → false); otherwise, if the book can't cover the
 *  requested qty within the ceiling, the order spills to the peg → true. This is
 *  the predicate that un-gates writer-ask book fills while still guarding
 *  peg-minting buys. */
export function buyRoutesToPeg(args: {
  orders: BookOrder[]; optionMint: string; taker: string;
  type: "market" | "limit"; limitPrice: number; qty: number; slippagePct: number;
}): boolean {
  const restingAsks = buildAskLevels(args.orders, args.optionMint, args.taker, null, 0); // peg EXCLUDED
  const priced = restingAsks.filter((l) => l.capacity > 0 && l.price > 0);
  const bestRestingAsk = priced.length ? Math.min(...priced.map((l) => l.price)) : null;
  // A limit BELOW the best resting ask just rests a bid — no immediate fill.
  const attemptsFill = args.type === "market" || (bestRestingAsk != null && args.limitPrice >= bestRestingAsk);
  if (!attemptsFill) return false;
  const plan = planSweep({
    side: "buy", qty: args.qty, levels: restingAsks, slippagePct: args.slippagePct,
    priceCeiling: args.type === "limit" ? args.limitPrice : undefined,
  });
  return plan.filledQty < args.qty; // book can't fully cover → spills to the peg
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
