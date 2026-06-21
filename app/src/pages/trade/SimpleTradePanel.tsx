import type { FC } from "react";
import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { usePegFill } from "../../hooks/useOrderFlows";
import { calculateCallGreeks, calculatePutGreeks, getDefaultVolatility, applyVolSmile } from "../../utils/blackScholes";
import { fetchUnderlyingCandles } from "../../utils/chartData";
import { TradingViewWidget } from "./TradingViewWidget";
import type { UnifiedChainRow } from "../../hooks/useUnifiedChain";

/**
 * SimpleTradePanel — the Simple persona (perps/meme one-tap mode, §5b).
 *
 * Chart-first: TradingView underlying widget + Up/Down direction + USDC amount +
 * expiry chips + auto-strike (no strike picking) + a plain-English outcome card.
 * Buys route through the SAME peg write path (usePegFill) — Simple always takes
 * the protocol peg (the natural one-tap counterparty), leaving the P2P book to Pro.
 */
const TV_SYMBOL: Record<string, string> = { BTC: "BINANCE:BTCUSDT", ETH: "BINANCE:ETHUSDT", SOL: "BINANCE:SOLUSDT" };
const tvSymbol = (asset: string) => TV_SYMBOL[asset.toUpperCase()] ?? `BINANCE:${asset.toUpperCase()}USDT`;
const PRESETS = [10, 50, 100];

