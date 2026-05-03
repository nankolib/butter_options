// =============================================================================
// utils/collateral.rs — Required collateral per contract (symmetric, 1x strike)
// =============================================================================
//
// Single source of truth for the writer's collateral requirement per contract.
// Both CALL and PUT vaults lock 1× strike per contract.
//
// Historical context (see COLLATERAL_2X_AUDIT.md and
// COLLATERAL_2X_PREMIUM_FOLLOWUP.md):
//   - v1 used 2× strike for CALLs and 1× strike for PUTs. Audit found this
//     halved CALL writer yield (premium stayed at 1× BS-fair value, so
//     writers locked 2× capital for the same nominal yield).
//   - v2 (this module, 2026-05-03) switches to symmetric 1× strike.
//   - Settle still caps payouts at vault.total_collateral via
//     `min(total_payout, total_collateral)` in settle_vault.rs, so under
//     the new formula CALLs cap at the writer's locked amount when
//     spot ≥ 2 × strike (vs 3 × strike under the old 2× formula).
//
// Future margin work (Tier-3 follow-up): if/when we adopt a margin-based
// system (per-asset risk multipliers, portfolio margin, etc.) the new
// logic lives here. Call sites already route through this function and
// don't need to change.
// =============================================================================

use crate::state::OptionType;

/// Required USDC collateral (in 6-decimal smallest units) per contract for a
/// vault with the given `strike` and `option_type`.
///
/// Currently symmetric: returns `strike` for both CALL and PUT. The
/// `option_type` parameter is preserved in the signature so future
/// margin work can branch on it without breaking call sites.
pub fn required_collateral_per_contract(strike: u64, _option_type: OptionType) -> u64 {
    strike
}
