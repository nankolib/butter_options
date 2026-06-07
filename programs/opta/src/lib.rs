// =============================================================================
// lib.rs — Opta: Tokenized P2P options protocol on Solana
// =============================================================================
//
// Options are represented as SPL tokens. Whoever holds the tokens can exercise.
// This makes options tradeable on the built-in P2P marketplace or any DEX.
//
// Surface (Stage 3):
//   1. initialize_protocol      — One-time setup
//   2. create_market            — Register a supported asset (admin-only, idempotent)
//   3. settle_expiry            — Record canonical price for an (asset, expiry)
//   v2 vault instructions follow below.
// =============================================================================

use anchor_lang::prelude::*;

pub mod errors;
pub mod events;
pub mod feature_flags;
pub mod instructions;
pub mod state;
pub mod utils;

use instructions::*;
use state::*;

declare_id!("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");

#[program]
pub mod opta {
    use super::*;

    pub fn initialize_protocol(ctx: Context<InitializeProtocol>) -> Result<()> {
        instructions::initialize_protocol::handle_initialize_protocol(ctx)
    }

    /// Register a supported asset (permissionless, idempotent).
    /// One Market PDA per asset; strike/expiry/type live on SharedVault.
    /// `pyth_feed_id` is the 32-byte Pyth Pull feed ID for the asset.
    pub fn create_market(
        ctx: Context<CreateMarket>,
        asset_name: String,
        pyth_feed_id: [u8; 32],
        asset_class: u8,
    ) -> Result<()> {
        instructions::create_market::handle_create_market(ctx, asset_name, pyth_feed_id, asset_class)
    }

    /// Record the canonical settlement price for an (asset, expiry) tuple
    /// from a Pyth Pull `PriceUpdateV2` account. Permissionless — anyone
    /// can call once the (asset, expiry) is past expiry and a fresh Pyth
    /// update is on-chain.
    pub fn settle_expiry(
        ctx: Context<SettleExpiry>,
        asset_name: String,
        expiry: i64,
    ) -> Result<()> {
        instructions::settle_expiry::handle_settle_expiry(ctx, asset_name, expiry)
    }

    /// Rotate the Pyth Pull feed_id stored on an existing OptionsMarket.
    /// Admin-only; idempotent on same feed_id; overwrites on different.
    /// No oracle call — only mutates registry metadata.
    pub fn migrate_pyth_feed(
        ctx: Context<MigratePythFeed>,
        asset_name: String,
        new_pyth_feed_id: [u8; 32],
    ) -> Result<()> {
        instructions::migrate_pyth_feed::handle_migrate_pyth_feed(
            ctx, asset_name, new_pyth_feed_id,
        )
    }

    // =========================================================================
    // v2 Shared Vault instructions
    // =========================================================================

    /// Initialize the epoch schedule (admin-only, one-time setup).
    pub fn initialize_epoch_config(
        ctx: Context<InitializeEpochConfig>,
        weekly_expiry_day: u8,
        weekly_expiry_hour: u8,
        monthly_enabled: bool,
    ) -> Result<()> {
        instructions::initialize_epoch_config::handle_initialize_epoch_config(
            ctx, weekly_expiry_day, weekly_expiry_hour, monthly_enabled,
        )
    }

    /// Create a new shared collateral vault for a specific option specification.
    pub fn create_shared_vault(
        ctx: Context<CreateSharedVault>,
        strike_price: u64,
        expiry: i64,
        option_type: OptionType,
        vault_type: VaultType,
        collateral_mint: Pubkey,
        carry_rate_bps: i32,
        exercise_style: ExerciseStyle,
    ) -> Result<()> {
        instructions::create_shared_vault::handle_create_shared_vault(
            ctx, strike_price, expiry, option_type, vault_type, collateral_mint, carry_rate_bps, exercise_style,
        )
    }

    /// Deposit USDC collateral into a shared vault and receive shares.
    pub fn deposit_to_vault(
        ctx: Context<DepositToVault>,
        amount: u64,
    ) -> Result<()> {
        instructions::deposit_to_vault::handle_deposit_to_vault(ctx, amount)
    }

