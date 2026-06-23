// =============================================================================
// instructions/fill_vault_peg.rs — Pegged-ask fill: mint-on-fill from the vault
// =============================================================================
//
// Spec: .context/plans/opta-exchange-spec.md §7.3.2 (D3/D5/D6/D7). The
// converged-architecture vault peg. A taker fills against an American series'
// shared vault at a price computed AT FILL TIME (BS-2002 + vault.spread_bps);
// `quantity` fungible series contracts mint-on-fill from the pooled vault
// collateral. This is the instruction that makes Pass A's series records
// tradeable.
//
// Economics (D7 — premium stays pool-share-proportional through Phase 2):
//   USDC  : taker → vault_usdc (vault_share) + taker → treasury (fee). Same
//           split as purchase_from_vault / fill_order — fee floored, seller-side.
//   Tokens: protocol_state (the series mint authority — see create_series.rs:185)
//           signs `mint_to` straight to the taker's ATA. mint_to is NOT a
//           transfer, so the Token-2022 hook never fires and no hook accounts
//           are needed. The vault PDA never signs here (no payout leaves it —
//           premium flows IN), so `vault_namespace_seed` is intentionally unused.
//
// Pricing goes through the SHARED `price_american` helper (utils/american_pricing/
// quote.rs) — the exact path get_option_price exposes — so a peg fill charges
// byte-identically to a same-block quote. No duplicated pricing logic.
//
// Gates: AMERICAN_ENABLED (dark until Stage I), !voided, !is_settled, expiry>now,
// American style, slippage (max_premium), and the vault-level free-collateral
// commitment cap. All of price_american's own oracle warmup/staleness gates ride
// underneath — until the Stage-I warmup completes the peg simply isn't quoted.
//
// Commitment bookkeeping: mint-on-fill means minted == sold atomically (no
// inventory ever exists — D8 retires burn_unsold). Counters advance on both the
// SharedVault and the series VaultMint record; the premium-per-share accumulator
// grows exactly as purchase_from_vault's (H-01).
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke_signed;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};
use anchor_spl::token_2022::Token2022;

use crate::errors::OptaError;
use crate::events::OrderFilled;
use crate::feature_flags::AMERICAN_ENABLED;
use crate::state::*;
use crate::utils::american_pricing::quote::{price_american, AmericanQuoteInputs};
use crate::utils::collateral::required_collateral_per_contract;
use super::initialize_protocol::TREASURY_SEED;

/// Apply the flat peg spread to a model quote: `base × (1 + spread_bps/10_000)`,
/// computed in u128 and FLOORED (spec §7.4). Extra LP yield on every peg fill.
pub fn apply_spread(base: u64, spread_bps: u16) -> Result<u64> {
    let scaled = (base as u128)
        .checked_mul(10_000u128 + spread_bps as u128)
        .ok_or(OptaError::MathOverflow)?
        / 10_000u128;
    u64::try_from(scaled).map_err(|_| OptaError::MathOverflow.into())
}

/// Vault-level free (uncommitted) collateral, in micro-USDC, as u128 (binding
/// resolution c):
///
///   free = (total_collateral − early_exercise_payout)
///          − (total_options_minted − exercised_options) × collateral_per_token
///
/// Mirrors the Stage-G universal handshake (`collateral_remaining =
/// total_collateral − early_exercise_payout`); outstanding obligations are the
/// LIVE contracts only (minted − exercised). The MED-1 per-contract cap
/// guarantees `early_exercise_payout ≤ exercised_options × cpt`, so early
/// exercise can never drive this negative — the checked_subs are defensive on
/// already-validated vault state.
pub fn vault_free_collateral(
    total_collateral: u64,
    early_exercise_payout: u64,
    total_options_minted: u64,
    exercised_options: u64,
    collateral_per_token: u64,
) -> Result<u128> {
    let net_collateral = (total_collateral as u128)
        .checked_sub(early_exercise_payout as u128)
        .ok_or(OptaError::MathOverflow)?;
    let live = (total_options_minted as u128)
        .checked_sub(exercised_options as u128)
        .ok_or(OptaError::MathOverflow)?;
    let committed = live
        .checked_mul(collateral_per_token as u128)
        .ok_or(OptaError::MathOverflow)?;
    net_collateral
        .checked_sub(committed)
        .ok_or(OptaError::MathOverflow.into())
}

