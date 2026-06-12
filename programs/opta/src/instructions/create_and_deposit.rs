// =============================================================================
// instructions/create_and_deposit.rs — Atomic write merge (Phase 2 Pass C, D9)
// =============================================================================
//
// Spec: .context/plans/opta-exchange-spec.md §7.3.3 + §7.6 + D9. Collapses the
// 3-step write (create_shared_vault → deposit_to_vault → mint_from_vault) by
// FUSING create + deposit into ONE tx. The heavy mint leaves the write path
// entirely (D8/D9 — minting is now mint-on-fill via the peg / writer asks), so
// this handler carries NO Token-2022 mint creation and NO BS-2002: ~light CU,
// well under the 1.4M ceiling for BOTH styles. The partial-flow stranded-
// collateral hazard dies structurally — one tx is all-or-nothing.
//
// "vault init (if absent)" — `init_if_needed` on shared_vault / vault_usdc /
// writer_position: the first caller for a spec creates + deposits; a subsequent
// caller into the SAME spec just deposits. Fresh is detected by
// `created_at == 0` (a real vault always stamps a positive unix timestamp);
// identity + config fields are written ONLY on fresh and NEVER rewritten on an
// existing vault (ruling c1). The 5 core spec dimensions (namespace/
// exercise_style, market, strike, expiry, option_type) are PDA-seed-encoded, so
// a params-vs-existing-vault mismatch on them is structurally impossible (ruling
// c2); the 3 non-seed params (vault_type, carry_rate_bps, collateral_mint) are
// creation-only — honored on fresh, ignored on existing (collateral_mint is
// independently pinned to protocol_state.usdc_mint regardless).
//
// ADDITIVE — create_shared_vault + deposit_to_vault stay live for legacy callers
// (ruling d). European byte-identical: a fresh EUR create_and_deposit yields the
// same vault + position state as the sequential pair (proven field-by-field in
// the bankrun suite). American creation keeps create_shared_vault's
// AMERICAN_ENABLED gate (dark until Stage I).
//
// Note on init-timing constraints: writer_usdc is pinned to `usdc_mint` (not the
// vault's stored collateral_mint, which is zero at constraint-eval time on a
// fresh init), and vault_usdc is pinned by its PDA seeds (not the vault's stored
// vault_usdc_account field, same reason).
// =============================================================================

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Mint as SplMint, Transfer};

use crate::errors::OptaError;
use crate::events::{VaultCreated, VaultDeposited};
use crate::feature_flags::AMERICAN_ENABLED;
use crate::state::*;
use crate::utils::epoch::is_valid_epoch_expiry;

/// Minimum time before expiry for custom vaults (mirrors create_shared_vault).
const MIN_CUSTOM_EXPIRY_BUFFER: i64 = 5;

/// Reward-per-share scale (mirrors deposit_to_vault).
const PREMIUM_SCALE: u128 = 1_000_000_000_000u128;

