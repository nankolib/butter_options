// =============================================================================
// instructions/post_order.rs — Post a resting bid or ask into the series book
// =============================================================================
//
// Phase 1 of the Opta Exchange (exchange-spec §6.3, Step 2). Generalizes
// list_v2_for_resale into a two-sided book. One call creates a RestingOrder
// PDA + its per-order escrow, and moves the collateral into escrow:
//
//   ResaleAsk: escrow is a Token-2022 account (TransferHookAccount-sized,
//              owner = protocol_state). `quantity` option tokens move
//              owner → escrow via invoke_transfer_checked (owner signs, hook
//              fires; pre-expiry it allows). Mirrors list_v2_for_resale.rs:54-120.
//   Bid:       escrow is a plain SPL USDC account (owner = protocol_state,
//              mint = protocol_state.usdc_mint). `price × quantity` USDC moves
//              owner → escrow via classic token::transfer (owner signs).
//   WriterAsk: rejected with WriterAsksDisabled until Phase 3.
//
// USDC mint pin (locked reconciliation #1): all book code pins to
// protocol_state.usdc_mint, never shared_vault.collateral_mint (the two are
// provably equal — create_shared_vault.rs:69 — but we use the canonical one).
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_instruction};
use anchor_spl::token::{self, spl_token, Token, Transfer};
use anchor_spl::token_2022::Token2022;
use spl_token_2022::extension::ExtensionType;

use crate::errors::OptaError;
use crate::events::OrderPosted;
use crate::feature_flags::WRITER_ASKS_ENABLED;
use crate::state::*;
use crate::utils::collateral::required_collateral_per_contract;

