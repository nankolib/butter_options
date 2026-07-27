// =============================================================================
// instructions/execute_trigger.rs — Keeper fires a trigger (Phase 4 Pass 1)
// =============================================================================
//
// The keeper (off-chain, P2) watches live Pyth prices and calls this when a
// stored TriggerOrder's condition crosses. The keeper's assertion is NEVER
// trusted: execute_trigger re-reads a FRESH Pyth EMA in-tx and re-checks the
// stored comparator itself before acting. It then routes to the SAME shared
// cores the direct instructions use:
//
//   StopEntryBuy   → vault_peg_fill_core (escrow PDA pays, mints to owner's ATA)
//   TakeProfitSell → american_exercise_core (delegate burns, vault pays owner)
//
// Flag-gated: require!(AMERICAN_ENABLED) is the FIRST line (6052 while dark).
// AMERICAN_ENABLED is LIVE (flipped Jun 18) so this is active the moment it
// deploys — no dark buffer.
//
// ⚠️ COMPUTE BUDGET: the BUY path (post_update_atomic + EMA re-check + vol_oracle
// + full peg set + BS-2002) is the heaviest tx in the protocol (~250-280K CU for
// the pricing kernel alone). The instruction can't set its own budget — CALLERS
// MUST prepend ComputeBudgetProgram.setComputeUnitLimit(~400_000). The P2 keeper
// does this.
//
// FIRE-TIME RE-VERIFICATION (SELL): the cores TRUST their token-account params.
// Because the SELL burn source is a STORED address (possibly stale or hostile),
// execute_trigger's HANDLER re-asserts holder_option_ata.owner == owner and
// .mint == option_mint (6060) and re-reads the live balance BEFORE calling the
// core. This is the theft-vector guard — exercise_american needs none (its
// source is constraint-pinned to the signer).
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_program};
use anchor_spl::token::{self, spl_token, Token, TokenAccount, Transfer};
use anchor_spl::token_2022::Token2022;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

use crate::errors::OptaError;
use crate::events::{TriggerExecuted, TriggerSkipped};
use crate::feature_flags::AMERICAN_ENABLED;
use crate::instructions::exercise_american::{
    american_exercise_core, MAX_CONF_BPS, PRICE_MAX_AGE_SECS,
};
use crate::instructions::fill_vault_peg::vault_peg_fill_core;
use crate::instructions::fill_writer_ask::writer_ask_fill_core;
use crate::instructions::fill_order::resale_ask_fill_core;
use crate::feature_flags::BOOK_TRIGGERS_ENABLED;
use crate::state::*;
use crate::utils::price_oracle::{
    find_ed25519_ix_index, pyth_current_spot_usdc, sb_current_spot_usdc, secs_to_slots,
    SB_MIN_ORACLE_SAMPLES_FLOOR,
};
use super::initialize_protocol::TREASURY_SEED;

/// Manual conditional close: drain rent → `dest`, zero the account, hand it back
/// to the system program. The fill_order / auto_finalize_writers idiom (Anchor
/// `close =` can't be conditional — a SELL closes only on full fill).
fn close_trigger_order<'info>(
    order_info: &AccountInfo<'info>,
    dest_info: &AccountInfo<'info>,
) -> Result<()> {
    let rent_lamports = order_info.lamports();
    **dest_info.try_borrow_mut_lamports()? = dest_info
        .lamports()
        .checked_add(rent_lamports)
        .ok_or(OptaError::MathOverflow)?;
    **order_info.try_borrow_mut_lamports()? = 0;
    order_info.assign(&system_program::ID);
    order_info.resize(0)?;
    Ok(())
}

