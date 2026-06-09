// =============================================================================
// instructions/push_vol_sample.rs -- Permissionless realized-vol sample push
// =============================================================================
//
// Crank (or anyone) calls this once per hour per feed. The handler:
//   1. Validates the Pyth PriceUpdateV2 (proof-of-feed, verification level,
//      EMA confidence interval, freshness vs Clock).
//   2. Extracts the spot price (NOT the EMA -- realized vol is computed
//      from spot returns, not smoothed returns).
//   3. Rejects zero or negative spot (ln undefined).
//   4. Branches on whether the oracle has ever been pushed to:
//      - Seed branch (last_spot_price == 0): set last_spot + last_ts only,
//        skip rate limit, skip ring write, skip accumulator update.
//      - Normal branch: enforce rate limit, compute log return, ring + acc
//        update, advance last_spot + last_ts.
//
// Permissionless. Caller pays only the tx fee; no rent (the oracle was
// pre-allocated by initialize_vol_oracle).
//
// Storage note: VolOracle is `#[account(zero_copy)]`; we use
// `AccountLoader::load_mut()` to obtain a `RefMut<VolOracle>`. The mutable
// borrow is scoped tightly so the validator doesn't hold a write lock
// longer than necessary.
//
// Algorithm cross-reference: the ring + accumulator update step is mirrored
// verbatim by the `apply` helper in `state/vol_oracle.rs`'s `#[cfg(test)]`
// module, which audits this code path against a naive O(n) recompute.
// =============================================================================

use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::error::GetPriceError;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;
use pyth_solana_receiver_sdk::price_update::VerificationLevel;
use solmath::transcendental::ln_fixed_i;
use solmath::arithmetic::fp_div;

use crate::errors::OptaError;
use crate::state::{
    VolOracle, VOL_ORACLE_MAX_SAMPLE_GAP_SECS, VOL_ORACLE_MIN_PUSH_INTERVAL_SECS,
    VOL_ORACLE_PYTH_MAX_AGE_SECS, VOL_ORACLE_RING_SIZE, VOL_ORACLE_SEED,
};
use crate::utils::solmath_bridge::pyth_price_to_scale;

/// EMA confidence-interval gate, in basis points of the EMA price. Same
/// 200bps threshold settle_expiry uses (audit Run-6 CRIT-2). Pyth wide-
/// confidence prints during stress events would otherwise let an attacker
/// stuff garbage returns into the buffer.
pub const VOL_ORACLE_MAX_CONF_BPS: u16 = 200;

