// =============================================================================
// eligibility.ts — THE ANTI-EXPLOIT FRAMEWORK (PURE)
// =============================================================================
//
// Every reason the treasury may refuse an order lives here, as a pure function
// of (order, fair value, clock, config). No I/O, no clock reads, no randomness
// — `now` and the sampled delay are injected, so every decision is reproducible
// and unit-testable. This module is the whole safety story; the rest of the
// service is plumbing around it.
//
// THE THREAT. The treasury is a standing bid of last resort, so it is ALWAYS the
// uninformed side: the user chooses what to sell and when. Every gate below
// exists because of a specific way that asymmetry can be turned into a
// withdrawal.
// =============================================================================

/** Every distinct reason a candidate is refused. Logged verbatim in shadow. */
export type RejectReason =
  | "internal_owner"
  | "not_a_wallet"
  | "self_owned"
  | "european"
  | "settled"
  | "voided"
  | "no_fair_value"
  | "above_band"
  | "below_band"
  | "too_near_expiry"
  | "wallet_budget"
  | "global_budget"
  | "float_cap"
  | "delay_pending"
  | "oi_cap"
  | "zero_quantity";

/**
 * Which side of the book the candidate is, and it changes the economics more
 * than it looks:
 *
 *   resaleAsk  a holder selling contracts that ALREADY EXIST. Filling it
 *              TRANSFERS open interest — someone else's position becomes ours.
 *   writerAsk  a user writing NEW contracts against escrowed collateral.
 *              Filling it MINTS, so it CREATES open interest that did not exist
 *              before, and the taker's eventual exit problem grows rather than
 *              moves.
 *
 * That asymmetry is why `maxOiUsd` exists and applies to writerAsk only.
 */
export type CandidateKind = "resaleAsk" | "writerAsk";

export interface BandConfig {
  /** Minimum discount to fair we require. Never pay within this of fair. */
  minDiscountBps: number;
  /** Maximum discount we will accept. Below this the price is not a bargain. */
  maxDiscountBps: number;
}

export interface TakerLimits extends BandConfig {
  minTteSecs: number;
  maxFillUsdc: number;
  maxPerWalletDayUsdc: number;
  maxGlobalDayUsdc: number;
  maxFloatUsdc: number;
  /**
   * Ceiling on open-interest notional the taker may CREATE via writerAsk fills,
   * measured as strike x contracts minted to us.
   *
   * Deliberately NOT the same thing as maxFloatUsdc. Float bounds cash paid out
   * — premium, which is small. This bounds the position we are left holding,
   * which is strike-sized and therefore roughly two orders of magnitude larger.
   * A $10k float cap would happily let the taker mint six figures of OI before
   * binding, so without this the exit problem is effectively uncapped.
   */
  maxOiUsd: number;
}

export interface Candidate {
  orderPk: string;
  owner: string;
  optionMint: string;
  kind: CandidateKind;
  /** micro-USDC per contract. */
  priceUsdc: number;
  /** Strike in human USD. Only meaningful for OI sizing on writerAsk. */
  strikeUsd: number;
  quantityRemaining: number;
  expiryTs: number;
  isEuropean: boolean;
}

export interface Spend {
  walletSpentTodayUsdc: number;
  globalSpentTodayUsdc: number;
  floatUsdc: number;
  /** Open-interest notional the taker currently carries from writerAsk fills. */
  oiUsd: number;
}

export type Decision =
  | { fill: true; quantity: number; costUsdc: number; bandBps: number; oiCreatedUsd: number }
  | { fill: false; reason: RejectReason; detail?: string };

/**
 * Discount of `ask` below `fair`, in bps. Positive = cheaper than fair.
 * Negative = the ask is ABOVE fair.
 */
export function discountBps(askUsdc: number, fairUsdc: number): number {
  if (!(fairUsdc > 0)) return Number.NaN;
  return Math.round(((fairUsdc - askUsdc) / fairUsdc) * 10_000);
}

/**
 * THE BAND — deliberately two-sided, and the asymmetry is the point.
 *
 * UPPER bound (never pay within `minDiscountBps` of fair): adverse-selection
 * compensation. The seller picks the moment, so a fill at fair is a losing
 * trade in expectation. The discount is the treasury's edge for standing there.
 *
 * LOWER bound (refuse anything cheaper than `maxDiscountBps`): a CIRCUIT
 * BREAKER, not a bargain filter. An ask 60% under model almost never means free
 * money — it means stale vol, a model bug, or a crafted order. Declining to
 * take "free" money is counter-intuitive and is exactly the behaviour that
 * survives a bad oracle day.
 */
