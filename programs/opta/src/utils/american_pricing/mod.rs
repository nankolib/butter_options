// =============================================================================
// utils/american_pricing/mod.rs -- Bjerksund-Stensland 2002 American option
// =============================================================================
//
// Reference:
//   Bjerksund, P. and Stensland, G. (2002). "Closed-Form Valuation of American
//   Options." NHH Department of Finance and Management Science Discussion Paper
//   No. 2002/9.
//
// Closed-form approximation for American option prices on assets with
// continuous cost-of-carry. This module implements the FLAT-BOUNDARY formula
// from the 2002 paper (5 phi calls, univariate normal CDF only). The paper
// also discusses a two-step boundary extension that requires the bivariate
// normal CDF -- not implemented here; solmath does not currently expose
// bivariate-N(.).
//
// Note on the QuantLib reference oracle: as of QL 1.32, the only Python
// engine exposed is `BjerksundStenslandApproximationEngine`, which despite
// the unqualified name implements the 1993 flat-boundary form (3 phi calls,
// h(T) = -(b*T + 2*sigma*sqrt(T)) * B_0 / (B_inf - B_0)) -- not the 2002
// form (5 phi calls, K^2 / (B_0 * (B_inf - B_0)) factor in h(T)). Our Rust
// kernel uses the true 2002 form; reference comparison is against a
// pure-Python BS-2002 implementation in scripts/gen_bs2002_refs.py
// (cross-validated against QL BS-1993 within 1.0%).
//
// CALL formula (when S < B*; otherwise return S - K immediately):
//   C = a*S^b
//     - a*phi(S, T, b, B*, B*)
//     + phi(S, T, 1, B*, B*)
//     - phi(S, T, 1, K,  B*)
//     - K*phi(S, T, 0, B*, B*)
//     + K*phi(S, T, 0, K,  B*)
//
// PUT formula via McDonald-Schroder put-call symmetry:
//   P_American(S, K, r, q, sigma, T) = C_American(K, S, q, r, sigma, T)
//
// Boundary B* (Haug / QuantLib form):
//   beta  = (1/2 - b/sigma^2) + sqrt((b/sigma^2 - 1/2)^2 + 2r/sigma^2)
//   B_inf = beta/(beta-1) * K
//   B_0   = max(K, r/(r-b) * K)
//   h(T)  = -(b*T + 2*sigma*sqrt(T)) * K^2 / (B_0 * (B_inf - B_0))
//   B*    = B_0 + (B_inf - B_0) * (1 - exp(h(T)))
//
// phi_normalized function (used internally; mirrors phi but drops the S^gamma
// factor):
//   phi_norm(S, T, gamma, H, X)
//       = exp(lambda*T)
//         * [N(d) - (X/S)^kappa * N(d - 2*ln(X/S)/(sigma*sqrt(T)))]
//   where:
//     lambda = -r + gamma*b + 0.5*gamma*(gamma-1)*sigma^2
//     d      = -(ln(S/H) + (b + (gamma - 0.5)*sigma^2)*T) / (sigma*sqrt(T))
//     kappa  = 2*b/sigma^2 + (2*gamma - 1)
//
// The full phi recovers as: phi(...) = S^gamma * phi_norm(...). For gamma=0
// the factor is 1; for gamma=1 it's S; for gamma=beta the call site uses
// the precision-preserving identity below.
//
// Precision-preserving reformulation -- WHY phi_normalized exists:
//   The naive formulation alpha = (B*-K)/B*^beta truncates to 0 at SCALE
//   when beta is large. Concretely, in the McDonald-Schroder transformed
//   call for low-sigma PUTs, beta can reach ~11; B*^beta is then ~1e22 in
//   real units, and alpha is ~1e-22 (well below SCALE = 1e-12 precision).
//   Storing alpha as i128 truncates it to 0, killing both the alpha*S^beta
//   term and the alpha*phi_beta term in the BS-2002 sum -- producing a
//   silent ~50%+ underprice on these cells.
//
//   The fix: never materialize alpha as a tiny scaled value. Use the
//   algebraic identity
//       alpha * S^beta = (B* - K) * (S/B*)^beta
//   where (S/B*)^beta is normal magnitude and SCALE-representable. Then
//       alpha * phi(beta, B*, B*) = alpha*S^beta * phi_norm(beta, B*, B*)
//   uses the same precision-preserving alpha*S^beta product.
//
// All values at solmath SCALE = 1e12 fixed-point. b = r - q (cost-of-carry).
//
// Edge case ladder (in order, each early-returns):
//   1. s == 0    -> InvalidSpot
//   2. k == 0    -> InvalidStrike
//   3. q  < 0    -> InvalidCarry  (Stage A only supports q >= 0)
//   4. t == 0    -> InvalidTime
//   5. t  < 1h   -> intrinsic
//   6. sigma < 1bp -> discounted intrinsic
//   7. deep-OTM  -> 0  (S/K < 1e-6 for CALL, K/S < 1e-6 for PUT)
//
// Fast path (CALL only): when q == 0, b = r and early exercise is never
// optimal (classical no-dividend-call result). Returns European BS exactly.
// PUT has no analogous fast path (American PUT > European PUT always).
//
// Numerical fallbacks: any boundary degeneracy (beta <= 1, B_inf inverted,
// exp(h) > 1, B* <= K) returns the European BS price as a safe lower bound.
// American >= European always holds, so this is conservative.
//
// Known approximation artifact -- BS-2002 flat-boundary in the deep-ITM
// short-tenor low-vol regime: the trigger price B* can underestimate the
// true (sloping) early-exercise boundary, causing the algorithm to fire
// "exercise immediately" (return S - K) when continuing to hold has
// strictly higher expected value. Empirically observed in 2 of 300 grid
// cells (sigma=120%, expiry<=36d, deep-ITM-PUT side via McD-S). The true
// fix is the two-step boundary form from the same paper, which requires
// the bivariate normal CDF (not in solmath today). The flat-boundary
// approximation is typically within 0.1-0.3% of the two-step form; in
// the affected cells the error tops out around $0.12 on a ~$20 option,
// well within the $0.25 PARITY_SLACK in tests/. Accepted as a known
// approximation limit; revisit if Stage F's exercise UI surfaces it as
// a user-facing concern.
//
// Phase 2 Stage A scope:
//     .context/plans/phase2-american-onchain-pricing-scope.md
// =============================================================================