pub fn handle_push_vol_sample(ctx: Context<PushVolSample>) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;

    // --- 1. Pyth validation (proof, verification, confidence, freshness) ---
    let pu = &ctx.accounts.price_update;

    // Defer the load_mut until after all validation so the oracle isn't
    // write-locked unnecessarily on the reject paths.
    {
        let oracle_ro = ctx.accounts.vol_oracle.load()?;
        require!(
            pu.verification_level.gte(VerificationLevel::Full),
            GetPriceError::InsufficientVerificationLevel
        );
        require!(
            pu.price_message.feed_id == oracle_ro.feed_id,
            GetPriceError::MismatchedFeedId
        );
    }

    let price = pu.price_message.price;
    let exponent = pu.price_message.exponent;
    let publish_time = pu.price_message.publish_time;
    let ema_price = pu.price_message.ema_price;
    let ema_conf = pu.price_message.ema_conf;

    // 1a. Spot positivity gate. Runs BEFORE the EMA-confidence and
    //     freshness gates so a fundamentally garbage price (zero or
    //     negative) surfaces VolOracleInvalidSpot rather than getting
    //     misattributed to VolOraclePriceStale (which would happen for
    //     a zero-price fixture: ema_price tracks price, abs_ema = 0,
    //     conf-check rhs = 0 < lhs).
    require!(price > 0, OptaError::VolOracleInvalidSpot);

    // 1b. Convert (i64 price, i32 exponent) -> u128 at SCALE = 1e12.
    //     Returns InvalidSettlementPrice on price <= 0 OR sub-microUSDC
    //     truncation (HIGH-4 catch-all from settle_expiry). For our
    //     positive-spot gate above, the only realistic re-raise is the
    //     sub-micro truncation, which would propagate the existing
    //     variant -- semantically the same "spot too small to handle"
    //     rejection.
    let new_spot_u128 = pyth_price_to_scale(price, exponent)?;

    // 1c. EMA confidence-interval gate (mirrors settle_expiry CRIT-2).
    //     Even though we sample SPOT, we use the EMA confidence interval
    //     because Pyth's per-tick spot confidence can be noisy; EMA conf
    //     tracks the publisher's aggregate uncertainty more stably.
    let conf_u128 = ema_conf as u128;
    let abs_ema = ema_price.unsigned_abs() as u128;
    require!(
        conf_u128
            .checked_mul(10_000)
            .ok_or(OptaError::MathOverflow)?
            <= abs_ema
                .checked_mul(VOL_ORACLE_MAX_CONF_BPS as u128)
                .ok_or(OptaError::MathOverflow)?,
        OptaError::VolOraclePriceStale  // re-using the catch-all: bad print
    );

    // 1d. One-sided freshness check (same shape as settle_expiry's
    //     PYTH_MAX_AGE_SECS bound). publish_time may sit in the future
    //     without triggering rejection -- Pyth-signed messages with a
    //     future timestamp would have to be aggregator-anomalies and the
    //     proof-gate already rejects unsigned attestations.
    require!(
        publish_time.saturating_add(VOL_ORACLE_PYTH_MAX_AGE_SECS) >= now,
        OptaError::VolOraclePriceStale
    );

    // Cap conversion to i64 storage. Max i64 (9.2e18) accommodates spot
    // up to ~$9.2M at SCALE; BTC at $90k = 9e16 well under.
    let new_spot_i64 = i64::try_from(new_spot_u128)
        .map_err(|_| error!(OptaError::MathOverflow))?;

    // --- 3. Mutate the oracle ------------------------------------------------
    let mut oracle = ctx.accounts.vol_oracle.load_mut()?;

    // ---- 3a. Seed-push branch (CRITICAL — DO NOT collapse into normal) ----
    // Triggered when the oracle has never been pushed to (last_spot_price
    // is the default zero value from init). Rationale:
    //   - The first push has no prior spot to compute a return against;
    //     computing ln(new_spot / 0) is mathematical garbage.
    //   - The rate-limit check compares against last_sample_ts, which
    //     also reads as default zero on a fresh oracle -- making the
    //     rate-limit branch always evaluate "now - 0 >= 3300" = true,
    //     which is correct but only by accident. Skipping it explicitly
    //     documents intent.
    //   - sample_count stays at 0; the buffer is untouched. The seed
    //     push contributes to ts/spot tracking only, not to the vol
    //     estimate. The next push (after the rate-limit interval) is
    //     the first one that produces a real sample.
    //
    // A future optimization pass MUST NOT remove this branch without
    // first proving the "ln of new/0" path returns a defined value AND
    // that the resulting sample is meaningful. Both are false. Keep it.
    if oracle.last_spot_price == 0 {
        oracle.last_spot_price = new_spot_i64;
        oracle.last_sample_ts = now;
        msg!(
            "VolOracle seeded: pda={} spot={} ts={}",
            ctx.accounts.vol_oracle.key(),
            new_spot_i64,
            now,
        );
        return Ok(());
    }

    // ---- 3a-bis. Gap-reseed branch (audit AM-MED-2) -----------------------
    // If the oracle went unpushed for longer than VOL_ORACLE_MAX_SAMPLE_GAP_SECS
    // (e.g. a crank outage), the price move accumulated over that gap must NOT
    // be recorded as a single hourly log return: ln(new_spot / last_spot) over
    // a multi-period gap, annualized by sqrt(8760), injects an outlier that
    // inflates realized vol for as long as it lives in the ring (up to 30 days).
    // Instead RESEED — adopt the new spot as the baseline and record NO sample.
    // The next on-cadence push then computes a correct ~1h return off this
    // refreshed spot. Mirrors the last_spot_price == 0 seed branch above
    // (spot + ts only; ring, accumulators, and sample_count untouched).
    //
    // Placed BEFORE the rate-limit check because a gap this large trivially
    // satisfies it; the reseed is the intended action, not a normal push.
    // Note: this prevents FUTURE gap pollution; it does not clear an outlier
    // already resident in the ring from a pre-existing gap.
    if now.saturating_sub(oracle.last_sample_ts) > VOL_ORACLE_MAX_SAMPLE_GAP_SECS {
        oracle.last_spot_price = new_spot_i64;
        oracle.last_sample_ts = now;
        msg!(
            "VolOracle reseeded after gap: pda={} spot={} ts={} (no sample recorded)",
            ctx.accounts.vol_oracle.key(),
            new_spot_i64,
            now,
        );
        return Ok(());
    }

    // ---- 3b. Normal-push branch -------------------------------------------
    // 3b.i. Rate limit. With test-fast-vol the constant is 1s.
    require!(
        now.saturating_sub(oracle.last_sample_ts) >= VOL_ORACLE_MIN_PUSH_INTERVAL_SECS,
        OptaError::VolOraclePushTooSoon
    );

    // 3b.ii. Compute log return = ln(new_spot / last_spot) at SCALE.
    //        last_spot is stored as i64 but is provably positive (set in
    //        the seed branch from a `price > 0` validated value), so
    //        casting to u128 for fp_div is safe.
    let last_spot_u128 = oracle.last_spot_price as u128;
    let quotient = fp_div(new_spot_u128, last_spot_u128)
        .map_err(|_| error!(OptaError::MathOverflow))?;
    let log_return_i128 = ln_fixed_i(quotient)
        .map_err(|_| error!(OptaError::MathOverflow))?;
    let log_return_i64 = i64::try_from(log_return_i128)
        .map_err(|_| error!(OptaError::MathOverflow))?;

    // 3b.iii. Ring buffer + O(1) accumulator update.
    //         Cross-reference: replicated by `apply()` in state/vol_oracle.rs
    //         #[cfg(test)] module, which audits this against naive recompute.
    apply_normal_push(&mut oracle, log_return_i64);

    // 3b.iv. Advance the rolling state.
    oracle.last_spot_price = new_spot_i64;
    oracle.last_sample_ts = now;

    msg!(
        "VolOracle pushed: pda={} spot={} log_return={} sample_count={}",
        ctx.accounts.vol_oracle.key(),
        new_spot_i64,
        log_return_i64,
        oracle.sample_count,
    );
    Ok(())
}

