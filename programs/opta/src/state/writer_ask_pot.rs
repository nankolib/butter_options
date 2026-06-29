// =============================================================================
// state/writer_ask_pot.rs — Per-series collateral pot for writer asks
// =============================================================================
//
// Phase 3 Slice A: STRUCT + SEEDS ONLY. Neither the pot record nor its USDC
// token account is created in Slice A, and no collateral moves into it here.
// `post_order` escrows the writer's collateral into the PER-ORDER escrow
// (["resting_order_escrow", order]) only. At FILL (Slice B) the filled slice
// moves from that per-order escrow into this per-series pot, and the pot's USDC
// token account (authority = protocol_state) is created/funded then.
//
// One pot per canonical series mint — it aggregates all backers' committed
// collateral for the series, mirroring how the pooled vault is the per-spec
// collateral pot for the peg.
//
// PDA seeds:
//   pot record       : ["writer_ask_pot", option_mint]
//   pot USDC account : ["writer_ask_pot_usdc", option_mint]
// =============================================================================

use anchor_lang::prelude::*;

#[account]
#[derive(InitSpace)]
pub struct WriterAskPot {
    /// The canonical Token-2022 series mint this pot collateralizes.
    pub option_mint: Pubkey,

    /// The series' American SharedVault.
    pub vault: Pubkey,

    /// The pot's USDC token account (PDA ["writer_ask_pot_usdc", option_mint],
    /// authority = protocol_state). Created/funded in Slice B.
    pub usdc_account: Pubkey,

    /// Total USDC (6dp) committed across all backers' filled asks. 0 at init.
    pub total_collateral: u64,

    /// Total contracts written against this pot. 0 at init.
    pub total_contracts: u64,

    /// PDA bump seed.
    pub bump: u8,
}

/// PDA seed prefix for the pot record: ["writer_ask_pot", option_mint].
pub const WRITER_ASK_POT_SEED: &[u8] = b"writer_ask_pot";

/// PDA seed prefix for the pot's USDC token account:
/// ["writer_ask_pot_usdc", option_mint].
pub const WRITER_ASK_POT_USDC_SEED: &[u8] = b"writer_ask_pot_usdc";