use solmath::{
    SCALE, SCALE_I,
    SolMathError,
    fp_mul, fp_mul_i, fp_div, fp_div_i, fp_sqrt,
    exp_fixed_i, ln_fixed_i, pow_fixed, pow_fixed_i,
    norm_cdf_poly,
    black_scholes_price,
};

#[cfg(test)]
mod test_vectors;
#[cfg(test)]
mod tests;

pub mod quote;

// =============================================================================
// Constants
// =============================================================================

/// Below this time-to-expiry (in SCALE units), return intrinsic value.
/// Equals 1 hour as a fraction of a 365.25-day year, matching the time
/// convention used by `solmath_bridge::seconds_to_time_scale`.
///
/// 3600 seconds / 31_557_600 seconds_per_year ~= 1.1407e-4 years.
/// Computed as SCALE / 8766 where 8766 = 31_557_600 / 3600 (hours per year).
const NEAR_EXPIRY_T_SCALE: u128 = SCALE / 8766;

/// Below this volatility (in SCALE units), return discounted intrinsic.
/// 1 basis point = 0.01% = SCALE / 10_000 = 100_000_000.
const ZERO_VOL_SIGMA_SCALE: u128 = SCALE / 10_000;

/// Deep-OTM threshold (S/K < 1e-6 for CALL, K/S < 1e-6 for PUT).
/// Conservative -- only catches the most degenerate inputs where the
/// premium is well below SCALE precision regardless of vol/time.
const DEEP_OTM_RATIO: u128 = 1_000_000;

