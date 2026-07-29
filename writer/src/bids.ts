// =============================================================================
// bids.ts — dependent-quote bid derivation (C0, pure).
// =============================================================================
// The writer quotes both sides. The BID is never an independent quote: it is
// re-derived only when the ask on the same series is posted, repriced, pulled or
// held, and it is refused outright whenever there is no resting ask to anchor to.
// That single rule is what makes the no-cross invariant hold BY CONSTRUCTION
// rather than by periodic check.
//
// WHY A BID IS PRICED WIDER THAN AN ASK. Three structural reasons, none stylistic:
//   1. A filled bid makes the writer a LONG holder, and there is no net-off
//      on-chain — nothing burns a long against the writer's own short. The short
//      lives in WriterAskPosition.contracts_written + the series pot; the long
//      lives as SPL tokens. They never meet.
//   2. Early exercise is unavailable on writer-ask-backed series:
//      american_exercise_core pays from vault_usdc_account, and writer-created
//      vaults are 0-pool shells — the pot only merges into the vault at
//      settle_vault, post-expiry. So a bought contract has no early exit.
//   3. Adverse selection is worse on the bid: informed flow sells you options
//      that are about to expire worthless.
// Together (1) and (2) mean bid inventory can only be recycled (relist as
// ResaleAsk) or held to settlement — hence the inventory cap and the relist
// decision at the bottom of this file.
//
// ⚠️ NO-CROSS IS THE WHOLE BALLGAME. There is NO on-chain cross check —
// post_order never inspects other orders and the book has no matching engine.
// The self-trade guard (CannotBuyOwnOption 6023) only stops the writer filling
// its OWN order; it does nothing against a third party buying a stale ask and
// dumping into a crossed bid. The comparison below is therefore against the
// RESTING ask price read from chain, never the freshly computed one — ask
// staleness IS the failure mode.
// =============================================================================

/** Bid must sit at least this far under the RESTING ask. Must strictly exceed a
 *  full round trip (2 x fee_bps = 100bps at the current 50bps fee) or a crossed
 *  book is directly profitable to an arbitrageur. */
export const CROSS_GUARD_BPS = 200;

/** One USDC tick (6dp). post_order requires price_per_contract > 0, so anything
 *  that rounds below this must be skipped rather than posted. */
export const TICK_USDC = 0.000001;

/** Bid spread = max(ask x MULT, ask + FLOOR_ADD). The multiplier governs normal
 *  tiers; the additive floor stops a tight ask spread producing a bid spread too
 *  thin to cover the round-trip fee. */
export const BID_SPREAD_MULT = 1.5;
export const BID_SPREAD_FLOOR_ADD_BPS = 200;

/** Bids pull on the FIRST quote failure, not the second. A resting bid is the
 *  classic pick-off target on a gap (someone dumps into it), so it gets a
 *  tighter trigger than the ask's OPTA_WRITER_QUOTE_FAIL_PULL_THRESHOLD. */
export const BID_QUOTE_FAIL_PULL_THRESHOLD = 1;

/**
 * ATM BAND — a CODE bound, not a config throttle.
 *
 * Bids are quoted only on the ATM rung and `atmRungs` rungs either side
 * (0 = ATM only). This is deliberately enforced here rather than left to
 * BID_MAX_CELLS / the assets allow-list: caps decide HOW MUCH is quoted inside
 * the band, they must never be the thing that decides WHERE. A cap is a number
 * an operator can raise by accident; the wing exclusion is a property of the
 * strategy — wing bids buy the contracts most likely to expire worthless, which
 * is exactly the inventory that cannot be netted off or exercised early.
 */
export interface BidPolicy {
  enabled: boolean;
  /** Rungs either side of ATM that may carry a bid. 0 = ATM only. */
  atmRungs: number;
  maxNotionalPerAsset: number;
  maxNotionalGlobal: number;
  reserveUsdc: number;
  /** 0 = uncapped (mirrors OPTA_WRITER_MAX_CELLS). */
  maxCells: number;
  maxLongPerSeries: number;
  depthFrac: number;
  driftBps: number;
  maxAgeMs: number;
}

