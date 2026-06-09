// =============================================================================
// state/vol_oracle.rs -- Per-asset realized-volatility ring buffer (Stage B)
// =============================================================================
//
// One VolOracle PDA per Pyth feed. Holds 720 hourly log-return samples and
// O(1) rolling accumulators (sum, sum_of_squares) so the realized-vol calc
// at read time is constant-cost regardless of buffer fill.
//
// Push side: the crank calls push_vol_sample once per hour per feed. The
// handler computes ln(new_spot / last_spot_price) from a fresh Pyth Pull
// PriceUpdateV2 and the on-chain `last_spot_price` from the previous push.
// Spot history is NOT retained -- only the most recent spot, plus the
// derived log returns, lives on chain. (See "Layout decision" below.)
//
// Read side: realized_vol_annualized(...) is a pure function consumed by
// Stage C's create_shared_vault for American vaults. Two gates:
//   - Warmup: sample_count < VOL_ORACLE_WARMUP_SAMPLES (168 = 7 days)
//   - Stale:  last_sample_ts older than VOL_ORACLE_STALENESS_SECS (6h)
//
// PDA seed: [b"vol_oracle", feed_id.as_ref()]. Keying on feed_id (not
// asset_name) makes the oracle survive an OptionsMarket rename and lets
// one oracle serve every market that references the same Pyth feed.
//
// Layout decision (Stage B Step 1, 2026-05-17):
// We store `last_spot_price: i64` only -- NOT a full `spot_prices: [i64; 720]`
// array. Reasoning:
//   - Halves account size and proportionally cuts push CU.
//   - Log returns themselves are stored in `samples`; the accumulator can
//     be audited against a fresh sum of that array. Nothing structural
//     requires spot history.
//   - If the realized-vol formula ever changes, the right move is a fresh
//     warmup window, not a backfill from spot history.
//
// Storage decision (Stage B Step 2, 2026-05-17, after build-time pivot):
// VolOracle is `#[account(zero_copy)]` + `#[repr(C)]` because the 5760-byte
// `samples` array exceeds the BPF stack ceiling (~4KB) when Anchor's
// `Account<T>` flow tries to Borsh-deserialize the struct onto the stack.
// Zero-copy keeps the bytes in the account data region and accesses them
// via `AccountLoader<T>` + bytemuck casts, never materializing the full
// struct on the stack. Field order below is dictated by `#[repr(C)]` +
// `bytemuck::Pod` alignment requirements (i128 first to anchor 16-alignment
// from offset 0); a compile-time `const _: () = assert!` at the bottom of
// this module locks the layout against silent drift.
//
// Future-extension contract (mirrors SharedVault.carry_rate_bps in Stage A):
// any new field MUST be appended AFTER `bump` and BEFORE `_padding`, with
// `_padding` shrunk by the new field's byte count to preserve the 5856-byte
// total. Anchor's typed Account deser is strict on length, so pre-existing
// oracles would need an admin-only realloc migration instruction (same
// pattern as migrate_shared_vault_carry_rate). Do NOT insert fields
// mid-struct; the layout assertion will fire if anyone tries.
// =============================================================================

use anchor_lang::prelude::*;
use solmath::{fp_sqrt, SCALE};

use crate::errors::OptaError;

#[account(zero_copy)]
#[repr(C)]
pub struct VolOracle {
    /// Running sum of all populated samples (i.e. of `samples[0..sample_count]`).
    /// i128 chosen for headroom: per-sample magnitude max ~ln(10)*SCALE
    /// = 2.3e12; sum across 720 samples bounded at ~1.66e15 -- well under
    /// i128::MAX (1.7e38). O(1) update on each push: add new, subtract evicted.
    /// Placed first so `#[repr(C)]` gives the struct 16-byte alignment from
    /// offset 0; reordering this field below an i64 introduces compiler-
    /// inserted gap bytes that violate bytemuck::Pod.
    pub sum_log_returns: i128,

    /// Running sum of squared samples (raw i64*i64 product, NOT re-scaled).
    /// Per-sample bound (2.3e12)^2 = 5.3e24; sum across 720 = 3.8e27;
    /// fits comfortably in i128. The variance formula descales at read
    /// time, dividing by SCALE^2 (= 1e24) to recover unit variance.
    pub sum_log_returns_sq: i128,

