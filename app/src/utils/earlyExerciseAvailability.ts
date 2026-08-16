// =============================================================================
// earlyExerciseAvailability.ts — can this position be exercised early, today?
// =============================================================================
//
// THE FAILURE THIS PREVENTS (measured 2026-08-12, JTO 0.457C x15).
//
// Opta holds writer-ask collateral in a per-series POT, not in the vault's own
// USDC account. `settle_vault` sweeps the pot into the vault at settlement and
// pays everyone correctly — that is the intended design, and it works.
//
// But `exercise_american` pays from `vault_usdc_account` and knows nothing about
// the pot. So on a series whose collateral came entirely from writer asks, an
// EARLY exercise draws on an account holding $0 and fails inside the token
// program, pre-settlement, every time. Measured across the whole board that day:
// 8 live filled series, 30 contracts, $612.21 sitting in pots, and every one of
// them American — i.e. early exercise was impossible on 100% of them.
//
// The program fix (give exercise_american the pot accounts and settle_vault's
// sweep) is queued for the next upgrade bundle. Until it ships, the honest thing
// is to not offer the action: a disabled control with a real reason beats a
// wallet popup that cannot succeed.
//
// NOTHING IS AT RISK. The money is there and settlement reaches it. The position
// pays out at expiry on its own. That is what the copy says, and it is true.
//
// PURE + DEPENDENCY-FREE so it can be tested against fixtures.
// =============================================================================

/** The shape this needs off a SharedVault. Numbers or BN-likes both work. */
export interface VaultFundingView {
  /** Collateral deposited into the VAULT itself (pool writers). BN or number. */
  totalCollateral: { toString(): string } | number | null | undefined;
  /** Set once settle_vault has swept the writer-ask pot in. */
  writerAskCollateralSwept?: { toString(): string } | number | null;
  isSettled?: boolean;
}

/** The series' writer-ask pot, when one has been read. `null`/absent means "not
 *  looked up", NOT "empty" — the distinction decides whether we may gate. */
export interface PotFundingView {
  totalCollateral: { toString(): string } | number | null | undefined;
}

function asNumber(v: VaultFundingView["totalCollateral"]): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const n = Number(v.toString());
  return Number.isFinite(n) ? n : 0;
}

export type EarlyExerciseAvailability =
  | { available: true }
  | { available: false; reason: string };

/** The one user-facing sentence. No pot mechanics, no vendor names, no
 *  internals — it states the consequence and the remedy, both of which are
 *  true: the position settles and pays on its own at expiry. */
export const EARLY_EXERCISE_UNFUNDED_COPY =
  "Early exercise isn't available for this position — it settles and pays automatically at expiry.";

/**
 * Whether an early exercise can be funded right now.
 *
 * Reads the vault's own accounting rather than fetching a token balance: a vault
 * with `totalCollateral == 0` has never had collateral deposited into it, so its
 * USDC account is empty by construction. Once `writerAskCollateralSwept > 0` the
 * pot has been folded in and the vault can pay — though by then the vault is
 * settled and the post-settlement path handles it anyway.
 *
 * Conservative in the safe direction: an unreadable vault yields `available`,
 * because wrongly HIDING a working action is a worse failure than letting a
 * transaction be attempted. This gate exists to stop a guaranteed failure, not
 * to be the authority on eligibility — the program remains that.
 */
export function earlyExerciseAvailability(
  vault: VaultFundingView | null | undefined,
  /** The series' writer-ask pot, if it was read. Omit when unknown — an omitted
   *  pot is treated as "not looked up", and the gate stays conservative. */
  pot?: PotFundingView | null,
): EarlyExerciseAvailability {
  if (!vault) return { available: true };
  if (vault.isSettled) return { available: true }; // post-settlement path, not ours

  const pooled = asNumber(vault.totalCollateral);
  const swept = asNumber(vault.writerAskCollateralSwept);
  // The pot became spendable pre-settlement when exercise_american learned to
  // draw its shortfall from it (2026-08-15). Before that this was the whole
  // reason the gate existed; now a funded pot is simply a third funding source,
  // and continuing to hide the action would be the lie.
  const potted = asNumber(pot?.totalCollateral);
  if (pooled > 0 || swept > 0 || potted > 0) return { available: true };

  return { available: false, reason: EARLY_EXERCISE_UNFUNDED_COPY };
}
