// ============================================================================
// crank/sbFeedRegistry.ts — supported-Switchboard-feed registry (Stage 3 1c-ii-A)
// ============================================================================
//
// The allow-list + job source for the SB oracle crank. An on-chain SB market's
// `pyth_feed_id` holds the 32-byte SB feedHash, but a feedHash alone does NOT
// encode the oracle JOBS needed to fetch a signed quote. This registry maps each
// SUPPORTED feedHash → {symbol, queue, quoteProgram, minOracleSamples, jobs}.
//
// Roles:
//   (a) allow-gate — the crank SKIPS any discovered SB market whose feedHash
//       isn't here (a junk SB market can't make the crank chase an
//       unresolvable feed).
//   (b) job source — `buildOracleFeed` constructs the `OracleFeed` (jobs) the
//       managed-quote fetch needs. These are the CACHED/FALLBACK job spec.
//   (c) Crossbar transport — the resolved `OracleFeed` + a `CrossbarClient` are
//       handed to `buildManagedQuoteUpdateIxs` (switchboardQuotePost.ts), which
//       uses Crossbar (the SDK managed path) to fetch the signed quote from the
//       gateway. A future enhancement can `crossbar.fetchOracleFeed(feedHash)`
//       to FRESHEN these cached jobs at runtime; the registry stays the fallback.
//
// Adding a feed = one entry in REGISTRY. Initially gold (XAU/USD via PAXG) only —
// the feed proven end-to-end by the 1c-i-A devnet smoke.
// ============================================================================

import { PublicKey } from "@solana/web3.js";
import { OracleFeed, OracleJob, FeedHash } from "@switchboard-xyz/common";
import {
  ON_DEMAND_DEVNET_QUEUE,
  QUOTE_PROGRAM_ID,
} from "@switchboard-xyz/on-demand";
import {
  SB_FEED_DATA,
  normSbFeedHash,
  type SbFeedDatum,
} from "@app/utils/sbFeedData";

export interface SbFeedEntry {
  /** 64-char lowercase hex, no 0x prefix. */
  feedHashHex: string;
  /** Human label for logs. */
  symbol: string;
  /** SB On-Demand queue this feed is served by. */
  queue: PublicKey;
  /** SB quote program (verifier target — informational; the read path verifies in-band). */
  quoteProgram: PublicKey;
  /** Min aggregating-oracle samples (matches the on-chain SB_MIN_ORACLE_SAMPLES_FLOOR=2). */
  minOracleSamples: number;
  /** Cached/fallback OracleJob specs (raw objects passed to OracleJob.fromObject). */
  jobs: Array<Record<string, unknown>>;
}

