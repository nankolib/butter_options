// =============================================================================
// utils/american_pricing/quote.rs -- Shared AMER pricing path (Pass 3)
// =============================================================================
//
// Single source of truth for on-chain American option pricing. Wraps the
// BS-2002 math kernel in `super::` with the Anchor-side plumbing every caller
// needs:
//   - VolOracle freshness gates (6h staleness, positive last_spot_price)
//   - realized_vol_annualized read (propagates Warmup/Stale/NotInitialized)
//   - TTE conversion (seconds_to_time_scale)
//   - Strike + carry conversion to solmath SCALE
//   - american_call_price / american_put_price dispatch
//   - Error wrapping to AmericanPricingFailed (with msg! logged variant)
//   - Premium scale-down to USDC + non-zero gate
//
// Callers:
//   - mint_from_vault.rs (American branch only; European branch never calls in)
//   - get_option_price.rs (Pass 3 view instruction)
//
// Both callers consume only the premium; vol_used / spot_used / computed_at
// are exposed for the get_option_price view's return-struct surface.
//
// Risk-free rate is fixed at 5% via RISK_FREE_RATE_SCALED (single source of
// truth; previously a per-handler const in mint_from_vault). PARKED: future
// arc lifts this to a stored ProtocolState field once multi-rate support
// is needed.
// =============================================================================

use anchor_lang::prelude::*;

use crate::errors::OptaError;
use crate::state::{OptionType, VolOracle, realized_vol_annualized, VOL_ORACLE_WARMUP_SAMPLES};
use crate::utils::solmath_bridge::{scale_to_usdc, seconds_to_time_scale, usdc_to_scale};

use super::{american_call_price, american_put_price};

/// Risk-free rate used by all on-chain American BS-2002 pricing, at solmath
/// SCALE = 1e12. Set to 5% to match the Stage A pricing reference + every
/// existing BS-2002 unit test. PARKED: future arc lifts this to a stored
/// ProtocolState field (`risk_free_rate_bps: u16`) once multi-rate support
/// is needed. Until then, this constant is the single source of truth.
pub const RISK_FREE_RATE_SCALED: u128 = solmath::SCALE / 20; // 5%

/// Inputs to the shared AMER pricing path. Field names mirror the
/// SharedVault fields mint_from_vault reads + the get_option_price args.
pub struct AmericanQuoteInputs {
    /// Strike in USDC smallest units (6 decimals). Matches SharedVault.strike_price.
    pub strike: u64,
    /// Expiry unix seconds. Matches SharedVault.expiry.
    pub expiry_ts: i64,
    pub option_type: OptionType,
    /// Signed bps. Matches SharedVault.carry_rate_bps.
    pub carry_rate_bps: i32,
}

/// Result of a successful AMER quote. Internal Rust struct — NOT
/// AnchorSerialize. The view instruction repacks the fields it needs into
/// the public `OptionPriceQuote` IDL type at its own return point.
pub struct AmericanQuoteResult {
    /// Premium in USDC smallest units (6 decimals). Same scale as
    /// VaultMint.premium_per_contract.
    pub premium_per_contract: u64,
    /// Realized vol used in the computation, at SCALE 1e12. From
    /// realized_vol_annualized.
    pub vol_used_scaled: i64,
    /// Spot used in the computation, at SCALE 1e12. From
    /// VolOracle.last_spot_price.
    pub spot_used_scaled: i64,
    /// `now_ts` at the time of the computation.
    pub computed_at_ts: i64,
}

