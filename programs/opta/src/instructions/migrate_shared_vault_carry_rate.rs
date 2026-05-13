// =============================================================================
// instructions/migrate_shared_vault_carry_rate.rs -- one-time SharedVault
// schema migration (Stage A: adds the trailing carry_rate_bps field)
// =============================================================================
//
// Anchor's `realloc` constraint runs AFTER typed `Account<T>` deserialization,
// so it cannot lazily migrate a SharedVault that's missing the new
// carry_rate_bps field (typed deser fails on too-short data before realloc
// can grow the account). This instruction does the migration explicitly:
// for each vault passed via remaining_accounts, if the on-disk size is
// shorter than the new INIT_SPACE, grow + zero-fill the trailing bytes.
//
// Admin-only (matches the migrate_pyth_feed pattern). Admin pays the rent
// delta -- one person paying once is fairer than imposing a tiny rent cost
// on every vault writer's first claim_premium call.
//
// Idempotent: vaults already at the new size are skipped with a log line.
// Caller batches vaults into manageable groups (recommended: 20-30 per call
// to stay well under 1.4M CU / tx).
//
// Phase 2 Stage A scope:
//     .context/plans/phase2-american-onchain-pricing-scope.md
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::system_instruction;
use anchor_lang::Discriminator;

use crate::errors::OptaError;
use crate::state::{ProtocolState, SharedVault, PROTOCOL_SEED};

pub fn handle_migrate_shared_vault_carry_rate<'info>(
    ctx: Context<'_, '_, '_, 'info, MigrateSharedVaultCarryRate<'info>>,
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

        // 3. Idempotency: skip if already at correct size (or larger -- shouldn't happen)
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
        //    (so carry_rate_bps deserializes as 0 -- the no-dividend default).
        let mut data = vault_info.try_borrow_mut_data()?;
        for byte in data[current_len..target_size].iter_mut() {
            *byte = 0;
        }

        migrated = migrated.saturating_add(1);
        msg!(
            "migrated {}: {} -> {} bytes",
            vault_info.key, current_len, target_size
        );
    }

    msg!(
        "migrate_shared_vault_carry_rate: migrated={} skipped={}",
        migrated, skipped
    );
    Ok(())
}

#[derive(Accounts)]
pub struct MigrateSharedVaultCarryRate<'info> {
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
