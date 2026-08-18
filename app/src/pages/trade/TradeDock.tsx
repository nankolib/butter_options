import type { FC, ReactNode } from "react";
import { useState } from "react";
import { SolscanLink } from "../../components/SolscanLink";
import { OpenOrders } from "./OpenOrders";
import { useTradeDockData } from "./useTradeDockData";
import type { ActivityEvent } from "./tradeHistory";
import type { Position } from "../portfolio/positions";
import type { WriterRow } from "../portfolio/writerRows";
import { Link } from "react-router-dom";
import { useTriggers, type ArmedTrigger } from "../../hooks/useTriggers";

/**
 * TradeDock — the full-width, collapsible bottom dock (design lock 2026-07-09).
 *
 * Tabs: POSITIONS · OPEN ORDERS · ORDER HISTORY · TRADE HISTORY · BALANCES, with
 * a live balances summary on the tab bar (USDC available · locked · SOL gas). All
 * data is REAL (useTradeDockData): positions/orders/balances are derived on-chain;
 * order/trade history are a BOUNDED recent-activity scan (no indexer exists yet),
 * labeled honestly. Empty panels show a one-line reason, never fabricated rows.
 *
 * Clicking a holder position loads that contract into the docked ticket via
 * onFocusMint. Collapse state persists.
 */
const DOCK_KEY = "opta.trade.dock";
type Tab = "positions" | "orders" | "orderHistory" | "tradeHistory" | "balances";
const TABS: [Tab, string][] = [
  ["positions", "Positions"],
  ["orders", "Open orders"],
  ["orderHistory", "Order history"],
  ["tradeHistory", "Trade history"],
  ["balances", "Balances"],
];

const fmt = (n: number) => {
  let s = n.toFixed(Math.abs(n) < 100 ? 4 : 2);
  if (/^-0(?:\.0+)?$/.test(s)) s = s.slice(1); // never negative-zero
  return `$${s}`;
};
const fmtStrike = (n: number) => (n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(n));

