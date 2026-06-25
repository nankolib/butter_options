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

    // Phase 2 Pass B — vault peg fill (fill_vault_peg).
    // A vault reclaimed via the dead-feed hatch (reclaim_unsettled, Pass D)
    // sets `voided = true`; it pays holders nothing and writers pro-rata. No
    // fill path may treat `voided` as tradeable (spec v1.1 invariant #6).
    // fill_vault_peg gates on it forward-safely (nothing sets voided until
    // Pass D, but the block ships now). Error code 6056.
    #[msg("Vault has been voided via the dead-feed hatch — no peg fills")]
    VaultVoided,

    // =========================================================================
    // Dead-feed hatch errors (Phase 2 Pass D — reclaim_unsettled)
    // =========================================================================
    // The hatch is callable ONLY when settlement provably never happened: the
    // per-(asset, expiry) SettlementRecord PDA must NOT exist. If it does, the
    // feed produced a price and the normal settle/withdraw path applies — the
    // hatch reverts forever. Error code 6057.
    #[msg("Settlement record exists — vault is settleable, the dead-feed hatch is forbidden")]
    SettlementRecordExists,

    // The hatch only opens once the 7-day GRACE_WINDOW has elapsed past expiry,
    // giving the settle crank time to recover from transient feed-archive gaps
    // before collateral can be reclaimed. Error code 6058.
    #[msg("Dead-feed grace window has not elapsed yet")]
    GracePeriodNotElapsed,

    // =========================================================================
    // Trigger orders (Phase 4 — TP/SL + stop-entry)
    // =========================================================================
    // DECLARED in Pass 0; first USED by execute_trigger (Pass 1). The keeper's
    // off-chain price assertion is never trusted: execute_trigger re-reads a
    // fresh Pyth EMA in-tx and reverts this when the live EMA does not satisfy
    // the trigger's stored comparator against threshold_usdc. Error code 6059.
    #[msg("Trigger condition not met — live price does not satisfy the stored comparator")]
    TriggerConditionNotMet,

    // execute_trigger fire-time re-verification (Pass 1). The SELL burn source is
    // a STORED address; before the delegate-burn, execute_trigger re-asserts the
    // declared holder_option_ata's owner == trigger.owner and mint ==
    // trigger.option_mint. A mismatch (re-init'd account, hostile/stale address)
    // reverts this. The theft-vector guard. Error code 6060.
    #[msg("Trigger source ATA failed fire-time re-verification (owner or mint mismatch)")]
    TriggerSourceAtaInvalid,

    // =========================================================================
    // Switchboard On-Demand read arm (Stage 3 — oracle_source routing)
    // =========================================================================
    // The QuoteVerifier (queue + SlotHashes + Instructions sysvar + clock_slot +
    // max_age) failed to verify the ed25519-signed oracle quote: signature/
    // slothash mismatch, quote older than max_age slots, or no ED25519 ix at the
    // given index. Maps the crate's anyhow error to a stable Opta code (the crate
    // error carries no discriminant we can surface on-chain). Error code 6061.
    #[msg("Switchboard quote verification failed (signature, slothash, freshness, or missing ED25519 ix)")]
    SwitchboardVerifyFailed,

    // The verified quote contained no feed whose feed_id matches the market's
    // expected oracle id. INERT until Stage 3 routes a market to Switchboard.
    // Error code 6062.
    #[msg("Switchboard quote does not contain the expected feed_id")]
    SwitchboardFeedNotFound,

    // The matched feed reported fewer aggregating oracle samples than the
    // SB_MIN_ORACLE_SAMPLES_FLOOR floor — the Switchboard analog of Pyth's
    // confidence-width gate (a thin multi-oracle quote is rejected). Error code
    // 6063.
    #[msg("Switchboard feed has fewer oracle samples than the required floor")]
    SwitchboardInsufficientSamples,

    // =========================================================================
    // Oracle-source routing (Stage 3 wiring) — the match arm guards
    // =========================================================================
    // A Pyth-sourced market routed to the Pyth arm but the optional price_update
    // account was absent (None). The price update is required for Pyth markets;
    // only Switchboard markets omit it. Error code 6064.
    #[msg("Pyth market requires the price_update account, but it was not provided")]
    PriceUpdateMissing,

    // A Switchboard-sourced market routed to the SB arm but one or more of the
    // trailing SB accounts (queue / SlotHashes sysvar / Instructions sysvar) was
    // absent. All three are required when oracle_source == Switchboard. Error
    // code 6065.
    #[msg("Switchboard market requires the queue + SlotHashes + Instructions accounts")]
    SwitchboardAccountsMissing,

    // market.oracle_source held a value that is neither Pyth (0) nor Switchboard
    // (1). Unreachable for well-formed markets (create_market pins Pyth; the only
    // other writer is the migration zero-fill) — fail-closed guard. Error code 6066.
    #[msg("Unknown oracle_source value on the market")]
    InvalidOracleSource,

    // The SB arm scanned the Instructions sysvar and found no ED25519 precompile
    // instruction in the current transaction. The caller must prepend the
    // Switchboard ed25519 verify instruction. Error code 6067.
    #[msg("No ED25519 instruction found in the transaction for Switchboard verification")]
    NoEd25519Instruction,

    // A SB account whose address is fixed (the SlotHashes or Instructions sysvar)
    // did not match its canonical pubkey. Runtime-checked in the SB arm because a
    // struct-level address constraint would fire on the absent-optional Pyth path.
    // Error code 6068.
    #[msg("Switchboard sysvar account address mismatch (SlotHashes or Instructions)")]
    InvalidSwitchboardSysvar,

    // settle_expiry SB arm: the settlement window elapsed. Unlike Pyth (which
    // settles on a HISTORICAL at-expiry price and has a 30-day window to run),
    // Switchboard has no historical lookback (the ~512-slot SlotHashes wall), so
    // an SB market must be settled within SB_SETTLE_WINDOW_SECS (5 min) of expiry
    // while a fresh quote is still verifiable. Missing the window leaves no
    // SettlementRecord → the reclaim_unsettled 7-day hatch winds the vault down.
    // Error code 6069.
    #[msg("Switchboard settlement window elapsed — settle within 5 min of expiry or reclaim after grace")]
    SwitchboardSettleWindowElapsed,
}
