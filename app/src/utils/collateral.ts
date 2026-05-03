// =============================================================================
// utils/collateral.ts — Required collateral per contract (symmetric, 1x strike)
// =============================================================================
//
// Frontend mirror of programs/opta/src/utils/collateral.rs. Single source
// of truth for the writer's collateral requirement per contract on the UI
// side. Both CALL and PUT vaults lock 1× strike per contract.
//
// Historical context (see COLLATERAL_2X_AUDIT.md and
// COLLATERAL_2X_PREMIUM_FOLLOWUP.md):
//   - v1 used 2× strike for CALLs and 1× strike for PUTs. Audit found this
//     halved CALL writer yield (premium stayed at 1× BS-fair value, so
//     writers locked 2× capital for the same nominal yield).
//   - v2 (this module, 2026-05-03) switches to symmetric 1× strike.
//
// Future margin work (Tier-3 follow-up): if/when we adopt a margin-based
// system the new logic lives here. Call sites already route through this
// function and don't need to change.
//
// CRITICAL: this MUST stay in sync with the on-chain helper at
// programs/opta/src/utils/collateral.rs. If the two drift, mint_from_vault
// will revert with InsufficientVaultCollateral and writers will be unable
// to mint.
// =============================================================================

/**
 * Required USDC collateral per contract for a vault with the given
 * `strike` and `side`. Returns dollars (human-readable, matches the
 * UI's display unit). The submit path scales to USDC u64 separately.
 *
 * Currently symmetric: returns `strike` for both CALL and PUT. The
 * `side` parameter is preserved in the signature so future margin
 * work can branch on it without breaking call sites.
 */
export function requiredCollateralPerContract(
  strike: number,
  _side: "call" | "put",
): number {
  return strike;
}
