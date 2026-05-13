#!/usr/bin/env python3
# Requires Python 3.8+ (modern datetime.timezone.utc + from __future__ import annotations).
"""
Bjerksund-Stensland 2002 American option pricing reference-value generator.

Produces 150 reference points (5 moneyness x 5 TTE x 6 vol) for both CALL and
PUT, 300 expected values total. Output is written to
    programs/opta/src/utils/american_pricing/test_vectors.rs
as a const array of TestVector rows.

PRIMARY reference: pure-Python BS-2002 (5 phi, full Bjerksund-Stensland 2002
flat-boundary form). Mirrors the Rust kernel structure in
programs/opta/src/utils/american_pricing/mod.rs so an auditor can verify
side-by-side. No scipy dependency -- normal CDF via math.erf.

SECONDARY sanity oracle: QuantLib 1.32 BjerksundStenslandApproximationEngine.
Note that QL's class-of-this-name implements BS-1993 (3 phi), not BS-2002.
We keep it as a cross-validation check: Python BS-2002 and QL BS-1993 are
expected to agree within 1.0% on every row (typically <0.5%; the 1993-vs-2002
gap shows up most on ITM short-tenor low-vol PUT cells).

Regenerate via:
    python3 scripts/gen_bs2002_refs.py

Dependencies: see scripts/requirements.txt.
Python is NOT a runtime dependency of the program -- only used at
test-vector generation time. Auditors can regenerate and diff.

Phase 2 Stage A scope:
    .context/plans/phase2-american-onchain-pricing-scope.md
"""

from __future__ import annotations

import datetime as _dt
import math
import pathlib
import sys

try:
    import QuantLib as ql
except ImportError:
    sys.stderr.write(
        "QuantLib import failed. Install via:\n"
        "    python3 -m pip install -r scripts/requirements.txt\n"
    )
    sys.exit(1)


# ----------------------------------------------------------------------------
# Grid (5 moneyness x 5 TTE x 6 vol = 150 rows; CALL + PUT per row)
# ----------------------------------------------------------------------------
STRIKE = 100.0
R = 0.05
Q = 0.0

MONEYNESS = [0.80, 0.95, 1.00, 1.05, 1.20]
TTE_DAYS = [4, 36, 91, 182, 365]
VOL = [0.10, 0.20, 0.40, 0.60, 0.80, 1.20]

SCALE = 10**12
DAY_COUNT = ql.Actual365Fixed()


# ----------------------------------------------------------------------------
# Scaling helpers
# ----------------------------------------------------------------------------
def to_scale_u(x: float) -> int:
    assert x >= 0, f"to_scale_u: negative input {x}"
    return int(round(x * SCALE))


def to_scale_i(x: float) -> int:
    return int(round(x * SCALE))


# ============================================================================
# PRIMARY REFERENCE: pure-Python BS-2002 (mirrors the Rust kernel)
# ============================================================================
#
# Bjerksund, P. and Stensland, G. (2002). "Closed-Form Valuation of American
# Options." NHH Department of Finance and Management Science Discussion Paper
# No. 2002/9.
#
# Function-by-function correspondence with programs/opta/src/utils/
# american_pricing/mod.rs:
#   _norm_cdf            <-> solmath::norm_cdf_poly
#   _european_call       <-> solmath::black_scholes_price (call leg)
#   _phi                 <-> phi
#   _bs2002_main_call    <-> bs2002_call_price
#   bs2002_price_python  <-> american_call_price / american_put_price
# ============================================================================


def _norm_cdf(x: float) -> float:
    """Standard normal CDF via math.erf -- avoids scipy."""
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _european_call(S: float, K: float, r: float, sigma: float, T: float) -> float:
    """Standard European Black-Scholes call. Used as fast path (q==0) and
    as fallback when boundary computation degenerates."""
    sqrt_t = math.sqrt(T)
    d1 = (math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrt_t)
    d2 = d1 - sigma * sqrt_t
    return S * _norm_cdf(d1) - K * math.exp(-r * T) * _norm_cdf(d2)


def _phi(S: float, T: float, gamma: float, H: float, X: float,
         r: float, b: float, sigma: float) -> float:
    """
    BS-2002 phi function. Mirrors `phi` in the Rust kernel.

      phi(S, T, gamma, H, X)
        = exp(lambda*T) * S^gamma
          * [N(d) - (X/S)^kappa * N(d - 2*ln(X/S)/(sigma*sqrt(T)))]

      lambda = -r + gamma*b + 0.5*gamma*(gamma-1)*sigma^2
      d      = -(ln(S/H) + (b + (gamma - 0.5)*sigma^2)*T) / (sigma*sqrt(T))
      kappa  = 2*b/sigma^2 + (2*gamma - 1)
    """
    sigma_sq = sigma * sigma
    sigma_sqrt_t = sigma * math.sqrt(T)
    lambda_ = -r + gamma * b + 0.5 * gamma * (gamma - 1.0) * sigma_sq
    d = -(math.log(S / H) + (b + (gamma - 0.5) * sigma_sq) * T) / sigma_sqrt_t
    kappa = 2.0 * b / sigma_sq + (2.0 * gamma - 1.0)
    return (
        math.exp(lambda_ * T)
        * (S ** gamma)
        * (
            _norm_cdf(d)
            - (X / S) ** kappa
            * _norm_cdf(d - 2.0 * math.log(X / S) / sigma_sqrt_t)
        )
    )


