/**
 * Canonical asset display mapping — the SINGLE source of truth for on-chain
 * symbol → clean display symbol, shared by every surface (Markets, Trade, and
 * anywhere an asset name is rendered).
 *
 * HARD RULE: oracle provenance is never user-visible. Switchboard "SB…" seed
 * markets and raw "…SPOT" feed tickers must never reach the UI. A `null` mapping
 * HIDES that market from discovery entirely (deprecated seed / test artifact) —
 * applied at the DATA layer so a hidden market's rows never enter any list, chart,
 * or dropdown, not just get filtered per-page.
 *
 * On-chain disposition (devnet, 2026-07-09):
 *   XAU        — the real gold market (multiple live vaults). SHOWN as "XAU".
 *   SBXAU      — Switchboard gold SEED market (SB-migration arc). HIDDEN — the
 *                real market is XAU; the two are distinct so we never merge them.
 *   XAUSMOKE   — gold smoke-test seed. HIDDEN.
 *   USOILSPOT  — raw US-oil feed ticker. SHOWN as "WTI".
 *   UKOILSPOT  — raw UK-oil (Brent) feed. HIDDEN (no live vaults; must not merge
 *                into WTI — it is a different underlying).
 */
const CANONICAL: Record<string, string | null> = {
  SBXAU: null,
  XAUSMOKE: null,
  USOILSPOT: "WTI",
  UKOILSPOT: null,
};

/**
 * Map an on-chain asset symbol to its clean display symbol, or `null` to hide it
 * from discovery. Un-mapped provenance-leaking shapes ("SB…" seeds, "…SPOT/…SMOKE/
 * …TEST" raw feeds) are hidden defensively so a NEW leak can't slip through.
 */
export function canonicalAsset(symbol: string | undefined | null): string | null {
  const s = (symbol ?? "").trim();
  if (!s || s === "?") return null;
  if (Object.prototype.hasOwnProperty.call(CANONICAL, s)) return CANONICAL[s];
  if (/^SB[A-Z0-9]/.test(s)) return null;                 // Switchboard seed prefix
  if (/(SPOT|SMOKE|TEST)$/i.test(s)) return null;         // raw feed / test tickers
  return s;
}

/** Asset class for grouping/labels. Kept beside the display map so both are canonical. */
export type AssetClass = "Crypto" | "Equities" | "Commodities" | "FX" | "Other";
const CRYPTO = new Set(["BTC", "ETH", "SOL", "XRP", "FARTCOIN"]);
// The full Switchboard equity board (asset_class 2 on-chain). Wave-2 shipped 11
// on 2026-07-20 and Wave-2b added SPCX + HOOD on 2026-07-21; this set lagged at
// 6, so the eight newest tickers grouped under "Other" in the Trade dropdown and
// Write selector. NOTE this set only drives GROUPING — discovery is on-chain, and
// the Markets page tabs key off the numeric asset_class (marketsView.classToTab),
// which is why those tabs were already correct. Keep in sync with a new listing.
const EQUITIES = new Set([
  "AAPL", "MSFT", "NVDA", "MSTR", "TSLA", "CRCL",
  "GOOGL", "AMZN", "AMD", "COIN", "META", "SPCX", "HOOD",
]);
const COMMODITIES = new Set(["XAU", "XAG", "WTI", "BRENT"]);

export function assetClassOf(displaySymbol: string): AssetClass {
  const a = displaySymbol.toUpperCase();
  if (CRYPTO.has(a)) return "Crypto";
  if (EQUITIES.has(a)) return "Equities";
  if (COMMODITIES.has(a) || a.includes("XAU") || a.includes("XAG") || a.includes("OIL")) return "Commodities";
  if (/^[A-Z]{3}[A-Z]{3}$/.test(a)) return "FX";
  return "Other";
}
