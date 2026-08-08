// =============================================================================
// app/src/utils/routeSource.ts — the PURE create-time oracle routing decision
// =============================================================================
//
// Split out of liveness.ts on 2026-08-08 (K2/D1) for one reason: liveness.ts
// imports ./env, which reads `import.meta.env`, which cannot compile to
// CommonJS — so the routing decision, the single most consequential pure
// function in the create path, could not be tested at all. `oracle_source` is
// IMMUTABLE once create_market writes it (close+recreate is the only migration),
// so a wrong routing decision is permanent for that market. It gets tests.
//
// This file is the decision ONLY: no fetch, no env, no cache. liveness.ts keeps
// the transport and re-exports everything here, so every existing call site
// (`import { resolveSource } from "./liveness"`) is untouched.
//
// THE ADVISORY POLICY (locked Phase-2 decision, unchanged by the split):
// liveness NEVER blocks creation — create only needs feed existence (the
// on-chain proof enforces that), and TradFi feeds are legitimately closed most
// hours. A stale routed feed surfaces an advisory hint, it does NOT disable
// Create.
// =============================================================================

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
export const STALE_AFTER_S = 600; // 10 min

/** Fresh enough to trust? A stale map (>10min) is treated as absent.
 *  `nowSec` is injectable so the routing tests have no clock dependence. */
export function isLivenessFresh(
  map: LivenessMap | null,
  nowSec: number = Math.floor(Date.now() / 1000),
): map is LivenessMap {
  if (!map) return false;
  return nowSec - map.updatedAt <= STALE_AFTER_S;
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
  nowSec: number = Math.floor(Date.now() / 1000),
): ResolvedSource | null {
  const def = staticDefault(row);
  if (!def) return null; // no id at all
  if (!isLivenessFresh(map, nowSec)) return def; // degrade silently to Phase-1

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

    // Neither live. TWO DIFFERENT SITUATIONS, and conflating them was the other
    // half of P-10 (fixed 2026-08-08):
    //
    //  (a) We PROBED and found them dead → prefer Pyth. Justified: a Pyth create
    //      is existence-only and works against a stale feed, whereas an SB
    //      create REQUIRES a live signed quote and would simply fail.
    //
    //  (b) We probed NEITHER — both ids absent from the map. That is every
    //      crypto row, because the crank publishes liveness for TradFi feeds
    //      only. Absence is not evidence that Switchboard is down, but this
    //      branch treated it as such and overrode the row's own default. Fixing
    //      buildAssetRegistry alone would NOT have changed a single crypto
    //      create: the new SB default would have been discarded right here.
    if (!pythKnown && !sbKnown) return def;

    return { oracleSource: 0, feedIdHex: row.pythFeedId!, stale: pythKnown && !pythLive };
  }

  // Single-source.
  if (row.sbFeedHash && !row.pythFeedId) {
    return { oracleSource: 1, feedIdHex: row.sbFeedHash, stale: sbKnown && !sbLive };
  }
  // Pyth-only (incl. crypto, which is untracked → stale stays false).
  return { oracleSource: 0, feedIdHex: row.pythFeedId!, stale: pythKnown && !pythLive };
}
