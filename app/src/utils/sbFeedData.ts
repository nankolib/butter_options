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
  // ---- Wave-2 equities (locked manifest, minted 2026-07-20; ClickUp 86eyb0xjz).
  // symbol is PART OF THE HASH — never edit. Registration is a PREREQUISITE of the
  // equity migrations: _cutover_rebirth's create path throws "not in SB registry"
  // (switchboardCreateMarket.ts:80) and would leave the asset MARKETLESS (found
  // live on MSFT). sbFeedRegistry.ts asserts each hash reproduces at module load.
  ...(
    [
      ["MSFT", "b13e5f030af9a49150591b6cbce83810184331e5b6a0eae8b303a49153496c56"],
      ["AAPL", "d0ab87e8218247d61f3b60e0d9c7e9dc93f691f30849552e0923aa8acd15fdc8"],
      ["GOOGL", "c47268fa603180997ab954702ef058dcf56d97f597085d095278dfffd37c9103"],
      ["AMZN", "bf3190ce3b040d25d1af35c66461fe8fee2f7dd4c83e72e5c13dcc89929abf3f"],
      ["META", "56bb4c5863ad44b5c59d75cce27d170f8c05e50b9698c9a27480bc7c47f11570"],
      ["NVDA", "5378913080bd823885beb8cc37d55842d438e2198f8ce711b7385b527a542bdf"],
      ["AMD", "28fcb07fb1301a399cbe35b809cd8ffa45a22f5bd4e3a15845b4fca219846668"],
      ["TSLA", "24f5404db181873fead6fd9ad15c7edc2265e8b7a494b3168055fa3bfbb3ced3"],
      ["COIN", "60e0a2d31235e2e3c7414635f3bf0c14c671098ef953b0823d380913d627c868"],
      ["MSTR", "5dc7af42f5237fb2d39aa65374c91234da9a92ba940ac9a5613b51d59d9a830a"],
      ["CRCL", "077acbc9a679e4660b8ace50be067bd08a443f1ea7c0a48b4b6e444c23c17040"],
    ] as const
  ).map(([t, feedHashHex]): SbFeedDatum => ({
    feedHashHex,
    symbol: `${t}/USD`,
    suggestedAssetClass: 2, // equity
    queuePubkey: ON_DEMAND_DEVNET_QUEUE_B58,
    quoteProgramPubkey: QUOTE_PROGRAM_ID_B58,
    minOracleSamples: 2,
  })),
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
