// =============================================================================
// instructions/reclaim_unsettled.rs — Dead-feed safety hatch (Phase 2 Pass D)
// =============================================================================
//
// The escape hatch for a vault whose settlement price NEVER landed. If the
// price feed for an (asset, expiry) is dead — no SettlementRecord ever gets
// created — the ordinary settle → exercise → withdraw_post_settlement pipeline
// can never run, and writer collateral would be stranded forever. This hatch
// lets writers reclaim their pooled collateral pro-rata once a 7-day grace
// window has elapsed with no settlement.
//
// Invariant #6 (spec v1.1): a voided vault pays holders NOTHING and writers
// exactly pro-rata. This handler therefore NEVER sets `is_settled` and NEVER
// writes a SettlementRecord — a zero/late settlement price would let PUT
// holders drain `strike − 0` per contract. `voided = true` is the terminal
// flag; the four defensive `!voided` guards (settle_vault, withdraw_from_vault,
// exercise_from_vault, auto_finalize_holders) ensure no path treats a voided
// vault as settled.
//
// Design (locked decisions, Pass D):
//   1. Per-writer claim — one WriterPosition paid per call. Permissionless: a
//      cranker may reclaim on any writer's behalf; funds land in that writer's
//      USDC ATA. Per-writer idempotency is the writer's shares being zeroed
//      (the same `shares > 0` guard withdraw_post_settlement uses), NOT the
//      vault's `voided` flag — so the second writer of a multi-writer vault is
//      not blocked after the first call flips `voided`.
//   2/3. On the FIRST call (the void transition), before any payout, seed
//      `collateral_remaining = total_collateral − early_exercise_payout` — the
//      same expression Stage G's F→G handshake uses, netting USDC already paid
//      out to early-American exercisers. On a never-settled vault
//      collateral_remaining is otherwise 0, which would pay everyone nothing.
//   4. Premium-claimed-first — reuses the exact ClaimPremiumFirst precondition
//      withdraw_from_vault enforces. Premium stays claimable via claim_premium.
//
// USDC flow: vault_usdc_account → writer_usdc_account (signed by vault PDA via
// vault_namespace_seed — series vaults are American, so the American prefix).
// =============================================================================

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::OptaError;
use crate::events::VaultReclaimed;
use crate::state::*;