pub fn handle_fill_vault_peg(
    ctx: Context<FillVaultPeg>,
    quantity: u64,
    max_premium: u64,
) -> Result<()> {
    let now_ts = Clock::get()?.unix_timestamp;
    // Phase 4 extraction: ALL peg economics live in vault_peg_fill_core. Here the
    // USDC payer is the TAKER (a real tx signer → usdc_external_signer = Some)
    // and the mint lands in the taker's ATA. execute_trigger calls the SAME core
    // with usdc_external_signer = None (the protocol PDA signs the escrow debit)
    // and the mint lands in the trigger owner's pre-created ATA. Behavior is
    // byte-identical to the pre-extraction handler — gates, pricing, fee split,
    // free-collateral cap, counter bumps, and the OrderFilled tape all moved
    // verbatim into the core.
    vault_peg_fill_core(
        &mut ctx.accounts.shared_vault,
        &mut ctx.accounts.vault_mint_record,
        &mut ctx.accounts.protocol_state,
        &ctx.accounts.vol_oracle,
        &ctx.accounts.option_mint.to_account_info(),
        &ctx.accounts.taker_option_account.to_account_info(),
        &ctx.accounts.taker_usdc_account.to_account_info(),
        Some(&ctx.accounts.taker.to_account_info()),
        &ctx.accounts.vault_usdc_account.to_account_info(),
        &ctx.accounts.treasury.to_account_info(),
        &ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.token_2022_program.to_account_info(),
        ctx.accounts.taker.key(),
        quantity,
        max_premium,
        now_ts,
    )?;
    Ok(())
}

/// Outcome of a peg fill — returned to the caller for refund math + analytics.
/// `total` is the gross USDC the buyer paid (vault_share + fee); execute_trigger
/// refunds `escrow_balance − total`.
pub struct PegFillResult {
    pub total: u64,
    pub premium_per_contract: u64,
    pub fee: u64,
    pub vault_share: u64,
}

