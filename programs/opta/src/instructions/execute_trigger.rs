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
}
