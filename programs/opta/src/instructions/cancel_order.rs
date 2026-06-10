// =============================================================================
// instructions/cancel_order.rs — Owner cancels their own resting order
// =============================================================================
//
// Phase 1 of the Opta Exchange (exchange-spec §6.3, Step 4). Returns the
// escrowed collateral to the owner and closes both PDAs (rent → owner):
//
//   ResaleAsk: option tokens escrow → owner via protocol-PDA-signed hook
//     transfer. The hook permits this even post-expiry because the source is
//     protocol-owned (opta-transfer-hook/src/lib.rs:286-291), so cancel always
//     works. Mirrors cancel_v2_resale.rs:43-81.
//   Bid: USDC escrow → owner via protocol-PDA-signed classic transfer.
//
// Only the owner can cancel: the order PDA seed embeds owner.key(), so a
// non-owner signer cannot derive the passed order account (no separate error
// needed). The order PDA closes via Anchor `close = owner`.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token::{self, spl_token, Token, Transfer};
use anchor_spl::token_2022::Token2022;

use crate::errors::OptaError;
use crate::events::OrderCancelled;
use crate::state::*;

pub fn handle_cancel_order(ctx: Context<CancelOrder>) -> Result<()> {
    let clock = Clock::get()?;
    let kind = ctx.accounts.order.kind;
    let token_2022_key = ctx.accounts.token_2022_program.key();
    let protocol_seeds: &[&[u8]] = &[PROTOCOL_SEED, &[ctx.accounts.protocol_state.bump]];
    let protocol_signer: &[&[&[u8]]] = &[protocol_seeds];

    // ---- 1. Read escrow balance (amount at bytes 64..72, both layouts) -----
    let escrow_balance: u64 = {
        let data = ctx.accounts.escrow.try_borrow_data()?;
        require!(data.len() >= 72, OptaError::MathOverflow);
        let amount_bytes: [u8; 8] = data[64..72]
            .try_into()
            .map_err(|_| OptaError::MathOverflow)?;
        u64::from_le_bytes(amount_bytes)
    };

    // ---- 2. Return escrow contents + close the escrow (rent → owner) -------
    match kind {
        OrderKind::ResaleAsk => {
            if escrow_balance > 0 {
                spl_token_2022::onchain::invoke_transfer_checked(
                    &token_2022_key,
                    ctx.accounts.escrow.to_account_info(),
                    ctx.accounts.option_mint.to_account_info(),
                    ctx.accounts.owner_option_account.to_account_info(),
                    ctx.accounts.protocol_state.to_account_info(),
                    &[
                        ctx.accounts.extra_account_meta_list.to_account_info(),
                        ctx.accounts.transfer_hook_program.to_account_info(),
                        ctx.accounts.hook_state.to_account_info(),
                    ],
                    escrow_balance,
                    0,
                    protocol_signer,
                )?;
            }
            invoke_signed(
                &spl_token_2022::instruction::close_account(
                    &token_2022_key,
                    ctx.accounts.escrow.key,
                    ctx.accounts.owner.key,
                    &ctx.accounts.protocol_state.key(),
                    &[],
                )?,
                &[
                    ctx.accounts.escrow.to_account_info(),
                    ctx.accounts.owner.to_account_info(),
                    ctx.accounts.protocol_state.to_account_info(),
                ],
                protocol_signer,
            )?;
        }
        OrderKind::Bid => {
            if escrow_balance > 0 {
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.escrow.to_account_info(),
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
                    ctx.accounts.escrow.key,
                    ctx.accounts.owner.key,
                    &ctx.accounts.protocol_state.key(),
                    &[],
                )?,
                &[
                    ctx.accounts.escrow.to_account_info(),
                    ctx.accounts.owner.to_account_info(),
                    ctx.accounts.protocol_state.to_account_info(),
                ],
                protocol_signer,
            )?;
        }
        OrderKind::WriterAsk => return err!(OptaError::WriterAsksDisabled),
    }

    emit!(OrderCancelled {
        order: ctx.accounts.order.key(),
        owner: ctx.accounts.owner.key(),
        option_mint: ctx.accounts.option_mint.key(),
        kind: kind.as_u8(),
        amount_returned: escrow_balance,
        ts: clock.unix_timestamp,
    });

    // ---- 3. Order PDA closes via Anchor `close = owner` -------------------
    Ok(())
}

#[derive(Accounts)]
pub struct CancelOrder<'info> {
    /// Order owner — only the owner can cancel (enforced by the seed below).
    #[account(mut)]
    pub owner: Signer<'info>,

    /// Token-2022 option mint. Part of the order PDA seed.
    /// CHECK: validated by the order PDA derivation + Token-2022 transfer CPI.
    #[account(mut)]
    pub option_mint: UncheckedAccount<'info>,

    /// The resting order being cancelled. Seed embeds owner.key(), so only the
    /// owner can derive it. Closed here; rent → owner.
    #[account(
        mut,
        seeds = [
            RESTING_ORDER_SEED,
            option_mint.key().as_ref(),
            owner.key().as_ref(),
            &order.nonce.to_le_bytes(),
        ],
        bump = order.bump,
        close = owner,
    )]
    pub order: Box<Account<'info, RestingOrder>>,

    /// Per-order escrow PDA (option tokens for asks, USDC for bids).
    /// CHECK: PDA seeds validate the address.
    #[account(
        mut,
        seeds = [RESTING_ORDER_ESCROW_SEED, order.key().as_ref()],
        bump,
    )]
    pub escrow: UncheckedAccount<'info>,

    /// Protocol state — signs the escrow-source transfer + close.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Owner's option ATA — destination on the ResaleAsk branch.
    /// CHECK: validated by the Token-2022 transfer.
    #[account(mut)]
    pub owner_option_account: UncheckedAccount<'info>,

    /// Owner's USDC account — destination on the Bid branch.
    /// CHECK: mint enforced by SPL transfer (from.mint == escrow.mint).
    #[account(mut)]
    pub owner_usdc_account: UncheckedAccount<'info>,

    /// Transfer hook program.
    /// CHECK: ID-constrained.
    #[account(constraint = transfer_hook_program.key() == opta_transfer_hook::ID)]
    pub transfer_hook_program: UncheckedAccount<'info>,

    /// ExtraAccountMetaList for the transfer hook.
    /// CHECK: validated by Token-2022 hook dispatch.
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// HookState for the transfer hook.
    /// CHECK: validated by Token-2022 hook dispatch.
    pub hook_state: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}