def _bs2002_main_call(S: float, K: float, r: float, b: float,
                      sigma: float, T: float) -> float:
    """Main BS-2002 (5-phi) formula for CALL. Mirrors `bs2002_call_price`
    in the Rust kernel. Caller has verified b < r (i.e. q > 0).

    Uses Haug/QL form for h(T):
      h(T) = -(b*T + 2*sigma*sqrt(T)) * K^2 / (B_0 * (B_inf - B_0))

    Falls back to European on boundary degeneracies (matches the Rust
    european_fallback_call path).
    """
    sigma_sq = sigma * sigma

    # beta = (1/2 - b/sigma^2) + sqrt((b/sigma^2 - 1/2)^2 + 2r/sigma^2)
    beta = (0.5 - b / sigma_sq) + math.sqrt(
        (b / sigma_sq - 0.5) ** 2 + 2.0 * r / sigma_sq
    )
    if beta <= 1.0:
        return _european_call(S, K, r, sigma, T)

    B_inf = beta / (beta - 1.0) * K
    # r - b == q (signed). Caller guarantees q > 0.
    B_0 = max(K, r / (r - b) * K)
    if B_inf <= B_0:
        return _european_call(S, K, r, sigma, T)

    # h(T) (Haug/QL form)
    h_T = -(b * T + 2.0 * sigma * math.sqrt(T)) * K * K / (B_0 * (B_inf - B_0))
    try:
        exp_h = math.exp(h_T)
    except OverflowError:
        return _european_call(S, K, r, sigma, T)
    if exp_h > 1.0:
        return _european_call(S, K, r, sigma, T)
    B_star = B_0 + (B_inf - B_0) * (1.0 - exp_h)

    # Early exercise
    if S >= B_star:
        return S - K

    # alpha = (B* - K) / B*^beta
    if B_star <= K:
        return _european_call(S, K, r, sigma, T)
    alpha = (B_star - K) / (B_star ** beta)

    # 5 phi calls
    phi_b_b_beta = _phi(S, T, beta, B_star, B_star, r, b, sigma)
    phi_b_b_one  = _phi(S, T, 1.0,  B_star, B_star, r, b, sigma)
    phi_k_b_one  = _phi(S, T, 1.0,  K,      B_star, r, b, sigma)
    phi_b_b_zero = _phi(S, T, 0.0,  B_star, B_star, r, b, sigma)
    phi_k_b_zero = _phi(S, T, 0.0,  K,      B_star, r, b, sigma)

    # C = alpha*S^beta - alpha*phi_1 + phi_2 - phi_3 - K*phi_4 + K*phi_5
    result = (
        alpha * (S ** beta)
        - alpha * phi_b_b_beta
        + phi_b_b_one
        - phi_k_b_one
        - K * phi_b_b_zero
        + K * phi_k_b_zero
    )
    return max(result, 0.0)


def bs2002_price_python(option_type: str, S: float, K: float,
                        r: float, q: float, sigma: float, T: float) -> float:
    """
    Pure-Python BS-2002 American option pricer (PRIMARY reference).

    Parameters in REAL units (not scaled). q must be >= 0 (Stage A
    constraint matching the Rust kernel's InvalidCarry rejection).

    Edge case ladder mirrors the Rust kernel exactly.
    """
    assert option_type in ("call", "put")
    assert S > 0 and K > 0 and sigma >= 0 and T > 0
    assert q >= 0, "Stage A only supports q >= 0 (matches Rust InvalidCarry)"

    # PUT via McDonald-Schroder transformation
    if option_type == "put":
        return bs2002_price_python("call", K, S, q, r, sigma, T)

    # Edge ladder
    if T < 1.0 / 8766:                 # < 1 hour as fraction of 365.25-day year
        return max(S - K, 0.0)
    if sigma < 1.0 / 10_000:           # < 1 bp
        return max(S * math.exp(-q * T) - K * math.exp(-r * T), 0.0)
    if S * 1_000_000 < K:              # deep OTM
        return 0.0

    # Cost-of-carry + fast path (q == 0 -> never exercise early -> European)
    b = r - q
    if b >= r:
        return _european_call(S, K, r, sigma, T)

    return _bs2002_main_call(S, K, r, b, sigma, T)


