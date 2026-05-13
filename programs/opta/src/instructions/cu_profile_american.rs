// =============================================================================
// instructions/cu_profile_american.rs -- CU profiling instruction for BS-2002
// =============================================================================
//
// Test-only instruction that exercises three pricing scenarios with
// `sol_log_compute_units` markers so a TS test can read per-scenario CU
// from the program logs. Per-phi breakdown comes from gated markers
// inside `bs2002_call_price` (utils/american_pricing/mod.rs).
//
// Gated by the `cu-profile` Cargo feature -- compiles to nothing in
// default builds. NEVER deploy a cu-profile build to devnet/mainnet.
//
// Phase 2 Stage A scope:
//     .context/plans/phase2-american-onchain-pricing-scope.md
// =============================================================================

#![cfg(feature = "cu-profile")]

use anchor_lang::prelude::*;
use solana_program::log::sol_log_compute_units;
use solmath::SCALE;

use crate::utils::american_pricing::{american_call_price, american_put_price};

pub fn handle_cu_profile_american(_ctx: Context<CuProfileAmerican>) -> Result<()> {
    // Common params for all 3 scenarios. Picked to avoid every edge-case
    // early return (sigma above zero-vol threshold, t above near-expiry,
    // moneyness moderate).
    let s = 100 * SCALE;          // spot $100
    let k = 100 * SCALE;          // strike $100
    let r = 5 * SCALE / 100;       // 5% risk-free
    let sigma = 4 * SCALE / 10;    // 40% vol
    let t = SCALE / 2;             // 6 months
    let q5: i128 = (5 * SCALE / 100) as i128; // 5% carry

    msg!("=== S1: american_call_price q=0 (fast path) ===");
    sol_log_compute_units();
    let s1 = american_call_price(s, k, r, 0, sigma, t).unwrap();
    sol_log_compute_units();
    msg!("S1 result: {}", s1);

    msg!("=== S2: american_call_price q=5% (BS-2002 main) ===");
    sol_log_compute_units();
    let s2 = american_call_price(s, k, r, q5, sigma, t).unwrap();
    sol_log_compute_units();
    msg!("S2 result: {}", s2);

    msg!("=== S3: american_put_price q=0 (McD-S -> BS-2002) ===");
    sol_log_compute_units();
    let s3 = american_put_price(s, k, r, 0, sigma, t).unwrap();
    sol_log_compute_units();
    msg!("S3 result: {}", s3);

    Ok(())
}

#[derive(Accounts)]
pub struct CuProfileAmerican<'info> {
    pub signer: Signer<'info>,
}
