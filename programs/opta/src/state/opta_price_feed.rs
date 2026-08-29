// =============================================================================
// state/opta_price_feed.rs -- first-party price feed account (FP-ORACLE module)
// =============================================================================
//
// The third oracle source. Pyth (0) and Switchboard (1) are third parties whose
// signatures we verify; this is a feed WE write. That inversion is the whole
// risk of the module, and every guard in this file exists because of it:
//
//   - `authority` lives HERE, not on ProtocolState. ProtocolState has no spare
//     field and widening it needs an explicit admin migration over every account
//     (Anchor deserializes before realloc, so it cannot be done lazily). Keeping
//     it on the feed also gives per-feed revocation for free.
//   - `frozen` is a real stored bool, not "infer it from a stale publish_time".
//     Freezing must be reachable in ONE admin transaction with no key movement
//     and no redeploy -- it is revocation tier 1 (spec section 5).
//   - `prev_price_6dec` / `prev_publish_time` exist only to feed the deviation
//     circuit-breaker. They are the difference between a compromised key writing
//     "$1 BTC" once and having to walk there 5% at a time, loudly, while the
//     soak monitor watches.
//
// MODULE BOUNDARY (spec section 7). ORACLE_SOURCE_OPTA is declared in THIS file
// rather than beside ORACLE_SOURCE_PYTH/SWITCHBOARD in state/market.rs, so the
// entire module is additive files until the plug ceremony arms the six match
// sites. Do not "tidy" it into market.rs before then -- that tidy is exactly the
// canonical-path edit the isolation gate exists to catch.
//
// Not zero_copy: ~122 bytes. The zero_copy threshold in this codebase is >3KB
// (see state/vol_oracle.rs, which carries a 720-slot ring).
// =============================================================================

use anchor_lang::prelude::*;

use crate::errors::OptaError;

/// PDA seed prefix. Full seeds: [OPTA_PRICE_FEED_SEED, feed_id].
/// Mirrors VOL_ORACLE_SEED's shape so the existing derivation helpers and the
/// frontend's "one hex threads both paths" pattern carry over unchanged.
pub const OPTA_PRICE_FEED_SEED: &[u8] = b"opta_price_feed";

/// The third `oracle_source` discriminant. See the MODULE BOUNDARY note above
/// for why this is not in state/market.rs yet.
pub const ORACLE_SOURCE_OPTA: u8 = 2;

/// Push-side rate limit. A second push inside this window reverts
/// `OptaFeedPushTooSoon`. Deliberately much tighter than the vol oracle's 55
/// minutes: this feed backs spot reads, not an hourly sample ring.
pub const OPTA_FEED_MIN_PUSH_INTERVAL_SECS: i64 = 5;

/// Maximum tolerated skew between a pushed `publish_time` and the on-chain
/// clock, in EITHER direction. Blocks future-dating (which would keep a feed
/// looking fresh after the pusher stops) and blocks backfill (which would let a
/// stale price be replayed as current).
pub const OPTA_FEED_PUSH_MAX_SKEW_SECS: i64 = 30;

/// Deviation circuit-breaker, in basis points, against `prev_price_6dec`.
/// R4: SHIPS AT 500. The final value is set from soak data, not from this
/// constant -- see OPTA_FEED_OBSERVE_DEVIATION_BPS.
pub const OPTA_FEED_MAX_DEVIATION_BPS: u64 = 500;

/// R4 shadow-logging threshold. A push whose deviation lands in
/// [OBSERVE, MAX) is accepted but emits a `would_have_tripped` log carrying the
/// deviation, so the soak can answer "would a tighter breaker have wedged us on
/// a real market move?" before anyone tightens it. A breaker tuned from an
/// armchair guess either never fires or wedges the lane in its first volatile
/// hour; this is how we avoid picking one blind.
pub const OPTA_FEED_OBSERVE_DEVIATION_BPS: u64 = 150;

/// Age beyond which the breaker stops comparing against `prev_price_6dec`.
/// After a long gap the previous price is not a meaningful baseline -- a real
/// market can move any distance in an hour -- so the deviation check is skipped
/// and the push is treated as a re-seed. Mirrors the reasoning behind
/// VOL_ORACLE_MAX_SAMPLE_GAP_SECS in state/vol_oracle.rs.
pub const OPTA_FEED_DEVIATION_BASELINE_MAX_AGE_SECS: i64 = 900;

