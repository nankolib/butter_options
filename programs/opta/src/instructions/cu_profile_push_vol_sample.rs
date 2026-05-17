// =============================================================================
// instructions/cu_profile_push_vol_sample.rs -- Hot-path CU profile (Stage B)
// =============================================================================
//
// Test-only instruction. Measures the CU cost of a normal-branch push:
// log_return calc (fp_div + ln_fixed_i) + ring-buffer write +
// O(1) accumulator update. The Pyth-validation and rate-limit overhead
// are excluded so the measurement isolates the algorithmic hot path
// that Stage C will end up touching from create_shared_vault.
//
// Gated by the `cu-profile` Cargo feature -- compiles to nothing in
// default builds. NEVER deploy a cu-profile build to devnet/mainnet
// (same rule as cu_profile_american).
//
// Mechanics:
//   1. Caller passes a pre-initialized + pre-seeded VolOracle PDA. To
//      seed, run initialize_vol_oracle followed by one push_vol_sample.
//   2. The handler bypasses the rate-limit and Pyth-validation paths by
//      calling apply_normal_push directly with a synthetic log_return
//      that simulates a +1% spot move (ln(1.01) ~= 9.95e9 at SCALE=1e12).
//   3. sol_log_compute_units brackets the call so the TS test can parse
//      "consumed N of M compute units" from the tx log.
//
// Phase 2 Stage B scope:
//     .context/plans/phase2-american-onchain-pricing-scope.md
// =============================================================================

#![cfg(feature = "cu-profile")]

use anchor_lang::prelude::*;
use solana_program::log::sol_log_compute_units;

use crate::instructions::push_vol_sample::apply_normal_push;
use crate::state::{VolOracle, VOL_ORACLE_SEED};

/// Synthetic log return ~= ln(1.01) at SCALE=1e12. Picked deliberately
/// to match a realistic hourly move; CU cost of the accumulator math
/// is constant w.r.t. value, but using a "typical" magnitude documents
/// intent and prevents future readers from inferring the CU depends
/// on input scale.
const SYNTHETIC_LOG_RETURN: i64 = 9_950_330_853; // ln(1.01) * 1e12, rounded

pub fn handle_cu_profile_push_vol_sample(
    ctx: Context<CuProfilePushVolSample>,
) -> Result<()> {
    let mut oracle = ctx.accounts.vol_oracle.load_mut()?;

    // Sanity: refuse to profile against a never-seeded oracle. The
    // accumulator hot path only fires on the normal-push branch.
    require!(
        oracle.last_spot_price != 0,
        crate::errors::OptaError::VolOracleNotInitialized
    );

    msg!("=== CU PROFILE: push_vol_sample hot path ===");
    sol_log_compute_units();
    apply_normal_push(&mut oracle, SYNTHETIC_LOG_RETURN);
    sol_log_compute_units();
    msg!(
        "cu-profile post-state: sample_count={} head={} sum_log_returns={}",
        oracle.sample_count,
        oracle.head,
        oracle.sum_log_returns,
    );

    Ok(())
}

#[derive(Accounts)]
pub struct CuProfilePushVolSample<'info> {
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [VOL_ORACLE_SEED, vol_oracle.load()?.feed_id.as_ref()],
        bump = vol_oracle.load()?.bump,
    )]
    pub vol_oracle: AccountLoader<'info, VolOracle>,
}