export function withinBand(askUsdc: number, fairUsdc: number, cfg: BandConfig): "ok" | "above_band" | "below_band" {
  const d = discountBps(askUsdc, fairUsdc);
  if (!Number.isFinite(d)) return "above_band";
  if (d < cfg.minDiscountBps) return "above_band"; // too close to (or over) fair
  if (d > cfg.maxDiscountBps) return "below_band"; // implausibly cheap
  return "ok";
}

/** OI notional a fill of `qty` would CREATE. Zero unless we are minting. */
export function oiCreatedUsd(c: Candidate, qty: number): number {
  return c.kind === "writerAsk" ? qty * Math.max(0, c.strikeUsd) : 0;
}

/**
 * Largest quantity affordable under the per-fill cap and every budget.
 *
 * The cash budgets divide by PRICE (what we pay); the OI budget divides by
 * STRIKE (what we end up holding). Using price for both would understate OI by
 * the ratio of premium to strike — typically 50-200x — and the cap would never
 * bind.
 */
export function affordableQuantity(c: Candidate, limits: TakerLimits, spend: Spend): number {
  if (!(c.priceUsdc > 0) || c.quantityRemaining <= 0) return 0;
  const cashHeadroom = Math.min(
    limits.maxFillUsdc,
    Math.max(0, limits.maxPerWalletDayUsdc - spend.walletSpentTodayUsdc),
    Math.max(0, limits.maxGlobalDayUsdc - spend.globalSpentTodayUsdc),
    Math.max(0, limits.maxFloatUsdc - spend.floatUsdc),
  );
  let qty = Math.min(c.quantityRemaining, Math.floor(cashHeadroom / c.priceUsdc));

  if (c.kind === "writerAsk") {
    // A writerAsk with no readable strike cannot be OI-sized, so it cannot be
    // filled. Fail closed rather than treat an unknown strike as free capacity.
    if (!(c.strikeUsd > 0)) return 0;
    const oiHeadroom = Math.max(0, limits.maxOiUsd - spend.oiUsd);
    qty = Math.min(qty, Math.floor(oiHeadroom / c.strikeUsd));
  }
  return Math.max(0, qty);
}

export interface EvalInput {
  candidate: Candidate;
  /** micro-USDC per contract from get_option_price, or null when unpriceable. */
  fairUsdc: number | null;
  limits: TakerLimits;
  spend: Spend;
  nowSecs: number;
  /** Unix secs before which this order must not be filled (injected, not sampled here). */
  delayUntilSecs: number;
  isInternal: (pubkey: string) => boolean;
  /** Chain-verified: false when the pubkey is a PDA/mint/token account. */
  isWallet: (pubkey: string) => boolean;
  takerWallet: string;
}

export type PreScreenInput = Omit<EvalInput, "fairUsdc" | "spend">;

export interface IdentityCtx {
  isInternal: (pubkey: string) => boolean;
  isWallet: (pubkey: string) => boolean;
  takerWallet: string;
}

/**
 * The identity gates, split out because they need NOTHING but the maker pubkey —
 * no vault read, no quote, no clock. The live board is ~232/233 our own orders,
 * so running this first is what keeps the shadow journal readable and the RPC
 * budget small: everything downstream is per-order chain work spent on an order
 * we were never going to fill.
 *
 * It also keeps the journal HONEST. Checking vault state before identity meant a
 * settled order owned by the treasury was reported as `settled` — true, but not
 * the reason we declined it, and the tally then under-counts `internal_owner`.
 */
export function identityGate(
  owner: string, ctx: IdentityCtx,
): { fill: false; reason: RejectReason } | null {
  if (owner === ctx.takerWallet) return { fill: false, reason: "self_owned" };
  if (ctx.isInternal(owner)) return { fill: false, reason: "internal_owner" };
  if (!ctx.isWallet(owner)) return { fill: false, reason: "not_a_wallet" };
  return null;
}

