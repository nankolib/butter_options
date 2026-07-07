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

// Crypto-surface migration (Pyth Core → Switchboard, Jul-31 cutover): the 5
// live crypto assets get parallel SB feeds so their SB vol oracles can warm
// ahead of cutover. feedHash = FeedHash.computeOracleFeedId(buildOracleFeed(entry))
// — validated to reproduce the gold hash; the `symbol` is part of the hash so it
// MUST NOT change once minted. Sources: Binance+Coinbase for BTC/ETH/SOL/XRP;
// FARTCOIN uses Gate+MEXC (Bybit spot does not list FARTCOIN — "Not supported
// symbols"). Each verified live via Crossbar simulate vs Pyth spot within <0.07%.
export const SB_FEED_DATA: SbFeedDatum[] = [
  /** Gold (XAU/USD via PAXG) — the 1c-i-A-proven pilot feed. */
  {
    feedHashHex: "6c3c5cc720d1ffd8108aca22bf7834d659612b7e1a4e5f623b76846d1167355e",
    symbol: "XAU/USD",
    suggestedAssetClass: 1, // commodity
    queuePubkey: ON_DEMAND_DEVNET_QUEUE_B58,
    quoteProgramPubkey: QUOTE_PROGRAM_ID_B58,
    minOracleSamples: 2,
  },
  {
    feedHashHex: "baf182b54386b4a1c0354b7d64fb33d679301087a8b509d6a397d7b4f5162ee2",
    symbol: "BTC/USD",
    suggestedAssetClass: 0, // crypto
    queuePubkey: ON_DEMAND_DEVNET_QUEUE_B58,
    quoteProgramPubkey: QUOTE_PROGRAM_ID_B58,
    minOracleSamples: 2,
  },
  {
    feedHashHex: "1d8f55a03da760d0f322bc1d066427e95573f651d506e0e31a5499659349caa3",
    symbol: "ETH/USD",
    suggestedAssetClass: 0, // crypto
    queuePubkey: ON_DEMAND_DEVNET_QUEUE_B58,
    quoteProgramPubkey: QUOTE_PROGRAM_ID_B58,
    minOracleSamples: 2,
  },
  {
    feedHashHex: "e01fe3bb1d659e5957296b2637658defd1f8b42fc87dd9f16e8fff16fcaeb463",
    symbol: "SOL/USD",
    suggestedAssetClass: 0, // crypto
    queuePubkey: ON_DEMAND_DEVNET_QUEUE_B58,
    quoteProgramPubkey: QUOTE_PROGRAM_ID_B58,
    minOracleSamples: 2,
  },
  {
    feedHashHex: "a1c4ce28a9a4abd471fb2eb11236c299a3b02cad72f3f93437aa01578405f736",
    symbol: "XRP/USD",
    suggestedAssetClass: 0, // crypto
    queuePubkey: ON_DEMAND_DEVNET_QUEUE_B58,
    quoteProgramPubkey: QUOTE_PROGRAM_ID_B58,
    minOracleSamples: 2,
  },
  {
    feedHashHex: "9612492ea0fdac76ef82ee98f21eee60c98ebb5cc8a2810fc415e56a7357a5f2",
    symbol: "FARTCOIN/USD",
    suggestedAssetClass: 0, // crypto
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
