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

// The routing DECISION lives in ./routeSource — a pure module with no ./env
// import, so it can compile to CommonJS and be tested. This file is the
// TRANSPORT. Re-exported here so every existing call site keeps importing
// `resolveSource` / `LivenessMap` from "./liveness" unchanged.
export {
  isLivenessFresh,
  resolveSource,
  STALE_AFTER_S,
  type FeedLiveness,
  type LivenessMap,
  type RoutableRow,
  type ResolvedSource,
} from "./routeSource";

import type { LivenessMap } from "./routeSource";

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
