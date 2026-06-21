import type { FC } from "react";
import { useEffect, useRef } from "react";

/**
 * TradingViewWidget — free Advanced Real-Time Chart embed (Simple persona, T3).
 * No account/login. Injects the official embed script with a JSON config into a
 * container; rebuilds on symbol change. Client-only (uses document in an effect).
 *
 * CSP allow-listing for s3.tradingview.com / *.tradingview.com is deferred to
 * Pass 6 (flip day); behind TRADE_V2_UI the widget only loads in the dark build /
 * local dev, which isn't CSP-gated.
 */
export const TradingViewWidget: FC<{ symbol: string; height?: number }> = ({ symbol, height = 440 }) => {
  const ref = useRef<HTMLDivElement>(null);

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
      theme: "light",
      style: "1",
      locale: "en",
      hide_top_toolbar: false,
      hide_legend: false,
      allow_symbol_change: false,
      save_image: false,
      backgroundColor: "#F1ECE2",
    });
    host.appendChild(script);

    return () => { host.innerHTML = ""; };
  }, [symbol]);

  return (
    <div
      ref={ref}
      className="tradingview-widget-container border border-rule rounded-md overflow-hidden"
      style={{ height, width: "100%" }}
    />
  );
};
