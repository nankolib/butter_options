// =============================================================================
// instructions/withdraw_from_vault.rs — Writer withdraws uncommitted collateral
// =============================================================================
//
// Writers can withdraw their free collateral (not committed to active options)
// from the shared vault. Shares are redeemed proportionally.
//
// The key constraint: can't withdraw collateral backing active (minted but
// unsold or sold) options. Only "free" collateral can be withdrawn.
//
// USDC flow: vault_usdc_account → writer_usdc_account (signed by vault PDA)
// =============================================================================

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::OptaError;
use crate::events::VaultWithdrawn;
use crate::state::*;
use crate::utils::collateral::required_collateral_per_contract;
// Phase 2 Pass C (a): single-source-of-truth vault-level free-collateral helper
// (defined in fill_vault_peg). Dual gate so an LP can't withdraw peg-committed
// collateral.
use crate::instructions::fill_vault_peg::vault_free_collateral;

pub fn handle_withdraw_from_vault(
    ctx: Context<WithdrawFromVault>,
    shares_to_withdraw: u64,
) -> Result<()> {
    let vault = &ctx.accounts.shared_vault;
    let writer_pos = &ctx.accounts.writer_position;

    // Validation
    require!(writer_pos.owner == ctx.accounts.writer.key(), OptaError::NotWriter);
    require!(shares_to_withdraw > 0, OptaError::InvalidContractSize);
    require!(shares_to_withdraw <= writer_pos.shares, OptaError::InsufficientCollateral);
    require!(!vault.is_settled, OptaError::VaultAlreadySettled);
    // Pass D (invariant #6): a voided vault's collateral is reclaimed only via
    // reclaim_unsettled (the pro-rata hatch). Block this pre-settle share
    // withdrawal — it survives the is_settled gate (voided vaults stay
    // is_settled=false) and would double-pay against the hatch. No-op on
    // European vaults (voided is always false there).
    require!(!vault.voided, OptaError::VaultVoided);

    // FIX MEDIUM-01: Require all premium claimed before share withdrawal
    // This prevents premium loss from debt/share mismatch
    let total_earned = (writer_pos.shares as u128)
        .checked_mul(vault.premium_per_share_cumulative)
        .ok_or(OptaError::MathOverflow)?
        .checked_div(1_000_000_000_000u128) // SCALE = 1e12
        .ok_or(OptaError::MathOverflow)?;

    let earned_since_deposit = total_earned
        .checked_sub(writer_pos.premium_debt)
        .unwrap_or(0);

    let unclaimed = earned_since_deposit
        .saturating_sub(writer_pos.premium_claimed as u128) as u64;

    require!(unclaimed == 0, OptaError::ClaimPremiumFirst);

    // Calculate withdrawal amount from shares
    let withdrawal_amount = (shares_to_withdraw as u128)
        .checked_mul(vault.total_collateral as u128)
        .ok_or(OptaError::MathOverflow)?
        .checked_div(vault.total_shares as u128)
        .ok_or(OptaError::MathOverflow)? as u64;

    // Check that withdrawal doesn't breach committed collateral.
    // Symmetric 1× strike for both CALL and PUT — see utils/collateral.rs.
    //
    // Legacy vaults created under the previous 2× formula will have excess
    // collateral above the new 1× committed amount; this gate correctly
    // treats that excess as free (post-redeploy, legacy CALL writers may
    // withdraw the previously-locked half).
    let collateral_per_contract =
        required_collateral_per_contract(vault.strike_price, vault.option_type);
    let writer_total_collateral = (writer_pos.shares as u128)
        .checked_mul(vault.total_collateral as u128)
        .ok_or(OptaError::MathOverflow)?
        .checked_div(vault.total_shares as u128)
        .ok_or(OptaError::MathOverflow)? as u64;
    let writer_committed = writer_pos.options_minted
        .checked_mul(collateral_per_contract)
        .ok_or(OptaError::MathOverflow)?;
    let writer_free = writer_total_collateral
        .checked_sub(writer_committed)
        .ok_or(OptaError::MathOverflow)?;

    require!(withdrawal_amount <= writer_free, OptaError::CollateralCommitted);

    // =========================================================================
    // Phase 2 Pass C (a fix) — vault-level free-collateral gate, DUAL with the
    // per-writer gate above.
    //
    // The per-writer gate only stops an LP from withdrawing ANOTHER LP's stake;
    // it is BLIND to peg commitment (fill_vault_peg bumps
    // vault.total_options_minted, not any writer's options_minted). Without this,
    // a passive LP in a peg-backed vault could withdraw collateral the peg has
    // already sold contracts against, stranding holders at settlement. Both
    // gates must hold.
    //
    // American-only — EUR vaults can't have peg fills, so this is a no-op there
    // and the EUR arm stays byte-identical (no computation added). Reuses Pass
    // B's vault_free_collateral (single source of truth).
    //
    // First-exit asymmetry among LPs (an early withdrawer exits cleanly; a late
    // LP ends up backing the peg's live contracts until settlement) is inherent
    // to the pooled D6/D7 model already locked — accepted, not engineered around.
    // =========================================================================
    if vault.exercise_style == ExerciseStyle::American {
        let vault_free = vault_free_collateral(
            vault.total_collateral,
            vault.early_exercise_payout,
            vault.total_options_minted,
            vault.exercised_options,
            collateral_per_contract,
        )?;
        require!(
            (withdrawal_amount as u128) <= vault_free,
            OptaError::CollateralCommitted
        );
    }

    // Transfer USDC from vault to writer (signed by shared_vault PDA)
    let vault_key = ctx.accounts.shared_vault.key();
    let market_key = vault.market;
    let strike_bytes = vault.strike_price.to_le_bytes();
    let expiry_bytes = vault.expiry.to_le_bytes();
    let option_type_byte = [vault.option_type as u8];
    let vault_bump = [vault.bump];

    // Stage D: namespace prefix from the single-source-of-truth helper so the
    // signer matches American vaults too. European resolves to the identical
    // SHARED_VAULT_SEED bytes used before Stage D — zero EUR behavior change.
    let vault_seeds: &[&[u8]] = &[
        vault_namespace_seed(vault.exercise_style),
        market_key.as_ref(),
        &strike_bytes,
        &expiry_bytes,
        &option_type_byte,
        &vault_bump,
    ];
    let signer_seeds = &[vault_seeds];

    let transfer_ctx = CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        Transfer {
            from: ctx.accounts.vault_usdc_account.to_account_info(),
            to: ctx.accounts.writer_usdc_account.to_account_info(),
            authority: ctx.accounts.shared_vault.to_account_info(),
        },
        signer_seeds,
    );
    token::transfer(transfer_ctx, withdrawal_amount)?;

    // Update state
    let writer_key = ctx.accounts.writer.key();
    let cumulative = ctx.accounts.shared_vault.premium_per_share_cumulative;

    let writer_pos = &mut ctx.accounts.writer_position;
    writer_pos.shares = writer_pos.shares
        .checked_sub(shares_to_withdraw)
        .ok_or(OptaError::MathOverflow)?;
    writer_pos.deposited_collateral = writer_pos.deposited_collateral
        .saturating_sub(withdrawal_amount);

    // FIX: Reset premium accounting after share reduction.
    // The writer was forced to claim all premium before withdrawal (ClaimPremiumFirst).
    // Now reset debt to current cumulative baseline for remaining shares,
    // and zero claimed counter, so future premium accrues correctly.
    writer_pos.premium_debt = (writer_pos.shares as u128)
        .checked_mul(cumulative)
        .ok_or(OptaError::MathOverflow)?
        .checked_div(1_000_000_000_000u128)
        .ok_or(OptaError::MathOverflow)?;
    writer_pos.premium_claimed = 0;

    let vault = &mut ctx.accounts.shared_vault;
    vault.total_collateral = vault.total_collateral
        .checked_sub(withdrawal_amount)
        .ok_or(OptaError::MathOverflow)?;
    vault.total_shares = vault.total_shares
        .checked_sub(shares_to_withdraw)
        .ok_or(OptaError::MathOverflow)?;

    emit!(VaultWithdrawn {
        vault: vault_key,
        writer: writer_key,
        amount: withdrawal_amount,
        shares: shares_to_withdraw,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawFromVault<'info> {
    /// The writer withdrawing collateral.
    #[account(mut)]
    pub writer: Signer<'info>,

    /// The shared vault.
    #[account(mut)]
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// Writer's position in the vault.
    #[account(
        mut,
        seeds = [WRITER_POSITION_SEED, shared_vault.key().as_ref(), writer.key().as_ref()],
        bump = writer_position.bump,
    )]
    pub writer_position: Box<Account<'info, WriterPosition>>,

    /// Vault's USDC token account — source of withdrawal.
    #[account(
        mut,
        constraint = vault_usdc_account.key() == shared_vault.vault_usdc_account,
    )]
    pub vault_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Writer's USDC token account — destination.
    #[account(
        mut,
        constraint = writer_usdc_account.owner == writer.key(),
        constraint = writer_usdc_account.mint == shared_vault.collateral_mint,
    )]
    pub writer_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Protocol state — for USDC mint validation.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Standard SPL Token program.
    pub token_program: Program<'info, Token>,
}