export const TradeDock: FC<{ onFocusMint?: (mint: string) => void }> = ({ onFocusMint }) => {
  const data = useTradeDockData();
  const [tab, setTab] = useState<Tab>("positions");
  // Default collapsed (matches the locked frames); expands on tab click or toggle.
  const [open, setOpen] = useState<boolean>(() => {
    try { return localStorage.getItem(DOCK_KEY) === "1"; } catch { return false; }
  });
  const toggle = () => setOpen((v) => {
    const next = !v;
    try { localStorage.setItem(DOCK_KEY, next ? "1" : "0"); } catch { /* ignore */ }
    return next;
  });

  const b = data.balances;

  return (
    <div data-testid="trade-dock" className="flex-none border-t border-l-hair bg-l-bg">
      {/* Tab bar */}
      <div className="flex h-[36px] items-center gap-1 px-4">
        <div className="flex items-center gap-1 overflow-x-auto">
          {TABS.map(([t, label]) => (
            <button
              key={t}
              type="button"
              data-testid="dock-tab"
              data-tab={t}
              onClick={() => { setTab(t); if (!open) toggle(); }}
              className={`whitespace-nowrap rounded-[6px] px-[11px] py-[5px] font-mono-plex text-[10px] uppercase tracking-[0.1em] transition-colors ${
                tab === t && open ? "bg-l-surface text-l-text" : "text-l-muted hover:text-l-text"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {/* Balances summary + expand toggle */}
        <div className="ml-auto flex items-center gap-[14px]">
          <span data-ph-mask className="hidden items-center gap-[12px] font-mono-plex text-[11px] tabular-nums text-l-muted sm:flex">
            <span>{b.usdcFree != null ? fmt(b.usdcFree) : "—"} <span className="text-l-faint">avail</span></span>
            <span>{b.usdcLocked != null ? fmt(b.usdcLocked) : "—"} <span className="text-l-faint">locked</span></span>
            <span>{b.sol != null ? `${b.sol.toFixed(3)} SOL` : "—"} <span className="text-l-faint">gas</span></span>
          </span>
          <button type="button" onClick={toggle}
            className="font-mono-plex text-[10px] uppercase tracking-[0.1em] text-l-muted transition-colors hover:text-l-text">
            {open ? "▾ collapse" : "▸ expand"}
          </button>
        </div>
      </div>

      {/* Body */}
      {open && (
        <div className="h-[204px] overflow-auto border-t border-l-hair px-4 py-3">
          {tab === "positions" && <PositionsTab holder={data.holderPositions} writer={data.writerRows} loading={data.loading.positions} onFocusMint={onFocusMint} />}
          {tab === "orders" && <div className="max-w-[720px]"><OpenOrders optionMint={null} /></div>}
          {tab === "orderHistory" && <HistoryTab events={data.orderHistory} loading={data.loading.history} bounded={data.historyBounded} empty="No recent orders in this session." />}
          {tab === "tradeHistory" && <HistoryTab events={data.tradeHistory} loading={data.loading.history} bounded={data.historyBounded} empty="No recent fills in this session." />}
          {tab === "balances" && <BalancesTab b={b} loading={data.loading.balances} />}
        </div>
      )}
    </div>
  );
};

// ---- Positions ------------------------------------------------------------
/** Armed exits, keyed by the option mint they protect. */
const exitLine = (t: ArmedTrigger): string => {
  const leg = t.leg === "tp" ? "TP" : "SL";
  const cmp = t.comparator === "ge" ? "≥" : "≤";
  return `${leg} ${cmp} ${t.threshold}`;
};

const PositionsTab: FC<{ holder: Position[]; writer: WriterRow[]; loading: boolean; onFocusMint?: (m: string) => void }> = ({ holder, writer, loading, onFocusMint }) => {
  // DISCOVERABILITY (founder walkthrough, 2026-08-18): armed exits were surfaced
  // only in Portfolio, but the founder looked for them HERE — next to the
  // position they protect, on the page where they were armed. Where someone
  // looks for their own data is data, not a preference.
  const { allTriggers } = useTriggers();
  const exitsFor = (mint: string) => allTriggers.filter((t) => t.optionMint === mint);

  if (loading && holder.length === 0 && writer.length === 0) return <SkeletonRows />;
  if (holder.length === 0 && writer.length === 0) {
    return <Empty>No open positions. Buy or write a contract to open one.</Empty>;
  }
  return (
    <div className="overflow-hidden rounded-[10px] border border-l-hair">
      <Row header cols="minmax(140px,1.4fr) 80px 80px 100px 90px 28px">
        <HCell>Contract</HCell><HCell>Role</HCell><HCell right>Size</HCell><HCell right>Value</HCell><HCell>State</HCell><HCell></HCell>
      </Row>
      {holder.map((p) => {
        const exits = exitsFor(p.id);
        return (
          <div key={p.id}>
            <Row cols="minmax(140px,1.4fr) 80px 80px 100px 90px 28px" onClick={onFocusMint ? () => onFocusMint(p.id) : undefined}>
              <Contract asset={p.asset} strike={p.strike} side={p.side} />
              <Cell><span style={{ color: "var(--color-l-up)" }}>Long</span></Cell>
              <Cell right>{p.contracts.toLocaleString()}</Cell>
              <Cell right>{fmt(p.currentValue)}</Cell>
              <Cell muted>{stateLabel(p.state)}</Cell>
              <Cell><SolscanLink kind="token" id={p.id} label="option mint" /></Cell>
            </Row>
            {exits.length > 0 && (
              <div className="flex flex-wrap items-center gap-2 border-b border-l-hair px-3 py-1.5">
                <span className="font-mono-plex text-[9px] uppercase tracking-[0.16em] text-l-muted">
                  Armed exits
                </span>
                {exits.map((t) => (
                  <span
                    key={t.pubkey}
                    className="rounded-[4px] border border-l-hair px-1.5 py-[1px] font-mono-plex text-[9.5px] tabular-nums text-l-text"
                  >
                    {exitLine(t)}
                    {/* An OCO pair is one decision, not two orders. Saying so here
                        stops a user cancelling one leg believing the other stands. */}
                    {t.ocoLink && <span className="ml-1 text-l-faint">OCO</span>}
                  </span>
                ))}
                <Link to="/portfolio" className="font-mono-plex text-[9.5px] text-l-up-text no-underline hover:underline">
                  manage &rarr;
                </Link>
              </div>
            )}
          </div>
        );
      })}
      {writer.map((w) => (
        <Row key={w.id} cols="minmax(140px,1.4fr) 80px 80px 100px 90px 28px">
          <Contract asset={w.asset} strike={w.strike} side={w.side} />
          <Cell><span style={{ color: "var(--color-l-down)" }}>Writer</span></Cell>
          <Cell right>{w.optionsSold.toLocaleString()}</Cell>
          <Cell right>{fmt(w.collateralDeposited)}</Cell>
          <Cell muted>{w.state.replace(/-/g, " ")}</Cell>
          <Cell><SolscanLink kind="account" id={w.vaultPda} label="vault" /></Cell>
        </Row>
      ))}
    </div>
  );
};

// ---- History (bounded scan) ----------------------------------------------
const HistoryTab: FC<{ events: ActivityEvent[]; loading: boolean; bounded: boolean; empty: string }> = ({ events, loading, bounded, empty }) => {
  if (loading && events.length === 0) return <SkeletonRows />;
  return (
    <div>
      {events.length === 0 ? (
        <Empty>{empty}</Empty>
      ) : (
        <div className="overflow-hidden rounded-[10px] border border-l-hair">
          <Row header cols="90px 70px 90px 70px 90px 1fr">
            <HCell>Event</HCell><HCell>Side</HCell><HCell right>Price</HCell><HCell right>Qty</HCell><HCell right>Age</HCell><HCell>Tx</HCell>
          </Row>
          {events.map((e) => (
            <Row key={e.sig + e.kind + e.ts} cols="90px 70px 90px 70px 90px 1fr">
              <Cell muted>{e.kind}</Cell>
              <Cell><span style={{ color: e.side === "buy" ? "var(--color-l-up)" : e.side === "sell" ? "var(--color-l-down)" : "var(--color-l-muted)" }}>{e.side ?? "—"}</span></Cell>
              <Cell right>{e.price != null ? fmt(e.price) : "—"}</Cell>
              <Cell right>{e.qty != null ? `×${e.qty}` : "—"}</Cell>
              <Cell right muted>{relTime(e.ts)}</Cell>
              <Cell>
                <span className="inline-flex items-center gap-1.5">
                  <span className="text-l-muted">{e.sig.slice(0, 6)}…</span>
                  <SolscanLink kind="tx" id={e.sig} label="transaction" />
                </span>
              </Cell>
            </Row>
          ))}
        </div>
      )}
      {bounded && (
        <p className="mt-[8px] font-mono-plex text-[9.5px] text-l-muted">
          Recent activity only — full history pending indexer.
        </p>
      )}
    </div>
  );
};

// ---- Balances -------------------------------------------------------------
const BalancesTab: FC<{ b: ReturnType<typeof useTradeDockData>["balances"]; loading: boolean }> = ({ b, loading }) => (
  <div className="max-w-[560px]">
    <div className="grid grid-cols-3 gap-px overflow-hidden rounded-[10px] border border-l-hair bg-l-hair">
      <BalCell label="USDC available" value={loading && b.usdcFree == null ? "…" : b.usdcFree != null ? fmt(b.usdcFree) : "—"} />
      <BalCell label="USDC locked" value={loading && b.usdcLocked == null ? "…" : b.usdcLocked != null ? fmt(b.usdcLocked) : "—"} />
      <BalCell label="SOL · gas" value={loading && b.sol == null ? "…" : b.sol != null ? b.sol.toFixed(4) : "—"} />
    </div>
    <p className="mt-[8px] font-mono-plex text-[9.5px] text-l-muted">
      Locked = resting-order escrows + written-vault collateral.
    </p>
  </div>
);

// ---- shared bits ----------------------------------------------------------
const Row: FC<{ children: ReactNode; cols: string; header?: boolean; onClick?: () => void }> = ({ children, cols, header, onClick }) => (
  <div
    onClick={onClick}
    className={`grid items-center border-b border-l-hair last:border-0 ${header ? "h-[28px] bg-l-surface" : "h-[30px]"} ${onClick ? "cursor-pointer hover:bg-l-surface" : ""}`}
    style={{ gridTemplateColumns: cols }}
  >
    {children}
  </div>
);
const HCell: FC<{ children?: ReactNode; right?: boolean }> = ({ children, right }) => (
  <span className={`px-3 font-mono-plex text-[9px] uppercase tracking-[0.1em] text-l-muted ${right ? "text-right" : ""}`}>{children}</span>
);
const Cell: FC<{ children: ReactNode; right?: boolean; muted?: boolean }> = ({ children, right, muted }) => (
  <span className={`px-3 font-mono-plex text-[12px] tabular-nums ${right ? "text-right" : ""} ${muted ? "text-l-muted" : "text-l-text"}`}>{children}</span>
);
const Contract: FC<{ asset: string; strike: number; side: "call" | "put" }> = ({ asset, strike, side }) => (
  <span className="flex items-center gap-[7px] px-3">
    <span className="h-[6px] w-[6px] flex-none rounded-full" style={{ background: side === "call" ? "var(--color-l-up)" : "var(--color-l-down)" }} />
    <span className="font-mono-plex text-[12px] text-l-text">{asset} {fmtStrike(strike)}{side === "call" ? "C" : "P"}</span>
  </span>
);
const BalCell: FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="bg-l-surface p-3">
    <div className="mb-1.5 font-mono-plex text-[9px] uppercase tracking-[0.12em] text-l-muted">{label}</div>
    <div className="font-mono-plex text-[16px] leading-none tabular-nums text-l-text" data-ph-mask>{value}</div>
  </div>
);
const Empty: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="py-4 font-mono-plex text-[11px] text-l-muted">{children}</div>
);
const SkeletonRows: FC = () => (
  <div className="space-y-[6px]">
    {Array.from({ length: 4 }).map((_, i) => (
      <div key={i} className="h-[24px] animate-l-pulse rounded-[4px] bg-l-surface" />
    ))}
  </div>
);

function stateLabel(s: Position["state"]): string {
  return s.replace(/-/g, " ");
}
function relTime(ts: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

export default TradeDock;
