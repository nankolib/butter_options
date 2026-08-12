import type { FC, ReactNode } from "react";
import { Link } from "react-router-dom";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { calculateCallGreeks, calculatePutGreeks, getDefaultVolatility, applyVolSmile } from "../../utils/blackScholes";
import type { UnifiedChainRow } from "../../hooks/useUnifiedChain";
import { useBook } from "../../hooks/useBook";
import { bestRestingBidAsk, type BookOrder } from "../../utils/exchangeData";

/**
 * TradeChainV2 — the terminal options chain (design lock 2026-07-09).
 *
 * ONE fixed mirrored template, strike dead-center, identical mirrored widths:
 *   [IV Δ OI MARK ASK BID] · gutter · [STRIKE] · gutter · [BID ASK MARK OI Δ IV]
 * The left (calls) and right (puts) columns use symmetric minmax(min,1fr) widths
 * (each side's widths are the exact reverse of the other) and the two gutter
 * columns share one fixed width, so the columns BREATHE to fill the pane while
 * the strike column stays geometrically centered — both asserted by
 * check-trade-visibility.mjs. The grid fills its container (no max-width /
 * centering); it only scrolls when narrower than the summed minimums.
 *
 * Bid is teal, ask crimson; greeks/IV in --text-2. Cells flash their direction
 * colour for ~300ms when a price changes. A full-width SPOT marker row sits
 * between the two strikes that bracket live spot (pinned to the top/bottom edge
 * when spot is outside the listed range).
 *
 * Clicking either side loads that contract into the docked ticket (onSelect).
 * There is NO ⓘ column and NO details modal on Trade.
 */

export type FocusedContract = UnifiedChainRow;

interface GridRow {
  strike: number;
  call: UnifiedChainRow | null;
  put: UnifiedChainRow | null;
}

// Symmetric column minimums (px). Right side is the exact reverse; both gutters
// share GUT so the strike lands dead-center. Data columns are minmax(min,1fr) so
// they grow to fill the pane; the fr shares are symmetric → strike stays centered.
const W = { iv: 42, delta: 46, oi: 54, mark: 60, ask: 60, bid: 60 } as const;
const GUT = 16;
const STRIKE_W = 88;
const LEFT = [W.iv, W.delta, W.oi, W.mark, W.ask, W.bid];
const RIGHT = [W.bid, W.ask, W.mark, W.oi, W.delta, W.iv];
const col = (m: number) => `minmax(${m}px, 1fr)`;
const TEMPLATE = [...LEFT.map(col), `${GUT}px`, `${STRIKE_W}px`, `${GUT}px`, ...RIGHT.map(col)].join(" ");
const MIN_W = LEFT.reduce((a, b) => a + b, 0) * 2 + GUT * 2 + STRIKE_W;

/** $-formatter that never emits negative-zero ("$-0.0000" → "$0.0000"). */
const fmtPrice = (n: number): string => {
  const dp = Math.abs(n) < 100 ? 4 : 2;
  let s = n.toFixed(dp);
  if (/^-0(?:\.0+)?$/.test(s)) s = s.slice(1); // strip the sign off a rounded -0
  return `$${s}`;
};
const fmtStrike = (n: number): string =>
  n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(n);

interface SideMetrics { iv: number | null; delta: number | null; mark: number | null; }
function metrics(row: UnifiedChainRow, spot: number | null): SideMetrics {
  if (!spot || spot <= 0) return { iv: null, delta: null, mark: null };
  const days = Math.max(0, (row.expiry - Date.now() / 1000) / 86_400);
  if (days <= 0) return { iv: null, delta: null, mark: null };
  const vol = applyVolSmile(getDefaultVolatility(row.asset), spot, row.strike, row.asset);
  const g = row.optionType === "call"
    ? calculateCallGreeks(spot, row.strike, days, vol, 0)
    : calculatePutGreeks(spot, row.strike, days, vol, 0);
  return { iv: vol, delta: g.delta, mark: g.premium };
}

const sameContract = (a: FocusedContract | null, b: UnifiedChainRow | null): boolean =>
  !!a && !!b && a.vault === b.vault && a.optionType === b.optionType && a.strike === b.strike;

