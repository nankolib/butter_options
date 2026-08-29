// =============================================================================
// instructions/push_opta_price.rs -- write a price to an OptaPriceFeed
// =============================================================================
//
// Signed by feed.authority. NOT by admin, and admin has no override here: the
// separation is the whole security model. Admin's power over this feed is to
// FREEZE it or ROTATE its authority, never to write a price through it.
//
// GUARD ORDER IS LOAD-BEARING. Cheapest and most-fatal first, so a compromised
// or buggy pusher burns as little as possible and the revert reason is the most
// specific one available:
//
//   1. frozen        -- a frozen feed accepts nothing, not even from the real
//                       authority. Freeze must be absolute or it is not a
//                       kill-switch.
//   2. authority     -- enforced by the Accounts constraint, before the body.
//   3. price > 0
//   4. clock skew    -- both directions.
//   5. rate limit
//   6. deviation     -- the circuit-breaker, LAST because it is the only guard
//                       that needs the previous accepted state to mean anything.
//
// R4: the breaker ships at 500 bps but also SHADOW-LOGS. A push landing in
// [OBSERVE, MAX) is accepted and emits `would_have_tripped`, so the soak can
// answer "would a tighter breaker have wedged us on a real move?" from data
// rather than from a guess. The final threshold is set at end of soak.
//
// -----------------------------------------------------------------------------
// ORDERING CONTRACT -- READ THIS BEFORE MOVING ANY LINE IN THIS HANDLER
// -----------------------------------------------------------------------------
// This account holds the same quantity twice: `price_6dec`/`publish_time` (the
// last accepted push) and `prev_price_6dec`/`prev_publish_time` (the one before
// that). A single roll-forward near the end of the handler shifts current into
// prev. Every guard therefore has a correct side of that roll, and picking the
// wrong side is not a compile error -- it silently reads a value one push stale.
//
// That is not hypothetical. The deviation breaker shipped reading `prev_*` and
// was DEAD: it runs pre-roll, where prev_ still holds the push from two back,
// which is 0 on the second-ever push -- so the breaker returned None and waved
// through the exact move it exists to stop. Caught by
// tests/bankrun/fp-oracle-push-guards.test.ts, not by review.
//
// THE CONTRACT, in one line:
//   Every guard runs PRE-ROLL and reads CURRENT state (`price_6dec`,
//   `publish_time`, `frozen`) or an instruction argument. NOTHING in this
//   handler reads `prev_*`. `prev_*` is write-only here -- it exists for
//   forensics and for off-chain readers, never for a decision.
//
// Full audit of every read, in execution order:
//
//   # | guard             | reads                          | roll side | why that side
//  ---|-------------------|--------------------------------|-----------|---------------------------
//   1 | frozen            | feed.frozen                    | pre       | unaffected by the roll
//   2 | authority         | feed.authority (Accounts)      | pre-body  | never rolled
//   3 | price > 0         | ARGUMENT price_6dec            | n/a       | no state read
//   4 | clock skew        | ARGUMENT publish_time, clock   | n/a       | no state read
//   5 | rate limit        | feed.publish_time              | pre       | must be the LAST ACCEPTED
//     |                   |                                |           | push; prev_ would permit a
//     |                   |                                |           | burst every other tx
//   6 | deviation breaker | feed.price_6dec,               | pre       | baseline IS the last
//     |                   | feed.publish_time              |           | accepted price; prev_ is
//     |                   | (via deviation_bps)            |           | one push stale and 0 on
//     |                   |                                |           | the second push
//   6b| shadow log        | feed.price_6dec,               | pre       | must report the SAME
//     |                   | feed.publish_time              |           | baseline the breaker used,
//     |                   |                                |           | or the soak data is a lie
//
// If you add a guard, add a row. If a guard ever legitimately needs `prev_*`,
// that is a design change -- say so out loud rather than reaching past the roll.
// =============================================================================

use anchor_lang::prelude::*;

use crate::errors::OptaError;
use crate::state::{
    OptaPriceFeed, OPTA_FEED_MAX_DEVIATION_BPS, OPTA_FEED_MIN_PUSH_INTERVAL_SECS,
    OPTA_FEED_OBSERVE_DEVIATION_BPS, OPTA_FEED_PUSH_MAX_SKEW_SECS, OPTA_PRICE_FEED_SEED,
};