/**
 * Every gate that does NOT need a fair value: identity, structure, expiry, delay.
 *
 * Split out so the caller can refuse an order BEFORE paying for a quote. Fair
 * value costs a simulate round-trip per distinct series, and the board is
 * overwhelmingly our own orders — running this first is the difference between
 * a handful of RPC calls per tick and a couple of hundred.
 *
 * Returns null when nothing objects. `evaluate` calls it, so the two can never
 * drift apart: there is one copy of these rules, not a cheap approximation of
 * them plus a real one.
 */
export function preScreen(inp: PreScreenInput): { fill: false; reason: RejectReason; detail?: string } | null {
  const { candidate: c, limits, nowSecs } = inp;

  // --- identity: absolute, and checked three ways ---------------------------
  const id = identityGate(c.owner, inp);
  if (id) return id;

  // --- structural -----------------------------------------------------------
  if (c.quantityRemaining <= 0 || !(c.priceUsdc > 0)) return { fill: false, reason: "zero_quantity" };
  if (c.isEuropean) return { fill: false, reason: "european" };
  // Near expiry the model is least trustworthy and gamma is largest — the worst
  // possible combination for the uninformed side.
  if (c.expiryTs - nowSecs < limits.minTteSecs) return { fill: false, reason: "too_near_expiry" };

  // --- the delay ------------------------------------------------------------
  // A deterministic instant fill turns the treasury into a synchronous put the
  // seller can price against. The wait is what removes that certainty.
  if (nowSecs < inp.delayUntilSecs) {
    return { fill: false, reason: "delay_pending", detail: `${inp.delayUntilSecs - nowSecs}s` };
  }
  return null;
}

/**
 * The single decision point. Order of checks is deliberate: the free gates run
 * first (via preScreen), then pricing, then budgets. An expensive check never
 * runs for an order a free one would have refused.
 */
export function evaluate(inp: EvalInput): Decision {
  const { candidate: c, limits, spend } = inp;

  const pre = preScreen(inp);
  if (pre) return pre;

  // --- pricing --------------------------------------------------------------
  if (inp.fairUsdc == null || !(inp.fairUsdc > 0)) return { fill: false, reason: "no_fair_value" };
  const band = withinBand(c.priceUsdc, inp.fairUsdc, limits);
  if (band !== "ok") {
    return { fill: false, reason: band, detail: `${discountBps(c.priceUsdc, inp.fairUsdc)}bps` };
  }

  // --- budgets --------------------------------------------------------------
  const qty = affordableQuantity(c, limits, spend);
  if (qty <= 0) {
    // Name the binding constraint — "no budget" is useless when tuning.
    // OI is checked FIRST for writerAsk: it is the cap most likely to bind on
    // that side (strike-sized, not premium-sized), and reporting `float_cap`
    // when OI is what stopped us would send an operator to the wrong knob.
    if (c.kind === "writerAsk") {
      if (!(c.strikeUsd > 0)) return { fill: false, reason: "oi_cap", detail: "strike unreadable" };
      if (spend.oiUsd + c.strikeUsd > limits.maxOiUsd) {
        return { fill: false, reason: "oi_cap", detail: `${Math.round(spend.oiUsd)}/${limits.maxOiUsd} OI` };
      }
    }
    if (spend.floatUsdc >= limits.maxFloatUsdc) return { fill: false, reason: "float_cap" };
    if (spend.globalSpentTodayUsdc >= limits.maxGlobalDayUsdc) return { fill: false, reason: "global_budget" };
    if (spend.walletSpentTodayUsdc >= limits.maxPerWalletDayUsdc) return { fill: false, reason: "wallet_budget" };
    return { fill: false, reason: "wallet_budget", detail: "price exceeds per-fill cap" };
  }

  return {
    fill: true,
    quantity: qty,
    costUsdc: qty * c.priceUsdc,
    bandBps: discountBps(c.priceUsdc, inp.fairUsdc),
    oiCreatedUsd: oiCreatedUsd(c, qty),
  };
}

/**
 * Deterministic per-order delay in [min, max]. Derived from the order pubkey
 * rather than sampled, so a restart cannot re-roll a shorter wait — otherwise
 * a seller could farm restarts for a faster exit.
 */
export function delayForOrder(orderPk: string, minSecs: number, maxSecs: number): number {
  if (maxSecs <= minSecs) return minSecs;
  let h = 2166136261;
  for (let i = 0; i < orderPk.length; i++) {
    h ^= orderPk.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return minSecs + (h % (maxSecs - minSecs + 1));
}
