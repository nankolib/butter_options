// =============================================================================
// app/src/utils/sbFeedData.ts — Pure Switchboard feed registry data (shared SoT)
// =============================================================================
//
// Dependency-free supported-Switchboard-feed DATA, importable by BOTH the FE
// (directly) and the crank (via the @app/* alias) — the same single-source
// pattern as seedVol.ts. It holds ONLY plain data; the SDK-bound construction
// (OracleFeed/OracleJob, real PublicKey queue/program constants, the cached job
// specs) stays in crank/sbFeedRegistry.ts, which imports this module and layers
// the Switchboard SDK on top.
//
// Pubkeys are plain base58 strings so this file imports neither
// @switchboard-xyz/* nor @solana/web3.js — keeping it browser-safe and clear of
// the heavy SB SDK (see the bundle spike). crank/sbFeedRegistry.ts re-derives the
// real PublicKey/SDK constants from these strings and asserts they equal the
// SDK's own constants at module load, so a future SDK constant change fails the
// crank LOUDLY rather than drifting silently.
//
// Adding a feed = one entry here (+ its job spec in sbFeedRegistry.ts). Initially
// gold (XAU/USD via PAXG) only — the feed proven end-to-end by the 1c-i-A devnet
// smoke.
// =============================================================================

/** Pure, dependency-free data for one supported Switchboard feed. */
export interface SbFeedDatum {
  /** 64-char lowercase hex, no 0x prefix. Doubles as the market pyth_feed_id. */
  feedHashHex: string;
  /** Human label for logs / UI (e.g. "XAU/USD"). */
  symbol: string;
  /** On-chain asset_class u8: 0=crypto 1=commodity 2=equity 3=forex 4=etf. */
  suggestedAssetClass: 0 | 1 | 2 | 3 | 4;
  /** SB On-Demand queue this feed is served by (base58 string). */
  queuePubkey: string;
  /** SB quote program / verifier target (base58 string). */
  quoteProgramPubkey: string;
  /** Min aggregating-oracle samples (matches on-chain SB_MIN_ORACLE_SAMPLES_FLOOR=2). */
  minOracleSamples: number;
}

// SB On-Demand devnet constants, as base58 strings copied verbatim from the SDK:
//   ON_DEMAND_DEVNET_QUEUE = EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7
//   QUOTE_PROGRAM_ID       = orac1eFjzWL5R3RbbdMV68K9H6TaCVVcL6LjvQQWAbz
// sbFeedRegistry.ts asserts these equal the live SDK constants at module load.
const ON_DEMAND_DEVNET_QUEUE_B58 = "EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7";
const QUOTE_PROGRAM_ID_B58 = "orac1eFjzWL5R3RbbdMV68K9H6TaCVVcL6LjvQQWAbz";

/** Gold (XAU/USD via PAXG) — the 1c-i-A-proven pilot feed. */
export const SB_FEED_DATA: SbFeedDatum[] = [
  {
    feedHashHex: "6c3c5cc720d1ffd8108aca22bf7834d659612b7e1a4e5f623b76846d1167355e",
    symbol: "XAU/USD",
    suggestedAssetClass: 1, // commodity
    queuePubkey: ON_DEMAND_DEVNET_QUEUE_B58,
    quoteProgramPubkey: QUOTE_PROGRAM_ID_B58,
    minOracleSamples: 2,
  },
];

/** Normalize a feedHash (strip 0x, lowercase) for keying / lookup. */
export function normSbFeedHash(feedHashHex: string): string {
  return feedHashHex.replace(/^0x/, "").toLowerCase();
}

/** Pure-data lookup by feedHash, or undefined if unsupported. */
export function lookupSbFeedDatum(feedHashHex: string): SbFeedDatum | undefined {
  const k = normSbFeedHash(feedHashHex);
  return SB_FEED_DATA.find((d) => normSbFeedHash(d.feedHashHex) === k);
}