# ============================================================================
# SECONDARY ORACLE: QuantLib BjerksundStenslandApproximationEngine (BS-1993)
# ============================================================================


def price_american_ql(option_type, spot, sigma, expiry_days):
    """
    Returns (price, tte_years_quantlib_view) from QL's BS-1993 engine.
    Used as a sanity oracle vs Python BS-2002.
    """
    today = ql.Date(1, 1, 2026)
    ql.Settings.instance().evaluationDate = today

    spot_handle = ql.QuoteHandle(ql.SimpleQuote(spot))
    risk_free = ql.YieldTermStructureHandle(ql.FlatForward(today, R, DAY_COUNT))
    dividend = ql.YieldTermStructureHandle(ql.FlatForward(today, Q, DAY_COUNT))
    vol = ql.BlackVolTermStructureHandle(
        ql.BlackConstantVol(today, ql.NullCalendar(), sigma, DAY_COUNT)
    )
    process = ql.BlackScholesMertonProcess(spot_handle, dividend, risk_free, vol)

    expiry = today + expiry_days
    payoff = ql.PlainVanillaPayoff(option_type, STRIKE)
    exercise = ql.AmericanExercise(today, expiry)
    option = ql.VanillaOption(payoff, exercise)
    # BS-1993 in QL despite the class name; see module docstring.
    option.setPricingEngine(ql.BjerksundStenslandApproximationEngine(process))

    tte_years = DAY_COUNT.yearFraction(today, expiry)
    return option.NPV(), tte_years


# ============================================================================
# Build rows -- dual-source (Python primary, QL secondary)
# ============================================================================


def build_rows():
    rows = []
    for moneyness in MONEYNESS:
        spot = moneyness * STRIKE
        for expiry_days in TTE_DAYS:
            for sigma in VOL:
                # QL provides the canonical TTE scalar (Actual/365Fixed). Both
                # Python and QL price using the same TTE so reference agreement
                # isn't polluted by day-count differences.
                ql_call, tte_years = price_american_ql(ql.Option.Call, spot, sigma, expiry_days)
                ql_put, _          = price_american_ql(ql.Option.Put,  spot, sigma, expiry_days)

                py_call = bs2002_price_python("call", spot, STRIKE, R, Q, sigma, tte_years)
                py_put  = bs2002_price_python("put",  spot, STRIKE, R, Q, sigma, tte_years)

                rows.append({
                    "spot": spot, "strike": STRIKE, "r": R, "q": Q,
                    "sigma": sigma, "t": tte_years,
                    "moneyness": moneyness, "expiry_days": expiry_days,
                    "py_call": py_call, "py_put": py_put,
                    "ql_call": ql_call, "ql_put": ql_put,
                })
    return rows


# ============================================================================
# Cross-validation: Python BS-2002 vs QL BS-1993
# ============================================================================


def cross_validate(rows, threshold_pct: float = 1.0):
    """
    Sanity-check: Python BS-2002 vs QL BS-1993 must agree within
    `threshold_pct`% on every row.

    BS-2002 (5 phi) is tighter than BS-1993 (3 phi) by typically 0.1-0.5%
    on ITM short-tenor low-vol cells. Threshold 1.0% gives slack for those.

    Skips rows where both prices are below 1 cent (relative comparison
    meaningless at near-zero prices).

    Fails (sys.exit 1) on any row exceeding the threshold -- catches bugs
    in the Python impl before they pollute test_vectors.rs.

    Returns a stats dict for embedding in the generated file header.
    """
    fails = []
    diffs = []
    for r in rows:
        for side, py_v, ql_v in (("call", r["py_call"], r["ql_call"]),
                                 ("put",  r["py_put"],  r["ql_put"])):
            denom = max(py_v, ql_v)
            if denom < 0.01:  # < 1 cent -- skip; relative scale meaningless
                continue
            diff_pct = abs(py_v - ql_v) / denom * 100.0
            diffs.append(diff_pct)
            if diff_pct > threshold_pct:
                fails.append((r, side, py_v, ql_v, diff_pct))

    if fails:
        sys.stderr.write(f"\n!! CROSS-VAL FAIL: {len(fails)} rows exceed {threshold_pct}%:\n")
        for r, side, py_v, ql_v, d in fails:
            sys.stderr.write(
                f"  m={r['moneyness']:.2f} d={r['expiry_days']:>3}d "
                f"sigma={r['sigma']:>4.2f} {side.upper():4}: "
                f"py={py_v:.4f} ql={ql_v:.4f} diff={d:.2f}%\n"
            )
        sys.exit(1)

    stats = {
        "max_pct": max(diffs) if diffs else 0.0,
        "mean_pct": (sum(diffs) / len(diffs)) if diffs else 0.0,
        "count_over_03pct": sum(1 for d in diffs if d > 0.3),
        "n": len(diffs),
    }
    print(
        f"Cross-val OK: max divergence {stats['max_pct']:.3f}%, "
        f"mean {stats['mean_pct']:.3f}%, "
        f"rows >0.3% = {stats['count_over_03pct']}/{stats['n']}"
    )
    return stats