pub fn handle_push_opta_price(
    ctx: Context<PushOptaPrice>,
    _feed_id: [u8; 32],
    price_6dec: u64,
    conf_6dec: u64,
    publish_time: i64,
) -> Result<()> {
    let clock = Clock::get()?;
    let now = clock.unix_timestamp;
    // Captured before the mutable borrow below — `key()` needs an immutable
    // borrow of the same account and the logs want it.
    let feed_key = ctx.accounts.opta_price_feed.key();
    let feed = &mut ctx.accounts.opta_price_feed;

    // 1. A frozen feed accepts nothing. Checked before anything else so that
    //    freezing is unambiguously total — including against the real authority,
    //    which is precisely the case where it matters (key compromise).
    require!(!feed.frozen, OptaError::OptaFeedFrozen);

    // 2. authority — enforced by the `address = ` constraint below.

    // 3. Zero prices never enter the account. assert_readable would reject them
    //    on the way out anyway, but storing one would blank a live feed.
    require!(price_6dec > 0, OptaError::OptaFeedInvalidPrice);

    // 4. Clock skew, BOTH directions. Future-dating would keep the feed looking
    //    fresh after the pusher stopped; backfill would replay a stale price as
    //    current. Neither is a thing an honest crank ever needs to do.
    let skew = (publish_time - now).abs();
    require!(
        skew <= OPTA_FEED_PUSH_MAX_SKEW_SECS,
        OptaError::OptaFeedSkewTooLarge
    );

    // 5. Rate limit. READS feed.publish_time — CURRENT, pre-roll (contract row 5).
    //    Measured against the last ACCEPTED push, not against the clock, so a
    //    burst cannot be laundered through a slow validator. Reading prev_ here
    //    would let a pusher land two txs back-to-back every other block.
    if feed.publish_time != 0 {
        require!(
            publish_time.saturating_sub(feed.publish_time) >= OPTA_FEED_MIN_PUSH_INTERVAL_SECS,
            OptaError::OptaFeedPushTooSoon
        );
    }

    // 6. Deviation circuit-breaker. READS feed.price_6dec + feed.publish_time —
    //    CURRENT, pre-roll (contract row 6). `deviation_bps` returns None when
    //    there is no usable baseline: the GENESIS push (price_6dec == 0) or a
    //    baseline older than OPTA_FEED_DEVIATION_BASELINE_MAX_AGE_SECS.
    //
    //    BOTH of those are UNGUARDED MOMENTS and the runbook must treat them as
    //    such: at genesis and after any long gap the very next push sets the
    //    baseline for everything after it, at whatever value it carries. The
    //    breaker cannot protect the number it is measuring from. Ceremony
    //    verification of that first price against the live market is the only
    //    control — see FP_ORACLE_MODULE_SPEC_V2, genesis-push handling.
    if let Some(dev_bps) = feed.deviation_bps(price_6dec, now) {
        require!(
            dev_bps <= OPTA_FEED_MAX_DEVIATION_BPS,
            OptaError::OptaFeedDeviationTooLarge
        );
        // R4 shadow log — accepted, but recorded for threshold-setting at end of
        // soak. Emitted as a msg! rather than an event because nothing on-chain
        // consumes it; the soak harness reads it from the transaction logs
        // alongside the reference market move for the same interval.
        if dev_bps >= OPTA_FEED_OBSERVE_DEVIATION_BPS {
            msg!(
                "would_have_tripped: feed={} dev_bps={} prev={} new={} dt={} live_limit={} observe={}",
                feed_key,
                dev_bps,
                feed.price_6dec,
                price_6dec,
                publish_time.saturating_sub(feed.publish_time),
                OPTA_FEED_MAX_DEVIATION_BPS,
                OPTA_FEED_OBSERVE_DEVIATION_BPS,
            );
        }
    }

    // ---- THE ROLL. Everything above is pre-roll; everything below is post-roll.
    // No guard may be moved below this line without re-deriving which side of the
    // roll its reads land on (see the ORDERING CONTRACT in the header).
    // prev_* is WRITE-ONLY in this handler — forensics, never a decision.
    feed.prev_price_6dec = feed.price_6dec;
    feed.prev_publish_time = feed.publish_time;

    feed.price_6dec = price_6dec;
    feed.conf_6dec = conf_6dec;
    feed.publish_time = publish_time;
    feed.slot = clock.slot;

    msg!(
        "OptaPriceFeed push: pda={} price={} conf={} publish_time={} slot={}",
        feed_key,
        price_6dec,
        conf_6dec,
        publish_time,
        clock.slot,
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(feed_id: [u8; 32])]
pub struct PushOptaPrice<'info> {
    /// The dedicated oracle authority for THIS feed. Deliberately not tied to
    /// protocol_state — per-feed authority means per-feed revocation, and this
    /// instruction never needs to load ProtocolState at all.
    #[account(address = opta_price_feed.authority @ OptaError::OptaFeedUnauthorized)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        seeds = [OPTA_PRICE_FEED_SEED, feed_id.as_ref()],
        bump = opta_price_feed.bump,
    )]
    pub opta_price_feed: Account<'info, OptaPriceFeed>,
}
