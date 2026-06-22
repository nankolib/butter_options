import type { FC } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart, CandlestickSeries, LineSeries, createSeriesMarkers, ColorType,
  type IChartApi, type ISeriesApi, type IPriceLine, type UTCTimestamp,
} from "lightweight-charts";
import { useProgram } from "../../hooks/useProgram";
import {
  fetchUnderlyingCandles, fetchContractFills, synthesizeContractCandles,
  coingeckoId, CONTRACT_FILL_THRESHOLD, type Candle, type ContractFill,
} from "../../utils/chartData";
import { calculateCallPremium, calculatePutPremium, getDefaultVolatility, applyVolSmile } from "../../utils/blackScholes";
import type { UnifiedChainRow } from "../../hooks/useUnifiedChain";

/**
 * PriceChart — Pass 3. lightweight-charts candlesticks for the focused contract.
 *
 * CONTRACT ↔ UNDERLYING toggle (persona-sticky). UNDERLYING = CoinGecko spot OHLC
 * (crypto-only v1). CONTRACT = the option's own tape, or — when real fills are
 * thin (< CONTRACT_FILL_THRESHOLD), the default on devnet — a synthetic BS-mark
 * series repriced along the underlying candles (T8), so the pane is never blank.
 * Real fills are marked; the strike is drawn as a price line on CONTRACT.
 */
const MODE_KEY = "opta.trade.chart.mode";
type Mode = "underlying" | "contract";