export const SimpleTradePanel: FC<{
  asset: string;
  spot: number | null;
  rows: UnifiedChainRow[];               // all unified rows (any expiry) for the asset
  expiries: number[];
  selectedExpiry: number;
  setSelectedExpiry: (e: number) => void;
  onDone: () => void;
}> = ({ asset, spot, rows, expiries, selectedExpiry, setSelectedExpiry, onDone }) => {
  const { publicKey } = useWallet();
  const peg = usePegFill();
  const [direction, setDirection] = useState<"up" | "down">("up");
  const [amount, setAmount] = useState(50);
  const [pct24h, setPct24h] = useState<number | null>(null);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  const day = (ts: number) => Math.floor(ts / 86_400);

  // 24h change from a 1-day CoinGecko OHLC (best-effort).
  useEffect(() => {
    let live = true;
    setPct24h(null);
    (async () => {
      const c = await fetchUnderlyingCandles(asset, 1);
      if (live && c.length) setPct24h(((c[c.length - 1].close - c[0].open) / c[0].open) * 100);
    })();
    return () => { live = false; };
  }, [asset]);

  // Auto-strike: the ATM-closest SERIES for asset+direction+expiry.
  const auto = useMemo(() => {
    const want = direction === "up" ? "call" : "put";
    const cands = rows.filter(
      (r) => r.provenance === "series" && r.optionType === want && day(r.expiry) === day(selectedExpiry),
    );
    if (!cands.length || !spot) return cands[0] ?? null;
    return [...cands].sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0];
  }, [rows, direction, selectedExpiry, spot]);

  // Instant cheap FE BS preview (carry r=0) — no on-chain quote in Simple.
  const preview = useMemo(() => {
    if (!auto || !spot || spot <= 0) return null;
    const days = Math.max(0, (auto.expiry - Date.now() / 1000) / 86_400);
    if (days <= 0) return null;
    const vol = applyVolSmile(getDefaultVolatility(asset), spot, auto.strike, asset);
    const g = direction === "up"
      ? calculateCallGreeks(spot, auto.strike, days, vol, 0)
      : calculatePutGreeks(spot, auto.strike, days, vol, 0);
    if (g.premium <= 0) return null;
    const qty = Math.max(1, Math.floor(amount / g.premium));
    const cost = qty * g.premium;
    const breakeven = direction === "up" ? auto.strike + g.premium : auto.strike - g.premium;
    const leverage = (Math.abs(g.delta) * spot) / g.premium;
    return { premium: g.premium, qty, cost, breakeven, leverage };
  }, [auto, spot, amount, direction, asset]);

  async function buy() {
    setStatus(null);
    if (!publicKey) { setStatus({ kind: "err", msg: "Connect a wallet" }); return; }
    if (!auto || !auto.optionMint || !preview) return;
    try {
      const sig = await peg.submit(
        { asset, vault: auto.vault, optionMint: auto.optionMint },
        preview.qty,
        preview.premium * 1.15, // 15% peg cushion
      );
      if (sig) { setStatus({ kind: "ok", msg: `Bought ${preview.qty} · ${sig.slice(0, 8)}…` }); onDone(); }
    } catch (e: any) {
      setStatus({ kind: "err", msg: (e?.message ?? String(e)).slice(0, 140) });
    }
  }

  const expiryLabel = (e: number) => new Date(e * 1000).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });

  return (
    <div className="grid lg:grid-cols-[1fr_380px] gap-8 items-start mt-4">
      {/* Chart + asset header */}
      <div>
        <div className="flex items-baseline gap-4 mb-3">
          <div className="font-fraunces-text italic font-light text-ink text-[28px]">{asset}</div>
          <div className="font-mono text-[18px] text-ink">{spot != null ? `$${spot.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : "—"}</div>
          {pct24h != null && (
            <div className={`font-mono text-[13px] ${pct24h >= 0 ? "text-teal" : "text-crimson"}`}>
              {pct24h >= 0 ? "+" : ""}{pct24h.toFixed(2)}% 24h
            </div>
          )}
        </div>
        <TradingViewWidget symbol={tvSymbol(asset)} />
      </div>

      {/* Ticket */}
      <div className="border border-rule rounded-md p-5 bg-paper">
        {/* Direction */}
        <div className="grid grid-cols-2 gap-3 mb-4">
          <button type="button" onClick={() => setDirection("up")}
            className={`rounded-md py-4 font-mono text-[13px] uppercase tracking-[0.18em] transition-colors border ${
              direction === "up" ? "bg-teal text-paper border-teal" : "bg-paper text-ink-muted border-rule hover:text-ink"
            }`}>↑ Up · Call</button>
          <button type="button" onClick={() => setDirection("down")}
            className={`rounded-md py-4 font-mono text-[13px] uppercase tracking-[0.18em] transition-colors border ${
              direction === "down" ? "bg-crimson text-paper border-crimson" : "bg-paper text-ink-muted border-rule hover:text-ink"
            }`}>↓ Down · Put</button>
        </div>

        {/* Amount */}
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted mb-1.5">Amount (USDC)</div>
        <input type="number" min={1} value={amount} onChange={(e) => setAmount(Math.max(1, Number(e.target.value) || 1))}
          className="w-full bg-transparent border border-rule rounded px-3 py-2 font-mono text-[15px] text-ink outline-none focus:border-ink mb-2" />
        <div className="flex gap-2 mb-4">
          {PRESETS.map((p) => (
            <button key={p} type="button" onClick={() => setAmount(p)}
              className="flex-1 font-mono text-[11px] border border-rule rounded py-1.5 text-ink-muted hover:text-ink hover:bg-paper-2 transition-colors">${p}</button>
          ))}
          <button type="button" disabled title="Max = wallet balance (Pass 6)"
            className="flex-1 font-mono text-[11px] border border-rule rounded py-1.5 text-ink-muted/40 cursor-not-allowed">Max</button>
        </div>

        {/* Expiry chips */}
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted mb-1.5">Expiry</div>
        <div className="flex flex-wrap gap-2 mb-4">
          {expiries.map((e) => (
            <button key={e} type="button" onClick={() => setSelectedExpiry(e)}
              className={`font-mono text-[11px] rounded px-3 py-1.5 border transition-colors ${
                day(e) === day(selectedExpiry) ? "bg-ink text-paper border-ink" : "bg-paper text-ink-muted border-rule hover:text-ink"
              }`}>{expiryLabel(e)}</button>
          ))}
        </div>

        {/* Auto-strike (soft) */}
        {auto ? (
          <div className="font-mono text-[11px] text-ink-muted mb-4">
            Strike <span className="text-ink">${auto.strike}</span> · expires {expiryLabel(auto.expiry)}
          </div>
        ) : (
          <div className="font-mono text-[11px] text-crimson mb-4">No {direction === "up" ? "call" : "put"} market yet at this expiry.</div>
        )}

        {/* Outcome card */}
        {auto && preview && (
          <div className="border border-rule rounded-md p-4 mb-4 bg-paper-2/40">
            <div className="font-sans text-[13px] text-ink leading-snug mb-2">
              Can't be liquidated — <span className="text-ink">max loss = ${preview.cost.toFixed(2)}</span> ({preview.qty} contract{preview.qty > 1 ? "s" : ""}).
            </div>
            <div className="font-mono text-[11px] text-ink-muted">
              Profit if {asset} {direction === "up" ? "≥" : "≤"} ${preview.breakeven.toFixed(2)} at expiry
            </div>
            <div className="font-mono text-[11px] text-ink-muted mt-1">≈{preview.leverage.toFixed(1)}× leverage</div>
          </div>
        )}

        {/* Buy */}
        <button type="button" onClick={buy}
          disabled={!publicKey || !auto || !preview || peg.submitting}
          className={`w-full font-mono text-[13px] uppercase tracking-[0.2em] rounded-md py-4 transition-colors ${
            !publicKey || !auto || !preview || peg.submitting ? "bg-paper-2 text-ink-muted cursor-not-allowed"
              : direction === "up" ? "bg-teal text-paper hover:opacity-90" : "bg-crimson text-paper hover:opacity-90"
          }`}>
          {!publicKey ? "Connect wallet"
            : !auto ? "No market"
            : peg.submitting ? "Buying…"
            : `Buy ${direction === "up" ? "Up" : "Down"} · $${preview?.cost.toFixed(2) ?? amount}`}
        </button>

        {status && <p className={`font-mono text-[10.5px] mt-3 ${status.kind === "ok" ? "text-ink" : "text-crimson"}`}>{status.msg}</p>}
      </div>
    </div>
  );
};