export const TradeChainV2: FC<{
  rows: UnifiedChainRow[];
  spot: number | null;
  atmStrike: number | null;
  focused: FocusedContract | null;
  onSelect: (c: FocusedContract) => void;
}> = ({ rows, spot, atmStrike, focused, onSelect }) => {
  const gridRows = useMemo<GridRow[]>(() => {
    const byStrike = new Map<number, GridRow>();
    for (const r of rows) {
      if (!byStrike.has(r.strike)) byStrike.set(r.strike, { strike: r.strike, call: null, put: null });
      const g = byStrike.get(r.strike)!;
      if (r.optionType === "call") g.call = r;
      else g.put = r;
    }
    return [...byStrike.values()].sort((a, b) => a.strike - b.strike);
  }, [rows]);

  // LIVE book (bus-subscribed + optimistic) — the bid/ask CELLS read best resting
  // prices from HERE, not the staler useUnifiedChain snapshot, so they always
  // match the book panel and update the instant an order posts/cancels.
  const { byOptionMint } = useBook();

  if (gridRows.length === 0) {
    return (
      <div className="rounded-[10px] border border-l-hair p-12 text-center">
        <p className="font-mono-plex text-[12px] text-l-muted">
          No contracts at this expiry.{" "}
          <Link to="/write" className="text-l-up-text no-underline hover:underline">
            Write one →
          </Link>
        </p>
      </div>
    );
  }

  // SPOT marker placement: between the two strikes bracketing live spot; pinned
  // to the top edge when spot ≤ lowest strike, bottom edge when spot ≥ highest.
  const strikes = gridRows.map((g) => g.strike);
  const lo = strikes[0], hi = strikes[strikes.length - 1];
  const pinTop = spot != null && spot <= lo;
  const pinBottom = spot != null && spot >= hi;
  let betweenIdx = -1;
  if (spot != null && !pinTop && !pinBottom) {
    for (let i = 0; i < gridRows.length - 1; i++) {
      if (strikes[i] < spot && spot <= strikes[i + 1]) { betweenIdx = i; break; }
    }
  }

  return (
    <div data-testid="trade-chain" className="overflow-x-auto">
      <div className="grid w-full" style={{ gridTemplateColumns: TEMPLATE, minWidth: MIN_W }}>
        {/* Header */}
        <HeaderCells labels={["IV", "Δ", "OI", "Mark", "Ask", "Bid"]} align="right" />
        <div data-testid="chain-gutter" className="h-[30px] border-b border-l-hair" />
        <div data-testid="chain-strike" className="flex h-[30px] items-center justify-center border-b border-l-hair">
          <span className="font-mono-plex text-[9px] uppercase tracking-[0.12em] text-l-muted">Strike</span>
        </div>
        <div data-testid="chain-gutter" className="h-[30px] border-b border-l-hair" />
        <HeaderCells labels={["Bid", "Ask", "Mark", "OI", "Δ", "IV"]} align="left" />

        {/* Body */}
        {pinTop && spot != null && <SpotMarker spot={spot} />}
        {gridRows.map((g, i) => (
          <Fragment key={g.strike}>
            <RowCells
              g={g}
              spot={spot}
              isAtm={atmStrike != null && g.strike === atmStrike}
              focused={focused}
              onSelect={onSelect}
              byOptionMint={byOptionMint}
            />
            {betweenIdx === i && spot != null && <SpotMarker spot={spot} />}
          </Fragment>
        ))}
        {pinBottom && spot != null && <SpotMarker spot={spot} />}
      </div>
    </div>
  );
};

/** Full-width hairline row with a centered "● SPOT <price>" pill (flashes on tick). */
const SpotMarker: FC<{ spot: number }> = ({ spot }) => (
  <div data-testid="spot-marker" style={{ gridColumn: "1 / -1" }} className="flex items-center justify-center border-b border-l-hair py-[3px]">
    <span className="inline-flex items-center gap-[6px] rounded-full border border-l-hair bg-l-bg px-[10px] py-[2px]">
      <span className="h-[5px] w-[5px] rounded-full" style={{ background: "var(--color-l-up)" }} />
      <span className="font-mono-plex text-[9.5px] uppercase tracking-[0.14em] text-l-muted">Spot</span>
      <FlashSpan value={spot} />
    </span>
  </div>
);

