// =============================================================================
// instructions/place_trigger.rs — Stage a durable trigger (Phase 4 Pass 0)
// =============================================================================
//
// Trigger-order spec v1, §placement. NOT flag-gated: a user can stage and
// cancel triggers anytime; only execute_trigger (P1) checks AMERICAN_ENABLED.
//
// One call inits the TriggerOrder PDA and provisions the per-kind resources:
//
//   StopEntryBuy:
//     - init the trigger_escrow PDA: a classic SPL USDC token account, owner =
//       protocol_state. (Same raw create+init shape as post_order's Bid escrow,
//       list_v2_for_resale's escrow — house style, no Anchor `init` on a raw
//       token account.)
//     - escrow_amount = max_premium * quantity  (per-contract ceiling × qty).
//       THIS product is the canonical escrow figure; P1's peg ceiling must reuse
//       it verbatim. checked math; overflow → MathOverflow.
//     - transfer escrow_amount USDC owner → escrow (owner signs, classic).
//     - PRE-CREATE the owner's destination option ATA (Token-2022, idempotent)
//       so a P1 fire can never fail on a missing ATA. Store its key.
//     - max_premium must be > 0.
//
//   TakeProfitSell:
//     - no escrow; escrow_funded = false; reject a nonzero max_premium (store 0).
//     - SANITY ONLY: the caller passes the owner's existing Token-2022 ATA for
//       option_mint; verify mint + owner + balance >= quantity from the raw ATA
//       bytes (the exercise_american.rs:92-101 read). Balance is RE-checked at
//       fire (P1); this just stops obviously-bad placements. No escrow, no lock.
//
// USDC mint pin: pin to protocol_state.usdc_mint (locked reconciliation #1, same
// as post_order). Series/vault/market linkage is expressed as account
// constraints, mirroring fill_vault_peg exactly (vault_mint_record pins
// option_mint↔vault, market pinned to vault) — no looser in-handler invention.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, program::invoke_signed, system_instruction};
use anchor_spl::associated_token::{self, AssociatedToken, Create};
use anchor_spl::token::{self, spl_token, Mint, Token, Transfer};
use anchor_spl::token_2022::Token2022;
use spl_token_2022::extension::ExtensionType;

use crate::errors::OptaError;
use crate::events::TriggerPlaced;
use crate::state::*;