    /// Mint Living Option Tokens from a shared vault using writer's collateral share.
    pub fn mint_from_vault(
        ctx: Context<MintFromVault>,
        quantity: u64,
        premium_per_contract: u64,
        created_at: i64,
    ) -> Result<()> {
        instructions::mint_from_vault::handle_mint_from_vault(
            ctx, quantity, premium_per_contract, created_at,
        )
    }

    /// Purchase option tokens minted from a shared vault.
    pub fn purchase_from_vault(
        ctx: Context<PurchaseFromVault>,
        quantity: u64,
        max_premium: u64,
    ) -> Result<()> {
        instructions::purchase_from_vault::handle_purchase_from_vault(ctx, quantity, max_premium)
    }

    /// Burn unsold option tokens from a vault mint, freeing committed collateral.
    pub fn burn_unsold_from_vault(ctx: Context<BurnUnsoldFromVault>) -> Result<()> {
        instructions::burn_unsold_from_vault::handle_burn_unsold_from_vault(ctx)
    }

    /// Withdraw uncommitted collateral from a shared vault.
    pub fn withdraw_from_vault(
        ctx: Context<WithdrawFromVault>,
        shares_to_withdraw: u64,
    ) -> Result<()> {
        instructions::withdraw_from_vault::handle_withdraw_from_vault(ctx, shares_to_withdraw)
    }

    /// Claim earned premium from a shared vault.
    pub fn claim_premium(ctx: Context<ClaimPremium>) -> Result<()> {
        instructions::claim_premium::handle_claim_premium(ctx)
    }

    /// Settle a shared vault. Permissionless — reads the canonical price
    /// from a SettlementRecord PDA written earlier by `settle_expiry`.
    pub fn settle_vault(ctx: Context<SettleVault>) -> Result<()> {
        instructions::settle_vault::handle_settle_vault(ctx)
    }

    /// Exercise option tokens from a settled vault.
    pub fn exercise_from_vault(
        ctx: Context<ExerciseFromVault>,
        quantity: u64,
    ) -> Result<()> {
        instructions::exercise_from_vault::handle_exercise_from_vault(ctx, quantity)
    }

    /// Early (pre-expiry) American exercise. The holder burns `quantity`
    /// tokens and receives cash-settled capped intrinsic in USDC from the
    /// vault (CALL/PUT capped at 1× collateral per contract). American-only
    /// and gated off via AMERICAN_ENABLED until Stage I. Spot is read from a
    /// fresh PriceUpdateV2 the exerciser supplies. Increments the vault's
    /// early-exercise counters only; settlement nets them in Stage G.
    pub fn exercise_american(
        ctx: Context<ExerciseAmerican>,
        quantity: u64,
    ) -> Result<()> {
        instructions::exercise_american::handle_exercise_american(ctx, quantity)
    }

    /// Withdraw remaining collateral after vault settlement.
    pub fn withdraw_post_settlement(ctx: Context<WithdrawPostSettlement>) -> Result<()> {
        instructions::withdraw_post_settlement::handle_withdraw_post_settlement(ctx)
    }

