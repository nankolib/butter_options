// =============================================================================
// instructions/settle_vault.rs — Settle a SharedVault from a SettlementRecord
// =============================================================================
//
// Stage 3 final shape: permissionless. Reads the canonical settlement
// price from a SettlementRecord PDA (written earlier by the admin-only
// `settle_expiry` instruction) and applies it to this vault.
//
// If no SettlementRecord exists for this vault's (asset, expiry) tuple,
// anchor's seed validation + Account deserialization fails before the
// handler runs — caller gets a clear "uninitialized account" error.
//
// This does NOT distribute funds. It just marks the vault as settled and
// records the payout calculations. Individual exercises and writer
// withdrawals handle actual fund movement.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

use crate::errors::OptaError;
use crate::events::VaultSettled;
use crate::state::*;

pub fn handle_settle_vault(ctx: Context<SettleVault>) -> Result<()> {
    let vault = &ctx.accounts.shared_vault;
    let record = &ctx.accounts.settlement_record;

    require!(!vault.is_settled, OptaError::VaultAlreadySettled);
    // Pass D (invariant #6, CRITICAL): a voided vault must never be settled. If
    // a late SettlementRecord lands after the dead-feed hatch ran, this blocks
    // settle_vault from writing a settlement_price onto a voided vault — the
    // drain vector. No-op on European vaults (voided is always false there).
    require!(!vault.voided, OptaError::VaultVoided);

    let clock = Clock::get()?;
    require!(
        vault.expiry <= clock.unix_timestamp,
        OptaError::MarketNotExpired
    );

    // Read canonical settlement price from the per-(asset, expiry) record
    let settlement_price = record.settlement_price;

    // Calculate total payout owed to option holders
    let strike_price = vault.strike_price;

    let payout_per_contract = match vault.option_type {
        OptionType::Call => {
            if settlement_price > strike_price {
                settlement_price
                    .checked_sub(strike_price)
                    .ok_or(OptaError::MathOverflow)?
            } else {
                0
            }
        }
        OptionType::Put => {
            if strike_price > settlement_price {
                strike_price
                    .checked_sub(settlement_price)
                    .ok_or(OptaError::MathOverflow)?
            } else {
                0
            }
        }
    };

    // Stage G F→G handshake: early-exercised contracts (exercise_american) are
    // already cash-settled and their tokens burned, so the at-expiry holder
    // total counts only the LIVE sold supply. European vaults never early-
    // exercise (exercised_options == 0), so this subtracts 0 — byte-identical.
    let live_sold = vault.total_options_sold.saturating_sub(vault.exercised_options);
    let total_payout = payout_per_contract
        .checked_mul(live_sold)
        .ok_or(OptaError::MathOverflow)?;

    // Cap payout at total collateral (can't pay out more than exists)
    let total_payout = std::cmp::min(total_payout, vault.total_collateral);

    // FIX CRITICAL-01: Do NOT pre-deduct at-expiry exercise payouts here;
    // exercise_from_vault / auto_finalize_holders deduct each one from
    // collateral_remaining individually post-settlement.
    //
    // Stage G F→G handshake: early-exercise USDC (exercise_american) has ALREADY
    // left the vault pre-settlement, so the writer-claimable pool starts at
    // total_collateral MINUS that drawdown. European: early_exercise_payout == 0
    // → unchanged. saturating_sub (not checked) is defensive — the per-contract
    // cap guarantees payout never exceeds collateral, but never panic at settle.
    // ---- Phase 3 Slice D1: writer-ask pot sweep (None → byte-identical) ----
    // Fold WriterAskPot.total_collateral (the COUNTER — donation-proof, INFO-3)
    // into the waterfall: move pot USDC → vault USDC and add it to
    // collateral_remaining, so the merged collateral backs the merged (pool +
    // writer-ask) contracts. Skipped entirely for EUR / pool-only vaults (no pot
    // → writer_ask_pot is None) → settlement is byte-identical to pre-D1. The
    // sweep is once-only (gated by the is_settled guard at the top). Writer
    // residual refunds + pool-writer scaling are D2/D3 — NOT here.
    let writer_ask_collateral_swept: u64 = if let Some(pot) = ctx.accounts.writer_ask_pot.as_ref() {
        // All-or-nothing: pot present ⇒ every sweep account must be present.
        let pot_usdc = ctx
            .accounts
            .writer_ask_pot_usdc
            .as_ref()
            .ok_or(OptaError::WriterAskSweepAccountsMissing)?;
        let vault_usdc = ctx
            .accounts
            .vault_usdc_account
            .as_ref()
            .ok_or(OptaError::WriterAskSweepAccountsMissing)?;
        let protocol = ctx
            .accounts
            .protocol_state
            .as_ref()
            .ok_or(OptaError::WriterAskSweepAccountsMissing)?;
        let token_prog = ctx
            .accounts
            .token_program
            .as_ref()
            .ok_or(OptaError::WriterAskSweepAccountsMissing)?;

        // Pin the pot to THIS vault + its USDC account; pin the vault USDC.
        require!(pot.vault == vault.key(), OptaError::InvalidVaultMint);
        require!(pot_usdc.key() == pot.usdc_account, OptaError::InvalidVaultMint);
        require!(
            vault_usdc.key() == vault.vault_usdc_account,
            OptaError::InvalidVaultMint
        );

        let swept = pot.total_collateral;
        // Required addition: prove the pot USDC actually backs the counter
        // BEFORE freezing it as the D2/D3 residual denominator. Fail closed if
        // the recorded counter ever exceeds the real on-chain backing.
        require!(
            pot_usdc.amount >= swept,
            OptaError::WriterAskSweepAccountsMissing
        );

        if swept > 0 {
            let protocol_seeds: &[&[u8]] = &[PROTOCOL_SEED, &[protocol.bump]];
            token::transfer(
                CpiContext::new_with_signer(
                    token_prog.to_account_info(),
                    Transfer {
                        from: pot_usdc.to_account_info(),
                        to: vault_usdc.to_account_info(),
                        authority: protocol.to_account_info(),
                    },
                    &[protocol_seeds],
                ),
                swept,
            )?;
        }
        swept
    } else {
        0
    };

    let collateral_remaining = vault
        .total_collateral
        .checked_add(writer_ask_collateral_swept)
        .ok_or(OptaError::MathOverflow)?
        .saturating_sub(vault.early_exercise_payout);

    // Update vault state
    let vault_key = ctx.accounts.shared_vault.key();

    let vault = &mut ctx.accounts.shared_vault;
    vault.is_settled = true;
    vault.settlement_price = settlement_price;
    vault.collateral_remaining = collateral_remaining;
    vault.writer_ask_collateral_swept = writer_ask_collateral_swept;

    emit!(VaultSettled {
        vault: vault_key,
        settlement_price,
        total_payout,
        collateral_remaining,
        writer_ask_collateral_swept,
    });

    Ok(())
}