/** What happened to the ask on this series THIS tick. The bid is derived from it. */
export type AskOutcome = "posted" | "repriced" | "held" | "pulled" | "absent";

export interface ExistingBid {
  price: number;
  qty: number;
  createdAtMs: number;
}

export interface BidDecisionInput {
  policy: BidPolicy;
  askOutcome: AskOutcome;
  /** Integer rung distance from ATM (0 = ATM). From TargetCell.rungIndex. */
  rungIndex: number;
  /** The ask price actually RESTING on chain. null when there is none. */
  restingAskPrice: number | null;
  mark: number;
  askSpreadBps: number;
  askQty: number;
  existingBid: ExistingBid | null;
  heldLong: number;
  assetBidNotional: number;
  globalBidNotional: number;
  /** Free USDC AFTER the ask loop has taken its budget. Asks have priority. */
  freeUsdcAfterAsks: number;
  liveBidCells: number;
  marketOpen: boolean;
  quoteFails: number;
  oracleReady: boolean;
  nowMs: number;
}

export type BidDecision =
  | { action: "post"; price: number; qty: number; notional: number }
  | { action: "reprice"; price: number; qty: number; notional: number }
  | { action: "pull"; reason: string }
  | { action: "hold" }
  | { action: "skip"; reason: string };

export interface RelistInput {
  enabled: boolean;
  heldLong: number;
  alreadyListed: number;
  askPrice: number;
}

export type RelistDecision =
  | { action: "relist"; qty: number; price: number }
  | { action: "none"; reason: string };

// ---- primitives -------------------------------------------------------------

export function bidSpreadBps(askSpreadBps: number): number {
  return Math.max(askSpreadBps * BID_SPREAD_MULT, askSpreadBps + BID_SPREAD_FLOOR_ADD_BPS);
}

export function bidPriceFrom(mark: number, askSpreadBps: number): number {
  return mark * (1 - bidSpreadBps(askSpreadBps) / 10_000);
}

export function roundsToZero(price: number): boolean {
  return !(price >= TICK_USDC);
}

/** True when `bidPrice` is close enough to the RESTING ask to make a third-party
 *  round trip (buy the ask, sell into the bid) profitable. */
export function crossesAsk(bidPrice: number, restingAskPrice: number, guardBps = CROSS_GUARD_BPS): boolean {
  if (!(restingAskPrice > 0)) return true; // no anchor ⇒ treat as crossing (fail closed)
  return bidPrice > restingAskPrice * (1 - guardBps / 10_000);
}

/** True when a cell is inside the ATM band and may carry a bid at all. */
export function withinAtmBand(rungIndex: number, atmRungs: number): boolean {
  return rungIndex <= atmRungs;
}

export function bidDepth(askQty: number, depthFrac: number): number {
  return Math.max(1, Math.round(askQty * depthFrac));
}

/** USDC available to bids: whatever the ask loop left, less the untouchable
 *  reserve. Never negative. */
export function bidBudgetRemaining(freeUsdcAfterAsks: number, reserveUsdc: number): number {
  return Math.max(0, freeUsdcAfterAsks - reserveUsdc);
}

// ---- the decision -----------------------------------------------------------

/**
 * Route one series' bid for this tick. Ordering is load-bearing:
 *   disabled → oracle → market hours → quote health → ask anchor → price
 *   sanity → cross guard → inventory → budget → post/reprice/hold.
 *
 * `pull` is emitted only when a bid is actually resting; otherwise the same
 * condition yields `skip`. The one exception is `disabled`, which is inert — it
 * never pulls, so flipping the flag off mid-flight leaves existing bids for a
 * deliberate operator sweep rather than mass-cancelling on a config change.
 */
