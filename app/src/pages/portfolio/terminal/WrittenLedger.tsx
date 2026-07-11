// =============================================================================
// WrittenLedger — the writer (SHORT) ledger. Grouped CLAIMABLE → OPEN → LOCKED.
// =============================================================================
// Columns: CONTRACT · ORIGIN · STYLE · EXPIRY · STATUS · COLLAT · MINTED · SOLD ·
// PREMIUM · ACTIONS. Actions (byte-identical flows): Claim (live claimable →
// claim_premium), Withdraw (settled+unlocked → withdraw_post_settlement, auto-
// claims premium), Burn unsold (crimson, past-expiry unsold → burn_unsold). LOCKED
// rows disable the primary with a mono countdown (holders-first 24h window).
// =============================================================================

import type { FC } from "react";
import { Link } from "react-router-dom";
import { SolscanLink } from "../../../components/SolscanLink";
import { usdcToNumber } from "../../../utils/format";
import { EXERCISE_WINDOW_SECONDS, type WriterRow, type WriterRowAction } from "../writerRows";
import {
  SectionBand, Th, Td, StyleBadge, OriginBadge, StatusPill, RowAction, EmptyLine, SkeletonRows,
  contractLabel, fmtExpiry, fmtUsd, fmtCountdown,
} from "./portfolioUi";

type Group = "claimable" | "open" | "locked";

function claimablePremium(row: WriterRow): number {
  return usdcToNumber(row.claimableUsdc);
}
function groupOf(row: WriterRow): Group {
  if (row.state === "settled-locked" || row.state === "expired-pending") return "locked";
  if (row.state === "settled-itm" || row.state === "settled-otm") return "claimable";
  // live
  return claimablePremium(row) > 0 ? "claimable" : "open";
}
const GROUP_ORDER: Group[] = ["claimable", "open", "locked"];
const GROUP_LABEL: Record<Group, string> = { claimable: "Claimable", open: "Open", locked: "Locked" };