// ---- Per-feed cached/fallback OracleJob specs (SDK construction; keyed by
// normalized feedHash). These stay HERE, not in sbFeedData.ts: they are the
// SB-managed-quote job source, conceptually part of the SDK path, and the FE
// has no use for them. ----
// NOTE: job ORDER + exact URLs/paths are load-bearing — they feed
// FeedHash.computeOracleFeedId(buildOracleFeed(entry)) which MUST equal the
// feedHash key (and the on-chain market/vol-oracle feed_id). Do not reorder or
// edit a job's url/path without re-minting the feedHash.
const JOBS_BY_FEED: Record<string, Array<Record<string, unknown>>> = {
  // Gold (XAU/USD via PAXG)
  "6c3c5cc720d1ffd8108aca22bf7834d659612b7e1a4e5f623b76846d1167355e": [
    { tasks: [{ httpTask: { url: "https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT" } }, { jsonParseTask: { path: "$.price" } }] },
    { tasks: [{ httpTask: { url: "https://api.exchange.coinbase.com/products/PAXG-USD/ticker" } }, { jsonParseTask: { path: "$.price" } }] },
  ],
  // BTC/USD — Binance + Coinbase
  "baf182b54386b4a1c0354b7d64fb33d679301087a8b509d6a397d7b4f5162ee2": [
    { tasks: [{ httpTask: { url: "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT" } }, { jsonParseTask: { path: "$.price" } }] },
    { tasks: [{ httpTask: { url: "https://api.exchange.coinbase.com/products/BTC-USD/ticker" } }, { jsonParseTask: { path: "$.price" } }] },
  ],
  // ETH/USD — Binance + Coinbase
  "1d8f55a03da760d0f322bc1d066427e95573f651d506e0e31a5499659349caa3": [
    { tasks: [{ httpTask: { url: "https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT" } }, { jsonParseTask: { path: "$.price" } }] },
    { tasks: [{ httpTask: { url: "https://api.exchange.coinbase.com/products/ETH-USD/ticker" } }, { jsonParseTask: { path: "$.price" } }] },
  ],
  // SOL/USD — Binance + Coinbase
  "e01fe3bb1d659e5957296b2637658defd1f8b42fc87dd9f16e8fff16fcaeb463": [
    { tasks: [{ httpTask: { url: "https://api.binance.com/api/v3/ticker/price?symbol=SOLUSDT" } }, { jsonParseTask: { path: "$.price" } }] },
    { tasks: [{ httpTask: { url: "https://api.exchange.coinbase.com/products/SOL-USD/ticker" } }, { jsonParseTask: { path: "$.price" } }] },
  ],
  // XRP/USD — Binance + Coinbase
  "a1c4ce28a9a4abd471fb2eb11236c299a3b02cad72f3f93437aa01578405f736": [
    { tasks: [{ httpTask: { url: "https://api.binance.com/api/v3/ticker/price?symbol=XRPUSDT" } }, { jsonParseTask: { path: "$.price" } }] },
    { tasks: [{ httpTask: { url: "https://api.exchange.coinbase.com/products/XRP-USD/ticker" } }, { jsonParseTask: { path: "$.price" } }] },
  ],
  // FARTCOIN/USD — Gate + MEXC (Bybit spot does not list FARTCOIN)
  "9612492ea0fdac76ef82ee98f21eee60c98ebb5cc8a2810fc415e56a7357a5f2": [
    { tasks: [{ httpTask: { url: "https://api.gateio.ws/api/v4/spot/tickers?currency_pair=FARTCOIN_USDT" } }, { jsonParseTask: { path: "$[0].last" } }] },
    { tasks: [{ httpTask: { url: "https://api.mexc.com/api/v3/ticker/price?symbol=FARTCOINUSDT" } }, { jsonParseTask: { path: "$.price" } }] },
  ],
  // JUP/USD — Binance + Gate (Wave-1 meme birth 2026-07-16, re-registered 2026-07-22)
  "5f42a2a7b0b52a26774d3554b4d58cb5b997079379b5b94649d34451be0239f2": [
    { tasks: [{ httpTask: { url: "https://api.binance.com/api/v3/ticker/price?symbol=JUPUSDT" } }, { jsonParseTask: { path: "$.price" } }] },
    { tasks: [{ httpTask: { url: "https://api.gateio.ws/api/v4/spot/tickers?currency_pair=JUP_USDT" } }, { jsonParseTask: { path: "$[0].last" } }] },
  ],
  // JTO/USD — Binance + Gate
  "bc8e0c273c458ee54aadd7d18875c2d3164a4acb424680c0a2d5f6a121317ec4": [
    { tasks: [{ httpTask: { url: "https://api.binance.com/api/v3/ticker/price?symbol=JTOUSDT" } }, { jsonParseTask: { path: "$.price" } }] },
    { tasks: [{ httpTask: { url: "https://api.gateio.ws/api/v4/spot/tickers?currency_pair=JTO_USDT" } }, { jsonParseTask: { path: "$[0].last" } }] },
  ],
  // WIF/USD — Binance + Gate (Coinbase WIF-USD rejected per manifest)
  "c186e1064610e8f14330734e4492e65dd6d141da371f1f94419c96296801294a": [
    { tasks: [{ httpTask: { url: "https://api.binance.com/api/v3/ticker/price?symbol=WIFUSDT" } }, { jsonParseTask: { path: "$.price" } }] },
    { tasks: [{ httpTask: { url: "https://api.gateio.ws/api/v4/spot/tickers?currency_pair=WIF_USDT" } }, { jsonParseTask: { path: "$[0].last" } }] },
  ],
  // BONK/USD — Binance + Coinbase
  "c062a25a824803dd5b88661f0b6dec5b6bc2bfc2ec385f2e053b83e58660e32f": [
    { tasks: [{ httpTask: { url: "https://api.binance.com/api/v3/ticker/price?symbol=BONKUSDT" } }, { jsonParseTask: { path: "$.price" } }] },
    { tasks: [{ httpTask: { url: "https://api.exchange.coinbase.com/products/BONK-USD/ticker" } }, { jsonParseTask: { path: "$.price" } }] },
  ],
  // ---- Wave-2 equities — quotes.opta.fyi (Finnhub + Yahoo). Builders are
  // byte-identical to crank/_equity_feed_hashes.ts (the generator that froze the
  // manifest). The parity guard below re-derives every hash at module load. ----
  ...eqJobs(),
};

/** Finnhub+Yahoo job pair per equity ticker, keyed by its FROZEN feedHash. */
function eqJobs(): Record<string, Array<Record<string, unknown>>> {
  const rows: Array<[string, string]> = [
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
    // Wave-2b (locked manifest, 2026-07-21) — builders below are unchanged, so
    // these keys re-derive exactly like the other 11 under the parity guard.
    ["SPCX", "fd7a0b9ea922e14e18944f8105b151df922487da9b1b2ed5ad52150924ed413f"],
    ["HOOD", "9801bc9a0cc3eceb1ec4dfb964186a426883bb89a670c5968879b6e2c31b7c8b"],
  ];
  const out: Record<string, Array<Record<string, unknown>>> = {};
  for (const [t, h] of rows) {
    out[h] = [
      { tasks: [{ httpTask: { url: `https://quotes.opta.fyi/finnhub/quote?symbol=${t}` } }, { jsonParseTask: { path: "$.c" } }] },
      { tasks: [{ httpTask: { url: `https://quotes.opta.fyi/yahoo/chart/${t}` } }, { jsonParseTask: { path: "$.chart.result[0].meta.regularMarketPrice" } }] },
    ];
  }
  return out;
}

