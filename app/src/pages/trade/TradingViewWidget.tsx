import type { FC } from "react";
import { useEffect, useRef } from "react";

/**
 * TradingViewWidget — free Advanced Real-Time Chart embed (Simple persona, T3).
 * No account/login. Injects the official embed script with a JSON config.
 *
 * Sizing (Pass 7): the embed honours `autosize:true` ONLY when its container has
 * a DEFINITE height. We give the outer container an explicit height/minHeight and
 * force the injected iframe to fill it (index.css `.tradingview-widget-container
 * iframe { height:100%!important }`). Pass a large height so the chart dominates.
 *
 * CSP: s3.tradingview.com (script) + *.tradingview.com (frame/connect) are
 * allow-listed in vercel.json. Client-only (uses document in an effect).
 */
export const TradingViewWidget: FC<{ symbol: string; height?: number | string; minHeight?: number }> = ({
  symbol, height = 600, minHeight = 560,
}) => {
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
      style={{ height: typeof height === "number" ? `${height}px` : height, minHeight, width: "100%" }}
    />
  );
};
