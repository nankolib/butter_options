// =============================================================================
// instructions/mod.rs — Re-exports all instruction modules
// =============================================================================

pub mod close_market;
pub mod create_market;
pub mod initialize_protocol;
pub mod migrate_pyth_feed;
pub mod settle_expiry;

// v2 shared vault instructions
pub mod initialize_epoch_config;
pub mod create_shared_vault;
pub mod deposit_to_vault;
pub mod mint_from_vault;
pub mod purchase_from_vault;
pub mod burn_unsold_from_vault;
pub mod withdraw_from_vault;
pub mod claim_premium;
pub mod settle_vault;
pub mod exercise_from_vault;
pub mod exercise_american;
pub mod withdraw_post_settlement;
pub mod auto_finalize_holders;
pub mod auto_finalize_writers;

// V2 secondary listing
pub mod list_v2_for_resale;
pub mod buy_v2_resale;
pub mod cancel_v2_resale;
pub mod auto_cancel_listings;

// Exchange book (Phase 1 — RestingOrder limit book)
pub mod post_order;
pub mod fill_order;
pub mod cancel_order;
pub mod sweep_expired_orders;

// Exchange series (Phase 2 Pass A — canonical per-spec series mint)
pub mod create_series;

// Exchange peg (Phase 2 Pass B — mint-on-fill vault peg)
pub mod fill_vault_peg;

// Exchange writer-ask fill (Phase 3 Slice B — mint-on-fill from personal collateral)
pub mod fill_writer_ask;

// Exchange writer-ask residual + close (Phase 3 Slice D2a)
pub mod withdraw_writer_ask_residual;
pub mod close_settled_writer_ask_vault;

// Exchange void-path reconciliation (Phase 3 Slice D3)
pub mod initialize_void;
pub mod reclaim_writer_ask_residual;

// Exchange write-flow collapse (Phase 2 Pass C — atomic create+deposit)
pub mod create_and_deposit;

// Exchange dead-feed hatch (Phase 2 Pass D — reclaim_unsettled)
pub mod reclaim_unsettled;

// Trigger orders (Phase 4 Pass 0 — placement + cancel; Pass 1 — execute)
pub mod link_oco;
pub mod place_trigger;
pub mod cancel_trigger;
pub mod execute_trigger;

// OptionsMarket oracle_source schema migration (Switchboard Stage 2)
pub mod migrate_market_oracle_source;
// SharedVault carry_rate_bps schema migration (Stage A)
pub mod migrate_shared_vault_carry_rate;
// SharedVault exercise_style schema migration (Stage C Pass 1)
pub mod migrate_shared_vault_exercise_style;
// SharedVault early-exercise tracking schema migration (Stage F)
pub mod migrate_shared_vault_exercise_tracking;
// SharedVault exchange-fields (spread_bps + voided) schema migration (Phase 2 Pass A)
pub mod migrate_shared_vault_exchange_fields;
pub mod migrate_shared_vault_writer_ask_swept;
// SharedVault writer_ask_equiv_shares schema migration (Phase 3 Slice D2a) —
// consolidated 276-migration; SUPERSEDES the D1 268-migration at deploy.
pub mod migrate_shared_vault_residual_shares;

// Phase 2 Stage B -- realized-vol oracle
pub mod initialize_vol_oracle;
pub mod push_vol_sample;
pub mod reset_vol_oracle;
// ---- FP-ORACLE module (additive files only until the plug ceremony) --------
pub mod init_opta_price_feed;
pub mod push_opta_price;
pub mod set_feed_authority;
pub mod set_oracle_source;

// Phase 2 Stage C Pass 3 -- AMER pricing view
pub mod get_option_price;
#[cfg(feature = "cu-profile")]
pub mod cu_profile_push_vol_sample;
#[cfg(feature = "cu-profile")]
pub mod cu_profile_realized_vol;

// CU profiling + Stage A test scaffolding (gated by `cu-profile` feature)
#[cfg(feature = "cu-profile")]
pub mod cu_profile_american;
#[cfg(feature = "cu-profile")]
pub mod cu_profile_mint_from_vault_american;
#[cfg(feature = "cu-profile")]
pub mod cu_profile_get_option_price;
#[cfg(feature = "cu-profile")]
pub mod shrink_shared_vault_for_test;
#[cfg(feature = "cu-profile")]
pub mod shrink_shared_vault_to_pre_exercise_style_for_test;
#[cfg(feature = "cu-profile")]
pub mod create_test_shared_vault;
#[cfg(feature = "test-synth-vol")]
pub mod synth_warm_vol_oracle;

