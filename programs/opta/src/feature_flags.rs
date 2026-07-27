// =============================================================================
// feature_flags.rs — Compile-time protocol feature gates
// =============================================================================
//
// AMERICAN_ENABLED is the systemic guard for the Phase 2 American-options
// build. American vault creation and minting are gated on it via a RUNTIME
// check against this const (the American code stays compiled in — this is NOT
// cfg-exclusion — it is simply unreachable while the const is false).
//
// STATUS: LIVE. Stage I is complete — the full American lifecycle (Stages D–G)
// plus audit shipped, and the feature-free `not(feature)` default was flipped to
// `true` and DEPLOYED FEATURE-FREE. BOTH cfg branches are now `true`, so the flag
// is effectively a permanent production default; the `american-enabled` Cargo
// feature is retained only so the pre-flip test build path still compiles. The
// European lifecycle never references this flag.
//
// DISCIPLINE (still live): do NOT deploy a `--features american-enabled` build —
// prod builds MUST be feature-free (LOW-5). The two branches being identical
// means a feature-free deploy already runs the American arms.
// =============================================================================

#[cfg(feature = "american-enabled")]
pub const AMERICAN_ENABLED: bool = true;

#[cfg(not(feature = "american-enabled"))]
pub const AMERICAN_ENABLED: bool = true;

// =============================================================================
// WRITER_ASKS_ENABLED — Phase 3 writer limit asks (LIVE production default)
// =============================================================================
//
// STATUS: LIVE. The full writer-ask lifecycle (Slices A–D: post / fill / cancel /
// refund / settle pot-sweep) is complete, audited, and proven end-to-end on
// devnet (13/13 assertions, scripts/_smoke_writer_ask_devnet.ts). The dark gate
// was retired: commit 9ab31dd (Jul 1 2026) flipped the feature-free
// `not(feature = "testing")` default to `true`, so BOTH cfg branches are now
// `true` and the flag is a permanent production default. The `testing`-feature
// branch is retained only so the split mirrors AMERICAN_ENABLED's shape.
//
// post_order's WriterAsk arm still guards on this const with
// OptaError::WriterAsksDisabled (6054); with the flag permanently true that
// revert is now unreachable in every shipped build (it remains as a fail-closed
// backstop should the const ever be reverted).
//
// DISCIPLINE (still live): do NOT deploy a build with `testing` enabled — prod
// builds MUST be feature-free (the LOW-5 guard in lib.rs enforces this). The
// two branches being identical means a feature-free deploy already runs the
// writer-ask path.
// =============================================================================

#[cfg(feature = "testing")]
pub const WRITER_ASKS_ENABLED: bool = true;

#[cfg(not(feature = "testing"))]
pub const WRITER_ASKS_ENABLED: bool = true;

// =============================================================================
// BOOK_TRIGGERS_ENABLED — Phase B1 book-path StopEntryBuy fires (DARK)
// =============================================================================
//
// When TRUE, execute_trigger's StopEntryBuy routes to the book — lifting the
// writer's live ask board via writer_ask_fill_core (primary) / resale_ask_fill_
// core (secondary), escrow-pays arm — instead of the structurally-dead vault peg
// (98% of vaults hold zero pooled collateral board-wide).
//
// SHAPE = the WRITER_ASKS_ENABLED dark pattern (NOT a plain flip-in-place const):
// a pure const is false in every build and could never be exercised by the
// bankrun gates. The `testing` branch is TRUE so the test build exercises the
// book path; the feature-free (prod) branch is FALSE (dark). This is the only
// way to satisfy B1's gate matrix (which must test the live book path).
//
// Routing is `BOOK_TRIGGERS_ENABLED && book_order.is_some()` — so a flag-true
// test build STILL runs the byte-identical vault peg when no book accounts are
// passed (the existing peg tests), while book-account calls take the new path.
//
// FLIP (Jul-31 canary session): change the `not(feature = "testing")` branch
// below from `false` to `true` and redeploy feature-free. The canary is the live
// acceptance test on the book path. Until then, prod is dark and the vault-peg
// fallback is intact.
#[cfg(feature = "testing")]
pub const BOOK_TRIGGERS_ENABLED: bool = true;

#[cfg(not(feature = "testing"))]
pub const BOOK_TRIGGERS_ENABLED: bool = false;

#[cfg(test)]
mod tests {
    // Run-8 M-1 / M-03 reconciliation: American options and writer asks are both
    // LIVE permanent production defaults (Stage I flip + commit 9ab31dd). This
    // invariant asserts a feature-free `cargo test` (default = no features)
    // compiles BOTH flags `true`, so an accidental revert to a dark default fails
    // the build. Both consts are `true` in every cfg combination, so the test is
    // build-agnostic (no cfg gating needed).
    #[test]
    fn american_and_writer_asks_are_live_production_defaults() {
        assert!(
            super::AMERICAN_ENABLED,
            "AMERICAN_ENABLED must be true — Stage I is live and deployed feature-free"
        );
        assert!(
            super::WRITER_ASKS_ENABLED,
            "WRITER_ASKS_ENABLED must be true — writer-ask lifecycle is live (9ab31dd, \
             proven 13/13 on devnet); a false here would revert every WriterAsk with 6054"
        );
    }
}
