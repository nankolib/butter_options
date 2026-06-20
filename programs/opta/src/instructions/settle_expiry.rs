// =============================================================================
// instructions/settle_expiry.rs — Record settlement price from Pyth Pull
// =============================================================================
//
// Pricing semantic (post-fix arc, 2026-05-03):
//   settlement price = Pyth EMA at first published time at-or-after
//                      vault expiry, within a 60s window.
//
// The crank fetches a HISTORICAL Pyth update whose publish_time is at
// or just after vault expiry (Hermes /v2/updates/price/{ts} endpoint —
// /v1 was decommissioned in the 2026-05-20 Pyth cutover), posts it via
// the Pyth Receiver, and consumes it here. We read EMA
// (price_update.price_message.ema_price) rather than spot to dampen
// final-tick noise — the EMA is signed/verified via the same Wormhole
// VAA + Merkle path as spot, so verification guarantees are identical.
//
// Permissionless. Caller passes a PriceUpdateV2 account. We validate:
//   1. Asset's expiry has elapsed (clock >= expiry)
//   2. price_update.verification_level == Full
//   3. price_update.price_message.feed_id == market.pyth_feed_id
//   4. publish_time >= expiry  (else PriceUpdateBeforeExpiry)
//   5. publish_time - expiry <= EXPIRY_WINDOW_SECS (60)  (else PriceUpdateTooFarFromExpiry)
//   6. publish_time + PYTH_MAX_AGE_SECS >= clock        (else PriceTooOld; 1-day floor)
//
// Checks (2) and (3) replicate what the SDK's get_price_no_older_than
// performs internally — verified against pyth-solana-receiver-sdk v1.1.0
// source at src/price_update.rs (2026-05-03). We replicate manually
// because that helper returns a Price struct with no EMA field.
//
// On success, writes the canonical settlement price for this (asset, expiry)
// to a SettlementRecord PDA. SharedVaults for this (asset, expiry) read
// from there.
//
// Idempotency: SettlementRecord is created with `init` (not init_if_needed).
// A second call for the same (asset, expiry) reverts with "account already
// in use".
// =============================================================================

use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::errors::OptaError;
use crate::state::{OptionsMarket, SettlementRecord, MARKET_SEED, SETTLEMENT_SEED};
use crate::utils::price_oracle::pyth_settlement_price_usdc;

/// Maximum gap between the Pyth update's `publish_time` and the on-chain clock
/// at settlement time. Set to 30 days (2_592_000 s) as a wide backstop SLO,
/// up from the original 1-day value. The real security against stale-data
/// attacks is the [expiry, expiry+60] window check (EXPIRY_WINDOW_SECS)
/// applied at gates #5-6 of this instruction — this constant is only a
/// catch-all that prevents silently settling vaults whose historical Pyth
/// updates are months or years stale.
///
/// Why 30 days: previously 86_400 (1 day) which assumed settle delays would
/// be operator-noticed in <24h. The 2026-05-19 Hermes /v1 → /v2 cutover
/// proved that assumption wrong (5-day silent backlog before fix). The new
/// value tolerates multi-day outages while still preventing settles against
/// arbitrarily-old historical updates.
pub const PYTH_MAX_AGE_SECS: u64 = 2_592_000;

/// Maximum gap between Pyth `publish_time` and vault `expiry`. The crank
/// fetches a historical update at `publish_time = expiry`; Pyth posts
/// every ~400ms, so a window of 60s comfortably accommodates skipped
/// slots while pinning settlement to "first official print at-or-after
/// expiry." One-sided: publish_time must be in [expiry, expiry + 60].
pub const EXPIRY_WINDOW_SECS: i64 = 60;

/// Maximum Pyth EMA confidence width tolerated at settlement, in basis
/// points of the EMA price. Settlement reverts when
/// `ema_conf * 10_000 > abs(ema_price) * MAX_CONF_BPS`. 200 bps (2%) is
/// the audit-suggested default — broad enough to absorb routine Pyth
/// noise on blue-chip feeds, tight enough to reject the wide-conf prints
/// that surface during oracle-stress / aggregator-divergence events.
/// See audit Run-6 finding CRIT-2.
pub const MAX_CONF_BPS: u16 = 200;

pub fn handle_settle_expiry(
    ctx: Context<SettleExpiry>,
    asset_name: String,
    expiry: i64,
) -> Result<()> {
    // 1. Cannot settle pre-expiry
    let clock = Clock::get()?;
    require!(
        clock.unix_timestamp >= expiry,
        OptaError::MarketNotExpired
    );

    // 2-6. Validate the Pyth update (Full verification + feed_id match +
    //      EMA-confidence gate + expiry-window gate + staleness floor) and
    //      normalize the EMA to USDC 6-dec. The full read+validate+normalize
    //      logic lives in the source-routed price-oracle abstraction (Stage 1);
    //      Pyth is the sole implementer until the Switchboard arm slots in at
    //      Stage 3. Error codes, gate order, and the EMA read are identical to
    //      the prior inline block.
    let read = pyth_settlement_price_usdc(
        &ctx.accounts.price_update,
        ctx.accounts.market.pyth_feed_id,
        expiry,
        clock.unix_timestamp,
        EXPIRY_WINDOW_SECS,
        PYTH_MAX_AGE_SECS as i64,
        MAX_CONF_BPS,
    )?;
    let settlement_price = read.price_usdc;
    let publish_time = read.publish_time;

    // 7. Populate the record
    let record = &mut ctx.accounts.settlement_record;
    record.asset_name = asset_name.clone();
    record.expiry = expiry;
    record.settlement_price = settlement_price;
    record.settled_at = clock.unix_timestamp;
    record.pyth_publish_time = publish_time;
    record.bump = ctx.bumps.settlement_record;

    // Log the consensus-relevant outputs. The raw Pyth EMA/exponent are no
    // longer surfaced here — they live inside the source-routed price-oracle
    // helper (and would be source-specific once Switchboard is wired at Stage
    // 3); settlement_price + publish_time fully describe the recorded result.
    msg!(
        "Settlement recorded: {} expiry={} price={} (publish_time={})",
        asset_name,
        expiry,
        settlement_price,
        publish_time,
    );

    Ok(())
}

#[derive(Accounts)]
#[instruction(asset_name: String, expiry: i64)]
pub struct SettleExpiry<'info> {
    /// Permissionless. Caller pays for SettlementRecord rent.
    #[account(mut)]
    pub caller: Signer<'info>,

    /// OptionsMarket — provides the canonical feed_id for this asset.
    #[account(
        seeds = [MARKET_SEED, asset_name.as_bytes()],
        bump = market.bump,
    )]
    pub market: Account<'info, OptionsMarket>,

    /// Fresh PriceUpdateV2 from the Pyth Receiver program. Validated by
    /// `get_price_no_older_than(.., &market.pyth_feed_id)` for both feed_id
    /// match and staleness.
    pub price_update: Account<'info, PriceUpdateV2>,

    /// The SettlementRecord PDA. Plain `init` — second call for the same
    /// (asset, expiry) reverts.
    #[account(
        init,
        seeds = [
            SETTLEMENT_SEED,
            asset_name.as_bytes(),
            &expiry.to_le_bytes(),
        ],
        bump,
        payer = caller,
        space = 8 + SettlementRecord::INIT_SPACE,
    )]
    pub settlement_record: Account<'info, SettlementRecord>,

    pub system_program: Program<'info, System>,
}
