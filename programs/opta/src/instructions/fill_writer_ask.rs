// =============================================================================
// instructions/fill_writer_ask.rs — Taker fills a writer's limit ask (Slice B)
// =============================================================================
// Phase 3 Slice B. A dedicated handler (mirrors fill_vault_peg; NOT an arm of
// fill_order) for OrderKind::WriterAsk. Mint-on-fill from the writer's PERSONAL
// collateral (lock-at-post in Slice A's per-order escrow):
//   - Premium = order.price_per_contract × fill_quantity, taker → maker(=writer)
//     USDC, fee → treasury (the ResaleAsk USDC-leg split). Model-B is structural.
//   - Mint fill_quantity series contracts → taker (protocol_state signs; no hook
//     fires — mint_to is not a transfer).
//   - Move cpt × fill_quantity (cpt = order.collateral_per_contract, the Slice-A
//     stamp — no recompute) from the per-order escrow → writer_ask_pot_usdc
//     (protocol_state signs). The unfilled remainder stays escrowed (Slice C).
//   - Bump ONLY WriterAskPot + WriterAskPosition. shared_vault is READ-ONLY —
//     touches no vault counter / premium accumulator, so every pool handler
//     stays pristine until Slice D's settle_vault pot-sweep.
//
// Fee source: protocol_state.fee_bps — the exact source fill_order.rs:67 and
// fill_vault_peg.rs:213 use, so the WriterAsk fee split matches the rest of the
// book.
//
// Gated dark by WRITER_ASKS_ENABLED + AMERICAN_ENABLED (first lines). Lock-at-
// post means NO fill-time free-collateral check is needed.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_program};
use anchor_spl::token::{self, spl_token, Mint as SplMint, Token, TokenAccount, Transfer};
use anchor_spl::token_2022::Token2022;

use crate::errors::OptaError;
use crate::events::OrderFilled;
use crate::feature_flags::{AMERICAN_ENABLED, WRITER_ASKS_ENABLED};
use crate::state::*;
use super::initialize_protocol::TREASURY_SEED;

