// =============================================================================
// WriterPositionsTable.tsx — Display-only table for writer rows.
// =============================================================================
//
// Mirrors PositionsTable.tsx visually but with writer-flavored columns
// per D2 + state badge per D3 + Solscan icon per D7 + secondary
// "Burn unsold" link per D6. Action handlers come in via props so the
// section can wire them to useWriterActions.
//
// Why a separate component (instead of variant-flagging PositionsTable):
// the buyer table has cost-basis / current-value / P&L columns that
// don't apply here, and the writer table has minted/sold + claimable +
// state-badge columns the buyer doesn't need. Sharing a single component
// would add ~6 conditional branches per row to switch column shape.
// =============================================================================

import type { FC, ReactNode } from "react";
import type { PublicKey } from "@solana/web3.js";
import { MoneyAmount } from "../../components/MoneyAmount";
import { SolscanLink } from "../../utils/solscan";
import { usdcToNumber } from "../../utils/format";
import { ExerciseStyleBadge } from "./ExerciseStyleBadge";
import type {
  WriterRow,
  WriterRowState,
  WriterRowPrimaryAction,
  WriterRowAction,
} from "./writerRows";
import { EXERCISE_WINDOW_SECONDS } from "./writerRows";

const ASSET_FULL_NAME: Record<string, string> = {
  SOL: "Solana",
  BTC: "Bitcoin",
  ETH: "Ethereum",
  AAPL: "Apple",
  XAU: "Gold",
  XAG: "Silver",
  WTI: "Crude Oil",
  TSLA: "Tesla",
  NVDA: "Nvidia",
};

type WriterPositionsTableProps = {
  rows: WriterRow[];
  onAction: (row: WriterRow, action: WriterRowAction) => void;
  /** Row id currently being acted on (from useWriterActions.busyId). */
  busyId: string | null;
  /** Loading-state label for the busy row's button. */
  busyLabel: string | null;
  /** Empty state shown when rows is empty. */
  emptyState?: ReactNode;
};

