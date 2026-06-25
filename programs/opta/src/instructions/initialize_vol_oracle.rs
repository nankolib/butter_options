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
// SWITCHBOARD (Stage 3 1c-i-A): the new trailing `oracle_source: u8` arg picks
// the spot source the born oracle reads from (push_vol_sample routes on
// VolOracle.oracle_source — the keystone). Only ORACLE_SOURCE_PYTH (0) or
// ORACLE_SOURCE_SWITCHBOARD (1) are accepted; anything else reverts
// InvalidOracleSource. For a Switchboard oracle the feed_id holds the 32-byte
// SB feedHash (the pyth_feed_id/feedHash double-duty — no schema change).
//
// PROOF ASYMMETRY: the Pyth proof-of-feed gate runs ONLY for oracle_source=0.
// A Switchboard feedHash has no Pyth PriceUpdateV2 to prove against, so the SB
// feed-existence proof is DEFERRED to the first push_vol_sample (its SB arm runs
// the QuoteVerifier and rejects an unknown feedHash with SwitchboardFeedNotFound).
// Birthing an SB oracle for a junk feedHash is INERT, not a security gap: no quote
// ever verifies → sample_count stays 0, last_spot_price stays 0 → the oracle can
// never feed a price into the American pricing tree. The only cost is the
// initializer's own wasted rent (a self-DoS, harmless to the protocol). Hence
// `price_update` is now Option: REQUIRED (present) for a Pyth oracle — wire-
// identical to the pre-1c-i-A required form — and passed None for a Switchboard
// oracle.
//
// INSTRUCTION-DATA BACKWARD COMPAT: adding the trailing `oracle_source` arg
// leaves the 8-byte discriminator unchanged (derived from the name) but grows
// the Borsh arg region by 1 byte. An existing tx carrying only the 32-byte
// feed_id no longer deserializes (InstructionDidNotDeserialize). This is
// acceptable: `init` is one-time per feed (a second call reverts), every
// existing VolOracle is ALREADY initialized, and no path re-inits — so the
// break only affects NEW oracle creation going forward, never existing on-chain
// state. All off-chain callers pass ORACLE_SOURCE_PYTH (0) to preserve today's
// behavior; the change is a mechanical +1 arg at each call site.
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
use crate::state::{VolOracle, ORACLE_SOURCE_PYTH, ORACLE_SOURCE_SWITCHBOARD, VOL_ORACLE_SEED};

pub fn handle_initialize_vol_oracle(
    ctx: Context<InitializeVolOracle>,
    feed_id: [u8; 32],
    oracle_source: u8,
) -> Result<()> {
    // 0. Validate the requested oracle source: Pyth (0) or Switchboard (1) only.
    require!(
        oracle_source == ORACLE_SOURCE_PYTH || oracle_source == ORACLE_SOURCE_SWITCHBOARD,
        OptaError::InvalidOracleSource
    );

    // 1. Proof-of-feed-existence gate -- PYTH SOURCE ONLY (mirrors
    //    create_market.rs:60-76). A Switchboard feedHash has no Pyth
    //    PriceUpdateV2 to prove against, so its feed-existence proof is deferred
    //    to the first push_vol_sample SB arm (see the module header). For a Pyth
    //    oracle the price_update is REQUIRED (else PriceUpdateMissing).
    if oracle_source == ORACLE_SOURCE_PYTH {
        let pu = ctx
            .accounts
            .price_update
            .as_ref()
            .ok_or(error!(OptaError::PriceUpdateMissing))?;
        require!(
            pu.verification_level.gte(VerificationLevel::Full),
            GetPriceError::InsufficientVerificationLevel
        );
        require!(
            pu.price_message.feed_id == feed_id,
            GetPriceError::MismatchedFeedId
        );
    }

    // 2. Zero-feed defense-in-depth (BOTH sources; matches create_market HIGH-3
    //    guard). For Pyth the proof above already implicitly rejects [0u8; 32];
    //    for Switchboard this is the cheap birth-time reject of a zero feedHash.
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
    // Stage 3 1c-i-A: born with the requested source (validated above).
    oracle.oracle_source = oracle_source;

    msg!(
        "VolOracle initialized: feed_id={:?} source={} pda={}",
        feed_id,
        oracle_source,
        ctx.accounts.vol_oracle.key(),
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(feed_id: [u8; 32], oracle_source: u8)]
pub struct InitializeVolOracle<'info> {
    /// Permissionless. Any signer pays for account creation.
    #[account(mut)]
    pub initializer: Signer<'info>,

    /// Fresh PriceUpdateV2 from the Pyth Receiver program. The handler
    /// verifies `verification_level == Full` and
    /// `price_message.feed_id == feed_id` to prove the caller-supplied
    /// feed_id corresponds to a real Pyth feed. Read-only -- never mutated.
    ///
    /// Stage 3 1c-i-A: now `Option`. REQUIRED (present) for a Pyth oracle
    /// (oracle_source=0) -- a present account is wire-identical to the prior
    /// required form, so existing Pyth inits are unaffected. Passed None for a
    /// Switchboard oracle (oracle_source=1): the SB feed-existence proof is
    /// deferred to the first push_vol_sample SB arm (see the module header).
    /// The Pyth arm errors `PriceUpdateMissing` if absent on a Pyth init.
    pub price_update: Option<Account<'info, PriceUpdateV2>>,

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