pub fn handle_execute_trigger(ctx: Context<ExecuteTrigger>) -> Result<()> {
    let clock = Clock::get()?;

    // 1. Flag gate FIRST (spec strict order). 6052 while AMERICAN_ENABLED=false.
    require!(AMERICAN_ENABLED, OptaError::AmericanVaultsDisabled);

    // 2. Fresh spot, ROUTED by market.oracle_source (Stage 3 wiring 1a-ii).
    //    This is the SINGLE match site in execute_trigger: the direct EMA feeds
    //    BOTH the comparator re-check (below) AND the SELL intrinsic (passed to
    //    american_exercise_core). The BUY peg reads the CACHED
    //    VolOracle.last_spot_price via price_american and needs NO routing here —
    //    it becomes SB-sourced automatically once 1a-iii routes push_vol_sample.
    //    Pyth arm is byte-for-byte the pre-Stage-3 read (60s / 200bps); the SB
    //    arm mirrors exercise_american's (60s → secs_to_slots → 150 slots).
    let oracle_source = ctx.accounts.market.oracle_source;
    let feed_id = ctx.accounts.market.pyth_feed_id;
    let ema = match oracle_source {
        ORACLE_SOURCE_PYTH => {
            let price_update = ctx
                .accounts
                .price_update
                .as_ref()
                .ok_or(error!(OptaError::PriceUpdateMissing))?;
            pyth_current_spot_usdc(
                price_update,
                feed_id,
                clock.unix_timestamp,
                PRICE_MAX_AGE_SECS,
                MAX_CONF_BPS,
            )?
        }
        ORACLE_SOURCE_SWITCHBOARD => {
            let queue = ctx
                .accounts
                .sb_queue
                .as_ref()
                .ok_or(error!(OptaError::SwitchboardAccountsMissing))?;
            let slothashes = ctx
                .accounts
                .sb_slothashes
                .as_ref()
                .ok_or(error!(OptaError::SwitchboardAccountsMissing))?;
            let instructions = ctx
                .accounts
                .sb_instructions
                .as_ref()
                .ok_or(error!(OptaError::SwitchboardAccountsMissing))?;
            require_keys_eq!(
                slothashes.key(),
                anchor_lang::solana_program::sysvar::slot_hashes::ID,
                OptaError::InvalidSwitchboardSysvar
            );
            require_keys_eq!(
                instructions.key(),
                anchor_lang::solana_program::sysvar::instructions::ID,
                OptaError::InvalidSwitchboardSysvar
            );
            let instructions_ai = instructions.to_account_info();
            let ed25519_ix_index = find_ed25519_ix_index(&instructions_ai)?;
            sb_current_spot_usdc(
                &queue.to_account_info(),
                &slothashes.to_account_info(),
                &instructions_ai,
                ed25519_ix_index,
                clock.slot,
                secs_to_slots(PRICE_MAX_AGE_SECS),
                feed_id,
                SB_MIN_ORACLE_SAMPLES_FLOOR,
            )?
        }
        _ => return Err(error!(OptaError::InvalidOracleSource)),
    };

    // 3. Re-check the stored comparator against the live EMA.
    let threshold = ctx.accounts.trigger_order.threshold_usdc;
    match ctx.accounts.trigger_order.comparator {
        Comparator::LessOrEqual => {
            require!(ema <= threshold, OptaError::TriggerConditionNotMet)
        }
        Comparator::GreaterOrEqual => {
            require!(ema >= threshold, OptaError::TriggerConditionNotMet)
        }
    }

    // 4. Dispatch on kind.
    let kind = ctx.accounts.trigger_order.kind;
    let owner = ctx.accounts.trigger_order.owner;
    let order_key = ctx.accounts.trigger_order.key();

    match kind {
        // ---------------------------------------------------------------------
        TriggerKind::StopEntryBuy => {
          if BOOK_TRIGGERS_ENABLED && ctx.accounts.book_order.is_some() {
            // ============ BOOK PATH: lift a live writer ask ============
            // Trigger escrow pays the ask premium (escrow-pays arm); the series is
            // minted to the owner's ATA; the writer's collateral moves escrow→pot.
            // fire_qty = min(trigger.quantity, ask depth); remainder stays armed.
            let (ask_price, ask_cpt, ask_mint, ask_vault, ask_owner, ask_remaining, ask_kind, ask_key) = {
                let o = ctx.accounts.book_order.as_ref().unwrap();
                (o.price_per_contract, o.collateral_per_contract, o.option_mint, o.vault,
                 o.owner, o.quantity_remaining, o.kind, o.key())
            };
            // Accept a WriterAsk (primary) or a ResaleAsk (secondary). The keeper
            // chooses which order to pass — a ResaleAsk only when it is better-priced
            // than the best WriterAsk yet still within max_premium (checked below).
            require!(
                ask_kind == OrderKind::WriterAsk || ask_kind == OrderKind::ResaleAsk,
                OptaError::NotAWriterAsk
            );
            require!(ask_mint == ctx.accounts.trigger_order.option_mint, OptaError::InvalidVaultMint);
            require!(ask_vault == ctx.accounts.trigger_order.vault, OptaError::InvalidVaultMint);
            require!(ask_price <= ctx.accounts.trigger_order.max_premium, OptaError::AskPriceExceedsMax);

            // Shared validation: maker pin, per-order escrow PDA, maker USDC owner.
            // The escrow seed [resting_order_escrow, order] is identical for both
            // kinds (only the token program / held asset differ).
            let book_maker_key = ctx.accounts.book_maker.as_ref().unwrap().key();
            require_keys_eq!(book_maker_key, ask_owner, OptaError::WriterWalletMismatch);
            let (exp_escrow, _) = Pubkey::find_program_address(&[RESTING_ORDER_ESCROW_SEED, ask_key.as_ref()], &crate::ID);
            require_keys_eq!(ctx.accounts.book_escrow.as_ref().unwrap().key(), exp_escrow, OptaError::InvalidVaultMint);
            require!(ctx.accounts.book_maker_usdc.as_ref().unwrap().owner == ask_owner, OptaError::WriterWalletMismatch);

            let want = ctx.accounts.trigger_order.quantity;
            let fire_qty = want.min(ask_remaining);
            if fire_qty == 0 {
                // Benign: no depth on the passed ask. Stay armed, no revert.
                emit!(TriggerSkipped { trigger_order: order_key, owner, reason: 1, ts: clock.unix_timestamp });
                return Ok(());
            }

            let protocol_bump = ctx.accounts.protocol_state.bump;
            let fee_bps = ctx.accounts.protocol_state.fee_bps;
            let trigger_escrow_ai = ctx.accounts.trigger_escrow.to_account_info();
            let protocol_ai = ctx.accounts.protocol_state.to_account_info();
            let treasury_ai = ctx.accounts.treasury.to_account_info();
            let option_mint_ai = ctx.accounts.option_mint.to_account_info();
            let holder_ata_ai = ctx.accounts.holder_option_ata.to_account_info();
            let tok_ai = ctx.accounts.token_program.to_account_info();
            let tok22_ai = ctx.accounts.token_2022_program.to_account_info();
            let book_escrow_ai = ctx.accounts.book_escrow.as_ref().unwrap().to_account_info();
            let book_maker_usdc_ai = ctx.accounts.book_maker_usdc.as_ref().unwrap().to_account_info();

            // Fill — escrow-pays (usdc_source = trigger_escrow, Some(protocol_bump)).
            // Returns the gross premium (fire_qty × ask_price) charged to the escrow,
            // used below for the TriggerExecuted event.
            let fill_total: u64 = match ask_kind {
                OrderKind::WriterAsk => {
                    // WriterAsk-only pot/position PDAs ([25]-[27]).
                    let (exp_pot, _) = Pubkey::find_program_address(&[WRITER_ASK_POT_SEED, ask_mint.as_ref()], &crate::ID);
                    require_keys_eq!(ctx.accounts.writer_ask_pot.as_ref().unwrap().key(), exp_pot, OptaError::InvalidVaultMint);
                    let (exp_pot_usdc, _) = Pubkey::find_program_address(&[WRITER_ASK_POT_USDC_SEED, ask_mint.as_ref()], &crate::ID);
                    require_keys_eq!(ctx.accounts.writer_ask_pot_usdc.as_ref().unwrap().key(), exp_pot_usdc, OptaError::InvalidVaultMint);
                    let (exp_pos, _) = Pubkey::find_program_address(&[WRITER_ASK_POSITION_SEED, ask_mint.as_ref(), ask_owner.as_ref()], &crate::ID);
                    require_keys_eq!(ctx.accounts.writer_ask_position.as_ref().unwrap().key(), exp_pos, OptaError::InvalidVaultMint);

                    let pot_usdc_ai = ctx.accounts.writer_ask_pot_usdc.as_ref().unwrap().to_account_info();
                    let pot_usdc_key = ctx.accounts.writer_ask_pot_usdc.as_ref().unwrap().key();
                    let pot_bump = ctx.accounts.writer_ask_pot.as_ref().unwrap().bump;
                    let position_bump = ctx.accounts.writer_ask_position.as_ref().unwrap().bump;

                    let fill = writer_ask_fill_core(
                        ask_price, ask_cpt, fire_qty, fee_bps, protocol_bump,
                        &trigger_escrow_ai, &protocol_ai, Some(protocol_bump),
                        &book_maker_usdc_ai, &treasury_ai,
                        &option_mint_ai, &holder_ata_ai, &protocol_ai,
                        &book_escrow_ai, &pot_usdc_ai,
                        ctx.accounts.writer_ask_pot.as_mut().unwrap(),
                        ctx.accounts.writer_ask_position.as_mut().unwrap(),
                        ask_mint, ask_vault, ask_owner, pot_usdc_key, pot_bump, position_bump, clock.unix_timestamp,
                        &tok_ai, &tok22_ai,
                    )?;
                    fill.total
                }
                OrderKind::ResaleAsk => {
                    // ResaleAsk-only hook accounts ([28]-[30]); the option-token leg
                    // is a Token-2022 transfer_checked that dispatches the hook.
                    require_keys_eq!(
                        ctx.accounts.resale_hook_program.as_ref().unwrap().key(),
                        opta_transfer_hook::ID,
                        OptaError::InvalidVaultMint
                    );
                    let metas_ai = ctx.accounts.resale_hook_metas.as_ref().unwrap().to_account_info();
                    let prog_ai = ctx.accounts.resale_hook_program.as_ref().unwrap().to_account_info();
                    let state_ai = ctx.accounts.resale_hook_state.as_ref().unwrap().to_account_info();

                    // Fee split (mirrors fill_order.rs:242-255 exactly).
                    let total: u64 = (fire_qty as u128)
                        .checked_mul(ask_price as u128)
                        .ok_or(OptaError::MathOverflow)?
                        .try_into()
                        .map_err(|_| OptaError::MathOverflow)?;
                    let fee: u64 = (total as u128)
                        .checked_mul(fee_bps as u128)
                        .ok_or(OptaError::MathOverflow)?
                        .checked_div(10_000)
                        .ok_or(OptaError::MathOverflow)?
                        .try_into()
                        .map_err(|_| OptaError::MathOverflow)?;
                    let counterparty_share = total.checked_sub(fee).ok_or(OptaError::MathOverflow)?;

                    resale_ask_fill_core(
                        &trigger_escrow_ai, &protocol_ai, Some(protocol_bump),
                        &book_maker_usdc_ai, &treasury_ai,
                        &book_escrow_ai, &option_mint_ai, &holder_ata_ai,
                        &metas_ai, &prog_ai, &state_ai,
                        &protocol_ai, protocol_bump,
                        &tok_ai, &tok22_ai,
                        fire_qty, counterparty_share, fee,
                    )?;
                    total
                }
                // Rejected by the require! above; kept exhaustive for the compiler.
                _ => return err!(OptaError::NotAWriterAsk),
            };

            let protocol_seeds: &[&[u8]] = &[PROTOCOL_SEED, &[protocol_bump]];
            let protocol_signer: &[&[&[u8]]] = &[protocol_seeds];

            // Ask order bookkeeping (mirror fill_writer_ask step 9).
            let ask_closed = {
                let o = ctx.accounts.book_order.as_mut().unwrap();
                o.quantity_remaining = o.quantity_remaining.checked_sub(fire_qty).ok_or(OptaError::MathOverflow)?;
                o.quantity_remaining == 0
            };
            if ask_closed {
                {
                    let data = ctx.accounts.book_escrow.as_ref().unwrap().try_borrow_data()?;
                    require!(data.len() >= 72, OptaError::MathOverflow);
                    let bal = u64::from_le_bytes(data[64..72].try_into().map_err(|_| OptaError::MathOverflow)?);
                    require!(bal == 0, OptaError::EscrowNotEmpty);
                }
                // Close the emptied escrow; rent → maker. The token program is
                // kind-specific: a WriterAsk escrow is a classic-SPL USDC account,
                // a ResaleAsk escrow is a Token-2022 option-token account.
                let (close_prog_key, close_prog_ai) = match ask_kind {
                    OrderKind::WriterAsk => (
                        ctx.accounts.token_program.key(),
                        ctx.accounts.token_program.to_account_info(),
                    ),
                    _ => (
                        ctx.accounts.token_2022_program.key(),
                        ctx.accounts.token_2022_program.to_account_info(),
                    ),
                };
                let close_ix = if ask_kind == OrderKind::WriterAsk {
                    spl_token::instruction::close_account(
                        &close_prog_key,
                        ctx.accounts.book_escrow.as_ref().unwrap().key,
                        &book_maker_key,
                        &ctx.accounts.protocol_state.key(),
                        &[],
                    )?
                } else {
                    spl_token_2022::instruction::close_account(
                        &close_prog_key,
                        ctx.accounts.book_escrow.as_ref().unwrap().key,
                        &book_maker_key,
                        &ctx.accounts.protocol_state.key(),
                        &[],
                    )?
                };
                invoke_signed(
                    &close_ix,
                    &[
                        ctx.accounts.book_escrow.as_ref().unwrap().to_account_info(),
                        ctx.accounts.book_maker.as_ref().unwrap().to_account_info(),
                        ctx.accounts.protocol_state.to_account_info(),
                        close_prog_ai,
                    ],
                    protocol_signer,
                )?;
                let order_info = ctx.accounts.book_order.as_ref().unwrap().to_account_info();
                let maker_info = ctx.accounts.book_maker.as_ref().unwrap().to_account_info();
                let rent = order_info.lamports();
                **maker_info.try_borrow_mut_lamports()? = maker_info.lamports().checked_add(rent).ok_or(OptaError::MathOverflow)?;
                **order_info.try_borrow_mut_lamports()? = 0;
                order_info.assign(&system_program::ID);
                order_info.resize(0)?;
            }

            // Trigger bookkeeping: decrement; on full fill refund remaining escrow + close.
            let remaining = {
                let t = &mut ctx.accounts.trigger_order;
                t.quantity = t.quantity.checked_sub(fire_qty).ok_or(OptaError::MathOverflow)?;
                t.quantity
            };
            if remaining == 0 {
                let esc_bal = {
                    let data = ctx.accounts.trigger_escrow.try_borrow_data()?;
                    require!(data.len() >= 72, OptaError::MathOverflow);
                    u64::from_le_bytes(data[64..72].try_into().map_err(|_| OptaError::MathOverflow)?)
                };
                if esc_bal > 0 {
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
                        esc_bal,
                    )?;
                }
                invoke_signed(
                    &spl_token::instruction::close_account(
                        &ctx.accounts.token_program.key(),
                        ctx.accounts.trigger_escrow.key,
                        ctx.accounts.owner_wallet.key,
                        &ctx.accounts.protocol_state.key(),
                        &[],
                    )?,
                    &[
                        ctx.accounts.trigger_escrow.to_account_info(),
                        ctx.accounts.owner_wallet.to_account_info(),
                        ctx.accounts.protocol_state.to_account_info(),
                    ],
                    protocol_signer,
                )?;
                close_trigger_order(
                    &ctx.accounts.trigger_order.to_account_info(),
                    &ctx.accounts.owner_wallet.to_account_info(),
                )?;
            }

            emit!(TriggerExecuted {
                trigger_order: order_key,
                owner,
                kind: kind.as_u8(),
                fire_quantity: fire_qty,
                ema_used: ema,
                premium_or_payout: fill_total,
                remaining_quantity: remaining,
                ts: clock.unix_timestamp,
            });
          } else {
            // ============ VAULT PEG PATH (flag-off / no book accounts) — UNCHANGED ============
            let quantity = ctx.accounts.trigger_order.quantity;
            let max_premium_pc = ctx.accounts.trigger_order.max_premium;
            // The SAME product P0 escrowed → the peg's fee-inclusive TOTAL ceiling.
            let peg_total_ceiling = max_premium_pc
                .checked_mul(quantity)
                .ok_or(OptaError::MathOverflow)?;

            // Escrow balance BEFORE the fill (for refund math). Authority is
            // protocol_state (P0 set the escrow owner) — the None-branch debit
            // below signs as protocol_state, so the SPL transfer's authority
            // check enforces that invariant at runtime.
            let escrow_balance = {
                let data = ctx.accounts.trigger_escrow.try_borrow_data()?;
                require!(data.len() >= 72, OptaError::MathOverflow);
                u64::from_le_bytes(
                    data[64..72]
                        .try_into()
                        .map_err(|_| OptaError::MathOverflow)?,
                )
            };

            // Peg fill: protocol PDA signs the escrow debit (usdc_external_signer
            // = None) + mints to the owner's pre-created ATA.
            let result = vault_peg_fill_core(
                &mut ctx.accounts.shared_vault,
                &mut ctx.accounts.vault_mint_record,
                &mut ctx.accounts.protocol_state,
                &ctx.accounts.vol_oracle,
                &ctx.accounts.option_mint.to_account_info(),
                &ctx.accounts.holder_option_ata.to_account_info(),
                &ctx.accounts.trigger_escrow.to_account_info(),
                None, // protocol PDA signs the escrow debit
                &ctx.accounts.vault_usdc_account.to_account_info(),
                &ctx.accounts.treasury.to_account_info(),
                &ctx.accounts.token_program.to_account_info(),
                &ctx.accounts.token_2022_program.to_account_info(),
                owner,
                quantity,
                peg_total_ceiling,
                clock.unix_timestamp,
            )?;

            // Refund unspent escrow → owner (protocol PDA signs), then close it.
            let protocol_bump = ctx.accounts.protocol_state.bump;
            let protocol_seeds: &[&[u8]] = &[PROTOCOL_SEED, &[protocol_bump]];
            let protocol_signer: &[&[&[u8]]] = &[protocol_seeds];

            let refund = escrow_balance
                .checked_sub(result.total)
                .ok_or(OptaError::MathOverflow)?;
            if refund > 0 {
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
                    refund,
                )?;
            }
            // Close the now-empty escrow token account → rent to owner_wallet.
            invoke_signed(
                &spl_token::instruction::close_account(
                    &ctx.accounts.token_program.key(),
                    ctx.accounts.trigger_escrow.key,
                    ctx.accounts.owner_wallet.key,
                    &ctx.accounts.protocol_state.key(),
                    &[],
                )?,
                &[
                    ctx.accounts.trigger_escrow.to_account_info(),
                    ctx.accounts.owner_wallet.to_account_info(),
                    ctx.accounts.protocol_state.to_account_info(),
                ],
                protocol_signer,
            )?;

            // A buy fires once → close the TriggerOrder (rent → owner_wallet).
            close_trigger_order(
                &ctx.accounts.trigger_order.to_account_info(),
                &ctx.accounts.owner_wallet.to_account_info(),
            )?;

            emit!(TriggerExecuted {
                trigger_order: order_key,
                owner,
                kind: kind.as_u8(),
                fire_quantity: quantity,
                ema_used: ema,
                premium_or_payout: result.total,
                remaining_quantity: 0,
                ts: clock.unix_timestamp,
            });
          }
        }
        // ---------------------------------------------------------------------
        TriggerKind::TakeProfitSell => {
            // FIRE-TIME RE-VERIFICATION against the STORED holder_option_ata.
            // The context already pins its address to trigger_order.holder_option_ata;
            // here we re-read its CURRENT owner/mint/balance (the address could be
            // re-init'd or the balance moved since placement).
            let (ata_owner, ata_mint, balance) = {
                let data = ctx.accounts.holder_option_ata.try_borrow_data()?;
                require!(data.len() >= 72, OptaError::TriggerSourceAtaInvalid);
                let mint_bytes: [u8; 32] = data[0..32]
                    .try_into()
                    .map_err(|_| OptaError::MathOverflow)?;
                let owner_bytes: [u8; 32] = data[32..64]
                    .try_into()
                    .map_err(|_| OptaError::MathOverflow)?;
                let amount_bytes: [u8; 8] = data[64..72]
                    .try_into()
                    .map_err(|_| OptaError::MathOverflow)?;
                (
                    Pubkey::new_from_array(owner_bytes),
                    Pubkey::new_from_array(mint_bytes),
                    u64::from_le_bytes(amount_bytes),
                )
            };
            require!(ata_owner == owner, OptaError::TriggerSourceAtaInvalid);
            require!(
                ata_mint == ctx.accounts.trigger_order.option_mint,
                OptaError::TriggerSourceAtaInvalid
            );

            let want = ctx.accounts.trigger_order.quantity;
            let fire_qty = want.min(balance);

            // Benign no-op: the holder moved everything out. Keeper logs + skips;
            // the trigger STAYS OPEN (no revert, no close, no decrement).
            if fire_qty == 0 {
                emit!(TriggerSkipped {
                    trigger_order: order_key,
                    owner,
                    reason: 0, // 0 = zero source balance
                    ts: clock.unix_timestamp,
                });
                return Ok(());
            }

            // Exercise via the shared core: delegate burn (protocol_state is the
            // PermanentDelegate → pda_bump = Some), payout to the owner. The core
            // enforces intrinsic > 0 (OTM → OptionNotInTheMoney — the reason
            // StopLoss is not a trigger kind).
            let protocol_bump = ctx.accounts.protocol_state.bump;
            let payout = american_exercise_core(
                &mut ctx.accounts.shared_vault,
                &ctx.accounts.option_mint.to_account_info(),
                &ctx.accounts.holder_option_ata.to_account_info(),
                &ctx.accounts.protocol_state.to_account_info(),
                Some(protocol_bump), // delegate signs (invoke_signed [PROTOCOL_SEED, bump])
                &ctx.accounts.vault_usdc_account.to_account_info(),
                &ctx.accounts.owner_usdc_account.to_account_info(),
                &ctx.accounts.token_program.to_account_info(),
                &ctx.accounts.token_2022_program.to_account_info(),
                owner,
                fire_qty,
                ema, // SAME EMA the comparator fired on
            )?;

            // PARTIAL-FIRE: decrement remaining; close only when fully filled.
            let remaining = {
                let order = &mut ctx.accounts.trigger_order;
                order.quantity = order
                    .quantity
                    .checked_sub(fire_qty)
                    .ok_or(OptaError::MathOverflow)?;
                order.quantity
            };
            if remaining == 0 {
                close_trigger_order(
                    &ctx.accounts.trigger_order.to_account_info(),
                    &ctx.accounts.owner_wallet.to_account_info(),
                )?;
            }

            emit!(TriggerExecuted {
                trigger_order: order_key,
                owner,
                kind: kind.as_u8(),
                fire_quantity: fire_qty,
                ema_used: ema,
                premium_or_payout: payout,
                remaining_quantity: remaining,
                ts: clock.unix_timestamp,
            });
        }
        // ---------------------------------------------------------------------
        // B0: StopLossSell is appended to TriggerKind but its book bid-side fire
        // path is DARK until B2 (there is no vault path — an OTM long can't be
        // exercised). Reject defensively; B2 routes it to bid_fill_core.
        TriggerKind::StopLossSell => return err!(OptaError::StopLossSellDark),
    }

    Ok(())
}

