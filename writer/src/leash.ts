/**
 * THE LEASH — spend ceilings and unwind solvency for the writer bot.
 *
 * WHY THIS EXISTS (incident 2026-08-27)
 *   The bot committed **$937,611** of USDC and burned **3.13 SOL** in ~24h, then
 *   ran out of SOL and could no longer pay for its own cancels. 291
 *   `writer-strand` errors followed: orders it could not unwind, and a resting
 *   count that climbed 109 -> 184 because posts had succeeded while cancels
 *   could not. Nothing was stolen — every lamport went to program-owned
 *   accounts — but nothing capped the spend either.
 *
 *   `MAX_CELLS` is not a spend limit. It caps how many cells are quoted; with
 *   BTC at ~$79k of collateral per contract, cell count is a meaningless proxy
 *   for dollars. On the incident day BTC calls + puts alone were $1.587M of the
 *   $1.835M committed.
 *
 * THE TWO RULES
 *   1. MEASURE, DON'T REMEMBER. Committed collateral is summed from live
 *      on-chain orders at the start of every tick. An internal counter drifts
 *      the moment a tx lands out-of-band, a process restarts, or a cancel fails
 *      — and a drifted counter is worse than none, because it reads as authority.
 *   2. UNWIND MUST ALWAYS BE AFFORDABLE. A reserve of SOL is fenced off that
 *      posting may never spend, because the failure mode was not "ran out of
 *      money" — it was "ran out of money to get out". Cancels cost fees too.
 *
 * Pure functions only, so every rule is testable without a chain.
 */

export type Committed = {
  /** Total committed collateral across live writer asks, micro-USDC. */
  totalMicro: bigint;
  /** Per-asset committed collateral, micro-USDC. */
  perAssetMicro: Map<string, bigint>;
};

export type MeasurableOrder = {
  optionMint: { toBase58(): string };
  quantityRemaining: bigint;
  collateralPerContract: bigint;
};

/**
 * Sum committed collateral from LIVE ON-CHAIN ORDERS. Never from a counter.
 *
 * `assetOf` resolves an order to its asset ticker; orders that cannot be
 * resolved are counted toward the global total but not to any per-asset bucket,
 * so an unresolvable order can never dodge the global ceiling.
 */
export function measureCommitted(
  orders: readonly MeasurableOrder[],
  assetOf: (o: MeasurableOrder) => string | null,
): Committed {
  let totalMicro = 0n;
  const perAssetMicro = new Map<string, bigint>();
  for (const o of orders) {
    const c = o.collateralPerContract * o.quantityRemaining;
    if (c <= 0n) continue;
    totalMicro += c;
    const asset = assetOf(o);
    if (asset) perAssetMicro.set(asset, (perAssetMicro.get(asset) ?? 0n) + c);
  }
  return { totalMicro, perAssetMicro };
}

export type CollateralCaps = {
  /** Global ceiling on committed collateral, whole USDC. 0 disables. */
  maxCollateralUsdc: number;
  /** Per-asset ceiling, whole USDC. 0 disables. */
  maxCollateralPerAssetUsdc: number;
};

export type PostDecision =
  | { allow: true }
  | { allow: false; reason: "cap-collateral-global" | "cap-collateral-asset"; committed: number; cap: number };

/**
 * May this cell be posted? Evaluated against MEASURED committed collateral plus
 * what this post would itself add. The would-be post is included on purpose: a
 * ceiling checked only against the prior state is always one post too late.
 */
export function collateralGate(
  committed: Committed,
  asset: string,
  addMicro: bigint,
  caps: CollateralCaps,
): PostDecision {
  const MICRO = 1_000_000n;
  if (caps.maxCollateralUsdc > 0) {
    const capMicro = BigInt(Math.floor(caps.maxCollateralUsdc)) * MICRO;
    if (committed.totalMicro + addMicro > capMicro) {
      return {
        allow: false, reason: "cap-collateral-global",
        committed: Number(committed.totalMicro) / 1e6, cap: caps.maxCollateralUsdc,
      };
    }
  }
  if (caps.maxCollateralPerAssetUsdc > 0) {
    const capMicro = BigInt(Math.floor(caps.maxCollateralPerAssetUsdc)) * MICRO;
    const cur = committed.perAssetMicro.get(asset) ?? 0n;
    if (cur + addMicro > capMicro) {
      return {
        allow: false, reason: "cap-collateral-asset",
        committed: Number(cur) / 1e6, cap: caps.maxCollateralPerAssetUsdc,
      };
    }
  }
  return { allow: true };
}

/** Record a post that actually landed, so later cells in the SAME tick see it.
 *  This is not a substitute for measuring — next tick re-measures from chain. */
export function applyPost(committed: Committed, asset: string, addMicro: bigint): void {
  committed.totalMicro += addMicro;
  committed.perAssetMicro.set(asset, (committed.perAssetMicro.get(asset) ?? 0n) + addMicro);
}

export type SolPolicy = {
  /** Refuse NEW posts below this liquid SOL. */
  minSolPost: number;
  /** SOL that posting may never spend, kept so unwind is always affordable. */
  reserveSol: number;
};

export type SolDecision =
  | { allow: true }
  | { allow: false; reason: "min-sol-post" | "reserve-sol"; sol: number; floor: number };

/**
 * May the bot post at all right now?
 *
 * Two distinct floors, and the second is the one the incident needed:
 *   minSolPost  — a comfort floor; below it, stop adding obligations.
 *   reserveSol  — a hard fence. Posting may never draw the balance into it,
 *                 because cancelling 184 stranded orders costs fees, and a bot
 *                 that cannot afford its own cancels cannot be unwound at all.
 *
 * Cancels are deliberately NOT gated — unwinding must stay possible at any
 * balance. Only new obligations are refused.
 */
export function solGate(solBalance: number, policy: SolPolicy): SolDecision {
  if (policy.reserveSol > 0 && solBalance <= policy.reserveSol) {
    return { allow: false, reason: "reserve-sol", sol: solBalance, floor: policy.reserveSol };
  }
  if (policy.minSolPost > 0 && solBalance < policy.minSolPost) {
    return { allow: false, reason: "min-sol-post", sol: solBalance, floor: policy.minSolPost };
  }
  return { allow: true };
}

/**
 * Assets frozen at BUILD level for this release, on top of any env denylist.
 *
 * On 2026-08-27 these three were **96%** of $1.84M committed (BTC $1.587M,
 * XAU $92k, ETH $50k) — the whole overrun in three tickers. Re-enabling is a
 * deliberate decision with per-asset caps, not an env edit someone makes at
 * 2am. Env may ADD exclusions; it cannot remove these.
 */
export const BUILD_EXCLUDED_ASSETS: readonly string[] = ["BTC", "ETH", "XAU"];

export function isBuildExcluded(assetName: string): boolean {
  return BUILD_EXCLUDED_ASSETS.includes(assetName.toUpperCase());
}
