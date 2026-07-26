// =============================================================================
// LeaderboardPage — the competition surface. Terminal temperature, both modes.
// =============================================================================
// Brief §5: bordered rows, 28-32px, hairline dividers, sticky header, hover =
// --surface, selected = 2px left border. §4: every number mono/tabular/right.
// §7: empty state is one line + one action. §3: labels use --text-2, and only
// de-emphasised content (excluded rows) may use --text-3.
//
// This component is deliberately thin — all formatting and state derivation is
// in utils/epoch0Format.ts, which is unit-tested. See app/scripts/run-epoch0-tests.mjs.
// =============================================================================

import { useCallback, useEffect, useMemo, useState, type FC } from "react";
import { Link } from "react-router-dom";
import { useWallet } from "@solana/wallet-adapter-react";

import { TerminalAppBar } from "../../components/TerminalAppBar";
import { useSurfaceMode } from "../../hooks/useSurfaceMode";
import { fetchLeaderboard, type BoardRow } from "../../utils/epoch0";
import {
  BOARDS,
  BOARD_LABEL,
  BOARD_METRIC,
  EMPTY_COPY,
  UNAVAILABLE_LINE,
  freshness,
  metricCell,
  multiplier as fmtMultiplier,
  surfaceState,
  truncateWallet,
  type Board,
} from "../../utils/epoch0Format";

interface Loaded {
  rows: BoardRow[];
  computedAt: number | null;
  failed: boolean;
  loading: boolean;
}

const EMPTY: Loaded = { rows: [], computedAt: null, failed: false, loading: true };