/// Confidence ceiling as a fraction of price, in basis points. Mirrors the
/// Pyth arm's MAX_CONF_BPS philosophy: a wide band means the sources disagreed,
/// and a price nobody agrees on must not settle an option.
pub const OPTA_FEED_MAX_CONF_BPS: u64 = 200;

#[account]
#[derive(InitSpace)]
pub struct OptaPriceFeed {
    /// 32-byte feed identity. Same double-duty field as the Pyth feed id and the
    /// Switchboard feedHash, so one hex string threads market, vol oracle and
    /// price feed alike.
    pub feed_id: [u8; 32],

    /// Current price, USDC 6-dec -- the unit every read site already speaks, so
    /// the Opta arm returns the same type as the Pyth and SB arms with no
    /// scaling seam of its own.
    pub price_6dec: u64,

    /// Confidence half-band, USDC 6-dec. Gated by OPTA_FEED_MAX_CONF_BPS.
    pub conf_6dec: u64,

    /// Unix seconds. THE freshness source of truth -- every read site gates on
    /// `now - publish_time`, never on `slot`.
    pub publish_time: i64,

    /// Slot at push. Recorded for forensics and cross-checking against
    /// publish_time; deliberately NOT used for freshness (the SB arm's
    /// slot-based max_age is a different mechanism and is not mirrored here).
    pub slot: u64,

    /// The dedicated oracle key. NEVER the protocol admin: admin can upgrade the
    /// program and move funds, this key must be able to do exactly one thing.
    /// Rotatable by admin via set_feed_authority (revocation tier 2).
    pub authority: Pubkey,

    /// Previous accepted price, for the deviation breaker.
    pub prev_price_6dec: u64,

    /// publish_time of `prev_price_6dec`, so the breaker can tell a 5% jump in
    /// ten seconds from a 5% drift over an hour.
    pub prev_publish_time: i64,

    /// Admin kill-switch (revocation tier 1). When true EVERY read reverts
    /// OptaFeedFrozen, at all six arm sites, regardless of freshness.
    pub frozen: bool,

    pub bump: u8,
}

impl OptaPriceFeed {
    /// Absolute deviation of `new_price` from `self.prev_price_6dec`, in bps.
    /// Returns None when there is no usable baseline: no previous price, or a
    /// baseline old enough that comparing against it is meaningless.
    pub fn deviation_bps(&self, new_price: u64, now_ts: i64) -> Option<u64> {
        if self.prev_price_6dec == 0 {
            return None;
        }
        if now_ts.saturating_sub(self.prev_publish_time)
            > OPTA_FEED_DEVIATION_BASELINE_MAX_AGE_SECS
        {
            return None;
        }
        let prev = self.prev_price_6dec as u128;
        let new = new_price as u128;
        let diff = if new > prev { new - prev } else { prev - new };
        // prev > 0 is guaranteed above, so the division is safe.
        u64::try_from(diff.saturating_mul(10_000) / prev).ok()
    }

    /// The shared read-side gate. EVERY read helper in utils/price_oracle.rs
    /// calls this first, so a new read site cannot accidentally skip the freeze
    /// or the staleness check -- the completeness of `frozen` across all six
    /// arms is an explicit audit item (spec section 11).
    ///
    /// Fails closed in all four directions: frozen, stale, zero price, wide
    /// confidence.
    pub fn assert_readable(&self, now_ts: i64, max_age_secs: i64) -> Result<()> {
        require!(!self.frozen, OptaError::OptaFeedFrozen);
        require!(self.price_6dec > 0, OptaError::OptaFeedInvalidPrice);
        require!(
            now_ts.saturating_sub(self.publish_time) <= max_age_secs,
            OptaError::OptaFeedStale
        );
        // A future-dated feed is also unreadable -- push-side skew should make
        // this unreachable, but a read gate that trusts the writer is not a gate.
        require!(
            self.publish_time.saturating_sub(now_ts) <= OPTA_FEED_PUSH_MAX_SKEW_SECS,
            OptaError::OptaFeedStale
        );
        let conf_bps = (self.conf_6dec as u128)
            .saturating_mul(10_000)
            .checked_div(self.price_6dec as u128)
            .unwrap_or(u128::MAX);
        require!(
            conf_bps <= OPTA_FEED_MAX_CONF_BPS as u128,
            OptaError::OptaFeedConfTooWide
        );
        Ok(())
    }
}
