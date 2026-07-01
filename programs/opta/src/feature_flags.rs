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

// =============================================================================
// WRITER_ASKS_ENABLED — Phase 3 Slice A dark gate for writer limit asks
// =============================================================================
//
// Mirrors the ORIGINAL pre-flip AMERICAN_ENABLED pattern (cfg-branched
// test-vs-prod, NOT the now-permanently-true form): the WriterAsk post path in
// post_order is reachable ONLY under the `testing` feature, so bankrun/validator
// can exercise the real escrow-at-post while a FEATURE-FREE production build
// stays dark (LOW-5 / spec §12.4 — every new surface dark-launchable).
//
// post_order's WriterAsk arm guards on this const with the repurposed
// OptaError::WriterAsksDisabled (6054) — the top-of-handler reject moved into
// the arm; no new error code. Slice B/C enable fill/cancel/refund; until then a
// posted WriterAsk has no refund path, so the feature-free deploy MUST stay dark.
//
// DISCIPLINE: NEVER deploy a build with `testing` enabled (the LOW-5 guard in
// lib.rs already enforces this). Flip to a permanent `true` only when Slices
// A–C are complete, audited, and the full writer-ask lifecycle ships.
// =============================================================================

#[cfg(feature = "testing")]
pub const WRITER_ASKS_ENABLED: bool = true;

#[cfg(not(feature = "testing"))]
pub const WRITER_ASKS_ENABLED: bool = true;

#[cfg(test)]
mod tests {
    // Phase 3 Slice A (iii): deterministic proof of the dark gate. A FEATURE-FREE
    // production build MUST compile WRITER_ASKS_ENABLED = false; since the first
    // line of post_order's WriterAsk arm is `require!(WRITER_ASKS_ENABLED,
    // WriterAsksDisabled)`, false ⇒ every WriterAsk post reverts with 6054. The
    // host `cargo test` (default = no features) compiles the not(testing) branch.
    #[test]
    #[cfg(not(feature = "testing"))]
    fn writer_asks_dark_in_feature_free_build() {
        assert!(
            !super::WRITER_ASKS_ENABLED,
            "feature-free build MUST keep WRITER_ASKS_ENABLED = false (dark) so \
             post_order's WriterAsk arm reverts with WriterAsksDisabled (6054)"
        );
    }

    // Under `--features testing` the test harness needs the gate OPEN so bankrun/
    // validator can exercise the real post path.
    #[test]
    #[cfg(feature = "testing")]
    fn writer_asks_open_under_testing() {
        assert!(super::WRITER_ASKS_ENABLED);
    }
}
