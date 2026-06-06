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

/// Exercise style for the option contracts a vault writes.
///
/// **Variant order is load-bearing.** Reordering after Pass 1 ships breaks
/// every existing vault on-chain — the byte that encodes this enum is a
/// single Borsh discriminator (0 or 1). Pre-Pass-1 vaults are migrated by
/// zero-filling the new trailing byte, which deserializes as variant 0
/// (European). Swapping the order would silently retag every legacy vault
/// as American. **Do not reorder.**
///
/// Phase 2 Stage C Pass 1.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum ExerciseStyle {
    /// European — exercise only at expiry. Default for all pre-Phase-2 vaults.
    /// Migrated to via zero-fill on the trailing byte (variant index 0).
    European,
    /// American — exercise any time before or at expiry. Stage C onward.
    American,
}

impl ExerciseStyle {
    /// Single source of truth for the lowercase human-word rendering of this
    /// enum on the option mint's Token-2022 metadata (`exercise_style` key).
    /// Mirrors the lowercase-word convention `option_type` uses for
    /// "call"/"put". Phase 2 Stage E.
    pub fn metadata_str(&self) -> &'static str {
        match self {
            ExerciseStyle::European => "european",
            ExerciseStyle::American => "american",
        }
    }
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

    /// Exercise style for the option contracts minted from this vault.
    /// European (default) = exercise only at expiry; American = exercise
    /// anytime up to expiry. Set at vault creation by `create_shared_vault`
    /// and immutable thereafter.
    ///
    /// MUST be the last field in this struct -- pre-Pass-1 SharedVault
    /// accounts on devnet were serialized without this field, so they're
    /// 1 byte shorter than the new INIT_SPACE. The admin-only migration
    /// `migrate_shared_vault_exercise_style` grows them to the new size
    /// and zero-fills the trailing byte -- which then deserializes as
    /// exercise_style = European (variant 0), matching the locked default
    /// for legacy vaults. Adding any new field BEFORE this one would
    /// break that migration path. Same architectural pattern as
    /// Stage A's carry_rate_bps append.
    pub exercise_style: ExerciseStyle,
}

/// PDA seed prefix for SharedVault accounts.
pub const SHARED_VAULT_SEED: &[u8] = b"shared_vault";

/// PDA seed prefix for American-style SharedVault accounts. Separate
/// namespace from `SHARED_VAULT_SEED` so EUR and AMER vaults at the same
/// `(market, strike, expiry, option_type)` tuple are distinct PDAs.
/// `create_shared_vault` selects between the two based on the
/// `exercise_style` instruction arg.
///
/// Phase 2 Stage C Pass 1.
pub const SHARED_VAULT_AMERICAN_SEED: &[u8] = b"shared_vault_american";