pub fn handle_place_trigger(
    ctx: Context<PlaceTrigger>,
    kind: TriggerKind,
    comparator: Comparator,
    threshold_usdc: u64,
    quantity: u64,
    max_premium: u64,
    nonce: u64,
) -> Result<()> {
    let clock = Clock::get()?;

    // ---- 1. Common pre-flight ---------------------------------------------
    require!(quantity > 0, OptaError::InvalidContractSize);

    let option_mint_key = ctx.accounts.option_mint.key();
    let owner_option_ata_key = ctx.accounts.owner_option_ata.key();

    // Per-kind resource provisioning + the stored escrow flag / max_premium.
    let (escrow_funded, stored_max_premium) = match kind {
        // -------------------------------------------------------------------
        TriggerKind::StopEntryBuy => {
            require!(max_premium > 0, OptaError::InvalidPremium);
            let escrow_amount = max_premium
                .checked_mul(quantity)
                .ok_or(OptaError::MathOverflow)?;

            // Create the classic SPL USDC escrow (owner = protocol_state, mint =
            // protocol_state.usdc_mint). The Token-2022 base account length (no
            // extensions) == the classic 165-byte SPL account length; reuse that
            // helper (post_order Bid pattern) to avoid pulling Pack into scope.
            let escrow_space =
                ExtensionType::try_calculate_account_len::<spl_token_2022::state::Account>(&[])
                    .map_err(|_| OptaError::MathOverflow)?;
            let escrow_lamports = Rent::get()?.minimum_balance(escrow_space);
            let token_classic_key = ctx.accounts.token_program.key();
            let order_key = ctx.accounts.trigger_order.key();
            let escrow_info = ctx.accounts.trigger_escrow.to_account_info();
            let escrow_seeds: &[&[u8]] = &[
                TRIGGER_ESCROW_SEED,
                order_key.as_ref(),
                &[ctx.bumps.trigger_escrow],
            ];

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
            invoke(
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
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.owner_usdc_account.to_account_info(),
                        to: escrow_info.clone(),
                        authority: ctx.accounts.owner.to_account_info(),
                    },
                ),
                escrow_amount,
            )?;

            // Pre-create the owner's destination option ATA (Token-2022),
            // idempotent. A mint is not a transfer, so no hook fires; create is
            // safe pre/post expiry. P1's peg mint_to lands here.
            associated_token::create_idempotent(CpiContext::new(
                ctx.accounts.associated_token_program.to_account_info(),
                Create {
                    payer: ctx.accounts.owner.to_account_info(),
                    associated_token: ctx.accounts.owner_option_ata.to_account_info(),
                    authority: ctx.accounts.owner.to_account_info(),
                    mint: ctx.accounts.option_mint.to_account_info(),
                    system_program: ctx.accounts.system_program.to_account_info(),
                    token_program: ctx.accounts.token_2022_program.to_account_info(),
                },
            ))?;

            (true, max_premium)
        }
        // -------------------------------------------------------------------
        // StopLossSell shares placement semantics with TakeProfitSell (both are
        // sells: no escrow, sanity-check the source ATA). StopLossSell's FIRE path
        // is dark until B2 — execute_trigger rejects it — but staging is harmless
        // and forward-compatible (B2 only wires the fire leg).
        TriggerKind::TakeProfitSell | TriggerKind::StopLossSell => {
            // Keep the field honest: a sell escrows nothing, so reject a nonzero
            // ceiling and store 0.
            require!(max_premium == 0, OptaError::InvalidPremium);

            // SANITY: the declared source ATA must be the owner's, on this mint,
            // and currently hold >= quantity. Raw Token-2022 layout:
            //   mint(0..32) / owner(32..64) / amount(64..72).
            let data = ctx.accounts.owner_option_ata.try_borrow_data()?;
            require!(data.len() >= 72, OptaError::InsufficientOptionTokens);
            let mint_bytes: [u8; 32] = data[0..32]
                .try_into()
                .map_err(|_| OptaError::MathOverflow)?;
            require!(
                Pubkey::new_from_array(mint_bytes) == option_mint_key,
                OptaError::InvalidVaultMint
            );
            let owner_bytes: [u8; 32] = data[32..64]
                .try_into()
                .map_err(|_| OptaError::MathOverflow)?;
            // The stored ATA must belong to the trigger owner — otherwise a
            // placement could point the P1 delegate-burn at a stranger's tokens.
            // P1 MUST re-verify this at fire (balance + owner) since balances
            // move; this is the placement-time half of that invariant.
            require!(
                Pubkey::new_from_array(owner_bytes) == ctx.accounts.owner.key(),
                OptaError::Unauthorized
            );
            let amount_bytes: [u8; 8] = data[64..72]
                .try_into()
                .map_err(|_| OptaError::MathOverflow)?;
            let balance = u64::from_le_bytes(amount_bytes);
            require!(balance >= quantity, OptaError::InsufficientOptionTokens);

            (false, 0u64)
        }
    };

    // ---- 2. Populate the TriggerOrder PDA ---------------------------------
    let order = &mut ctx.accounts.trigger_order;
    order.owner = ctx.accounts.owner.key();
    order.market = ctx.accounts.market.key();
    order.option_mint = option_mint_key;
    order.vault = ctx.accounts.shared_vault.key();
    order.kind = kind;
    order.comparator = comparator;
    order.threshold_usdc = threshold_usdc;
    order.quantity = quantity;
    order.max_premium = stored_max_premium;
    order.holder_option_ata = owner_option_ata_key;
    order.escrow_funded = escrow_funded;
    order.created_at = clock.unix_timestamp;
    order.nonce = nonce;
    order.bump = ctx.bumps.trigger_order;
    // OCO is wired in B3; placements are standalone until then.
    order.oco_link = None;

    emit!(TriggerPlaced {
        trigger_order: order.key(),
        owner: ctx.accounts.owner.key(),
        option_mint: option_mint_key,
        vault: ctx.accounts.shared_vault.key(),
        kind: kind.as_u8(),
        comparator: comparator.as_u8(),
        threshold_usdc,
        quantity,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(
    kind: TriggerKind,
    comparator: Comparator,
    threshold_usdc: u64,
    quantity: u64,
    max_premium: u64,
    nonce: u64,
)]
pub struct PlaceTrigger<'info> {
    /// Trigger owner — pays the trigger PDA + (BUY) escrow + dest-ATA rent, and
    /// signs the inbound USDC transfer on the BUY branch.
    #[account(mut)]
    pub owner: Signer<'info>,

    /// Market — pinned to the vault; provides pyth_feed_id for the P1 re-check.
    #[account(constraint = market.key() == shared_vault.market)]
    pub market: Account<'info, OptionsMarket>,

    /// The SharedVault: peg-fill source (BUY) / exercise-payout source (SELL).
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// Series/VaultMint record — pins option_mint↔vault (the mint↔vault proof,
    /// mirrors fill_vault_peg.rs:302-308 / exercise_american.rs:220-224).
    #[account(
        constraint = vault_mint_record.vault == shared_vault.key() @ OptaError::InvalidVaultMint,
        constraint = vault_mint_record.option_mint == option_mint.key() @ OptaError::InvalidVaultMint,
    )]
    pub vault_mint_record: Account<'info, VaultMint>,

    /// The Token-2022 option (series) mint this trigger trades. Part of the PDA
    /// seed; pinned via vault_mint_record.
    /// CHECK: validated via vault_mint_record + the ATA CPIs / raw reads.
    pub option_mint: UncheckedAccount<'info>,

    /// The TriggerOrder PDA — created here. One per (owner, option_mint, nonce).
    #[account(
        init,
        seeds = [
            TRIGGER_ORDER_SEED,
            owner.key().as_ref(),
            option_mint.key().as_ref(),
            &nonce.to_le_bytes(),
        ],
        bump,
        payer = owner,
        space = 8 + TriggerOrder::INIT_SPACE,
    )]
    pub trigger_order: Box<Account<'info, TriggerOrder>>,

    /// Per-trigger USDC escrow PDA (BUY only), owner = protocol_state. Created
    /// in-handler via raw CPI on the BUY branch; on the SELL branch this is the
    /// derived (uninitialized) address and is never touched.
    /// CHECK: PDA seeds validate the address; classic SPL USDC layout (BUY).
    #[account(
        mut,
        seeds = [TRIGGER_ESCROW_SEED, trigger_order.key().as_ref()],
        bump,
    )]
    pub trigger_escrow: UncheckedAccount<'info>,

    /// Protocol state — escrow's owner authority + canonical USDC mint pin.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Canonical USDC mint — used to init the BUY escrow; pinned to protocol_state.
    #[account(constraint = usdc_mint.key() == protocol_state.usdc_mint)]
    pub usdc_mint: Account<'info, Mint>,

    /// Owner's USDC account — BUY escrow source (unused on the SELL branch).
    /// CHECK: mint enforced by the SPL transfer (from.mint == escrow.mint),
    /// owner by the owner signature.
    #[account(mut)]
    pub owner_usdc_account: UncheckedAccount<'info>,

    /// Owner's option ATA on `option_mint`.
    ///   BUY : the mint destination — pre-created idempotently here.
    ///   SELL: the existing source to delegate-burn at fire — read for sanity.
    /// CHECK: BUY → created/validated by the AssociatedToken CPI; SELL →
    /// mint/owner/balance validated from raw bytes in the handler.
    #[account(mut)]
    pub owner_option_ata: UncheckedAccount<'info>,

    /// Classic SPL Token program — BUY escrow create/init + USDC transfer.
    pub token_program: Program<'info, Token>,
    /// Token-2022 program — destination ATA creation (BUY).
    pub token_2022_program: Program<'info, Token2022>,
    /// Associated-token program — idempotent dest-ATA create (BUY).
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
    pub rent: Sysvar<'info, Rent>,
}
