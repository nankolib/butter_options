// =============================================================================
// utils/exercise_intrinsic.rs — capped per-contract intrinsic (Stage F)
// =============================================================================
//
// Single source of truth for the CASH-SETTLED intrinsic value paid out on an
// early American exercise (exercise_american). Pure arithmetic — no oracle,
// no CPI — so it is unit-testable in isolation and reused verbatim by the
// handler.
//
// The `collateral_per_token` cap is the Stage F (f)-locked CRIT-4 bound: a
// single contract can NEVER pay out more than the writer locked to back it
// (= 1× strike under the symmetric collateral model, utils/collateral.rs).
// Without this cap a deep-ITM CALL exercised early could over-draw the pool
// and strand other holders/writers — note that pre-settlement there is no
// `collateral_remaining` floor yet (it is populated only at settle_vault), so
// this per-contract cap is the ONLY structural protection at early-exercise
// time.
//
// NOTE: AMERICAN settlement (exercise_from_vault / auto_finalize_holders) now
// ALSO routes its per-contract payout through this helper (AM-MED-1), so an
// American contract is capped at collateral_per_token identically whether it is
// exercised early or held to settlement. EUROPEAN settlement is NOT routed
// through it — it keeps its uncapped per-contract intrinsic + the aggregate
// pool clamp and stays byte-identical. settle_vault's emitted aggregate event
// is likewise unchanged.
// =============================================================================

use crate::state::OptionType;

/// Capped per-contract intrinsic value, in USDC smallest units (6 decimals).
///
///   CALL = min(spot − strike, collateral_per_token)   (OTM → 0)
///   PUT  = min(strike − spot, collateral_per_token)    (OTM → 0)
///
/// All arithmetic saturating: out-of-the-money legs floor at 0, and the cap
/// clamps deep-ITM payouts to the collateral the writer locked.
pub fn exercise_capped_intrinsic(
    option_type: OptionType,
    spot_6dec: u64,
    strike_6dec: u64,
    collateral_per_token: u64,
) -> u64 {
    let raw = match option_type {
        OptionType::Call => spot_6dec.saturating_sub(strike_6dec),
        OptionType::Put => strike_6dec.saturating_sub(spot_6dec),
    };
    raw.min(collateral_per_token)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 6-decimal USDC helper for readable vectors.
    const fn d(dollars: u64) -> u64 {
        dollars * 1_000_000
    }

    #[test]
    fn call_normal_in_the_money() {
        // strike < spot < 2·strike → pays spot − strike (below the cap).
        // strike $100, spot $150, collateral $100 → $50.
        let i = exercise_capped_intrinsic(OptionType::Call, d(150), d(100), d(100));
        assert_eq!(i, d(50));
    }

    #[test]
    fn call_deep_itm_is_capped_at_collateral() {
        // spot ≥ 2·strike → raw intrinsic (spot − strike) EXCEEDS the cap.
        // strike $100, spot $250, collateral $100 → capped at $100, NOT $150.
        // THIS is the Stage F (f) lock.
        let i = exercise_capped_intrinsic(OptionType::Call, d(250), d(100), d(100));
        assert_eq!(i, d(100), "deep-ITM CALL must cap at collateral_per_token");
        assert_ne!(i, d(150), "must NOT return uncapped spot − strike");
    }

    #[test]
    fn put_in_the_money() {
        // strike $100, spot $60, collateral $100 → $40 (below cap).
        let i = exercise_capped_intrinsic(OptionType::Put, d(60), d(100), d(100));
        assert_eq!(i, d(40));
    }

    #[test]
    fn put_deep_itm_is_capped_at_collateral() {
        // spot $0, strike $100 → raw $100, equals the cap.
        let i = exercise_capped_intrinsic(OptionType::Put, 0, d(100), d(100));
        assert_eq!(i, d(100));
    }

    #[test]
    fn call_out_of_the_money_is_zero() {
        // spot ≤ strike → 0.
        let i = exercise_capped_intrinsic(OptionType::Call, d(80), d(100), d(100));
        assert_eq!(i, 0);
    }

    #[test]
    fn at_the_money_is_zero() {
        // spot == strike → 0 for both legs.
        assert_eq!(exercise_capped_intrinsic(OptionType::Call, d(100), d(100), d(100)), 0);
        assert_eq!(exercise_capped_intrinsic(OptionType::Put, d(100), d(100), d(100)), 0);
    }
}
