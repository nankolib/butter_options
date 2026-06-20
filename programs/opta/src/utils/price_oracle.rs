// =============================================================================
// utils/price_oracle.rs — Source-routed spot-price read abstraction (Stage 1)
// =============================================================================
//
// This module is the SEAM the Switchboard arm slots into at Stage 3. It wraps
// the three spot-read sites mapped in the Switchboard Stage-0 recon:
//
//   #1 settle_expiry      → pyth_settlement_price_usdc  (historical EMA in a
//                                                         [expiry, expiry+window]
//                                                         settlement window)
//   #2 exercise_american  → pyth_current_spot_usdc      (current EMA, tight 60s)
//   #3 push_vol_sample    → pyth_current_spot_scale     (current SPOT, tight 60s)
//
// STAGE 1 CONTRACT — pure internal refactor, ZERO behavior change:
//   - There is exactly ONE implementer: Pyth. No routing dispatch, no
//     oracle_source flag (that is Stage 2). Each handler calls its Pyth helper
//     unconditionally.
//   - Each helper is a verbatim lift of the handler's prior inline
//     validate→extract→normalize block. Error codes, gate ORDER, the EMA-vs-
//     spot choice, and the USDC-vs-SCALE normalization are preserved exactly.
//   - Threshold constants stay defined in their handlers and are passed in as
//     parameters, so no `pub const` reference (tests, cu_profile_*) breaks and
//     there is no `utils → instructions` dependency. The helpers hardcode only
//     what genuinely differs per seam (error variants, EMA vs spot, scale).
//
// STAGE 3 (future): each handler grows
//     match market.oracle_source {
//         OracleSource::Pyth        => pyth_*(...),
//         OracleSource::Switchboard => sb_*(...),
//     }
// The plain-function shape (not a trait) is deliberate: the two arms read
// different account TYPES (PriceUpdateV2 vs the Switchboard PullFeed) living in
// different ctx fields, which a trait would only obscure with generics/dyn.
// =============================================================================

use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::error::GetPriceError;
use pyth_solana_receiver_sdk::price_update::{PriceUpdateV2, VerificationLevel};

use crate::errors::OptaError;
use crate::utils::solmath_bridge::{pyth_price_to_scale, pyth_price_to_usdc};

/// Result of a settlement-window read: the canonical settlement price in USDC
/// smallest units (6 decimals) plus the update's `publish_time`, which
/// settle_expiry persists to `SettlementRecord.pyth_publish_time`.
pub struct SettlementRead {
    pub price_usdc: u64,
    pub publish_time: i64,
}

/// #1 settle_expiry. Validate a historical Pyth `PriceUpdateV2` whose
/// `publish_time` must land in `[expiry, expiry + window_secs]`, then normalize
/// the EMA to USDC 6-dec.
///
/// Gates, in order (identical to the prior settle_expiry inline block):
///   - verification_level == Full          → InsufficientVerificationLevel
///   - price_message.feed_id == expected    → MismatchedFeedId
///   - EMA confidence ≤ max_conf_bps        → PriceConfidenceTooWide
///   - publish_time ≥ expiry                → PriceUpdateBeforeExpiry
///   - publish_time − expiry ≤ window_secs  → PriceUpdateTooFarFromExpiry
///   - publish_time + max_age_secs ≥ now    → PriceTooOld
///   - EMA normalizes (price > 0, no trunc) → InvalidSettlementPrice / MathOverflow
#[inline]
pub fn pyth_settlement_price_usdc(
    price_update: &PriceUpdateV2,
    expected_feed_id: [u8; 32],
    expiry: i64,
    now: i64,
    window_secs: i64,
    max_age_secs: i64,
    max_conf_bps: u16,
) -> Result<SettlementRead> {
    let pu = price_update;
    require!(
        pu.verification_level.gte(VerificationLevel::Full),
        GetPriceError::InsufficientVerificationLevel
    );
    require!(
        pu.price_message.feed_id == expected_feed_id,
        GetPriceError::MismatchedFeedId
    );

    let ema_price = pu.price_message.ema_price;
    let exponent = pu.price_message.exponent;
    let publish_time = pu.price_message.publish_time;

    // Confidence-interval gate (CRIT-2).
    let conf = pu.price_message.ema_conf as u128;
    let abs_price = ema_price.unsigned_abs() as u128;
    require!(
        conf.checked_mul(10_000).ok_or(OptaError::MathOverflow)?
            <= abs_price
                .checked_mul(max_conf_bps as u128)
                .ok_or(OptaError::MathOverflow)?,
        OptaError::PriceConfidenceTooWide
    );

    // Expiry-window gate.
    require!(publish_time >= expiry, OptaError::PriceUpdateBeforeExpiry);
    require!(
        publish_time.saturating_sub(expiry) <= window_secs,
        OptaError::PriceUpdateTooFarFromExpiry
    );

    // Backstop staleness floor.
    require!(
        publish_time.saturating_add(max_age_secs) >= now,
        GetPriceError::PriceTooOld
    );

    let price_usdc = pyth_price_to_usdc(ema_price, exponent)?;
    Ok(SettlementRead {
        price_usdc,
        publish_time,
    })
}

