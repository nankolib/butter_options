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
// THE SOURCE RESOLUTION RULE (2026-08-08, K3) supersedes the Phase-2 tie-break:
// a curated SB feedHash means oracle_source = SB, unconditionally. Liveness no
// longer reroutes an SB-curated asset. Pyth remains the source only for assets
// with ZERO SB coverage — today HYPE, RAY, XAG and USOILSPOT.
//
// What survives from the advisory policy: liveness still never BLOCKS creation
// here. `stale` is a hint the caller renders as the market-hours copy; it does
// not change the routing. What changed is that a dead SB feed no longer buys a
// successful create at the cost of a permanently mis-sourced market — see the
// rule's own comment below for why immutability makes that trade a bad one.
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

  // ── THE SOURCE RESOLUTION RULE (2026-08-08) ────────────────────────────────
  // A curated SB feedHash means oracle_source = SB. Unconditionally. Liveness
  // cannot downgrade an SB-curated asset to Pyth, and neither can a live Pyth
  // peer reclaim it.
  //
  // What this replaces: a "prefer Pyth when neither peer is live" fallback,
  // justified on the grounds that a Pyth create is existence-only and succeeds
  // against a stale feed while an SB create needs a live signed quote. True,
  // and the wrong objective. `oracle_source` is IMMUTABLE, so that branch did
  // not rescue the create — it made the wrong market permanent. An equity
  // created out of hours was bound forever to a Pyth equity feed that 404s
  // outside NYSE hours, i.e. one that cannot price an 08:00 UTC expiry. A
  // failed create is recoverable in thirty seconds. A mis-sourced market is
  // recoverable only by close-and-recreate.
  //
  // So an out-of-hours attempt now either completes on the SB path or fails
  // fast with the market-hours copy and the real program logs (D2 surfaces
  // them). Both are honest outcomes. Silently minting a Pyth market was not.
  //
  // Checked BEFORE the freshness gate and keyed on `sbFeedHash` rather than
  // `canonicalSource`: the rule is a property of HAVING a curated feed, not of
  // a field a caller could set wrong.
  if (row.sbFeedHash) {
    const sbEntry = isLivenessFresh(map, nowSec) ? map.feeds[row.sbFeedHash] : undefined;
    return {
      oracleSource: 1,
      feedIdHex: row.sbFeedHash,
      // Advisory only — it drives the market-hours copy, it does not reroute.
      stale: sbEntry !== undefined && !sbEntry.live,
    };
  }

  if (!isLivenessFresh(map, nowSec)) return def; // degrade silently to Phase-1

  // Everything below is the ZERO-SB-COVERAGE path — the rule above returned for
  // every row that has a curated SB feed. Today that set is HYPE and RAY (no SB
  // crypto feed), XAG (the SB silver migration is blocked — no feed exists to
  // migrate to) and USOILSPOT. Pyth is not a fallback for them; it is their only
  // source, and it must keep working.
  //
  // The dual-source branch that used to live here is gone with the fallback it
  // implemented: "dual" required an sbFeedHash, so it is unreachable now, and an
  // unreachable branch that looks like live routing logic is exactly the trap
  // writePauseGate had become.
  const pythEntry = row.pythFeedId ? map.feeds[row.pythFeedId] : undefined;
  const pythKnown = pythEntry !== undefined;
  const pythLive = !!pythEntry?.live;
  // Pyth is this row's only source. A known-dead feed raises the advisory but
  // never blocks the create — the on-chain proof is the real gate, and these
  // assets are legitimately closed most hours.
  return { oracleSource: 0, feedIdHex: row.pythFeedId!, stale: pythKnown && !pythLive };
}
