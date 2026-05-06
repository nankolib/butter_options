// =============================================================================
// instructions/create_market.rs — Register an asset (permissionless + proof-gated)
// =============================================================================
//
// Permissionless post-HIGH-5 fix (audit Run-7 PART 1). Anyone can register an
// asset by passing a fresh Pyth PriceUpdateV2 account whose `feed_id` matches
// the `pyth_feed_id` argument. The caller-supplied feed_id is therefore
// proof-bound to a real Pyth feed — random byte griefers are rejected at
// account-validation time, not just downstream at settle. The HIGH-2 admin
// gate that this fix replaces is strictly weaker: an admin fat-finger could
// still brick a namespace, and external integrators couldn't bootstrap their
// own asset listings.
//
// On-chain proof check (mirrors settle_expiry.rs:88-97):
//   1. price_update.verification_level == Full   → InsufficientVerificationLevel
//   2. price_update.price_message.feed_id == pyth_feed_id  → MismatchedFeedId
//
// Zero feed IDs are still rejected as defense-in-depth, though the proof check
// already implicitly rejects them (no real Pyth feed has feed_id [0u8; 32]).
//
// Strike, expiry, option type, and settlement state moved to SharedVault
// and SettlementRecord. The Market PDA is a per-asset registry record.
//
// Asset names must be pre-normalized by the caller: ASCII-uppercase,
// alphanumeric only, 1..=16 chars. The handler verifies the normalization
// (it does NOT silently uppercase) so the (asset_name, market_pda)
// mapping is unambiguous.
//
// PDA seed: ["market", asset_name.as_bytes()]
// =============================================================================

use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::error::GetPriceError;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;
use pyth_solana_receiver_sdk::price_update::VerificationLevel;

use crate::errors::OptaError;
use crate::state::{OptionsMarket, ProtocolState, MARKET_SEED, MAX_ASSET_CLASS, MAX_ASSET_NAME_LEN, PROTOCOL_SEED};

/// Verify the asset name conforms to the normalization contract:
/// 1..=16 ASCII uppercase letters or digits. Caller must pre-normalize.
fn assert_normalized(name: &str) -> Result<()> {
    require!(
        !name.is_empty() && name.len() <= MAX_ASSET_NAME_LEN,
        OptaError::InvalidAssetName
    );
    require!(
        name.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit()),
        OptaError::InvalidAssetName
    );
    Ok(())
}

pub fn handle_create_market(
    ctx: Context<CreateMarket>,
    asset_name: String,
    pyth_feed_id: [u8; 32],
    asset_class: u8,
) -> Result<()> {
    // HIGH-5 proof gate (audit Run-7). Verify the caller-supplied feed_id
    // is proof-bound to a real Pyth feed by checking the supplied
    // PriceUpdateV2 account: verification_level must be Full and the
    // price_message's feed_id must match the argument. Mirrors the
    // canonical check in settle_expiry.rs:88-97. Replaces the prior
    // HIGH-2 admin gate — proof-of-feed-existence is strictly stronger:
    // it rejects random-byte griefers AND admin fat-fingers, and unblocks
    // permissionless asset listing.
    let pu = &ctx.accounts.price_update;
    require!(
        pu.verification_level.gte(VerificationLevel::Full),
        GetPriceError::InsufficientVerificationLevel
    );
    require!(
        pu.price_message.feed_id == pyth_feed_id,
        GetPriceError::MismatchedFeedId
    );

    // HIGH-3 same-arc zero-feed guard. Defense-in-depth — the proof check
    // above already implicitly rejects [0u8; 32] (no real Pyth feed has
    // a zero feed_id), but kept as a belt-and-suspenders explicit reject.
    require!(pyth_feed_id != [0u8; 32], OptaError::InvalidPythFeedId);

    // 1. Asset name normalization contract
    assert_normalized(&asset_name)?;

    // 2. Asset class bound (0..=4)
    require!(asset_class <= MAX_ASSET_CLASS, OptaError::InvalidAssetClass);

    // 3. Idempotent init: if account already populated, verify match
    let market = &mut ctx.accounts.market;
    if !market.asset_name.is_empty() {
        require!(
            market.asset_name == asset_name
                && market.pyth_feed_id == pyth_feed_id
                && market.asset_class == asset_class,
            OptaError::AssetMismatch
        );
        msg!("Market already exists for {} — idempotent Ok", asset_name);
        return Ok(());
    }

    // 4. First init — populate fields and bump market counter
    market.asset_name = asset_name.clone();
    market.pyth_feed_id = pyth_feed_id;
    market.asset_class = asset_class;
    market.bump = ctx.bumps.market;

    let protocol = &mut ctx.accounts.protocol_state;
    protocol.total_markets = protocol
        .total_markets
        .checked_add(1)
        .ok_or(OptaError::MathOverflow)?;

    msg!(
        "Market registered: {} feed_id={:?} class={}",
        asset_name,
        pyth_feed_id,
        asset_class
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(asset_name: String, pyth_feed_id: [u8; 32], asset_class: u8)]
pub struct CreateMarket<'info> {
    /// Permissionless post-HIGH-5 fix (audit Run-7). Any signer pays for
    /// account creation on first init; pays nothing on idempotent re-call
    /// because `init_if_needed` short-circuits. The proof-of-feed gate is
    /// enforced via the `price_update` account below.
    #[account(mut)]
    pub creator: Signer<'info>,

    /// Global ProtocolState — mutated to bump total_markets on first init.
    #[account(
        mut,
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Fresh PriceUpdateV2 from the Pyth Receiver program. The handler
    /// verifies `verification_level == Full` and
    /// `price_message.feed_id == pyth_feed_id` to prove the caller-supplied
    /// feed_id corresponds to a real Pyth feed. Read-only — never mutated.
    pub price_update: Account<'info, PriceUpdateV2>,

    /// Asset registry PDA. One per supported asset.
    #[account(
        init_if_needed,
        seeds = [MARKET_SEED, asset_name.as_bytes()],
        bump,
        payer = creator,
        space = 8 + OptionsMarket::INIT_SPACE,
    )]
    pub market: Account<'info, OptionsMarket>,

    pub system_program: Program<'info, System>,
}
