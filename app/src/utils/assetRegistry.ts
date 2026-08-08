// =============================================================================
// app/src/utils/assetRegistry.ts — Unified, source-aware asset registry (merge)
// =============================================================================
//
// One row per asset, carrying BOTH a Pyth feed id AND an SB feed hash (where one
// exists). Built as a RUNTIME MERGE: the live Hermes/Pyth catalog is the broad
// base, left-joined against the curated `sbFeedData` (SB hashes — gold today) by
// normalized ticker, biased HARD toward no-match (a missed join → Pyth-sourced =
// degraded-but-safe; a false join → wrong asset priced = unacceptable).
//
// Dependency-free: pure transforms over CatalogEntry + SbFeedDatum. NO
// @switchboard-xyz/* — the SB SDK never enters the FE bundle.
//
// ── On `canonicalSource` (READ THIS before Phase 2) ──────────────────────────
// `canonicalSource` is the **currently-resolved default routing source for this
// row** — NOT a permanent preference. Pyth and SB are PEERS. Phase 1 resolves a
// single default (crypto→Pyth; TradFi-with-SB→SB; TradFi-without→Pyth) only
// because gold is the lone dual-source asset, so there's nothing to tie-break
// yet. Phase 2 will recompute the bound source PER-CREATE from a liveness map +
// a best-feed tie-break (freshest / most-samples — TBD in Phase 2 recon),
// treating both sources as equals. The shape is deliberately neutral: every row
// carries BOTH ids, so Phase 2 can re-resolve without a structural change — do
// NOT add logic that assumes "SB is canonical/preferred."
// =============================================================================

import type { CatalogEntry } from "./hermesCatalog";
import type { SbFeedDatum } from "./sbFeedData";

export interface AssetRegistryEntry {
  /** Display label (best-effort; NEVER load-bearing for routing or matching). */
  commonName: string;
  /** Normalized on-chain asset-name candidate, /^[A-Z0-9]{1,16}$/. */
  ticker: string;
  /** On-chain asset_class u8: 0 crypto / 1 commodity / 2 equity / 3 forex / 4 etf. */
  assetClass: 0 | 1 | 2 | 3 | 4;
  /** 64-char lowercase hex Pyth feed id, or null for an SB-only orphan. */
  pythFeedId: string | null;
  /** 64-char lowercase hex SB feed hash, or null when no SB feed exists. */
  sbFeedHash: string | null;
  /**
   * The currently-resolved DEFAULT routing source (0 Pyth / 1 SB) — see the
   * module header. A per-row default, not a permanent preference; Phase 2
   * re-resolves per-create from liveness + a best-feed tie-break.
   */
  canonicalSource: 0 | 1;
}

/** SB symbol "XAU/USD" → base ticker "XAU" (strip quote leg + non-alphanumerics,
 *  uppercase, cap 16). Shared by the merge join AND the modal's advanced autofill. */
export function sbBaseTicker(symbol: string): string {
  const base = symbol.split("/")[0] ?? symbol;
  return base.replace(/[^A-Za-z0-9]/g, "").toUpperCase().slice(0, 16);
}

/** Normalize any ticker for comparison (alphanumeric-only, uppercase). */
function normTicker(t: string): string {
  return t.replace(/[^A-Za-z0-9]/g, "").toUpperCase();
}

const keyOf = (cls: number, ticker: string) => `${cls}:${normTicker(ticker)}`;

/** Quote leg of a Hermes symbol: "Equity.US.MSFT/USD.POST" → "USD",
 *  "Crypto.SOL/ETH" → "ETH". null when there is no parseable quote leg. */
function quoteLegOf(hermesSymbol: string): string | null {
  const i = hermesSymbol.indexOf("/");
  if (i < 0) return null;
  const q = hermesSymbol.slice(i + 1).split(".")[0];
  return q ? q.toUpperCase() : null;
}

/** Trading-session suffix (".PRE" / ".POST" / ".ON"), or null for the regular
 *  session. Pyth publishes four feeds per US equity; only one is the RTH print. */