// =============================================================================
// vault_peg_fill_core — shared mint-on-fill peg economics (Phase 4)
// =============================================================================
//
// Single source of truth for a vault-peg fill: gates → BS-2002 price + spread →
// fee split → free-collateral cap → USDC in → mint_to → counter bumps →
// OrderFilled tape. Two callers with different USDC-payer + mint-destination
// wiring:
//
//   fill_vault_peg : usdc_source = taker's USDC, usdc_external_signer = Some(taker)
//                    → CpiContext::new (taker signs); mint_destination = taker ATA;
//                    buyer = taker.
//   execute_trigger: usdc_source = trigger_escrow, usdc_external_signer = None
//                    → CpiContext::new_with_signer ([PROTOCOL_SEED, bump]) so the
//                    protocol PDA (the escrow's owner — P0) signs the debit;
//                    mint_destination = owner's pre-created ATA; buyer = owner.
//
// The mint_to authority is ALWAYS protocol_state (the series mint authority),
// signed with [PROTOCOL_SEED, bump], in both paths. All gates live here so the
// existing instruction stays byte-identical and triggers inherit identical
// vault-state safety.
#[allow(clippy::too_many_arguments)]
pub fn vault_peg_fill_core<'info>(
    shared_vault: &mut Account<'info, SharedVault>,
    vault_mint_record: &mut Account<'info, VaultMint>,
    protocol_state: &mut Account<'info, ProtocolState>,
    vol_oracle: &AccountLoader<'info, VolOracle>,
    option_mint: &AccountInfo<'info>,
    mint_destination: &AccountInfo<'info>,
    usdc_source: &AccountInfo<'info>,
    usdc_external_signer: Option<&AccountInfo<'info>>,
    vault_usdc_account: &AccountInfo<'info>,
    treasury: &AccountInfo<'info>,
    token_program: &AccountInfo<'info>,
    token_2022_program: &AccountInfo<'info>,
    buyer: Pubkey,
    quantity: u64,
    max_premium: u64,
    now_ts: i64,
) -> Result<PegFillResult> {
    // ---- 1. Gates ---------------------------------------------------------
    require!(quantity > 0, OptaError::InvalidContractSize);
    require!(AMERICAN_ENABLED, OptaError::AmericanVaultsDisabled);
    require!(!shared_vault.voided, OptaError::VaultVoided);
    require!(!shared_vault.is_settled, OptaError::VaultAlreadySettled);
    require!(shared_vault.expiry > now_ts, OptaError::VaultExpired);
    require!(
        shared_vault.exercise_style == ExerciseStyle::American,
        OptaError::NotAmericanOption
    );

    // ---- 2. Price at fill time: BS-2002 via the shared helper + spread ----
    let premium_per_contract = {
        let oracle = vol_oracle.load()?;
        let quote = price_american(
            &*oracle,
            now_ts,
            AmericanQuoteInputs {
                strike: shared_vault.strike_price,
                expiry_ts: shared_vault.expiry,
                option_type: shared_vault.option_type,
                carry_rate_bps: shared_vault.carry_rate_bps,
            },
        )?;
        apply_spread(quote.premium_per_contract, shared_vault.spread_bps)?
    };

    // ---- 3. Totals + fee split --------------------------------------------
    let total: u64 = (quantity as u128)
        .checked_mul(premium_per_contract as u128)
        .ok_or(OptaError::MathOverflow)?
        .try_into()
        .map_err(|_| OptaError::MathOverflow)?;
    // Slippage: fee-inclusive total must not exceed the buyer's ceiling.
    require!(total <= max_premium, OptaError::SlippageExceeded);

    let fee_bps = protocol_state.fee_bps as u128;
    let fee: u64 = ((total as u128)
        .checked_mul(fee_bps)
        .ok_or(OptaError::MathOverflow)?
        .checked_div(10_000)
        .ok_or(OptaError::MathOverflow)?)
    .try_into()
    .map_err(|_| OptaError::MathOverflow)?;
    let vault_share = total.checked_sub(fee).ok_or(OptaError::MathOverflow)?;

    // ---- 4. Free-collateral commitment cap --------------------------------
    let collateral_per_token =
        required_collateral_per_contract(shared_vault.strike_price, shared_vault.option_type);
    let free = vault_free_collateral(
        shared_vault.total_collateral,
        shared_vault.early_exercise_payout,
        shared_vault.total_options_minted,
        shared_vault.exercised_options,
        collateral_per_token,
    )?;
    let needed = (quantity as u128)
        .checked_mul(collateral_per_token as u128)
        .ok_or(OptaError::MathOverflow)?;
    require!(free >= needed, OptaError::InsufficientVaultCollateral);

    // ---- 5. USDC in: buyer → vault (vault_share) + buyer → treasury (fee) --
    // The protocol signer is built once; used for the None-branch escrow debit
    // AND the always-protocol mint_to below.
    let protocol_bump = protocol_state.bump;
    let protocol_seeds: &[&[u8]] = &[PROTOCOL_SEED, &[protocol_bump]];
    let protocol_signer: &[&[&[u8]]] = &[protocol_seeds];

    if vault_share > 0 {
        match usdc_external_signer {
            Some(signer) => token::transfer(
                CpiContext::new(
                    token_program.clone(),
                    Transfer {
                        from: usdc_source.clone(),
                        to: vault_usdc_account.clone(),
                        authority: signer.clone(),
                    },
                ),
                vault_share,
            )?,
            None => token::transfer(
                CpiContext::new_with_signer(
                    token_program.clone(),
                    Transfer {
                        from: usdc_source.clone(),
                        to: vault_usdc_account.clone(),
                        authority: protocol_state.to_account_info(),
                    },
                    protocol_signer,
                ),
                vault_share,
            )?,
        }
    }
    if fee > 0 {
        match usdc_external_signer {
            Some(signer) => token::transfer(
                CpiContext::new(
                    token_program.clone(),
                    Transfer {
                        from: usdc_source.clone(),
                        to: treasury.clone(),
                        authority: signer.clone(),
                    },
                ),
                fee,
            )?,
            None => token::transfer(
                CpiContext::new_with_signer(
                    token_program.clone(),
                    Transfer {
                        from: usdc_source.clone(),
                        to: treasury.clone(),
                        authority: protocol_state.to_account_info(),
                    },
                    protocol_signer,
                ),
                fee,
            )?,
        }
    }

    // ---- 6. Mint contracts → destination (protocol_state is the authority) -
    invoke_signed(
        &spl_token_2022::instruction::mint_to(
            &token_2022_program.key(),
            option_mint.key,
            mint_destination.key,
            &protocol_state.key(),
            &[],
            quantity,
        )?,
        &[
            option_mint.clone(),
            mint_destination.clone(),
            protocol_state.to_account_info(),
        ],
        protocol_signer,
    )?;

    // ---- 7. Commitment bookkeeping ----------------------------------------
    vault_mint_record.quantity_minted = vault_mint_record
        .quantity_minted
        .checked_add(quantity)
        .ok_or(OptaError::MathOverflow)?;
    vault_mint_record.quantity_sold = vault_mint_record
        .quantity_sold
        .checked_add(quantity)
        .ok_or(OptaError::MathOverflow)?;

    let total_shares = shared_vault.total_shares;
    shared_vault.total_options_minted = shared_vault
        .total_options_minted
        .checked_add(quantity)
        .ok_or(OptaError::MathOverflow)?;
    shared_vault.total_options_sold = shared_vault
        .total_options_sold
        .checked_add(quantity)
        .ok_or(OptaError::MathOverflow)?;
    shared_vault.net_premium_collected = shared_vault
        .net_premium_collected
        .checked_add(vault_share)
        .ok_or(OptaError::MathOverflow)?;
    if total_shares > 0 {
        let premium_increment = (vault_share as u128)
            .checked_mul(1_000_000_000_000) // 1e12 scale factor
            .ok_or(OptaError::MathOverflow)?
            .checked_div(total_shares as u128)
            .ok_or(OptaError::MathOverflow)?;
        shared_vault.premium_per_share_cumulative = shared_vault
            .premium_per_share_cumulative
            .checked_add(premium_increment)
            .ok_or(OptaError::MathOverflow)?;
    }

    protocol_state.total_volume = protocol_state
        .total_volume
        .checked_add(total)
        .ok_or(OptaError::MathOverflow)?;

    // ---- 8. Tape: OrderFilled with the VaultPeg convention ----------------
    let capacity_after: u64 = ((free - needed) / (collateral_per_token as u128))
        .try_into()
        .unwrap_or(u64::MAX);
    emit!(OrderFilled {
        order: vault_mint_record.key(),
        option_mint: *option_mint.key,
        vault: shared_vault.key(),
        kind: OrderKind::VaultPeg.as_u8(),
        maker: shared_vault.key(),
        taker: buyer,
        price_per_contract: premium_per_contract,
        fill_quantity: quantity,
        fee,
        quantity_remaining: capacity_after,
        ts: now_ts,
    });

    Ok(PegFillResult {
        total,
        premium_per_contract,
        fee,
        vault_share,
    })
}