pub fn handle_reclaim_unsettled(ctx: Context<ReclaimUnsettled>) -> Result<()> {
    let vault = &ctx.accounts.shared_vault;
    let writer_pos = &ctx.accounts.writer_position;

    // ---- 1. Precondition: the vault must be VOIDED (Phase 3 Slice D3) --------
    // `initialize_void` is the SOLE voided-setter and runs the full merge (pot
    // sweep + shares-unification + collateral_remaining seed) ATOMICALLY before
    // flipping voided. require!(voided) therefore guarantees the merge committed
    // before this per-writer claim — there is no path to a reclaim against a
    // voided-but-unmerged vault. The no-SettlementRecord + 7-day grace gates AND
    // the seed/void transition that used to live here MOVED to initialize_void;
    // reclaim never re-checks them, so a post-void SettlementRecord (a late feed)
    // cannot re-block reclaim — and settle_vault's !voided guard blocks ever
    // applying it. The pro-rata payout below is byte-identical (it auto-scales on
    // the bumped total_shares + merged collateral_remaining initialize_void seeded).
    require!(vault.voided, OptaError::VaultNotVoided);

    // ---- 2. Caller authorization + zero-shares idempotency ------------------
    // Same guards withdraw_post_settlement uses. `writer` is the position owner
    // (NOT necessarily the signer — permissionless on-behalf-of crank).
    require!(
        writer_pos.owner == ctx.accounts.writer.key(),
        OptaError::NotWriter
    );
    require!(writer_pos.shares > 0, OptaError::InsufficientCollateral);

    // ---- 4. Premium-claimed-first (reuse withdraw_from_vault's check) -------
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

    // ---- 4. Per-writer pro-rata payout (withdraw_post_settlement formula) ----
    // collateral_remaining + total_shares were seeded/merged by initialize_void
    // (the void transition that used to live here). Byte-identical math.
    let vault = &ctx.accounts.shared_vault;
    let writer_remaining = (writer_pos.shares as u128)
        .checked_mul(vault.collateral_remaining as u128)
        .ok_or(OptaError::MathOverflow)?
        .checked_div(vault.total_shares as u128)
        .ok_or(OptaError::MathOverflow)? as u64;

    // Vault-PDA signer — namespace-aware so American series vaults sign.
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

    if writer_remaining > 0 {
        let transfer_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.vault_usdc_account.to_account_info(),
                to: ctx.accounts.writer_usdc_account.to_account_info(),
                authority: ctx.accounts.shared_vault.to_account_info(),
            },
            signer_seeds,
        );
        token::transfer(transfer_ctx, writer_remaining)?;
    }

    // ---- 7. Accounting (same decrements as withdraw_post_settlement) --------
    let vault_key = ctx.accounts.shared_vault.key();
    let writer_key = ctx.accounts.writer.key();
    let writer_shares = writer_pos.shares;

    let vault = &mut ctx.accounts.shared_vault;
    vault.collateral_remaining = vault
        .collateral_remaining
        .checked_sub(writer_remaining)
        .ok_or(OptaError::MathOverflow)?;
    vault.total_shares = vault
        .total_shares
        .checked_sub(writer_shares)
        .ok_or(OptaError::MathOverflow)?;
    vault.total_collateral = vault
        .total_collateral
        .checked_sub(writer_remaining)
        .ok_or(OptaError::MathOverflow)?;

    // Zero the position's shares so a second reclaim hits the shares>0 guard
    // above (zeroed-not-closed: clean per-writer idempotency without depending
    // on rent-refund to a non-signer position owner).
    let writer_pos = &mut ctx.accounts.writer_position;
    writer_pos.shares = 0;

    emit!(VaultReclaimed {
        vault: vault_key,
        writer: writer_key,
        amount: writer_remaining,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct ReclaimUnsettled<'info> {
    /// Permissionless cranker — pays the transaction. May reclaim on any
    /// writer's behalf; the payout always lands in the writer's USDC ATA.
    #[account(mut)]
    pub cranker: Signer<'info>,

    /// The writer whose collateral is being reclaimed. NOT a signer — bound by
    /// the writer_position seed + the writer_usdc owner constraint.
    /// CHECK: used only as a PDA seed and ATA-owner constraint; never read or
    /// written, never required to sign.
    pub writer: UncheckedAccount<'info>,

    /// The vault being wound down via the hatch.
    #[account(mut)]
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// The writer's position in the vault. Zeroed (not closed) after payout.
    #[account(
        mut,
        seeds = [WRITER_POSITION_SEED, shared_vault.key().as_ref(), writer.key().as_ref()],
        bump = writer_position.bump,
    )]
    pub writer_position: Box<Account<'info, WriterPosition>>,

    // D3: `market` + `settlement_record` were dropped — the no-record gate they
    // served moved to initialize_void (which is now the sole voider). reclaim
    // gates on `voided` instead. CRANK: drop these two accounts from the
    // reclaim_unsettled call before redeploy (a pre-flip wiring task).

    /// Vault's USDC token account — source of the pro-rata payout.
    #[account(
        mut,
        constraint = vault_usdc_account.key() == shared_vault.vault_usdc_account,
    )]
    pub vault_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Writer's USDC token account — destination. Must be owned by the writer.
    #[account(
        mut,
        constraint = writer_usdc_account.owner == writer.key(),
        constraint = writer_usdc_account.mint == shared_vault.collateral_mint,
    )]
    pub writer_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Standard SPL Token program.
    pub token_program: Program<'info, Token>,
}
