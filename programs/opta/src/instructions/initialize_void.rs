// =============================================================================
// instructions/initialize_void.rs — atomic dead-feed void transition (Phase 3 D3)
// =============================================================================
//
// The SOLE setter of `vault.voided` (relocated from reclaim_unsettled). One
// instruction, all-or-nothing, that winds a dead-feed vault into the SAME merged
// pool a normal settle produces — so writer-ask backers and pool writers are both
// made whole, exactly, with the early-exercise cost E socialized by share (no
// origin attribution; E_wa is structurally unknowable and unnecessary).
//
// After the 7-day grace with no SettlementRecord, it:
//   1. derives the CANONICAL writer-ask pot from the vault's own identity
//      (un-omittable / un-substitutable — sound because D2.5 pins writer-asks to
//      canonical mints, so there is exactly one pot per vault at the derived addr);
//   2. NO POT (empty record / EUR / pool-only) → seed collateral_remaining =
//      total_collateral − early_exercise_payout, swept = 0 — BYTE-IDENTICAL to the
//      old reclaim_unsettled self-void seed;
//   3. POT present → sweep pot.total_collateral (the COUNTER — donation-proof, with
//      the D1 pot_usdc.amount ≥ counter guard) pot_usdc → vault_usdc; route any
//      donation remainder to treasury (NOT into the merge — keeps it donation-proof)
//      and close pot_usdc (rent → treasury); record writer_ask_collateral_swept =
//      swept, writer_ask_equiv_shares = equiv_total = swept × TS/TC (or = swept if
//      TC == 0); total_shares += equiv_total; collateral_remaining = TC + swept − E;
//   4. set voided = true. THE ONLY `voided` write in the program.
//
// Solana tx atomicity ⇒ `voided == true` ⟺ the full merge committed (no
// partial-init). reclaim_unsettled (pool) + reclaim_writer_ask_residual (backer)
// both require voided, so no claim can run against a voided-but-unmerged vault.
// Once-only via require!(!voided). Late-feed safe: a post-void SettlementRecord
// cannot un-void (settle_vault's !voided guard blocks applying it).
//
// PERMISSIONLESS, UNGATED — an exit/cleanup path. Inert feature-free: no pot is
// ever funded (fill_writer_ask reverts 6054), so the pot branch is unreachable and
// every void takes the byte-identical no-pot path.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_spl::token::{self, CloseAccount, Token, TokenAccount, Transfer};

use crate::errors::OptaError;
use crate::events::VaultVoidInitialized;
use crate::state::*;