    /// Auto-burn holder option tokens + auto-pay ITM USDC for a settled vault.
    /// Permissionless. Caller passes `remaining_accounts` as pairs of
    /// (holder_option_ata, holder_usdc_ata). Idempotent: zero-amount accounts
    /// and mismatched USDC ATAs are skipped silently.
    /// See docs/AUTO_FINALIZE_PLAN.md.
    pub fn auto_finalize_holders<'info>(
        ctx: Context<'_, '_, '_, 'info, AutoFinalizeHolders<'info>>,
    ) -> Result<()> {
        instructions::auto_finalize_holders::handle_auto_finalize_holders(ctx)
    }

    /// Auto-distribute USDC to writers + close their writer_position accounts
    /// for a settled vault. Permissionless. Caller passes `remaining_accounts`
    /// as triples of (writer_position, writer_usdc_ata, writer_wallet).
    /// Idempotent: closed writer_positions and mismatched USDC ATAs are
    /// skipped silently. When the last writer is processed, sweeps any USDC
    /// dust + the vault_usdc_account rent SOL to the protocol treasury.
    /// See docs/AUTO_FINALIZE_PLAN.md.
    pub fn auto_finalize_writers<'info>(
        ctx: Context<'_, '_, 'info, 'info, AutoFinalizeWriters<'info>>,
    ) -> Result<()> {
        instructions::auto_finalize_writers::handle_auto_finalize_writers(ctx)
    }

    // =========================================================================
    // V2 secondary listing instructions
    // =========================================================================

    /// V2 secondary listing — list option tokens for resale.
    /// Spec: docs/V2_SECONDARY_LISTING_PLAN.md §2.1.
    pub fn list_v2_for_resale(
        ctx: Context<ListV2ForResale>,
        price_per_contract: u64,
        quantity: u64,
    ) -> Result<()> {
        instructions::list_v2_for_resale::handle_list_v2_for_resale(
            ctx, price_per_contract, quantity,
        )
    }

    /// V2 secondary listing — fill (partially or fully) an existing listing.
    /// Spec: docs/V2_SECONDARY_LISTING_PLAN.md §2.2.
    pub fn buy_v2_resale(
        ctx: Context<BuyV2Resale>,
        quantity: u64,
        max_total_price: u64,
    ) -> Result<()> {
        instructions::buy_v2_resale::handle_buy_v2_resale(ctx, quantity, max_total_price)
    }

    /// V2 secondary listing — seller cancels their own listing.
    /// Spec: docs/V2_SECONDARY_LISTING_PLAN.md §2.3.
    pub fn cancel_v2_resale(ctx: Context<CancelV2Resale>) -> Result<()> {
        instructions::cancel_v2_resale::handle_cancel_v2_resale(ctx)
    }

    /// V2 secondary listing — permissionless cleanup of stale listings at expiry.
    /// Spec: docs/V2_SECONDARY_LISTING_PLAN.md §4.2 (Design A).
    pub fn auto_cancel_listings<'info>(
        ctx: Context<'_, '_, 'info, 'info, AutoCancelListings<'info>>,
    ) -> Result<()> {
        instructions::auto_cancel_listings::handle_auto_cancel_listings(ctx)
    }

    /// One-time SharedVault schema migration that adds the trailing
    /// carry_rate_bps field to pre-Stage-A vaults. Admin-only. Caller passes
    /// vault accounts to migrate via remaining_accounts (recommended batch:
    /// 20-30 per call to stay under 1.4M CU). Idempotent: vaults already at
    /// the new size are skipped. Admin pays the rent delta.
    pub fn migrate_shared_vault_carry_rate<'info>(
        ctx: Context<'_, '_, '_, 'info, MigrateSharedVaultCarryRate<'info>>,
    ) -> Result<()> {
        instructions::migrate_shared_vault_carry_rate::handle_migrate_shared_vault_carry_rate(ctx)
    }

    /// One-time SharedVault schema migration that adds the trailing
    /// exercise_style field to pre-Pass-1 vaults. Admin-only.
    /// Caller passes vault accounts via remaining_accounts (recommended
    /// batch: 20-30 per call). Idempotent: vaults already at the new
    /// size are skipped. Zero-fill on the new byte deserializes as
    /// ExerciseStyle::European (variant 0). Admin pays the rent delta.
    pub fn migrate_shared_vault_exercise_style<'info>(
        ctx: Context<'_, '_, '_, 'info, MigrateSharedVaultExerciseStyle<'info>>,
    ) -> Result<()> {
        instructions::migrate_shared_vault_exercise_style::handle_migrate_shared_vault_exercise_style(ctx)
    }

    /// One-time SharedVault schema migration that adds the trailing
    /// exercised_options + early_exercise_payout fields (Stage F) to
    /// pre-Stage-F vaults. Admin-only. Caller passes vault accounts via
    /// remaining_accounts (recommended batch: 20 per call). Idempotent:
    /// vaults already at the new size are skipped. Zero-fill on the new 16
    /// bytes deserializes as 0/0 (no early exercises). Admin pays the rent delta.
    pub fn migrate_shared_vault_exercise_tracking<'info>(
        ctx: Context<'_, '_, '_, 'info, MigrateSharedVaultExerciseTracking<'info>>,
    ) -> Result<()> {
        instructions::migrate_shared_vault_exercise_tracking::handle_migrate_shared_vault_exercise_tracking(ctx)
    }

    // =========================================================================
    // Phase 2 Stage B -- realized-vol oracle
    // =========================================================================

    /// Bootstrap a per-feed VolOracle PDA. Permissionless; caller supplies
    /// a fresh PriceUpdateV2 whose feed_id matches the arg as proof-of-
    /// feed-existence. Plain `init` -- second call for the same feed_id
    /// reverts.
    pub fn initialize_vol_oracle(
        ctx: Context<InitializeVolOracle>,
        feed_id: [u8; 32],
    ) -> Result<()> {
        instructions::initialize_vol_oracle::handle_initialize_vol_oracle(ctx, feed_id)
    }

    /// Push a fresh Pyth spot sample to a VolOracle. Permissionless. The
    /// handler validates the Pyth update, computes a log return against
    /// the prior spot, and updates the ring buffer + O(1) accumulators.
    /// First push to a fresh oracle takes the seed-only branch (no
    /// ring/accumulator write; rate limit skipped). Subsequent pushes
    /// enforce the rate limit (55 min production / 1 sec test-fast-vol).
    pub fn push_vol_sample(ctx: Context<PushVolSample>) -> Result<()> {
        instructions::push_vol_sample::handle_push_vol_sample(ctx)
    }

    /// AMER-only BS-2002 pricing view. Read-only; CPI-callable.
    /// Returns OptionPriceQuote (premium + vol/spot snapshot + ts) for the
    /// supplied hypothetical option against a live VolOracle. European
    /// reverts with ViewNotSupportedForEuropean — use the off-chain BS
    /// pricer (app/src/utils/blackScholes.ts) for EUR quotes. Shares the
    /// `price_american` helper with mint_from_vault, so same-block quotes
    /// match what a mint would charge.
    pub fn get_option_price(
        ctx: Context<GetOptionPrice>,
        strike: u64,
        expiry_ts: i64,
        option_type: OptionType,
        exercise_style: ExerciseStyle,
        carry_rate_bps: i32,
    ) -> Result<OptionPriceQuote> {
        instructions::get_option_price::handle_get_option_price(
            ctx, strike, expiry_ts, option_type, exercise_style, carry_rate_bps,
        )
    }

    /// Hot-path CU profile for push_vol_sample. Calls the ring +
    /// accumulator update directly with a synthetic log return,
    /// bracketed by sol_log_compute_units. Test-only.
    #[cfg(feature = "cu-profile")]
    pub fn cu_profile_push_vol_sample(
        ctx: Context<CuProfilePushVolSample>,
    ) -> Result<()> {
        instructions::cu_profile_push_vol_sample::handle_cu_profile_push_vol_sample(ctx)
    }

    /// CU profile for realized_vol_annualized. Synthesizes 720-sample
    /// accumulators in the oracle account, then measures the read
    /// function. Test-only.
    #[cfg(feature = "cu-profile")]
    pub fn cu_profile_realized_vol(
        ctx: Context<CuProfileRealizedVol>,
    ) -> Result<()> {
        instructions::cu_profile_realized_vol::handle_cu_profile_realized_vol(ctx)
    }

    // =========================================================================
    // Test-only CU profiling (gated by `cu-profile` Cargo feature).
    // NEVER deploy a cu-profile build to devnet/mainnet.
    // =========================================================================

    /// Profile compute-unit consumption of the BS-2002 American pricing kernel
    /// across three scenarios (CALL fast-path, CALL BS-2002 main, PUT via
    /// McD-S transform). Per-phi breakdown via gated markers inside
    /// `bs2002_call_price`. Test-only.
    #[cfg(feature = "cu-profile")]
    pub fn cu_profile_american(ctx: Context<CuProfileAmerican>) -> Result<()> {
        instructions::cu_profile_american::handle_cu_profile_american(ctx)
    }

    /// CU profile for the FULL American branch pipeline of mint_from_vault:
    /// VolOracle load + realized_vol_annualized + american_call_price /
    /// american_put_price. Synthesizes oracle accumulator state in-line so
    /// no warmup wait is needed. Test-only.
    #[cfg(feature = "cu-profile")]
    pub fn cu_profile_mint_from_vault_american(
        ctx: Context<CuProfileMintFromVaultAmerican>,
    ) -> Result<()> {
        instructions::cu_profile_mint_from_vault_american::handle_cu_profile_mint_from_vault_american(ctx)
    }

    /// CU profile for the Pass 3 `price_american` helper (the path
    /// `get_option_price` executes per call). Plants synthetic vol oracle
    /// state then measures Call q=5% + Put q=5% (both BS-2002 main path).
    /// Test-only.
    #[cfg(feature = "cu-profile")]
    pub fn cu_profile_get_option_price(
        ctx: Context<CuProfileGetOptionPrice>,
    ) -> Result<()> {
        instructions::cu_profile_get_option_price::handle_cu_profile_get_option_price(ctx)
    }

    /// Shrink a SharedVault account back to its pre-Stage-A size (without the
    /// trailing carry_rate_bps field). Used by tests/realloc-shared-vault.ts
    /// to simulate a legacy on-chain vault before exercising the lazy-realloc
    /// migration in claim_premium. Test-only.
    #[cfg(feature = "cu-profile")]
    pub fn shrink_shared_vault_for_test(ctx: Context<ShrinkSharedVaultForTest>) -> Result<()> {
        instructions::shrink_shared_vault_for_test::handle_shrink_shared_vault_for_test(ctx)
    }

    /// Shrink a SharedVault account back to its pre-Pass-1 size (without
    /// the trailing exercise_style field). Used by
    /// tests/realloc-shared-vault-exercise-style.ts to simulate a legacy
    /// on-chain vault before exercising the
    /// migrate_shared_vault_exercise_style instruction. Test-only.
    #[cfg(feature = "cu-profile")]
    pub fn shrink_shared_vault_to_pre_exercise_style_for_test(
        ctx: Context<ShrinkSharedVaultToPreExerciseStyleForTest>,
    ) -> Result<()> {
        instructions::shrink_shared_vault_to_pre_exercise_style_for_test::handle_shrink_shared_vault_to_pre_exercise_style_for_test(ctx)
    }

    /// Initialize a bare SharedVault account with default values, bypassing
    /// the full create_shared_vault validation chain (no market/USDC/epoch/
    /// Pyth proof dependencies). Used by tests/realloc-shared-vault.ts to
    /// stand up vaults for the realloc tests. Test-only.
    #[cfg(feature = "cu-profile")]
    pub fn create_test_shared_vault(
        ctx: Context<CreateTestSharedVault>,
    ) -> Result<()> {
        instructions::create_test_shared_vault::handle_create_test_shared_vault(ctx)
    }

    /// Plant warmed VolOracle state (sample_count=720, fresh last_sample_ts,
    /// V2-reference accumulators, caller-supplied spot) so American pricing
    /// reads Ok past warmup/stale/math gates without 168 rate-limited pushes.
    /// Gated by `test-synth-vol`. NEVER deploy a test-synth-vol build — it
    /// lets anyone overwrite an oracle's vol state. Test-only.
    #[cfg(feature = "test-synth-vol")]
    pub fn synth_warm_vol_oracle(
        ctx: Context<SynthWarmVolOracle>,
        spot_price_scaled: i64,
        last_sample_ts: i64,
    ) -> Result<()> {
        instructions::synth_warm_vol_oracle::handle_synth_warm_vol_oracle(
            ctx, spot_price_scaled, last_sample_ts,
        )
    }
}