// =============================================================================
// Errors
// =============================================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AmericanPricingError {
    /// Spot price was zero.
    InvalidSpot,
    /// Strike price was zero.
    InvalidStrike,
    /// Time-to-expiry was zero (negative is unrepresentable in u128).
    InvalidTime,
    /// Cost-of-carry was negative. Stage A only supports q >= 0 because the
    /// McDonald-Schroder put transformation needs q in the "r" slot of the
    /// recursive call, which is u128. Negative-carry assets (e.g. commodities
    /// with high storage costs) are deferred to a future stage.
    InvalidCarry,
    /// Volatility input failed a domain check. Currently unreachable since
    /// sigma is u128, but reserved for future bound checks (e.g. sigma > 1000%).
    InvalidVolatility,
    /// The B* boundary computation hit a numerical edge (beta <= 1, B_inf
    /// inverted, exp overflow, etc.). The caller has fallen back to the
    /// European BS price as a safe lower bound; American >= European always.
    BoundaryOverflow,
    /// Underlying solmath primitive returned an error.
    SolMath(SolMathError),
}

impl From<SolMathError> for AmericanPricingError {
    fn from(e: SolMathError) -> Self {
        Self::SolMath(e)
    }
}

// =============================================================================
// Public API: american_call_price
// =============================================================================

/// Bjerksund-Stensland 2002 closed-form American CALL price.
///
/// All values at solmath SCALE = 1e12 fixed-point.
///
/// # Parameters
/// - `s`     -- Spot price (u128, must be > 0)
/// - `k`     -- Strike price (u128, must be > 0)
/// - `r`     -- Risk-free rate (u128)
/// - `q`     -- Cost-of-carry / dividend yield (i128, must be >= 0 in Stage A)
/// - `sigma` -- Volatility (u128)
/// - `t`     -- Time to expiry in years (u128, must be > 0)
///
/// # Carry sign
/// `q` is typed `i128` for forward-compatibility with negative-carry assets
/// (e.g. commodities with significant storage costs whose net cost-of-carry
/// is negative). Stage A's math kernel REJECTS `q < 0` with
/// `AmericanPricingError::InvalidCarry`. Negative-carry support is deferred
/// to a future stage; the current McDonald-Schroder put transformation
/// requires the carry slot to be representable as `u128`.
pub fn american_call_price(
    s: u128, k: u128, r: u128, q: i128, sigma: u128, t: u128,
) -> Result<u128, AmericanPricingError> {
    // -- Edge case ladder --
    if s == 0 { return Err(AmericanPricingError::InvalidSpot); }
    if k == 0 { return Err(AmericanPricingError::InvalidStrike); }
    if q  < 0 { return Err(AmericanPricingError::InvalidCarry); }
    if t == 0 { return Err(AmericanPricingError::InvalidTime); }
    if t < NEAR_EXPIRY_T_SCALE {
        return Ok(intrinsic_call(s, k));
    }
    if sigma < ZERO_VOL_SIGMA_SCALE {
        return discounted_intrinsic_call(s, k, r, q, t);
    }
    if let Some(s_scaled) = s.checked_mul(DEEP_OTM_RATIO) {
        if s_scaled < k { return Ok(0); }
    }

    // -- Cost-of-carry b = r - q (signed) --
    let r_i = r as i128;
    let b_i = r_i - q;

    // -- Fast path: when q == 0 (b == r), early exercise is never optimal
    // for a CALL. Returns European BS exactly. q < 0 was rejected above.
    if b_i >= r_i {
        let (call, _put) = black_scholes_price(s, k, r, sigma, t)?;
        return Ok(call);
    }

    // -- BS-2002 main path --
    bs2002_call_price(s, k, r, b_i, sigma, t)
}

// =============================================================================
// Public API: american_put_price
// =============================================================================