#[allow(clippy::too_many_arguments)]
pub fn handle_create_and_deposit(
    ctx: Context<CreateAndDeposit>,
    strike_price: u64,
    expiry: i64,
    option_type: OptionType,
    vault_type: VaultType,
    collateral_mint: Pubkey,
    carry_rate_bps: i32,
    exercise_style: ExerciseStyle,
    amount: u64,
) -> Result<()> {
    // ---- Always-on validations (cheap; hold on fresh + existing) ----------
    // American gate — same as create_shared_vault. EUR never references the flag
    // (byte-identical). Pre-flip no American vault can exist, so this only ever
    // fires on a fresh American create attempt.
    if exercise_style == ExerciseStyle::American {
        require!(AMERICAN_ENABLED, OptaError::AmericanVaultsDisabled);
    }
    require!(
        collateral_mint == ctx.accounts.protocol_state.usdc_mint,
        OptaError::UnsupportedCollateral
    );
    require!(
        collateral_mint == ctx.accounts.usdc_mint.key(),
        OptaError::UnsupportedCollateral
    );
    require!(amount > 0, OptaError::InvalidPremium);

    let clock = Clock::get()?;

    // ---- Fresh detection — a real vault always stamps created_at > 0 ------
    let is_fresh = ctx.accounts.shared_vault.created_at == 0;

    if is_fresh {
        // create-portion validations (verbatim from create_shared_vault), fresh-only.
        require!(
            ctx.accounts.market.pyth_feed_id != [0u8; 32],
            OptaError::InvalidPythFeedId
        );
        require!(strike_price > 0, OptaError::InvalidStrikePrice);
        require!(expiry > clock.unix_timestamp, OptaError::ExpiryInPast);
        match vault_type {
            VaultType::Epoch => {
                let epoch_config = ctx
                    .accounts
                    .epoch_config
                    .as_ref()
                    .ok_or(OptaError::InvalidEpochExpiry)?;
                require!(
                    is_valid_epoch_expiry(expiry, epoch_config),
                    OptaError::InvalidEpochExpiry
                );
                let min_expiry = clock.unix_timestamp
                    + (epoch_config.min_epoch_duration_days as i64) * 86400;
                require!(expiry >= min_expiry, OptaError::InvalidEpochExpiry);
            }
            VaultType::Custom => {
                require!(
                    expiry >= clock.unix_timestamp + MIN_CUSTOM_EXPIRY_BUFFER,
                    OptaError::ExpiryInPast
                );
            }
        }

        // Set identity + config fields EXACTLY as create_shared_vault does
        // (trailing Stage-F / Pass-A fields are left to init-zeroing, matching
        // create_shared_vault → byte-identical fresh state).
        let vault = &mut ctx.accounts.shared_vault;
        vault.market = ctx.accounts.market.key();
        vault.option_type = option_type;
        vault.strike_price = strike_price;
        vault.expiry = expiry;
        vault.vault_type = vault_type;
        vault.total_collateral = 0;
        vault.total_shares = 0;
        vault.vault_usdc_account = ctx.accounts.vault_usdc_account.key();
        vault.collateral_mint = collateral_mint;
        vault.total_options_minted = 0;
        vault.total_options_sold = 0;
        vault.net_premium_collected = 0;
        vault.premium_per_share_cumulative = 0;
        vault.is_settled = false;
        vault.settlement_price = 0;
        vault.collateral_remaining = 0;
        vault.creator = ctx.accounts.writer.key();
        vault.created_at = clock.unix_timestamp;
        vault.bump = ctx.bumps.shared_vault;
        vault.carry_rate_bps = carry_rate_bps;
        vault.exercise_style = exercise_style;

        emit!(VaultCreated {
            vault: ctx.accounts.shared_vault.key(),
            market: ctx.accounts.market.key(),
            vault_type: vault_type as u8,
            strike_price,
            expiry,
            option_type: option_type as u8,
            creator: ctx.accounts.writer.key(),
        });
    }

    // ---- Deposit guards (always; trivially true on fresh) -----------------
    {
        let vault = &ctx.accounts.shared_vault;
        require!(!vault.is_settled, OptaError::VaultAlreadySettled);
        require!(vault.expiry > clock.unix_timestamp, OptaError::VaultExpired);
        // Custom vault gate: only the creator can deposit (mirrors deposit_to_vault).
        if vault.vault_type == VaultType::Custom && vault.total_shares > 0 {
            require!(
                ctx.accounts.writer.key() == vault.creator,
                OptaError::CustomVaultSingleWriter
            );
        }
    }

    // ---- Deposit logic (verbatim from deposit_to_vault) -------------------
    let (total_shares, total_collateral, cumulative) = {
        let v = &ctx.accounts.shared_vault;
        (v.total_shares, v.total_collateral, v.premium_per_share_cumulative)
    };

    let shares = if total_shares == 0 {
        amount
    } else {
        (amount as u128)
            .checked_mul(total_shares as u128)
            .ok_or(OptaError::MathOverflow)?
            .checked_div(total_collateral as u128)
            .ok_or(OptaError::MathOverflow)? as u64
    };
    require!(shares > 0, OptaError::MathOverflow);

    let transfer_ctx = CpiContext::new(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.writer_usdc_account.to_account_info(),
            to: ctx.accounts.vault_usdc_account.to_account_info(),
            authority: ctx.accounts.writer.to_account_info(),
        },
    );
    token::transfer(transfer_ctx, amount)?;

    let vault_key = ctx.accounts.shared_vault.key();
    let writer_key = ctx.accounts.writer.key();

    let position = &mut ctx.accounts.writer_position;
    let is_new = position.shares == 0 && position.deposited_collateral == 0;
    if is_new {
        position.owner = writer_key;
        position.vault = vault_key;
        position.premium_claimed = 0;
        position.premium_debt = 0;
        position.options_minted = 0;
        position.options_sold = 0;
        position.deposited_at = clock.unix_timestamp;
        position.bump = ctx.bumps.writer_position;
    }

    let additional_debt = (shares as u128)
        .checked_mul(cumulative)
        .ok_or(OptaError::MathOverflow)?
        .checked_div(PREMIUM_SCALE)
        .ok_or(OptaError::MathOverflow)?;
    position.premium_debt = position
        .premium_debt
        .checked_add(additional_debt)
        .ok_or(OptaError::MathOverflow)?;
    position.shares = position.shares.checked_add(shares).ok_or(OptaError::MathOverflow)?;
    position.deposited_collateral = position
        .deposited_collateral
        .checked_add(amount)
        .ok_or(OptaError::MathOverflow)?;

    let vault = &mut ctx.accounts.shared_vault;
    vault.total_collateral = vault.total_collateral.checked_add(amount).ok_or(OptaError::MathOverflow)?;
    vault.total_shares = vault.total_shares.checked_add(shares).ok_or(OptaError::MathOverflow)?;
    let new_total_collateral = vault.total_collateral;

    emit!(VaultDeposited {
        vault: vault_key,
        writer: writer_key,
        amount,
        shares,
        total_collateral: new_total_collateral,
    });

    Ok(())
}

