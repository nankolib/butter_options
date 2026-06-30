// =============================================================================
// instructions/migrate_shared_vault_residual_shares.rs -- one-time SharedVault
// schema migration (Phase 3 Slice D2a: adds the trailing writer_ask_equiv_shares
// field)
// =============================================================================
//
// Mirrors the Pass-A / D1 migration pattern exactly (the 7th such append). For
// each vault passed via remaining_accounts, if the on-disk size is shorter than
// the new INIT_SPACE, grow + zero-fill the trailing bytes. Zero-fill on the new
// 8 trailing bytes deserializes as writer_ask_equiv_shares = 0 -- the correct
// default for a legacy vault (settled with no writer-ask equiv-shares folded).
//
// CONSOLIDATION (the locked D2a decision): this single migration grows a vault
// at ANY prior size straight to the new target. A pre-D1 vault (260 bytes,
// post-Pass-A) grows by 16 bytes (writer_ask_collateral_swept + writer_ask_equiv_shares,
// both zero-filled → both default 0); a post-D1 vault (268 bytes) grows by 8.
// It therefore SUPERSEDES the D1 `migrate_shared_vault_writer_ask_swept` at
// deploy: run ONLY this 276-migration, not the D1 268-migration. (The D1
// instruction stays compiled in for callers that already ran it, but the deploy
// runbook calls this one.)
//
// Admin-only. Admin pays the rent delta. Idempotent. Batched via
// remaining_accounts (recommended: 20 per call to stay under Solana's tx
// serialization limit; see feedback_remaining_accounts_batch_size).
//
// After Slice D2a ships, `SharedVault::INIT_SPACE` is 268 (was 260 post-D1), so
// `target_size = 8 + INIT_SPACE = 276`.
//
// DEPLOY COUPLING (the May-19 lesson): until this migration runs on devnet, the
// deployed-old-program + new-IDL combination drops legacy vaults from
// `safeFetchAll` (typed deserialization fails on the short size), and any
// settle/exercise/withdraw against a legacy vault reverts. Deploy and migration
// must execute together -- see HANDOFF.md for the live devnet vault count.
//
// Phase 3 spec: .context/plans/opta-exchange-spec.md §8 (writer asks / Slice D).
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::system_instruction;
use anchor_lang::Discriminator;

use crate::errors::OptaError;
use crate::state::{ProtocolState, SharedVault, PROTOCOL_SEED};

pub fn handle_migrate_shared_vault_residual_shares<'info>(
    ctx: Context<'_, '_, '_, 'info, MigrateSharedVaultResidualShares<'info>>,
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

        // 6. Manually zero-fill the new trailing bytes (so writer_ask_collateral_swept
        //    AND writer_ask_equiv_shares both deserialize as 0 — handles a vault
        //    grown straight from the pre-D1 260-byte size in one step).
        let mut data = vault_info.try_borrow_mut_data()?;
        for byte in data[current_len..target_size].iter_mut() {
            *byte = 0;
        }

        migrated = migrated.saturating_add(1);
        msg!(
            "migrated {}: {} -> {} bytes (writer_ask_equiv_shares=0)",
            vault_info.key, current_len, target_size
        );
    }

    msg!(
        "migrate_shared_vault_residual_shares: migrated={} skipped={}",
        migrated, skipped
    );
    Ok(())
}

#[derive(Accounts)]
pub struct MigrateSharedVaultResidualShares<'info> {
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
