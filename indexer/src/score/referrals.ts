// =============================================================================
// referrals.ts — Part E: referral rules (PURE). Write path is Phase 2b.
// =============================================================================
//
//   referee   +25 at bound_at
//   activation = the referee completes O3 (Make a Market)
//   referrer  earns 10% of the referee's points EARNED AFTER activation
//             (base + quests, post-multiplier)
//   cap       total referral income <= 25% of the referrer's SELF-earned points
//
// NON-CIRCULAR BY CONSTRUCTION. `selfEarned` excludes referral income, so the
// cap can never feed itself. Computed in two passes: self-earned for everyone
// first, then referral income against that fixed base.
//
// The referrals table is EMPTY until Phase 2b. Every function here returns
// zeroes on empty input — the evaluator must not care.
// =============================================================================

export interface ReferralRow {
  code: string;
  referrer_wallet: string;
  referee_wallet: string;
  bound_at: number | null;
  activated_at: number | null;
}

export interface ReferralConfig {
  refereeBondPoints: number;
  referrerRate: number;
  referrerCapFractionOfSelf: number;
}

export interface ReferralResult {
  /** wallet -> points credited as a referee bond. */
  bondPoints: Map<string, number>;
  /** wallet -> referral commission earned (already capped). */
  commission: Map<string, number>;
  /** wallet -> commission that was forfeited to the 25% cap. */
  capForfeited: Map<string, number>;
  activated: number;
  bound: number;
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/**
 * @param referrals    rows from the `referrals` table (empty in Phase 2a)
 * @param selfEarned   wallet -> base + quest points, post-multiplier, EXCLUDING
 *                     any referral income (this is what makes the cap stable)
 * @param earnedAfter  (wallet, sinceTs) -> points that wallet earned at or after
 *                     `sinceTs`; supplied by the caller so this stays pure
 */
export function computeReferrals(
  referrals: readonly ReferralRow[],
  selfEarned: ReadonlyMap<string, number>,
  earnedAfter: (wallet: string, sinceTs: number) => number,
  cfg: ReferralConfig,
): ReferralResult {
  const bondPoints = new Map<string, number>();
  const commission = new Map<string, number>();
  const capForfeited = new Map<string, number>();
  let activated = 0;
  let bound = 0;

  // Pass 1 — referee bonds, and raw (uncapped) commission per referrer.
  const rawByReferrer = new Map<string, number>();
  for (const r of [...referrals].sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))) {
    if (r.bound_at == null) continue;
    bound += 1;
    bondPoints.set(r.referee_wallet, round4((bondPoints.get(r.referee_wallet) ?? 0) + cfg.refereeBondPoints));

    if (r.activated_at == null) continue;
    activated += 1;
    const refereeEarned = earnedAfter(r.referee_wallet, r.activated_at);
    const raw = refereeEarned * cfg.referrerRate;
    rawByReferrer.set(r.referrer_wallet, (rawByReferrer.get(r.referrer_wallet) ?? 0) + raw);
  }

  // Pass 2 — apply the cap against a FIXED self-earned base.
  for (const referrer of [...rawByReferrer.keys()].sort()) {
    const raw = rawByReferrer.get(referrer)!;
    const cap = (selfEarned.get(referrer) ?? 0) * cfg.referrerCapFractionOfSelf;
    const paid = Math.min(raw, cap);
    commission.set(referrer, round4(paid));
    if (raw > paid) capForfeited.set(referrer, round4(raw - paid));
  }

  return { bondPoints, commission, capForfeited, activated, bound };
}
