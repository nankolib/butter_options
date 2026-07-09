import type { FC } from "react";
import { useEffect, useMemo, useState } from "react";
import { useProgram } from "../../hooks/useProgram";
import { fetchContractFills, type ContractFill } from "../../utils/chartData";
import { calculateCallPremium, calculatePutPremium, getDefaultVolatility, applyVolSmile } from "../../utils/blackScholes";
import { TradingViewWidget, tvSymbol } from "./TradingViewWidget";
import type { UnifiedChainRow } from "../../hooks/useUnifiedChain";

// ============================================================================
// ⛔ DO NOT swap the UNDERLYING chart to lightweight-charts / a client-side OHLC
//    API (CoinGecko et al.). This decision has now been made TWICE — the first
//    revert is documented in git history; the second was a design-lock ruling by
//    the founder on 2026-07-09 after an agent re-litigated it during a "reskin".
//
//    UNDERLYING = TradingView Advanced Real-Time Chart embed. Non-negotiable:
//      1. COVERAGE  — TradingView charts EVERY Opta asset class (equities,
//         commodities, FX, crypto) from real exchange feeds via tvSymbol().
//         A crypto-only OHLC API leaves AAPL / XAU / TSLA / … permanently blank.
//      2. RELIABILITY — lightweight-charts "failed to render reliably on this
//         terminal layout" (the prior revert's own words). TradingView is the
//         validated choice for this layout.
//      3. RATE LIMITS — a free client-side OHLC API 429s on a shared preview /
//         prod domain. Unacceptable for a live trading surface.
//
//    CONTRACT = the real on-chain OrderFilled tape (fetchContractFills), rendered
//    as a fills table. NEVER synthesize candles from spot or a model.
//
//    If a task says "reskin the chart," reskin the CHROME (header, toggles, tape)
//    — do NOT re-architect the data source or the rendering engine.
// ============================================================================

/**
 * PriceChart — Trade terminal chart pane (terminal redesign, design lock
 * 2026-07-09). Terminal-skinned chrome (`-l-` tokens, mono-plex, hairlines) over:
 *   UNDERLYING → theme-aware TradingView embed (all asset classes, real feeds).
 *   CONTRACT   → on-chain OrderFilled fills tape (honest-empty when unsettled).
 */
const MODE_KEY = "opta.trade.chart.mode";
type Mode = "underlying" | "contract";

const fmt = (n: number) => {
  let s = n.toFixed(Math.abs(n) < 100 ? 4 : 2);
  if (/^-0(?:\.0+)?$/.test(s)) s = s.slice(1); // never negative-zero
  return `$${s}`;
};

/** Current app surface mode (data-mode on <html>); defaults dark for /trade. */
function readMode(): "light" | "dark" {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.getAttribute("data-mode") === "light" ? "light" : "dark";
}

