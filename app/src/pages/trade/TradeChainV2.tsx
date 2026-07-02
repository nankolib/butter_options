import type { FC, ReactNode } from "react";
import { useMemo } from "react";
import { calculateCallPremium, calculatePutPremium, getDefaultVolatility } from "../../utils/blackScholes";
import type { UnifiedChainRow } from "../../hooks/useUnifiedChain";

/**
 * TradeChainV2 — Deribit-style unified chain for the v2 exchange Trade page.
 *
 * Calls (left) │ Strike (centre) │ Puts (right). Per side: Bid · Ask · OI · Mark.
 *   - bid/ask/OI come from the Pass-0 unified aggregate (book best bid/ask +
 *     series OI). Legacy per-event rows have no book → "—".
 *   - mark is a CHEAP client-side TS Black-Scholes figure (carry r=0, asset
 *     smile applied) — the precise American number comes from the on-chain
 *     get_option_price view only when a contract is engaged (Pass 2/RFQ).
 *   - provenance (series vs legacy) is shown as a small badge under the strike,
 *     not a separate section (T2).
 *
 * Selection highlights the focused contract; the ticket (Pass 2) and chart
 * (Pass 3) will read that focused state.
 */

/** The focused contract is the full unified row (carries bid/ask/oi/mark). */
export type FocusedContract = UnifiedChainRow;

/** A strike's both sides + which to open the detail modal on (F). */
export interface DetailTarget {
  call: UnifiedChainRow | null;
  put: UnifiedChainRow | null;
  side: "call" | "put";
}

interface GridRow {
  strike: number;
  call: UnifiedChainRow | null;
  put: UnifiedChainRow | null;
}

const fmtPrice = (n: number): string => `$${n.toFixed(n < 100 ? 4 : 2)}`;
const fmtStrike = (n: number): string =>
  n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(n);

function mark(row: UnifiedChainRow, spot: number | null): number | null {
  if (!spot || spot <= 0) return null;
  const days = Math.max(0, (row.expiry - Date.now() / 1000) / 86_400);
  if (days <= 0) return null;
  const vol = getDefaultVolatility(row.asset);
  // carry r=0 (T6 note): for crypto carry=0 CALLs this equals the American premium.
  return row.optionType === "call"
    ? calculateCallPremium(spot, row.strike, days, vol, 0, undefined, row.asset)
    : calculatePutPremium(spot, row.strike, days, vol, 0, undefined, row.asset);
}