export const LeaderboardPage: FC = () => {
  const { mode, toggle } = useSurfaceMode("dark");
  const { publicKey } = useWallet();
  const me = publicKey?.toBase58() ?? null;

  const [board, setBoard] = useState<Board>("profit");
  const [state, setState] = useState<Loaded>(EMPTY);

  const load = useCallback(async (b: Board) => {
    setState((p) => ({ ...p, loading: true }));
    const res = await fetchLeaderboard(b, 50);
    setState(
      res.ok
        ? { rows: res.data.rows, computedAt: res.data.computed_at, failed: false, loading: false }
        : { rows: [], computedAt: null, failed: true, loading: false },
    );
  }, []);

  useEffect(() => {
    void load(board);
  }, [board, load]);

  const view = useMemo(
    () => surfaceState({ loading: state.loading, failed: state.failed, rowCount: state.rows.length }),
    [state],
  );

  return (
    <div className="flex min-h-screen flex-col bg-l-bg text-l-text">
      <TerminalAppBar mode={mode} onToggleMode={toggle} />

      <main className="flex-1 overflow-auto px-5 py-6">
        <div className="mx-auto w-full max-w-[900px]">
          {/* Header row: title + freshness. One job per screen (§5). */}
          <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
            <h1 className="font-sans text-[15px] font-medium text-l-text">Leaderboard</h1>
            <span className="font-mono-plex text-[11px] tabular-nums text-l-muted">
              {state.computedAt ? `Computed ${freshness(state.computedAt)}` : "—"}
            </span>
          </div>

          {/* Board tabs */}
          <nav className="mb-4 flex flex-wrap gap-1" aria-label="Boards">
            {BOARDS.map((b) => {
              const active = b === board;
              return (
                <button
                  key={b}
                  type="button"
                  onClick={() => setBoard(b)}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-[6px] px-[11px] py-[6px] font-mono-plex text-[10.5px] uppercase tracking-[0.14em] transition-colors duration-150 ${
                    active
                      ? "border border-l-muted text-l-text"
                      : "border border-transparent text-l-muted hover:text-l-text"
                  }`}
                >
                  {BOARD_LABEL[b]}
                </button>
              );
            })}
          </nav>

          {view === "unavailable" && (
            <p className="border-t border-l-hair py-4 font-mono-plex text-[11px] text-l-muted">{UNAVAILABLE_LINE}</p>
          )}

          {view === "loading" && <SkeletonRows />}

          {view === "empty" && (
            <div className="border-t border-l-hair py-6">
              <p className="font-sans text-[13px] text-l-text">{EMPTY_COPY[board].line}</p>
              <Link
                to={EMPTY_COPY[board].to}
                className="mt-2 inline-flex font-mono-plex text-[10.5px] uppercase tracking-[0.14em] text-l-muted underline-offset-4 hover:text-l-text hover:underline"
              >
                {EMPTY_COPY[board].action}
              </Link>
            </div>
          )}

          {view === "ready" && <BoardTable board={board} rows={state.rows} me={me} />}

          {board === "profit" && view === "ready" && (
            <p className="mt-3 font-mono-plex text-[10.5px] text-l-muted">Faucet-funded wallets only.</p>
          )}
        </div>
      </main>
    </div>
  );
};

// ---------------------------------------------------------------------------

const SkeletonRows: FC = () => (
  // Brief §6: skeleton rows, never a spinner in a data surface.
  <div className="border-t border-l-hair" aria-hidden="true">
    {Array.from({ length: 8 }, (_, i) => (
      <div key={i} className="flex h-[30px] items-center gap-4 border-b border-l-hair px-3">
        <span className="h-[9px] w-[18px] rounded-[2px] bg-l-surface" />
        <span className="h-[9px] w-[120px] rounded-[2px] bg-l-surface" />
        <span className="ml-auto h-[9px] w-[64px] rounded-[2px] bg-l-surface" />
      </div>
    ))}
  </div>
);

const BoardTable: FC<{ board: Board; rows: BoardRow[]; me: string | null }> = ({ board, rows, me }) => (
  <div className="overflow-x-auto">
    <table className="w-full border-collapse">
      <thead className="sticky top-0 z-10 bg-l-bg">
        <tr className="border-b border-l-hair">
          <Th className="w-[52px]">#</Th>
          <Th>Wallet</Th>
          <Th align="right">{BOARD_METRIC[board]}</Th>
          {board === "profit" && <Th align="right">Realized</Th>}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => {
          const cell = metricCell(board, r as unknown as Record<string, unknown>);
          const isMe = me != null && r.wallet === me;
          const dirClass = cell.dir === "up" ? "text-l-up" : cell.dir === "down" ? "text-l-down" : "text-l-text";
          return (
            <tr
              key={r.wallet}
              className={`h-[30px] border-b border-l-hair transition-colors duration-150 hover:bg-l-surface ${
                isMe ? "border-l-2 border-l-up bg-l-surface" : ""
              }`}
            >
              <Td className="font-mono-plex tabular-nums text-l-muted">{i + 1}</Td>
              <Td className="font-mono-plex">
                <span data-ph-mask className="text-l-text">
                  {truncateWallet(r.wallet)}
                </span>
                {isMe && (
                  <span className="ml-2 rounded-[3px] border border-l-faint px-[5px] py-[1px] font-mono-plex text-[9px] uppercase tracking-[0.14em] text-l-muted">
                    You
                  </span>
                )}
              </Td>
              <Td align="right" className={`font-mono-plex tabular-nums ${dirClass}`}>
                {cell.text}
              </Td>
              {board === "profit" && (
                <Td align="right" className="font-mono-plex tabular-nums text-l-muted">
                  {r.realized_pnl != null ? fmtUsdShort(r.realized_pnl) : "—"}
                </Td>
              )}
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);

const fmtUsdShort = (micro: number): string => {
  const v = micro / 1e6;
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
};

const Th: FC<{ children: React.ReactNode; align?: "left" | "right"; className?: string }> = ({
  children,
  align = "left",
  className = "",
}) => (
  // §3: column headers use --text-2 (l-muted), never --text-3.
  <th
    className={`whitespace-nowrap px-3 py-2 font-mono-plex text-[10px] font-medium uppercase tracking-[0.16em] text-l-muted ${
      align === "right" ? "text-right" : "text-left"
    } ${className}`}
  >
    {children}
  </th>
);

const Td: FC<{ children: React.ReactNode; align?: "left" | "right"; className?: string }> = ({
  children,
  align = "left",
  className = "",
}) => (
  <td className={`whitespace-nowrap px-3 text-[12.5px] ${align === "right" ? "text-right" : "text-left"} ${className}`}>
    {children}
  </td>
);

export default LeaderboardPage;
