// =============================================================================
// app/src/utils/liveness.ts — FE read of the crank-published liveness map
// =============================================================================
//
// Reads the crank's GET /liveness (off-chain, feed-id-keyed) and resolves a
// create-time oracle source under the ADVISORY policy (locked Phase-2 decision):
// liveness NEVER blocks creation — create only needs feed existence (the on-chain
// proof enforces that), and TradFi feeds are legitimately closed most hours. So:
//   - dual-source (gold): route to the LIVE peer; both live → per-class tie-break.
//   - single-source: always creatable via its source; a stale routed feed only
//     surfaces an advisory hint (the caller shows "pricing resumes at market
//     open"), it does NOT disable Create.
//   - map stale/missing/unreachable: silently fall back to the static Phase-1
//     default. Create always works. Liveness is strictly additive.
//
// Dependency-free (fetch + plain data). NO @switchboard-xyz/* — the SB SDK never
// enters the FE bundle; the crank does all SB work and publishes this map.
// =============================================================================

import { getSbCreateEndpoint } from "./env";

export interface FeedLiveness {
  source: 0 | 1;
  live: boolean;
  asOf: number;
  samples: number | null;
}
export interface LivenessMap {
  updatedAt: number; // unix seconds
  feeds: Record<string, FeedLiveness>; // keyed by 64-hex feed id (no 0x)
}

/** A map older than this is treated as absent (degrade to the static default). */
const STALE_AFTER_S = 600; // 10 min
/** Client-side cache so repeated resolves don't re-fetch each render. */
const CACHE_MS = 15_000;

let cache: { at: number; map: LivenessMap | null } | null = null;

/**
 * Fetch the liveness map (short-cached). Returns null on
 * unset-endpoint / unreachable / non-2xx / malformed — callers degrade to the
 * static default. Never throws.
 */
export async function getLiveness(): Promise<LivenessMap | null> {
  const now = Date.now();
  if (cache && now - cache.at < CACHE_MS) return cache.map;
  const base = getSbCreateEndpoint();
  if (!base) {
    cache = { at: now, map: null };
    return null;
  }
  try {
    const resp = await fetch(`${base}/liveness`);
    if (!resp.ok) {
      cache = { at: now, map: null };
      return null;
    }
    const json = await resp.json();
    if (typeof json?.updatedAt !== "number" || typeof json?.feeds !== "object") {
      cache = { at: now, map: null };
      return null;
    }
    cache = { at: now, map: json as LivenessMap };
    return cache.map;
  } catch {
    cache = { at: now, map: null };
    return null;
  }
}

/** Fresh enough to trust? A stale map (>10min) is treated as absent. */
export function isLivenessFresh(map: LivenessMap | null): map is LivenessMap {
  if (!map) return false;
  return Math.floor(Date.now() / 1000) - map.updatedAt <= STALE_AFTER_S;
}

export interface RoutableRow {
  pythFeedId: string | null;
  sbFeedHash: string | null;
  /** Phase-1 static default + the BOTH-LIVE tie-break preference. */
  canonicalSource: 0 | 1;
  assetClass: number;
}

export interface ResolvedSource {
  oracleSource: 0 | 1;
  feedIdHex: string;
  /** Advisory, non-blocking: the routed feed is liveness-KNOWN-stale. Never set
   *  for an untracked feed (e.g. crypto, which we don't probe). */
  stale: boolean;
}

function staticDefault(row: RoutableRow): ResolvedSource | null {
  const feedIdHex = row.canonicalSource === 0 ? row.pythFeedId : row.sbFeedHash;
  if (!feedIdHex) return null;
  return { oracleSource: row.canonicalSource, feedIdHex, stale: false };
}

/**
 * Resolve the create-time source under the advisory policy. Returns null only if
 * the row has no usable feed id at all. NEVER returns a "blocked" state — create
 * is always allowed (the on-chain proof is the real gate).
 *
 * `map` null/stale → the static Phase-1 default (silent degrade).
 */
export function resolveSource(
  row: RoutableRow,
  map: LivenessMap | null,
): ResolvedSource | null {
  const def = staticDefault(row);
  if (!def) return null; // no id at all
  if (!isLivenessFresh(map)) return def; // degrade silently to Phase-1

  const pythEntry = row.pythFeedId ? map.feeds[row.pythFeedId] : undefined;
  const sbEntry = row.sbFeedHash ? map.feeds[row.sbFeedHash] : undefined;
  const pythKnown = pythEntry !== undefined;
  const sbKnown = sbEntry !== undefined;
  const pythLive = !!pythEntry?.live;
  const sbLive = !!sbEntry?.live;

  const dual = !!row.pythFeedId && !!row.sbFeedHash;
  if (dual) {
    // both live → per-class tie-break (canonicalSource); one live → that one.
    if (pythLive && sbLive) {
      return {
        oracleSource: row.canonicalSource,
        feedIdHex: row.canonicalSource === 0 ? row.pythFeedId! : row.sbFeedHash!,
        stale: false,
      };
    }
    if (sbLive) return { oracleSource: 1, feedIdHex: row.sbFeedHash!, stale: false };
    if (pythLive) return { oracleSource: 0, feedIdHex: row.pythFeedId!, stale: false };
    // Neither live → prefer Pyth: its create is existence-only and works on a
    // stale feed, whereas an SB create REQUIRES a live signed quote. Advisory
    // stale only if Pyth is KNOWN-dead (untracked → no hint).
    return { oracleSource: 0, feedIdHex: row.pythFeedId!, stale: pythKnown && !pythLive };
  }

  // Single-source.
  if (row.sbFeedHash && !row.pythFeedId) {
    return { oracleSource: 1, feedIdHex: row.sbFeedHash, stale: sbKnown && !sbLive };
  }
  // Pyth-only (incl. crypto, which is untracked → stale stays false).
  return { oracleSource: 0, feedIdHex: row.pythFeedId!, stale: pythKnown && !pythLive };
}
