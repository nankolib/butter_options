// =============================================================================
// instructions/migrate_shared_vault_exercise_style.rs -- one-time SharedVault
// schema migration (Stage C Pass 1: adds the trailing exercise_style field)
// =============================================================================
//
// Mirrors the Stage A `migrate_shared_vault_carry_rate` pattern. For each
// vault passed via remaining_accounts, if the on-disk size is shorter than
// the new INIT_SPACE, grow + zero-fill the trailing bytes. Zero-fill on
// the new trailing byte deserializes as ExerciseStyle::European (variant 0)
// -- the locked default for legacy vaults.
//
// Admin-only. Admin pays the rent delta. Idempotent. Batched via
// remaining_accounts (recommended: 20-30 per call to stay well under 1.4M CU).
//
// Important: after Pass 1 ships, `SharedVault::INIT_SPACE` is 233 (was 232
// pre-Pass-1). Both `migrate_shared_vault_carry_rate` and this new
// instruction compute `target_size = 8 + INIT_SPACE = 241`, so they're
// semantically equivalent post-Pass-1 (both grow any short vault to the
// current 241-byte schema). The distinct instruction exists for audit
// trail clarity -- the on-chain log line names the migration.
//
// Phase 2 Stage C Pass 1 scope:
//     .context/plans/phase2-american-onchain-pricing-scope.md
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::system_instruction;
use anchor_lang::Discriminator;

use crate::errors::OptaError;
use crate::state::{ProtocolState, SharedVault, PROTOCOL_SEED};

pub fn handle_migrate_shared_vault_exercise_style<'info>(
    ctx: Context<'_, '_, '_, 'info, MigrateSharedVaultExerciseStyle<'info>>,
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

        // 6. Manually zero-fill the new trailing bytes
        //    (so exercise_style deserializes as European -- variant 0).
        let mut data = vault_info.try_borrow_mut_data()?;
        for byte in data[current_len..target_size].iter_mut() {
            *byte = 0;
        }

        migrated = migrated.saturating_add(1);
        msg!(
            "migrated {}: {} -> {} bytes (exercise_style=European)",
            vault_info.key, current_len, target_size
        );
    }

    msg!(
        "migrate_shared_vault_exercise_style: migrated={} skipped={}",
        migrated, skipped
    );
    Ok(())
}

#[derive(Accounts)]
pub struct MigrateSharedVaultExerciseStyle<'info> {
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
