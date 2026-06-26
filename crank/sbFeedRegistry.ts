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
import { OracleFeed, OracleJob } from "@switchboard-xyz/common";
import {
  ON_DEMAND_DEVNET_QUEUE,
  QUOTE_PROGRAM_ID,
} from "@switchboard-xyz/on-demand";

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

// ---- Gold (XAU/USD via PAXG) — the 1c-i-A-proven pilot feed ----------------
const GOLD: SbFeedEntry = {
  feedHashHex: "6c3c5cc720d1ffd8108aca22bf7834d659612b7e1a4e5f623b76846d1167355e",
  symbol: "XAU/USD",
  queue: ON_DEMAND_DEVNET_QUEUE,
  quoteProgram: QUOTE_PROGRAM_ID,
  minOracleSamples: 2,
  jobs: [
    { tasks: [{ httpTask: { url: "https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT" } }, { jsonParseTask: { path: "$.price" } }] },
    { tasks: [{ httpTask: { url: "https://api.exchange.coinbase.com/products/PAXG-USD/ticker" } }, { jsonParseTask: { path: "$.price" } }] },
  ],
};

const REGISTRY: Map<string, SbFeedEntry> = new Map([
  [GOLD.feedHashHex, GOLD],
]);

/** Normalize a feedHash (strip 0x, lowercase) for registry keying. */
export function normFeedHash(feedHashHex: string): string {
  return feedHashHex.replace(/^0x/, "").toLowerCase();
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
