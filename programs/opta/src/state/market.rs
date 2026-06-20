// =============================================================================
// state/market.rs — Asset registry record (one PDA per supported asset)
// =============================================================================
//
// Stage 2 reshape: an OptionsMarket is now an *asset registration*, not an
// option specification. A single PDA per asset records the human-readable
// name, the Pyth oracle feed, and the asset class. Strike, expiry, option
// type, and settlement state moved off the market entirely:
//   - Strike, expiry, option type live on `SharedVault` (one vault per
//     unique option spec).
//   - Settlement price lives on a per-(asset, expiry) `SettlementRecord`
//     PDA (introduced in Stage 3).
//
// The `OptionType` enum still lives here because `SharedVault` reuses it.
//
// PDA seed: ["market", normalized_asset_name(bytes)]
//
// Asset names are normalized at create time (uppercase, alphanumeric only,
// 1..=16 chars). Once registered, the (asset_name, pyth_feed_id, asset_class)
// triple is immutable — re-creating with matching values is a silent Ok
// (idempotent registry); re-creating with different values reverts with
// `AssetMismatch`.
// =============================================================================

use anchor_lang::prelude::*;

/// Maximum length of an asset name (e.g. "SOL", "BTC", "AAPL").
pub const MAX_ASSET_NAME_LEN: usize = 16;

/// Whether this option is a call (right to buy) or put (right to sell).
/// Lives on `SharedVault` post-Stage-2; kept here because vaults import it.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug, PartialEq, Eq, InitSpace)]
pub enum OptionType {
    /// Call option — buyer profits when the asset price is ABOVE the strike.
    Call,
    /// Put option — buyer profits when the asset price is BELOW the strike.
    Put,
}

#[account]
#[derive(InitSpace)]
pub struct OptionsMarket {
    /// Human-readable, normalized asset identifier ("SOL", "BTC", "AAPL", ...).
    /// Max 16 chars, ASCII-uppercase, alphanumeric only.
    #[max_len(16)]
    pub asset_name: String,

    /// The 32-byte Pyth Pull oracle feed ID for this asset.
    /// HIGH-5 (audit Run-7): proof-bound at create_market AND
    /// migrate_pyth_feed via a PriceUpdateV2 account whose
    /// `verification_level == Full` and `price_message.feed_id` matches.
    /// settle_expiry re-validates the same proof at settlement time.
    pub pyth_feed_id: [u8; 32],

    /// Asset class for categorizing the underlying asset.
    /// 0 = crypto, 1 = commodity, 2 = equity, 3 = forex, 4 = ETF.
    /// Metadata-only today — no surviving on-chain or frontend pricing
    /// logic branches on this value.
    pub asset_class: u8,

    /// PDA bump seed.
    pub bump: u8,

    /// Oracle backing this asset's spot price.
    /// `0` = Pyth (pull), `1` = Switchboard (On-Demand). See
    /// `ORACLE_SOURCE_*` consts below.
    ///
    /// Trailing-appended (Stage 2 of the Switchboard arc) AFTER `bump`,
    /// following the `carry_rate_bps` / `exercise_style` precedent on
    /// `SharedVault`: legacy 62-byte markets grow to 63 bytes via the
    /// admin-only `migrate_market_oracle_source` instruction, which
    /// zero-fills this trailing byte (→ Pyth, the no-op default). New
    /// markets are born with this set to `ORACLE_SOURCE_PYTH` in
    /// `create_market`.
    ///
    /// The 32-byte `pyth_feed_id` field above is reused as the oracle id for
    /// BOTH sources (a Switchboard feedHash is also 32 bytes); only its
    /// MEANING routes by this field. INERT until Stage 3 wires the read-arm
    /// match in `utils/price_oracle.rs` — every handler stays unconditionally
    /// Pyth today, so this field is read by nothing.
    pub oracle_source: u8,
}

/// Prefix for the OptionsMarket PDA seed.
pub const MARKET_SEED: &[u8] = b"market";

/// Asset class constants.
pub const ASSET_CLASS_CRYPTO: u8 = 0;
pub const ASSET_CLASS_COMMODITY: u8 = 1;
pub const ASSET_CLASS_EQUITY: u8 = 2;
pub const ASSET_CLASS_FOREX: u8 = 3;
pub const ASSET_CLASS_ETF: u8 = 4;
/// Maximum valid asset class value.
pub const MAX_ASSET_CLASS: u8 = 4;

/// Oracle-source values for the `OptionsMarket.oracle_source` field.
/// Pyth pull oracle — the only source wired today (Stage 1/2). Default for
/// every existing market (migration zero-fill) and every new market
/// (`create_market`).
pub const ORACLE_SOURCE_PYTH: u8 = 0;
/// Switchboard On-Demand — reserved for Stage 3; no read path routes to it
/// yet, and `create_market` cannot mint a market with this value until then.
pub const ORACLE_SOURCE_SWITCHBOARD: u8 = 1;
