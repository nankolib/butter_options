// =============================================================================
// WriteLadderTable — full-width ladder cell table (Epoch · LADDER).
// =============================================================================
//
// Renders the snapped, collision-merged ladder cells as a dense terminal table:
// TENOR · EXPIRY · % · CONTRACTS · PREMIUM/CT · COLLATERAL, plus a Total row.
// All numerals Plex Mono, tabular, right-aligned; rows ~30px. Every value comes
// from the controller's resolved cells (per-cell live Black-Scholes premium) —
// display only, no logic here.
// =============================================================================

import type { FC } from "react";
import type { PreviewCell } from "./useWriteController";

const fmtUsd = (v: number, dp = 2) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

const fmtExpiry = (ts: number) =>
  new Date(ts * 1000)
    .toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "2-digit", timeZone: "UTC" })
    .toUpperCase();

export const WriteLadderTable: FC<{ cells: PreviewCell[] }> = ({ cells }) => {
  if (cells.length === 0) return null;
  const totalContracts = cells.reduce((s, c) => s + c.contracts, 0);
  const totalPremium = cells.reduce((s, c) => s + c.premiumPerContract * c.contracts, 0);
  const totalCollateral = cells.reduce((s, c) => s + c.collateral, 0);

  return (
    <div className="overflow-x-auto" data-testid="ladder-table">
      <table className="w-full min-w-[560px] border-collapse">
        <thead>
          <tr className="border-b border-l-hair">
            <Th align="left">Tenor</Th>
            <Th align="left">Expiry</Th>
            <Th align="right">%</Th>
            <Th align="right">Contracts</Th>
            <Th align="right">Premium/ct</Th>
            <Th align="right">Collateral</Th>
          </tr>
        </thead>
        <tbody>
          {cells.map((c) => (
            <tr key={c.expiryTs} data-testid="ladder-row" className="h-[30px] border-b border-l-hair/60">
              <Td align="left" tone="text">{c.tenorLabels.join(" + ")}</Td>
              <Td align="left">{fmtExpiry(c.expiryTs)}</Td>
              <Td align="right">{c.pct}%</Td>
              <Td align="right">{c.contracts}</Td>
              <Td align="right">{fmtUsd(c.premiumPerContract)}</Td>
              <Td align="right">{fmtUsd(c.collateral)}</Td>
            </tr>
          ))}
          <tr className="h-[32px]">
            <Td align="left" tone="text">Total</Td>
            <Td align="left" />
            <Td align="right" />
            <Td align="right" tone="text">{totalContracts}</Td>
            <Td align="right" tone="text">{fmtUsd(totalPremium)}</Td>
            <Td align="right" tone="text">{fmtUsd(totalCollateral)}</Td>
          </tr>
        </tbody>
      </table>
    </div>
  );
};

const Th: FC<{ align: "left" | "right"; children?: React.ReactNode }> = ({ align, children }) => (
  <th
    className={`py-2 font-mono-plex text-[9px] font-normal uppercase tracking-[0.14em] text-l-faint ${
      align === "right" ? "text-right" : "text-left"
    }`}
  >
    {children}
  </th>
);

const Td: FC<{ align: "left" | "right"; tone?: "text" | "muted"; children?: React.ReactNode }> = ({
  align,
  tone = "muted",
  children,
}) => (
  <td
    className={`py-1.5 font-mono-plex text-[12px] tabular-nums ${
      align === "right" ? "text-right" : "text-left"
    } ${tone === "text" ? "text-l-text" : "text-l-muted"}`}
  >
    {children}
  </td>
);

export default WriteLadderTable;
