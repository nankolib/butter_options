// =============================================================================
// instructions/fill_order.rs — Taker fills a named resting order (both sides)
// =============================================================================
//
// Phase 1 of the Opta Exchange (exchange-spec §6.3, Step 3). Partial fills are
// first-class. Uniform context, branch on order.kind:
//
//   ResaleAsk fill: taker pays `total` USDC → maker (minus fee → treasury),
//     taker-signed; escrow option tokens → taker, protocol-PDA-signed hook
//     transfer. (The exact economics of buy_v2_resale.rs:71-130.)
//   Bid fill: taker delivers `fill_quantity` option tokens → maker (bidder),
//     taker-signed hook transfer; escrow USDC → taker (minus fee → treasury),
//     protocol-PDA-signed. (The inverse direction.)
//
// Fee block is reused verbatim from buy_v2_resale.rs:71-109 (total = qty ×
// price, fee = total × fee_bps / 10_000 floored, both legs zero-guarded,
// treasury validated by seed + protocol_state.treasury constraint).
//
// On full fill (quantity_remaining → 0) the escrow + order PDAs close with the
// conditional manual-close idiom (buy_v2_resale.rs:133-177); rent → order owner
// in both close paths. Self-fill is allowed (no taker ≠ maker check) — Phase 1
// locked behavior.
//
// Destination ATAs (taker's option ATA on a resale fill, maker's option ATA on
// a bid fill, the USDC accounts) are CPI-validated UncheckedAccount/typed
// accounts pre-created idempotently by the client — same pattern as
// buy_v2_resale (frontend pre-creates; handler transfers). See the build-report
// deviation note vs. the spec's "(idempotent create)" wording.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_program};
use anchor_spl::token::{self, spl_token, Token, TokenAccount, Transfer};
use anchor_spl::token_2022::Token2022;

use crate::errors::OptaError;
use crate::events::OrderFilled;
use crate::state::*;
use super::initialize_protocol::TREASURY_SEED;

