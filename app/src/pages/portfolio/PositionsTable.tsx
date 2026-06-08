import type { FC, ReactNode } from "react";
import type { PublicKey } from "@solana/web3.js";
import { MoneyAmount } from "../../components/MoneyAmount";
import { SolscanLink } from "../../utils/solscan";
import { ExerciseStyleBadge } from "./ExerciseStyleBadge";
import type { Position, PositionAction } from "./positions";

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

type PositionsTableProps = {
  positions: Position[];
  onAction: (p: Position, action: PositionAction) => void;
  /** Position id currently being acted on; that row's button disables. */
  busyId: string | null;
  /** Render this when positions is empty. */
  emptyState?: ReactNode;
  /** When true, dampens row visual weight (used for the closed-positions section). */
  muted?: boolean;
};

/**
 * Display-only positions table. Renders header row + position rows;
 * action handlers come in via props so the same table serves both
 * the open-positions and closed-positions sections.
 *
 * Semantic <table> with hairline row dividers (border-rule-soft).
 * The asset cell uses a small letter chip + italic Fraunces ticker +
 * mono uppercase full-name sub-line, mirroring the mockup. Action
 * column has no header — actions are contextual per row.
 *
 * Mobile: wrapper sets overflow-x: auto so wide tables scroll
 * horizontally rather than blowing out the reading column.
 */
export const PositionsTable: FC<PositionsTableProps> = ({
  positions,
  onAction,
  busyId,
  emptyState,
  muted = false,
}) => {
  if (positions.length === 0 && emptyState !== undefined) {
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
            <Th>Contracts</Th>
            <Th>Cost basis</Th>
            <Th>Current value</Th>
            <Th>P&amp;L</Th>
            <Th>{""}</Th>
          </tr>
        </thead>
        <tbody className={muted ? "opacity-70" : ""}>
          {positions.map((p) => (
            <PositionRow key={p.id} position={p} onAction={onAction} isBusy={busyId === p.id} />
          ))}
        </tbody>
      </table>
    </div>
  );
};

const Th: FC<{ children: ReactNode }> = ({ children }) => (
  <th className="text-left font-mono font-medium text-[10.5px] uppercase tracking-[0.18em] py-3 pr-4 text-ink-muted align-bottom whitespace-nowrap">
    {children}
  </th>
);

const PositionRow: FC<{
  position: Position;
  onAction: (p: Position, action: PositionAction) => void;
  isBusy: boolean;
}> = ({ position: p, onAction, isBusy }) => {
  const fullName = ASSET_FULL_NAME[p.asset];
  const pnlColor =
    p.pnl > 0 ? "text-emerald-700" : p.pnl < 0 ? "text-crimson" : "text-ink";

  return (
    <tr className="border-b border-rule-soft align-middle">
      {/* Asset */}
      <td className="py-2 pr-2 sm:py-4 sm:pr-4">
        <div className="flex items-center gap-3">
          <span
            aria-hidden="true"
            className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-paper-2 font-mono text-[13px] uppercase"
          >
            {p.asset.charAt(0) || "?"}
          </span>
          <div>
            <div className="font-sans font-medium text-[15px] leading-tight text-ink">
              {p.asset || "Unknown"}
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
          {p.side}
        </span>
        <div className="mt-1.5">
          <ExerciseStyleBadge style={p.exerciseStyle} />
        </div>
      </td>

      {/* Strike */}
      <td className="py-2 pr-2 sm:py-4 sm:pr-4 font-mono text-[13px] whitespace-nowrap">
        ${p.strike.toFixed(2)}
      </td>

      {/* Expiry — date + countdown */}
      <td className="py-2 pr-2 sm:py-4 sm:pr-4 whitespace-nowrap">
        <div className="font-mono text-[13px]">{formatTableDate(p.expiry)}</div>
        <div className="font-mono font-medium text-[10px] uppercase tracking-[0.16em] text-ink-muted mt-0.5">
          {formatCountdown(p.expiry)}
        </div>
      </td>

      {/* Contracts */}
      <td className="py-2 pr-2 sm:py-4 sm:pr-4 font-mono text-[13px]">
        {p.contracts.toLocaleString()}
      </td>

      {/* Cost basis */}
      <td className="py-2 pr-2 sm:py-4 sm:pr-4 font-mono text-[13px] whitespace-nowrap">
        <MoneyAmount value={p.costBasis} />
      </td>

      {/* Current value */}
      <td className="py-2 pr-2 sm:py-4 sm:pr-4 font-mono text-[13px] whitespace-nowrap">
        <MoneyAmount value={p.currentValue} />
      </td>

      {/* P&L */}
      <td className="py-2 pr-2 sm:py-4 sm:pr-4 font-mono text-[13px] whitespace-nowrap">
        <span className={pnlColor}>
          <MoneyAmount value={p.pnl} showSign />
          <span className="ml-2 text-[10.5px] text-ink-body">
            {formatPnLPercent(p.pnlPercent)}
          </span>
        </span>
      </td>

      {/* Action — Solscan icon + primary action button (D7 retrofit). */}
      <td className="py-2 sm:py-4">
        <div className="flex items-center gap-3 justify-end">
          <SolscanLink pda={solscanTargetFor(p)} />
          {p.action !== "none" && (
            <button
              type="button"
              onClick={() => onAction(p, p.action)}
              disabled={isBusy}
              className={`inline-flex items-center gap-2 rounded-full border px-[14px] py-[7px] font-mono text-[10.5px] uppercase tracking-[0.18em] no-underline transition-colors duration-300 ease-opta disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap ${actionStyle(
                p.action,
              )}`}
            >
              {isBusy ? "…" : actionLabel(p.action)}
              {!isBusy &&
                (p.action === "exercise" || p.action === "exercise-american") && (
                  <span aria-hidden="true">→</span>
                )}
            </button>
          )}
        </div>
      </td>
    </tr>
  );
};

/** Resolve the Solscan link target for a buyer row — the SharedVault PDA. */
function solscanTargetFor(p: Position): PublicKey {
  return p.vaultPda;
}

function actionLabel(action: PositionAction): string {
  switch (action) {
    case "exercise":
      return "Exercise";
    case "exercise-american":
      return "Exercise Early";
    case "list-resale":
      return "List for Resale";
    case "cancel-resale":
      return "Cancel Listing";
    case "burn":
      return "Burn";
    default:
      return "";
  }
}

function actionStyle(action: PositionAction): string {
  switch (action) {
    case "exercise":
    case "exercise-american":
      return "border-ink bg-ink text-paper hover:bg-transparent hover:text-ink";
    case "list-resale":
      return "border-ink text-ink hover:bg-ink hover:text-paper";
    case "cancel-resale":
      return "border-rule text-ink-body hover:border-ink hover:text-ink";
    case "burn":
      return "border-rule text-ink-muted hover:border-crimson hover:text-crimson";
    default:
      return "";
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

function formatPnLPercent(percent: number): string {
  const sign = percent > 0 ? "+" : "";
  return `${sign}${percent.toFixed(1)}%`;
}

export default PositionsTable;
