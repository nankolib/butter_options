// =============================================================================
// tvSymbol — Opta asset → TradingView symbol. PURE (no React, no DOM).
// =============================================================================
//
// Extracted from TradingViewWidget.tsx so it can be unit-tested, per the app's
// testing doctrine (no runner in app/; pure logic lives in pure modules and is
// covered by app/scripts/run-wave1-tests.mjs). TradingViewWidget re-exports
// `tvSymbol` so every existing import site is unchanged.
//
// ── WHY EVERY LISTED ASSET MUST BE IN THIS MAP ──────────────────────────────
// The fallback below is a Binance USDT pair. That is correct for a token and
// WRONG for anything else: `BINANCE:GOOGLUSDT` does not exist, so TradingView
// renders "This symbol doesn't exist" and the user sees a blank chart.
//
// The 2026-08-04 gap audit found 9 of 13 equities plus FARTCOIN blank for
// exactly this reason — the map had 4 equities and the board had 13. When a
// ticker is listed, add it here in the same change. The audit's verification
// method is the only one that proves a symbol: render it in a real TradingView
// embed and read the iframe body. Every symbol below was verified that way on
// 2026-08-04 against the live oracle spot (all within 1%).
//
// Traps found while verifying — do not "simplify" these back:
//   CRCL is NYSE, not NASDAQ.
//   SPCX is NASDAQ; AMEX:SPCX and OTC:SPCX are both invalid.
//   FARTCOIN is MEXC; BINANCE and BYBIT are both invalid.
// =============================================================================

const TV_SYMBOL: Record<string, string> = {
  // Crypto — exchange pairs.
  BTC: "BINANCE:BTCUSDT", ETH: "BINANCE:ETHUSDT", SOL: "BINANCE:SOLUSDT",
  XRP: "BINANCE:XRPUSDT", JUP: "BINANCE:JUPUSDT", JTO: "BINANCE:JTOUSDT",
  WIF: "BINANCE:WIFUSDT", BONK: "BINANCE:BONKUSDT",
  FARTCOIN: "MEXC:FARTCOINUSDT",

  // US equities — the full Switchboard equity board (13).
  AAPL: "NASDAQ:AAPL", MSFT: "NASDAQ:MSFT", NVDA: "NASDAQ:NVDA",
  TSLA: "NASDAQ:TSLA", MSTR: "NASDAQ:MSTR", GOOGL: "NASDAQ:GOOGL",
  AMZN: "NASDAQ:AMZN", AMD: "NASDAQ:AMD", COIN: "NASDAQ:COIN",
  META: "NASDAQ:META", HOOD: "NASDAQ:HOOD", SPCX: "NASDAQ:SPCX",
  CRCL: "NYSE:CRCL",

  // Metals + energy.
  XAU: "OANDA:XAUUSD", XAG: "OANDA:XAGUSD",
  WTI: "TVC:USOIL", BRENT: "TVC:UKOIL",
};

/**
 * Map an Opta display symbol to a TradingView symbol.
 *
 * Unknown tickers fall back to a Binance USDT pair — a deliberate guess that is
 * only ever right for crypto. Anything non-crypto MUST have an explicit entry
 * above; see the header.
 */
export const tvSymbol = (asset: string): string =>
  TV_SYMBOL[asset.toUpperCase()] ?? `BINANCE:${asset.toUpperCase()}USDT`;

/** True iff `asset` has an explicit mapping (i.e. is NOT relying on the
 *  crypto-shaped fallback). Used by the test gate to hold the board covered. */
export const hasExplicitTvSymbol = (asset: string): boolean =>
  Object.prototype.hasOwnProperty.call(TV_SYMBOL, asset.toUpperCase());