/// Bjerksund-Stensland 2002 closed-form American PUT price via the
/// McDonald-Schroder put-call transformation:
///
///   P_American(S, K, r, q, sigma, T) = C_American(K, S, q, r, sigma, T)
///
/// Edge cases are checked here on the original parameters (so error variants
/// are meaningful to the caller), then the swapped call is dispatched into
/// `american_call_price`.
///
/// # Carry sign
/// `q` is typed `i128` for forward-compatibility, but Stage A's math kernel
/// REJECTS `q < 0` with `AmericanPricingError::InvalidCarry`. Negative-carry
/// support is deferred -- the McDonald-Schroder transformation puts `q` into
/// the recursive call's `r` slot, which is `u128` and can't represent
/// negative values.
pub fn american_put_price(
    s: u128, k: u128, r: u128, q: i128, sigma: u128, t: u128,
) -> Result<u128, AmericanPricingError> {
    if s == 0 { return Err(AmericanPricingError::InvalidSpot); }
    if k == 0 { return Err(AmericanPricingError::InvalidStrike); }
    if q  < 0 { return Err(AmericanPricingError::InvalidCarry); }
    if t == 0 { return Err(AmericanPricingError::InvalidTime); }
    if t < NEAR_EXPIRY_T_SCALE {
        return Ok(intrinsic_put(s, k));
    }
    if sigma < ZERO_VOL_SIGMA_SCALE {
        return discounted_intrinsic_put(s, k, r, q, t);
    }
    if let Some(k_scaled) = k.checked_mul(DEEP_OTM_RATIO) {
        if k_scaled < s { return Ok(0); }
    }

    // McDonald-Schroder: P(S, K, r, q, sigma, T) = C(K, S, q, r, sigma, T).
    // q >= 0 was checked above so the cast to u128 is safe.
    american_call_price(k, s, q as u128, r as i128, sigma, t)
}

// =============================================================================
// Edge case helpers
// =============================================================================

fn intrinsic_call(s: u128, k: u128) -> u128 { s.saturating_sub(k) }
fn intrinsic_put (s: u128, k: u128) -> u128 { k.saturating_sub(s) }

/// Discounted intrinsic for CALL: max(s*exp(-q*t) - k*exp(-r*t), 0).
fn discounted_intrinsic_call(
    s: u128, k: u128, r: u128, q: i128, t: u128,
) -> Result<u128, AmericanPricingError> {
    let r_i = r as i128;
    let t_i = t as i128;
    let s_disc = fp_mul_i(s as i128, exp_fixed_i(-fp_mul_i(q,   t_i)?)?)?;
    let k_disc = fp_mul_i(k as i128, exp_fixed_i(-fp_mul_i(r_i, t_i)?)?)?;
    let diff = s_disc - k_disc;
    Ok(if diff > 0 { diff as u128 } else { 0 })
}

/// Discounted intrinsic for PUT: max(k*exp(-r*t) - s*exp(-q*t), 0).
fn discounted_intrinsic_put(
    s: u128, k: u128, r: u128, q: i128, t: u128,
) -> Result<u128, AmericanPricingError> {
    let r_i = r as i128;
    let t_i = t as i128;
    let s_disc = fp_mul_i(s as i128, exp_fixed_i(-fp_mul_i(q,   t_i)?)?)?;
    let k_disc = fp_mul_i(k as i128, exp_fixed_i(-fp_mul_i(r_i, t_i)?)?)?;
    let diff = k_disc - s_disc;
    Ok(if diff > 0 { diff as u128 } else { 0 })
}

// =============================================================================
// BS-2002 main: bs2002_call_price
// =============================================================================