/// #2 exercise_american. Validate a CURRENT Pyth `PriceUpdateV2` (single-sided
/// `max_age_secs` freshness against `now`) and normalize the EMA to USDC 6-dec.
///
/// Gates, in order (identical to the prior exercise_american inline block):
///   - verification_level == Full           → InsufficientVerificationLevel
///   - price_message.feed_id == expected     → MismatchedFeedId
///   - EMA confidence ≤ max_conf_bps         → PriceConfidenceTooWide
///   - now − publish_time ≤ max_age_secs     → PriceTooOld (single-sided)
///   - EMA normalizes                        → InvalidSettlementPrice / MathOverflow
#[inline]
pub fn pyth_current_spot_usdc(
    price_update: &PriceUpdateV2,
    expected_feed_id: [u8; 32],
    now: i64,
    max_age_secs: i64,
    max_conf_bps: u16,
) -> Result<u64> {
    let pu = price_update;
    require!(
        pu.verification_level.gte(VerificationLevel::Full),
        GetPriceError::InsufficientVerificationLevel
    );
    require!(
        pu.price_message.feed_id == expected_feed_id,
        GetPriceError::MismatchedFeedId
    );

    let ema_price = pu.price_message.ema_price;
    let exponent = pu.price_message.exponent;
    let publish_time = pu.price_message.publish_time;

    let conf = pu.price_message.ema_conf as u128;
    let abs_price = ema_price.unsigned_abs() as u128;
    require!(
        conf.checked_mul(10_000).ok_or(OptaError::MathOverflow)?
            <= abs_price
                .checked_mul(max_conf_bps as u128)
                .ok_or(OptaError::MathOverflow)?,
        OptaError::PriceConfidenceTooWide
    );

    // Single-sided freshness: only a price older than max_age_secs reverts; a
    // future-dated publish_time yields a negative diff and passes (receiver
    // verification already bounds forward skew).
    require!(
        now.saturating_sub(publish_time) <= max_age_secs,
        GetPriceError::PriceTooOld
    );

    pyth_price_to_usdc(ema_price, exponent)
}

/// #3 push_vol_sample. Validate a CURRENT Pyth `PriceUpdateV2`, read SPOT (not
/// EMA — realized vol is computed from spot returns), and normalize to solmath
/// SCALE (1e12).
///
/// Gates, in order (identical to the prior push_vol_sample inline block):
///   - verification_level == Full           → InsufficientVerificationLevel
///   - price_message.feed_id == expected     → MismatchedFeedId
///   - spot price > 0  (BEFORE conf/fresh)   → VolOracleInvalidSpot
///   - spot normalizes to SCALE              → InvalidSettlementPrice / MathOverflow
///   - EMA confidence ≤ max_conf_bps         → VolOraclePriceStale (catch-all)
///   - publish_time + max_age_secs ≥ now     → VolOraclePriceStale
///
/// The spot>0 gate runs BEFORE the confidence and freshness gates so a
/// fundamentally garbage price surfaces VolOracleInvalidSpot rather than being
/// misattributed to VolOraclePriceStale (a zero-price update would make the
/// conf-check rhs 0 and trip the stale branch). Caller is responsible for
/// reading `oracle.feed_id` and passing it as `expected_feed_id` so the
/// read-only oracle borrow drops before any subsequent `load_mut`.
#[inline]
pub fn pyth_current_spot_scale(
    price_update: &PriceUpdateV2,
    expected_feed_id: [u8; 32],
    now: i64,
    max_age_secs: i64,
    max_conf_bps: u16,
) -> Result<u128> {
    let pu = price_update;
    require!(
        pu.verification_level.gte(VerificationLevel::Full),
        GetPriceError::InsufficientVerificationLevel
    );
    require!(
        pu.price_message.feed_id == expected_feed_id,
        GetPriceError::MismatchedFeedId
    );

    let price = pu.price_message.price;
    let exponent = pu.price_message.exponent;
    let publish_time = pu.price_message.publish_time;
    let ema_price = pu.price_message.ema_price;
    let ema_conf = pu.price_message.ema_conf;

    // Spot positivity gate — runs BEFORE conf/freshness for correct error
    // attribution (see doc comment).
    require!(price > 0, OptaError::VolOracleInvalidSpot);

    // Convert (i64 price, i32 exponent) → u128 at SCALE.
    let new_spot_u128 = pyth_price_to_scale(price, exponent)?;

    // EMA confidence-interval gate (re-uses the VolOraclePriceStale catch-all).
    let conf_u128 = ema_conf as u128;
    let abs_ema = ema_price.unsigned_abs() as u128;
    require!(
        conf_u128
            .checked_mul(10_000)
            .ok_or(OptaError::MathOverflow)?
            <= abs_ema
                .checked_mul(max_conf_bps as u128)
                .ok_or(OptaError::MathOverflow)?,
        OptaError::VolOraclePriceStale
    );

    // One-sided freshness check.
    require!(
        publish_time.saturating_add(max_age_secs) >= now,
        OptaError::VolOraclePriceStale
    );

    Ok(new_spot_u128)
}
