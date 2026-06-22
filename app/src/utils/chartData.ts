// =============================================================================
// app/src/utils/chartData.ts — Pass 3 chart data (React-free)
// =============================================================================
//
// Pure data functions for the v2 Trade-page chart:
//   - UNDERLYING candles from CoinGecko OHLC (crypto-only v1, T7)
//   - CONTRACT fills from the on-chain OrderFilled tape (T8)
//   - BS-2002 mark fallback: synthesize a contract candle series by repricing
//     the option along the underlying candles when real trade history is thin.
//
// Tested against devnet in isolation; PriceChart (lightweight-charts) wraps these.
// =============================================================================

import { PublicKey } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";
import { calculateCallPremium, calculatePutPremium, getDefaultVolatility, applyVolSmile } from "./blackScholes";

/** lightweight-charts candlestick datum (time = unix seconds). */
export interface Candle { time: number; open: number; high: number; low: number; close: number; }
export interface ContractFill { time: number; price: number; qty: number }

/** Below this many real fills, the contract chart uses the synthetic series. */
export const CONTRACT_FILL_THRESHOLD = 5;

// Crypto-only v1 (T7). Equities/commodities candles are a known deferred gap.
const COINGECKO_IDS: Record<string, string> = {
  BTC: "bitcoin", ETH: "ethereum", SOL: "solana",
};

export function coingeckoId(asset: string): string | null {
  return COINGECKO_IDS[asset.toUpperCase()] ?? null;
}

const OHLC_TTL_MS = 5 * 60_000; // 5 min — CoinGecko OHLC is coarse; reloads reuse.
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Only candles with finite numeric fields survive — nothing undefined/NaN ever
 *  reaches lightweight-charts (Pass-10 A). */
function sanitize(candles: Candle[]): Candle[] {
  return candles.filter(
    (c) => Number.isFinite(c.time) && Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close),
  );
}

/**
 * UNDERLYING spot OHLC from CoinGecko. Crypto-only (v1). Bulletproofed (Pass 10):
 *   - sessionStorage cache keyed (id, days), 5-min TTL → reloads don't re-hit the
 *     endpoint (kills the 429-on-reload loop that produced empty candles).
 *   - retry with backoff on 429 / transient failure.
 *   - returns sanitized candles; [] only when genuinely unavailable (caller shows
 *     a loading/unavailable state, never a blank box).
 */
export async function fetchUnderlyingCandles(asset: string, days = 30): Promise<Candle[]> {
  const id = coingeckoId(asset);
  if (!id) return [];
  const key = `opta.ohlc.${id}.${days}`;

  // Fresh cache hit → reuse (no network).
  try {
    const cached = sessionStorage.getItem(key);
    if (cached) {
      const { at, candles } = JSON.parse(cached) as { at: number; candles: Candle[] };
      if (Date.now() - at < OHLC_TTL_MS && Array.isArray(candles) && candles.length) return candles;
    }
  } catch { /* sessionStorage unavailable — fall through to fetch */ }

  const url = `https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=usd&days=${days}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) { await sleep(600 * (attempt + 1)); continue; }
      if (!res.ok) break;
      const raw = (await res.json()) as [number, number, number, number, number][];
      const candles = sanitize(raw.map(([ms, o, h, l, c]) => ({ time: Math.floor(ms / 1000), open: o, high: h, low: l, close: c })));
      if (candles.length) {
        try { sessionStorage.setItem(key, JSON.stringify({ at: Date.now(), candles })); } catch { /* quota */ }
        return candles;
      }
      break;
    } catch { await sleep(600 * (attempt + 1)); }
  }

  // All attempts failed → fall back to STALE cache (better than blank) if present.
  try {
    const cached = sessionStorage.getItem(key);
    if (cached) {
      const { candles } = JSON.parse(cached) as { candles: Candle[] };
      if (Array.isArray(candles) && candles.length) return candles;
    }
  } catch { /* ignore */ }
  return [];
}

/**
 * CONTRACT fills from the OrderFilled tape: signatures that mention the series
 * mint → decode the OrderFilled event (price 6dp, qty, blockTime). Best-effort.
 */
export async function fetchContractFills(
  program: Program<any>, optionMint: string, limit = 50,
): Promise<ContractFill[]> {
  const conn = program.provider.connection;
  const out: ContractFill[] = [];
  try {
    const sigs = await conn.getSignaturesForAddress(new PublicKey(optionMint), { limit });
    for (const s of sigs) {
      if (s.err) continue;
      const tx = await conn.getTransaction(s.signature, { commitment: "confirmed", maxSupportedTransactionVersion: 0 });
      const logs = tx?.meta?.logMessages ?? [];
      const ts = tx?.blockTime ?? s.blockTime ?? 0;
      for (const l of logs) {
        if (!l.startsWith("Program data: ")) continue;
        try {
          const ev: any = (program.coder as any).events.decode(l.slice(14));
          if (ev?.name === "orderFilled" && ev.data?.optionMint?.toBase58?.() === optionMint) {
            out.push({
              time: Number(ev.data.ts) || ts,
              price: Number(ev.data.pricePerContract) / 1_000_000,
              qty: Number(ev.data.fillQuantity ?? 0),
            });
          }
        } catch { /* not an anchor event line */ }
      }
    }
  } catch { /* RPC hiccup — return whatever we gathered */ }
  return out.sort((a, b) => a.time - b.time);
}

/**
 * BS-2002 mark fallback (T8): reprice the option along the underlying candles to
 * produce a synthetic contract OHLC series. carry r=0 + asset smile, matching the
 * cheap display mark. Never empty when underlying candles exist.
 */
export function synthesizeContractCandles(
  underlying: Candle[],
  opts: { strike: number; optionType: "call" | "put"; expiryUnix: number; asset: string },
): Candle[] {
  const baseVol = getDefaultVolatility(opts.asset);
  const priceAt = (spot: number, atTime: number): number => {
    if (spot <= 0) return 0;
    const days = Math.max(0.5, (opts.expiryUnix - atTime) / 86_400);
    const vol = applyVolSmile(baseVol, spot, opts.strike, opts.asset);
    return opts.optionType === "call"
      ? calculateCallPremium(spot, opts.strike, days, vol, 0, undefined, opts.asset)
      : calculatePutPremium(spot, opts.strike, days, vol, 0, undefined, opts.asset);
  };
  return underlying.map((c) => {
    const o = priceAt(c.open, c.time);
    const cl = priceAt(c.close, c.time);
    // For a call, premium rises with spot (high↔high); for a put it inverts.
    const pHigh = priceAt(c.high, c.time);
    const pLow = priceAt(c.low, c.time);
    const vals = [o, cl, pHigh, pLow];
    return { time: c.time, open: o, close: cl, high: Math.max(...vals), low: Math.min(...vals) };
  });
}
