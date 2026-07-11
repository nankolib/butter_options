// =============================================================================
// HoldingsLedger — the holder (LONG) ledger. Grouped CLAIMABLE → OPEN → EXPIRED.
// =============================================================================
// Columns: CONTRACT · STYLE · EXPIRY · STATUS · QTY · MARK · VALUE · B/E · ACTIONS.
// Terminal action set (resale-listing creation + OTM dust-burn parked): Claim
// (settled-ITM payout → exercise_from_vault), Exercise (American active ITM →
// exercise_american), Cancel (listed → cancel_v2_resale). No PnL column — honest
// footnote per the data-honesty rule.
// =============================================================================

import type { FC } from "react";
import { Link } from "react-router-dom";
import { SolscanLink } from "../../../components/SolscanLink";
import type { Position, PositionAction } from "../positions";
import {
  SectionBand, Th, Td, StyleBadge, StatusPill, RowAction, EmptyLine, SkeletonRows,
  contractLabel, fmtExpiry, fmtUsd,
} from "./portfolioUi";

type Group = "claimable" | "open" | "expired";

function groupOf(p: Position): Group {
  if (p.state === "settled-itm") return "claimable";
  if (p.state === "active") return "open";
  return "expired"; // settled-otm, expired-unsettled
}
const GROUP_ORDER: Group[] = ["claimable", "open", "expired"];
const GROUP_LABEL: Record<Group, string> = { claimable: "Claimable", open: "Open", expired: "Expired" };

function statusFor(p: Position): { tone: "up" | "muted" | "faint"; label: string } {
  switch (p.state) {
    case "settled-itm": return { tone: "up", label: "Claimable" };
    case "active": return { tone: "muted", label: "Open" };
    case "settled-otm": return { tone: "faint", label: "Expired" };
    default: return { tone: "faint", label: "Pending" };
  }
}

/** Which terminal action (if any) this row exposes + its verb/pending label. */
function actionFor(p: Position): { action: PositionAction; verb: string; busyLabel: string; destructive?: boolean } | null {
  switch (p.action) {
    case "exercise": return { action: "exercise", verb: "Claim", busyLabel: "Claiming…" };
    case "exercise-american": return { action: "exercise-american", verb: "Exercise", busyLabel: "Exercising…" };
    case "cancel-resale": return { action: "cancel-resale", verb: "Cancel", busyLabel: "Cancelling…" };
    default: return null; // list-resale + burn + none are parked / no-op in terminal
  }
}

export const HoldingsLedger: FC<{
  positions: Position[];
  loading: boolean;
  onAction: (p: Position, a: PositionAction) => void;
  busyId: string | null;
  collapsed: boolean;
  onToggle: () => void;
}> = ({ positions, loading, onAction, busyId, collapsed, onToggle }) => {
  // Sort: group order, then expiry ascending within a group.
  const sorted = [...positions].sort(
    (a, b) => GROUP_ORDER.indexOf(groupOf(a)) - GROUP_ORDER.indexOf(groupOf(b)) || a.expiry - b.expiry,
  );

  return (
    <section className="mb-10">
      <SectionBand
        accent="up"
        label="Holdings"
        sublabel="Long"
        count={positions.length}
        footnote="Mark from pool mid. Unrealized PnL once indexed."
        testid="holdings-band"
        collapsible
        collapsed={collapsed}
        onToggle={onToggle}
      />

      {!collapsed && (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse">
          <thead>
            <tr className="border-b border-l-hair">
              <Th>Contract</Th><Th>Style</Th><Th>Expiry</Th><Th>Status</Th>
              <Th align="right">Qty</Th><Th align="right">Mark</Th><Th align="right">Value</Th>
              <Th align="right">B/E</Th><Th align="right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {loading && positions.length === 0 ? (
              <SkeletonRows cols={9} />
            ) : positions.length === 0 ? (
              <tr><td colSpan={9}><EmptyLine>No open positions. <Link to="/trade" className="text-l-up-text no-underline hover:underline">→ Trade</Link></EmptyLine></td></tr>
            ) : (
              sorted.map((p, i) => {
                const g = groupOf(p);
                const prev = i > 0 ? groupOf(sorted[i - 1]) : null;
                const showHeader = g !== prev;
                const st = statusFor(p);
                const act = actionFor(p);
                const mark = p.contracts > 0 ? p.currentValue / p.contracts : 0;
                const perCt = p.contracts > 0 ? p.costBasis / p.contracts : 0;
                const be = p.side === "call" ? p.strike + perCt : p.strike - perCt;
                const dim = g === "expired";
                const busy = busyId === p.id;
                return (
                  <>
                    {showHeader && (
                      <tr key={`h-${g}`} data-testid="holdings-group">
                        <td colSpan={9} className="pt-4 pb-1 font-mono-plex text-[9px] uppercase tracking-[0.16em] text-l-faint">
                          {GROUP_LABEL[g]}
                        </td>
                      </tr>
                    )}
                    <tr
                      key={p.id}
                      data-testid="holdings-row"
                      data-group={g}
                      className={`h-[30px] border-b border-l-hair/50 ${dim ? "opacity-55" : ""}`}
                    >
                      <Td tone="text">{contractLabel(p.asset, p.strike, p.side)}</Td>
                      <td className="py-[7px]"><StyleBadge style={p.exerciseStyle} /></td>
                      <Td tone={dim ? "faint" : "muted"}>{fmtExpiry(p.expiry)}</Td>
                      <td className="py-[7px]"><StatusPill tone={st.tone}>{st.label}</StatusPill></td>
                      <Td align="right" tone="text">{p.contracts}</Td>
                      <Td align="right">{fmtUsd(mark)}</Td>
                      <Td align="right" tone="text">{fmtUsd(p.currentValue)}</Td>
                      <Td align="right">{fmtUsd(be)}</Td>
                      <td className="py-[7px]">
                        <div className="flex items-center justify-end gap-2">
                          {act ? (
                            <RowAction
                              onClick={() => onAction(p, act.action)}
                              busy={busy}
                              busyLabel={act.busyLabel}
                            >
                              {act.verb}
                            </RowAction>
                          ) : (
                            <span className="font-mono-plex text-[10px] text-l-faint">—</span>
                          )}
                          <SolscanLink kind="token" id={p.id} label="option mint" />
                        </div>
                      </td>
                    </tr>
                  </>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      )}
    </section>
  );
};

export default HoldingsLedger;
