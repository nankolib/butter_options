// =============================================================================
// errors.rs — Custom error codes for the Opta protocol
// =============================================================================
//
// Stage 2 prune: v1-only variants removed. New variants added for asset
// registry validation and (Stage 3) collateral mint validation.
// =============================================================================

use anchor_lang::prelude::*;

#[error_code]
pub enum OptaError {
    // Protocol errors
    #[msg("Unauthorized: signer is not the protocol admin")]
    Unauthorized,

    // Market / asset registry errors
    #[msg("Expiry timestamp must be in the future")]
    ExpiryInPast,
    #[msg("Strike price must be greater than zero")]
    InvalidStrikePrice,
    #[msg("Asset name must be 1-16 ASCII uppercase letters or digits")]
    InvalidAssetName,
    #[msg("Asset class must be 0-4 (crypto, commodity, equity, forex, etf)")]
    InvalidAssetClass,
    #[msg("Market already exists for this asset with different metadata")]
    AssetMismatch,
    #[msg("Market has not expired yet")]
    MarketNotExpired,
    #[msg("Market has not been settled yet")]
    MarketNotSettled,
    #[msg("Settlement price must be greater than zero")]
    InvalidSettlementPrice,

    // Collateral / vault validation
    #[msg("Collateral mint must be the protocol's USDC mint")]
    UnsupportedCollateral,

    // Position / contract errors (still used by v2 vault flow)
    #[msg("Insufficient collateral for this option")]
    InsufficientCollateral,
    #[msg("Contract size must be greater than zero")]
    InvalidContractSize,
    #[msg("Premium must be greater than zero")]
    InvalidPremium,

    // Authorization errors
    #[msg("Only the writer can perform this action")]
    NotWriter,
    #[msg("Cannot buy your own option")]
    CannotBuyOwnOption,

    // Token errors
    #[msg("Insufficient option tokens to exercise")]
    InsufficientOptionTokens,

    // Pricing / oracle errors (used by surviving solmath_bridge)
    #[msg("Option has already expired — cannot price")]
    OptionExpired,

    // Math errors
    #[msg("Arithmetic overflow")]
    MathOverflow,

    // =========================================================================
    // Shared Vault errors (v2 liquidity system)
    // =========================================================================
    #[msg("Custom vaults only allow the original creator to deposit")]
    CustomVaultSingleWriter,

    #[msg("Vault has been settled, no more deposits allowed")]
    VaultAlreadySettled,

    #[msg("Vault expiry has passed")]
    VaultExpired,

    #[msg("Invalid epoch expiry - must fall on configured day and hour")]
    InvalidEpochExpiry,

    #[msg("Insufficient free collateral in writer's vault position")]
    InsufficientVaultCollateral,

    #[msg("Collateral is committed to active options and cannot be withdrawn")]
    CollateralCommitted,

    #[msg("No unsold tokens to burn")]
    NoTokensToBurn,

    #[msg("Nothing to claim - all premium already withdrawn")]
    NothingToClaim,

    #[msg("Premium exceeds buyer's maximum (slippage protection)")]
    SlippageExceeded,

    #[msg("Vault not yet settled")]
    VaultNotSettled,

    #[msg("Option is not in the money - cannot exercise")]
    OptionNotInTheMoney,

    #[msg("Option mint does not belong to this vault")]
    InvalidVaultMint,

    #[msg("Claim all premium before withdrawing shares")]
    ClaimPremiumFirst,

    #[msg("remaining_accounts length must be a multiple of 2 (holder_option_ata, holder_usdc_ata pairs)")]
    InvalidBatchAccounts,

    #[msg("writer_position.vault does not match the shared_vault passed to this instruction")]
    WriterPositionVaultMismatch,

    #[msg("writer_wallet pubkey does not match writer_position.owner — refusing to drain rent to a stranger")]
    WriterWalletMismatch,

    // =========================================================================
    // V2 secondary listing errors
    // =========================================================================
    #[msg("listing has fewer tokens available than requested")]
    ListingExhausted,

    #[msg("only the listing's seller can cancel it")]
    NotResaleSeller,

    #[msg("listing escrow does not belong to this vault")]
    InvalidListingEscrow,

    #[msg("listing PDA derivation failed or its mint/vault doesn't match the batch")]
    ListingMismatch,

    // =========================================================================
    // Pyth settlement window (settle_expiry, D2 of pricing-fix arc)
    // =========================================================================
    #[msg("Pyth price update publish_time is before vault expiry")]
    PriceUpdateBeforeExpiry,

    #[msg("Pyth price update publish_time is more than 60s after vault expiry")]
    PriceUpdateTooFarFromExpiry,

    #[msg("Pyth EMA confidence interval exceeds MAX_CONF_BPS at settlement")]
    PriceConfidenceTooWide,