#[derive(Accounts)]
pub struct ExecuteTrigger<'info> {
    /// Permissionless keeper — pays the tx fee. NOT the trigger owner.
    #[account(mut)]
    pub caller: Signer<'info>,

    /// The trigger being executed. Self-referential seeds (owner+mint+nonce are
    /// stored fields) so the keeper — not the owner — can derive it. Conditionally
    /// closed in-handler (BUY always; SELL only when fully filled).
    #[account(
        mut,
        seeds = [
            TRIGGER_ORDER_SEED,
            trigger_order.owner.as_ref(),
            trigger_order.option_mint.as_ref(),
            &trigger_order.nonce.to_le_bytes(),
        ],
        bump = trigger_order.bump,
    )]
    pub trigger_order: Box<Account<'info, TriggerOrder>>,

    /// Market — pinned to vault + trigger; provides pyth_feed_id for the EMA
    /// re-check + the vol_oracle seed.
    #[account(
        constraint = market.key() == shared_vault.market,
        constraint = market.key() == trigger_order.market,
    )]
    pub market: Account<'info, OptionsMarket>,

    /// The vault — peg-fill source (BUY) / exercise-payout source (SELL).
    #[account(
        mut,
        constraint = shared_vault.key() == trigger_order.vault,
    )]
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// Series/VaultMint record — the peg core bumps its supply counters (BUY);
    /// validated but untouched on SELL.
    #[account(
        mut,
        constraint = vault_mint_record.vault == shared_vault.key() @ OptaError::InvalidVaultMint,
        constraint = vault_mint_record.option_mint == trigger_order.option_mint @ OptaError::InvalidVaultMint,
    )]
    pub vault_mint_record: Box<Account<'info, VaultMint>>,

    /// The series option mint — peg mint_to target (BUY) / burn target (SELL).
    /// CHECK: pinned to trigger_order.option_mint; Token-2022 CPIs validate.
    #[account(
        mut,
        constraint = option_mint.key() == trigger_order.option_mint @ OptaError::InvalidVaultMint,
    )]
    pub option_mint: UncheckedAccount<'info>,

    /// Fresh PriceUpdateV2 the keeper posts in-tx. The live-EMA source for the
    /// comparator re-check (BUY+SELL) AND the intrinsic spot (SELL).
    ///
    /// Stage 3 (1a-ii): now `Option`, position unchanged. REQUIRED (present) for
    /// a Pyth market — a present price_update is wire-identical to before. A
    /// Switchboard market passes None (sentinel) and uses the trailing SB
    /// accounts. The Pyth arm errors `PriceUpdateMissing` if absent on a Pyth market.
    pub price_update: Option<Account<'info, PriceUpdateV2>>,

    /// VolOracle for the market's feed — the BUY peg's BS-2002 input. Validated
    /// on SELL but unused.
    #[account(
        seeds = [VOL_ORACLE_SEED, market.pyth_feed_id.as_ref()],
        bump = vol_oracle.load()?.bump,
    )]
    pub vol_oracle: AccountLoader<'info, VolOracle>,

    /// Protocol state — fee_bps + total_volume + mint authority (BUY), escrow
    /// authority (BUY refund/debit + close), and the PermanentDelegate burn
    /// authority (SELL).
    #[account(
        mut,
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    /// Treasury — BUY fee destination. Validated but unused on SELL.
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump,
        constraint = treasury.key() == protocol_state.treasury,
    )]
    pub treasury: Box<Account<'info, TokenAccount>>,

    /// Per-trigger USDC escrow (BUY): peg USDC source + unspent refund + close.
    /// SELL: the derived (uninitialized) address, never touched.
    /// CHECK: PDA seeds validate the address; classic USDC layout (BUY).
    #[account(
        mut,
        seeds = [TRIGGER_ESCROW_SEED, trigger_order.key().as_ref()],
        bump,
    )]
    pub trigger_escrow: UncheckedAccount<'info>,

    /// The owner's option ATA stored at placement.
    ///   BUY : peg mint destination (pre-created in P0).
    ///   SELL: the delegate-burn source (re-verified in-handler).
    /// CHECK: pinned to trigger_order.holder_option_ata; CPIs / raw reads validate.
    #[account(
        mut,
        constraint = holder_option_ata.key() == trigger_order.holder_option_ata @ OptaError::TriggerSourceAtaInvalid,
    )]
    pub holder_option_ata: UncheckedAccount<'info>,

    /// Owner's USDC account — BUY: unspent-escrow refund dest; SELL: payout dest.
    /// Pinned to the trigger owner + USDC mint so a keeper can't redirect proceeds.
    #[account(
        mut,
        constraint = owner_usdc_account.owner == trigger_order.owner,
        constraint = owner_usdc_account.mint == protocol_state.usdc_mint,
    )]
    pub owner_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Owner's wallet — rent destination on close (escrow + trigger_order).
    /// CHECK: pinned to trigger_order.owner; receives lamports only.
    #[account(
        mut,
        constraint = owner_wallet.key() == trigger_order.owner,
    )]
    pub owner_wallet: UncheckedAccount<'info>,

    /// Vault's USDC account — BUY vault_share destination / SELL payout source.
    #[account(
        mut,
        constraint = vault_usdc_account.key() == shared_vault.vault_usdc_account,
    )]
    pub vault_usdc_account: Box<Account<'info, TokenAccount>>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,

    // --- Switchboard read-arm accounts (Stage 3 1a-ii). TRAILING optionals: a
    // Pyth trigger omits all three (allow-missing-optionals → None), keeping its
    // tx byte-identical. Required only when market.oracle_source == Switchboard;
    // the handler unwraps + runtime-address-checks the two sysvars in the SB arm.
    // Appended AFTER system_program; no existing account moved. ---
    /// CHECK: Switchboard oracle queue; validated by QuoteVerifier (oracle-key
    /// set) in the SB arm. Not address-pinned (per-network queue).
    pub sb_queue: Option<UncheckedAccount<'info>>,

    /// CHECK: SlotHashes sysvar; address-checked == sysvar::slot_hashes::ID at
    /// runtime in the SB arm.
    pub sb_slothashes: Option<UncheckedAccount<'info>>,

    /// CHECK: Instructions sysvar; address-checked == sysvar::instructions::ID at
    /// runtime in the SB arm, then scanned for the ed25519 ix index.
    pub sb_instructions: Option<UncheckedAccount<'info>>,

    // --- B1 book-fire accounts (StopEntryBuy → book). TRAILING optionals AFTER the
    // three SB optionals; ALL None on the vault-peg path, the SELL path, and every
    // flag-off fire (byte-identical). Present (Some) only for a BOOK_TRIGGERS_ENABLED
    // StopEntryBuy fire that lifts a live ask — a WriterAsk (primary, deep board
    // liquidity, via writer_ask_fill_core) OR a ResaleAsk (secondary, only when the
    // keeper found a better-priced resale within max_premium, via resale_ask_fill_core).
    //
    // KEEPER POSITIONAL LAYOUT (assemble in this exact order after sb_instructions):
    //   [21] book_order        (the RestingOrder being lifted — WriterAsk OR ResaleAsk)
    //   [22] book_maker        (the ask's maker wallet = book_order.owner; rent dest)
    //   [23] book_escrow        (per-order escrow, PDA [resting_order_escrow, book_order];
    //                            WriterAsk → classic-SPL USDC collateral escrow,
    //                            ResaleAsk → Token-2022 option-token escrow)
    //   [24] book_maker_usdc    (the maker's classic USDC — premium recipient)
    //   -- WriterAsk-only ([25]-[27]; pass None for a ResaleAsk fire): --
    //   [25] writer_ask_pot     (per-series pot; MUST pre-exist — ≥1 prior direct fill)
    //   [26] writer_ask_pot_usdc(per-series pot USDC account; MUST pre-exist)
    //   [27] writer_ask_position(per-(series,writer) position; MUST pre-exist)
    //   -- ResaleAsk-only ([28]-[30]; pass None for a WriterAsk fire): --
    //   [28] resale_hook_metas  (ExtraAccountMetaList for the option-token transfer hook)
    //   [29] resale_hook_program(opta_transfer_hook::ID — pinned in-handler)
    //   [30] resale_hook_state  (HookState for the transfer hook)
    // A Pyth book fire passes price_update=Some, sb_*=None, book_*=Some. An SB book
    // fire passes price_update=None, sb_*=Some, book_*=Some. The handler validates
    // every book account's PDA + fields (kind/mint/vault/owner) at runtime — no
    // struct-level seeds (self-referential to optionals). WriterAsk pot/position
    // pre-exist (no init_if_needed in the optional context): a trigger fires only on
    // a series that has already had a direct writer-ask fill. The kind==ResaleAsk arm
    // ignores [25]-[27] and consumes [28]-[30]; the kind==WriterAsk arm is the reverse.
    /// CHECK: validated in-handler (kind==WriterAsk, option_mint/vault == trigger, PDA).
    #[account(mut)]
    pub book_order: Option<Box<Account<'info, RestingOrder>>>,

    /// CHECK: writer wallet, pinned == book_order.owner in-handler; rent dest on close.
    #[account(mut)]
    pub book_maker: Option<UncheckedAccount<'info>>,

    /// CHECK: ask per-order USDC escrow; PDA [resting_order_escrow, book_order] checked in-handler.
    #[account(mut)]
    pub book_escrow: Option<UncheckedAccount<'info>>,

    /// Writer's USDC (premium recipient); owner==book_order.owner + mint checked in-handler.
    #[account(mut)]
    pub book_maker_usdc: Option<Box<Account<'info, TokenAccount>>>,

    /// Per-series WriterAskPot (must pre-exist); PDA [writer_ask_pot, option_mint] checked in-handler.
    #[account(mut)]
    pub writer_ask_pot: Option<Box<Account<'info, WriterAskPot>>>,

    /// Per-series pot USDC (must pre-exist); PDA [writer_ask_pot_usdc, option_mint] checked in-handler.
    #[account(mut)]
    pub writer_ask_pot_usdc: Option<Box<Account<'info, TokenAccount>>>,

    /// Per-(series, writer) WriterAskPosition (must pre-exist); PDA checked in-handler.
    #[account(mut)]
    pub writer_ask_position: Option<Box<Account<'info, WriterAskPosition>>>,

    // --- ResaleAsk-only hook accounts ([28]-[30]); None for a WriterAsk fire. The
    // option-token leg of resale_ask_fill_core is a Token-2022 transfer_checked that
    // dispatches the transfer hook, which requires these three accounts. Validated
    // in-handler (hook program ID-pinned; metas/state validated by the hook dispatch).
    /// CHECK: ExtraAccountMetaList for the transfer hook; validated by T22 hook dispatch.
    pub resale_hook_metas: Option<UncheckedAccount<'info>>,

    /// CHECK: transfer-hook program; pinned == opta_transfer_hook::ID in-handler.
    pub resale_hook_program: Option<UncheckedAccount<'info>>,

    /// CHECK: HookState for the transfer hook; validated by T22 hook dispatch.
    pub resale_hook_state: Option<UncheckedAccount<'info>>,
}
