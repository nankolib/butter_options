// =============================================================================
// instructions/create_test_shared_vault.rs -- bare SharedVault for tests
// =============================================================================
//
// Initializes a SharedVault account with default values for use in
// tests/realloc-shared-vault.ts. Bypasses create_market, USDC mint setup,
// epoch config, and the Pyth proof gate -- none of which are relevant to
// exercising the realloc constraint pattern.
//
// The vault is created as a regular (non-PDA) account so tests can generate
// a fresh keypair per case. All fields default to safe zero-equivalent
// values; the only meaningful field is `creator` (= caller) for completeness.
//
// Gated by the `cu-profile` Cargo feature -- compiles to nothing in default
// builds. NEVER deploy a cu-profile build to devnet/mainnet.
//
// Phase 2 Stage A scope:
//     .context/plans/phase2-american-onchain-pricing-scope.md
// =============================================================================

#![cfg(feature = "cu-profile")]

use anchor_lang::prelude::*;

use crate::state::{OptionType, SharedVault, VaultType};

pub fn handle_create_test_shared_vault(
    ctx: Context<CreateTestSharedVault>,
) -> Result<()> {
    let vault = &mut ctx.accounts.shared_vault;
    vault.market = Pubkey::default();
    vault.option_type = OptionType::Call;
    vault.strike_price = 100;
    vault.expiry = i64::MAX / 2;
    vault.vault_type = VaultType::Custom;
    vault.total_collateral = 0;
    vault.total_shares = 0;
    vault.vault_usdc_account = Pubkey::default();
    vault.collateral_mint = Pubkey::default();
    vault.total_options_minted = 0;
    vault.total_options_sold = 0;
    vault.net_premium_collected = 0;
    vault.premium_per_share_cumulative = 0;
    vault.is_settled = false;
    vault.settlement_price = 0;
    vault.collateral_remaining = 0;
    vault.creator = ctx.accounts.creator.key();
    vault.created_at = 0;
    vault.bump = 0;
    vault.carry_rate_bps = 0;
    Ok(())
}

#[derive(Accounts)]
pub struct CreateTestSharedVault<'info> {
    /// The test runner. Pays for account rent.
    #[account(mut)]
    pub creator: Signer<'info>,

    /// Fresh SharedVault, allocated as a regular (non-PDA) account so each
    /// test can pass a fresh keypair signer. Init allocates 8 + INIT_SPACE
    /// bytes (the NEW size, including carry_rate_bps).
    #[account(
        init,
        payer = creator,
        space = 8 + SharedVault::INIT_SPACE,
    )]
    pub shared_vault: Account<'info, SharedVault>,

    pub system_program: Program<'info, System>,
}
