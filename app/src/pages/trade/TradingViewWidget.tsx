import type { FC } from "react";
import { useEffect, useRef } from "react";

/**
 * Map an Opta asset to a TradingView symbol. Covers every asset class Opta lists
 * — crypto (Binance pairs), US equities (Nasdaq), metals + oil (OANDA/TVC) —
 * from real exchange feeds. Unknown tickers fall back to a Binance USDT pair.
 */
const TV_SYMBOL: Record<string, string> = {
  BTC: "BINANCE:BTCUSDT", ETH: "BINANCE:ETHUSDT", SOL: "BINANCE:SOLUSDT",
  AAPL: "NASDAQ:AAPL", TSLA: "NASDAQ:TSLA", NVDA: "NASDAQ:NVDA", MSFT: "NASDAQ:MSFT",
  XAU: "OANDA:XAUUSD", XAG: "OANDA:XAGUSD", WTI: "TVC:USOIL",
};
export const tvSymbol = (asset: string) => TV_SYMBOL[asset.toUpperCase()] ?? `BINANCE:${asset.toUpperCase()}USDT`;

/**
 * TradingViewWidget — free Advanced Real-Time Chart embed. No account/login;
 * injects the official embed script with a JSON config. Theme-aware so it matches
 * the terminal surface in both light and dark (re-injects on theme change).
 *
 * Sizing (Pass 7): the embed honours `autosize:true` ONLY when its container has
 * a DEFINITE height. We give the outer container an explicit height/minHeight and
 * force the injected iframe to fill it (index.css `.tradingview-widget-container
 * iframe { height:100%!important }`).
 *
 * CSP: s3.tradingview.com (script) + *.tradingview.com (frame/connect) are
 * allow-listed in vercel.json. Client-only (uses document in an effect).
 */
export const TradingViewWidget: FC<{
  symbol: string;
  height?: number | string;
  minHeight?: number;
  theme?: "light" | "dark";
  backgroundColor?: string;
}> = ({ symbol, height = 600, minHeight = 560, theme = "dark", backgroundColor }) => {
  const ref = useRef<HTMLDivElement>(null);
  const bg = backgroundColor ?? (theme === "dark" ? "#0C0C0A" : "#F1ECE2");

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    host.innerHTML = "";
    const widget = document.createElement("div");
    widget.className = "tradingview-widget-container__widget";
    widget.style.height = "100%";
    widget.style.width = "100%";
    host.appendChild(widget);

    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.type = "text/javascript";
    script.async = true;
    script.innerHTML = JSON.stringify({
      symbol,
      autosize: true,
      interval: "60",
      timezone: "Etc/UTC",
      theme,
      style: "1",
      locale: "en",
      hide_top_toolbar: false,
      hide_legend: false,
      allow_symbol_change: false,
      save_image: false,
      backgroundColor: bg,
    });
    host.appendChild(script);

    return () => { host.innerHTML = ""; };
  }, [symbol, theme, bg]);

  return (
    <div
      ref={ref}
      className="tradingview-widget-container overflow-hidden rounded-[10px] border border-l-hair"
      style={{ height: typeof height === "number" ? `${height}px` : height, minHeight, width: "100%" }}
    />
  );
};