pub use close_market::*;
pub use create_market::*;
pub use initialize_protocol::*;
pub use migrate_pyth_feed::*;
pub use settle_expiry::*;

// v2 shared vault instructions
pub use initialize_epoch_config::*;
pub use create_shared_vault::*;
pub use deposit_to_vault::*;
pub use mint_from_vault::*;
pub use purchase_from_vault::*;
pub use burn_unsold_from_vault::*;
pub use withdraw_from_vault::*;
pub use claim_premium::*;
pub use settle_vault::*;
pub use exercise_from_vault::*;
pub use exercise_american::*;
pub use withdraw_post_settlement::*;
pub use auto_finalize_holders::*;
pub use auto_finalize_writers::*;

// V2 secondary listing
pub use list_v2_for_resale::*;
pub use buy_v2_resale::*;
pub use cancel_v2_resale::*;
pub use auto_cancel_listings::*;

// Exchange book (Phase 1 — RestingOrder limit book)
pub use post_order::*;
pub use fill_order::*;
pub use cancel_order::*;
pub use sweep_expired_orders::*;

// Exchange series (Phase 2 Pass A — canonical per-spec series mint)
pub use create_series::*;

// Exchange peg (Phase 2 Pass B — mint-on-fill vault peg)
pub use fill_vault_peg::*;

// Exchange writer-ask fill (Phase 3 Slice B — mint-on-fill from personal collateral)
pub use fill_writer_ask::*;

// Exchange writer-ask residual + close (Phase 3 Slice D2a)
pub use withdraw_writer_ask_residual::*;
pub use close_settled_writer_ask_vault::*;

// Exchange void-path reconciliation (Phase 3 Slice D3)
pub use initialize_void::*;
pub use reclaim_writer_ask_residual::*;

// Exchange write-flow collapse (Phase 2 Pass C — atomic create+deposit)
pub use create_and_deposit::*;

// Exchange dead-feed hatch (Phase 2 Pass D — reclaim_unsettled)
pub use reclaim_unsettled::*;

// Trigger orders (Phase 4 Pass 0 — placement + cancel; Pass 1 — execute)
pub use link_oco::*;
pub use place_trigger::*;
pub use cancel_trigger::*;
pub use execute_trigger::*;

// OptionsMarket oracle_source schema migration (Switchboard Stage 2)
pub use migrate_market_oracle_source::*;
// SharedVault carry_rate_bps schema migration
pub use migrate_shared_vault_carry_rate::*;
pub use migrate_shared_vault_exercise_style::*;
pub use migrate_shared_vault_exercise_tracking::*;
pub use migrate_shared_vault_exchange_fields::*;
pub use migrate_shared_vault_writer_ask_swept::*;
pub use migrate_shared_vault_residual_shares::*;

// Phase 2 Stage B -- realized-vol oracle
pub use initialize_vol_oracle::*;
pub use push_vol_sample::*;
pub use reset_vol_oracle::*;
// ---- FP-ORACLE module ------------------------------------------------------
pub use init_opta_price_feed::*;
pub use push_opta_price::*;
pub use set_feed_authority::*;
pub use set_oracle_source::*;

// Phase 2 Stage C Pass 3 -- AMER pricing view
pub use get_option_price::*;
#[cfg(feature = "cu-profile")]
pub use cu_profile_push_vol_sample::*;
#[cfg(feature = "cu-profile")]
pub use cu_profile_realized_vol::*;

// CU profiling + Stage A test scaffolding
#[cfg(feature = "cu-profile")]
pub use cu_profile_american::*;
#[cfg(feature = "cu-profile")]
pub use cu_profile_mint_from_vault_american::*;
#[cfg(feature = "cu-profile")]
pub use cu_profile_get_option_price::*;
#[cfg(feature = "cu-profile")]
pub use shrink_shared_vault_for_test::*;
#[cfg(feature = "cu-profile")]
pub use shrink_shared_vault_to_pre_exercise_style_for_test::*;
#[cfg(feature = "cu-profile")]
pub use create_test_shared_vault::*;
#[cfg(feature = "test-synth-vol")]
pub use synth_warm_vol_oracle::*;
