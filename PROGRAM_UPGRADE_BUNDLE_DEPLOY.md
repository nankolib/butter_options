# Program-Upgrade Bundle — Deploy-Day Checklist

Branch: `feat/program-upgrade-bundle` (authored, tested, **NOT deployed**).
Bundle: self-trade guard + European strike-cap + `close_market` (one program upgrade).
Program-id **unchanged** (`CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq`); additive only
(no realloc / layout / seed change). Deployable IDL == **50** instructions.
Deploy is a **separate founder-gated session** run from WSL (admin upgrade authority).

The branch stays **unmerged** until deploy so `master`'s Rust == the deployed binary.

---

## Pre-deploy gates (ALL must be true before `anchor upgrade`)

- [ ] **[1] FE skip-own-level live on prod.** After the self-trade guard lands, any
  marketable-limit/sweep cell that would cross the taker's OWN resting order reverts
  `CannotBuyOwnOption` (6023). The FE planner already skips own orders
  (`app/src/pages/trade/marketSweep.ts` `buildAskLevels`/`buildBidLevels`,
  `o.owner !== taker`); **Stage 3 Slice 2 locks it with 4 unit tests + an entry-point
  audit**. Gate = Slice 2 shipped to prod (master:main + Vercel). Satisfied by tests,
  not new code.

- [ ] **[2] Cargo.lock pinned before `anchor build`.** The worktree's Cargo.lock is
  gitignored; a fresh resolve pulls a broken `pyth-solana-receiver-sdk 1.2.0` /
  `borsh 1.7.0` graph. Pin to the main clone's known-good **`pyth 1.1.0` / `borsh 1.6.1`**
  (Cargo.toml manifests are byte-identical between clones, so the lock is valid).
  Fresh checkouts of this branch re-break without this.

## Deploy (founder, from WSL — admin upgrade authority)

- [ ] **[3] `anchor upgrade`.**
  1. Confirm gate [2] (lock pin) in place.
  2. `anchor build` **FEATURE-FREE** (no `--features`) — LOW-5: prod artifact must be
     feature-free. Verify IDL == 50, `close_market` present, zero test-only leakage.
  3. Hash-verify the new `.so` vs the on-chain program; archive the CURRENT on-chain
     `.so` (hashed) for rollback before upgrading.
  4. `anchor upgrade target/deploy/opta.so --program-id CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq --provider.cluster devnet`
  5. **IDL sync:** write the feature-free `target/idl/opta.json`; copy `target/idl/opta.json`
     + `target/types/opta.ts` into `app/` per the app-IDL-sync convention. NOTE: zero
     "UN-APPLY ON IDL SYNC" casts belong to THIS bundle — the only one
     (`crank/sbCreateMarketEndpoint.ts:353`) is the SB create-market path, untouched here.

## Post-deploy verification

- [ ] **[4] Verify:**
  - Instruction count == **50** on the deployed feature-free IDL.
  - **Canary self-trade rejection:** post a resting ask, attempt self-fill from the same
    wallet → expect `CannotBuyOwnOption` (6023); a third-party fill still succeeds.
  - **European boundary settle (throwaway market):** create a EUR CALL strike K, settle at
    ~2.5x K, exercise → per-contract payout == K (capped), not 1.5x K; `collateral_remaining`
    never underflows and a 2nd claimant is not stranded.
  - Smoke: existing third-party exchange fills + American settlement unaffected.

- [ ] **[5] XAUSMOKE close_market sweep.** First `close_market` sweep candidate =
  **XAUSMOKE** (`4FU8cV8sMdWJX4GDvwBzp52YHoummFc7pCoHmqq9Z3Qf`, gold smoke-test seed
  artifact, FE-hidden). Run `scripts/preflight_close_market.ts XAUSMOKE` (dry) first;
  it must report SAFE (no live child vaults) before `--execute`.

## Close-out

- [ ] **[6] Merge + record.** Merge `feat/program-upgrade-bundle` → `master`, push
  `master` + `master:main`, delete branch. Write HANDOFF (bundle contents, deploy slot,
  IDL==50, canary + boundary-settle evidence, XAUSMOKE swept).

---

## Rollback posture
Program is upgradeable in place (authority retained): rollback = re-`anchor upgrade` the
archived prior `.so`. No state migration — the guard/cap only gate NEW fills/settlements,
no persisted schema to unwind; `close_market` is inert until first invoked. If gate [1]
slips, fallback is per-cell retry (degraded UX, not unsafe).

## Test baseline (at authoring)
`npm run test:bankrun` = **212 passing / 0 failing / 2 pending** (pre 202 -> +10). The 2
pending are pre-existing feature-free WriterAsk-rejection skips, unrelated to this bundle.
