// =============================================================================
// instructions/migrate_shared_vault_exercise_tracking.rs -- one-time SharedVault
// schema migration (Stage F: adds the trailing exercised_options +
// early_exercise_payout fields)
// =============================================================================
//
// Mirrors the Stage C `migrate_shared_vault_exercise_style` pattern exactly.
// For each vault passed via remaining_accounts, if the on-disk size is shorter
// than the new INIT_SPACE, grow + zero-fill the trailing bytes. Zero-fill on
// the new 16 trailing bytes deserializes as exercised_options = 0 and
// early_exercise_payout = 0 -- the correct default for a vault that has had no
// early exercises.
//
// Admin-only. Admin pays the rent delta. Idempotent. Batched via
// remaining_accounts (recommended: 20 per call to stay under Solana's tx
// serialization limit; see feedback_remaining_accounts_batch_size).
//
// After Stage F ships, `SharedVault::INIT_SPACE` is 249 (was 233 pre-Stage-F),
// so `target_size = 8 + INIT_SPACE = 257`. A pre-Stage-F vault is 241 bytes
// (post-exercise-style) and grows by 16 bytes here.
//
// Phase 2 Stage F scope:
//     .context/plans/stage-f-exercise-american-scope.md
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::system_instruction;
use anchor_lang::Discriminator;

use crate::errors::OptaError;
use crate::state::{ProtocolState, SharedVault, PROTOCOL_SEED};

pub fn handle_migrate_shared_vault_exercise_tracking<'info>(
    ctx: Context<'_, '_, '_, 'info, MigrateSharedVaultExerciseTracking<'info>>,
) -> Result<()> {
    let target_size = 8 + SharedVault::INIT_SPACE;
    let rent = Rent::get()?;
    let target_rent = rent.minimum_balance(target_size);

    let mut migrated: u32 = 0;
    let mut skipped: u32 = 0;

    for vault_info in ctx.remaining_accounts.iter() {
        // 1. Owner check -- only migrate accounts owned by this program
        require_keys_eq!(*vault_info.owner, crate::ID, OptaError::Unauthorized);

        // 2. Discriminator check -- only migrate SharedVault accounts
        let data = vault_info.try_borrow_data()?;
        require!(data.len() >= 8, OptaError::Unauthorized);
        require!(
            &data[..8] == SharedVault::DISCRIMINATOR,
            OptaError::Unauthorized
        );
        let current_len = data.len();
        drop(data);

        // 3. Idempotency: skip if already at correct size (or larger)
        if current_len >= target_size {
            skipped = skipped.saturating_add(1);
            msg!(
                "skipped {}: already at size {} (target {})",
                vault_info.key, current_len, target_size
            );
            continue;
        }

        // 4. Top up rent if needed (admin pays)
        let lamports_needed = target_rent.saturating_sub(vault_info.lamports());
        if lamports_needed > 0 {
            invoke(
                &system_instruction::transfer(
                    ctx.accounts.admin.key,
                    vault_info.key,
                    lamports_needed,
                ),
                &[
                    ctx.accounts.admin.to_account_info(),
                    vault_info.clone(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;
        }

        // 5. Grow the account
        vault_info.realloc(target_size, false)?;

        // 6. Manually zero-fill the new trailing bytes (so exercised_options
        //    and early_exercise_payout both deserialize as 0).
        let mut data = vault_info.try_borrow_mut_data()?;
        for byte in data[current_len..target_size].iter_mut() {
            *byte = 0;
        }

        migrated = migrated.saturating_add(1);
        msg!(
            "migrated {}: {} -> {} bytes (exercised_options=0, early_exercise_payout=0)",
            vault_info.key, current_len, target_size
        );
    }

    msg!(
        "migrate_shared_vault_exercise_tracking: migrated={} skipped={}",
        migrated, skipped
    );
    Ok(())
}

#[derive(Accounts)]
pub struct MigrateSharedVaultExerciseTracking<'info> {
    /// Admin -- must match protocol_state.admin (CRIT-3 deployer pubkey).
    /// Pays the rent delta for any grown vaults.
    #[account(mut, address = protocol_state.admin @ OptaError::Unauthorized)]
    pub admin: Signer<'info>,

    /// Used only to assert admin == protocol_state.admin.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    pub system_program: Program<'info, System>,
    // remaining_accounts: SharedVault accounts to migrate
}
