// =============================================================================
// utils/opta_price_read.rs -- read seam for the first-party oracle (source 2)
// =============================================================================
//
// The Opta counterparts of the pyth_* and sb_* families in utils/price_oracle.rs.
// They deliberately live in their OWN file rather than beside their siblings:
// price_oracle.rs is a canonical read path, and the FP-ORACLE module stays
// additive-only until the plug ceremony (spec section 7). At plug time these can
// move next to the others in one mechanical commit if that reads better; until
// then the isolation gate must be able to say "no canonical read path touched".
//
// SHAPE: mirrors the PYTH arm, not the Switchboard one. No queue account, no
// SlotHashes, no Instructions sysvar, no ed25519 index derivation -- just an
// account read plus gates. That makes arm 2 by far the cheapest of the three in
// CU and account count, which matters at sites already close to the 1232-byte
// transaction limit.
//
// EVERY function here goes through OptaPriceFeed::assert_readable first. That is
// the one chokepoint where `frozen`, staleness, zero-price and confidence are
// enforced, and routing all four read sites through it is what makes
// "freeze is honoured at every arm" provable rather than promised -- an explicit
// audit item (spec section 11).
// =============================================================================

use anchor_lang::prelude::*;

use crate::errors::OptaError;
use crate::state::OptaPriceFeed;

/// Settlement read result. Structurally the Pyth arm's `SettlementRead`, kept as
/// its own type so the module owns no canonical file. The field carries a unix
/// timestamp here, exactly like the Pyth arm -- unlike the SB arm, which
/// repurposes the record's slot for a `recent_slot`.
pub struct OptaSettlementRead {
    pub price_usdc: u64,
    pub publish_time: i64,
}

/// Assert the feed's identity matches the caller-supplied feed id.
///
/// Every read site takes `feed_id` from the MARKET, never from instruction data,
/// so this cannot be spoofed by a caller. It exists to catch a mis-derived PDA
/// or a wrong account being passed -- the same role `MismatchedFeedId` plays on
/// the Pyth path.
#[inline]
fn assert_feed_identity(feed: &OptaPriceFeed, expected_feed_id: [u8; 32]) -> Result<()> {
    require!(
        feed.feed_id == expected_feed_id,
        OptaError::OptaFeedInvalidPrice
    );
    Ok(())
}

/// #1 exercise_american / execute_trigger -- current spot in USDC 6-dec.
///
/// Gates, in order:
///   - feed identity matches the market's feed_id
///   - assert_readable: frozen / zero price / stale / future-dated / conf
#[inline]
pub fn opta_current_spot_usdc(
    feed: &OptaPriceFeed,
    expected_feed_id: [u8; 32],
    now: i64,
    max_age_secs: i64,
) -> Result<u64> {
    assert_feed_identity(feed, expected_feed_id)?;
    feed.assert_readable(now, max_age_secs)?;
    Ok(feed.price_6dec)
}

/// #2 push_vol_sample / initialize_vol_oracle -- current spot at solmath SCALE
/// (1e12), matching what the vol oracle stores in `last_spot_price`.
///
/// The scale-up is checked, not wrapped: a price large enough to overflow the
/// multiply is a broken feed, not a big number.
#[inline]
pub fn opta_current_spot_scale(
    feed: &OptaPriceFeed,
    expected_feed_id: [u8; 32],
    now: i64,
    max_age_secs: i64,
) -> Result<u128> {
    let usdc_6dec = opta_current_spot_usdc(feed, expected_feed_id, now, max_age_secs)?;
    // 6-dec -> 1e12 SCALE is a factor of 1e6.
    (usdc_6dec as u128)
        .checked_mul(1_000_000)
        .ok_or_else(|| error!(OptaError::MathOverflow))
}

/// #3 settle_expiry -- the settlement price for an expiry.
///
/// SEMANTICS DIFFER FROM PYTH, DELIBERATELY, AND THIS IS THE IMPORTANT COMMENT
/// IN THIS FILE.
///
/// The Pyth arm settles from a HISTORICAL print: it demands a `publish_time`
/// inside `[expiry, expiry + window]`, so the recorded price is the price AT
/// EXPIRY even if settlement is submitted much later. We cannot do that here --
/// an OptaPriceFeed holds only its current value; there is no history to fetch
/// and no signed archive to verify against.
///
/// So this arm is PERSIST-AT-EXPIRY, structurally the same choice the Switchboard
/// arm makes: settlement must happen inside a short window after expiry, while a
/// fresh reading is still meaningful, and the price used is the CURRENT one.
/// The caller enforces the window (settle_expiry already rejects pre-expiry, and
/// will gate the post-expiry window the same way it does for SB); this function
/// enforces that the reading is fresh enough to stand in for the expiry price.
///
/// Consequence to carry into the audit: a market on source 2 that is not settled
/// inside its window does NOT get a late settlement at the right price -- it
/// falls to the reclaim path, exactly like a Switchboard market. That is a
/// property of having no history, not an oversight.
#[inline]
pub fn opta_settlement_price_usdc(
    feed: &OptaPriceFeed,
    expected_feed_id: [u8; 32],
    expiry: i64,
    now: i64,
    max_age_secs: i64,
) -> Result<OptaSettlementRead> {
    assert_feed_identity(feed, expected_feed_id)?;
    feed.assert_readable(now, max_age_secs)?;

    // The reading must not PRE-date the expiry it is settling. A price published
    // before expiry is not a settlement price, however fresh it looks -- without
    // this, a feed that stopped updating just before expiry could settle the
    // contract at a stale pre-expiry value that still passed the age gate.
    require!(feed.publish_time >= expiry, OptaError::OptaFeedStale);

    Ok(OptaSettlementRead {
        price_usdc: feed.price_6dec,
        publish_time: feed.publish_time,
    })
}

/// #4 create_market -- HIGH-5 existence proof.
///
/// The Pyth arm proves existence from a verified price update; the SB arm runs a
/// QuoteVerifier pass. Here existence means: the PDA resolves, carries the
/// expected feed id, and has been pushed at least once by its authority.
///
/// `price_6dec > 0` is the load-bearing half. A feed can be created by admin at
/// any time, so PDA existence alone proves nothing about whether anyone is
/// actually feeding it -- registering an asset against a feed nobody pushes is
/// precisely the failure HIGH-5 exists to prevent. Freshness is deliberately NOT
/// required here: create is not a price read, and demanding a live push at
/// create time would make market creation fail during any transient crank gap.
#[inline]
pub fn opta_prove_feed_exists(feed: &OptaPriceFeed, expected_feed_id: [u8; 32]) -> Result<()> {
    assert_feed_identity(feed, expected_feed_id)?;
    require!(!feed.frozen, OptaError::OptaFeedFrozen);
    require!(feed.price_6dec > 0, OptaError::OptaFeedInvalidPrice);
    require!(feed.publish_time > 0, OptaError::OptaFeedInvalidPrice);
    Ok(())
}
