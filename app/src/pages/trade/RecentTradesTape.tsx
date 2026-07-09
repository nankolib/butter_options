import type { FC } from "react";
import { useEffect, useState } from "react";
import { useProgram } from "../../hooks/useProgram";
import { fetchRecentTrades, type TapeTrade } from "./tradeHistory";

/**
 * RecentTradesTape — market fills for the focused contract (design lock
 * 2026-07-09). Bounded, best-effort scan of the option-mint's recent
 * `orderFilled` events (tradeHistory.fetchRecentTrades); no indexer exists, so
 * thin devnet books legitimately show an honest "no recent trades" line rather
 * than a fabricated tape. Side-colored, mono-plex, right-aligned numerics.
 */
export const RecentTradesTape: FC<{ optionMint: string | null }> = ({ optionMint }) => {
  const { program } = useProgram();
  const [trades, setTrades] = useState<TapeTrade[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let live = true;
    setTrades([]);
    if (!program || !optionMint) return;
    setLoading(true);
    (async () => {
      try {
        const t = await fetchRecentTrades(program as any, optionMint, 24);
        if (live) setTrades(t);
      } catch {
        if (live) setTrades([]);
      } finally {
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; };
  }, [program, optionMint]);

  return (
    <div className="text-l-text">
      <div className="mb-[10px] font-mono-plex text-[9px] uppercase tracking-[0.14em] text-l-muted">Recent trades</div>
      {loading ? (
        <div className="space-y-[6px]">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-[16px] animate-l-pulse rounded-[3px] bg-l-surface" />
          ))}
        </div>
      ) : trades.length === 0 ? (
        <div className="py-3 font-mono-plex text-[11px] text-l-muted">No recent trades</div>
      ) : (
        <div className="overflow-hidden rounded-[10px] border border-l-hair">
          <div
            className="grid h-[26px] items-center border-b border-l-hair bg-l-surface"
            style={{ gridTemplateColumns: "60px 1fr 1fr" }}
          >
            <span className="px-3 font-mono-plex text-[9px] uppercase tracking-[0.1em] text-l-muted">Side</span>
            <span className="px-3 text-right font-mono-plex text-[9px] uppercase tracking-[0.1em] text-l-muted">Price</span>
            <span className="px-3 text-right font-mono-plex text-[9px] uppercase tracking-[0.1em] text-l-muted">Qty · time</span>
          </div>
          {trades.map((t) => {
            const color = t.side === "buy" ? "var(--color-l-up)" : t.side === "sell" ? "var(--color-l-down)" : "var(--color-l-muted)";
            return (
              <div
                key={t.sig + t.ts}
                className="grid h-[28px] items-center border-b border-l-hair last:border-0"
                style={{ gridTemplateColumns: "60px 1fr 1fr" }}
              >
                <span className="flex items-center gap-[6px] px-3">
                  <span className="h-[5px] w-[5px] flex-none rounded-full" style={{ background: color }} />
                  <span className="font-mono-plex text-[9.5px] uppercase tracking-[0.1em]" style={{ color }}>
                    {t.side === "buy" ? "Buy" : t.side === "sell" ? "Sell" : "—"}
                  </span>
                </span>
                <span className="px-3 text-right font-mono-plex text-[12px] tabular-nums text-l-text">
                  ${t.price.toFixed(t.price < 100 ? 4 : 2)}
                </span>
                <span className="px-3 text-right font-mono-plex text-[11px] tabular-nums text-l-muted">
                  ×{t.qty} · {relTime(t.ts)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

function relTime(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export default RecentTradesTape;
