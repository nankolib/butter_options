// =============================================================================
// usePythPrices.ts — Hermes-only spot prices for tickers in scope
// =============================================================================
//
// Stage P4b rewrite: single source of truth for every price displayed
// anywhere in the app is the Hermes off-chain price endpoint (mainnet by
// default, override via VITE_HERMES_BASE — see utils/env.ts). The
// CoinGecko + Jupiter + STATIC_FALLBACKS chain is gone; if Hermes can't
// resolve a feed_id, the ticker is absent from `prices` and call sites
// render the "—" placeholder.
//
// Caller shape: `Array<{ ticker, feedIdHex }>`. Hermes deals in feed_ids;
// the ticker is just the display key the caller wants the price under.
// Duplicate tickers in the input are last-write-wins with a console.warn —
// the on-chain registry enforces unique asset_name, so this is defensive.
// =============================================================================

import { useEffect, useMemo, useState } from "react";
import { getHermesBase } from "../utils/env";

const PRICE_PATH = "/v2/updates/price/latest";
const FETCH_TIMEOUT_MS = 4000;
const REFRESH_INTERVAL_MS = 30_000;
const CACHE_TTL_MS = 30_000;
const STALE_THRESHOLD_MS = 60_000;
// MED-7: prune cache entries older than 5× TTL. Without this, every
// distinct feed_id ever queried over a tab's lifetime accumulates a
// Map entry that's never cleaned up. Bounded leak (~1MB at 10k feeds)
// but worth fixing for long-running trader tabs.
const JANITOR_THRESHOLD_MS = CACHE_TTL_MS * 5;

export type FeedRequest = {
  /** Display key. Whatever string the caller wants the price returned under. */
  ticker: string;
  /** 64-char lowercase hex, no `0x` prefix. */
  feedIdHex: string;
};

type CachedPrice = { value: number; ts: number };

// Module-level cache shared across all hook instances. Keyed by feed_id_hex.
const priceCache = new Map<string, CachedPrice>();

type HermesParsedEntry = {
  id?: string;
  price?: { price?: string; expo?: number };
};

function parsePriceResponse(json: unknown): Map<string, number> {
  const out = new Map<string, number>();
  const parsed = (json as { parsed?: HermesParsedEntry[] })?.parsed;
  if (!Array.isArray(parsed)) return out;
  for (const entry of parsed) {
    const id = entry?.id;
    const priceStr = entry?.price?.price;
    const expo = entry?.price?.expo;
    if (typeof id !== "string" || typeof priceStr !== "string" || typeof expo !== "number") {
      continue;
    }
    const raw = parseFloat(priceStr);
    if (!Number.isFinite(raw)) continue;
    const value = raw * Math.pow(10, expo);
    if (!Number.isFinite(value)) continue;
    out.set(id.toLowerCase().replace(/^0x/, ""), value);
  }
  return out;
}

async function fetchPrices(feedIds: string[]): Promise<Map<string, number>> {
  if (feedIds.length === 0) return new Map();
  const params = feedIds.map((id) => `ids[]=${encodeURIComponent(id)}`).join("&");
  // ignore_invalid_price_ids=true: Hermes otherwise 404s the ENTIRE batch when a
  // single id is unknown/unavailable (e.g. an off-hours equity or SB/corrupt
  // feed), which used to blank spot/mark for every asset. With this flag it
  // returns 200 with the resolvable ids and silently drops the bad ones.
  const url = `${getHermesBase()}${PRICE_PATH}?${params}&parsed=true&ignore_invalid_price_ids=true`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ac.signal });
    if (!resp.ok) {
      throw new Error(`Hermes price HTTP ${resp.status}`);
    }
    const json = await resp.json();
    const out = parsePriceResponse(json);
    // Surface (don't silently swallow) any feed ids Hermes couldn't resolve.
    const missing = feedIds.filter((id) => !out.has(id.toLowerCase().replace(/^0x/, "")));
    if (missing.length) {
      console.warn(
        `[usePythPrices] Hermes returned no price for ${missing.length} feed id(s) (dropped, batch preserved): ${missing.map((m) => m.slice(0, 10) + "…").join(", ")}`,
      );
    }
    return out;
  } finally {
    clearTimeout(timer);
  }
}

