// =============================================================================
// instructions/shrink_shared_vault_to_pre_exercise_style_for_test.rs
// -- test-only pre-Pass-1 simulator (Stage C Pass 1)
// =============================================================================
//
// Shrinks a SharedVault's data buffer back to the pre-Pass-1 size (without
// the trailing exercise_style field). Used to simulate a legacy on-chain
// vault for the realloc test in tests/realloc-shared-vault-exercise-style.ts.
//
// Parallel to Stage A's shrink_shared_vault_for_test (which truncates by 4
// for the carry_rate_bps removal). Don't parameterize the existing one --
// keeping per-migration shrinkers separate matches the per-stage pattern.
//
// Gated by the `cu-profile` Cargo feature -- compiles to nothing in default
// builds. NEVER deploy a cu-profile build to devnet/mainnet.
//
// Phase 2 Stage C Pass 1 scope:
//     .context/plans/phase2-american-onchain-pricing-scope.md
// =============================================================================

#![cfg(feature = "cu-profile")]

use anchor_lang::prelude::*;

use crate::state::SharedVault;

/// Pre-Pass-1 SharedVault size on disk: new INIT_SPACE minus exercise_style
/// (ExerciseStyle enum = 1 byte), plus the 8-byte Anchor discriminator.
const PRE_PASS1_SHARED_VAULT_DATA_SIZE: usize = 8 + SharedVault::INIT_SPACE - 1;

pub fn handle_shrink_shared_vault_to_pre_exercise_style_for_test(
    ctx: Context<ShrinkSharedVaultToPreExerciseStyleForTest>,
) -> Result<()> {
    let vault_info = &ctx.accounts.shared_vault;
    // Caller has verified ownership via the constraint below; truncate the
    // data buffer to pre-Pass-1 size. The trailing 1 byte (exercise_style)
    // is discarded; rent overpayment for that byte stays on the account.
    vault_info.realloc(PRE_PASS1_SHARED_VAULT_DATA_SIZE, false)?;
    msg!(
        "shrunk shared_vault {} from {} to {} bytes (pre-Pass-1 size)",
        vault_info.key,
        8 + SharedVault::INIT_SPACE,
        PRE_PASS1_SHARED_VAULT_DATA_SIZE,
    );
    Ok(())
}

#[derive(Accounts)]
pub struct ShrinkSharedVaultToPreExerciseStyleForTest<'info> {
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