fn bs2002_call_price(
    s: u128, k: u128, r: u128, b_i: i128, sigma: u128, t: u128,
) -> Result<u128, AmericanPricingError> {
    #[cfg(feature = "cu-profile")]
    use solana_program::log::sol_log_compute_units;
    #[cfg(feature = "cu-profile")]
    use anchor_lang::prelude::msg;

    #[cfg(feature = "cu-profile")] { msg!("=BS2002= start"); sol_log_compute_units(); }

    // Cache invariants used across the 5 phi calls + boundary computation.
    let sqrt_t       = fp_sqrt(t)?;
    let sigma_sq     = fp_mul(sigma, sigma)?;
    let sigma_sqrt_t = fp_mul(sigma, sqrt_t)?;

    // beta
    let beta = compute_beta(r, b_i, sigma_sq)?;
    if beta <= SCALE_I {
        return european_fallback_call(s, k, r, sigma, t);
    }
    #[cfg(feature = "cu-profile")] { msg!("=BS2002= beta done"); sol_log_compute_units(); }

    // B*
    let b_star = match compute_b_star(k, r, b_i, sigma_sqrt_t, t, beta) {
        Ok(b) => b,
        Err(_) => return european_fallback_call(s, k, r, sigma, t),
    };
    #[cfg(feature = "cu-profile")] { msg!("=BS2002= b_star done"); sol_log_compute_units(); }

    // Early exercise: if S >= B*, exercise immediately.
    if s >= b_star {
        return Ok(s - k);
    }

    // -------------------------------------------------------------------------
    // Precision-preserving alpha*S^beta = (B* - K) * (S/B*)^beta.
    // See module header "Precision-preserving reformulation" for the why.
    // -------------------------------------------------------------------------
    if b_star <= k {
        // Defensive: identity still works but signals a degenerate boundary.
        return european_fallback_call(s, k, r, sigma, t);
    }
    let s_over_b_star      = fp_div(s, b_star)?;
    let ratio_pow_beta     = pow_fixed(s_over_b_star, beta as u128)?;
    let b_star_minus_k     = b_star - k;
    let alpha_s_pow_beta_u = fp_mul(b_star_minus_k, ratio_pow_beta)?;
    let alpha_s_pow_beta   = alpha_s_pow_beta_u as i128;
    #[cfg(feature = "cu-profile")] { msg!("=BS2002= alpha*S^beta done"); sol_log_compute_units(); }

    // 5 phi_normalized calls (each = exp(lambda*T) * bracket; no S^gamma factor)
    let phi_n_b_b_beta = phi_normalized(s, t, beta,    b_star, b_star, r, b_i, sigma_sq, sigma_sqrt_t)?;
    #[cfg(feature = "cu-profile")] { msg!("=BS2002= phi_n_b_b_beta done"); sol_log_compute_units(); }
    let phi_n_b_b_one  = phi_normalized(s, t, SCALE_I, b_star, b_star, r, b_i, sigma_sq, sigma_sqrt_t)?;
    #[cfg(feature = "cu-profile")] { msg!("=BS2002= phi_n_b_b_one done"); sol_log_compute_units(); }
    let phi_n_k_b_one  = phi_normalized(s, t, SCALE_I, k,      b_star, r, b_i, sigma_sq, sigma_sqrt_t)?;
    #[cfg(feature = "cu-profile")] { msg!("=BS2002= phi_n_k_b_one done"); sol_log_compute_units(); }
    let phi_n_b_b_zero = phi_normalized(s, t, 0,       b_star, b_star, r, b_i, sigma_sq, sigma_sqrt_t)?;
    #[cfg(feature = "cu-profile")] { msg!("=BS2002= phi_n_b_b_zero done"); sol_log_compute_units(); }
    let phi_n_k_b_zero = phi_normalized(s, t, 0,       k,      b_star, r, b_i, sigma_sq, sigma_sqrt_t)?;
    #[cfg(feature = "cu-profile")] { msg!("=BS2002= phi_n_k_b_zero done"); sol_log_compute_units(); }

    // Compose:
    //   C =   alpha*S^beta                                           (term0)
    //       - alpha*S^beta * phi_norm(beta, B*, B*)                  (term1 = alpha*phi_beta)
    //       + S^1 * phi_norm(1, B*, B*)                              (term2)
    //       - S^1 * phi_norm(1, K,  B*)                              (term3)
    //       - S^0 * K * phi_norm(0, B*, B*)                          (term4 = K*phi_zero_B)
    //       + S^0 * K * phi_norm(0, K,  B*)                          (term5 = K*phi_zero_K)
    let alpha_phi_beta = fp_mul_i(alpha_s_pow_beta, phi_n_b_b_beta)?;
    let s_phi_one_b    = fp_mul_i(s as i128, phi_n_b_b_one)?;
    let s_phi_one_k    = fp_mul_i(s as i128, phi_n_k_b_one)?;
    let k_phi_zero_b   = fp_mul_i(k as i128, phi_n_b_b_zero)?;
    let k_phi_zero_k   = fp_mul_i(k as i128, phi_n_k_b_zero)?;

    let result = alpha_s_pow_beta
        - alpha_phi_beta
        + s_phi_one_b
        - s_phi_one_k
        - k_phi_zero_b
        + k_phi_zero_k;

    Ok(if result > 0 { result as u128 } else { 0 })
}