pub fn handle_fill_order(ctx: Context<FillOrder>, fill_quantity: u64) -> Result<()> {
    let clock = Clock::get()?;

    // Snapshot order fields before the in-loop mutation + manual close.
    let kind = ctx.accounts.order.kind;
    let order_owner = ctx.accounts.order.owner;
    let order_mint = ctx.accounts.order.option_mint;
    let order_vault = ctx.accounts.order.vault;
    let price = ctx.accounts.order.price_per_contract;
    let remaining = ctx.accounts.order.quantity_remaining;
    let order_key = ctx.accounts.order.key();

    // ---- 1. Pre-flight checks ---------------------------------------------
    require!(
        clock.unix_timestamp < ctx.accounts.shared_vault.expiry,
        OptaError::VaultExpired
    );
    require!(fill_quantity > 0, OptaError::InvalidContractSize);
    require!(fill_quantity <= remaining, OptaError::ListingExhausted);

    // ---- 2. Fee split (mirrors buy_v2_resale.rs:71-109) -------------------
    let total: u64 = (fill_quantity as u128)
        .checked_mul(price as u128)
        .ok_or(OptaError::MathOverflow)?
        .try_into()
        .map_err(|_| OptaError::MathOverflow)?;
    let fee_bps = ctx.accounts.protocol_state.fee_bps as u128;
    let fee: u64 = ((total as u128)
        .checked_mul(fee_bps)
        .ok_or(OptaError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(OptaError::MathOverflow)?)
    .try_into()
    .map_err(|_| OptaError::MathOverflow)?;
    let counterparty_share = total.checked_sub(fee).ok_or(OptaError::MathOverflow)?;

    let token_2022_key = ctx.accounts.token_2022_program.key();
    let protocol_seeds: &[&[u8]] = &[PROTOCOL_SEED, &[ctx.accounts.protocol_state.bump]];
    let protocol_signer: &[&[&[u8]]] = &[protocol_seeds];

    // ---- 3. Branch on order kind ------------------------------------------
    match kind {
        OrderKind::ResaleAsk => {
            // Taker pays USDC: fee → treasury, remainder → maker. Taker signs.
            if fee > 0 {
                token::transfer(
                    CpiContext::new(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.taker_usdc_account.to_account_info(),
                            to: ctx.accounts.treasury.to_account_info(),
                            authority: ctx.accounts.taker.to_account_info(),
                        },
                    ),
                    fee,
                )?;
            }
            if counterparty_share > 0 {
                token::transfer(
                    CpiContext::new(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.taker_usdc_account.to_account_info(),
                            to: ctx.accounts.maker_usdc_account.to_account_info(),
                            authority: ctx.accounts.taker.to_account_info(),
                        },
                    ),
                    counterparty_share,
                )?;
            }
            // Escrow option tokens → taker (protocol PDA signs).
            spl_token_2022::onchain::invoke_transfer_checked(
                &token_2022_key,
                ctx.accounts.escrow.to_account_info(),
                ctx.accounts.option_mint.to_account_info(),
                ctx.accounts.taker_option_account.to_account_info(),
                ctx.accounts.protocol_state.to_account_info(),
                &[
                    ctx.accounts.extra_account_meta_list.to_account_info(),
                    ctx.accounts.transfer_hook_program.to_account_info(),
                    ctx.accounts.hook_state.to_account_info(),
                ],
                fill_quantity,
                0,
                protocol_signer,
            )?;
        }
        OrderKind::Bid => {
            // C-1 (Run-8) — pin maker_option_account to (order.owner,
            // order.option_mint) BEFORE the transfer. Token-2022
            // transfer_checked validates only the destination's mint/decimals,
            // not its ownership; an unpinned destination let the taker pass
            // their OWN account (a self-transfer that keeps the tokens) while
            // still draining the bidder's escrowed USDC. Read owner(32..64) +
            // mint(0..32) from the raw account layout — same idiom as
            // auto_finalize_holders.rs / auto_finalize_writers.rs. The borrow is
            // scoped so it drops before the transfer re-borrows the account.
            {
                let data = ctx.accounts.maker_option_account.try_borrow_data()?;
                require!(data.len() >= 72, OptaError::MakerOptionAccountInvalid);
                let mint_bytes: [u8; 32] = data[0..32]
                    .try_into()
                    .map_err(|_| OptaError::MakerOptionAccountInvalid)?;
                let owner_bytes: [u8; 32] = data[32..64]
                    .try_into()
                    .map_err(|_| OptaError::MakerOptionAccountInvalid)?;
                require!(
                    Pubkey::new_from_array(mint_bytes) == order_mint,
                    OptaError::MakerOptionAccountInvalid
                );
                require!(
                    Pubkey::new_from_array(owner_bytes) == order_owner,
                    OptaError::MakerOptionAccountInvalid
                );
            }
            // Taker delivers option tokens → maker (bidder). Taker signs.
            spl_token_2022::onchain::invoke_transfer_checked(
                &token_2022_key,
                ctx.accounts.taker_option_account.to_account_info(),
                ctx.accounts.option_mint.to_account_info(),
                ctx.accounts.maker_option_account.to_account_info(),
                ctx.accounts.taker.to_account_info(),
                &[
                    ctx.accounts.extra_account_meta_list.to_account_info(),
                    ctx.accounts.transfer_hook_program.to_account_info(),
                    ctx.accounts.hook_state.to_account_info(),
                ],
                fill_quantity,
                0,
                &[],
            )?;
            // Escrow USDC → taker (minus fee), fee → treasury. Protocol signs.
            if counterparty_share > 0 {
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.escrow.to_account_info(),
                            to: ctx.accounts.taker_usdc_account.to_account_info(),
                            authority: ctx.accounts.protocol_state.to_account_info(),
                        },
                        protocol_signer,
                    ),
                    counterparty_share,
                )?;
            }
            if fee > 0 {
                token::transfer(
                    CpiContext::new_with_signer(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.escrow.to_account_info(),
                            to: ctx.accounts.treasury.to_account_info(),
                            authority: ctx.accounts.protocol_state.to_account_info(),
                        },
                        protocol_signer,
                    ),
                    fee,
                )?;
            }
        }
        OrderKind::WriterAsk => return err!(OptaError::WriterAsksDisabled),
        // VaultPeg is never a resting order (post_order rejects it) — no stored
        // order can carry this kind, so this branch is structurally unreachable.
        OrderKind::VaultPeg => unreachable!("VaultPeg is never a resting order"),
    }

    // ---- 4. Decrement + conditional close ---------------------------------
    let new_remaining = {
        let order = &mut ctx.accounts.order;
        order.quantity_remaining = order
            .quantity_remaining
            .checked_sub(fill_quantity)
            .ok_or(OptaError::MathOverflow)?;
        order.quantity_remaining
    };

    let order_closed = new_remaining == 0;
    if order_closed {
        // a) Close the escrow (kind-specific token program); rent → maker.
        match kind {
            OrderKind::ResaleAsk => {
                invoke_signed(
                    &spl_token_2022::instruction::close_account(
                        &token_2022_key,
                        ctx.accounts.escrow.key,
                        ctx.accounts.maker.key,
                        &ctx.accounts.protocol_state.key(),
                        &[],
                    )?,
                    &[
                        ctx.accounts.escrow.to_account_info(),
                        ctx.accounts.maker.to_account_info(),
                        ctx.accounts.protocol_state.to_account_info(),
                    ],
                    protocol_signer,
                )?;
            }
            OrderKind::Bid => {
                invoke_signed(
                    &spl_token::instruction::close_account(
                        &ctx.accounts.token_program.key(),
                        ctx.accounts.escrow.key,
                        ctx.accounts.maker.key,
                        &ctx.accounts.protocol_state.key(),
                        &[],
                    )?,
                    &[
                        ctx.accounts.escrow.to_account_info(),
                        ctx.accounts.maker.to_account_info(),
                        ctx.accounts.protocol_state.to_account_info(),
                    ],
                    protocol_signer,
                )?;
            }
            OrderKind::WriterAsk => unreachable!("rejected above"),
            OrderKind::VaultPeg => unreachable!("VaultPeg is never a resting order"),
        }

        // b) Close the order PDA manually; rent → maker. Same idiom as
        //    buy_v2_resale.rs:162-177 / auto_finalize_writers.rs:225-244.
        let order_info = ctx.accounts.order.to_account_info();
        let maker_info = ctx.accounts.maker.to_account_info();
        let rent_lamports = order_info.lamports();
        **maker_info.try_borrow_mut_lamports()? = maker_info
            .lamports()
            .checked_add(rent_lamports)
            .ok_or(OptaError::MathOverflow)?;
        **order_info.try_borrow_mut_lamports()? = 0;
        order_info.assign(&system_program::ID);
        order_info.resize(0)?;
    }

    emit!(OrderFilled {
        order: order_key,
        option_mint: order_mint,
        vault: order_vault,
        kind: kind.as_u8(),
        maker: order_owner,
        taker: ctx.accounts.taker.key(),
        price_per_contract: price,
        fill_quantity,
        fee,
        quantity_remaining: new_remaining,
        ts: clock.unix_timestamp,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct FillOrder<'info> {
    /// Taker — pays/receives USDC, delivers/receives option tokens.
    #[account(mut)]
    pub taker: Signer<'info>,

    /// Token-2022 option mint. Part of the order PDA seed (binds mint↔order).
    /// CHECK: validated by the order PDA derivation + Token-2022 transfer CPI.
    #[account(mut)]
    pub option_mint: UncheckedAccount<'info>,

    /// The resting order being filled. Seeds bind it to (option_mint, owner,
    /// nonce); a wrong option_mint fails derivation. Closed on full fill via
    /// the manual idiom (Anchor `close =` can't be conditional).
    #[account(
        mut,
        seeds = [
            RESTING_ORDER_SEED,
            option_mint.key().as_ref(),
            order.owner.as_ref(),
            &order.nonce.to_le_bytes(),
        ],
        bump = order.bump,
    )]
    pub order: Box<Account<'info, RestingOrder>>,

    /// Maker wallet — order owner. Rent destination on close, USDC recipient on
    /// a resale fill. Pinned to order.owner so no third party redirects rent.
    /// CHECK: pubkey-pinned to order.owner.
    #[account(mut, constraint = maker.key() == order.owner)]
    pub maker: UncheckedAccount<'info>,

    /// Vault — read for the expiry guard.
    #[account(constraint = shared_vault.key() == order.vault)]
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// Per-order escrow PDA (option tokens for asks, USDC for bids).
    /// CHECK: PDA seeds validate the address.
    #[account(
        mut,
        seeds = [RESTING_ORDER_ESCROW_SEED, order.key().as_ref()],
        bump,
    )]
    pub escrow: UncheckedAccount<'info>,

    /// Protocol state — fee_bps + escrow signer authority.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Treasury — receives the protocol fee.
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump,
        constraint = treasury.key() == protocol_state.treasury,
    )]
    pub treasury: Box<Account<'info, TokenAccount>>,

    /// Taker's USDC ATA — source on resale fill, destination on bid fill.
    #[account(
        mut,
        constraint = taker_usdc_account.owner == taker.key(),
        constraint = taker_usdc_account.mint == protocol_state.usdc_mint,
    )]
    pub taker_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Maker's USDC ATA — destination on resale fill (unused on bid fill, but
    /// passed for uniform context). Pinned to order.owner + USDC mint.
    #[account(
        mut,
        constraint = maker_usdc_account.owner == order.owner,
        constraint = maker_usdc_account.mint == protocol_state.usdc_mint,
    )]
    pub maker_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Taker's option ATA — destination on resale fill, source on bid fill.
    /// CHECK: validated by the Token-2022 transfer.
    #[account(mut)]
    pub taker_option_account: UncheckedAccount<'info>,

    /// Maker's option ATA — destination on bid fill (unused on resale fill).
    /// CHECK: runtime-pinned in the Bid branch (C-1) — owner(32..64) must equal
    /// order.owner and mint(0..32) must equal order.option_mint before the
    /// transfer, so the taker cannot redirect the delivery to their own account.
    /// A struct-level typed constraint isn't used: these are Token-2022 accounts
    /// (owned by the Token-2022 program), which `Account<TokenAccount>` rejects.
    #[account(mut)]
    pub maker_option_account: UncheckedAccount<'info>,

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