/// **Single source of truth for the SharedVault PDA seed namespace.**
///
/// Returns the seed-prefix byte string that, combined with
/// `(market, strike, expiry, option_type)`, derives a vault's PDA:
/// `SHARED_VAULT_SEED` for European, `SHARED_VAULT_AMERICAN_SEED` for
/// American.
///
/// EVERY handler that signs a USDC payout *as the vault PDA* MUST build its
/// `signer_seeds` with this helper rather than hardcoding `SHARED_VAULT_SEED`.
/// Hardcoding the European prefix on an American vault re-derives a signer
/// that does not match the account, so the CPI transfer fails (the Stage D
/// bug). This is the one place EUR vs AMER is decided — `withdraw_from_vault`
/// and `claim_premium` consume it today; Stage G's settlement handlers
/// (`withdraw_post_settlement`, `auto_finalize_holders`, `auto_finalize_writers`)
/// will consume it when they get full American treatment.
///
/// Returns `&'static [u8]` (the prefix only, not full signer seeds) so call
/// sites keep their existing stack-local `strike_bytes` / `expiry_bytes` /
/// `bump` arrays without lifetime gymnastics.
///
/// Phase 2 Stage D.
pub fn vault_namespace_seed(style: ExerciseStyle) -> &'static [u8] {
    match style {
        ExerciseStyle::European => SHARED_VAULT_SEED,
        ExerciseStyle::American => SHARED_VAULT_AMERICAN_SEED,
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::{AnchorDeserialize, AnchorSerialize};

    #[test]
    fn exercise_style_european_is_variant_zero() {
        // CRITICAL: variant order is load-bearing for the migration.
        // Zero-filled bytes from migrate_shared_vault_exercise_style must
        // deserialize as European. If anyone reorders the enum, this
        // test fires and prevents the build from shipping.
        let mut buf = vec![];
        ExerciseStyle::European.serialize(&mut buf).unwrap();
        assert_eq!(buf, vec![0u8], "European must encode to [0x00]");
    }

    #[test]
    fn exercise_style_american_is_variant_one() {
        let mut buf = vec![];
        ExerciseStyle::American.serialize(&mut buf).unwrap();
        assert_eq!(buf, vec![1u8], "American must encode to [0x01]");
    }

    #[test]
    fn exercise_style_metadata_str_mapping() {
        // Phase 2 Stage E — the lowercase-word rendering written onto each new
        // option mint's Token-2022 `exercise_style` metadata pair. Locked so a
        // future rename can't silently change the on-chain literal that
        // default-on-read frontends will key against.
        assert_eq!(ExerciseStyle::European.metadata_str(), "european");
        assert_eq!(ExerciseStyle::American.metadata_str(), "american");
    }

    #[test]
    fn exercise_style_roundtrips() {
        for style in [ExerciseStyle::European, ExerciseStyle::American] {
            let mut buf = vec![];
            style.serialize(&mut buf).unwrap();
            let decoded = ExerciseStyle::try_from_slice(&buf).unwrap();
            assert_eq!(style, decoded);
        }
    }

    // -------------------------------------------------------------------------
    // Phase 2 Stage D — vault_namespace_seed is the single source of truth for
    // vault-PDA signer seeds. These are the PRIMARY regression for the Stage D
    // bug: a hardcoded SHARED_VAULT_SEED signer fails on American vaults.
    // -------------------------------------------------------------------------

    #[test]
    fn vault_namespace_seed_american_is_american_prefix() {
        assert_eq!(
            vault_namespace_seed(ExerciseStyle::American),
            SHARED_VAULT_AMERICAN_SEED,
        );
        assert_eq!(
            vault_namespace_seed(ExerciseStyle::American),
            b"shared_vault_american",
        );
    }

    #[test]
    fn vault_namespace_seed_european_is_byte_identical_to_today() {
        // Proves zero EUR behavior change: the helper returns the EXACT bytes
        // the handlers hardcoded before Stage D.
        assert_eq!(
            vault_namespace_seed(ExerciseStyle::European),
            SHARED_VAULT_SEED,
        );
        assert_eq!(
            vault_namespace_seed(ExerciseStyle::European),
            b"shared_vault",
        );
    }

    #[test]
    fn vault_namespace_seed_derives_distinct_pdas_for_same_tuple() {
        // Same (market, strike, expiry, option_type) under each namespace must
        // resolve to DIFFERENT PDAs — the whole point of the seed split, and
        // why a European-seeded signer can never authorize an American vault.
        let market = Pubkey::new_unique();
        let strike: u64 = 200_000_000;
        let expiry: i64 = 1_800_000_000;
        let option_type_byte = [OptionType::Call as u8];

        let derive = |style: ExerciseStyle| {
            Pubkey::find_program_address(
                &[
                    vault_namespace_seed(style),
                    market.as_ref(),
                    &strike.to_le_bytes(),
                    &expiry.to_le_bytes(),
                    &option_type_byte,
                ],
                &crate::ID,
            )
            .0
        };

        let eur = derive(ExerciseStyle::European);
        let amer = derive(ExerciseStyle::American);
        assert_ne!(
            eur, amer,
            "EUR and AMER vaults at the same tuple must be distinct PDAs",
        );
    }

    #[test]
    fn shared_vault_init_space_is_233() {
        // Locks the byte total against silent drift. If a future field
        // change shifts this, the migration script's hardcoded constants
        // and the matching `tests/realloc-shared-vault-exercise-style.ts`
        // expectations need to be updated in lockstep.
        assert_eq!(SharedVault::INIT_SPACE, 233);
    }
}