pub fn handle_initialize_void(ctx: Context<InitializeVoid>) -> Result<()> {
    // ---- Snapshot vault inputs (copies — no borrow held across the CPIs) ----
    let v = &ctx.accounts.shared_vault;
    require!(!v.voided, OptaError::VaultVoided); // once-only (the sole voided-setter)
    let tc = v.total_collateral;
    let e = v.early_exercise_payout;
    let ts = v.total_shares;
    let strike = v.strike_price;
    let expiry = v.expiry;
    let ot = v.option_type as u8;
    let es = v.exercise_style as u8;
    let vault_pubkey = v.key();

    // ---- Hatch gates: no SettlementRecord + 7-day grace ---------------------
    require!(
        ctx.accounts.settlement_record.data_is_empty(),
        OptaError::SettlementRecordExists
    );
    let clock = Clock::get()?;
    let grace_end = expiry.checked_add(GRACE_WINDOW).ok_or(OptaError::MathOverflow)?;
    require!(
        clock.unix_timestamp >= grace_end,
        OptaError::GracePeriodNotElapsed
    );

    // ---- Derive + pin the canonical mint, pot, pot_usdc from vault identity --
    // Un-omittable (required accounts) + un-substitutable (pinned to the
    // vault-derived addresses). Sound: D2.5 pins writer-asks to canonical mints,
    // so the one pot per vault lives at exactly this address.
    let market_key = ctx.accounts.market.key();
    let (canonical_mint, _) = Pubkey::find_program_address(
        &[
            VAULT_OPTION_MINT_SEED,
            market_key.as_ref(),
            &strike.to_le_bytes(),
            &expiry.to_le_bytes(),
            &[ot],
            &[es],
        ],
        &crate::ID,
    );
    require_keys_eq!(ctx.accounts.option_mint.key(), canonical_mint, OptaError::InvalidVaultMint);
    let (pot_pda, _) =
        Pubkey::find_program_address(&[WRITER_ASK_POT_SEED, canonical_mint.as_ref()], &crate::ID);
    require_keys_eq!(ctx.accounts.writer_ask_pot.key(), pot_pda, OptaError::InvalidVaultMint);
    let (pot_usdc_pda, _) = Pubkey::find_program_address(
        &[WRITER_ASK_POT_USDC_SEED, canonical_mint.as_ref()],
        &crate::ID,
    );
    require_keys_eq!(ctx.accounts.writer_ask_pot_usdc.key(), pot_usdc_pda, OptaError::InvalidVaultMint);

    // ---- No-pot vs pot fork -------------------------------------------------
    let (swept, equiv_total) = if ctx.accounts.writer_ask_pot.data_is_empty() {
        (0u64, 0u64) // EUR / pool-only / no writer-asks → byte-identical seed below
    } else {
        let pot = {
            let data = ctx.accounts.writer_ask_pot.try_borrow_data()?;
            WriterAskPot::try_deserialize(&mut &data[..])?
        };
        require!(pot.vault == vault_pubkey, OptaError::InvalidVaultMint);
        require!(
            pot.usdc_account == ctx.accounts.writer_ask_pot_usdc.key(),
            OptaError::InvalidVaultMint
        );
        let swept = pot.total_collateral; // the COUNTER (donation-proof)

        // pot_usdc balance — classic SPL `amount` at bytes 64..72.
        let pot_bal = {
            let d = ctx.accounts.writer_ask_pot_usdc.try_borrow_data()?;
            require!(d.len() >= 72, OptaError::WriterAskSweepAccountsMissing);
            u64::from_le_bytes(
                d[64..72]
                    .try_into()
                    .map_err(|_| OptaError::MathOverflow)?,
            )
        };
        // D1 guard: the recorded counter must be backed by real USDC before it
        // becomes the merged collateral.
        require!(pot_bal >= swept, OptaError::WriterAskSweepAccountsMissing);

        let equiv = if tc == 0 {
            swept // pure writer-ask: 1:1 (no pool to denominate)
        } else {
            ((swept as u128)
                .checked_mul(ts as u128)
                .ok_or(OptaError::MathOverflow)?
                .checked_div(tc as u128)
                .ok_or(OptaError::MathOverflow)?) as u64
        };

        // Sweep counter → vault_usdc (the merge); donation (balance − counter) →
        // treasury (NOT merged — donation-proof); then close pot_usdc → treasury.
        let protocol_seeds: &[&[u8]] = &[PROTOCOL_SEED, &[ctx.accounts.protocol_state.bump]];
        if swept > 0 {
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
        let donation = pot_bal.checked_sub(swept).ok_or(OptaError::MathOverflow)?;
        if donation > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.writer_ask_pot_usdc.to_account_info(),
                        to: ctx.accounts.treasury.to_account_info(),
                        authority: ctx.accounts.protocol_state.to_account_info(),
                    },
                    &[protocol_seeds],
                ),
                donation,
            )?;
        }
        // pot_usdc is now empty → close it (rent → treasury). The pot RECORD is
        // left (minor rent; consistent with settle not closing it).
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.writer_ask_pot_usdc.to_account_info(),
                destination: ctx.accounts.treasury.to_account_info(),
                authority: ctx.accounts.protocol_state.to_account_info(),
            },
            &[protocol_seeds],
        ))?;
        (swept, equiv)
    };

    // ---- Merge + flip voided (the atomic transition) ------------------------
    // collateral_remaining = TC + swept − E (no-pot ⇒ TC − E, byte-identical to the
    // old reclaim_unsettled seed). E ≤ TC + swept (pool exercises ≤ TC, writer-ask
    // ≤ swept) ⇒ no underflow.
    let cr = tc
        .checked_add(swept)
        .ok_or(OptaError::MathOverflow)?
        .checked_sub(e)
        .ok_or(OptaError::MathOverflow)?;

    let vault = &mut ctx.accounts.shared_vault;
    vault.writer_ask_collateral_swept = swept;
    vault.writer_ask_equiv_shares = equiv_total;
    vault.total_shares = ts.checked_add(equiv_total).ok_or(OptaError::MathOverflow)?;
    vault.collateral_remaining = cr;
    vault.voided = true; // THE ONLY `voided` write in the program

    emit!(VaultVoidInitialized {
        vault: vault_pubkey,
        swept,
        equiv_total,
        collateral_remaining: cr,
    });
    Ok(())
}

#[derive(Accounts)]
pub struct InitializeVoid<'info> {
    /// Permissionless cranker — pays the tx. Receives nothing.
    pub cranker: Signer<'info>,

    /// The dead-feed vault being wound down. Mutated (the void transition).
    #[account(mut)]
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// The vault's market — provides asset_name for the SettlementRecord seed +
    /// the canonical-mint derivation. Pinned to the vault.
    #[account(constraint = market.key() == shared_vault.market)]
    pub market: Account<'info, OptionsMarket>,

    /// The per-(asset, expiry) SettlementRecord — which MUST NOT exist (the hatch
    /// gate). Seeds-pinned so it can't be substituted; the handler asserts empty.
    /// CHECK: existence is the gate; handler requires data_is_empty().
    #[account(
        seeds = [
            SETTLEMENT_SEED,
            market.asset_name.as_bytes(),
            &shared_vault.expiry.to_le_bytes(),
        ],
        bump,
    )]
    pub settlement_record: UncheckedAccount<'info>,

    /// The canonical series mint — in-handler-pinned to the vault-derived address.
    /// CHECK: pinned via require_keys_eq in the handler.
    pub option_mint: UncheckedAccount<'info>,

    /// The writer-ask pot RECORD — in-handler-pinned; empty ⇒ no-pot branch.
    /// CHECK: pinned via require_keys_eq; deserialized manually when non-empty.
    pub writer_ask_pot: UncheckedAccount<'info>,

    /// The writer-ask pot USDC account — swept then closed. In-handler-pinned.
    /// CHECK: pinned via require_keys_eq; authority = protocol_state.
    #[account(mut)]
    pub writer_ask_pot_usdc: UncheckedAccount<'info>,

    /// Vault's USDC token account — sweep destination.
    #[account(
        mut,
        constraint = vault_usdc_account.key() == shared_vault.vault_usdc_account,
    )]
    pub vault_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Protocol state — signs the pot sweep/close (pot_usdc authority) + pins treasury.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Protocol treasury — receives the donation remainder + pot_usdc rent.
    #[account(
        mut,
        constraint = treasury.key() == protocol_state.treasury,
    )]
    pub treasury: Box<Account<'info, TokenAccount>>,

    /// Classic SPL Token program — for the sweep + close.
    pub token_program: Program<'info, Token>,
}
