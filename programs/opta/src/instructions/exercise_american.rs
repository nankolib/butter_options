// =============================================================================
// instructions/exercise_american.rs — early (pre-expiry) American exercise
// =============================================================================
//
// The HOLDER of an American option burns N tokens BEFORE expiry and receives
// cash-settled capped intrinsic value in USDC from the vault. This is the
// defining American feature (European has no early exercise).
//
// Money flow (N contracts, capped intrinsic `i` per contract, P = N × i):
//   1. Gates (American + AMERICAN_ENABLED + pre-expiry + balance).
//   2. Read spot from a FRESH PriceUpdateV2 supplied by the exerciser
//      (atomic post+consume, same validation pattern as settle_expiry — read
//      the EMA field), normalized to 6-dec USDC.
//   3. i = exercise_capped_intrinsic(option_type, spot, strike, collateral_per_token)
//      (the (f) lock: CALL/PUT capped at 1× collateral). require!(i > 0).
//   4. Burn N tokens — HOLDER signs (same as exercise_from_vault, NOT delegate).
//   5. Transfer P USDC vault → holder, vault PDA signs via vault_namespace_seed.
//   6. vault.exercised_options += N; vault.early_exercise_payout += P.
//
// Deliberately does NOT mutate total_collateral / total_options_sold /
// collateral_remaining — Stage G's settlement math consumes the two counters
// above to net early exercises without double-paying. (Stage F owns the entire
// HOLDER-side exercise surface; the writer-side seed sweep + partial-supply
// settlement handshake is Stage G.)
//
// Gated off until Stage I via AMERICAN_ENABLED (the American arm reverts
// AmericanVaultsDisabled when the flag is false — the default).
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_spl::token_2022::Token2022;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::errors::OptaError;
use crate::events::VaultExercised;
use crate::feature_flags::AMERICAN_ENABLED;
use crate::state::*;
use crate::utils::collateral::required_collateral_per_contract;
use crate::utils::exercise_intrinsic::exercise_capped_intrinsic;
use crate::utils::price_oracle::pyth_current_spot_usdc;

/// Max age of the supplied price update at exercise time, in seconds: the
/// price's `publish_time` must be within 60s of the on-chain clock (now). Early
/// exercise needs a CURRENT price; a stale/historical print would let a holder
/// cherry-pick a favorable spot (bounded by the per-contract cap, but real
/// value extraction). 60s reuses settle_expiry's EXPIRY_WINDOW_SECS magnitude.
///
/// Stage G Pass 2 tightened this from the loose 30d PYTH_MAX_AGE backstop that
/// Stage F shipped (decision (a) flip-blocker for the Stage I AMERICAN_ENABLED
/// flip). Deterministically testable only under bankrun setClock (a static
/// fixture's publish_time can't be aligned to a moving validator wall-clock).
const PRICE_MAX_AGE_SECS: i64 = 60;

/// Max Pyth EMA confidence width tolerated, in bps of the EMA price. Same
/// value + check as settle_expiry::MAX_CONF_BPS (CRIT-2): reject wide-conf
/// prints that surface during oracle stress.
const MAX_CONF_BPS: u16 = 200;

