// =============================================================================
// state/writer_ask_position.rs — Per-(series, backer) writer-ask position
// =============================================================================
//
// Phase 3 Slice A: STRUCT + SEEDS ONLY. This account is NOT created or mutated
// in Slice A — `post_order` only escrows the writer's collateral per-order. The
// position is initialized and populated AT FILL in Slice B (collateral moves
// from the per-order escrow into the series pot; the writer's short obligation
// is recorded here).
//
// Distinct seed prefix from `WriterPosition` (state/writer_position.rs, seed
// ["writer_position", vault, owner], the pooled-deposit receipt) to avoid any
// PDA/namespace collision — this one is keyed by the canonical SERIES MINT, not
// the vault, and tracks personal-collateral writer asks rather than pool shares.
//
// PDA seed: ["writer_ask_position", option_mint, backer]
// One position per (series mint, backer) — a backer's asks on one series
// accumulate onto the same position at fill.
// =============================================================================

use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct WriterAskPosition {
    /// The quoting writer (backer) who posted the WriterAsk(s).
    pub backer: Pubkey,

    /// The canonical Token-2022 series mint this position backs.
    pub option_mint: Pubkey,

    /// The series' American SharedVault (market/settlement context).
    pub vault: Pubkey,

    /// USDC (6dp) moved from per-order escrow into the series pot at fill.
    /// Populated in Slice B; 0 at init.
    pub collateral_committed: u64,

    /// Contracts the backer is short on this series (minted-on-fill against
    /// their committed collateral). Populated in Slice B; 0 at init.
    pub contracts_written: u64,

    /// When this position was first created (Slice B).
    pub created_at: i64,

    /// PDA bump seed.
    pub bump: u8,
}

/// PDA seed prefix: ["writer_ask_position", option_mint, backer].
pub const WRITER_ASK_POSITION_SEED: &[u8] = b"writer_ask_position";