export const PriceChart: FC<{ row: UnifiedChainRow | null; spot: number | null }> = ({ row, spot }) => {
  const { program } = useProgram();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick" | "Line"> | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);

  const [mode, setMode] = useState<Mode>(() =>
    (typeof localStorage !== "undefined" && localStorage.getItem(MODE_KEY) === "contract") ? "contract" : "underlying",
  );
  useEffect(() => { try { localStorage.setItem(MODE_KEY, mode); } catch { /* ignore */ } }, [mode]);

  const [candles, setCandles] = useState<Candle[]>([]);
  const [fills, setFills] = useState<ContractFill[]>([]);
  const [usedFallback, setUsedFallback] = useState(false);
  const [loading, setLoading] = useState(false);
  const [note, setNote] = useState<string>("");

  const cryptoSupported = useMemo(() => (row ? coingeckoId(row.asset) != null : false), [row]);

  // ---- Load data on row/mode change ----
  useEffect(() => {
    let live = true;
    if (!row) { setCandles([]); setFills([]); return; }
    setLoading(true); setNote("");
    (async () => {
      const underlying = await fetchUnderlyingCandles(row.asset, 30);
      if (!live) return;
      if (mode === "underlying") {
        setCandles(dedupe(underlying));
        setUsedFallback(false);
        if (!underlying.length) setNote(cryptoSupported ? "No candles returned." : "Underlying candles: crypto-only in v1.");
        setLoading(false);
        return;
      }
      // CONTRACT mode
      let realFills: ContractFill[] = [];
      if (row.optionMint && program) {
        realFills = await fetchContractFills(program, row.optionMint, 50);
      }
      if (!live) return;
      setFills(realFills);
      if (realFills.length >= CONTRACT_FILL_THRESHOLD) {
        setCandles(dedupe(bucketFills(realFills)));
        setUsedFallback(false);
        setNote(`Contract tape — ${realFills.length} fills.`);
      } else {
        // Fallback: synthesize from the underlying candles (T8).
        const synth = synthesizeContractCandles(underlying, {
          strike: row.strike, optionType: row.optionType, expiryUnix: row.expiry, asset: row.asset,
        });
        setCandles(dedupe(synth));
        setUsedFallback(true);
        setNote(`Synthetic BS mark (${realFills.length}/${CONTRACT_FILL_THRESHOLD} real fills) — repriced along spot.`);
      }
      setLoading(false);
    })();
    return () => { live = false; };
  }, [row?.vault, row?.optionType, row?.optionMint, mode, program]);

  // ---- Chart (created once) ----
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "#F1ECE2" }, textColor: "#504B41", fontFamily: "JetBrains Mono, monospace" },
      grid: { vertLines: { color: "#EAE3D5" }, horzLines: { color: "#EAE3D5" } },
      timeScale: { borderColor: "#D8CFBE" },
      rightPriceScale: { borderColor: "#D8CFBE" },
    });
    chartRef.current = chart;
    return () => { chart.remove(); chartRef.current = null; };
  }, []);

  // ---- Series per mode: candlesticks for UNDERLYING, a continuous LINE for the
  // CONTRACT mark (Pass-8 D: one mark line + fill dots, not scattered bars). ----
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const series = mode === "contract"
      ? chart.addSeries(LineSeries, { color: "#37332D", lineWidth: 2, priceLineVisible: false, lastValueVisible: true })
      : chart.addSeries(CandlestickSeries, { upColor: "#37332D", downColor: "#D7263D", borderVisible: false, wickUpColor: "#37332D", wickDownColor: "#D7263D" });
    seriesRef.current = series;
    priceLinesRef.current = [];
    return () => { chart.removeSeries(series); seriesRef.current = null; };
  }, [mode]);

  // Strike + breakeven are SPOT levels → they belong on the UNDERLYING chart
  // (spot Y-axis), not the CONTRACT chart (premium Y-axis, ~$6 — strike $75 would
  // be off-scale). BE = strike ± the cheap-BS premium.
  const overlay = useMemo(() => {
    if (!row || !spot || spot <= 0) return null;
    const d = Math.max(0, (row.expiry - Date.now() / 1000) / 86_400);
    if (d <= 0) return { strike: row.strike, breakeven: null as number | null };
    const vol = applyVolSmile(getDefaultVolatility(row.asset), spot, row.strike, row.asset);
    const prem = row.optionType === "call"
      ? calculateCallPremium(spot, row.strike, d, vol, 0, undefined, row.asset)
      : calculatePutPremium(spot, row.strike, d, vol, 0, undefined, row.asset);
    const breakeven = row.optionType === "call" ? row.strike + prem : row.strike - prem;
    return { strike: row.strike, breakeven };
  }, [row?.strike, row?.optionType, row?.expiry, row?.asset, spot]);

  // ---- Push data + overlays ----
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    // Line series takes {time,value}; candlesticks take {time,o,h,l,c}.
    const data = mode === "contract"
      ? candles.map((c) => ({ time: c.time as UTCTimestamp, value: c.close }))
      : candles.map((c) => ({ ...c, time: c.time as UTCTimestamp }));
    (series as any).setData(data);
    chartRef.current?.timeScale().fitContent();

    // Clear prior price lines (setData keeps them; we recreate each push).
    for (const pl of priceLinesRef.current) series.removePriceLine(pl);
    priceLinesRef.current = [];

    // Strike + breakeven lines on the UNDERLYING (spot-axis) chart only.
    if (mode === "underlying" && overlay) {
      priceLinesRef.current.push(series.createPriceLine({
        price: overlay.strike, color: "#504B41", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "strike",
      }));
      if (overlay.breakeven != null) {
        priceLinesRef.current.push(series.createPriceLine({
          price: overlay.breakeven, color: "#0F766E", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "BE",
        }));
      }
    }
    // Real-fill markers (CONTRACT mode, when we have any).
    createSeriesMarkers(series, mode === "contract" && fills.length
      ? fills.map((f) => ({ time: f.time as UTCTimestamp, position: "belowBar" as const, color: "#D7263D", shape: "circle" as const, text: `${f.qty}` }))
      : []);
  }, [candles, fills, mode, overlay]);

  if (!row) {
    return (
      <div className="border border-rule rounded-md p-16 text-center my-2">
        <p className="font-fraunces-text italic font-light text-ink text-[20px] m-0">Select a contract</p>
        <p className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-ink-muted mt-2 m-0">click a strike in GRID to chart it</p>
      </div>
    );
  }

  return (
    <div className="my-2">
      <div className="flex items-center justify-between mb-3">
        <div className="font-mono text-[11px] uppercase tracking-[0.2em] text-ink-muted">
          {row.asset} ${row.strike} {row.optionType} · {note || (loading ? "loading…" : "")}
        </div>
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
      <div ref={containerRef} className="border border-rule rounded-md" style={{ height: 420 }} />
      {mode === "contract" && usedFallback && (
        <p className="font-mono text-[9.5px] text-ink-muted/70 mt-2">
          Synthetic mark — devnet trade history is thin. Real fills mark as dots; live tape takes over as volume grows.
        </p>
      )}
    </div>
  );
};

/** Bucket raw fills into OHLC candles (1h buckets). Used when real fills are dense. */
function bucketFills(fills: ContractFill[], bucketSec = 3600): Candle[] {
  const byBucket = new Map<number, number[]>();
  for (const f of fills) {
    const b = Math.floor(f.time / bucketSec) * bucketSec;
    if (!byBucket.has(b)) byBucket.set(b, []);
    byBucket.get(b)!.push(f.price);
  }
  return [...byBucket.entries()].sort((a, b) => a[0] - b[0]).map(([time, ps]) => ({
    time, open: ps[0], high: Math.max(...ps), low: Math.min(...ps), close: ps[ps.length - 1],
  }));
}

/** lightweight-charts requires strictly ascending, unique timestamps. */
function dedupe(candles: Candle[]): Candle[] {
  const m = new Map<number, Candle>();
  for (const c of candles) m.set(c.time, c);
  return [...m.values()].sort((a, b) => a.time - b.time);
}