#[derive(Accounts)]
pub struct SettleVault<'info> {
    /// Permissionless — anyone can settle a vault once the SettlementRecord
    /// for its (asset, expiry) exists.
    pub authority: Signer<'info>,

    /// The shared vault to settle.
    #[account(mut)]
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// The vault's market — needed to derive the SettlementRecord PDA from
    /// `market.asset_name`. Constraint pins it to the vault's recorded market.
    #[account(constraint = market.key() == shared_vault.market)]
    pub market: Account<'info, OptionsMarket>,

    /// The canonical settlement record for this (asset, expiry). If none
    /// exists, anchor's seed validation + Account deserialization fails
    /// before the handler runs.
    #[account(
        seeds = [
            SETTLEMENT_SEED,
            market.asset_name.as_bytes(),
            &shared_vault.expiry.to_le_bytes(),
        ],
        bump = settlement_record.bump,
    )]
    pub settlement_record: Account<'info, SettlementRecord>,

    // ---- Phase 3 Slice D1 — writer-ask pot sweep (TRAILING OPTIONALS) -------
    // ALL None for EUR / pool-only vaults (no WriterAsk pot) → the sweep branch
    // is skipped and settlement is byte-identical. Pass all Some (the canonical
    // series pot) to sweep. `allow-missing-optionals` (Cargo) lets these trailing
    // optionals deserialize to None when omitted. The handler enforces
    // all-or-nothing presence + pins each to the vault.
    /// Vault USDC — sweep destination.
    #[account(mut)]
    pub vault_usdc_account: Option<Box<Account<'info, TokenAccount>>>,

    /// The series' WriterAskPot record — read for total_collateral; pinned to
    /// this vault in-handler (pot.vault == shared_vault.key()).
    pub writer_ask_pot: Option<Box<Account<'info, WriterAskPot>>>,

    /// The pot's USDC account — sweep source (authority = protocol_state).
    #[account(mut)]
    pub writer_ask_pot_usdc: Option<Box<Account<'info, TokenAccount>>>,

    /// Protocol state — signs the pot→vault USDC transfer.
    #[account(seeds = [PROTOCOL_SEED], bump)]
    pub protocol_state: Option<Account<'info, ProtocolState>>,

    /// Classic SPL Token program — for the USDC sweep transfer.
    pub token_program: Option<Program<'info, Token>>,
}