    /// 32-byte Pyth Pull feed ID. PDA seed.
    pub feed_id: [u8; 32],

    /// Ring buffer of hourly log returns at solmath SCALE (1e12).
    /// `samples[i] = ln(spot_i / spot_{i-1}) * SCALE`. Always 720 slots;
    /// `sample_count` tracks how many are populated.
    pub samples: [i64; VOL_ORACLE_RING_SIZE as usize],

    /// Unix timestamp of the most recent successful push. Drives both
    /// the push-side rate limit (VOL_ORACLE_MIN_PUSH_INTERVAL_SECS) and
    /// the read-side staleness gate (VOL_ORACLE_STALENESS_SECS).
    pub last_sample_ts: i64,

    /// Spot price at the time of the most recent push, at solmath SCALE
    /// (1e12). Used by the next push to compute log_return without
    /// reading Pyth history. Replaces the dropped `spot_prices` array.
    /// Stored as i64 (positive only): max i64 ~9.2e18 accommodates spot
    /// prices up to ~$9.2M at SCALE=1e12, comfortably covering BTC and
    /// every equity Opta currently lists.
    pub last_spot_price: i64,

    /// Next write index in the ring buffer (0..720). Wraps mod 720.
    pub head: u16,

    /// Number of populated samples. Saturates at VOL_ORACLE_RING_SIZE.
    /// American vault creation is gated on >= VOL_ORACLE_WARMUP_SAMPLES.
    pub sample_count: u16,

    /// PDA bump seed.
    pub bump: u8,

    /// MANDATORY Pod alignment padding -- NOT reserved future-field space.
    /// `bytemuck::Pod` requires zero uninitialized bytes; this pads the
    /// struct to a 16-byte boundary (i128 alignment). Future fields must
    /// be appended AFTER `bump` and BEFORE this padding, reducing
    /// `_padding` correspondingly. Any schema change still requires an
    /// explicit admin migration instruction (same pattern as Stage A
    /// `migrate_shared_vault_carry_rate`).
    _padding: [u8; 11],
}

/// PDA seed prefix for VolOracle accounts.
pub const VOL_ORACLE_SEED: &[u8] = b"vol_oracle";

/// Ring buffer slot count (30 days * 24 hours = 720).
pub const VOL_ORACLE_RING_SIZE: u16 = 720;

/// Warmup gate: minimum samples (7 days * 24 hours = 168) before the
/// oracle is considered live. American vault creation (Stage C) reverts
/// below this with VolOracleWarmup.
pub const VOL_ORACLE_WARMUP_SAMPLES: u16 = 168;

/// Read-side staleness threshold (6 hours). Reads with last_sample_ts
/// older than this revert with VolOracleStale.
pub const VOL_ORACLE_STALENESS_SECS: i64 = 6 * 3600;

/// Push-side rate limit (55 minutes in production). Second push within
/// this window reverts with VolOraclePushTooSoon. 5-minute jitter from
/// the nominal 1-hour cadence so the crank doesn't have to be
/// metronome-precise.
///
/// The `test-fast-vol` cargo feature shrinks this to 1 second so
/// solana-test-validator (no clock-warp helper) can exercise the
/// rate-limit + ring-buffer paths in real wall-clock time. NEVER enable
/// `test-fast-vol` in a production deploy -- it removes the protection
/// that prevents push-spam attacks from skewing the realized-vol
/// estimate. The deploy pipeline must not pass --features test-fast-vol.
#[cfg(feature = "test-fast-vol")]
pub const VOL_ORACLE_MIN_PUSH_INTERVAL_SECS: i64 = 1;
#[cfg(not(feature = "test-fast-vol"))]
pub const VOL_ORACLE_MIN_PUSH_INTERVAL_SECS: i64 = 55 * 60;