const HeaderCells: FC<{ labels: string[]; align: "left" | "right" }> = ({ labels, align }) => (
  <>
    {labels.map((l, i) => (
      <div
        key={i}
        className={`flex h-[30px] items-center border-b border-l-hair px-2 ${align === "right" ? "justify-end" : "justify-start"}`}
      >
        <span className="font-mono-plex text-[9px] uppercase tracking-[0.1em] text-l-muted">{l}</span>
      </div>
    ))}
  </>
);

const RowCells: FC<{
  g: GridRow;
  spot: number | null;
  isAtm: boolean;
  focused: FocusedContract | null;
  onSelect: (c: FocusedContract) => void;
  byOptionMint: Map<string, { bids: BookOrder[]; asks: BookOrder[] }>;
}> = ({ g, spot, isAtm, focused, onSelect, byOptionMint }) => {
  const cm = g.call ? metrics(g.call, spot) : null;
  const pm = g.put ? metrics(g.put, spot) : null;
  const callFocused = sameContract(focused, g.call);
  const putFocused = sameContract(focused, g.put);

  // Best resting bid/ask from the LIVE book (same source the panel + sweep read).
  const callBA = bestRestingBidAsk(byOptionMint, g.call?.optionMint ?? null);
  const putBA = bestRestingBidAsk(byOptionMint, g.put?.optionMint ?? null);

  const badge = provenanceBadge(g);
  const rowBg = "border-b border-l-hair";
  const selCall = g.call ? () => onSelect(g.call!) : undefined;
  const selPut = g.put ? () => onSelect(g.put!) : undefined;

  return (
    <>
      {/* Left side (calls): IV Δ OI MARK ASK BID — right-aligned toward the strike. */}
      <DataCell align="right" muted focused={callFocused} onClick={selCall}>{cm?.iv != null ? `${(cm.iv * 100).toFixed(0)}%` : "—"}</DataCell>
      <DataCell align="right" muted focused={callFocused} onClick={selCall}>{cm?.delta != null ? cm.delta.toFixed(2) : "—"}</DataCell>
      <DataCell align="right" muted focused={callFocused} onClick={selCall}>{g.call && g.call.oi > 0 ? g.call.oi.toLocaleString() : "—"}</DataCell>
      <FlashCell align="right" value={cm?.mark ?? null} focused={callFocused} onClick={selCall} />
      <FlashCell align="right" value={callBA.ask} tone="down" focused={callFocused} onClick={selCall} dataField="ask" dataMint={g.call?.optionMint} />
      <FlashCell align="right" value={callBA.bid} tone="up" focused={callFocused} onClick={selCall} dataField="bid" dataMint={g.call?.optionMint} />

      {/* gutter */}
      <div className={rowBg} />
      {/* strike */}
      <div className={`flex flex-col items-center justify-center ${rowBg} py-2`}>
        <span className="font-mono-plex text-[13px] tabular-nums text-l-text">{fmtStrike(g.strike)}</span>
        {badge && (
          <span
            className="mt-[2px] font-mono-plex text-[8px] uppercase tracking-[0.14em]"
            style={{ color: badge === "LEGACY" ? "var(--color-l-faint)" : badge === "EPOCH" ? "var(--color-l-muted)" : "var(--color-l-up)" }}
          >
            {badge}
          </span>
        )}
        {isAtm && (
          <span className="mt-[1px] font-mono-plex text-[8px] uppercase tracking-[0.16em]" style={{ color: "var(--color-l-up)" }}>ATM</span>
        )}
      </div>
      {/* gutter */}
      <div className={rowBg} />

      {/* Right side (puts): BID ASK MARK OI Δ IV — left-aligned mirror. */}
      <FlashCell align="left" value={putBA.bid} tone="up" focused={putFocused} onClick={selPut} dataField="bid" dataMint={g.put?.optionMint} />
      <FlashCell align="left" value={putBA.ask} tone="down" focused={putFocused} onClick={selPut} dataField="ask" dataMint={g.put?.optionMint} />
      <FlashCell align="left" value={pm?.mark ?? null} focused={putFocused} onClick={selPut} />
      <DataCell align="left" muted focused={putFocused} onClick={selPut}>{g.put && g.put.oi > 0 ? g.put.oi.toLocaleString() : "—"}</DataCell>
      <DataCell align="left" muted focused={putFocused} onClick={selPut}>{pm?.delta != null ? pm.delta.toFixed(2) : "—"}</DataCell>
      <DataCell align="left" muted focused={putFocused} onClick={selPut}>{pm?.iv != null ? `${(pm.iv * 100).toFixed(0)}%` : "—"}</DataCell>
    </>
  );
};

