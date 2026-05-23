// =============================================================================
// instructions/get_option_price.rs -- Read-only AMER pricing view (Pass 3)
// =============================================================================
//
// Returns a BS-2002 American option price quote for a hypothetical option
// against a live VolOracle, WITHOUT requiring a SharedVault to exist.
//
// Designed for client-side `.view()` calls: no signer, no mutability, no
// fees. The caller specifies the option spec directly via instruction args
// rather than reading from a vault.
//
// Scope:
//   - American only. European returns ViewNotSupportedForEuropean — frontend
//     should use the off-chain BS in app/src/utils/blackScholes.ts for EUR.
//   - Uses the SAME shared `price_american` helper that mint_from_vault's
//     American branch uses, so quotes here are byte-identical to what a
//     same-block mint would charge.
//   - Risk-free rate is fixed at RISK_FREE_RATE_SCALED (5%) — single source
//     of truth in utils/american_pricing/quote.rs.
//
// CPI-callable: returns `Result<OptionPriceQuote>` so other on-chain
// programs (or the same program in a future arc) can quote without
// duplicating the math.
// =============================================================================

use anchor_lang::prelude::*;

use crate::errors::OptaError;
use crate::state::{ExerciseStyle, OptionType, OptionsMarket, VolOracle, VOL_ORACLE_SEED};
use crate::utils::american_pricing::quote::{price_american, AmericanQuoteInputs};

/// View-instruction return type. AnchorSerialize/Deserialize for IDL +
/// `.view()` decode on the client; Copy/Clone/Debug for ergonomic Rust
/// consumption (no allocations).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Debug)]
pub struct OptionPriceQuote {
    /// Quoted premium per contract in USDC smallest units (6 decimals).
    /// Matches VaultMint.premium_per_contract scale.
    pub premium_per_contract: u64,
    /// Realized vol used in the computation, at solmath SCALE 1e12. From
    /// realized_vol_annualized over the oracle's 30d window.
    pub vol_used_scaled: i64,
    /// Spot used in the computation, at solmath SCALE 1e12. From
    /// VolOracle.last_spot_price.
    pub spot_used_scaled: i64,
    /// On-chain Clock unix_timestamp at the moment the quote was computed.
    pub computed_at_ts: i64,
}

pub fn handle_get_option_price(
    ctx: Context<GetOptionPrice>,
    strike: u64,
    expiry_ts: i64,
    option_type: OptionType,
    exercise_style: ExerciseStyle,
    carry_rate_bps: i32,
) -> Result<OptionPriceQuote> {
    let now = Clock::get()?.unix_timestamp;

    match exercise_style {
        ExerciseStyle::European => err!(OptaError::ViewNotSupportedForEuropean),
        ExerciseStyle::American => {
            let oracle = ctx.accounts.vol_oracle.load()?;
            let quote = price_american(
                &*oracle,
                now,
                AmericanQuoteInputs {
                    strike,
                    expiry_ts,
                    option_type,
                    carry_rate_bps,
                },
            )?;

            Ok(OptionPriceQuote {
                premium_per_contract: quote.premium_per_contract,
                vol_used_scaled: quote.vol_used_scaled,
                spot_used_scaled: quote.spot_used_scaled,
                computed_at_ts: now,
            })
        }
    }
}

#[derive(Accounts)]
pub struct GetOptionPrice<'info> {
    /// The OptionsMarket — provides `pyth_feed_id` used as the VolOracle
    /// PDA seed. Read-only.
    pub market: Account<'info, OptionsMarket>,

    /// VolOracle PDA for the market's Pyth feed. Read-only.
    /// Bump derived canonically (not from stored bump) since the view has
    /// no perf-critical CU budget and avoids a load-before-account-ctx
    /// dance for an account that gets re-loaded inside the handler.
    #[account(
        seeds = [VOL_ORACLE_SEED, market.pyth_feed_id.as_ref()],
        bump,
    )]
    pub vol_oracle: AccountLoader<'info, VolOracle>,
}
