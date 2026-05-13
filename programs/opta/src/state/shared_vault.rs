// =============================================================================
// state/shared_vault.rs — Shared collateral vault for pooled liquidity
// =============================================================================
//
// A SharedVault pools USDC collateral from multiple writers for a specific
// option specification (asset + strike + expiry + type). Instead of each
// writer having their own isolated escrow, writers deposit into a shared
// pool and receive proportional shares.
//
// Two vault types:
//   - Epoch: Protocol-defined expiry (Fridays at 08:00 UTC), open to all writers
//   - Custom: Writer-defined expiry, restricted to a single writer
//
// PDA seed: ["shared_vault", market, strike_price(8), expiry(8), option_type(1)]
//
// This ensures exactly one vault per unique option specification within a market.
// =============================================================================

use anchor_lang::prelude::*;
use super::market::OptionType;

/// Whether this vault is an epoch (shared) or custom (single-writer) vault.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum VaultType {
    /// Protocol-defined expiry (fixed Fridays at 08:00 UTC).
    /// Multiple writers can deposit — this is the shared liquidity pool.
    Epoch,
    /// Writer-defined expiry, single writer only.
    /// Functions like the v1 isolated escrow but using the vault infrastructure.
    Custom,
}

#[account]
#[derive(InitSpace)]
pub struct SharedVault {
    // === Identity (what kind of option is this vault for?) ===

    /// Which OptionsMarket this vault belongs to.
    pub market: Pubkey,

    /// Call or Put — reuses the existing OptionType enum from market.rs.
    pub option_type: OptionType,

    /// Strike price in USDC (6 decimals). Example: $200.00 = 200_000_000.
    pub strike_price: u64,

    /// Unix timestamp when all options in this vault expire.
    pub expiry: i64,

    // === Vault type ===

    /// Epoch (shared, Friday expiries) or Custom (single writer, any expiry).
    pub vault_type: VaultType,

    // === Collateral tracking ===

    /// Total USDC locked across all writers in this vault (6 decimals).
    pub total_collateral: u64,

    /// Total shares issued to all writers. First depositor gets 1:1 ratio,
    /// subsequent depositors get proportional shares.
    pub total_shares: u64,

    /// The USDC token account holding this vault's collateral.
    /// Authority = this SharedVault PDA.
    pub vault_usdc_account: Pubkey,

    /// Stage 3: the mint of the collateral token. USDC-only enforced today
    /// via a runtime check in `create_shared_vault` against
    /// `protocol_state.usdc_mint`. The field exists so every vault is
    /// self-describing — the 6 ATA-mint constraints across vault-context
    /// instructions read from here rather than from protocol_state, which
    /// keeps the door open for per-vault collateral diversification later.
    pub collateral_mint: Pubkey,

    // === Options tracking ===

    /// Total option tokens minted from this vault across all writers.
    pub total_options_minted: u64,

    /// Total option tokens that have been purchased by buyers.
    pub total_options_sold: u64,

    /// Total premium collected in this vault (USDC, 6 decimals).
    /// FIX L-04: renamed from premium_collected for clarity.
    pub net_premium_collected: u64,

    /// FIX H-01: Cumulative premium per share, scaled by 1e12.
    /// Implements reward-per-share accumulator pattern to prevent
    /// late-depositor premium dilution.
    pub premium_per_share_cumulative: u128,

    // === Settlement ===

    /// Whether this vault has been settled after expiry.
    pub is_settled: bool,

    /// Final settlement price (0 until settled). Copied from market.
    pub settlement_price: u64,

    /// Collateral remaining after settlement payouts. Writers withdraw from this.
    pub collateral_remaining: u64,

    // === Metadata ===

    /// Who created this vault (the first depositor).
    /// For Custom vaults, this is the only allowed depositor.
    pub creator: Pubkey,

    /// When this vault was created.
    pub created_at: i64,

    /// PDA bump seed.
    pub bump: u8,

    /// Cost-of-carry rate at vault creation, in basis points (signed).
    /// Positive = positive carry (e.g. dividend yield on equities).
    /// Negative = negative net carry (e.g. commodities with storage costs).
    /// Defaults to 0 for non-dividend crypto assets.
    /// For future yield-bearing assets (jitoSOL etc.) this will be set
    /// non-zero at vault creation.
    ///
    /// MUST be the last field in this struct -- pre-Stage-A SharedVault
    /// accounts on devnet/mainnet were serialized without this field, so
    /// they're 4 bytes shorter than the new INIT_SPACE. The lazy-realloc
    /// migration in `claim_premium` (Stage A step 2.3) grows them to the
    /// new size and zero-fills the trailing bytes -- which then deserialize
    /// as carry_rate_bps = 0, matching the no-dividend default. Adding any
    /// new field BEFORE this one would break that migration path because
    /// existing on-chain bytes for the trailing fields would shift.
    pub carry_rate_bps: i32,
}

/// PDA seed prefix for SharedVault accounts.
pub const SHARED_VAULT_SEED: &[u8] = b"shared_vault";

/// PDA seed prefix for the vault's USDC token account.
pub const VAULT_USDC_SEED: &[u8] = b"vault_usdc";

/// Holder exercise window in seconds, applied post-expiry before writers
/// may call withdraw_post_settlement or auto_finalize_writers (CRIT-1
/// audit-fix arc, Run-6). 24 hours matches industry-standard cash-settled
/// options conventions and gives ITM holders a clear, predictable window
/// to exercise via either exercise_from_vault or auto_finalize_holders
/// before pro-rata writer payouts can deplete vault.collateral_remaining.
///
/// Vaults with `total_options_sold == 0` bypass this gate (no buyers ever
/// bought, so no holders exist to harm — writers can withdraw immediately
/// at settle time).
pub const EXERCISE_WINDOW: i64 = 86_400;