pub fn handle_exercise_american(
    ctx: Context<ExerciseAmerican>,
    quantity: u64,
) -> Result<()> {
    // ----- Snapshot vault fields (immutable read) ---------------------------
    let vault = &ctx.accounts.shared_vault;
    let exercise_style = vault.exercise_style;
    let option_type = vault.option_type;
    let strike_price = vault.strike_price;
    let expiry = vault.expiry;
    let market_key = vault.market;
    let vault_bump = vault.bump;

    // ----- Gates (in spec order) --------------------------------------------
    // 1. American feature gate (default-off until Stage I). The European arm
    //    never reaches this instruction (gate #2), so EUR is unaffected.
    require!(AMERICAN_ENABLED, OptaError::AmericanVaultsDisabled);

    // 2. American-only: early exercise is not a European feature.
    require!(
        exercise_style == ExerciseStyle::American,
        OptaError::NotAmericanOption
    );

    // 3. Pre-expiry only. At/after expiry holders route through settlement
    //    (settle_vault → exercise_from_vault / auto_finalize_holders).
    let clock = Clock::get()?;
    require!(clock.unix_timestamp < expiry, OptaError::OptionExpired);

    // 4. Quantity + holder balance.
    require!(quantity > 0, OptaError::InvalidContractSize);
    let holder_balance = {
        let data = ctx.accounts.holder_option_account.try_borrow_data()?;
        require!(data.len() >= 72, OptaError::InsufficientOptionTokens);
        u64::from_le_bytes(
            data[64..72]
                .try_into()
                .map_err(|_| OptaError::MathOverflow)?,
        )
    };
    require!(quantity <= holder_balance, OptaError::InsufficientOptionTokens);

    // ----- Read + normalize spot from the fresh PriceUpdateV2 ---------------
    // Full validate (verification + feed_id + confidence + tight single-sided
    // 60s freshness) + EMA→USDC normalization now lives in the source-routed
    // price-oracle abstraction (Stage 1). Pyth is the sole implementer until
    // the Switchboard arm slots in at Stage 3; behavior, error codes, and the
    // EMA read are identical to the prior inline block.
    let spot_6dec = pyth_current_spot_usdc(
        &ctx.accounts.price_update,
        ctx.accounts.market.pyth_feed_id,
        clock.unix_timestamp,
        PRICE_MAX_AGE_SECS,
        MAX_CONF_BPS,
    )?;

    // ----- Capped intrinsic (the (f) lock) ----------------------------------
    let collateral_per_token = required_collateral_per_contract(strike_price, option_type);
    let intrinsic_per_contract =
        exercise_capped_intrinsic(option_type, spot_6dec, strike_price, collateral_per_token);
    require!(intrinsic_per_contract > 0, OptaError::OptionNotInTheMoney);

    let total_payout = quantity
        .checked_mul(intrinsic_per_contract)
        .ok_or(OptaError::MathOverflow)?;

    // ----- Burn N tokens — HOLDER signs (same as exercise_from_vault) -------
    invoke(
        &spl_token_2022::instruction::burn(
            &ctx.accounts.token_2022_program.key(),
            ctx.accounts.holder_option_account.key,
            ctx.accounts.option_mint.key,
            ctx.accounts.holder.key,
            &[],
            quantity,
        )?,
        &[
            ctx.accounts.holder_option_account.to_account_info(),
            ctx.accounts.option_mint.to_account_info(),
            ctx.accounts.holder.to_account_info(),
        ],
    )?;

    // ----- Transfer USDC vault → holder — vault PDA signs via the namespace
    //       helper. FIRST payout handler to route through vault_namespace_seed
    //       (Stage D); MUST NOT hardcode SHARED_VAULT_SEED — the American
    //       vault PDA is derived from the American prefix.
    let ns = vault_namespace_seed(exercise_style);
    let strike_bytes = strike_price.to_le_bytes();
    let expiry_bytes = expiry.to_le_bytes();
    let option_type_byte = [option_type as u8];
    let vault_bump_arr = [vault_bump];
    let vault_seeds: &[&[u8]] = &[
        ns,
        market_key.as_ref(),
        &strike_bytes,
        &expiry_bytes,
        &option_type_byte,
        &vault_bump_arr,
    ];
    let signer_seeds = &[vault_seeds];

    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.vault_usdc_account.to_account_info(),
            to: ctx.accounts.holder_usdc_account.to_account_info(),
            authority: ctx.accounts.shared_vault.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(transfer_ctx, total_payout)?;

    // ----- Accounting: increment the two Stage F counters ONLY --------------
    let vault_key = ctx.accounts.shared_vault.key();
    let holder_key = ctx.accounts.holder.key();

    let vault = &mut ctx.accounts.shared_vault;
    vault.exercised_options = vault
        .exercised_options
        .checked_add(quantity)
        .ok_or(OptaError::MathOverflow)?;
    vault.early_exercise_payout = vault
        .early_exercise_payout
        .checked_add(total_payout)
        .ok_or(OptaError::MathOverflow)?;

    emit!(VaultExercised {
        vault: vault_key,
        holder: holder_key,
        quantity,
        payout: total_payout,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct ExerciseAmerican<'info> {
    /// The option token holder exercising early.
    #[account(mut)]
    pub holder: Signer<'info>,

    /// The (unsettled, pre-expiry) American shared vault.
    #[account(mut)]
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// The vault's market — provides the canonical `pyth_feed_id` the supplied
    /// price update is validated against.
    #[account(constraint = market.key() == shared_vault.market)]
    pub market: Account<'info, OptionsMarket>,

    /// Fresh PriceUpdateV2 from the Pyth Receiver (exerciser posts it in the
    /// same tx). Validated for Full verification + feed_id + confidence +
    /// freshness in the handler.
    pub price_update: Account<'info, PriceUpdateV2>,

    /// Validates option_mint belongs to this vault (same guard as
    /// exercise_from_vault).
    #[account(
        constraint = vault_mint_record.vault == shared_vault.key() @ OptaError::InvalidVaultMint,
        constraint = vault_mint_record.option_mint == option_mint.key() @ OptaError::InvalidVaultMint,
    )]
    pub vault_mint_record: Account<'info, VaultMint>,

    /// The Token-2022 option mint.
    /// CHECK: Validated by the Token-2022 burn instruction + vault_mint_record.
    #[account(mut)]
    pub option_mint: UncheckedAccount<'info>,

    /// Holder's option token account (Token-2022).
    /// CHECK: Validated by the Token-2022 burn instruction (mint + owner).
    #[account(mut)]
    pub holder_option_account: UncheckedAccount<'info>,

    /// Vault's USDC account — payout source.
    #[account(
        mut,
        constraint = vault_usdc_account.key() == shared_vault.vault_usdc_account,
    )]
    pub vault_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Holder's USDC account — receives the cash-settled payout.
    #[account(
        mut,
        constraint = holder_usdc_account.owner == holder.key(),
        constraint = holder_usdc_account.mint == shared_vault.collateral_mint,
    )]
    pub holder_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Token-2022 program — for burning option tokens.
    pub token_2022_program: Program<'info, Token2022>,

    /// Standard SPL Token program — for the USDC transfer.
    pub token_program: Program<'info, Token>,
}
