import type { FC } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createChart, CandlestickSeries, createSeriesMarkers, ColorType,
  type IChartApi, type ISeriesApi, type UTCTimestamp,
} from "lightweight-charts";
import { useProgram } from "../../hooks/useProgram";
import {
  fetchUnderlyingCandles, fetchContractFills, synthesizeContractCandles,
  coingeckoId, CONTRACT_FILL_THRESHOLD, type Candle, type ContractFill,
} from "../../utils/chartData";
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

export const PriceChart: FC<{ row: UnifiedChainRow | null; spot: number | null }> = ({ row }) => {
  const { program } = useProgram();
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

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

  // ---- Draw ----
  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "#F1ECE2" }, textColor: "#504B41", fontFamily: "JetBrains Mono, monospace" },
      grid: { vertLines: { color: "#EAE3D5" }, horzLines: { color: "#EAE3D5" } },
      timeScale: { borderColor: "#D8CFBE" },
      rightPriceScale: { borderColor: "#D8CFBE" },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#37332D", downColor: "#D7263D", borderVisible: false, wickUpColor: "#37332D", wickDownColor: "#D7263D",
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => { chart.remove(); chartRef.current = null; seriesRef.current = null; };
  }, []);

  // ---- Push data + overlays ----
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    series.setData(candles.map((c) => ({ ...c, time: c.time as UTCTimestamp })));
    chartRef.current?.timeScale().fitContent();

    // Strike line (CONTRACT mode only).
    if (mode === "contract" && row) {
      // setData replaces the series; re-create the strike line each push.
      series.createPriceLine({ price: row.strike, color: "#D7263D", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "K" });
    }
    // Real-fill markers (CONTRACT mode, when we have any).
    if (mode === "contract" && fills.length) {
      createSeriesMarkers(series, fills.map((f) => ({
        time: f.time as UTCTimestamp, position: "belowBar" as const, color: "#D7263D", shape: "circle" as const, text: `${f.qty}`,
      })));
    }
  }, [candles, fills, mode, row?.strike]);

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
