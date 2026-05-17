// =============================================================================
// instructions/cu_profile_realized_vol.rs -- realized_vol_annualized CU profile
// =============================================================================
//
// Test-only instruction. Measures CU cost of the read function Stage C's
// create_shared_vault (American branch) will call from on-chain when
// pricing an American option. Stage B target: < 8K CU.
//
// Mechanics:
//   1. Caller passes an already-initialized VolOracle PDA (cheapest path:
//      tests/zzz-vol-oracle.ts's existing init flow).
//   2. The handler synthesizes realistic Stage-B-Vector-2 accumulator
//      values directly into the account (sample_count=720, last_ts=now,
//      sum/sum_sq from the 80%-annual-vol Python vector). The samples[]
//      array is NOT populated -- the function reads only the fields the
//      synth above sets.
//   3. sol_log_compute_units brackets the call to realized_vol_annualized
//      so the TS test can parse "consumed N of M" from the tx log.
//
// Gated by the `cu-profile` Cargo feature. NEVER deploy a cu-profile
// build (same rule as cu_profile_american and cu_profile_push_vol_sample).
// =============================================================================

#![cfg(feature = "cu-profile")]

use anchor_lang::prelude::*;
use solana_program::log::sol_log_compute_units;

use crate::state::{realized_vol_annualized, VolOracle, VOL_ORACLE_SEED};

/// Sample-count + accumulators from Vector 2 in scripts/gen_vol_test_vectors.py.
/// Represents 720 hourly returns drawn from N(0, sigma_h) where sigma_h is
/// calibrated for ~80% annualized vol. Yields sigma ~= 0.792 * SCALE.
const SYNTH_SAMPLE_COUNT: u16 = 720;
const SYNTH_SUM_LOG_RETURNS: i128 = 213_459_012_326;
const SYNTH_SUM_LOG_RETURNS_SQ: i128 = 51_603_174_085_658_138_726_748;

pub fn handle_cu_profile_realized_vol(
    ctx: Context<CuProfileRealizedVol>,
) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let mut oracle = ctx.accounts.vol_oracle.load_mut()?;

    // Plant the synthetic accumulators (pre-measurement, not counted).
    oracle.sample_count = SYNTH_SAMPLE_COUNT;
    oracle.last_sample_ts = now;
    oracle.sum_log_returns = SYNTH_SUM_LOG_RETURNS;
    oracle.sum_log_returns_sq = SYNTH_SUM_LOG_RETURNS_SQ;

    msg!("=== CU PROFILE: realized_vol_annualized ===");
    sol_log_compute_units();
    let sigma = realized_vol_annualized(&*oracle, now)?;
    sol_log_compute_units();
    msg!("realized_vol_annualized = {}", sigma);

    Ok(())
}

#[derive(Accounts)]
pub struct CuProfileRealizedVol<'info> {
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [VOL_ORACLE_SEED, vol_oracle.load()?.feed_id.as_ref()],
        bump = vol_oracle.load()?.bump,
    )]
    pub vol_oracle: AccountLoader<'info, VolOracle>,
}
