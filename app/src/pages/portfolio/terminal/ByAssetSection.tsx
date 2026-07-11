// =============================================================================
// ByAssetSection — BY ASSET · N per-asset profitability rollup.
// =============================================================================
// Sits between the summary strip and HOLDINGS. WRITER P&L is the green/red
// health number (mark-to-market on sold contracts). No holder-PnL column — the
// footnote states the honesty boundary. Collapsible like the ledgers.
// =============================================================================

import type { FC } from "react";
import { SectionBand, Th, Td, EmptyLine, fmtUsd, signTone } from "./portfolioUi";
import type { AssetRollupRow } from "./assetRollup";

/** Signed value → "+$X" / "−$X"; null → "—". */
const signed = (v: number | null) =>
  v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmtUsd(Math.abs(v))}`;

export const ByAssetSection: FC<{
  rows: AssetRollupRow[];
  loading: boolean;
  collapsed: boolean;
  onToggle: () => void;
}> = ({ rows, loading, collapsed, onToggle }) => (
  <section className="mb-10">
    <SectionBand
      accent="up"
      label="By asset"
      count={rows.length}
      footnote="Writer P&L is mark-to-market on sold contracts. Holder P&L pending indexer."
      testid="byasset-band"
      collapsible
      collapsed={collapsed}
      onToggle={onToggle}
    />
    {!collapsed && (
      <div className="overflow-x-auto" data-testid="byasset-body">
        <table className="w-full min-w-[720px] border-collapse">
          <thead>
            <tr className="border-b border-l-hair">
              <Th>Asset</Th>
              <Th align="right">Writer P&amp;L</Th>
              <Th align="right">Premium earned</Th>
              <Th align="right">Holdings value</Th>
              <Th align="right">Claimable</Th>
              <Th align="right">Collateral</Th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6}>
                  <EmptyLine>{loading ? "Loading…" : "No exposure yet."}</EmptyLine>
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.asset} data-testid="byasset-row" className="h-[30px] border-b border-l-hair/50">
                  <Td tone="text">{r.asset}</Td>
                  <td className="py-[7px] text-right">
                    <span
                      data-testid="byasset-pnl"
                      className={`font-mono-plex text-[12px] tabular-nums ${
                        r.writerPnl == null
                          ? "text-l-faint"
                          : signTone(r.writerPnl) === "up"
                            ? "text-l-up-text"
                            : signTone(r.writerPnl) === "down"
                              ? "text-l-down"
                              : "text-l-muted"
                      }`}
                    >
                      {signed(r.writerPnl)}
                    </span>
                    {r.partial && (
                      <span className="ml-1.5 font-mono-plex text-[9px] uppercase tracking-[0.1em] text-l-faint">partial</span>
                    )}
                  </td>
                  <Td align="right" tone={r.premiumEarned > 0 ? "up" : "muted"}>{fmtUsd(r.premiumEarned)}</Td>
                  <Td align="right" tone="text">{fmtUsd(r.holdingsValue)}</Td>
                  <Td align="right" tone={r.claimable > 0 ? "up" : "muted"}>{fmtUsd(r.claimable)}</Td>
                  <Td align="right">{fmtUsd(r.collateral)}</Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    )}
  </section>
);

export default ByAssetSection;