    // =========================================================================
    // Holder exercise window (CRIT-1 audit-fix arc, Run-6)
    // =========================================================================
    // Writers must wait EXERCISE_WINDOW seconds after vault.expiry before
    // calling withdraw_post_settlement / auto_finalize_writers, unless the
    // vault never sold any options (total_options_sold == 0). This prevents
    // the writer-drains-before-holders-exercise race where holders' payouts
    // get capped to a vault that's already been emptied.
    #[msg(
        "Holder exercise window still open — writers must wait until \
         vault.expiry + EXERCISE_WINDOW before withdrawing"
    )]
    HolderExerciseWindowOpen,

    // =========================================================================
    // Zero-feed grief guard (HIGH-2 + HIGH-3 audit-fix arc, Run-7)
    // =========================================================================
    // Rejected at create_market, create_shared_vault, and migrate_pyth_feed.
    // The all-zeros feed_id is the default sentinel value of [u8; 32] — a
    // common admin fat-finger and the registration-name griefer's lowest-
    // friction lock. Real Pyth feed IDs are random 32-byte values and
    // never collide with this.
    #[msg("Pyth feed ID cannot be all zeros — register a real feed")]
    InvalidPythFeedId,

    // =========================================================================
    // VolOracle errors (Phase 2 Stage B)
    // =========================================================================
    // VolOracleNotInitialized is returned by realized_vol_annualized when
    // its caller passes an uninitialized account; Stage C's
    // create_shared_vault will surface this on the American branch.
    // VolOracleWarmup / VolOracleStale gate the read path.
    // VolOraclePushTooSoon / VolOraclePriceStale gate the push path.
    #[msg("VolOracle account not initialized for this asset")]
    VolOracleNotInitialized,

    #[msg("VolOracle in warmup — needs 168 samples (7 days) before reads are valid")]
    VolOracleWarmup,

    #[msg("VolOracle stale — most recent sample is older than 6 hours")]
    VolOracleStale,

    #[msg("VolOracle push too soon — must wait at least 55 minutes since last push")]
    VolOraclePushTooSoon,

    #[msg("Pyth price update for vol push is older than 60 seconds")]
    VolOraclePriceStale,

    #[msg("Pyth spot price for vol push is zero or negative")]
    VolOracleInvalidSpot,

    #[msg("VolOracle math error (sqrt domain, division-by-zero, or overflow)")]
    VolOracleMathError,

    // Phase 2 Stage C Pass 2 — American on-chain pricing.
    // Single wrapper for any BS-2002 internal error (InvalidSpot,
    // InvalidStrike, InvalidCarry, BoundaryOverflow, SolMath). The raw
    // variant is logged via msg! at the call site for diagnostics; the
    // 5 underlying variants are defensive on validated inputs and do not
    // warrant individual IDL surface area.
    #[msg("American BS-2002 pricing failed — see tx log for raw variant")]
    AmericanPricingFailed,

    // Phase 2 Stage C Pass 3 — get_option_price view.
    // The view instruction does not price European options on-chain; the
    // off-chain pricer (app/src/utils/blackScholes.ts) is the canonical
    // EUR source and avoids burning CU on a value the client already has.
    #[msg("get_option_price view does not support European style; use frontend pricer")]
    ViewNotSupportedForEuropean,

    // Phase 2 Stage D — American vaults feature gate.
    // Returned by the American arm of create_shared_vault and mint_from_vault
    // when feature_flags::AMERICAN_ENABLED is false (the default until Stage I).
    // European arms NEVER reference the flag, so this can only surface on
    // American vaults. Error code 6052.
    #[msg("American vaults are disabled — AMERICAN_ENABLED is false (flip at Stage I)")]
    AmericanVaultsDisabled,

    // Phase 2 Stage F — early American exercise.
    // Returned by exercise_american when the vault's exercise_style is
    // European (early exercise is an American-only feature). Error code 6053.
    #[msg("Option is not American-style — early exercise is not available")]
    NotAmericanOption,

    // =========================================================================
    // Exchange book errors (Phase 1 — RestingOrder limit book)
    // =========================================================================
    // WriterAsk is reserved for Phase 3 (writer limit asks, mint-on-fill from
    // personal collateral). post_order rejects it until then. Error code 6054.
    #[msg("Writer asks are not enabled yet — reserved for Phase 3")]
    WriterAsksDisabled,

    // =========================================================================
    // Exchange series errors (Phase 2 Pass A — canonical series mint)
    // =========================================================================
    // D12 — Phase 2 series mints are American-only; create_series rejects
    // European. European series ride the European arc. Error code 6055.
    #[msg("Series mints are American-only in Phase 2 (D12)")]
    SeriesMustBeAmerican,
}