# ============================================================================
# Emit Rust
# ============================================================================
RUST_HEADER = """\
// =============================================================================
// AUTO-GENERATED by scripts/gen_bs2002_refs.py -- DO NOT EDIT BY HAND.
// =============================================================================
//
// Bjerksund-Stensland 2002 American option pricing reference values.
//
// PRIMARY reference: pure-Python BS-2002 (5 phi, full Bjerksund-Stensland 2002
//                    flat-boundary form), implemented in
//                    scripts/gen_bs2002_refs.py.
// SECONDARY oracle:  QuantLib {ql_version} BjerksundStenslandApproximationEngine
//                    (which implements BS-1993, 3 phi -- NOT BS-2002 despite
//                    the unqualified class name). Used as a sanity check.
//
// Cross-validation stats (Python BS-2002 vs QL BS-1993):
//   max divergence  = {max_pct:.3f}%
//   mean divergence = {mean_pct:.3f}%
//   rows >0.3%      = {count_over_03pct}/{n}
//
// Generated: {generated_at}
//
// 5 moneyness x 5 TTE x 6 vol = 150 parameter rows; each row carries both
// the expected CALL and the expected PUT, for 300 expected values total.
//
// All values at solmath SCALE = 1e12 fixed-point.
//
// To regenerate:
//     python3 scripts/gen_bs2002_refs.py
//
// Phase 2 Stage A scope:
//     .context/plans/phase2-american-onchain-pricing-scope.md
// =============================================================================

#![allow(clippy::unreadable_literal)]

#[derive(Debug, Clone, Copy)]
pub struct TestVector {{
    pub s: u128,
    pub k: u128,
    pub r: u128,
    pub q: i128,
    pub sigma: u128,
    pub t: u128,
    pub expected_call: u128,
    pub expected_put: u128,
    /// Human-readable moneyness (S/K), for assertion error messages.
    pub moneyness: f64,
    /// Original TTE bucket in days, for assertion error messages.
    pub expiry_days: u32,
}}

pub const TEST_VECTORS: &[TestVector] = &[
"""

RUST_ROW = """\
    TestVector {{
        s: {s},
        k: {k},
        r: {r},
        q: {q},
        sigma: {sigma},
        t: {t},
        expected_call: {call},
        expected_put: {put},
        moneyness: {moneyness},
        expiry_days: {expiry_days},
    }},
"""

RUST_FOOTER = """\
];
"""


def emit(rows, stats, out_path: pathlib.Path):
    generated_at = _dt.datetime.now(_dt.timezone.utc).isoformat(timespec="seconds")
    parts = [
        RUST_HEADER.format(
            ql_version=ql.__version__,
            generated_at=generated_at,
            max_pct=stats["max_pct"],
            mean_pct=stats["mean_pct"],
            count_over_03pct=stats["count_over_03pct"],
            n=stats["n"],
        )
    ]
    for r in rows:
        parts.append(
            RUST_ROW.format(
                s=to_scale_u(r["spot"]),
                k=to_scale_u(r["strike"]),
                r=to_scale_u(r["r"]),
                q=to_scale_i(r["q"]),
                sigma=to_scale_u(r["sigma"]),
                t=to_scale_u(r["t"]),
                # PRIMARY reference: Python BS-2002 values
                call=to_scale_u(r["py_call"]),
                put=to_scale_u(r["py_put"]),
                moneyness=r["moneyness"],
                expiry_days=r["expiry_days"],
            )
        )
    parts.append(RUST_FOOTER)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text("".join(parts), encoding="utf-8")


# ----------------------------------------------------------------------------
# Entrypoint
# ----------------------------------------------------------------------------
def main():
    script_dir = pathlib.Path(__file__).resolve().parent
    repo_root = script_dir.parent
    out_path = (
        repo_root
        / "programs" / "opta" / "src" / "utils" / "american_pricing"
        / "test_vectors.rs"
    )

    rows = build_rows()
    assert len(rows) == 150, f"expected 150 rows, got {len(rows)}"

    stats = cross_validate(rows, threshold_pct=1.0)

    emit(rows, stats, out_path)
    print(f"wrote {len(rows)} rows ({2 * len(rows)} expected values) to {out_path}")


if __name__ == "__main__":
    main()
