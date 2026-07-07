// =============================================================================
// instructions/close_market.rs — Admin-only OptionsMarket close (rent reclaim)
// =============================================================================
//
// DRAFT (Pyth→Switchboard crypto migration, cutover step). Closes an
// OptionsMarket PDA and returns its rent to the admin. Used at cutover to free a
// crypto asset's name PDA (["market", asset_name]) so an SB-sourced market can be
// re-created under the SAME real name (atomic name handover) — the migration keeps
// BTC/ETH/SOL/XRP/FARTCOIN undecorated at every step.
//
// CHILD-CHECK — why there is NO on-chain "no open vaults" guard:
//   SharedVaults reference their market by BOTH a stored `market: Pubkey` field
//   AND their PDA seed (["shared_vault"|"shared_vault_american", market.key(),
//   strike, expiry, option_type]). They are independent PDAs; the OptionsMarket
//   carries NO child counter. Proving "no vault references this market" on-chain
//   would require enumerating every SharedVault — impossible without passing them
//   all via UNBOUNDED remaining_accounts, which is also griefable (omit one and a
//   false-clean check passes). A market-side child counter would require touching
//   create_shared_vault + every vault-close path + a migration to backfill every
//   legacy market (which would read counter=0) — out of scope for the cutover.
//
//   Therefore this instruction is ADMIN-TRUSTED and safety is enforced OFF-CHAIN
//   by scripts/preflight_close_market.ts, which scans for live child vaults and
//   REFUSES to build the tx if any exist. VolOracles are NOT children (keyed by
//   feed_id, not market) — they survive the close BY DESIGN so the cutover
//   re-created same-name SB market inherits the warm oracle by feed_id.
//   SettlementRecords are keyed by asset_name and also survive (informational;
//   the preflight lists them).
//
// Admin-trusted, devnet. Ships in the cutover deploy alongside the name handover;
// INERT until then.
// =============================================================================

use anchor_lang::prelude::*;

use crate::errors::OptaError;
use crate::state::{OptionsMarket, ProtocolState, MARKET_SEED, PROTOCOL_SEED};

pub fn handle_close_market(ctx: Context<CloseMarket>, _asset_name: String) -> Result<()> {
    // No state mutation beyond the account close (handled by `close = admin`).
    // The off-chain preflight is the safety gate; on-chain we only pin the
    // canonical PDA + admin identity below.
    msg!(
        "close_market: {} ({}) closed — rent -> admin {}",
        ctx.accounts.market.asset_name,
        ctx.accounts.market.key(),
        ctx.accounts.admin.key(),
    );
    Ok(())
}

#[derive(Accounts)]
#[instruction(asset_name: String)]
pub struct CloseMarket<'info> {
    /// Admin — must equal protocol_state.admin (CRIT-3 deployer). Receives the
    /// reclaimed rent (mut for the lamport credit from `close`).
    #[account(mut, address = protocol_state.admin @ OptaError::Unauthorized)]
    pub admin: Signer<'info>,

    /// Used only to assert admin == protocol_state.admin.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// The OptionsMarket to close. Seed-pinned to the canonical PDA for
    /// `asset_name` (so a stray/orphan OptionsMarket can't be substituted);
    /// `close = admin` zeroes it and returns rent to the admin. A second close
    /// reverts — the account no longer exists (AccountNotInitialized / seeds).
    #[account(
        mut,
        seeds = [MARKET_SEED, asset_name.as_bytes()],
        bump = market.bump,
        close = admin,
    )]
    pub market: Account<'info, OptionsMarket>,
}