export function decideBid(inp: BidDecisionInput): BidDecision {
  const p = inp.policy;
  const resting = inp.existingBid;
  const stop = (reason: string): BidDecision =>
    resting ? { action: "pull", reason } : { action: "skip", reason };

  // Flag first, and INERT: never pull on a config flip.
  if (!p.enabled) return { action: "skip", reason: "disabled" };

  // ATM band is the CODE bound and is checked before anything else, so a wing
  // cell can never reach pricing or budget logic regardless of how wide the caps
  // are set. Tightening the band DOES pull an out-of-band bid — unlike the
  // enabled flag, a narrower band means those bids are no longer wanted.
  if (!withinAtmBand(inp.rungIndex, p.atmRungs)) return stop("out-of-atm-band");

  if (!inp.oracleReady) return stop("oracle-not-ready");
  if (!inp.marketOpen) return stop("market-closed");
  if (inp.quoteFails >= BID_QUOTE_FAIL_PULL_THRESHOLD) return stop("quote-fail");

  // Dependent-quote invariant: no live ask ⇒ no bid. A bid without an ask anchor
  // has nothing to measure the cross guard against.
  const anchored =
    inp.askOutcome !== "pulled" &&
    inp.askOutcome !== "absent" &&
    inp.restingAskPrice != null &&
    inp.restingAskPrice > 0;
  if (!anchored) return stop("no-ask-anchor");
  const askPrice = inp.restingAskPrice as number;

  const price = bidPriceFrom(inp.mark, inp.askSpreadBps);
  if (roundsToZero(price)) return stop("rounds-to-zero");
  if (crossesAsk(price, askPrice)) return stop("would-cross");

  // Inventory headroom — a full fill must not breach the cap.
  const headroom = p.maxLongPerSeries - inp.heldLong;
  if (headroom <= 0) return stop("inventory-cap");

  const qty = Math.min(bidDepth(inp.askQty, p.depthFrac), headroom);
  const notional = price * qty;

  // Budget is charged on the DELTA: a reprice releases the old escrow and locks
  // the new one, so only the increase consumes fresh headroom.
  const restingNotional = resting ? resting.price * resting.qty : 0;
  const delta = Math.max(0, notional - restingNotional);

  if (!resting && p.maxCells > 0 && inp.liveBidCells >= p.maxCells) return stop("cell-cap");
  if (inp.assetBidNotional + delta > p.maxNotionalPerAsset) return stop("asset-cap");
  if (inp.globalBidNotional + delta > p.maxNotionalGlobal) return stop("global-cap");
  if (delta > bidBudgetRemaining(inp.freeUsdcAfterAsks, p.reserveUsdc)) return stop("budget-reserve");

  if (!resting) return { action: "post", price, qty, notional };

  // Same shape as the ask side's repriceDecision: drift always acts, age is
  // ε-gated by the caller's threshold.
  const drift = resting.price > 0 ? Math.abs(price - resting.price) / resting.price : 1;
  const age = resting.createdAtMs > 0 ? inp.nowMs - resting.createdAtMs : Infinity;
  if (drift * 10_000 > p.driftBps || age > p.maxAgeMs) {
    return { action: "reprice", price, qty, notional };
  }
  return { action: "hold" };
}

/**
 * Inventory disposal (C3 wires the ix; this is the decision).
 *
 * A filled bid leaves the writer LONG with no net-off and no early exercise, so
 * the only way to recycle capital before expiry is to re-list the contracts as a
 * ResaleAsk — which escrows the TOKENS and costs no USDC, making bought-back
 * inventory strictly cheaper to offer than writing a fresh WriterAsk (which
 * locks strike x qty). Relist only the unlisted remainder so a partially listed
 * position is never double-escrowed.
 */
export function decideRelist(inp: RelistInput): RelistDecision {
  if (!inp.enabled) return { action: "none", reason: "disabled" };
  if (!(inp.askPrice > 0)) return { action: "none", reason: "no-ask-price" };
  const qty = inp.heldLong - inp.alreadyListed;
  if (qty <= 0) return { action: "none", reason: "nothing-unlisted" };
  return { action: "relist", qty, price: inp.askPrice };
}
