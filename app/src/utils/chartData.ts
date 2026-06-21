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

/**
 * UNDERLYING spot OHLC from CoinGecko. Returns [] for non-crypto (deferred) or
 * on fetch failure (caller renders an empty-state, never throws).
 */
export async function fetchUnderlyingCandles(asset: string, days = 30): Promise<Candle[]> {
  const id = coingeckoId(asset);
  if (!id) return [];
  try {
    const res = await fetch(`https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=usd&days=${days}`);
    if (!res.ok) return [];
    const raw = (await res.json()) as [number, number, number, number, number][];
    return raw.map(([ms, o, h, l, c]) => ({ time: Math.floor(ms / 1000), open: o, high: h, low: l, close: c }));
  } catch {
    return [];
  }
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
