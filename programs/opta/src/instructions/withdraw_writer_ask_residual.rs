// =============================================================================
// instructions/withdraw_writer_ask_residual.rs — writer-ask backer claims their
// post-settlement residual (Phase 3 Slice D2a)
// =============================================================================
//
// The PURE residual-claim handler for a writer-ask backer (the supply-side
// analog of withdraw_post_settlement for pool writers). After a writer-ask vault
// settles (Slice D1 swept the pot into the merged collateral and Slice D2a folded
// the swept collateral into `total_shares` as `writer_ask_equiv_shares`), each
// backer claims their pro-rata of the residual:
//
//   equiv_shares = collateral_committed × writer_ask_equiv_shares / swept   (floor)
//   payout       = equiv_shares × collateral_remaining / total_shares       (floor)
//
// against the SAME jointly-decremented (collateral_remaining, total_shares) the
// pool writers draw from. Conservation: payout = ⌊w·CR/T⌋ with w ≤ T ⇒ payout ≤ CR;
// the per-claim floor loss (< 1) stays in collateral_remaining; Σ payouts ≤ CR₀
// under ANY interleaving of pool-writer and writer-ask claims (the single-bucket
// telescoping proof, unchanged).
//
// PURE: pay → decrement (collateral_remaining, total_shares) → zero the position.
// NO close logic — a fully-drained writer-ask vault's USDC is reclaimed by the
// separate `close_settled_writer_ask_vault` (keyed on total_shares == 0). This
// handler never closes the position account either: it zeroes
// collateral_committed / contracts_written (the double-claim guard) and leaves the
// rent in place (a backer may hold positions across several series; rent cleanup
// is out of scope here).
//
// PERMISSIONLESS, recipient-pinned: any signer (a cranker) may call on a backer's
// behalf, but the USDC destination is pinned to `position.backer` — funds can only
// go to the backer, never the caller.
//
// HOLDERS-FIRST (CRIT-1 mirror): a writer-ask vault by construction minted
// fungible series contracts to takers (swept > 0), so ITM holders may still need
// to exercise from the merged collateral. This handler enforces the SAME
// `expiry + EXERCISE_WINDOW` wait that gates withdraw_post_settlement, so a backer
// cannot drain collateral_remaining before holders have their exercise window.
// Note total_options_sold counts only POOL sales (Slice B isolation — fills never
// bump it), so the wait is gated on swept > 0, not on total_options_sold.
//
// UNGATED by WRITER_ASKS_ENABLED / AMERICAN_ENABLED — an exit/refund path, like
// the Slice C cancel/sweep and reclaim_unsettled. In a feature-free production
// build no pot is ever funded (fill_writer_ask reverts 6054), so every settled
// vault has swept == 0 and this handler reverts NothingToClaim — present but inert.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::OptaError;
use crate::events::WriterAskResidualWithdrawn;
use crate::state::*;

pub fn handle_withdraw_writer_ask_residual(ctx: Context<WithdrawWriterAskResidual>) -> Result<()> {
    let vault = &ctx.accounts.shared_vault;

    // ---- Settle-path gate -------------------------------------------------
    require!(vault.is_settled, OptaError::VaultNotSettled);
    // A voided vault (dead-feed hatch) pays holders nothing and unwinds through
    // the void path (reclaim_writer_ask_residual, D3). The settled residual is the
    // is_settled path only. Never treat voided as settled (invariant #6).
    require!(!vault.voided, OptaError::VaultVoided);

    // enforce_window = true: settled writer-ask-minted holders may still exercise
    // from the merged collateral, so backers wait the 24h window (CRIT-1).
    writer_ask_residual_core(
        &mut ctx.accounts.shared_vault,
        &mut ctx.accounts.writer_ask_position,
        &ctx.accounts.vault_usdc_account.to_account_info(),
        &ctx.accounts.writer_usdc_account.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        true,
    )
}