export const TradeChainV2: FC<{
  rows: UnifiedChainRow[];
  spot: number | null;
  atmStrike: number | null;
  focused: FocusedContract | null;
  onSelect: (c: FocusedContract) => void;
  onShowDetails: (t: DetailTarget) => void;
}> = ({ rows, spot, atmStrike, focused, onSelect, onShowDetails }) => {
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

  if (gridRows.length === 0) {
    return (
      <div className="border border-rule rounded-md p-12 text-center">
        <p className="font-sans italic font-medium leading-[1.55] text-ink-body text-[15px] m-0">
          No contracts at this expiry.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-rule">
            <Th align="right">Bid</Th>
            <Th align="right">Ask</Th>
            <Th align="right">OI</Th>
            <Th align="right">Mark</Th>
            <Th align="center">Strike</Th>
            <Th align="left">Mark</Th>
            <Th align="left">OI</Th>
            <Th align="left">Ask</Th>
            <Th align="left">Bid</Th>
          </tr>
        </thead>
        <tbody>
          {gridRows.map((g) => (
            <GridRowEl
              key={g.strike}
              g={g}
              spot={spot}
              isAtm={atmStrike != null && g.strike === atmStrike}
              focused={focused}
              onSelect={onSelect}
              onShowDetails={onShowDetails}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
};

const GridRowEl: FC<{
  g: GridRow;
  spot: number | null;
  isAtm: boolean;
  focused: FocusedContract | null;
  onSelect: (c: FocusedContract) => void;
  onShowDetails: (t: DetailTarget) => void;
}> = ({ g, spot, isAtm, focused, onSelect, onShowDetails }) => {
  const provs = [g.call?.provenance, g.put?.provenance].filter(Boolean) as ("series" | "epoch" | "legacy")[];
  const badge = provs.includes("series")
    ? provs.some((p) => p !== "series") ? "SER·MIX" : "SERIES"
    : provs.includes("epoch")
      ? "EPOCH"
      : provs.length ? "LEGACY" : "";
  // Strike-cell ⤢ opens the detail modal (both sides; Call default if both exist).
  const hasAny = !!(g.call || g.put);

  return (
    <tr className={`border-t border-b ${isAtm ? "border-rule" : "border-rule-soft"} align-middle`}>
      <SideCells row={g.call} side="call" spot={spot} focused={focused} onSelect={onSelect} />

      <td className="px-2 py-2 sm:px-3 sm:py-4 text-center align-middle">
        <button
          type="button"
          onClick={() => hasAny && onShowDetails({ call: g.call, put: g.put, side: g.call ? "call" : "put" })}
          title="Contract details"
          className="group inline-flex items-center gap-1 hover:text-crimson transition-colors"
        >
          <span className="font-fraunces-text italic font-light text-ink group-hover:text-crimson text-[18px] leading-tight">
            ${fmtStrike(g.strike)}
          </span>
          <span className="font-mono text-[10px] text-ink-muted group-hover:text-crimson">⤢</span>
        </button>
        {badge && (
          <div className={`font-mono text-[8.5px] uppercase tracking-[0.18em] mt-1 ${
            badge === "LEGACY" ? "text-ink-muted" : badge === "EPOCH" ? "text-ink" : "text-crimson"
          }`}>
            {badge}
          </div>
        )}
        {isAtm && (
          <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-crimson mt-1">ATM</div>
        )}
      </td>

      <SideCells row={g.put} side="put" spot={spot} focused={focused} onSelect={onSelect} />
    </tr>
  );
};

/** Four cells for one side. Order flips so both sides read toward the strike. */
const SideCells: FC<{
  row: UnifiedChainRow | null;
  side: "call" | "put";
  spot: number | null;
  focused: FocusedContract | null;
  onSelect: (c: FocusedContract) => void;
}> = ({ row, side, spot, focused, onSelect }) => {
  const align = side === "call" ? "right" : "left";
  if (!row) {
    return (
      <>
        <Td align={align}>—</Td>
        <Td align={align}>—</Td>
        <Td align={align}>—</Td>
        <Td align={align}>—</Td>
      </>
    );
  }
  const m = mark(row, spot);
  const isFocused =
    focused != null && focused.vault === row.vault && focused.optionType === row.optionType && focused.strike === row.strike;
  const bid = <Td align={align}>{row.bestBid != null ? <span className="text-ink">{fmtPrice(row.bestBid)}</span> : "—"}</Td>;
  const ask = <Td align={align}>{row.bestAsk != null ? <span className="text-ink">{fmtPrice(row.bestAsk)}</span> : "—"}</Td>;
  const oi = <Td align={align}>{row.oi > 0 ? row.oi.toLocaleString() : "—"}</Td>;
  const markCell = (
    <td className={`px-2 py-2 sm:px-3 sm:py-3 align-middle ${align === "right" ? "text-right" : "text-left"}`}>
      <button
        type="button"
        onClick={() => onSelect(row)}
        className={`font-mono text-[13px] leading-tight px-2 py-1 rounded transition-colors ${
          isFocused ? "bg-crimson/10 text-crimson" : "text-ink-body hover:bg-paper-2"
        }`}
      >
        {m != null ? fmtPrice(m) : "—"}
      </button>
    </td>
  );
  // Calls read Bid·Ask·OI·Mark toward the strike; puts mirror (Mark·OI·Ask·Bid).
  return side === "call" ? <>{bid}{ask}{oi}{markCell}</> : <>{markCell}{oi}{ask}{bid}</>;
};

const Th: FC<{ children: ReactNode; align: "left" | "center" | "right" }> = ({ children, align }) => (
  <th className={`font-mono font-medium text-[10.5px] uppercase tracking-[0.18em] py-3 px-3 text-ink-muted align-bottom whitespace-nowrap ${
    align === "right" ? "text-right" : align === "center" ? "text-center" : "text-left"
  }`}>
    {children}
  </th>
);

const Td: FC<{ children: ReactNode; align: "left" | "right" }> = ({ children, align }) => (
  <td className={`font-mono text-[13px] text-ink-body px-2 py-2 sm:px-3 sm:py-3 align-middle whitespace-nowrap ${
    align === "right" ? "text-right" : "text-left"
  }`}>
    {children}
  </td>
);