pub fn handle_fill_writer_ask(ctx: Context<FillWriterAsk>, fill_quantity: u64) -> Result<()> {
    // ---- 1. Gates (first lines) -------------------------------------------
    require!(WRITER_ASKS_ENABLED, OptaError::WriterAsksDisabled);
    require!(AMERICAN_ENABLED, OptaError::AmericanVaultsDisabled);

    let clock = Clock::get()?;
    let order_owner = ctx.accounts.order.owner;
    let order_mint = ctx.accounts.order.option_mint;
    let order_vault = ctx.accounts.order.vault;
    let price = ctx.accounts.order.price_per_contract;
    let cpt = ctx.accounts.order.collateral_per_contract;
    let remaining = ctx.accounts.order.quantity_remaining;
    let order_key = ctx.accounts.order.key();

    // ---- 2. Guards --------------------------------------------------------
    require!(ctx.accounts.order.kind == OrderKind::WriterAsk, OptaError::NotAWriterAsk);
    require!(ctx.accounts.taker.key() != order_owner, OptaError::CannotBuyOwnOption);
    require!(
        ctx.accounts.shared_vault.exercise_style == ExerciseStyle::American,
        OptaError::NotAmericanOption
    );
    require!(!ctx.accounts.shared_vault.is_settled, OptaError::VaultAlreadySettled);
    require!(!ctx.accounts.shared_vault.voided, OptaError::VaultVoided);
    require!(
        clock.unix_timestamp < ctx.accounts.shared_vault.expiry,
        OptaError::VaultExpired
    );
    require!(fill_quantity > 0, OptaError::InvalidContractSize);
    require!(fill_quantity <= remaining, OptaError::ListingExhausted);

    // ---- 3. Premium + fee split (maker-set price) -------------------------
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
    let collateral_moved: u64 = (cpt as u128)
        .checked_mul(fill_quantity as u128)
        .ok_or(OptaError::MathOverflow)?
        .try_into()
        .map_err(|_| OptaError::MathOverflow)?;

    let token_2022_key = ctx.accounts.token_2022_program.key();
    let protocol_seeds: &[&[u8]] = &[PROTOCOL_SEED, &[ctx.accounts.protocol_state.bump]];
    let protocol_signer: &[&[&[u8]]] = &[protocol_seeds];

    // ---- 4. USDC: taker → maker (premium − fee) + taker → treasury (fee) ---
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

    // ---- 5. Mint fill_quantity → taker (protocol_state signs; no hook) -----
    invoke_signed(
        &spl_token_2022::instruction::mint_to(
            &token_2022_key,
            ctx.accounts.option_mint.key,
            ctx.accounts.taker_option_account.key,
            &ctx.accounts.protocol_state.key(),
            &[],
            fill_quantity,
        )?,
        &[
            ctx.accounts.option_mint.to_account_info(),
            ctx.accounts.taker_option_account.to_account_info(),
            ctx.accounts.protocol_state.to_account_info(),
        ],
        protocol_signer,
    )?;

    // ---- 6. Escrow → pot debit (cpt × fill_quantity; protocol signs) -------
    if collateral_moved > 0 {
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.escrow.to_account_info(),
                    to: ctx.accounts.writer_ask_pot_usdc.to_account_info(),
                    authority: ctx.accounts.protocol_state.to_account_info(),
                },
                protocol_signer,
            ),
            collateral_moved,
        )?;
    }

    // ---- 7. Pot bookkeeping (identity on fresh; counters always) ----------
    {
        let pot = &mut ctx.accounts.writer_ask_pot;
        if pot.option_mint == Pubkey::default() {
            pot.option_mint = order_mint;
            pot.vault = order_vault;
            pot.usdc_account = ctx.accounts.writer_ask_pot_usdc.key();
            pot.bump = ctx.bumps.writer_ask_pot;
        }
        pot.total_collateral = pot
            .total_collateral
            .checked_add(collateral_moved)
            .ok_or(OptaError::MathOverflow)?;
        pot.total_contracts = pot
            .total_contracts
            .checked_add(fill_quantity)
            .ok_or(OptaError::MathOverflow)?;
    }

    // ---- 8. Position bookkeeping (backer = order.owner) -------------------
    {
        let pos = &mut ctx.accounts.writer_ask_position;
        if pos.created_at == 0 {
            pos.backer = order_owner;
            pos.option_mint = order_mint;
            pos.vault = order_vault;
            pos.created_at = clock.unix_timestamp;
            pos.bump = ctx.bumps.writer_ask_position;
        }
        pos.collateral_committed = pos
            .collateral_committed
            .checked_add(collateral_moved)
            .ok_or(OptaError::MathOverflow)?;
        pos.contracts_written = pos
            .contracts_written
            .checked_add(fill_quantity)
            .ok_or(OptaError::MathOverflow)?;
    }

    // ---- 9. Decrement + conditional close ---------------------------------
    let new_remaining = {
        let order = &mut ctx.accounts.order;
        order.quantity_remaining = order
            .quantity_remaining
            .checked_sub(fill_quantity)
            .ok_or(OptaError::MathOverflow)?;
        order.quantity_remaining
    };
    if new_remaining == 0 {
        // Money-conservation guard: all escrowed collateral must have moved into
        // the pot. Assert escrow == 0 explicitly (clear error) before closing —
        // do not rely on close_account's implicit non-empty revert. Amount at
        // bytes 64..72 of the classic SPL account.
        {
            let data = ctx.accounts.escrow.try_borrow_data()?;
            require!(data.len() >= 72, OptaError::MathOverflow);
            let bal = u64::from_le_bytes(
                data[64..72]
                    .try_into()
                    .map_err(|_| OptaError::MathOverflow)?,
            );
            require!(bal == 0, OptaError::EscrowNotEmpty);
        }
        // Close the now-empty USDC escrow; rent → maker.
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
        // Manual close of the order PDA; rent → maker. Same idiom as
        // fill_order.rs:235-244.
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

    // ---- 10. Tape ---------------------------------------------------------
    emit!(OrderFilled {
        order: order_key,
        option_mint: order_mint,
        vault: order_vault,
        kind: OrderKind::WriterAsk.as_u8(),
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
pub struct FillWriterAsk<'info> {
    /// Taker — pays USDC premium, receives minted contracts, pays init rent.
    #[account(mut)]
    pub taker: Signer<'info>,

    /// Series Token-2022 mint (authority = protocol_state). Order PDA seed.
    /// CHECK: bound by the order PDA derivation + validated by mint_to.
    #[account(mut)]
    pub option_mint: UncheckedAccount<'info>,

    /// The WriterAsk order. Closed (manual) on full fill.
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

    /// Maker = writer = order.owner. Premium recipient + rent dest on close.
    /// CHECK: pubkey-pinned to order.owner.
    #[account(mut, constraint = maker.key() == order.owner)]
    pub maker: UncheckedAccount<'info>,

    /// Vault — READ-ONLY (Slice B touches no vault counter). Pinned to order.vault.
    #[account(constraint = shared_vault.key() == order.vault @ OptaError::InvalidVaultMint)]
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// Series record — mint↔vault proof (read-only).
    #[account(
        seeds = [VAULT_MINT_RECORD_SEED, option_mint.key().as_ref()],
        bump = vault_mint_record.bump,
        constraint = vault_mint_record.vault == shared_vault.key() @ OptaError::InvalidVaultMint,
    )]
    pub vault_mint_record: Box<Account<'info, VaultMint>>,

    /// Per-order USDC escrow (Slice A). Debit source; closed on full fill.
    /// CHECK: PDA seeds validate; authority = protocol_state.
    #[account(mut, seeds = [RESTING_ORDER_ESCROW_SEED, order.key().as_ref()], bump)]
    pub escrow: UncheckedAccount<'info>,

    /// Protocol state — escrow signer + mint authority + fee_bps + usdc/treasury pins.
    #[account(seeds = [PROTOCOL_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Treasury — fee recipient.
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump,
        constraint = treasury.key() == protocol_state.treasury,
    )]
    pub treasury: Box<Account<'info, TokenAccount>>,

    /// Taker USDC — pays premium.
    #[account(
        mut,
        constraint = taker_usdc_account.owner == taker.key(),
        constraint = taker_usdc_account.mint == protocol_state.usdc_mint,
    )]
    pub taker_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Maker (writer) USDC — receives premium − fee.
    #[account(
        mut,
        constraint = maker_usdc_account.owner == order.owner,
        constraint = maker_usdc_account.mint == protocol_state.usdc_mint,
    )]
    pub maker_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Taker's series ATA — mint destination (client pre-creates idempotently).
    /// CHECK: validated by mint_to.
    #[account(mut)]
    pub taker_option_account: UncheckedAccount<'info>,

    /// WriterAskPot record — init on first fill (taker pays).
    #[account(
        init_if_needed,
        seeds = [WRITER_ASK_POT_SEED, option_mint.key().as_ref()],
        bump,
        payer = taker,
        space = 8 + WriterAskPot::INIT_SPACE,
    )]
    pub writer_ask_pot: Box<Account<'info, WriterAskPot>>,

    /// WriterAskPot USDC account — init on first fill; authority = protocol_state
    /// (matches the per-order escrow authority → enables Slice D's pot sweep).
    #[account(
        init_if_needed,
        seeds = [WRITER_ASK_POT_USDC_SEED, option_mint.key().as_ref()],
        bump,
        payer = taker,
        token::mint = usdc_mint,
        token::authority = protocol_state,
    )]
    pub writer_ask_pot_usdc: Box<Account<'info, TokenAccount>>,

    /// Per-(series, backer) position — init on first fill (taker pays).
    /// backer = order.owner (the writer, NOT the taker).
    #[account(
        init_if_needed,
        seeds = [WRITER_ASK_POSITION_SEED, option_mint.key().as_ref(), order.owner.as_ref()],
        bump,
        payer = taker,
        space = 8 + WriterAskPosition::INIT_SPACE,
    )]
    pub writer_ask_position: Box<Account<'info, WriterAskPosition>>,

    /// USDC mint — pinned; used to init the pot USDC account.
    #[account(constraint = usdc_mint.key() == protocol_state.usdc_mint)]
    pub usdc_mint: Account<'info, SplMint>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}