// =============================================================================
// Account validation
// =============================================================================

#[derive(Accounts)]
pub struct FillVaultPeg<'info> {
    /// The taker — pays USDC, receives freshly-minted series contracts.
    #[account(mut)]
    pub taker: Signer<'info>,

    /// The series' shared vault — collateral pot + commitment counters + the
    /// spread_bps / voided / exercise_style fields. Mutated.
    #[account(mut)]
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// The series record (Pass A) — the standing ask. Pins option_mint↔vault
    /// (mint↔vault proof) and carries the series supply counters.
    #[account(
        mut,
        seeds = [VAULT_MINT_RECORD_SEED, option_mint.key().as_ref()],
        bump = vault_mint_record.bump,
        constraint = vault_mint_record.vault == shared_vault.key() @ OptaError::InvalidVaultMint,
    )]
    pub vault_mint_record: Box<Account<'info, VaultMint>>,

    /// Market — provides pyth_feed_id for the VolOracle seed; pinned to the vault.
    #[account(constraint = market.key() == shared_vault.market)]
    pub market: Account<'info, OptionsMarket>,

    /// VolOracle PDA for the market's Pyth feed — the pricing input. Read-only.
    #[account(
        seeds = [VOL_ORACLE_SEED, market.pyth_feed_id.as_ref()],
        bump = vol_oracle.load()?.bump,
    )]
    pub vol_oracle: AccountLoader<'info, VolOracle>,

    /// Protocol state — fee_bps, volume, and the option mint's authority
    /// (signs mint_to with PROTOCOL_SEED). Mutated (total_volume).
    #[account(
        mut,
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Box<Account<'info, ProtocolState>>,

    /// The canonical series mint (Token-2022) — mint_to target. Authority =
    /// protocol_state (create_series.rs:185). Pinned to the series record.
    /// CHECK: pinned to vault_mint_record.option_mint; Token-2022 mint_to validates.
    #[account(
        mut,
        constraint = option_mint.key() == vault_mint_record.option_mint @ OptaError::InvalidVaultMint,
    )]
    pub option_mint: UncheckedAccount<'info>,

    /// Taker's option ATA on the series mint — mint_to destination. The client
    /// pre-creates it idempotently (no hook runs on a mint).
    /// CHECK: validated by the Token-2022 mint_to instruction.
    #[account(mut)]
    pub taker_option_account: UncheckedAccount<'info>,

    /// Taker's USDC account — premium source.
    #[account(
        mut,
        constraint = taker_usdc_account.owner == taker.key(),
        constraint = taker_usdc_account.mint == shared_vault.collateral_mint,
    )]
    pub taker_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Vault's USDC account — receives the vault's share of premium (pool — D7).
    #[account(
        mut,
        constraint = vault_usdc_account.key() == shared_vault.vault_usdc_account,
    )]
    pub vault_usdc_account: Box<Account<'info, TokenAccount>>,

    /// Treasury — receives the protocol fee.
    #[account(
        mut,
        seeds = [TREASURY_SEED],
        bump,
        constraint = treasury.key() == protocol_state.treasury,
    )]
    pub treasury: Box<Account<'info, TokenAccount>>,

    /// Standard SPL Token program — for USDC transfers.
    pub token_program: Program<'info, Token>,

    /// Token-2022 program — for the option mint_to.
    pub token_2022_program: Program<'info, Token2022>,
}