fn european_fallback_call(
    s: u128, k: u128, r: u128, sigma: u128, t: u128,
) -> Result<u128, AmericanPricingError> {
    let (call, _put) = black_scholes_price(s, k, r, sigma, t)?;
    Ok(call)
}

// =============================================================================
// beta = (1/2 - b/sigma^2) + sqrt((b/sigma^2 - 1/2)^2 + 2r/sigma^2)
// =============================================================================
fn compute_beta(r: u128, b_i: i128, sigma_sq: u128) -> Result<i128, AmericanPricingError> {
    let half = SCALE_I / 2;
    let b_over_sigma_sq = fp_div_i(b_i, sigma_sq as i128)?;

    let inner = b_over_sigma_sq - half;
    let inner_sq = fp_mul_i(inner, inner)?;

    let two_r = (r as i128).checked_mul(2).ok_or(AmericanPricingError::BoundaryOverflow)?;
    let two_r_over_sigma_sq = fp_div_i(two_r, sigma_sq as i128)?;

    let discriminant = inner_sq + two_r_over_sigma_sq;
    if discriminant < 0 { return Err(AmericanPricingError::BoundaryOverflow); }
    let sqrt_disc = fp_sqrt(discriminant as u128)? as i128;

    Ok(-inner + sqrt_disc) // beta = (1/2 - b/sigma^2) + sqrt_disc
}

// =============================================================================
// B* (Haug / QuantLib form): see formula in module header
// =============================================================================
fn compute_b_star(
    k: u128, r: u128, b_i: i128, sigma_sqrt_t: u128, t: u128, beta: i128,
) -> Result<u128, AmericanPricingError> {
    let beta_minus_one = beta - SCALE_I;
    if beta_minus_one <= 0 { return Err(AmericanPricingError::BoundaryOverflow); }
    let beta_ratio = fp_div_i(beta, beta_minus_one)?;
    if beta_ratio <= 0 { return Err(AmericanPricingError::BoundaryOverflow); }
    let b_inf = fp_mul(beta_ratio as u128, k)?;

    // r - b = q (signed). bs2002_call_price is only entered when q > 0,
    // so r - b > 0.
    let r_minus_b_i = (r as i128) - b_i;
    if r_minus_b_i <= 0 { return Err(AmericanPricingError::BoundaryOverflow); }
    let r_over_q = fp_div(r, r_minus_b_i as u128)?;
    let b_0_candidate = fp_mul(r_over_q, k)?;
    let b_0 = u128::max(k, b_0_candidate);

    if b_inf <= b_0 { return Err(AmericanPricingError::BoundaryOverflow); }
    let delta = b_inf - b_0;

    // h(T) = -(b*T + 2*sigma*sqrt(T)) * K^2 / (B_0 * (B_inf - B_0))
    let two_sigma_sqrt_t = sigma_sqrt_t
        .checked_mul(2)
        .ok_or(AmericanPricingError::BoundaryOverflow)? as i128;
    let b_t = fp_mul_i(b_i, t as i128)?;
    let bt_plus = b_t + two_sigma_sqrt_t;

    let k_sq = fp_mul(k, k)?;
    let denom = fp_mul(b_0, delta)?;
    if denom == 0 { return Err(AmericanPricingError::BoundaryOverflow); }
    let k_sq_over_denom = fp_div(k_sq, denom)?;

    let h_pos = fp_mul_i(bt_plus, k_sq_over_denom as i128)?;
    let h = -h_pos;

    let exp_h = exp_fixed_i(h)?;
    if exp_h > SCALE_I { return Err(AmericanPricingError::BoundaryOverflow); }
    let one_minus_exp_h = (SCALE_I - exp_h) as u128;
    let trigger_addition = fp_mul(delta, one_minus_exp_h)?;
    Ok(b_0 + trigger_addition)
}