/// Maximum tolerated gap between two consecutive pushes (2 hours = 2× the
/// nominal ~1h cadence). When `now - last_sample_ts` EXCEEDS this, the next
/// push is treated as a RESEED, not a sample (audit AM-MED-2): the price move
/// accumulated over the gap would otherwise be recorded as a single hourly
/// log return and mis-annualized by `sqrt(8760)`, injecting an outlier that
/// inflates realized vol for as long as it lives in the ring (up to 30 days).
/// On a gap the handler refreshes `last_spot_price` + `last_sample_ts` ONLY —
/// no ring write, no accumulator change, no `sample_count` increment — so the
/// next on-cadence push computes a correct ~1h return off the refreshed spot.
///
/// Deliberately NOT shrunk by `test-fast-vol`: this is a cadence-semantic
/// guard, not a rate limit. Tests exercise it by advancing a synthetic
/// `now_ts` past the gap rather than waiting wall-clock.
pub const VOL_ORACLE_MAX_SAMPLE_GAP_SECS: i64 = 7200;

/// Pyth update freshness threshold for the push path. publish_time must
/// be within this many seconds of the on-chain clock at push time.
/// Mirrors the philosophy of settle_expiry's EXPIRY_WINDOW_SECS but is
/// time-anchored to `now` rather than to a vault's expiry.
pub const VOL_ORACLE_PYTH_MAX_AGE_SECS: i64 = 60;

/// `sqrt(8760)` rounded to nearest integer at SCALE = 1e12. 8760 = hours
/// per year (24 * 365). Pinned as a compile-time constant; verified via
/// `scripts/gen_vol_test_vectors.py` and the
/// `sqrt_hours_per_year_constant_matches_python` test below.
///
///   sqrt(8760) ≈ 93.594871654380725
///   * 1e12      ≈ 93594871654380.725
///   rounded     = 93_594_871_654_381
pub const SQRT_HOURS_PER_YEAR_SCALED: i64 = 93_594_871_654_381;

// -----------------------------------------------------------------------------
// Read function: realized_vol_annualized
// -----------------------------------------------------------------------------
//
// Pure function (not an instruction). Computes annualized realized vol from
// the oracle's on-chain accumulators. Stage C's `create_shared_vault` (for
// American vaults) will call this from on-chain.
//
// Algorithm: sample variance (ddof=1; matches Deribit DVOL + numpy.var
// default), annualized by sqrt(8760).
//
// Scale tracking (CRITICAL -- audit any change against this table):
//   sum_log_returns         : SCALE        (sum of i64 SCALE samples)
//   sum_log_returns_sq      : SCALE^2      (sum of squared samples, raw)
//   mean = sum / n          : SCALE
//   mean^2                  : SCALE^2
//   n * mean^2              : SCALE^2
//   sum_sq - n*mean^2       : SCALE^2
//   variance = (...) / (n-1): SCALE^2
//   variance / SCALE        : SCALE        (input to fp_sqrt)
//   fp_sqrt(...)            : SCALE        (= sigma_hourly at SCALE)
//   sigma_h * SQRT_HPY / SCALE: SCALE      (= sigma_annual at SCALE)
//
// The `variance / SCALE` integer-division step loses at most SCALE-1 in
// the variance, which translates to ~1ppm relative error in sigma at the
// volatility levels we care about. The Python-reference unit test bounds
// this empirically at 0.1%.
//
// Returns Err on:
//   - sample_count < VOL_ORACLE_WARMUP_SAMPLES (Warmup gate)
//   - now_ts - last_sample_ts > VOL_ORACLE_STALENESS_SECS (Stale gate)
//   - any solmath primitive returning an error (should be unreachable
//     given the warmup gate guarantees n >= 168 and positive variance
//     invariant, but defensive)
pub fn realized_vol_annualized(
    oracle: &VolOracle,
    now_ts: i64,
) -> Result<i64> {
    // Gate 1: warmup. Cheapest check first.
    require!(
        oracle.sample_count >= VOL_ORACLE_WARMUP_SAMPLES,
        OptaError::VolOracleWarmup
    );

    // Gate 2: staleness. last_sample_ts is set on every push including
    // the seed push, so it's always populated when sample_count > 0.
    require!(
        now_ts.saturating_sub(oracle.last_sample_ts) <= VOL_ORACLE_STALENESS_SECS,
        OptaError::VolOracleStale
    );

    // Hot path: variance + sqrt + annualization.
    let n = oracle.sample_count as i128;
    let n_minus_1 = n - 1;  // guaranteed >= 167 by warmup gate
    let sum = oracle.sum_log_returns;
    let sum_sq = oracle.sum_log_returns_sq;

    // mean at SCALE (signed integer division)
    let mean = sum / n;

    // n * mean^2 at SCALE^2 (use checked_mul for defense; overflow would
    // require sum well outside the physical range of log returns)
    let mean_sq = mean
        .checked_mul(mean)
        .ok_or(OptaError::VolOracleMathError)?;
    let n_mean_sq = n
        .checked_mul(mean_sq)
        .ok_or(OptaError::VolOracleMathError)?;

    // numerator at SCALE^2. Clamp to 0 on negative (would only happen via
    // numerical artifact in pathological near-zero-variance cases; the
    // ddof=1 sample variance formula is non-negative on real data).
    let var_numerator = sum_sq.saturating_sub(n_mean_sq);
    let variance_raw = if var_numerator <= 0 {
        0i128
    } else {
        var_numerator / n_minus_1
    };

    // fp_sqrt operates on SCALE input -> SCALE output. To take sqrt of a
    // SCALE^2 value and land at SCALE, divide by SCALE first. Loses ~1ppm
    // of precision (bounded by Python-reference test).
    let scaled_for_sqrt = (variance_raw / (SCALE as i128)) as u128;
    let sigma_hourly_u = fp_sqrt(scaled_for_sqrt)
        .map_err(|_| error!(OptaError::VolOracleMathError))?;
    let sigma_hourly = sigma_hourly_u as i128;

    // Annualize: sigma_h * sqrt(8760) / SCALE keeps result at SCALE.
    let annualized_i128 = sigma_hourly
        .checked_mul(SQRT_HOURS_PER_YEAR_SCALED as i128)
        .ok_or(OptaError::VolOracleMathError)?
        / (SCALE as i128);

    i64::try_from(annualized_i128).map_err(|_| error!(OptaError::VolOracleMathError))
}

