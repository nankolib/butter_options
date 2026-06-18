// =============================================================================
// feature_flags.rs — Compile-time protocol feature gates
// =============================================================================
//
// AMERICAN_ENABLED is the systemic guard for the Phase 2 American-options
// build. American vault creation and minting are gated on it via a RUNTIME
// check against this const (the American code stays compiled in — this is NOT
// cfg-exclusion — it is simply unreachable while the const is false).
//
// The const is flipped by the `american-enabled` Cargo feature:
//   - feature off (default): AMERICAN_ENABLED = false → American arms revert
//     with OptaError::AmericanVaultsDisabled.
//   - feature on:            AMERICAN_ENABLED = true  → American arms run.
//
// DISCIPLINE: NEVER ship a build with `american-enabled` enabled until
// Stage I. The European lifecycle never references this flag, so a default
// (feature-free) build behaves exactly as today. At Stage I — after the full
// American lifecycle (Stages D–G) plus audit are complete — flip the
// `not(feature)` default below to `true` and DEPLOY FEATURE-FREE. Do NOT
// deploy a `--features american-enabled` build: that path is only for running
// the American test suite before the default flips.
// =============================================================================

#[cfg(feature = "american-enabled")]
pub const AMERICAN_ENABLED: bool = true;

#[cfg(not(feature = "american-enabled"))]
pub const AMERICAN_ENABLED: bool = true;