export const WriterPositionsTable: FC<WriterPositionsTableProps> = ({
  rows,
  onAction,
  busyId,
  busyLabel,
  emptyState,
}) => {
  if (rows.length === 0 && emptyState !== undefined) {
    return <>{emptyState}</>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-rule">
            <Th>Asset</Th>
            <Th>Side</Th>
            <Th>Strike</Th>
            <Th>Expiry</Th>
            <Th>Collateral</Th>
            <Th>Contracts</Th>
            <Th
              title="Premium is paid by buyers at purchase. As contracts in your vault sell, your share becomes claimable."
            >
              Claimable<span className="text-ink-muted">*</span>
            </Th>
            <Th>State</Th>
            <Th>{""}</Th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <WriterRowEl
              key={row.id}
              row={row}
              onAction={onAction}
              isBusy={busyId === row.id}
              busyLabel={busyId === row.id ? busyLabel : null}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
};

const Th: FC<{ children: ReactNode; title?: string }> = ({ children, title }) => (
  <th
    title={title}
    className={`text-left font-mono font-medium text-[10.5px] uppercase tracking-[0.18em] py-3 pr-4 text-ink-muted align-bottom whitespace-nowrap ${
      title ? "cursor-help" : ""
    }`}
  >
    {children}
  </th>
);

const WriterRowEl: FC<{
  row: WriterRow;
  onAction: (row: WriterRow, action: WriterRowAction) => void;
  isBusy: boolean;
  busyLabel: string | null;
}> = ({ row, onAction, isBusy, busyLabel }) => {
  const fullName = ASSET_FULL_NAME[row.asset];
  // BN claimable → display number via usdcToNumber, which guards the $9B
  // safe-integer boundary (MED-5).
  const claimableUsd = usdcToNumber(row.claimableUsdc);
  const canClaim = row.primaryAction === "claim-premium" && claimableUsd > 0;
  const actionDisabled = isBusy || row.primaryAction === "settling" || !canActOnState(row);

  return (
    <tr className="border-b border-rule-soft align-middle">
      {/* Asset */}
      <td className="py-2 pr-2 sm:py-4 sm:pr-4">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-paper-2 font-mono text-[13px] uppercase"
          >
            {row.asset.charAt(0) || "?"}
          </span>
          <div>
            <div className="font-sans font-medium text-[15px] leading-tight text-ink">
              {row.asset || "Unknown"}
            </div>
            {fullName && (
              <div className="font-mono font-medium text-[10px] uppercase tracking-[0.18em] text-ink-muted">
                {fullName}
              </div>
            )}
          </div>
        </div>
      </td>

      {/* Side + exercise-style badge */}
      <td className="py-2 pr-2 sm:py-4 sm:pr-4">
        <span className="inline-flex items-center gap-2 font-mono text-[11.5px] uppercase tracking-[0.18em]">
          <span aria-hidden="true" className="inline-block w-[6px] h-[6px] rounded-full bg-crimson" />
          {row.side}
        </span>
        <div className="mt-1.5">
          <ExerciseStyleBadge style={row.exerciseStyle} />
        </div>
      </td>

      {/* Strike */}
      <td className="py-2 pr-2 sm:py-4 sm:pr-4 font-mono text-[13px] whitespace-nowrap">
        ${row.strike.toFixed(2)}
      </td>

      {/* Expiry */}
      <td className="py-2 pr-2 sm:py-4 sm:pr-4 whitespace-nowrap">
        <div className="font-mono text-[13px]">{formatTableDate(row.expiry)}</div>
        <div className="font-mono font-medium text-[10px] uppercase tracking-[0.16em] text-ink-muted mt-0.5">
          {formatCountdown(row.expiry)}
        </div>
      </td>

      {/* Collateral */}
      <td className="py-2 pr-2 sm:py-4 sm:pr-4 font-mono text-[13px] whitespace-nowrap">
        <MoneyAmount value={row.collateralDeposited} />
      </td>

      {/* Contracts: minted / sold */}
      <td className="py-2 pr-2 sm:py-4 sm:pr-4 font-mono text-[13px] whitespace-nowrap">
        {row.optionsMinted.toLocaleString()}
        <span className="text-ink-muted"> / </span>
        {row.optionsSold.toLocaleString()}
      </td>

      {/* Claimable premium */}
      <td className="py-2 pr-2 sm:py-4 sm:pr-4 font-mono text-[13px] whitespace-nowrap">
        <MoneyAmount value={claimableUsd} />
      </td>

      {/* State badge */}
      <td className="py-2 pr-2 sm:py-4 sm:pr-4 whitespace-nowrap">
        <div className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className={`inline-block w-[6px] h-[6px] rounded-full ${stateDotClass(row.state)}`}
          />
          <span className="font-mono text-[11px] uppercase tracking-[0.18em]">
            {stateLabel(row.state)}
          </span>
        </div>
        {stateSubtitle(row) && (
          <div className="font-mono font-medium text-[10px] uppercase tracking-[0.16em] text-ink-muted mt-0.5">
            {stateSubtitle(row)}
          </div>
        )}
      </td>

      {/* Action: Solscan icon + primary button + optional burn link */}
      <td className="py-2 sm:py-4">
        <div className="flex items-center gap-3 justify-end">
          <SolscanLink pda={row.vaultPda} />
          {row.primaryAction !== "settling" && (
            <button
              type="button"
              onClick={() => onAction(row, row.primaryAction)}
              disabled={actionDisabled}
              title={
                row.primaryAction === "claim-premium" && !canClaim
                  ? "No premium accrued yet — wait for buyers to purchase from this vault."
                  : undefined
              }
              className={`inline-flex items-center gap-2 rounded-full border px-[14px] py-[7px] font-mono text-[10.5px] uppercase tracking-[0.18em] no-underline transition-colors duration-300 ease-opta disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap ${actionStyle(
                row.primaryAction,
              )}`}
            >
              {isBusy ? (busyLabel ?? "…") : actionLabelFor(row.primaryAction)}
            </button>
          )}
          {row.primaryAction === "settling" && (
            <span className="font-mono font-medium text-[10.5px] uppercase tracking-[0.18em] text-ink-muted px-[14px] py-[7px]">
              Settling…
            </span>
          )}
        </div>
        {row.showBurnUnsold && (
          <div className="flex justify-end mt-2">
            <button
              type="button"
              onClick={() => onAction(row, "burn-unsold")}
              disabled={isBusy}
              className="font-mono font-medium text-[10px] uppercase tracking-[0.18em] underline underline-offset-2 decoration-rule hover:decoration-ink text-ink-muted hover:text-ink transition-colors duration-300 ease-opta disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Burn unsold ({row.unsoldCount}) ↗
            </button>
          </div>
        )}
      </td>
    </tr>
  );
};

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function canActOnState(row: WriterRow): boolean {
  if (row.primaryAction === "claim-premium") {
    return row.claimableUsdc.gtn(0);
  }
  return row.primaryAction === "withdraw-collateral";
}

function actionLabelFor(action: WriterRowPrimaryAction): string {
  switch (action) {
    case "claim-premium":
      return "Claim Accrued Premium";
    case "withdraw-collateral":
      return "Withdraw Collateral";
    case "settling":
      return "Settling…";
  }
}

function actionStyle(action: WriterRowPrimaryAction): string {
  switch (action) {
    case "claim-premium":
      return "border-ink text-ink hover:bg-ink hover:text-paper";
    case "withdraw-collateral":
      return "border-ink bg-ink text-paper hover:bg-transparent hover:text-ink";
    case "settling":
      return "border-rule text-ink-muted";
  }
}

/** Color of the small dot in the state cell. Per D3. */
function stateDotClass(state: WriterRowState): string {
  switch (state) {
    case "live":
      return "bg-ink";
    case "expired-pending":
    case "settled-locked":
      return "bg-amber-500";
    case "settled-itm":
      return "bg-crimson";
    case "settled-otm":
      return "bg-emerald-700";
  }
}

function stateLabel(state: WriterRowState): string {
  switch (state) {
    case "live":
      return "Live";
    case "expired-pending":
      return "Expired · Pending";
    case "settled-locked":
      return "Settled · Locked";
    case "settled-itm":
      return "Settled · ITM";
    case "settled-otm":
      return "Settled · OTM";
  }
}

/** Per-state subtitle text. Empty string hides the line. */
function stateSubtitle(row: WriterRow): string {
  switch (row.state) {
    case "live":
      return "";
    case "expired-pending":
      return "settling…";
    case "settled-locked":
      return `Locked until ${formatLockUnlock(row.expiry + EXERCISE_WINDOW_SECONDS)}`;
    case "settled-itm":
      return row.settlementPrice !== null
        ? `Settled @ $${row.settlementPrice.toFixed(2)}`
        : "in the money";
    case "settled-otm":
      return "expired worthless";
  }
}

function formatTableDate(unix: number): string {
  return new Date(unix * 1000).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function formatCountdown(unix: number): string {
  const now = Date.now() / 1000;
  const diff = unix - now;
  if (diff <= 0) return "Expired";
  const days = Math.floor(diff / 86400);
  const hours = Math.floor((diff % 86400) / 3600);
  if (days === 0) return `${hours}h`;
  return `${days}d ${hours}h`;
}

/**
 * "05 May, 18:44 UTC" — date + time, UTC explicit. Used by the
 * settled-locked subtitle. Year omitted because lock is always within
 * 24h of expiry; UTC explicit because the on-chain gate compares
 * clock.unix_timestamp directly (see writerRows.ts EXERCISE_WINDOW_SECONDS).
 */
function formatLockUnlock(unix: number): string {
  const d = new Date(unix * 1000);
  const date = d.toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    timeZone: "UTC",
  });
  const time = d.toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "UTC",
  });
  return `${date}, ${time} UTC`;
}

// Suppress unused-import-warning: PublicKey is used via the WriterRow type
// (vaultPda field) but tsc with "isolatedModules" sometimes flags re-exports.
export type { PublicKey };

export default WriterPositionsTable;
