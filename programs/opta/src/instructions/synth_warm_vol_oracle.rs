// =============================================================================
// instructions/synth_warm_vol_oracle.rs -- Plant a warmed VolOracle (TEST-ONLY)
// =============================================================================
//
// Test-only instruction. Writes synthetic-but-realistic warmed state directly
// into an already-initialized VolOracle PDA so the read path
// (`realized_vol_annualized`) returns Ok past all three gates:
//   - warmup:  sample_count = 720 (>= VOL_ORACLE_WARMUP_SAMPLES = 168)
//   - stale:   last_sample_ts = now (fresh within VOL_ORACLE_STALENESS_SECS)
//   - math:    sum / sum_sq from Vector 2 of scripts/gen_vol_test_vectors.py
//              (~79.2% annualized vol -- realistic crypto)
//
// It also sets `last_spot_price` from the caller-supplied `spot_price_scaled`
// (solmath SCALE = 1e12) so `price_american`'s positive-spot gate passes and
// the caller controls moneyness vs. their strike, and `last_sample_ts` from
// the caller so the staleness gate can be exercised deterministically:
//   - fresh:  pass now            -> reads Ok
//   - stale:  pass now - 7h       -> VolOracleStale
//   - zero spot: pass spot 0      -> VolOracleInvalidSpot (vol still Ok)
//
// This exists because warming an oracle the production way -- 168+ rate-limited
// push_vol_sample calls -- is infeasible on solana-test-validator: even at
// test-fast-vol's 1s rate limit, the seconds-granularity clock vs ~400ms slots
// produces sporadic VolOraclePushTooSoon mid-loop (see tests/zzz-vol-oracle.ts
// ring-wrap skip). Bankrun setClock is the eventual deterministic answer
// (Stage G); until then this synth instruction un-blocks the American test
// subset, which needs a warmed oracle but no clock warp.
//
// Mechanism mirrors cu_profile_realized_vol's accumulator synthesis exactly.
//
// Gated by the `test-synth-vol` Cargo feature. NEVER deploy a test-synth-vol
// build -- it would let anyone overwrite an oracle's realized-vol state with
// arbitrary values, destroying pricing integrity. Same never-ship discipline
// as cu-profile and test-fast-vol. The .test-fixtures launcher passes this
// feature only for the American test suite; production deploy scripts must not.
// =============================================================================

#![cfg(feature = "test-synth-vol")]

use anchor_lang::prelude::*;

use crate::state::{VolOracle, VOL_ORACLE_SEED};

/// Sample-count + accumulators from Vector 2 in scripts/gen_vol_test_vectors.py
/// (720 hourly returns calibrated for ~80% annualized vol; lands at ~79.2%).
/// Identical to the values cu_profile_realized_vol plants. Sharing the exact
/// constants keeps the synth path's vol output pinned to the audited V2
/// reference that state/vol_oracle.rs::tests asserts against.
pub const SYNTH_SAMPLE_COUNT: u16 = 720;
pub const SYNTH_SUM_LOG_RETURNS: i128 = 213_459_012_326;
pub const SYNTH_SUM_LOG_RETURNS_SQ: i128 = 51_603_174_085_658_138_726_748;

pub fn handle_synth_warm_vol_oracle(
    ctx: Context<SynthWarmVolOracle>,
    spot_price_scaled: i64,
    last_sample_ts: i64,
) -> Result<()> {
    let mut oracle = ctx.accounts.vol_oracle.load_mut()?;

    oracle.sample_count = SYNTH_SAMPLE_COUNT;
    oracle.last_sample_ts = last_sample_ts;
    oracle.sum_log_returns = SYNTH_SUM_LOG_RETURNS;
    oracle.sum_log_returns_sq = SYNTH_SUM_LOG_RETURNS_SQ;
    oracle.last_spot_price = spot_price_scaled;

    Ok(())
}

#[derive(Accounts)]
pub struct SynthWarmVolOracle<'info> {
    pub signer: Signer<'info>,

    #[account(
        mut,
        seeds = [VOL_ORACLE_SEED, vol_oracle.load()?.feed_id.as_ref()],
        bump = vol_oracle.load()?.bump,
    )]
    pub vol_oracle: AccountLoader<'info, VolOracle>,
}

// -----------------------------------------------------------------------------
// Unit test (host target). Asserts the exact state this instruction plants
// yields a warmed, fresh, in-band realized_vol_annualized. Compiled only under
// `test-synth-vol`, so `cargo test --features test-synth-vol` exercises it
// while feature-free `cargo test` never sees it.
// -----------------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::realized_vol_annualized;
    use bytemuck::Zeroable;
    use solmath::SCALE;

    #[test]
    fn synth_state_yields_warmed_realized_vol() {
        // Build an oracle with EXACTLY what handle_synth_warm_vol_oracle plants.
        let now: i64 = 1_700_000_000;
        let mut oracle = VolOracle::zeroed();
        oracle.sample_count = SYNTH_SAMPLE_COUNT;
        oracle.last_sample_ts = now;
        oracle.sum_log_returns = SYNTH_SUM_LOG_RETURNS;
        oracle.sum_log_returns_sq = SYNTH_SUM_LOG_RETURNS_SQ;
        oracle.last_spot_price = 180 * (SCALE as i64); // $180 at SCALE 1e12

        // Past warmup + stale gates, returns Ok with a realistic crypto sigma.
        let sigma = realized_vol_annualized(&oracle, now)
            .expect("synth'd oracle must read Ok (warmed + fresh)");

        // Same realistic-crypto band the V2 reference test asserts: [0.7, 0.9].
        let lower = 7 * (SCALE as i64) / 10;
        let upper = 9 * (SCALE as i64) / 10;
        assert!(
            sigma >= lower && sigma <= upper,
            "synth sigma {} not in realistic-crypto band [{}, {}]",
            sigma, lower, upper,
        );
    }
}