pub fn handle_post_order(
    ctx: Context<PostOrder>,
    kind: OrderKind,
    price_per_contract: u64,
    quantity: u64,
    nonce: u64,
) -> Result<()> {
    let clock = Clock::get()?;
    let vault = &ctx.accounts.shared_vault;

    // ---- 1. Common pre-flight checks --------------------------------------
    // Phase 3 Slice A: the WriterAsk top reject is removed; the dark gate moved
    // into the WriterAsk match arm below (require!(WRITER_ASKS_ENABLED, ...)).
    // Phase 2 Pass B: the vault peg is VIRTUAL (priced + minted on the fly by
    // fill_vault_peg) — it is never a resting order. Refuse it at the only
    // client-reachable entry point. Reuses WriterAsksDisabled (no new error
    // code) since both kinds are simply non-postable through the book.
    require!(kind != OrderKind::VaultPeg, OptaError::WriterAsksDisabled);
    require!(quantity > 0, OptaError::InvalidContractSize);
    require!(price_per_contract > 0, OptaError::InvalidContractSize);
    require!(!vault.is_settled, OptaError::VaultAlreadySettled);
    require!(clock.unix_timestamp < vault.expiry, OptaError::VaultExpired);

    let token_2022_key = ctx.accounts.token_2022_program.key();
    let order_key = ctx.accounts.order.key();
    let escrow_info = ctx.accounts.escrow.to_account_info();
    let escrow_seeds: &[&[u8]] = &[
        RESTING_ORDER_ESCROW_SEED,
        order_key.as_ref(),
        &[ctx.bumps.escrow],
    ];

    // ---- 2. Branch: create escrow + move collateral in --------------------
    // Snapshotted onto the order in section 3. 0 = N/A (Bid / ResaleAsk); set to
    // the protocol cpt on the WriterAsk arm (lock-at-post personal collateral).
    let mut collateral_per_contract: u64 = 0;
    match kind {
        OrderKind::ResaleAsk => {
            // Seller balance: raw Token-2022 amount at bytes 64..72.
            {
                let data = ctx.accounts.owner_option_account.try_borrow_data()?;
                require!(data.len() >= 72, OptaError::MathOverflow);
                let amount_bytes: [u8; 8] = data[64..72]
                    .try_into()
                    .map_err(|_| OptaError::MathOverflow)?;
                let balance = u64::from_le_bytes(amount_bytes);
                require!(quantity <= balance, OptaError::InsufficientOptionTokens);
            }

            // Create the Token-2022 escrow (TransferHookAccount-sized), owner =
            // protocol_state. Mirrors list_v2_for_resale.rs:54-100.
            let escrow_space =
                ExtensionType::try_calculate_account_len::<spl_token_2022::state::Account>(
                    &[ExtensionType::TransferHookAccount],
                )
                .map_err(|_| OptaError::MathOverflow)?;
            let escrow_lamports = Rent::get()?.minimum_balance(escrow_space);

            invoke_signed(
                &system_instruction::create_account(
                    ctx.accounts.owner.key,
                    escrow_info.key,
                    escrow_lamports,
                    escrow_space as u64,
                    &token_2022_key,
                ),
                &[ctx.accounts.owner.to_account_info(), escrow_info.clone()],
                &[escrow_seeds],
            )?;
            anchor_lang::solana_program::program::invoke(
                &spl_token_2022::instruction::initialize_account3(
                    &token_2022_key,
                    escrow_info.key,
                    ctx.accounts.option_mint.key,
                    &ctx.accounts.protocol_state.key(),
                )?,
                &[escrow_info.clone(), ctx.accounts.option_mint.to_account_info()],
            )?;

            // Move tokens owner → escrow (owner signs, no PDA seeds). decimals
            // = 0 by protocol invariant (mint_from_vault.rs:212).
            spl_token_2022::onchain::invoke_transfer_checked(
                &token_2022_key,
                ctx.accounts.owner_option_account.to_account_info(),
                ctx.accounts.option_mint.to_account_info(),
                escrow_info.clone(),
                ctx.accounts.owner.to_account_info(),
                &[
                    ctx.accounts.extra_account_meta_list.to_account_info(),
                    ctx.accounts.transfer_hook_program.to_account_info(),
                    ctx.accounts.hook_state.to_account_info(),
                ],
                quantity,
                0,
                &[],
            )?;
        }
        OrderKind::Bid => {
            let total = (price_per_contract as u128)
                .checked_mul(quantity as u128)
                .ok_or(OptaError::MathOverflow)?;
            let total: u64 = total.try_into().map_err(|_| OptaError::MathOverflow)?;

            // Create the classic SPL USDC escrow (owner = protocol_state, mint =
            // protocol_state.usdc_mint). Same raw create+init shape as the ask
            // escrow, but classic 165-byte layout on the legacy Token program.
            // The Token-2022 base account length (no extensions) == the classic
            // 165-byte SPL account length, so we reuse that helper to avoid
            // pulling the Pack trait into scope.
            let escrow_space =
                ExtensionType::try_calculate_account_len::<spl_token_2022::state::Account>(&[])
                    .map_err(|_| OptaError::MathOverflow)?;
            let escrow_lamports = Rent::get()?.minimum_balance(escrow_space);
            let token_classic_key = ctx.accounts.token_program.key();

            invoke_signed(
                &system_instruction::create_account(
                    ctx.accounts.owner.key,
                    escrow_info.key,
                    escrow_lamports,
                    escrow_space as u64,
                    &token_classic_key,
                ),
                &[ctx.accounts.owner.to_account_info(), escrow_info.clone()],
                &[escrow_seeds],
            )?;
            anchor_lang::solana_program::program::invoke(
                &spl_token::instruction::initialize_account3(
                    &token_classic_key,
                    escrow_info.key,
                    &ctx.accounts.usdc_mint.key(),
                    &ctx.accounts.protocol_state.key(),
                )?,
                &[escrow_info.clone(), ctx.accounts.usdc_mint.to_account_info()],
            )?;

            // Move USDC owner → escrow (owner signs). SPL transfer enforces
            // from.mint == escrow.mint, so a non-USDC source is rejected here.
            if total > 0 {
                token::transfer(
                    CpiContext::new(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.owner_usdc_account.to_account_info(),
                            to: escrow_info.clone(),
                            authority: ctx.accounts.owner.to_account_info(),
                        },
                    ),
                    total,
                )?;
            }
        }
        OrderKind::WriterAsk => {
            // Dark gate (Phase 3 Slice A): reachable only under the `testing`
            // feature; a feature-free production build rejects with 6054. The
            // top-of-handler reject moved here — no new error code.
            require!(WRITER_ASKS_ENABLED, OptaError::WriterAsksDisabled);

            // American-only series (D12). AMERICAN_ENABLED is permanently true
            // post Stage-I, but we keep the gate for parity with fill_vault_peg
            // and to fail closed if it ever flips back.
            require!(
                crate::feature_flags::AMERICAN_ENABLED,
                OptaError::AmericanVaultsDisabled
            );
            require!(
                vault.exercise_style == ExerciseStyle::American,
                OptaError::NotAmericanOption
            );

            // Phase 3 Slice D2.5: writer-asks may ONLY rest on the CANONICAL
            // create_series mint. The canonical-series record sentinels
            // writer == Pubkey::default (create_series.rs); a per-writer
            // mint_from_vault record sets writer = the minter. A WriterAsk on a
            // per-writer mint would create a pot keyed by a mint NOT derivable
            // from vault identity → unreconcilable on the void path (D3's
            // initialize_void derives the canonical pot only) → stranded
            // collateral. Pinning here makes one-canonical-pot-per-vault a hard
            // invariant. (Dark-gate-first ordering preserved: feature-free reverts
            // 6054 above; a European vault reverts NotAmericanOption above.)
            require!(
                ctx.accounts.vault_mint_record.writer == Pubkey::default(),
                OptaError::CanonicalMintRequired
            );

            // Protocol-set collateral per contract — the writer does NOT choose
            // it. Symmetric 1× strike, the exact source mint_from_vault /
            // fill_vault_peg use, so post-time and fill-time cpt agree.
            let cpt = required_collateral_per_contract(vault.strike_price, vault.option_type);
            collateral_per_contract = cpt;
            let total = (cpt as u128)
                .checked_mul(quantity as u128)
                .ok_or(OptaError::MathOverflow)?;
            let total: u64 = total.try_into().map_err(|_| OptaError::MathOverflow)?;

            // Clean pre-flight balance error (reuses InsufficientCollateral — no
            // new error code). Writer USDC amount at bytes 64..72.
            {
                let data = ctx.accounts.owner_usdc_account.try_borrow_data()?;
                require!(data.len() >= 72, OptaError::MathOverflow);
                let bal = u64::from_le_bytes(
                    data[64..72]
                        .try_into()
                        .map_err(|_| OptaError::MathOverflow)?,
                );
                require!(bal >= total, OptaError::InsufficientCollateral);
            }

            // === Bid USDC-escrow mechanic, verbatim (only `total` differs) ====
            // Plain SPL USDC escrow (owner = protocol_state, mint =
            // protocol_state.usdc_mint), same 165-byte create+init shape as Bid.
            let escrow_space =
                ExtensionType::try_calculate_account_len::<spl_token_2022::state::Account>(&[])
                    .map_err(|_| OptaError::MathOverflow)?;
            let escrow_lamports = Rent::get()?.minimum_balance(escrow_space);
            let token_classic_key = ctx.accounts.token_program.key();

            invoke_signed(
                &system_instruction::create_account(
                    ctx.accounts.owner.key,
                    escrow_info.key,
                    escrow_lamports,
                    escrow_space as u64,
                    &token_classic_key,
                ),
                &[ctx.accounts.owner.to_account_info(), escrow_info.clone()],
                &[escrow_seeds],
            )?;
            anchor_lang::solana_program::program::invoke(
                &spl_token::instruction::initialize_account3(
                    &token_classic_key,
                    escrow_info.key,
                    &ctx.accounts.usdc_mint.key(),
                    &ctx.accounts.protocol_state.key(),
                )?,
                &[escrow_info.clone(), ctx.accounts.usdc_mint.to_account_info()],
            )?;

            // Move USDC owner → escrow (owner signs). SPL transfer enforces
            // from.mint == escrow.mint, so a non-USDC source is rejected here.
            if total > 0 {
                token::transfer(
                    CpiContext::new(
                        ctx.accounts.token_program.to_account_info(),
                        Transfer {
                            from: ctx.accounts.owner_usdc_account.to_account_info(),
                            to: escrow_info.clone(),
                            authority: ctx.accounts.owner.to_account_info(),
                        },
                    ),
                    total,
                )?;
            }
        }
        OrderKind::VaultPeg => unreachable!("rejected above"),
    }

    // ---- 3. Populate the RestingOrder PDA ---------------------------------
    let order = &mut ctx.accounts.order;
    order.owner = ctx.accounts.owner.key();
    order.option_mint = ctx.accounts.option_mint.key();
    order.vault = ctx.accounts.shared_vault.key();
    order.kind = kind;
    order.price_per_contract = price_per_contract;
    order.quantity_remaining = quantity;
    order.quantity_initial = quantity;
    order.created_at = clock.unix_timestamp;
    order.nonce = nonce;
    order.bump = ctx.bumps.order;
    order.collateral_per_contract = collateral_per_contract;

    emit!(OrderPosted {
        order: order_key,
        owner: ctx.accounts.owner.key(),
        option_mint: ctx.accounts.option_mint.key(),
        vault: ctx.accounts.shared_vault.key(),
        kind: kind.as_u8(),
        price_per_contract,
        quantity,
        nonce,
        ts: clock.unix_timestamp,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(kind: OrderKind, price_per_contract: u64, quantity: u64, nonce: u64)]
pub struct PostOrder<'info> {
    /// Order owner — pays for the order PDA + escrow rent, signs the inbound
    /// collateral transfer.
    #[account(mut)]
    pub owner: Signer<'info>,

    /// The vault the option mint belongs to. Read for expiry / settled guards.
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// Market — pinned to the vault for sanity.
    #[account(constraint = market.key() == shared_vault.market)]
    pub market: Account<'info, OptionsMarket>,

    /// VaultMint record — pins option_mint to this vault (mint↔vault proof,
    /// same constraint set as buy_v2_resale.rs:208-215).
    #[account(
        constraint = vault_mint_record.vault == shared_vault.key()
            @ OptaError::InvalidVaultMint,
        constraint = vault_mint_record.option_mint == option_mint.key()
            @ OptaError::InvalidVaultMint,
    )]
    pub vault_mint_record: Account<'info, VaultMint>,

    /// Token-2022 option mint being traded.
    /// CHECK: validated via vault_mint_record + Token-2022 transfer CPI.
    #[account(mut)]
    pub option_mint: UncheckedAccount<'info>,

    /// The RestingOrder PDA — created here. One per (option_mint, owner, nonce).
    #[account(
        init,
        seeds = [
            RESTING_ORDER_SEED,
            option_mint.key().as_ref(),
            owner.key().as_ref(),
            &nonce.to_le_bytes(),
        ],
        bump,
        payer = owner,
        space = 8 + RestingOrder::INIT_SPACE,
    )]
    pub order: Box<Account<'info, RestingOrder>>,

    /// Per-order escrow PDA, owner = protocol_state. Token-2022 for asks, classic
    /// USDC for bids — created in-handler via raw CPI.
    /// CHECK: PDA seeds validate the address; layout depends on `kind`.
    #[account(
        mut,
        seeds = [RESTING_ORDER_ESCROW_SEED, order.key().as_ref()],
        bump,
    )]
    pub escrow: UncheckedAccount<'info>,

    /// Protocol state — escrow's owner authority + canonical USDC mint pin.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Owner's option ATA — source on the ResaleAsk branch (unused for Bid).
    /// CHECK: balance + ownership validated by the Token-2022 transfer.
    #[account(mut)]
    pub owner_option_account: UncheckedAccount<'info>,

    /// Owner's USDC account — source on the Bid branch (unused for ResaleAsk).
    /// CHECK: mint enforced by SPL transfer (from.mint == escrow.mint), owner by
    /// the owner signature.
    #[account(mut)]
    pub owner_usdc_account: UncheckedAccount<'info>,

    /// Canonical USDC mint — used to init the Bid escrow; pinned to protocol_state.
    #[account(constraint = usdc_mint.key() == protocol_state.usdc_mint)]
    pub usdc_mint: Account<'info, anchor_spl::token::Mint>,

    /// Transfer hook program — pinned to the known opta-transfer-hook ID.
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
    pub rent: Sysvar<'info, Rent>,
}