// Map each pure-data base58 string → the live SDK constant, asserting equality
// so a future SDK constant change fails the crank LOUDLY instead of drifting.
const QUEUE_BY_B58: Record<string, PublicKey> = {
  [ON_DEMAND_DEVNET_QUEUE.toBase58()]: ON_DEMAND_DEVNET_QUEUE,
};
const PROGRAM_BY_B58: Record<string, PublicKey> = {
  [QUOTE_PROGRAM_ID.toBase58()]: QUOTE_PROGRAM_ID,
};

function resolveQueue(b58: string): PublicKey {
  const q = QUEUE_BY_B58[b58];
  if (!q) throw new Error(`sbFeedRegistry: unknown SB queue ${b58} (sbFeedData drifted from SDK constant)`);
  return q;
}
function resolveProgram(b58: string): PublicKey {
  const p = PROGRAM_BY_B58[b58];
  if (!p) throw new Error(`sbFeedRegistry: unknown SB quote program ${b58} (sbFeedData drifted from SDK constant)`);
  return p;
}

function entryFromDatum(d: SbFeedDatum): SbFeedEntry {
  const key = normSbFeedHash(d.feedHashHex);
  const jobs = JOBS_BY_FEED[key];
  if (!jobs) throw new Error(`sbFeedRegistry: no job spec for ${d.symbol} (${key.slice(0, 10)})`);
  return {
    feedHashHex: key,
    symbol: d.symbol,
    queue: resolveQueue(d.queuePubkey),
    quoteProgram: resolveProgram(d.quoteProgramPubkey),
    minOracleSamples: d.minOracleSamples,
    jobs,
  };
}

const REGISTRY: Map<string, SbFeedEntry> = new Map(
  SB_FEED_DATA.map((d) => [normSbFeedHash(d.feedHashHex), entryFromDatum(d)]),
);

// ---- PARITY GUARD (fail-loud, module load) --------------------------------
// Every entry's jobs+symbol MUST re-derive its own feedHash key. This is the
// GUARD1 assertion applied to the registry itself: a reordered job, an edited
// URL/path, or a changed symbol silently mints a DIFFERENT feed — which would
// make the crank fetch quotes for the wrong feed and make create_market build an
// unusable quote. Drift dies here, not in production.
export function assertRegistryHashParity(): { checked: number; ok: string[] } {
  const ok: string[] = [];
  const bad: string[] = [];
  for (const [key, entry] of REGISTRY) {
    const derived = normSbFeedHash(
      Buffer.from(FeedHash.computeOracleFeedId(buildOracleFeed(entry))).toString("hex"),
    );
    if (derived === key) ok.push(entry.symbol);
    else bad.push(`${entry.symbol}: key=${key.slice(0, 12)}… derived=${derived.slice(0, 12)}…`);
  }
  if (bad.length > 0) {
    throw new Error(
      `sbFeedRegistry PARITY FAILURE — ${bad.length}/${REGISTRY.size} entries do not reproduce their feedHash:\n  ${bad.join("\n  ")}`,
    );
  }
  return { checked: REGISTRY.size, ok };
}
assertRegistryHashParity();

/** Normalize a feedHash (strip 0x, lowercase) for registry keying. Thin
 *  re-export of the shared pure-data normalizer so existing callers
 *  (switchboardCreateMarket.ts) stay untouched. */
export function normFeedHash(feedHashHex: string): string {
  return normSbFeedHash(feedHashHex);
}

/** Registry entry for a feedHash, or undefined if unsupported. */
export function lookupSbFeed(feedHashHex: string): SbFeedEntry | undefined {
  return REGISTRY.get(normFeedHash(feedHashHex));
}

/** Is this feedHash in the supported allow-list? */
export function isSupportedSbFeed(feedHashHex: string): boolean {
  return REGISTRY.has(normFeedHash(feedHashHex));
}

/** All supported feeds (for boot logging). */
export function listSupportedFeeds(): SbFeedEntry[] {
  return Array.from(REGISTRY.values());
}

/**
 * Build the `OracleFeed` for an entry from its cached jobs. Crossbar is the
 * TRANSPORT (handed to buildManagedQuoteUpdateIxs separately) — the jobs here
 * are the source of truth until a Crossbar-resolution freshening is wired.
 */
export function buildOracleFeed(entry: SbFeedEntry): OracleFeed {
  return OracleFeed.fromObject({
    name: entry.symbol,
    jobs: entry.jobs.map((o) => OracleJob.fromObject(o)),
    minOracleSamples: entry.minOracleSamples,
    minJobResponses: entry.jobs.length,
    maxJobRangePct: 5000000000,
  });
}
