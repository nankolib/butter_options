// =============================================================================
// instructions/cu_profile_get_option_price.rs -- Stage C Pass 3 CU profile
// =============================================================================
//
// Test-only instruction. Measures CU cost of the Pass 3 `price_american`
// helper -- the exact pricing path that `get_option_price` (and the AMER
// branch of `mint_from_vault`) executes per call.
//
// Two scenarios, both forcing the BS-2002 main path (q > 0 -> b < r):
//   S1 - Call, carry = 5% (BS-2002 main, direct call)
//   S2 - Put,  carry = 5% (McDonald-Schroder transform -> BS-2002 main)
//
// Mechanics:
//   1. Caller passes an already-initialized VolOracle PDA.
//   2. The handler synthesizes the same accumulator state used by
//      cu_profile_mint_from_vault_american so realized_vol_annualized
//      returns ~80% annualized vol.
//   3. sol_log_compute_units brackets each `price_american` call so the
//      TS test can parse "consumed N of M" from the program logs.
//
// Gated by the `cu-profile` Cargo feature. NEVER deploy a cu-profile build
// (same rule as cu_profile_american / cu_profile_mint_from_vault_american).
// =============================================================================

#![cfg(feature = "cu-profile")]

use anchor_lang::prelude::*;
use solana_program::log::sol_log_compute_units;
use solmath::SCALE;

use crate::state::{OptionType, VolOracle, VOL_ORACLE_SEED};
use crate::utils::american_pricing::quote::{price_american, AmericanQuoteInputs};

// Synthesized accumulators (same as cu_profile_mint_from_vault_american --
// yields sigma ~= 0.792 * SCALE, ~79% annualized vol).
const SYNTH_SAMPLE_COUNT: u16 = 720;
const SYNTH_SUM_LOG_RETURNS: i128 = 213_459_012_326;
const SYNTH_SUM_LOG_RETURNS_SQ: i128 = 51_603_174_085_658_138_726_748;
/// Synthetic spot at $100 SCALE = 1e12.
const SYNTH_SPOT_SCALED: i64 = 100 * (SCALE as i64);

/// Strike = $100, USDC 6-decimal smallest units.
const STRIKE_USDC: u64 = 100 * 1_000_000;
/// 5% carry; forces b < r so the BS-2002 main branch fires (not the q=0
/// European fast path). Same regime the plan targeted at 400K.
const CARRY_RATE_BPS: i32 = 500;
/// ~7 days from `now` -- matches the get_option_price target tenor.
const EXPIRY_OFFSET_SECS: i64 = 7 * 24 * 3600;

pub fn handle_cu_profile_get_option_price(
    ctx: Context<CuProfileGetOptionPrice>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;

    // -- Plant synthetic state (pre-measurement, not counted) --
    {
        let mut oracle = ctx.accounts.vol_oracle.load_mut()?;
        oracle.sample_count = SYNTH_SAMPLE_COUNT;
        oracle.last_sample_ts = now;
        oracle.sum_log_returns = SYNTH_SUM_LOG_RETURNS;
        oracle.sum_log_returns_sq = SYNTH_SUM_LOG_RETURNS_SQ;
        oracle.last_spot_price = SYNTH_SPOT_SCALED;
    }

    let expiry_ts = now + EXPIRY_OFFSET_SECS;
    let oracle = ctx.accounts.vol_oracle.load()?;

    msg!("=== S1: price_american CALL q=5% (BS-2002 main) ===");
    sol_log_compute_units();
    let s1 = price_american(
        &*oracle,
        now,
        AmericanQuoteInputs {
            strike: STRIKE_USDC,
            expiry_ts,
            option_type: OptionType::Call,
            carry_rate_bps: CARRY_RATE_BPS,
        },
    )?;
    sol_log_compute_units();
    msg!(
        "S1 result: premium={} vol={} spot={}",
        s1.premium_per_contract,
        s1.vol_used_scaled,
        s1.spot_used_scaled,
    );

    msg!("=== S2: price_american PUT  q=5% (McD-S -> BS-2002 main) ===");
    sol_log_compute_units();
    let s2 = price_american(
        &*oracle,
        now,
        AmericanQuoteInputs {
            strike: STRIKE_USDC,
            expiry_ts,
            option_type: OptionType::Put,
            carry_rate_bps: CARRY_RATE_BPS,
        },
    )?;
    sol_log_compute_units();
    msg!(
        "S2 result: premium={} vol={} spot={}",
        s2.premium_per_contract,
        s2.vol_used_scaled,
        s2.spot_used_scaled,
    );

    Ok(())
}

#[derive(Accounts)]
pub struct CuProfileGetOptionPrice<'info> {
    pub signer: Signer<'info>,

    /// The VolOracle to plant state on + read from. Must already be
    /// initialized (any existing oracle works -- we overwrite the
    /// accumulators in-place for the measurement).
    #[account(
        mut,
        seeds = [VOL_ORACLE_SEED, vol_oracle.load()?.feed_id.as_ref()],
        bump = vol_oracle.load()?.bump,
    )]
    pub vol_oracle: AccountLoader<'info, VolOracle>,
}