// =============================================================================
// writer_ask_residual_core — shared backer residual economics (Phase 3 Slice D3)
// =============================================================================
//
// Single source of truth for a writer-ask backer's pro-rata residual claim,
// shared by the SETTLED path (withdraw_writer_ask_residual, enforce_window =
// true) and the VOID path (reclaim_writer_ask_residual, enforce_window = false —
// voided holders are paid nothing, so there is no holder window to respect; the
// 7-day GRACE_WINDOW already elapsed at initialize_void). Both call sites pay from
// `vault_usdc` (Slice D1 swept the pot in on settle; D3's initialize_void swept it
// in on void) against the unified (collateral_remaining, total_shares). Pure: pay
// → decrement → zero the position. The is_settled-vs-voided gate + the
// recipient/seeds pins live in each WRAPPER's context, not here.
//
// Extracted VERBATIM from the D2a body — the settled wrapper is byte-identical
// (the D2a residual suite is the purity proof: it must pass unchanged).
pub fn writer_ask_residual_core<'info>(
    vault: &mut Account<'info, SharedVault>,
    position: &mut Account<'info, WriterAskPosition>,
    vault_usdc: &AccountInfo<'info>,
    writer_usdc: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    enforce_window: bool,
) -> Result<()> {
    let swept = vault.writer_ask_collateral_swept;
    // Not a writer-ask-bearing vault (or the no-pot path) → nothing here.
    require!(swept > 0, OptaError::NothingToClaim);

    let committed = position.collateral_committed;
    // Double-claim guard: a claimed position is zeroed below; a second call reverts.
    require!(committed > 0, OptaError::NothingToClaim);

    if enforce_window {
        // Holders-first (settled path): writer-ask-minted holders may still
        // exercise the merged collateral, so backers wait the 24h post-expiry
        // window, exactly like pool writers in withdraw_post_settlement (CRIT-1).
        let clock = Clock::get()?;
        let window_end = vault
            .expiry
            .checked_add(EXERCISE_WINDOW)
            .ok_or(OptaError::MathOverflow)?;
        require!(
            clock.unix_timestamp >= window_end,
            OptaError::HolderExerciseWindowOpen
        );
    }

    // ---- Size this backer's claim against the unified denominator ----------
    // equiv_shares = committed × writer_ask_equiv_shares / swept   (floor)
    let equiv_shares: u64 = ((committed as u128)
        .checked_mul(vault.writer_ask_equiv_shares as u128)
        .ok_or(OptaError::MathOverflow)?
        .checked_div(swept as u128)
        .ok_or(OptaError::MathOverflow)?) as u64;

    // payout = equiv_shares × collateral_remaining / total_shares   (floor)
    // When equiv_shares > 0 this position's shares are still in total_shares
    // (unclaimed), so total_shares ≥ equiv_shares > 0 — the division is safe.
    // equiv_shares == 0 (floor-dust position) → payout 0 with no division.
    let payout: u64 = if equiv_shares == 0 {
        0
    } else {
        ((equiv_shares as u128)
            .checked_mul(vault.collateral_remaining as u128)
            .ok_or(OptaError::MathOverflow)?
            .checked_div(vault.total_shares as u128)
            .ok_or(OptaError::MathOverflow)?) as u64
    };

    // ---- Transfer payout: vault_usdc → backer (vault PDA signs) -------------
    let vault_key = vault.key();
    let backer = position.backer;
    let option_mint = position.option_mint;

    let market_key = vault.market;
    let strike_bytes = vault.strike_price.to_le_bytes();
    let expiry_bytes = vault.expiry.to_le_bytes();
    let option_type_byte = [vault.option_type as u8];
    let vault_bump = [vault.bump];
    // Single-source-of-truth namespace prefix (writer-ask vaults are American →
    // the American-prefix PDA). Hardcoding SHARED_VAULT_SEED would mis-derive the
    // signer and fail the CPI (the Stage D bug).
    let vault_seeds: &[&[u8]] = &[
        vault_namespace_seed(vault.exercise_style),
        market_key.as_ref(),
        &strike_bytes,
        &expiry_bytes,
        &option_type_byte,
        &vault_bump,
    ];
    let signer_seeds = &[vault_seeds];

    if payout > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                token_program.clone(),
                Transfer {
                    from: vault_usdc.clone(),
                    to: writer_usdc.clone(),
                    authority: vault.to_account_info(),
                },
                signer_seeds,
            ),
            payout,
        )?;
    }

    // ---- Decrement the shared denominator + zero the position --------------
    // collateral_remaining and total_shares are the SAME values the pool path
    // decrements; payout ≤ collateral_remaining and equiv_shares ≤ total_shares,
    // so both checked_subs hold. total_collateral is NOT touched: the swept
    // writer-ask collateral was never added to total_collateral (Slice B
    // isolation) — it lives only in collateral_remaining.
    position.collateral_committed = 0;
    position.contracts_written = 0;

    vault.collateral_remaining = vault
        .collateral_remaining
        .checked_sub(payout)
        .ok_or(OptaError::MathOverflow)?;
    vault.total_shares = vault
        .total_shares
        .checked_sub(equiv_shares)
        .ok_or(OptaError::MathOverflow)?;

    emit!(WriterAskResidualWithdrawn {
        vault: vault_key,
        backer,
        option_mint,
        equiv_shares,
        payout,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct WithdrawWriterAskResidual<'info> {
    /// Permissionless caller (a cranker, or the backer). Pays tx fee only — the
    /// payout is pinned to the backer's USDC account below.
    pub cranker: Signer<'info>,

    /// The settled writer-ask vault.
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

    /// Vault's USDC token account — payout source.
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