// -----------------------------------------------------------------------------
// Compile-time layout assertion
// -----------------------------------------------------------------------------
// Locks the on-disk byte size of VolOracle. If a future change reorders
// fields, adds one without shrinking `_padding`, or inadvertently flips
// alignment, the build fails here with a clear pointer to this file.
// Update the constant ONLY in coordination with an admin realloc
// migration instruction for pre-existing on-chain accounts.
const _: () = assert!(
    std::mem::size_of::<VolOracle>() == 5856,
    "VolOracle layout drift -- update size constant and audit field offsets"
);

// -----------------------------------------------------------------------------
// Pure-logic unit tests (host target, no validator, no Pyth)
// -----------------------------------------------------------------------------
// Replaces what would otherwise be an integration test for the O(1)
// accumulator algorithm. Validator-side tests (`tests/zzz-vol-oracle.ts`)
// can't easily push 1000 samples through real rate-limited handlers; this
// pure-Rust test runs in milliseconds via `cargo test` and gives stronger
// assurance because it isolates the ring + accumulator algebra from every
// other moving part (Pyth fixture freshness, RPC latency, clock drift).
//
// The tests intentionally replicate the same update sequence that
// `push_vol_sample::apply_normal_push` performs, then cross-check the
// running accumulators against a naive recompute over the buffer slice.
// If the production handler's algorithm ever diverges from what's
// duplicated here, this test will pass while the handler is broken --
// so any change to the production update sequence MUST be mirrored here.
#[cfg(test)]
mod tests {
    use super::*;
    use bytemuck::Zeroable;