// =============================================================================
// Account validation — union of CreateSharedVault + DepositToVault (~11)
// =============================================================================

#[derive(Accounts)]
#[instruction(strike_price: u64, expiry: i64, option_type: OptionType, vault_type: VaultType, collateral_mint: Pubkey, carry_rate_bps: i32, exercise_style: ExerciseStyle, amount: u64)]
pub struct CreateAndDeposit<'info> {
    /// The depositor — also the creator on a fresh vault. Pays all rent.
    #[account(mut)]
    pub writer: Signer<'info>,

    /// The OptionsMarket this vault is for.
    pub market: Account<'info, OptionsMarket>,

    /// The SharedVault PDA — unique per (namespace/exercise_style, market,
    /// strike, expiry, option_type). `init_if_needed`: created on the first
    /// caller, reused on subsequent deposits into the same spec.
    #[account(
        init_if_needed,
        seeds = [
            match exercise_style {
                ExerciseStyle::European => SHARED_VAULT_SEED,
                ExerciseStyle::American => SHARED_VAULT_AMERICAN_SEED,
            },
            market.key().as_ref(),
            &strike_price.to_le_bytes(),
            &expiry.to_le_bytes(),
            &[option_type as u8],
        ],
        bump,
        payer = writer,
        space = 8 + SharedVault::INIT_SPACE,
    )]
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// The vault's USDC token account (authority = shared_vault PDA). Pinned by
    /// its own PDA seeds — NOT by shared_vault.vault_usdc_account, which is zero
    /// at constraint-eval time on a fresh init.
    #[account(
        init_if_needed,
        seeds = [VAULT_USDC_SEED, shared_vault.key().as_ref()],
        bump,
        payer = writer,
        token::mint = usdc_mint,
        token::authority = shared_vault,
    )]
    pub vault_usdc_account: Box<Account<'info, TokenAccount>>,

    /// USDC mint — pinned to the protocol's stored USDC mint.
    #[account(constraint = usdc_mint.key() == protocol_state.usdc_mint)]
    pub usdc_mint: Account<'info, SplMint>,

    /// Writer's position — created on first deposit, accumulated thereafter.
    #[account(
        init_if_needed,
        seeds = [WRITER_POSITION_SEED, shared_vault.key().as_ref(), writer.key().as_ref()],
        bump,
        payer = writer,
        space = 8 + WriterPosition::INIT_SPACE,
    )]
    pub writer_position: Box<Account<'info, WriterPosition>>,

    /// Writer's USDC account — source of collateral. Pinned to `usdc_mint`
    /// (not the vault's stored collateral_mint, which is zero on a fresh init).
    #[account(
        mut,
        constraint = writer_usdc_account.owner == writer.key(),
        constraint = writer_usdc_account.mint == usdc_mint.key(),
    )]
    pub writer_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Protocol state — USDC mint validation.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Epoch config — required for Epoch vaults on fresh create, else optional.
    pub epoch_config: Option<Account<'info, EpochConfig>>,

    /// Standard SPL Token program.
    pub token_program: Program<'info, Token>,

    pub system_program: Program<'info, System>,
}
