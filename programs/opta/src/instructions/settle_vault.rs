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
    // ---- Phase 3 retro-harden: derive + pin the canonical pot from vault identity.
    // Mirrors initialize_void (un-omittable / un-substitutable) — the pot accounts
    // are REQUIRED and pinned to the vault-derived addresses, so a permissionless
    // settle can no longer omit a funded pot and strand it (is_settled is once-only).
    // D2.5 pins writer-asks to canonical mints ⇒ exactly one pot per vault at the
    // derived address. No-pot / EUR / pool-only takes the data_is_empty() branch ⇒
    // swept == 0 ⇒ settlement is byte-identical to pre-D1. The sweep folds
    // WriterAskPot.total_collateral (the COUNTER — donation-proof) into the
    // waterfall (counter-only; residual refunds + pool-writer scaling are D2/D3).
    let market_key = ctx.accounts.market.key();
    let (canonical_mint, _) = Pubkey::find_program_address(
        &[
            VAULT_OPTION_MINT_SEED,
            market_key.as_ref(),
            &vault.strike_price.to_le_bytes(),
            &vault.expiry.to_le_bytes(),
            &[vault.option_type as u8],
            &[vault.exercise_style as u8],
        ],
        &crate::ID,
    );
    require_keys_eq!(
        ctx.accounts.option_mint.key(),
        canonical_mint,
        OptaError::InvalidVaultMint
    );
    let (pot_pda, _) =
        Pubkey::find_program_address(&[WRITER_ASK_POT_SEED, canonical_mint.as_ref()], &crate::ID);
    require_keys_eq!(
        ctx.accounts.writer_ask_pot.key(),
        pot_pda,
        OptaError::InvalidVaultMint
    );
    let (pot_usdc_pda, _) = Pubkey::find_program_address(
        &[WRITER_ASK_POT_USDC_SEED, canonical_mint.as_ref()],
        &crate::ID,
    );
    require_keys_eq!(
        ctx.accounts.writer_ask_pot_usdc.key(),
        pot_usdc_pda,
        OptaError::InvalidVaultMint
    );

    let writer_ask_collateral_swept: u64 = if ctx.accounts.writer_ask_pot.data_is_empty() {
        0 // EUR / pool-only / no writer-asks → byte-identical to pre-D1 settle
    } else {
        let pot = {
            let data = ctx.accounts.writer_ask_pot.try_borrow_data()?;
            WriterAskPot::try_deserialize(&mut &data[..])?
        };
        // Pin the pot to THIS vault + its USDC account.
        require!(pot.vault == vault.key(), OptaError::InvalidVaultMint);
        require!(
            pot.usdc_account == ctx.accounts.writer_ask_pot_usdc.key(),
            OptaError::InvalidVaultMint
        );

        let swept = pot.total_collateral; // the COUNTER (donation-proof)
        // Prove the pot USDC actually backs the counter BEFORE freezing it as the
        // D2/D3 residual denominator. Fail closed if the recorded counter ever
        // exceeds the real on-chain backing. Raw SPL `amount` at bytes 64..72
        // (UncheckedAccount, same read as initialize_void's proven path).
        let pot_bal = {
            let d = ctx.accounts.writer_ask_pot_usdc.try_borrow_data()?;
            require!(d.len() >= 72, OptaError::WriterAskSweepAccountsMissing);
            u64::from_le_bytes(d[64..72].try_into().map_err(|_| OptaError::MathOverflow)?)
        };
        require!(pot_bal >= swept, OptaError::WriterAskSweepAccountsMissing);

        if swept > 0 {
            let protocol_seeds: &[&[u8]] = &[PROTOCOL_SEED, &[ctx.accounts.protocol_state.bump]];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.writer_ask_pot_usdc.to_account_info(),
                        to: ctx.accounts.vault_usdc_account.to_account_info(),
                        authority: ctx.accounts.protocol_state.to_account_info(),
                    },
                    &[protocol_seeds],
                ),
                swept,
            )?;
        }
        swept
    };

    let collateral_remaining = vault
        .total_collateral
        .checked_add(writer_ask_collateral_swept)
        .ok_or(OptaError::MathOverflow)?
        .saturating_sub(vault.early_exercise_payout);

    // ---- Phase 3 Slice D2a: shares-unification (writer-ask equiv-shares) ----
    // Fold the swept writer-ask collateral into the SHARE denominator so that
    // pool-writers and writer-ask-writers both claim the post-holder residual
    // against ONE jointly-decremented `total_shares` (the conservation-preserving
    // model — it reduces to the existing single-bucket telescoping proof).
    //   equiv_total = swept × total_shares / total_collateral
    // is the share-equivalent of the swept collateral at the settle-time pool
    // ratio (read here using the UNMUTATED settle-time total_shares /
    // total_collateral — settle is once-only, nothing has claimed yet). For a
    // PURE writer-ask vault (no pool: total_collateral == 0) there is no ratio,
    // so equiv_total = swept (1:1; the pot IS the only collateral and
    // total_shares was 0). 0 when there is no pot (swept == 0) → total_shares
    // unchanged → settlement stays byte-identical for EUR / pool-only vaults.
    let writer_ask_equiv_shares: u64 = if writer_ask_collateral_swept == 0 {
        0
    } else if vault.total_collateral == 0 {
        writer_ask_collateral_swept
    } else {
        ((writer_ask_collateral_swept as u128)
            .checked_mul(vault.total_shares as u128)
            .ok_or(OptaError::MathOverflow)?
            .checked_div(vault.total_collateral as u128)
            .ok_or(OptaError::MathOverflow)?) as u64
    };

    // Update vault state
    let vault_key = ctx.accounts.shared_vault.key();

    let vault = &mut ctx.accounts.shared_vault;
    vault.is_settled = true;
    vault.settlement_price = settlement_price;
    vault.collateral_remaining = collateral_remaining;
    vault.writer_ask_collateral_swept = writer_ask_collateral_swept;
    // D2a: add the writer-ask equiv-shares to the unified denominator. No-op for
    // the no-pot path (equiv_shares == 0) → total_shares unchanged.
    vault.total_shares = vault
        .total_shares
        .checked_add(writer_ask_equiv_shares)
        .ok_or(OptaError::MathOverflow)?;
    vault.writer_ask_equiv_shares = writer_ask_equiv_shares;

    emit!(VaultSettled {
        vault: vault_key,
        settlement_price,
        total_payout,
        collateral_remaining,
        writer_ask_collateral_swept,
        writer_ask_equiv_shares,
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

    // ---- Phase 3 retro-harden — writer-ask pot sweep (REQUIRED + DERIVED) ----
    // The pot is no longer optionally-passed; it is derived from vault identity and
    // pinned in-handler (mirrors initialize_void), so a permissionless settle can't
    // omit a funded pot to strand it. EUR / pool-only vaults pass the derived-empty
    // pot accounts → the handler's data_is_empty() branch ⇒ swept == 0 ⇒ settlement
    // state is byte-identical. The canonical series mint, pot, and pot_usdc are all
    // pinned via require_keys_eq in the handler.
    /// Vault USDC — sweep destination. Required.
    #[account(
        mut,
        constraint = vault_usdc_account.key() == shared_vault.vault_usdc_account @ OptaError::InvalidVaultMint,
    )]
    pub vault_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Canonical series mint — in-handler-pinned to the vault-derived address.
    /// CHECK: pinned via require_keys_eq in the handler.
    pub option_mint: UncheckedAccount<'info>,

    /// The series' WriterAskPot record — in-handler-pinned; empty ⇒ no-pot branch.
    /// CHECK: pinned via require_keys_eq; deserialized manually when non-empty.
    pub writer_ask_pot: UncheckedAccount<'info>,

    /// The pot's USDC account — sweep source (authority = protocol_state).
    /// In-handler-pinned. CHECK: pinned via require_keys_eq; balance read raw.
    #[account(mut)]
    pub writer_ask_pot_usdc: UncheckedAccount<'info>,

    /// Protocol state — signs the pot→vault USDC transfer. Required.
    #[account(seeds = [PROTOCOL_SEED], bump = protocol_state.bump)]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Classic SPL Token program — for the USDC sweep transfer. Required.
    pub token_program: Program<'info, Token>,
}