    /// Replicates the production handler's ring-buffer + accumulator
    /// update step. Kept inline (not extracted to a shared helper) so the
    /// test is self-contained reference math the production code is
    /// audited against -- not the other way around.
    fn apply(oracle: &mut VolOracle, log_return: i64) {
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

    fn naive_sum(oracle: &VolOracle) -> i128 {
        let n = oracle.sample_count as usize;
        oracle.samples[..n].iter().map(|&x| x as i128).sum()
    }

    fn naive_sum_sq(oracle: &VolOracle) -> i128 {
        let n = oracle.sample_count as usize;
        oracle.samples[..n]
            .iter()
            .map(|&x| (x as i128) * (x as i128))
            .sum()
    }

    #[test]
    fn layout_is_exactly_5856_bytes() {
        // Mirror of the module-level `const _: () = assert!(...)` so the
        // failure surfaces with a friendlier message during `cargo test`
        // rather than only at compile time.
        assert_eq!(std::mem::size_of::<VolOracle>(), 5856);
    }

    #[test]
    fn o1_accumulator_matches_naive_pre_saturation() {
        // 200 synthetic samples spanning positive + negative returns of
        // varying magnitude. Stays below the ring size (720) so this
        // exercises the append-only branch.
        let mut oracle = VolOracle::zeroed();
        for i in 0..200i64 {
            // Returns from ~-5% to ~+5% at SCALE.
            let lr = ((i % 11) - 5) * 1_000_000_000;
            apply(&mut oracle, lr);
        }
        assert_eq!(oracle.sample_count, 200);
        assert_eq!(oracle.head, 200);
        assert_eq!(oracle.sum_log_returns, naive_sum(&oracle));
        assert_eq!(oracle.sum_log_returns_sq, naive_sum_sq(&oracle));
    }

    #[test]
    fn o1_accumulator_matches_naive_at_exactly_full() {
        // Fill the ring exactly to capacity (no wrap yet). head should
        // wrap to 0 on the 720th sample because (719+1) % 720 == 0.
        let mut oracle = VolOracle::zeroed();
        for i in 0..VOL_ORACLE_RING_SIZE as i64 {
            let lr = ((i % 7) - 3) * 2_000_000_000;
            apply(&mut oracle, lr);
        }
        assert_eq!(oracle.sample_count, VOL_ORACLE_RING_SIZE);
        assert_eq!(oracle.head, 0);
        assert_eq!(oracle.sum_log_returns, naive_sum(&oracle));
        assert_eq!(oracle.sum_log_returns_sq, naive_sum_sq(&oracle));
    }

    #[test]
    fn o1_accumulator_matches_naive_post_wrap() {
        // Push 1500 samples (more than 2 full rings). The accumulators
        // must reflect the *most recent 720 samples* only -- the test
        // confirms this by comparing against a naive sum over a fresh
        // 720-element vec built from the same input tail.
        let total = 1500usize;
        let inputs: Vec<i64> = (0..total as i64)
            .map(|i| (((i * 7) % 17) - 8) * 750_000_000)
            .collect();

        let mut oracle = VolOracle::zeroed();
        for &lr in &inputs {
            apply(&mut oracle, lr);
        }

        assert_eq!(oracle.sample_count, VOL_ORACLE_RING_SIZE);

        // Expected = sum/sum_sq over the last 720 inputs.
        let tail = &inputs[total - VOL_ORACLE_RING_SIZE as usize..];
        let expected_sum: i128 = tail.iter().map(|&x| x as i128).sum();
        let expected_sum_sq: i128 = tail
            .iter()
            .map(|&x| (x as i128) * (x as i128))
            .sum();
        assert_eq!(oracle.sum_log_returns, expected_sum);
        assert_eq!(oracle.sum_log_returns_sq, expected_sum_sq);

        // And cross-check against the live ring's own naive recompute.
        assert_eq!(oracle.sum_log_returns, naive_sum(&oracle));
        assert_eq!(oracle.sum_log_returns_sq, naive_sum_sq(&oracle));
    }

    // -------------------------------------------------------------------------
    // realized_vol_annualized: warmup + stale gates
    // -------------------------------------------------------------------------

    /// Convenience: build an oracle with a given sample_count and last_ts;
    /// other fields zero. Use for gate-only tests (no math performed).
    fn make_oracle_for_gates(sample_count: u16, last_ts: i64) -> VolOracle {
        let mut oracle = VolOracle::zeroed();
        oracle.sample_count = sample_count;
        oracle.last_sample_ts = last_ts;
        oracle
    }

    #[test]
    fn realized_vol_warmup_blocks_below_168() {
        let oracle = make_oracle_for_gates(167, 1_000_000_000);
        let err = realized_vol_annualized(&oracle, 1_000_000_000).unwrap_err();
        // anchor errors stringify like "AnchorError caused by account: ... Error
        // Code: VolOracleWarmup". The cleanest cross-version assertion is by
        // error-code name in the formatted output.
        let s = format!("{:?}", err);
        assert!(s.contains("VolOracleWarmup"), "expected Warmup, got: {}", s);
    }

    #[test]
    fn realized_vol_warmup_passes_at_168() {
        // 168 identical zero returns -> variance 0 -> sigma 0 (legal Ok)
        let mut oracle = make_oracle_for_gates(168, 1_000_000_000);
        // Accumulators zero -> variance zero, sigma zero. Function returns Ok(0).
        let result = realized_vol_annualized(&oracle, 1_000_000_000).unwrap();
        assert_eq!(result, 0);
        let _ = &mut oracle;
    }

    #[test]
    fn realized_vol_stale_blocks_past_6h() {
        let oracle = make_oracle_for_gates(200, 1_000_000_000);
        // now > last + 6h + 1s
        let now = 1_000_000_000 + (6 * 3600) + 1;
        let err = realized_vol_annualized(&oracle, now).unwrap_err();
        let s = format!("{:?}", err);
        assert!(s.contains("VolOracleStale"), "expected Stale, got: {}", s);
    }

    #[test]
    fn realized_vol_stale_passes_at_6h_minus_1() {
        let oracle = make_oracle_for_gates(200, 1_000_000_000);
        // now = last + 6h - 1s (within window)
        let now = 1_000_000_000 + (6 * 3600) - 1;
        assert!(realized_vol_annualized(&oracle, now).is_ok());
    }

    #[test]
    fn realized_vol_zero_vol_constant_returns() {
        // 200 identical samples -> variance = 0 -> sigma = 0
        let mut oracle = VolOracle::zeroed();
        let r = 5_000_000_000i64; // any constant value at SCALE
        for _ in 0..200 {
            apply(&mut oracle, r);
        }
        oracle.last_sample_ts = 1_000_000_000;
        let sigma = realized_vol_annualized(&oracle, 1_000_000_000).unwrap();
        // SCALE = 1e12; 1ppm = SCALE / 1_000_000 = 1_000_000. Allow that.
        assert!(sigma.abs() < (SCALE as i64) / 1_000_000,
            "expected sigma ~= 0 for constant returns, got {}", sigma);
    }

    // -------------------------------------------------------------------------
    // realized_vol_annualized: Python-reference correctness
    // -------------------------------------------------------------------------
    //
    // The constants below are pasted from `scripts/gen_vol_test_vectors.py`.
    // Regenerate via:
    //   wsl -e bash -lc "cd /mnt/d/claude\ everything/butter_options && \
    //                    python3 scripts/gen_vol_test_vectors.py"
    // and copy the V1/V2/V3 blocks verbatim. Tolerance per Stage B prompt:
    // on-chain integer math must agree with the Python round-trip reference
    // within 0.1% relative error.

    // ---- Vector 1: 200 samples, N(0, 0.01) (~93% annual vol, lands at 86%) ---
    const V1_SAMPLE_COUNT: u16 = 200;
    const V1_SUM_LOG_RETURNS: i128 = 232259256639;
    const V1_SUM_LOG_RETURNS_SQ: i128 = 17264374622445104132799;
    const V1_EXPECTED_SIGMA_SCALED: i64 = 864931398866;

    // ---- Vector 2: 720 samples, ~80% target crypto vol -----------------------
    const V2_SAMPLE_COUNT: u16 = 720;
    const V2_SUM_LOG_RETURNS: i128 = 213459012326;
    const V2_SUM_LOG_RETURNS_SQ: i128 = 51603174085658138726748;
    const V2_EXPECTED_SIGMA_SCALED: i64 = 792427156365;

    // ---- Vector 3: 720 samples, ~10% target FX vol ---------------------------
    const V3_SAMPLE_COUNT: u16 = 720;
    const V3_SUM_LOG_RETURNS: i128 = 19533328696;
    const V3_SUM_LOG_RETURNS_SQ: i128 = 814746029569655859492;
    const V3_EXPECTED_SIGMA_SCALED: i64 = 99599566946;

    fn build_oracle_from_vector(
        sample_count: u16,
        sum_log_returns: i128,
        sum_log_returns_sq: i128,
    ) -> VolOracle {
        let mut oracle = VolOracle::zeroed();
        oracle.sample_count = sample_count;
        oracle.last_sample_ts = 1_000_000_000;
        oracle.sum_log_returns = sum_log_returns;
        oracle.sum_log_returns_sq = sum_log_returns_sq;
        oracle
    }

    fn assert_within_relative_tolerance(actual: i64, expected: i64, tol_bps: i64) {
        // tol_bps = tolerance in basis points (10000 bps = 100%). Stage B
        // contract: 10 bps (0.1%) for the v1 reference.
        let diff = (actual - expected).abs();
        let allowed = (expected.abs() as i128 * tol_bps as i128 / 10_000) as i64;
        assert!(
            diff <= allowed,
            "diff {} exceeds tolerance {} bps ({} absolute) -- actual={} expected={}",
            diff, tol_bps, allowed, actual, expected
        );
    }

    #[test]
    fn realized_vol_known_sigma_matches_python_reference() {
        // The critical correctness test. Python computes the true answer
        // via stdlib float math on the same round-tripped integer inputs;
        // on-chain integer math must agree within 0.1%.
        let oracle = build_oracle_from_vector(
            V1_SAMPLE_COUNT, V1_SUM_LOG_RETURNS, V1_SUM_LOG_RETURNS_SQ,
        );
        let sigma = realized_vol_annualized(&oracle, 1_000_000_000).unwrap();
        assert_within_relative_tolerance(sigma, V1_EXPECTED_SIGMA_SCALED, 10);
    }

    #[test]
    fn realized_vol_high_vol_realistic_crypto() {
        // 720 samples sized to ~80% annual vol; with this seed it lands at
        // ~79.2%. Asserts both Python-reference accuracy AND a sanity-band
        // [0.7 * SCALE, 0.9 * SCALE].
        let oracle = build_oracle_from_vector(
            V2_SAMPLE_COUNT, V2_SUM_LOG_RETURNS, V2_SUM_LOG_RETURNS_SQ,
        );
        let sigma = realized_vol_annualized(&oracle, 1_000_000_000).unwrap();
        assert_within_relative_tolerance(sigma, V2_EXPECTED_SIGMA_SCALED, 10);
        let lower = 7 * (SCALE as i64) / 10;
        let upper = 9 * (SCALE as i64) / 10;
        assert!(sigma >= lower && sigma <= upper,
            "sigma {} not in realistic-crypto band [{}, {}]", sigma, lower, upper);
    }

    #[test]
    fn realized_vol_low_vol_realistic_fx() {
        // 720 samples sized to ~10% annual vol. Sanity band [0.08*SCALE, 0.12*SCALE].
        let oracle = build_oracle_from_vector(
            V3_SAMPLE_COUNT, V3_SUM_LOG_RETURNS, V3_SUM_LOG_RETURNS_SQ,
        );
        let sigma = realized_vol_annualized(&oracle, 1_000_000_000).unwrap();
        assert_within_relative_tolerance(sigma, V3_EXPECTED_SIGMA_SCALED, 10);
        let lower = 8 * (SCALE as i64) / 100;
        let upper = 12 * (SCALE as i64) / 100;
        assert!(sigma >= lower && sigma <= upper,
            "sigma {} not in realistic-FX band [{}, {}]", sigma, lower, upper);
    }

    #[test]
    fn sqrt_hours_per_year_constant_matches_python() {
        // Sanity-pin the SQRT_HOURS_PER_YEAR_SCALED constant. Independently
        // computed by the Python reference generator. If anyone bumps the
        // hours-per-year convention (8760 -> 8765.82, etc.) this fires.
        const EXPECTED: i64 = 93_594_871_654_381;
        assert_eq!(SQRT_HOURS_PER_YEAR_SCALED, EXPECTED);
    }

    #[test]
    fn accumulator_handles_alternating_sign_returns() {
        // Edge case: alternating +X / -X should drive sum_log_returns
        // close to 0 (exactly 0 for an even count) while keeping
        // sum_log_returns_sq strictly positive. Confirms i128 sign math
        // doesn't accidentally rely on positivity.
        let mut oracle = VolOracle::zeroed();
        for i in 0..100i64 {
            let lr = if i % 2 == 0 { 3_000_000_000 } else { -3_000_000_000 };
            apply(&mut oracle, lr);
        }
        assert_eq!(oracle.sum_log_returns, 0);
        assert_eq!(oracle.sum_log_returns_sq, 100i128 * 3_000_000_000i128 * 3_000_000_000i128);
    }
}
