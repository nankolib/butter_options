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
const JOBS_BY_FEED: Record<string, Array<Record<string, unknown>>> = {
  // Gold (XAU/USD via PAXG)
  "6c3c5cc720d1ffd8108aca22bf7834d659612b7e1a4e5f623b76846d1167355e": [
    { tasks: [{ httpTask: { url: "https://api.binance.com/api/v3/ticker/price?symbol=PAXGUSDT" } }, { jsonParseTask: { path: "$.price" } }] },
    { tasks: [{ httpTask: { url: "https://api.exchange.coinbase.com/products/PAXG-USD/ticker" } }, { jsonParseTask: { path: "$.price" } }] },
  ],
};

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