// =============================================================================
// phi_normalized(S, T, gamma, H, X) = exp(lambda*T) * [N(d) - (X/S)^kappa * N(d_adj)]
// (Drops the S^gamma factor that the original BS-2002 phi function carries.
//  Caller multiplies by S^gamma at the call site, or uses the precision-
//  preserving alpha*S^beta product for the gamma=beta case.)
// =============================================================================
fn phi_normalized(
    s: u128, t: u128, gamma_i: i128, h_u: u128, x_u: u128,
    r: u128, b_i: i128, sigma_sq: u128, sigma_sqrt_t: u128,
) -> Result<i128, AmericanPricingError> {
    let r_i              = r as i128;
    let t_i              = t as i128;
    let sigma_sq_i       = sigma_sq as i128;
    let sigma_sqrt_t_i   = sigma_sqrt_t as i128;

    // lambda = -r + gamma*b + 0.5*gamma*(gamma-1)*sigma^2
    let gamma_b           = fp_mul_i(gamma_i, b_i)?;
    let gamma_minus_one   = gamma_i - SCALE_I;
    let gamma_gamma_minus = fp_mul_i(gamma_i, gamma_minus_one)?;
    let half_gamma_term   = fp_mul_i(gamma_gamma_minus, sigma_sq_i)? / 2;
    let lambda            = -r_i + gamma_b + half_gamma_term;

    // exp(lambda*T)
    let lambda_t      = fp_mul_i(lambda, t_i)?;
    let exp_lambda_t  = exp_fixed_i(lambda_t)?;

    // d = -(ln(S/H) + (b + (gamma - 0.5)*sigma^2)*T) / (sigma*sqrt(T))
    let s_over_h         = fp_div(s, h_u)?;
    let ln_s_over_h      = ln_fixed_i(s_over_h)?;
    let half_sigma_sq    = sigma_sq_i / 2;
    let drift            = b_i + fp_mul_i(gamma_i, sigma_sq_i)? - half_sigma_sq;
    let drift_t          = fp_mul_i(drift, t_i)?;
    let d_num            = -(ln_s_over_h + drift_t);
    let d                = fp_div_i(d_num, sigma_sqrt_t_i)?;
    let n_d              = norm_cdf_poly(d)?;

    // (X/S)^kappa
    let x_over_s              = fp_div(x_u, s)?;
    let two_b                 = b_i.checked_mul(2)
        .ok_or(AmericanPricingError::BoundaryOverflow)?;
    let two_b_over_sigma_sq   = fp_div_i(two_b, sigma_sq_i)?;
    let two_gamma             = gamma_i.checked_mul(2)
        .ok_or(AmericanPricingError::BoundaryOverflow)?;
    let two_gamma_minus_one   = two_gamma - SCALE_I;
    let kappa                 = two_b_over_sigma_sq + two_gamma_minus_one;
    let xs_pow_kappa          = pow_fixed_i(x_over_s as i128, kappa)?;

    // d_adj = d - 2*ln(X/S)/(sigma*sqrt(T))
    let ln_x_over_s   = ln_fixed_i(x_over_s)?;
    let two_ln_xs     = ln_x_over_s.checked_mul(2)
        .ok_or(AmericanPricingError::BoundaryOverflow)?;
    let adjustment    = fp_div_i(two_ln_xs, sigma_sqrt_t_i)?;
    let d_adj         = d - adjustment;
    let n_d_adj       = norm_cdf_poly(d_adj)?;

    // phi_norm = exp(lambda*T) * [N(d) - (X/S)^kappa * N(d_adj)]
    let xs_pow_n  = fp_mul_i(xs_pow_kappa, n_d_adj)?;
    let bracket   = n_d - xs_pow_n;
    let result    = fp_mul_i(exp_lambda_t, bracket)?;
    Ok(result)
}
