// =============================================================================
// instructions/reset_vol_oracle.rs -- Admin-only VolOracle reset (MED-2 clear)
// =============================================================================
//
// Clears a polluted/broken VolOracle so the next push re-seeds fresh. Zeroes
// the 720-sample ring, both O(1) accumulators, sample_count, head, and the
// rolling last_spot_price / last_sample_ts via `load_mut()`. After reset
// `last_spot_price == 0`, so the next `push_vol_sample` takes the seed-only
// branch (records spot, computes NO return) and normal sampling resumes; the
// 168-sample (7-day) warmup re-engages from 0. That warmup restart is
// INTENTIONAL -- a polluted ring must not keep pricing American options.
//
// Use case: the AM-MED-2 gap-reseed guard prevents FUTURE gap pollution, but
// an outlier already resident in a ring from a pre-existing crank outage must
// be cleared explicitly. This is that path.
//
// Admin-only (ProtocolState.admin -- same gate as the migrate_* instructions).
// One oracle per call (mirrors initialize_vol_oracle's single-feed pattern;
// ~9 live oracles to reset, well within one tx each). `feed_id` is preserved:
// it is the PDA seed + Pyth identity, not polluted state.
//
// Storage note: VolOracle is `#[account(zero_copy)]`; the 720-slot ring is
// zeroed IN PLACE via `iter_mut()` rather than `samples = [0; 720]`, which
// would materialize a 5760-byte array literal on the ~4KB BPF stack.
// =============================================================================

use anchor_lang::prelude::*;

use crate::errors::OptaError;
use crate::state::{
    seed_vol_in_bounds, ProtocolState, VolOracle, PROTOCOL_SEED, VOL_ORACLE_SEED,
};

pub fn handle_reset_vol_oracle(
    ctx: Context<ResetVolOracle>,
    _feed_id: [u8; 32],
    seed_vol: i64,
) -> Result<()> {
    // H-1 (Run-8) — this is ALSO the admin repair path for an already-poisoned
    // seed_vol. `initialize_vol_oracle` is write-once and used to leave a bad seed
    // resident (the old reset zeroed the ring but never touched seed_vol). Reset
    // now REWRITES seed_vol to an admin-supplied, bounded value; passing 0
    // restores the "no seed" sentinel. Same bounds as init (admin is trusted, but
    // reject a fat-finger). See state/vol_oracle.rs.
    require!(seed_vol_in_bounds(seed_vol), OptaError::SeedVolOutOfBounds);

    let mut oracle = ctx.accounts.vol_oracle.load_mut()?;

    // Zero the ring in place (no 5760-byte stack literal).
    for slot in oracle.samples.iter_mut() {
        *slot = 0;
    }
    // Zero the accumulators + counters + rolling state. feed_id and bump are
    // preserved (PDA identity, not polluted data). seed_vol is REPAIRED to the
    // admin-passed bounded value (H-1) — after reset the oracle re-warms from 0,
    // and during that warmup price_american consults this corrected seed.
    oracle.sum_log_returns = 0;
    oracle.sum_log_returns_sq = 0;
    oracle.sample_count = 0;
    oracle.head = 0;
    oracle.last_spot_price = 0;
    oracle.last_sample_ts = 0;
    oracle.seed_vol = seed_vol;

    msg!(
        "VolOracle reset: pda={} seed_vol={} (ring + accumulators + counters zeroed; next push reseeds)",
        ctx.accounts.vol_oracle.key(),
        seed_vol,
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(feed_id: [u8; 32])]
pub struct ResetVolOracle<'info> {
    /// Admin -- must match protocol_state.admin (same gate as migrate_*).
    #[account(address = protocol_state.admin @ OptaError::Unauthorized)]
    pub admin: Signer<'info>,

    /// Used only to assert admin == protocol_state.admin.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// The VolOracle PDA to reset, derived from `feed_id` (same seeds as
    /// initialize_vol_oracle). Mutated.
    #[account(
        mut,
        seeds = [VOL_ORACLE_SEED, feed_id.as_ref()],
        bump = vol_oracle.load()?.bump,
    )]
    pub vol_oracle: AccountLoader<'info, VolOracle>,
}