function provenanceBadge(g: GridRow): string {
  const provs = [g.call?.provenance, g.put?.provenance].filter(Boolean) as ("series" | "epoch" | "legacy")[];
  if (provs.includes("series")) return provs.some((p) => p !== "series") ? "SER·MIX" : "SERIES";
  if (provs.includes("epoch")) return "EPOCH";
  return provs.length ? "LEGACY" : "";
}

const cellBase = "flex h-[31px] items-center border-b border-l-hair px-2 font-mono-plex text-[12.5px] tabular-nums transition-colors";

const DataCell: FC<{ children: ReactNode; align: "left" | "right"; muted?: boolean; focused?: boolean; onClick?: () => void }> = ({
  children, align, muted, focused, onClick,
}) => (
  <div
    onClick={onClick}
    className={`${cellBase} ${align === "right" ? "justify-end" : "justify-start"} ${muted ? "text-l-muted" : "text-l-text"} ${
      focused ? "bg-l-surface" : ""
    } ${onClick ? "cursor-pointer hover:bg-l-surface" : ""}`}
  >
    {children}
  </div>
);

/** A numeric cell that flashes its direction color for ~300ms on value change. */
const FlashCell: FC<{
  value: number | null;
  align: "left" | "right";
  tone?: "up" | "down";
  focused?: boolean;
  onClick?: () => void;
  dataField?: string;
  dataMint?: string | null;
}> = ({ value, align, tone, focused, onClick, dataField, dataMint }) => {
  const flash = useFlash(value);
  const baseColor = tone === "up" ? "var(--color-l-up)" : tone === "down" ? "var(--color-l-down)" : undefined;
  const color = flash ? (flash === "up" ? "var(--color-l-up)" : "var(--color-l-down)") : baseColor;
  return (
    <div
      onClick={onClick}
      style={{ color }}
      data-field={dataField}
      data-mint={dataMint ?? undefined}
      className={`${cellBase} ${align === "right" ? "justify-end" : "justify-start"} ${color ? "" : "text-l-text"} ${
        focused ? "bg-l-surface" : ""
      } ${onClick ? "cursor-pointer hover:bg-l-surface" : ""}`}
    >
      {value != null ? fmtPrice(value) : "—"}
    </div>
  );
};

const FlashSpan: FC<{ value: number }> = ({ value }) => {
  const flash = useFlash(value);
  const color = flash === "up" ? "var(--color-l-up)" : flash === "down" ? "var(--color-l-down)" : undefined;
  return (
    <span className="font-mono-plex text-[11px] tabular-nums text-l-text" style={color ? { color } : undefined}>
      {fmtPrice(value)}
    </span>
  );
};

/** Shared flash-on-change hook: returns "up"/"down" for ~300ms after value moves. */
function useFlash(value: number | null): "up" | "down" | null {
  const prev = useRef<number | null>(value);
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  useEffect(() => {
    if (prev.current != null && value != null && value !== prev.current) {
      setFlash(value > prev.current ? "up" : "down");
      const t = window.setTimeout(() => setFlash(null), 300);
      prev.current = value;
      return () => window.clearTimeout(t);
    }
    prev.current = value;
  }, [value]);
  return flash;
}

export default TradeChainV2;