export function usePythPrices(feeds: FeedRequest[]): {
  prices: Record<string, number>;
  loading: boolean;
  error: string | null;
  stale: boolean;
} {
  // Build the ticker → feedId map once per stable input. Duplicate tickers
  // are last-write-wins with a console.warn — see header comment.
  const tickerToFeedId = useMemo(() => {
    const map = new Map<string, string>();
    for (const f of feeds) {
      if (!f?.ticker || !f?.feedIdHex) continue;
      const hex = f.feedIdHex.toLowerCase().replace(/^0x/, "");
      if (map.has(f.ticker) && map.get(f.ticker) !== hex) {
        console.warn(
          `[usePythPrices] duplicate ticker "${f.ticker}" with differing feed_ids — using last`,
        );
      }
      map.set(f.ticker, hex);
    }
    return map;
  }, [feeds]);

  // Stable batch key — sort and dedupe feed_ids so re-renders don't re-fetch.
  const batchKey = useMemo(() => {
    return Array.from(new Set(tickerToFeedId.values())).sort().join(",");
  }, [tickerToFeedId]);

  const [prices, setPrices] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [stale, setStale] = useState(false);

  useEffect(() => {
    if (batchKey === "") {
      setPrices({});
      setLoading(false);
      setError(null);
      setStale(false);
      return;
    }
    const feedIds = batchKey.split(",");
    let cancelled = false;

    const computeStaleFromIds = (ids: string[]): boolean => {
      const now = Date.now();
      let oldest: number | null = null;
      for (const id of ids) {
        const c = priceCache.get(id);
        if (!c) continue;
        if (oldest == null || c.ts < oldest) oldest = c.ts;
      }
      return oldest != null && now - oldest > STALE_THRESHOLD_MS;
    };

    const computeFromCacheOnly = (): { complete: boolean; map: Map<string, number> } => {
      const out = new Map<string, number>();
      const now = Date.now();
      let complete = true;
      for (const id of feedIds) {
        const c = priceCache.get(id);
        if (c && now - c.ts < CACHE_TTL_MS) out.set(id, c.value);
        else complete = false;
      }
      return { complete, map: out };
    };

    const writeIntoState = (priceById: Map<string, number>) => {
      const next: Record<string, number> = {};
      for (const [ticker, hex] of tickerToFeedId.entries()) {
        const v = priceById.get(hex);
        if (typeof v === "number") next[ticker] = v;
      }
      setPrices(next);
    };

    const run = async () => {
      // Janitor pass: drop entries that haven't been refreshed in
      // 5× TTL. Runs at the top of every cycle so abandoned feed_ids
      // (user navigated away from a market) clear within ~150s.
      const janitorNow = Date.now();
      for (const [id, entry] of priceCache.entries()) {
        if (janitorNow - entry.ts > JANITOR_THRESHOLD_MS) {
          priceCache.delete(id);
        }
      }

      // Serve cache first if every feed_id is fresh.
      const cacheOnly = computeFromCacheOnly();
      if (cacheOnly.complete) {
        if (!cancelled) {
          writeIntoState(cacheOnly.map);
          setLoading(false);
          setError(null);
          setStale(computeStaleFromIds(feedIds));
        }
        return;
      }
      try {
        const fetched = await fetchPrices(feedIds);
        const now = Date.now();
        for (const [id, value] of fetched.entries()) {
          priceCache.set(id, { value, ts: now });
        }
        // Combine fresh fetch with whatever was already in cache.
        const merged = new Map<string, number>();
        for (const id of feedIds) {
          const c = priceCache.get(id);
          if (c) merged.set(id, c.value);
        }
        if (!cancelled) {
          writeIntoState(merged);
          setLoading(false);
          setError(null);
          setStale(computeStaleFromIds(feedIds));
        }
      } catch (err: any) {
        // On failure, fall back to whatever we already had cached, even if stale.
        const fallback = new Map<string, number>();
        for (const id of feedIds) {
          const c = priceCache.get(id);
          if (c) fallback.set(id, c.value);
        }
        if (!cancelled) {
          writeIntoState(fallback);
          setLoading(false);
          setError(err?.message ?? "Hermes price fetch failed");
          setStale(computeStaleFromIds(feedIds));
        }
      }
    };

    run();
    const id = setInterval(run, REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [batchKey, tickerToFeedId]);

  return { prices, loading, error, stale };
}