/// Shared AMER pricing path. Performs the 6h freshness gate, vol+spot read,
/// TTE conversion, BS-2002 dispatch, and USDC scale-down. Returns the
/// quoted premium plus the underlying oracle snapshot used.
///
/// Error mapping (verbatim from Pass 2's inline arm in mint_from_vault):
///   - oracle.last_sample_ts staler than 6h        -> VolOracleStale
///   - oracle.last_spot_price <= 0                 -> VolOracleInvalidSpot
///   - realized_vol_annualized returns Err         -> propagated verbatim
///   - expiry_ts <= now_ts                         -> ExpiryInPast
///   - american_*_price returns Err                -> AmericanPricingFailed (msg! logged)
///   - resulting USDC premium == 0                 -> InvalidPremium
///   - any conversion overflow                     -> MathOverflow
pub fn price_american(
    oracle: &VolOracle,
    now_ts: i64,
    inputs: AmericanQuoteInputs,
) -> Result<AmericanQuoteResult> {
    // Freshness gate on the spot snapshot. Independent of the
    // realized_vol staleness gate (which fires inside the read fn);
    // both use the same 6h threshold against last_sample_ts.
    require!(
        now_ts.saturating_sub(oracle.last_sample_ts) <= 6 * 3600,
        OptaError::VolOracleStale
    );

    // Spot at SCALE (already 1e12).
    require!(oracle.last_spot_price > 0, OptaError::VolOracleInvalidSpot);
    let spot_scaled: u128 = oracle.last_spot_price as u128;

    // Vol at SCALE (i64). Seed-at-birth handoff — ONE site, abrupt switch:
    //   - warm (sample_count >= VOL_ORACLE_WARMUP_SAMPLES): realized vol, the
    //     unchanged path. A warm oracle NEVER consults seed_vol, so the warm
    //     majors (BTC/ETH/SOL) are byte-identical to today.
    //   - cold + seeded (seed_vol != 0): use the per-asset-class seed so a
    //     brand-new market is priceable from minute one while the ring warms.
    //   - cold + unseeded (seed_vol == 0): revert exactly as before. Same error
    //     CODE as today (VolOracleWarmup); only the logged source location moves
    //     from vol_oracle.rs (realized_vol's require!) to here.
    //
    // The staleness gate and the last_spot_price > 0 gate ABOVE this line already
    // passed for a freshly-seeded oracle because initialize_vol_oracle wrote
    // last_sample_ts + last_spot_price at birth (Change 2). Those gates are
    // untouched.
    let vol_scaled: i64 = if oracle.sample_count >= VOL_ORACLE_WARMUP_SAMPLES {
        realized_vol_annualized(oracle, now_ts)?
    } else if oracle.seed_vol != 0 {
        oracle.seed_vol
    } else {
        return Err(error!(OptaError::VolOracleWarmup));
    };
    let sigma_u128: u128 = vol_scaled as u128;

    // TTE: gate expiry strictly > now before the conversion.
    require!(inputs.expiry_ts > now_ts, OptaError::ExpiryInPast);
    let tte_secs: i64 = inputs.expiry_ts - now_ts;
    let t_scaled: u128 = seconds_to_time_scale(tte_secs)?;

    // Strike: u64 USDC (6-dec) -> u128 SCALE (12-dec).
    let strike_scaled: u128 = usdc_to_scale(inputs.strike)?;

    // Carry: i32 bps -> i128 SCALE fraction. bps * SCALE_I / 10_000.
    let carry_scaled: i128 = (inputs.carry_rate_bps as i128)
        .checked_mul(solmath::SCALE_I)
        .ok_or(OptaError::MathOverflow)?
        / 10_000;

    let r_scaled: u128 = RISK_FREE_RATE_SCALED;

    let premium_scaled: u128 = match inputs.option_type {
        OptionType::Call => american_call_price(
            spot_scaled, strike_scaled, r_scaled, carry_scaled,
            sigma_u128, t_scaled,
        ),
        OptionType::Put => american_put_price(
            spot_scaled, strike_scaled, r_scaled, carry_scaled,
            sigma_u128, t_scaled,
        ),
    }
    .map_err(|e| {
        msg!("BS-2002 American pricing failed: {:?}", e);
        OptaError::AmericanPricingFailed
    })?;

    let premium_usdc = scale_to_usdc(premium_scaled)?;
    require!(premium_usdc > 0, OptaError::InvalidPremium);

    Ok(AmericanQuoteResult {
        premium_per_contract: premium_usdc,
        vol_used_scaled: vol_scaled,
        spot_used_scaled: oracle.last_spot_price,
        computed_at_ts: now_ts,
    })
}
