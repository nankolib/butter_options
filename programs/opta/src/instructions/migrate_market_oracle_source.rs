// =============================================================================
// instructions/migrate_market_oracle_source.rs -- one-time OptionsMarket
// schema migration (Switchboard Stage 2: adds the trailing oracle_source byte)
// =============================================================================
//
// Anchor's `realloc` constraint runs AFTER typed `Account<T>` deserialization,
// so it cannot lazily migrate an OptionsMarket that's missing the new
// oracle_source field (typed deser fails on too-short data before realloc can
// grow the account). This instruction does the migration explicitly: for each
// market passed via remaining_accounts, if the on-disk size is shorter than the
// new INIT_SPACE, grow + zero-fill the trailing byte (-> oracle_source = 0 =
// Pyth, the no-op default that keeps every read path unconditionally Pyth until
// Stage 3 wires routing).
//
// Direct copy of the migrate_shared_vault_carry_rate pattern (Stage A):
// admin-only, remaining_accounts batched, idempotent. The ONLY shape
// differences are the target type (OptionsMarket) and the trailing delta
// (1 byte here vs 4 for carry_rate).
//
// MIGRATION SCOPE (Switchboard Stage 2): the 16 current per-asset markets
// (62 bytes -> 63). The ~433 pre-Stage-2 per-variation orphan accounts share
// the OptionsMarket discriminator but are LARGER (87/88/68 bytes); the
// `len >= target_size` idempotency check below skips them untouched, and they
// are unreachable on-chain anyway (every typed-load site resolves a market by
// asset_name -> one of the 16 current PDAs).
//
// Admin-only (matches migrate_pyth_feed / migrate_shared_vault_carry_rate).
// Admin pays the (negligible, 1-byte) rent delta.
//
// Idempotent: markets already at the new size are skipped with a log line.
// Caller batches markets into groups (BATCH_SIZE = 20, well under the 1232-byte
// tx serialization limit; the full current set of 16 fits in a single call).
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::program::invoke;
use anchor_lang::solana_program::system_instruction;
use anchor_lang::Discriminator;

use crate::errors::OptaError;
use crate::state::{OptionsMarket, ProtocolState, PROTOCOL_SEED};

pub fn handle_migrate_market_oracle_source<'info>(
    ctx: Context<'_, '_, '_, 'info, MigrateMarketOracleSource<'info>>,
) -> Result<()> {
    let target_size = 8 + OptionsMarket::INIT_SPACE;
    let rent = Rent::get()?;
    let target_rent = rent.minimum_balance(target_size);

    let mut migrated: u32 = 0;
    let mut skipped: u32 = 0;

    for market_info in ctx.remaining_accounts.iter() {
        // 1. Owner check -- only migrate accounts owned by this program
        require_keys_eq!(*market_info.owner, crate::ID, OptaError::Unauthorized);

        // 2. Discriminator check -- only migrate OptionsMarket accounts
        let data = market_info.try_borrow_data()?;
        require!(data.len() >= 8, OptaError::Unauthorized);
        require!(
            &data[..8] == OptionsMarket::DISCRIMINATOR,
            OptaError::Unauthorized
        );
        let current_len = data.len();
        drop(data);

        // 3. Idempotency: skip if already at correct size or larger. The
        //    "larger" arm is what protects the ~433 pre-Stage-2 per-variation
        //    orphans (87/88/68 bytes) -- they share the discriminator but must
        //    NOT be touched.
        if current_len >= target_size {
            skipped = skipped.saturating_add(1);
            msg!(
                "skipped {}: already at size {} (target {})",
                market_info.key, current_len, target_size
            );
            continue;
        }

        // 4. Top up rent if needed (admin pays)
        let lamports_needed = target_rent.saturating_sub(market_info.lamports());
        if lamports_needed > 0 {
            invoke(
                &system_instruction::transfer(
                    ctx.accounts.admin.key,
                    market_info.key,
                    lamports_needed,
                ),
                &[
                    ctx.accounts.admin.to_account_info(),
                    market_info.clone(),
                    ctx.accounts.system_program.to_account_info(),
                ],
            )?;
        }

        // 5. Grow the account
        market_info.realloc(target_size, false)?;

        // 6. Manually zero-fill the new trailing byte
        //    (so oracle_source deserializes as 0 -- the Pyth default).
        let mut data = market_info.try_borrow_mut_data()?;
        for byte in data[current_len..target_size].iter_mut() {
            *byte = 0;
        }

        migrated = migrated.saturating_add(1);
        msg!(
            "migrated {}: {} -> {} bytes",
            market_info.key, current_len, target_size
        );
    }

    msg!(
        "migrate_market_oracle_source: migrated={} skipped={}",
        migrated, skipped
    );
    Ok(())
}

#[derive(Accounts)]
pub struct MigrateMarketOracleSource<'info> {
    /// Admin -- must match protocol_state.admin (CRIT-3 deployer pubkey).
    /// Pays the rent delta for any grown markets.
    #[account(mut, address = protocol_state.admin @ OptaError::Unauthorized)]
    pub admin: Signer<'info>,

    /// Used only to assert admin == protocol_state.admin.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    pub system_program: Program<'info, System>,
    // remaining_accounts: OptionsMarket accounts to migrate
}
