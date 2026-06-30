// =============================================================================
// instructions/close_settled_writer_ask_vault.rs — reclaim a fully-drained
// writer-ask vault's USDC account (Phase 3 Slice D2a)
// =============================================================================
//
// The dedicated close path for a writer-ask vault, separated from the pooled
// last-writer close (withdraw_post_settlement / auto_finalize_writers) because a
// writer-ask vault's total_shares is the UNIFIED denominator (pool shares +
// writer-ask equiv-shares) — the pooled close, which fires on `total_shares == 0`
// after the last POOL writer, never triggers while writer-ask equiv-shares remain.
//
// EXACT, UNSPOOFABLE PRECONDITION (Opt-1):
//
//     is_settled && !voided && writer_ask_collateral_swept > 0 && total_shares == 0
//
// `total_shares` is mutated only by deposit / withdraw / the D2a settle-bump /
// withdraw_writer_ask_residual — all program-controlled, so it cannot be spoofed.
// If ANY claimant is still owed, their weight is still in total_shares:
//   - a pool WriterPosition with shares > 0 ⇒ total_shares ≥ shares > 0;
//   - an unclaimed WriterAskPosition (collateral_committed > 0) ⇒ its equiv_shares
//     are still in total_shares ⇒ total_shares > 0.
// Therefore `total_shares == 0` ⟹ EVERY position has been drained, and it is
// impossible to close a vault that still owes a claimant. (The proof is in
// .context/audits — close-precondition exactness.)
//
// SAFE UNDER-CLOSE (the logged Opt-1 gap): a mixed pool+writer-ask vault whose
// pool ratio drifted via a truncated partial withdrawal can land at
// total_shares == D > 0 floor-dust after every position is drained. This close
// then never fires — the vault USDC stays open (≈ rent + ≤ D micro-USDC stranded),
// NO claimant is harmed. This is an under-close (refuses to act), the opposite of
// the dangerous over-close, and is reclaimable later by a future admin
// force-close. In the common 1:1 pool case D == 0 and the close fires.
//
// Scope is pinned to writer-ask vaults via `swept > 0`; pool-only / EUR vaults
// (swept == 0) close through the pooled last-writer path and revert 6073 here.
//
// Dust (residual micro-USDC) and the account rent SOL both go to the protocol
// TREASURY — the non-urgent, no-incentive recipient (mirrors auto_finalize_writers'
// dust+rent → treasury sweep). PERMISSIONLESS. UNGATED (an exit/cleanup path); in
// a feature-free build swept is always 0 so this reverts 6073 — present but inert.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};

use crate::errors::OptaError;
use crate::events::SettledWriterAskVaultClosed;
use crate::state::*;

pub fn handle_close_settled_writer_ask_vault(
    ctx: Context<CloseSettledWriterAskVault>,
) -> Result<()> {
    let vault = &ctx.accounts.shared_vault;

    // ---- EXACT all-drained precondition (Opt-1) ---------------------------
    // is_settled && !voided && swept > 0 && total_shares == 0
    require!(vault.is_settled, OptaError::VaultNotSettled);
    require!(!vault.voided, OptaError::VaultVoided);
    require!(
        vault.writer_ask_collateral_swept > 0,
        OptaError::NotAWriterAskVault
    );
    require!(vault.total_shares == 0, OptaError::VaultNotFullyDrained);

    // ---- Vault PDA signer seeds (American-namespace prefix) ----------------
    let vault_key = ctx.accounts.shared_vault.key();
    let market_key = vault.market;
    let strike_bytes = vault.strike_price.to_le_bytes();
    let expiry_bytes = vault.expiry.to_le_bytes();
    let option_type_byte = [vault.option_type as u8];
    let vault_bump = [vault.bump];
    let vault_seeds: &[&[u8]] = &[
        vault_namespace_seed(vault.exercise_style),
        market_key.as_ref(),
        &strike_bytes,
        &expiry_bytes,
        &option_type_byte,
        &vault_bump,
    ];
    let signer_seeds = &[vault_seeds];

    // ---- Sweep residual dust → treasury, then close → rent to treasury -----
    ctx.accounts.vault_usdc_account.reload()?;
    let dust = ctx.accounts.vault_usdc_account.amount;
    if dust > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault_usdc_account.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                    authority: ctx.accounts.shared_vault.to_account_info(),
                },
                signer_seeds,
            ),
            dust,
        )?;
    }

    token::close_account(CpiContext::new_with_signer(
        ctx.accounts.token_program.to_account_info(),
        CloseAccount {
            account: ctx.accounts.vault_usdc_account.to_account_info(),
            destination: ctx.accounts.treasury.to_account_info(),
            authority: ctx.accounts.shared_vault.to_account_info(),
        },
        signer_seeds,
    ))?;

    let clock = Clock::get()?;
    emit!(SettledWriterAskVaultClosed {
        vault: vault_key,
        dust_swept: dust,
        ts: clock.unix_timestamp,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct CloseSettledWriterAskVault<'info> {
    /// Permissionless caller (a cranker). Receives nothing — dust + rent → treasury.
    pub cranker: Signer<'info>,

    /// The settled, fully-drained writer-ask vault. Read-only: the SharedVault
    /// record persists (only its USDC account is closed), so no field is mutated.
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// Vault's USDC token account — dust swept then account closed.
    #[account(
        mut,
        constraint = vault_usdc_account.key() == shared_vault.vault_usdc_account,
    )]
    pub vault_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Protocol treasury — receives the dust + the account rent SOL. Pinned via
    /// protocol_state.
    #[account(
        mut,
        constraint = treasury.key() == protocol_state.treasury,
    )]
    pub treasury: Box<Account<'info, TokenAccount>>,

    /// Protocol state — pins the treasury.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Standard SPL Token program.
    pub token_program: Program<'info, Token>,
}