function sessionSuffixOf(hermesSymbol: string): string | null {
  const m = /\/[A-Za-z0-9]+\.(PRE|POST|ON)$/i.exec(hermesSymbol);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Is this Pyth feed a legitimate candidate to price a market on its ticker?
 *
 * `hermesCatalog.deriveTicker` returns the BASE ALONE for every class except FX,
 * so two very different kinds of feed collapse onto the same (class, ticker) key
 * without being competing candidates for it:
 *
 *   - a different NUMERAIRE (Crypto.SOL/ETH keys as "SOL"). Our collateral is
 *     USDC, so a market bound to this feed would carry an ETH-denominated strike
 *     and settlement against USDC collateral. Never a candidate.
 *   - a different SESSION (Equity.US.MSFT/USD.PRE keys as "MSFT"). Same asset,
 *     same numeraire, but a print that only exists outside regular hours.
 *
 * Excluding both is what makes the ambiguity guard below mean what it says. It
 * is not a tie-break: a genuine collision between two regular-session USD feeds
 * (FDX vs FDXF) still refuses to guess.
 *
 * FX is EXEMPT: deriveTicker returns base+quote there ("USDJPY"), so the pair is
 * the asset and the quote leg is not a masquerade.
 *
 * Abstains (returns true) on an unparseable symbol — `hermesSymbol` is
 * `attrs.symbol ?? ""`, and an entry we cannot judge must not be silently
 * deleted from the create surface.
 */
export function isPythCandidate(e: CatalogEntry): boolean {
  if (e.suggestedAssetClass === 3) return true; // FX: ticker is base+quote
  const q = quoteLegOf(e.hermesSymbol);
  if (q === null) return true; // cannot judge → keep
  if (q !== "USD") return false;
  return sessionSuffixOf(e.hermesSymbol) === null;
}

/**
 * Merge the live Pyth catalog (broad base) with the curated SB feed data into one
 * row per asset. DEGRADES, never throws: an empty `pythEntries` (Hermes catalog
 * loading/failed) yields SB-only rows (gold) — exactly today's behavior, with
 * Advanced-paste as the crypto fallback.
 *
 * Join (conservative): an SB datum links to a Pyth row ONLY when there is
 * EXACTLY ONE Pyth feed for its (asset_class, normalized-ticker). Zero → SB-only
 * row (no Pyth dup risk). Ambiguous (>1 distinct Pyth feeds) → DROP the SB hash,
 * leave the row Pyth-only (logged) — never guess which Pyth feed it is.
 */
export function buildAssetRegistry(
  pythEntries: CatalogEntry[],
  sbData: SbFeedDatum[],
): AssetRegistryEntry[] {
  // Only CANDIDATE feeds are eligible to price a row — see isPythCandidate.
  // Everything downstream (dedup, ambiguity counting, the SB join) operates on
  // this set, so a non-USD or off-session feed can neither become a row's Pyth
  // id nor block an SB join by inflating the collision count.
  //
  // Measured against the live catalog on 2026-08-08: 2967 entries → 2049
  // candidates, 2741 (class,ticker) rows → 2038. The 703 rows that disappear are
  // ones whose ONLY prints are non-USD — 604 foreign-listed equities quoted in
  // HKD/KRW/GBP/JPY, 93 crypto redemption-rate feeds quoted in their underlying,
  // 6 EUR commodity futures. Each would have minted a market whose settlement
  // price is in a different currency from its collateral, so this removes a trap
  // rather than an option. 11 rows remain genuinely ambiguous (FDX/FDXF,
  // USD0/USD0++, spot-vs-.RR duplicates); none carry an SB feed.
  const candidates = pythEntries.filter(isPythCandidate);

  // Count DISTINCT Pyth feed ids per (class, ticker) for ambiguity detection
  // (before dedup, so a true >1 collision is visible).
  const pythCount = new Map<string, Set<string>>();
  for (const e of candidates) {
    const k = keyOf(e.suggestedAssetClass, e.suggestedTicker);
    if (!pythCount.has(k)) pythCount.set(k, new Set());
    pythCount.get(k)!.add(e.feedIdHex);
  }

  // 1. Pyth-only base rows, deduped by (class, ticker) — first feed wins as the
  //    row's Pyth fallback id. One row per asset.
  const byKey = new Map<string, AssetRegistryEntry>();
  for (const e of candidates) {
    const k = keyOf(e.suggestedAssetClass, e.suggestedTicker);
    if (byKey.has(k)) continue;
    byKey.set(k, {
      commonName: e.suggestedTicker,
      ticker: e.suggestedTicker,
      assetClass: e.suggestedAssetClass,
      pythFeedId: e.feedIdHex,
      sbFeedHash: null,
      canonicalSource: 0, // Pyth default (TradFi-without-SB stays here)
    });
  }

  // 2. Fold in SB feeds — conservative join.
  for (const d of sbData) {
    const t = sbBaseTicker(d.symbol);
    const k = keyOf(d.suggestedAssetClass, t);
    const hash = d.feedHashHex.replace(/^0x/, "").toLowerCase();
    const n = pythCount.get(k)?.size ?? 0;

    if (n > 1) {
      // Ambiguous → never guess; row stays Pyth-only.
      console.warn(
        `[assetRegistry] ambiguous SB join for ${d.symbol}: ${n} Pyth feeds for ${k} — dropping SB hash (Pyth-only)`,
      );
      continue;
    }
    if (n === 1) {
      // Exactly one Pyth row → attach the SB hash to it (one dual-source row).
      const row = byKey.get(k)!;
      row.sbFeedHash = hash;
      row.commonName = d.symbol; // prefer the SB symbol as the display label
      // Resolved default: SB wherever a curated SB feed exists.
      //
      // This used to read `d.suggestedAssetClass === 0 ? 0 : 1` — crypto to
      // Pyth — and the comment beside it said "no SB-crypto exists". That was
      // true when it was written. The crypto board has since migrated: BTC and
      // SOL both read `oracle_source = 1` on chain (measured 2026-08-08), and
      // all ten crypto feeds in SB_FEED_DATA are curated and warm. The line
      // outlived its premise and was pinning new crypto markets to the source
      // the protocol had already left.
      //
      // Being in SB_FEED_DATA is the whole condition: the list is curated, every
      // hash re-derives under sbFeedRegistry's parity guard, and resolveSource
      // still re-routes to Pyth when liveness proves the SB feed is dead.
      row.canonicalSource = 1;
    } else {
      // Zero Pyth match → SB-only row (no Pyth row to duplicate).
      byKey.set(k, {
        commonName: d.symbol,
        ticker: t,
        assetClass: d.suggestedAssetClass,
        pythFeedId: null,
        sbFeedHash: hash,
        canonicalSource: 1, // only the SB id exists for this row
      });
    }
  }

  return Array.from(byKey.values());
}
