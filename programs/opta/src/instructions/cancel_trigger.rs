// =============================================================================
// instructions/cancel_trigger.rs — Owner cancels their own trigger (Phase 4 Pass 0)
// =============================================================================
//
// Trigger-order spec v1, §cancel. NOT flag-gated. Owner-only — the TriggerOrder
// PDA seed embeds owner.key(), so a non-owner signer cannot derive the passed
// account (no separate error needed). The cancel_order.rs pattern.
//
//   BUY (escrow_funded): refund the FULL escrow balance trigger_escrow → owner
//     (protocol_state PDA signs the classic transfer), then close the escrow
//     token account, rent → owner.
//   SELL: nothing was escrowed — the escrow block is skipped entirely; the
//     derived (uninitialized) escrow address is passed but never touched.
//
// The TriggerOrder PDA closes via Anchor `close = owner`; rent → owner.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token::{self, spl_token, Token, Transfer};

use crate::errors::OptaError;
use crate::events::TriggerCancelled;
use crate::state::*;

pub fn handle_cancel_trigger(ctx: Context<CancelTrigger>) -> Result<()> {
    // ---- Refund + close the escrow (BUY only) -----------------------------
    if ctx.accounts.trigger_order.escrow_funded {
        let protocol_seeds: &[&[u8]] = &[PROTOCOL_SEED, &[ctx.accounts.protocol_state.bump]];
        let protocol_signer: &[&[&[u8]]] = &[protocol_seeds];

        // Read the escrow balance (classic SPL amount at bytes 64..72).
        let escrow_balance: u64 = {
            let data = ctx.accounts.trigger_escrow.try_borrow_data()?;
            require!(data.len() >= 72, OptaError::MathOverflow);
            let amount_bytes: [u8; 8] = data[64..72]
                .try_into()
                .map_err(|_| OptaError::MathOverflow)?;
            u64::from_le_bytes(amount_bytes)
        };

        if escrow_balance > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.trigger_escrow.to_account_info(),
                        to: ctx.accounts.owner_usdc_account.to_account_info(),
                        authority: ctx.accounts.protocol_state.to_account_info(),
                    },
                    protocol_signer,
                ),
                escrow_balance,
            )?;
        }
        invoke_signed(
            &spl_token::instruction::close_account(
                &ctx.accounts.token_program.key(),
                ctx.accounts.trigger_escrow.key,
                ctx.accounts.owner.key,
                &ctx.accounts.protocol_state.key(),
                &[],
            )?,
            &[
                ctx.accounts.trigger_escrow.to_account_info(),
                ctx.accounts.owner.to_account_info(),
                ctx.accounts.protocol_state.to_account_info(),
            ],
            protocol_signer,
        )?;
    }

    // ---- B3: unlink the surviving OCO leg ---------------------------------
    //
    // Closing one leg while the other still points at it would BRICK the
    // survivor: execute_trigger sees `oco_link = Some(closed_pda)`, demands that
    // account (6087), and any account supplied for a closed PDA fails the mutual
    // back-link check (6088). The survivor could then never fire — a stop-loss
    // that silently stops protecting is worse than one that was never placed.
    //
    // The peer is OPTIONAL so unpaired cancels are unchanged, but if this trigger
    // IS linked the peer must be supplied, for exactly the reason above.
    if let Some(link) = ctx.accounts.trigger_order.oco_link {
        let peer = ctx
            .accounts
            .oco_peer
            .as_mut()
            .ok_or(error!(OptaError::OcoPeerRequired))?;
        require_keys_eq!(peer.key(), link, OptaError::OcoPeerMismatch);
        require!(
            peer.oco_link == Some(ctx.accounts.trigger_order.key()),
            OptaError::OcoPeerMismatch
        );
        peer.oco_link = None;
    }

    emit!(TriggerCancelled {
        trigger_order: ctx.accounts.trigger_order.key(),
        owner: ctx.accounts.owner.key(),
    });

    // ---- TriggerOrder PDA closes via Anchor `close = owner` ---------------
    Ok(())
}

#[derive(Accounts)]
pub struct CancelTrigger<'info> {
    /// Trigger owner — only the owner can cancel (enforced by the seed below).
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The trigger being cancelled. Seed embeds owner.key(), so only the owner
    /// can derive it. Self-references its own stored option_mint + nonce
    /// (the FillOrder self-seed idiom). Closed here; rent → owner.
    #[account(
        mut,
        seeds = [
            TRIGGER_ORDER_SEED,
            owner.key().as_ref(),
            trigger_order.option_mint.as_ref(),
            &trigger_order.nonce.to_le_bytes(),
        ],
        bump = trigger_order.bump,
        close = owner,
    )]
    pub trigger_order: Box<Account<'info, TriggerOrder>>,

    /// Per-trigger USDC escrow PDA (touched only when escrow_funded). On a SELL
    /// this is the derived (uninitialized) address, passed but never read.
    /// CHECK: PDA seeds validate the address.
    #[account(
        mut,
        seeds = [TRIGGER_ESCROW_SEED, trigger_order.key().as_ref()],
        bump,
    )]
    pub trigger_escrow: UncheckedAccount<'info>,

    /// Protocol state — signs the escrow-source refund + close.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,


    /// Owner's USDC account — refund destination (BUY). Mint enforced by the SPL
    /// transfer (from.mint == to.mint); unused on the SELL branch.
    /// CHECK: validated by the SPL transfer.
    #[account(mut)]
    pub owner_usdc_account: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    /// The paired trigger, when this one is half of an OCO couple. APPENDED, so
    /// every existing account keeps its index and unpaired callers pass None.
    #[account(mut)]
    pub oco_peer: Option<Box<Account<'info, TriggerOrder>>>,
}
