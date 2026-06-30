// =============================================================================
// instructions/reclaim_writer_ask_residual.rs — writer-ask backer claims their
// VOID-path residual (Phase 3 Slice D3)
// =============================================================================
//
// The void-path twin of withdraw_writer_ask_residual. After a dead-feed vault is
// wound down via `initialize_void` (which swept the canonical pot into vault_usdc,
// applied the D2a shares-unification merge, and flipped `voided`), each writer-ask
// backer claims their pro-rata of the merged residual — identical economics to the
// settled path, against the SAME unified (collateral_remaining, total_shares) the
// pool writers draw from via reclaim_unsettled. E is socialized by share exactly as
// on normal settle; no origin attribution.
//
// Differences from the settled residual (both encoded by the wrapper, not the
// shared core):
//   - Gate on `voided` (not is_settled). `require!(voided)` guarantees
//     initialize_void already ran (the sole, atomic voided-setter) → the merge is
//     committed before any claim. Defensive `!is_settled` (voided ⇏ settled).
//   - enforce_window = false: a voided vault pays holders NOTHING, so there is no
//     holder exercise window to respect; the 7-day GRACE_WINDOW already elapsed at
//     initialize_void.
//
// Pays from vault_usdc (swept in at init). PERMISSIONLESS, backer-pinned recipient,
// double-claim guarded (committed > 0, in the core). UNGATED — an exit/refund path,
// inert feature-free (no pot funded ⇒ swept == 0 ⇒ NothingToClaim).
// =============================================================================

use anchor_lang::prelude::*;
use anchor_spl::token::{Token, TokenAccount};

use crate::errors::OptaError;
use crate::instructions::withdraw_writer_ask_residual::writer_ask_residual_core;
use crate::state::*;

pub fn handle_reclaim_writer_ask_residual(ctx: Context<ReclaimWriterAskResidual>) -> Result<()> {
    let vault = &ctx.accounts.shared_vault;

    // ---- Void-path gate ---------------------------------------------------
    // `voided` is set ONLY by initialize_void, atomically with the merge, so this
    // guarantees the pot was swept + shares unified + collateral_remaining seeded
    // before any backer claim. There is no path to a claim against a
    // voided-but-unmerged vault.
    require!(vault.voided, OptaError::VaultNotVoided);
    // Defensive: a voided vault is never settled (settle_vault's !voided guard).
    require!(!vault.is_settled, OptaError::VaultAlreadySettled);

    // enforce_window = false: voided holders are paid nothing → no holder window.
    writer_ask_residual_core(
        &mut ctx.accounts.shared_vault,
        &mut ctx.accounts.writer_ask_position,
        &ctx.accounts.vault_usdc_account.to_account_info(),
        &ctx.accounts.writer_usdc_account.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        false,
    )
}

#[derive(Accounts)]
pub struct ReclaimWriterAskResidual<'info> {
    /// Permissionless caller (a cranker, or the backer). Payout is pinned to the
    /// backer's USDC account below.
    pub cranker: Signer<'info>,

    /// The voided writer-ask vault.
    #[account(mut)]
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// The backer's writer-ask position — zeroed (not closed) after the claim.
    /// Self-referential seeds pin it to its own (option_mint, backer); the vault
    /// constraint pins it to THIS vault.
    #[account(
        mut,
        seeds = [
            WRITER_ASK_POSITION_SEED,
            writer_ask_position.option_mint.as_ref(),
            writer_ask_position.backer.as_ref(),
        ],
        bump = writer_ask_position.bump,
        constraint = writer_ask_position.vault == shared_vault.key() @ OptaError::InvalidVaultMint,
    )]
    pub writer_ask_position: Box<Account<'info, WriterAskPosition>>,

    /// Vault's USDC token account — payout source (the pot was swept in at init).
    #[account(
        mut,
        constraint = vault_usdc_account.key() == shared_vault.vault_usdc_account,
    )]
    pub vault_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Backer's USDC token account — payout destination. Owner PINNED to the
    /// backer: a cranker cannot redirect the residual to itself.
    #[account(
        mut,
        constraint = writer_usdc_account.owner == writer_ask_position.backer @ OptaError::NotWriter,
        constraint = writer_usdc_account.mint == shared_vault.collateral_mint,
    )]
    pub writer_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Standard SPL Token program.
    pub token_program: Program<'info, Token>,
}
