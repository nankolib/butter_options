// =============================================================================
// instructions/shrink_shared_vault_for_test.rs -- test-only legacy simulator
// =============================================================================
//
// Shrinks a SharedVault's data buffer back to the pre-Stage-A size (without
// the trailing carry_rate_bps field). Used to simulate a legacy on-chain
// vault for the realloc test in tests/realloc-shared-vault.ts.
//
// Gated by the `cu-profile` Cargo feature -- compiles to nothing in default
// builds. NEVER deploy a cu-profile build to devnet/mainnet.
//
// Phase 2 Stage A scope:
//     .context/plans/phase2-american-onchain-pricing-scope.md
// =============================================================================

#![cfg(feature = "cu-profile")]

use anchor_lang::prelude::*;

use crate::state::SharedVault;

/// Pre-Stage-A SharedVault size on disk: new INIT_SPACE minus carry_rate_bps
/// (i32 = 4 bytes), plus the 8-byte Anchor discriminator.
const LEGACY_SHARED_VAULT_DATA_SIZE: usize = 8 + SharedVault::INIT_SPACE - 4;

pub fn handle_shrink_shared_vault_for_test(
    ctx: Context<ShrinkSharedVaultForTest>,
) -> Result<()> {
    let vault_info = &ctx.accounts.shared_vault;
    // Caller has verified ownership via the constraint below; truncate the
    // data buffer to legacy size. The trailing 4 bytes (carry_rate_bps) are
    // discarded; rent overpayment for those bytes stays on the account
    // (negligible -- ~30-100 lamports).
    vault_info.realloc(LEGACY_SHARED_VAULT_DATA_SIZE, false)?;
    msg!(
        "shrunk shared_vault {} from {} to {} bytes",
        vault_info.key,
        8 + SharedVault::INIT_SPACE,
        LEGACY_SHARED_VAULT_DATA_SIZE,
    );
    Ok(())
}

#[derive(Accounts)]
pub struct ShrinkSharedVaultForTest<'info> {
    /// The vault to shrink. Bypasses Account<SharedVault> typed deserialization
    /// because we're about to mutate the data buffer in a way that would
    /// break the typed view.
    /// CHECK: owner check below; the realloc itself is the destructive op.
    #[account(
        mut,
        owner = crate::ID @ anchor_lang::error::ErrorCode::AccountOwnedByWrongProgram,
    )]
    pub shared_vault: AccountInfo<'info>,
}
