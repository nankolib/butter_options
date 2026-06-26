// =============================================================================
// app/src/utils/seedVol.ts — Per-asset-class day-0 seed volatility (single SoT)
// =============================================================================
//
// THE single source of truth for "seed vol at birth" values. There is NO
// Rust-side table — the on-chain program only stores/uses the number passed to
// initialize_vol_oracle(seed_vol). This module is imported by BOTH the FE
// (directly) and the crank (via the @app/* path alias), so the per-class
// defaults can never drift between the two callers.
//
// Encoding: annualized σ at solmath SCALE = 1e12, as a plain JS integer. Each
// value (max 8e11) is far under Number.MAX_SAFE_INTEGER (~9.0e15), so plain
// numbers are exact. The Anchor call site wraps the value in BN at the i64
// boundary — this file stays dependency-free (no BN import).
//
// `seed_vol == 0` is the on-chain ZERO-SAFE SENTINEL meaning "no seed, behave as
// before". seedVolForAssetClass therefore GUARDS on an unknown class rather than
// returning 0 — silently seeding 0 would birth an un-warmable cold oracle.
// =============================================================================

/**
 * Per-class day-0 annualized vol, encoded ×1e12, indexed by the on-chain
 * `asset_class` u8 (0=crypto, 1=commodity, 2=equity, 3=forex, 4=etf).
 */
export const SEED_VOL_BY_ASSET_CLASS: Record<number, number> = {
  0: 800_000_000_000, // crypto    0.80
  1: 550_000_000_000, // commodity 0.55
  2: 450_000_000_000, // equity    0.45
  3: 120_000_000_000, // forex     0.12
  4: 250_000_000_000, // etf       0.25
};

/**
 * Day-0 seed volatility (annualized σ × 1e12) for an on-chain `asset_class`.
 * Throws on an unknown class — callers must NOT seed 0 (the "no seed" sentinel).
 * Wrap the result in BN at the Anchor i64 boundary.
 */
export function seedVolForAssetClass(assetClass: number): number {
  const v = SEED_VOL_BY_ASSET_CLASS[assetClass];
  if (v === undefined) {
    throw new Error(`seedVolForAssetClass: no seed_vol for asset_class ${assetClass}`);
  }
  return v;
}
