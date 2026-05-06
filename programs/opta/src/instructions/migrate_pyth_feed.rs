// =============================================================================
// instructions/migrate_pyth_feed.rs — Admin-only Pyth feed_id rotation
// =============================================================================
//
// Stage P3 shape: a one-shot admin instruction that overwrites an existing
// OptionsMarket's `pyth_feed_id`. Intended for the rare case where Pyth
// rotates a feed_id (e.g. asset re-listing on a new feed). 99% of the time
// this instruction is never called; markets are immutable in practice.
//
// Re-call semantics:
//   - Same feed_id as currently stored → silent Ok (idempotent).
//   - Different feed_id → overwrite and continue.
//
// Authorization: signer must match `protocol_state.admin`. Reuses the
// existing `Unauthorized` error.
//
// HIGH-5 proof gate (audit Run-7 PART 1): the new_pyth_feed_id must be
// proof-bound to a real Pyth feed via a fresh PriceUpdateV2 account. Mirrors
// the canonical pattern in settle_expiry.rs:88-97. The admin gate is kept
// because feed rotation is an authority-only operation by design — the proof
// gate prevents an admin fat-finger from rotating to a non-existent feed.
// =============================================================================

use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::error::GetPriceError;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;
use pyth_solana_receiver_sdk::price_update::VerificationLevel;

use crate::errors::OptaError;
use crate::state::{OptionsMarket, ProtocolState, MARKET_SEED, PROTOCOL_SEED};

pub fn handle_migrate_pyth_feed(
    ctx: Context<MigratePythFeed>,
    asset_name: String,
    new_pyth_feed_id: [u8; 32],
) -> Result<()> {
    // Admin-only gate
    require_keys_eq!(
        ctx.accounts.admin.key(),
        ctx.accounts.protocol_state.admin,
        OptaError::Unauthorized
    );

    // HIGH-5 proof gate (audit Run-7). Verify the new feed_id is proof-bound
    // to a real Pyth feed. Mirrors create_market.rs and settle_expiry.rs.
    let pu = &ctx.accounts.price_update;
    require!(
        pu.verification_level.gte(VerificationLevel::Full),
        GetPriceError::InsufficientVerificationLevel
    );
    require!(
        pu.price_message.feed_id == new_pyth_feed_id,
        GetPriceError::MismatchedFeedId
    );

    // HIGH-3 same-arc zero-feed guard (audit Run-6). Defense-in-depth — the
    // proof check above already implicitly rejects [0u8; 32] (no real Pyth
    // feed has a zero feed_id), but kept as a belt-and-suspenders reject.
    require!(
        new_pyth_feed_id != [0u8; 32],
        OptaError::InvalidPythFeedId
    );

    let market = &mut ctx.accounts.market;

    // Idempotent re-call with same feed_id — silent Ok.
    if market.pyth_feed_id == new_pyth_feed_id {
        msg!(
            "migrate_pyth_feed: feed_id unchanged for {} — idempotent Ok",
            asset_name
        );
        return Ok(());
    }

    let old_feed_id = market.pyth_feed_id;
    market.pyth_feed_id = new_pyth_feed_id;

    msg!(
        "Pyth feed_id rotated for {}: {:?} -> {:?}",
        asset_name,
        old_feed_id,
        new_pyth_feed_id,
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(asset_name: String, new_pyth_feed_id: [u8; 32])]
pub struct MigratePythFeed<'info> {
    /// Must match `protocol_state.admin`. Verified in the handler.
    pub admin: Signer<'info>,

    /// Global ProtocolState — read-only here, used to verify the admin key.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Fresh PriceUpdateV2 from the Pyth Receiver program. The handler
    /// verifies `verification_level == Full` and
    /// `price_message.feed_id == new_pyth_feed_id` to prove the rotation
    /// target corresponds to a real Pyth feed. Read-only — never mutated.
    pub price_update: Account<'info, PriceUpdateV2>,

    /// The market whose Pyth feed_id is being rotated. PDA seeds enforce
    /// existence — passing an unknown asset_name fails seed validation
    /// (AccountNotInitialized).
    #[account(
        mut,
        seeds = [MARKET_SEED, asset_name.as_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, OptionsMarket>,
}
