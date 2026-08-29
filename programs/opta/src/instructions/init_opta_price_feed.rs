// =============================================================================
// instructions/init_opta_price_feed.rs -- create an OptaPriceFeed (admin-only)
// =============================================================================
//
// Creates the PDA and installs its initial oracle `authority`. Admin-signed,
// same gate as the migrate_* / reset_* instructions.
//
// STORES NO PRICE. Birth leaves price_6dec == 0, which `assert_readable` rejects
// with OptaFeedInvalidPrice — so a freshly created feed is unreadable until the
// authority pushes to it. That ordering is deliberate: creating a feed must
// never be able to make a market quotable by accident.
//
// The admin picks the authority but is NOT the authority. Passing the admin's
// own key here is rejected: the entire point of the separation is that the
// oracle key's compromise is survivable, and an admin-as-authority feed silently
// gives that up (spec section 5).
// =============================================================================

use anchor_lang::prelude::*;

use crate::errors::OptaError;
use crate::state::{OptaPriceFeed, ProtocolState, OPTA_PRICE_FEED_SEED, PROTOCOL_SEED};

pub fn handle_init_opta_price_feed(
    ctx: Context<InitOptaPriceFeed>,
    feed_id: [u8; 32],
    authority: Pubkey,
) -> Result<()> {
    // A feed id of all zeros is never a real feed — same guard shape as
    // InvalidPythFeedId on the Pyth path.
    require!(feed_id != [0u8; 32], OptaError::InvalidPythFeedId);

    // Refuse admin-as-authority. This is the one structural property that makes
    // an oracle-key compromise survivable; if it can be given away silently at
    // init, it is not a property. Also refuse the default pubkey, which would be
    // an unusable feed nobody could ever push to.
    require_keys_neq!(
        authority,
        ctx.accounts.admin.key(),
        OptaError::OptaFeedUnauthorized
    );
    require_keys_neq!(authority, Pubkey::default(), OptaError::OptaFeedUnauthorized);

    let feed = &mut ctx.accounts.opta_price_feed;
    feed.feed_id = feed_id;
    feed.price_6dec = 0;
    feed.conf_6dec = 0;
    feed.publish_time = 0;
    feed.slot = 0;
    feed.authority = authority;
    feed.prev_price_6dec = 0;
    feed.prev_publish_time = 0;
    feed.frozen = false;
    feed.bump = ctx.bumps.opta_price_feed;

    msg!(
        "OptaPriceFeed initialized: pda={} authority={} (no price yet — unreadable until first push)",
        ctx.accounts.opta_price_feed.key(),
        authority,
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(feed_id: [u8; 32])]
pub struct InitOptaPriceFeed<'info> {
    /// Admin — must match protocol_state.admin. Pays rent.
    #[account(mut, address = protocol_state.admin @ OptaError::Unauthorized)]
    pub admin: Signer<'info>,

    /// Used only to assert admin == protocol_state.admin.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// The feed PDA, derived from `feed_id`.
    #[account(
        init,
        payer = admin,
        space = 8 + OptaPriceFeed::INIT_SPACE,
        seeds = [OPTA_PRICE_FEED_SEED, feed_id.as_ref()],
        bump,
    )]
    pub opta_price_feed: Account<'info, OptaPriceFeed>,

    pub system_program: Program<'info, System>,
}