export const PriceChart: FC<{ row: UnifiedChainRow | null; spot: number | null }> = ({ row, spot }) => {
  const { program } = useProgram();
  const [mode, setMode] = useState<Mode>(() =>
    (typeof localStorage !== "undefined" && localStorage.getItem(MODE_KEY) === "contract") ? "contract" : "underlying",
  );
  useEffect(() => { try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ } }, [mode]);

  // Theme-follow: the TradingView embed re-injects when data-mode flips.
  const [theme, setTheme] = useState<"light" | "dark">(readMode);
  useEffect(() => {
    const obs = new MutationObserver(() => setTheme(readMode()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });
    return () => obs.disconnect();
  }, []);

  const [fills, setFills] = useState<ContractFill[]>([]);
  const [fillsLoading, setFillsLoading] = useState(false);

  // Cheap BS mark + breakeven (carry r=0), for the readouts.
  const { mark, breakeven } = useMemo(() => {
    if (!row || !spot || spot <= 0) return { mark: null as number | null, breakeven: null as number | null };
    const d = Math.max(0, (row.expiry - Date.now() / 1000) / 86_400);
    if (d <= 0) return { mark: null, breakeven: null };
    const vol = applyVolSmile(getDefaultVolatility(row.asset), spot, row.strike, row.asset);
    const m = row.optionType === "call"
      ? calculateCallPremium(spot, row.strike, d, vol, 0, undefined, row.asset)
      : calculatePutPremium(spot, row.strike, d, vol, 0, undefined, row.asset);
    return { mark: m, breakeven: row.optionType === "call" ? row.strike + m : row.strike - m };
  }, [row?.strike, row?.optionType, row?.expiry, row?.asset, spot]);

  // Contract fills tape (CONTRACT mode only).
  useEffect(() => {
    let live = true;
    if (mode !== "contract" || !row?.optionMint || !program) { setFills([]); return; }
    setFillsLoading(true);
    (async () => {
      const f = await fetchContractFills(program, row.optionMint!, 50);
      if (live) { setFills(f); setFillsLoading(false); }
    })();
    return () => { live = false; };
  }, [mode, row?.optionMint, program]);

  if (!row) {
    return (
      <div className="flex h-full min-h-0 flex-col items-center justify-center rounded-[10px] border border-l-hair bg-l-bg p-16 text-center">
        <p className="m-0 font-mono-plex text-[13px] text-l-text">Select a contract</p>
        <p className="m-0 mt-2 font-mono-plex text-[10px] uppercase tracking-[0.2em] text-l-muted">click a strike in the grid to chart it</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-[10px] border border-l-hair bg-l-bg text-l-text">
      {/* Header */}
      <div className="flex flex-none flex-wrap items-center gap-x-4 gap-y-2 border-b border-l-hair px-4 py-[10px]">
        <div className="flex items-center gap-[7px]">
          <span
            className="h-[6px] w-[6px] flex-none rounded-full"
            style={{ background: row.optionType === "call" ? "var(--color-l-up)" : "var(--color-l-down)" }}
          />
          <span className="font-mono-plex text-[11px] uppercase tracking-[0.14em] text-l-text">
            {row.asset} ${row.strike} {row.optionType}
          </span>
        </div>

        {/* Underlying | Contract toggle */}
        <div className="flex gap-[2px]">
          {(["underlying", "contract"] as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`rounded-[6px] border px-[10px] py-[4px] font-mono-plex text-[10px] uppercase tracking-[0.14em] transition-colors ${
                mode === m ? "border-l-text bg-l-surface text-l-text" : "border-l-hair text-l-muted hover:text-l-text"
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        <div className="ml-auto flex items-center gap-4">
          {mode === "contract" && (
            <span className="font-mono-plex text-[11px] tabular-nums text-l-muted">
              mark <span className="text-l-text">{mark != null ? fmt(mark) : "—"}</span>
            </span>
          )}
          <span className="font-mono-plex text-[10.5px] tabular-nums text-l-muted">
            strike <span className="text-l-text">${row.strike}</span>
            {breakeven != null && <> · BE <span className="text-l-text">{fmt(breakeven)}</span></>}
            {spot != null && <> · spot <span className="text-l-text">{fmt(spot)}</span></>}
          </span>
        </div>
      </div>

      {/* Body */}
      {mode === "underlying" ? (
        // Underlying real-time chart — all asset classes, real exchange feeds.
        // Re-keyed on theme so the embed re-themes with the surface mode.
        <div className="relative flex-1 min-h-0 p-3" style={{ minHeight: 340 }}>
          <TradingViewWidget key={theme} symbol={tvSymbol(row.asset)} theme={theme} height="100%" minHeight={320} />
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto p-4" style={{ minHeight: 340 }}>
          <div className="mb-3 flex items-baseline justify-between">
            <span className="font-mono-plex text-[9px] uppercase tracking-[0.2em] text-l-muted">Recent trades</span>
            <span className="font-mono-plex text-[10px] text-l-faint">on-chain tape · {fills.length}</span>
          </div>
          {fillsLoading ? (
            <p className="py-6 text-center font-mono-plex text-[11px] text-l-muted">Loading tape…</p>
          ) : fills.length === 0 ? (
            <p className="py-6 text-center font-mono-plex text-[11px] text-l-muted">No fills yet — this contract hasn't traded.</p>
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-l-hair">
                  <th className="py-2 text-left font-mono-plex text-[9px] uppercase tracking-[0.14em] text-l-muted">Price</th>
                  <th className="py-2 text-right font-mono-plex text-[9px] uppercase tracking-[0.14em] text-l-muted">Size</th>
                  <th className="py-2 text-right font-mono-plex text-[9px] uppercase tracking-[0.14em] text-l-muted">Time (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {[...fills].reverse().map((f, i) => (
                  <tr key={i} className="border-b border-l-hair">
                    <td className="py-[6px] text-left font-mono-plex text-[12px] tabular-nums text-l-text">{fmt(f.price)}</td>
                    <td className="py-[6px] text-right font-mono-plex text-[12px] tabular-nums text-l-text">{f.qty}</td>
                    <td className="py-[6px] text-right font-mono-plex text-[11px] tabular-nums text-l-muted">
                      {f.time ? new Date(f.time * 1000).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="mt-3 font-mono-plex text-[9px] text-l-faint">
            Contract price history — real on-chain fills only ({fills.length}). Candle history is deferred (devnet tape is sparse).
          </p>
        </div>
      )}
    </div>
  );
};

export default PriceChart;
