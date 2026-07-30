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
// BOOK_TRIGGERS_ENABLED — book-path trigger fires, both legs (LIVE)
// =============================================================================
//
// When TRUE, execute_trigger routes trigger fires to the BOOK instead of the
// structurally-dead pooled vault (98% of vaults hold zero pooled collateral
// board-wide):
//   B1 BUY  — StopEntryBuy lifts the live ask board via writer_ask_fill_core
//             (primary) / resale_ask_fill_core (secondary), escrow-pays arm.
//   B2 SELL — TakeProfitSell and StopLossSell hit the live bid board via
//             bid_fill_core, delegate-pull arm. StopLossSell has NO vault path
//             (an OTM long cannot be exercised), so this flag is the whole of
//             its fire path: false ⇒ 6079, true ⇒ book-or-skip.
//
// The sell leg additionally enforces the owner's stored per-contract minimum-
// proceeds floor (6082/6083) — see execute_trigger.rs. That floor is meaningless
// while this flag is false, since no sell can reach the book.
//
// Routing is `BOOK_TRIGGERS_ENABLED && book_order.is_some()` — so a fire that
// passes NO book accounts still runs the byte-identical vault peg (the existing
// peg tests), while book-account calls take the book path. That second conjunct
// is why the flag was inert on its own; see B1.5 below.
//
// STATUS: FLIPPED AND LIVE. Both cfg branches are now `true`, so the flag is a
// permanent production default (the AMERICAN_ENABLED / WRITER_ASKS_ENABLED
// shape). The `testing` branch is retained only so the split still compiles.
//
// The flip required B1.5 first: routing is `BOOK_TRIGGERS_ENABLED &&
// book_order.is_some()`, and until the keeper actually assembled book accounts
// this const was unreachable — a flag alone could never move a fire onto the
// book. Do not re-flip without checking that the keeper still populates the
// eleven optionals (crank/triggerCrank.ts, enumerateAsksForMint).
//
// SELL LEGS ARE LIVE TOO. StopLossSell no longer reverts 6079; with no crossable
// bid it takes skip-until-bid (stays armed, quiet TriggerSkipped). It cannot be
// dumped into a dust bid: `max_premium` is the stored per-contract MINIMUM-
// PROCEEDS FLOOR on a sell, and 0 means BOOK INELIGIBLE (SellFloorRequired 6082),
// so every legacy-style sell placement is refused the book by construction.
#[cfg(feature = "testing")]
pub const BOOK_TRIGGERS_ENABLED: bool = true;

#[cfg(not(feature = "testing"))]
pub const BOOK_TRIGGERS_ENABLED: bool = true;

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
