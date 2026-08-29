// =============================================================================
// state/mod.rs — Re-exports all account structures
// =============================================================================
//
// This module aggregates the three core account types so other parts of the
// program can import them with a single `use crate::state::*;`.
// =============================================================================

pub mod epoch_config;
pub mod market;
// FP-ORACLE module (additive; see state/opta_price_feed.rs MODULE BOUNDARY note)
pub mod opta_price_feed;
pub mod protocol;
pub mod resting_order;
pub mod settlement_record;
pub mod shared_vault;
pub mod trigger_order;
pub mod vault_mint;
pub mod vault_resale_listing;
pub mod vol_oracle;
pub mod writer_ask_position;
pub mod writer_ask_pot;
pub mod writer_position;

pub use epoch_config::*;
pub use market::*;
pub use opta_price_feed::*;
pub use protocol::*;
pub use resting_order::*;
pub use settlement_record::*;
pub use shared_vault::*;
pub use trigger_order::*;
pub use vault_mint::*;
pub use vault_resale_listing::*;
pub use vol_oracle::*;
pub use writer_ask_position::*;
pub use writer_ask_pot::*;
pub use writer_position::*;
