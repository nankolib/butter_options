// =============================================================================
// instructions/cu_profile_mint_from_vault_american.rs -- Stage C Pass 2 CU profile
// =============================================================================
//
// Test-only instruction. Measures CU cost of the FULL American branch
// pipeline that mint_from_vault now runs on AMER vaults: VolOracle load,
// realized_vol_annualized read, then american_call_price / american_put_price.
// Excludes the Token-2022 mint creation cost (constant ~600K, same for EUR
// and AMER), so the headroom check is: pipeline CU < 800K leaves 600K for
// Token-2022 work under the 1.4M tx budget.
//
// Three scenarios (mirrors cu_profile_american.rs):
//   S1 - american_call_price q=0 (BS-2002 fast path == European)
//   S2 - american_call_price q=5% (BS-2002 main path)
//   S3 - american_put_price q=0 (McDonald-Schroder transform)
//
// Mechanics:
//   1. Caller passes an already-initialized VolOracle PDA.
//   2. The handler synthesizes the same Vector-2 accumulator state used by
//      cu_profile_realized_vol so realized_vol_annualized returns ~80% vol.
//      The samples[] array is NOT populated -- the function reads only
//      the fields set below.
//   3. sol_log_compute_units brackets each scenario so the TS test can
//      parse "consumed N of M" from the program logs.
//
// Gated by the `cu-profile` Cargo feature. NEVER deploy a cu-profile build
// (same rule as cu_profile_american and cu_profile_realized_vol).
// =============================================================================

#![cfg(feature = "cu-profile")]

use anchor_lang::prelude::*;
use solana_program::log::sol_log_compute_units;
use solmath::SCALE;

use crate::state::{realized_vol_annualized, VolOracle, VOL_ORACLE_SEED};
use crate::utils::american_pricing::{american_call_price, american_put_price};

/// Same synthesized accumulators as cu_profile_realized_vol -- yields
/// sigma ~= 0.792 * SCALE (~79% annualized vol).
const SYNTH_SAMPLE_COUNT: u16 = 720;
const SYNTH_SUM_LOG_RETURNS: i128 = 213_459_012_326;
const SYNTH_SUM_LOG_RETURNS_SQ: i128 = 51_603_174_085_658_138_726_748;
/// Synthetic spot at $100 SCALE = 1e12.
const SYNTH_SPOT_SCALED: i64 = 100 * (SCALE as i64);

pub fn handle_cu_profile_mint_from_vault_american(
    ctx: Context<CuProfileMintFromVaultAmerican>,
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

    // Common BS-2002 inputs across all 3 scenarios.
    let k = 100 * SCALE;                       // strike $100
    let r = 5 * SCALE / 100;                    // 5% risk-free (matches handler const)
    let t = SCALE / 2;                          // 6 months
    let q5: i128 = (5 * SCALE / 100) as i128;   // 5% carry

    // ---- Measured pipeline: load + read vol + read spot ----
    let oracle = ctx.accounts.vol_oracle.load()?;

    msg!("=== S1: american_call_price q=0 (fast path) ===");
    sol_log_compute_units();
    let sigma = realized_vol_annualized(&*oracle, now)?;
    let sigma_u = sigma as u128;
    let s = oracle.last_spot_price as u128;
    let s1 = american_call_price(s, k, r, 0, sigma_u, t)
        .map_err(|_| error!(crate::errors::OptaError::AmericanPricingFailed))?;
    sol_log_compute_units();
    msg!("S1 result: {}", s1);

    msg!("=== S2: american_call_price q=5% (BS-2002 main) ===");
    sol_log_compute_units();
    let s2 = american_call_price(s, k, r, q5, sigma_u, t)
        .map_err(|_| error!(crate::errors::OptaError::AmericanPricingFailed))?;
    sol_log_compute_units();
    msg!("S2 result: {}", s2);

    msg!("=== S3: american_put_price q=0 (McD-S -> BS-2002) ===");
    sol_log_compute_units();
    let s3 = american_put_price(s, k, r, 0, sigma_u, t)
        .map_err(|_| error!(crate::errors::OptaError::AmericanPricingFailed))?;
    sol_log_compute_units();
    msg!("S3 result: {}", s3);

    Ok(())
}

#[derive(Accounts)]
pub struct CuProfileMintFromVaultAmerican<'info> {
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