// =============================================================================
// Pure-math unit tests (run under `cargo test` — fast, no oracle/validator)
// =============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn apply_spread_zero_is_identity() {
        assert_eq!(apply_spread(1_000_000, 0).unwrap(), 1_000_000);
        assert_eq!(apply_spread(0, 0).unwrap(), 0);
    }

    #[test]
    fn apply_spread_scales_and_floors() {
        // 5% on a clean number.
        assert_eq!(apply_spread(1_000_000, 500).unwrap(), 1_050_000);
        // Flooring: 999 × 10001/10000 = 999.0999 → 999.
        assert_eq!(apply_spread(999, 1).unwrap(), 999);
        // 1 × 11000/10000 = 1.1 → 1.
        assert_eq!(apply_spread(1, 1000).unwrap(), 1);
        // 12345 × 12500/10000 = 15431.25 → 15431.
        assert_eq!(apply_spread(12_345, 2500).unwrap(), 15_431);
    }

    #[test]
    fn vault_free_collateral_basic() {
        // Fresh vault: $1000 collateral, nothing minted → all free.
        assert_eq!(
            vault_free_collateral(1_000_000_000, 0, 0, 0, 100_000_000).unwrap(),
            1_000_000_000u128
        );
        // 3 of 10 contracts minted at $100 cpt → 7 contracts ($700) free.
        assert_eq!(
            vault_free_collateral(1_000_000_000, 0, 3, 0, 100_000_000).unwrap(),
            700_000_000u128
        );
    }

    #[test]
    fn vault_free_collateral_nets_early_exercise() {
        // 5 minted, 2 early-exercised at capped $50 intrinsic ($100 payout).
        // free = (1000 − 100) − (5 − 2)×100 = 900 − 300 = $600.
        let free = vault_free_collateral(
            1_000_000_000, // total_collateral $1000
            100_000_000,   // early_exercise_payout $100 (2 × $50 cap)
            5,             // total_options_minted
            2,             // exercised_options
            100_000_000,   // cpt $100
        )
        .unwrap();
        assert_eq!(free, 600_000_000u128);
    }

    #[test]
    fn vault_free_collateral_never_negative_under_med1_cap() {
        // Worst case: whole pool minted, all exercised at the per-contract cap.
        // total = minted×cpt, early_payout = exercised×cpt (the MED-1 ceiling).
        // free = (minted×cpt − exercised×cpt) − (minted − exercised)×cpt = 0.
        let cpt = 100_000_000u64;
        let minted = 10u64;
        let exercised = 10u64;
        let total = minted * cpt;
        let early_payout = exercised * cpt; // MED-1 cap
        let free = vault_free_collateral(total, early_payout, minted, exercised, cpt).unwrap();
        assert_eq!(free, 0u128, "free collateral floors at 0, never underflows");
    }
}
