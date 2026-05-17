// =============================================================================
// instructions/initialize_vol_oracle.rs -- Bootstrap a per-asset VolOracle PDA
// =============================================================================
//
// Permissionless, proof-of-feed-existence-gated. Mirrors the create_market
// post-HIGH-5 pattern (audit Run-7 PART 1): anyone can register an oracle
// for any feed_id, provided they supply a fresh PriceUpdateV2 whose
//   - verification_level == Full
//   - price_message.feed_id == arg feed_id
//
// This proves the caller-supplied feed_id corresponds to a real Pyth feed
// rather than 32 random bytes a griefer typed. Same defense-in-depth
// zero-feed reject as create_market is included.
//
// One oracle per feed_id (PDA collision otherwise). Plain `init` -- a
// second call for the same feed_id reverts with "account already in use".
// This is acceptable because the price-update freshness gate in
// push_vol_sample (Step 3) makes the initial last_sample_ts irrelevant:
// the first push won't compute a return because last_spot_price is 0,
// it just seeds the buffer.
//
// Caller pays rent (~5.7 KB account, ~0.041 SOL).
//
// Storage note: VolOracle is `#[account(zero_copy)]` because its 5760-byte
// `samples` array would overflow the BPF stack via Anchor's Borsh-backed
// `Account<T>` flow. We use `AccountLoader<T>` here and `load_init()` on
// the fresh account so bytemuck can cast the data region without a
// stack-resident copy. See state/vol_oracle.rs for the layout decision.
// =============================================================================

use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::error::GetPriceError;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;
use pyth_solana_receiver_sdk::price_update::VerificationLevel;

use crate::errors::OptaError;
use crate::state::{VolOracle, VOL_ORACLE_SEED};

pub fn handle_initialize_vol_oracle(
    ctx: Context<InitializeVolOracle>,
    feed_id: [u8; 32],
) -> Result<()> {
    // 1. Proof-of-feed-existence gate (mirrors create_market.rs:60-76).
    let pu = &ctx.accounts.price_update;
    require!(
        pu.verification_level.gte(VerificationLevel::Full),
        GetPriceError::InsufficientVerificationLevel
    );
    require!(
        pu.price_message.feed_id == feed_id,
        GetPriceError::MismatchedFeedId
    );

    // 2. Zero-feed defense-in-depth (matches create_market HIGH-3 guard).
    //    The proof check above already implicitly rejects [0u8; 32] since
    //    no real Pyth feed has a zero feed_id; this is belt-and-suspenders.
    require!(feed_id != [0u8; 32], OptaError::InvalidPythFeedId);

    // 3. Populate the account via the zero_copy loader. `load_init` is the
    //    correct entry point for a fresh `init`-created account: it casts
    //    the zeroed data region as &mut VolOracle without trying to
    //    deserialize (which would fail given the discriminator hasn't been
    //    written yet from the program's perspective). Anchor zeroes the
    //    data buffer for us, so samples/head/sample_count/last_*/sum_*
    //    start at 0 without explicit writes.
    let mut oracle = ctx.accounts.vol_oracle.load_init()?;
    oracle.feed_id = feed_id;
    oracle.bump = ctx.bumps.vol_oracle;

    msg!(
        "VolOracle initialized: feed_id={:?} pda={}",
        feed_id,
        ctx.accounts.vol_oracle.key(),
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(feed_id: [u8; 32])]
pub struct InitializeVolOracle<'info> {
    /// Permissionless. Any signer pays for account creation.
    #[account(mut)]
    pub initializer: Signer<'info>,

    /// Fresh PriceUpdateV2 from the Pyth Receiver program. The handler
    /// verifies `verification_level == Full` and
    /// `price_message.feed_id == feed_id` to prove the caller-supplied
    /// feed_id corresponds to a real Pyth feed. Read-only -- never mutated.
    pub price_update: Account<'info, PriceUpdateV2>,

    /// The VolOracle PDA. One per Pyth feed_id. Plain `init` -- a second
    /// call for the same feed_id reverts ("account already in use").
    /// `AccountLoader` (not `Account`) because zero_copy: see state file.
    #[account(
        init,
        seeds = [VOL_ORACLE_SEED, feed_id.as_ref()],
        bump,
        payer = initializer,
        space = 8 + std::mem::size_of::<VolOracle>(),
    )]
    pub vol_oracle: AccountLoader<'info, VolOracle>,

    pub system_program: Program<'info, System>,
}
