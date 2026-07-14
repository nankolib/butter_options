// =============================================================================
// writePauseGate — FE-only mint-gate for winding-down Pyth markets.
// =============================================================================
//
// While the old Pyth BTC/SOL markets drain toward close (BTC ~Jul-19, SOL on the
// buyout track), NO new vaults may be written on them. This gate hides/disables
// the write CTA for those markets and surfaces an inline note. It is purely a
// frontend guard — trading, settling and claiming EXISTING positions are
// untouched (holders must still exit normally), and Portfolio is unaffected.
//
// The gate keys off `oracle_source == 0` (Pyth) for the two winding-down
// tickers. The moment the Switchboard rebirth lands at the SAME market PDA with
// `oracle_source == 1`, the condition goes false and the gate AUTO-FREES — a
// zero-touch un-gate with no code change or redeploy required.
// =============================================================================

import type { AssetOption } from "./WriterForm";

/** Tickers whose old Pyth markets are winding down to Switchboard. */
const PAUSED_TICKERS: ReadonlySet<string> = new Set(["BTC", "SOL"]);

/** Inline copy shown when a write is paused. */
export const WRITE_PAUSED_NOTE = "New positions paused — market upgrade in progress.";

/**
 * Returns a gate block ({ tooltip }) when the chosen asset is an OLD Pyth
 * market (oracle_source == 0) for a winding-down ticker (BTC/SOL); null
 * otherwise. Same `{ tooltip } | null` shape as the other write gates so it
 * folds into `canSubmit` and the inline-note rendering identically.
 */
export function writePausedBlock(
  asset: AssetOption | null,
): { tooltip: string } | null {
  if (!asset) return null;
  const oracleSource = Number(asset.market.account?.oracleSource ?? 0);
  if (oracleSource === 0 && PAUSED_TICKERS.has(asset.ticker)) {
    return { tooltip: WRITE_PAUSED_NOTE };
  }
  return null;
}
