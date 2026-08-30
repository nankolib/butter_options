// =============================================================================
// instructions/close_opta_price_feed.rs -- delete a feed, reclaim its rent
// =============================================================================
//
// WHY THIS EXISTS. Two things needed it and neither was optional:
//
//   1. THE WEDGE PATH. A wrong genesis price cannot be pushed over -- the
//      breaker arms against it immediately, so the correcting push is refused as
//      a deviation. The gap-scaled band widens with staleness but CAPS at
//      OPTA_FEED_DEVIATION_CAP_BPS (5000 = 50%), so a genesis error larger than
//      50% can never be corrected by any push, at any gap, ever. Without a close
//      the feed is permanently wedged at a wrong price and the only remedy is to
//      abandon the PDA and mint a new feed id. That is not a recovery plan.
//
//   2. UNPLUG (spec 9.2 step 4) says "close the feed PDAs and reclaim rent".
//      That sentence was false until this instruction existed.
//
// FROZEN IS A PRECONDITION, NOT A COURTESY. Closing a LIVE feed would be a
// silent, instant capability removal: the account vanishes, and every read arm
// starts failing on a missing account rather than on the explicit
// OptaFeedFrozen that operators are trained to recognise. Requiring
// `frozen == true` forces the two-step -- freeze (reversible, one tx, loud at
// every arm) and only then close (irreversible) -- so nobody deletes a feed the
// board is still pricing off. It also means the destructive step is never the
// first thing an operator reaches for under pressure.
//
// Anchor's `close = admin` zeroes the discriminator and returns the lamports, so
// the PDA can be re-initialised at the same address afterwards. That is exactly
// what re-genesis needs.
// =============================================================================

use anchor_lang::prelude::*;

use crate::errors::OptaError;
use crate::state::{OptaPriceFeed, ProtocolState, OPTA_PRICE_FEED_SEED, PROTOCOL_SEED};

pub fn handle_close_opta_price_feed(
    ctx: Context<CloseOptaPriceFeed>,
    _feed_id: [u8; 32],
) -> Result<()> {
    let feed = &ctx.accounts.opta_price_feed;

    // The one guard. See the header: this is what makes closing a deliberate
    // second step rather than a single-transaction capability deletion.
    require!(feed.frozen, OptaError::OptaFeedNotFrozen);

    // Log the state being destroyed. After this instruction the account is gone,
    // so if the value is not in the transaction log it is not anywhere -- and a
    // close is exactly the moment someone will later want to know what the feed
    // held.
    msg!(
        "OptaPriceFeed CLOSED: pda={} last_price={} last_publish_time={} authority={} (rent -> admin)",
        feed.key(),
        feed.price_6dec,
        feed.publish_time,
        feed.authority,
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(feed_id: [u8; 32])]
pub struct CloseOptaPriceFeed<'info> {
    /// Admin — must match protocol_state.admin. Receives the reclaimed rent.
    /// NOT the feed authority: the oracle key may write prices, never delete
    /// the account it writes to.
    #[account(mut, address = protocol_state.admin @ OptaError::Unauthorized)]
    pub admin: Signer<'info>,

    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    #[account(
        mut,
        seeds = [OPTA_PRICE_FEED_SEED, feed_id.as_ref()],
        bump = opta_price_feed.bump,
        close = admin,
    )]
    pub opta_price_feed: Account<'info, OptaPriceFeed>,
}
