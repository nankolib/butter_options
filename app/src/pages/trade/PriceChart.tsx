import type { FC } from "react";
import { useEffect, useMemo, useState } from "react";
import { useProgram } from "../../hooks/useProgram";
import { fetchContractFills, type ContractFill } from "../../utils/chartData";
import { calculateCallPremium, calculatePutPremium, getDefaultVolatility, applyVolSmile } from "../../utils/blackScholes";
import { TradingViewWidget, tvSymbol } from "./TradingViewWidget";
import type { UnifiedChainRow } from "../../hooks/useUnifiedChain";

/**
 * PriceChart — Pro chart pane (Pass 12 pivot).
 *
 * lightweight-charts failed to render reliably on this terminal layout across
 * three fixes (zero-height under the Pass-8 grid). We pivot to the proven
 * TradingView widget (the same one Simple uses) for the UNDERLYING chart, and
 * DEFER the contract candle chart (sparse on devnet) to a "recent trades" readout
 * from the OrderFilled tape. No lightweight-charts here anymore.
 *
 *   UNDERLYING → TradingView Advanced Real-Time Chart + strike/BE/spot text.
 *   CONTRACT   → recent-fills list + current mark + strike/BE (no candle chart).
 */
const MODE_KEY = "opta.trade.chart.mode";
type Mode = "underlying" | "contract";
const fmt = (n: number) => `$${n.toFixed(n < 100 ? 4 : 2)}`;

export const PriceChart: FC<{ row: UnifiedChainRow | null; spot: number | null }> = ({ row, spot }) => {
  const { program } = useProgram();
  const [mode, setMode] = useState<Mode>(() =>
    (typeof localStorage !== "undefined" && localStorage.getItem(MODE_KEY) === "contract") ? "contract" : "underlying",
  );
  useEffect(() => { try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ } }, [mode]);

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

  // Load the contract tape only in CONTRACT mode.
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
      <div className="border border-rule rounded-md p-16 text-center my-2">
        <p className="font-fraunces-text italic font-light text-ink text-[20px] m-0">Select a contract</p>
        <p className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-ink-muted mt-2 m-0">click a strike in GRID to chart it</p>
      </div>
    );
  }

  const readout = (
    <span className="font-mono text-[10.5px] text-ink-muted">
      strike <span className="text-ink">${row.strike}</span>
      {breakeven != null && <> · BE <span className="text-ink">{fmt(breakeven)}</span></>}
      {spot != null && <> · spot <span className="text-ink">{fmt(spot)}</span></>}
    </span>
  );

  return (
    // Fills the (stretched) grid cell so the chart window grows to the band height
    // (= the ticket panel's height). header (fixed) + chart window (flex-1).
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap shrink-0">
        <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-muted">
          {row.asset} ${row.strike} {row.optionType}
        </div>
        <div className="flex items-center gap-3">
          {readout}
          <div className="flex gap-px bg-rule border border-rule rounded-md overflow-hidden">
            {(["underlying", "contract"] as Mode[]).map((m) => (
              <button key={m} type="button" onClick={() => setMode(m)}
                className={`font-mono text-[10px] uppercase tracking-[0.18em] px-4 py-2 transition-colors ${
                  mode === m ? "bg-ink text-paper" : "bg-paper text-ink-muted hover:text-ink"
                }`}>
                {m}
              </button>
            ))}
          </div>
        </div>
      </div>

      {mode === "underlying" ? (
        <div className="flex-1 min-h-0">
          <TradingViewWidget symbol={tvSymbol(row.asset)} height="100%" minHeight={420} />
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto border border-rule rounded-md p-5" style={{ minHeight: 420 }}>
          <div className="flex items-baseline justify-between mb-3">
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-muted">Recent trades</div>
            <div className="font-mono text-[11px] text-ink-muted">mark <span className="text-ink">{mark != null ? fmt(mark) : "—"}</span></div>
          </div>
          {fillsLoading ? (
            <p className="font-mono text-[11px] text-ink-muted py-6 text-center">Loading tape…</p>
          ) : fills.length === 0 ? (
            <p className="font-mono text-[11px] text-ink-muted py-6 text-center">No fills yet — this contract hasn't traded.</p>
          ) : (
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-rule text-ink-muted">
                  <th className="text-left font-mono text-[9.5px] uppercase tracking-[0.18em] py-2">Price</th>
                  <th className="text-right font-mono text-[9.5px] uppercase tracking-[0.18em] py-2">Size</th>
                  <th className="text-right font-mono text-[9.5px] uppercase tracking-[0.18em] py-2">Time (UTC)</th>
                </tr>
              </thead>
              <tbody>
                {[...fills].reverse().map((f, i) => (
                  <tr key={i} className="border-b border-rule-soft">
                    <td className="text-left font-mono text-[12px] text-crimson py-1.5">{fmt(f.price)}</td>
                    <td className="text-right font-mono text-[12px] text-ink py-1.5">{f.qty}</td>
                    <td className="text-right font-mono text-[11px] text-ink-muted py-1.5">
                      {f.time ? new Date(f.time * 1000).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <p className="font-mono text-[9.5px] text-ink-muted/70 mt-3">
            Contract price history — fills shown ({fills.length}). Full candle chart with volume is parked (devnet tape is sparse).
          </p>
        </div>
      )}
    </div>
  );
};