export const WrittenLedger: FC<{
  rows: WriterRow[];
  loading: boolean;
  nowSecs: number;
  onAction: (row: WriterRow, a: WriterRowAction) => void;
  busyId: string | null;
  busyLabel: string | null;
  collapsed: boolean;
  onToggle: () => void;
}> = ({ rows, loading, nowSecs, onAction, busyId, busyLabel, collapsed, onToggle }) => {
  const sorted = [...rows].sort(
    (a, b) => GROUP_ORDER.indexOf(groupOf(a)) - GROUP_ORDER.indexOf(groupOf(b)) || a.expiry - b.expiry,
  );

  return (
    <section className="mb-10">
      <SectionBand
        accent="down"
        label="Written"
        sublabel="Short"
        count={rows.length}
        footnote="Settled vaults unlock for writers 24h after settlement — holders claim first."
        testid="written-band"
        collapsible
        collapsed={collapsed}
        onToggle={onToggle}
      />

      {!collapsed && (
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] border-collapse">
          <thead>
            <tr className="border-b border-l-hair">
              <Th>Contract</Th><Th>Origin</Th><Th>Style</Th><Th>Expiry</Th><Th>Status</Th>
              <Th align="right">Collat</Th><Th align="right">Minted</Th><Th align="right">Sold</Th>
              <Th align="right">Premium</Th><Th align="right">Actions</Th>
            </tr>
          </thead>
          <tbody>
            {loading && rows.length === 0 ? (
              <SkeletonRows cols={10} />
            ) : rows.length === 0 ? (
              <tr><td colSpan={10}><EmptyLine>Nothing written. <Link to="/write" className="text-l-up-text no-underline hover:underline">→ Write</Link></EmptyLine></td></tr>
            ) : (
              sorted.map((row, i) => {
                const g = groupOf(row);
                const prev = i > 0 ? groupOf(sorted[i - 1]) : null;
                const showHeader = g !== prev;
                const busy = busyId === row.id;
                const premium = claimablePremium(row);
                const unlockTs = row.expiry + EXERCISE_WINDOW_SECONDS;
                const dim = g === "locked";
                return (
                  <>
                    {showHeader && (
                      <tr key={`h-${g}`} data-testid="written-group">
                        <td colSpan={10} className="pt-4 pb-1 font-mono-plex text-[9px] uppercase tracking-[0.16em] text-l-faint">
                          {GROUP_LABEL[g]}
                        </td>
                      </tr>
                    )}
                    <tr
                      key={row.id}
                      data-testid="written-row"
                      data-group={g}
                      className={`h-[30px] border-b border-l-hair/50 ${dim ? "opacity-55" : ""}`}
                    >
                      <Td tone="text">{contractLabel(row.asset, row.strike, row.side)}</Td>
                      <td className="py-[7px]"><OriginBadge origin={row.origin} /></td>
                      <td className="py-[7px]"><StyleBadge style={row.exerciseStyle} /></td>
                      <Td tone={dim ? "faint" : "muted"}>{fmtExpiry(row.expiry)}</Td>
                      <td className="py-[7px]"><WriterStatus row={row} nowSecs={nowSecs} group={g} unlockTs={unlockTs} /></td>
                      <Td align="right" tone="text">{fmtUsd(row.collateralDeposited)}</Td>
                      <Td align="right">{row.optionsMinted}</Td>
                      <Td align="right">{row.optionsSold}</Td>
                      <Td align="right" tone={premium > 0 ? "up" : "muted"}>{fmtUsd(premium)}</Td>
                      <td className="py-[7px] text-right">
                        <WriterActionsCell
                          row={row} nowSecs={nowSecs} unlockTs={unlockTs}
                          premium={premium} busy={busy} busyLabel={busyLabel} onAction={onAction}
                        />
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

const WriterStatus: FC<{ row: WriterRow; nowSecs: number; group: Group; unlockTs: number }> = ({ row, nowSecs, group, unlockTs }) => {
  if (row.state === "settled-locked") {
    return <StatusPill tone="faint">Locked · {fmtCountdown(unlockTs, nowSecs)}</StatusPill>;
  }
  if (row.state === "expired-pending") return <StatusPill tone="faint">Settling</StatusPill>;
  if (group === "claimable") return <StatusPill tone="up">Claimable</StatusPill>;
  return <StatusPill tone="muted">Open</StatusPill>;
};

const WriterActionsCell: FC<{
  row: WriterRow;
  nowSecs: number;
  unlockTs: number;
  premium: number;
  busy: boolean;
  busyLabel: string | null;
  onAction: (row: WriterRow, a: WriterRowAction) => void;
}> = ({ row, nowSecs, unlockTs, premium, busy, busyLabel, onAction }) => {
  const burn = row.showBurnUnsold ? (
    <RowAction key="burn" destructive onClick={() => onAction(row, "burn-unsold")} busy={busy} busyLabel={busyLabel}>
      Burn unsold
    </RowAction>
  ) : null;

  let primary: React.ReactNode = null;
  if (row.state === "settled-locked") {
    primary = (
      <span className="inline-flex items-center rounded-[6px] border border-l-hair px-[10px] py-[5px] font-mono-plex text-[10.5px] uppercase tracking-[0.1em] text-l-faint">
        Locked · {fmtCountdown(unlockTs, nowSecs)}
      </span>
    );
  } else if (row.state === "expired-pending") {
    primary = <span className="font-mono-plex text-[10px] text-l-faint">—</span>;
  } else if (row.state === "settled-itm" || row.state === "settled-otm") {
    primary = (
      <RowAction onClick={() => onAction(row, "withdraw-collateral")} busy={busy} busyLabel={busyLabel ?? "Withdrawing…"}>
        Withdraw
      </RowAction>
    );
  } else {
    // live
    primary = (
      <RowAction
        onClick={() => onAction(row, "claim-premium")}
        busy={busy}
        busyLabel={busyLabel ?? "Claiming…"}
        disabled={premium <= 0}
        title={premium <= 0 ? "No premium accrued yet" : undefined}
      >
        Claim
      </RowAction>
    );
  }
  return (
    <div className="flex items-center justify-end gap-2">
      {primary}
      {burn}
      <SolscanLink kind="account" id={row.vaultPda} label="vault" />
    </div>
  );
};

export default WrittenLedger;