/// Apply a log_return to the ring + accumulators. Pure mutation; no
/// validation. Extracted so the cu-profile instruction can measure the
/// hot path without the rate-limit + Pyth-validation overhead.
///
/// Mirrors the `apply()` test helper in state/vol_oracle.rs verbatim.
/// Any divergence here from that helper invalidates the unit-test audit.
pub fn apply_normal_push(oracle: &mut VolOracle, log_return: i64) {
    let lr_i128 = log_return as i128;
    if oracle.sample_count < VOL_ORACLE_RING_SIZE {
        oracle.samples[oracle.head as usize] = log_return;
        oracle.sum_log_returns += lr_i128;
        oracle.sum_log_returns_sq += lr_i128 * lr_i128;
        oracle.head = (oracle.head + 1) % VOL_ORACLE_RING_SIZE;
        oracle.sample_count += 1;
    } else {
        let evicted = oracle.samples[oracle.head as usize] as i128;
        oracle.sum_log_returns -= evicted;
        oracle.sum_log_returns_sq -= evicted * evicted;
        oracle.samples[oracle.head as usize] = log_return;
        oracle.sum_log_returns += lr_i128;
        oracle.sum_log_returns_sq += lr_i128 * lr_i128;
        oracle.head = (oracle.head + 1) % VOL_ORACLE_RING_SIZE;
    }
}

#[derive(Accounts)]
pub struct PushVolSample<'info> {
    /// Permissionless. Pays the tx fee only.
    pub signer: Signer<'info>,

    /// Fresh PriceUpdateV2 from the Pyth Receiver program. Validated
    /// against the oracle's feed_id and the 60s freshness window.
    pub price_update: Account<'info, PriceUpdateV2>,

    /// The VolOracle PDA. Mutated. PDA-validated against the price
    /// update's feed_id via the `seeds` constraint here; the handler
    /// re-checks the proof against price_update.price_message.feed_id
    /// for defense-in-depth against passing a stale PriceUpdateV2 from
    /// a different feed.
    #[account(
        mut,
        seeds = [VOL_ORACLE_SEED, vol_oracle.load()?.feed_id.as_ref()],
        bump = vol_oracle.load()?.bump,
    )]
    pub vol_oracle: AccountLoader<'info, VolOracle>,

    pub system_program: Program<'info, System>,
}
