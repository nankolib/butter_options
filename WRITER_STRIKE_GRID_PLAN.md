# Writer — Absolute Strike Grid (equity)

**Status:** implemented + gated 2026-07-22; deploy per §5. Greenlit decisions baked in:
`n=5`, `MAX_CELLS` stays 470, **class 2 only**, one-time transition open accepted.

## Problem

Equity strikes were **spot-relative** (`spot × {0.90,0.95,1.00,1.05,1.10}`, `roundSig`-rounded).
`cancel-at-close` wipes every equity ask, so `stickyStrike`'s hysteresis anchors — which
come from *live asks* — are empty at the next open ("cold board"). The repost therefore
recentres the whole ladder on the overnight spot and mints a fresh series+vault for every
cell. Measured 2026-07-22 open: **+260 shells, ~5.6 SOL**, recurring **every** NYSE open,
a monotonic orphan accrual (~1,300 shells/wk).

Root cause is not a `needVault`/`needSeries` detection bug — those checks are correct
(`engine.ts:353-354`, `!accountExists(...)`). The strike *value* moved, so the derived
`(market, strike, expiry, side)` PDA was genuinely new.

## Fix

Make the strike value itself stable: snap equity strikes to a fixed **absolute grid**. A
move smaller than one `gridStep` re-derives the identical strike set → the PDAs already
exist → the repost reuses. Stateless (no anchors needed), so a cold post-cancel board
still lands on the same strikes.

**Scope (locked):** equity `asset_class === 2` only. Crypto/metals/fx/etf keep the
spot-relative + `stickyStrike` path **byte-for-byte** (zero blast radius on the proven
24/7 board). Writer-side TS only; no on-chain / program change.

### Grid function + tier table (`writer/src/ladder.ts`)

| Spot | gridStep | 5-point span (±2 steps) |
|---|---|---|
| < $50 | $1.00 | ±$2 |
| < $100 | $2.50 | ±$5 |
| < $250 | $5.00 | ±$10 |
| < $500 | $10.00 | ±$20 |
| < $1000 | $25.00 | ±$50 |
| ≥ $1000 | $50.00 | ±$100 |

- `gridStep(spot)` — deterministic tier lookup.
- `snapToGrid(x, step)` — nearest grid point, half-up on the midpoint (JS `Math.round`).
- `equityGridStrikes(spot, n=5)` — the N grid points nearest the snapped ATM; drops
  non-positive wings. **Stateless.**
- `buildLadder` branches on `assetClass === 2`: equity → `equityGridStrikes` (expiry-
  independent, ATM-first by `|strike−spot|`); everything else → unchanged rung path.

`n=5` holds 20 cells/ticker → equity 260 + crypto ~118 = ~378 < `MAX_CELLS=470`. Wings
tighten from ±10% to ~±6% (accepted). `n=7` would exceed the cap — rejected.

## Tests (all green 2026-07-22)

- `writer/src/ladder.grid.test.ts` — 7/7. Tier boundaries, snap rounding, ladder
  selection, **ATM snap-stability** (|drift| < ½ step → identical ladder), one-boundary
  slide, tier-migration respacing.
- `writer/src/engine.crossday.test.ts` — 4/4. Derives **real** series+vault PDAs for two
  same-week ladders at drifted spots. **HEADLINE:** sub-`gridStep` drift → **0 new
  series/vault PDAs** (day-old-shell reuse — the gate). One-boundary cross → exactly 1 new
  strike (4 cells). Weekly-roll → weekly PDAs fresh (legit residual), monthly reused.
- Regression: `engine.churn` 18/0 (crypto `stickyStrike` path unchanged), `engine.denylist`
  8/0, `engine.stalePull` 4/0, `env.excludeClasses` 7/0. `tsc --noEmit` clean.

## Predicted mint counts

- **Tomorrow 2026-07-23 (transition open):** ~200–240 mints. Today's 1,383 persisted vaults
  sit on old `roundSig` strikes; tomorrow's grid targets coincide only occasionally, so the
  board migrates to the grid once. **Acceptance ceiling: ≤ 260** (no worse than today).
- **Thursday 2026-07-24 onward (payoff):** overnight move < 1 `gridStep` for most tickers
  → ~0; boundary-crossers mint 4 cells each (~3–5/day ⇒ ~15/day); weekly roll adds one
  event on expiry day. **~65–130/wk residual vs ~1,300/wk → ~90–95% reduction.**
  **Success signal: Thursday's open < 20 mints.**

## Deploy sequencing (§5)

1. Implement on `master` — `ladder.ts` + two test files. No `engine.ts` change.
2. Gates (all green before push): `tsc --noEmit` → grid unit → cross-day repro (0-init is
   the headline gate) → full writer suite (crypto no-regression).
3. Commit named files only; push `master` + `master:main`.
4. VPS surgical checkout of the three writer files onto the `d1d0471` overlay; `npm run
   build`; grep `equityGridStrikes` in `dist/ladder.js`; HEAD unchanged.
5. `systemctl restart opta-writer`; boot marker (same build/caps); 2–3 tick watch — crypto
   untouched, shells flat, strand 0. Complete before 2026-07-23 13:30Z.
6. Acceptance read at tomorrow's open: mints ≤ 260; then Thursday < 20.

**Rollback:** surgical checkout `ladder.ts` back to `9701eec` + rebuild + restart.

## WATCH

**Grid-midpoint edge-cell flapping.** The snap is **stateless**: when a spot sits almost
exactly on a grid midpoint (e.g. step $10, spot ≈ $x95), tiny ticks can flip the snapped
ATM back and forth across the boundary between successive reprices, so the outermost rung
alternates (one edge strike appears/disappears). This is **gas-only churn — no net new
mints** (both edge vaults, once minted, persist and are reused on the return), unlike the
old spot-relative recentre. If observed and material, the fix is a **v2 deadband** on the
ATM snap (hysteresis on the *grid index*, analogous to `stickyStrike` on the rung) — do NOT
add it pre-emptively; it reintroduces state the grid deliberately removed. Watch the
edge-rung post/cancel rate per equity ticker post-deploy.
