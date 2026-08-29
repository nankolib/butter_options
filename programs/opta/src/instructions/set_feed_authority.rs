// =============================================================================
// instructions/set_feed_authority.rs -- rotate an OptaPriceFeed authority
// =============================================================================
//
// Revocation tier 2 (spec section 5). Admin-only. The compromised key is inert
// the moment the new pubkey lands — no redeploy, no account migration, no
// downtime for the feed's readers.
//
// Tier 1 (freeze) is faster and is the break-glass; this is the repair. Normal
// order in an incident is freeze -> rotate -> unfreeze, so that there is never a
// window where a compromised key can push into an unfrozen feed.
//
// Also refuses admin-as-authority, for the same reason init does: the separation
// between "can upgrade the program and move funds" and "can write one price" is
// the property that makes an oracle-key compromise survivable, and it must not
// be possible to give it away silently through the rotation path either.
// =============================================================================

use anchor_lang::prelude::*;

use crate::errors::OptaError;
use crate::state::{OptaPriceFeed, ProtocolState, OPTA_PRICE_FEED_SEED, PROTOCOL_SEED};

pub fn handle_set_feed_authority(
    ctx: Context<SetFeedAuthority>,
    _feed_id: [u8; 32],
    new_authority: Pubkey,
) -> Result<()> {
    require_keys_neq!(
        new_authority,
        ctx.accounts.admin.key(),
        OptaError::OptaFeedUnauthorized
    );
    require_keys_neq!(
        new_authority,
        Pubkey::default(),
        OptaError::OptaFeedUnauthorized
    );

    let feed = &mut ctx.accounts.opta_price_feed;
    let previous = feed.authority;
    feed.authority = new_authority;

    msg!(
        "OptaPriceFeed authority rotated: pda={} from={} to={} (old key is inert as of this tx)",
        ctx.accounts.opta_price_feed.key(),
        previous,
        new_authority,
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(feed_id: [u8; 32])]
pub struct SetFeedAuthority<'info> {
    #[account(address = protocol_state.admin @ OptaError::Unauthorized)]
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
    )]
    pub opta_price_feed: Account<'info, OptaPriceFeed>,
}

// =============================================================================
// set_feed_frozen -- revocation tier 1 (the break-glass)
// =============================================================================
//
// Deliberately colocated with rotation: they are the two halves of the same
// incident runbook, and keeping them in one file means nobody ships the rotate
// path without the freeze path.
//
// One admin transaction, no key movement, no redeploy. Blocks EVERY read at all
// six arm sites via OptaPriceFeed::assert_readable, regardless of freshness.
// =============================================================================

pub fn handle_set_feed_frozen(
    ctx: Context<SetFeedFrozen>,
    _feed_id: [u8; 32],
    frozen: bool,
) -> Result<()> {
    let feed = &mut ctx.accounts.opta_price_feed;
    feed.frozen = frozen;

    msg!(
        "OptaPriceFeed freeze set: pda={} frozen={} (reads {})",
        ctx.accounts.opta_price_feed.key(),
        frozen,
        if frozen { "BLOCKED at all arms" } else { "permitted" },
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(feed_id: [u8; 32])]
pub struct SetFeedFrozen<'info> {
    #[account(address = protocol_state.admin @ OptaError::Unauthorized)]
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
    )]
    pub opta_price_feed: Account<'info, OptaPriceFeed>,
}
