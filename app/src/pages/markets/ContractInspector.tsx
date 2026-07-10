import type { FC, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useProgram } from "../../hooks/useProgram";
import { useBook } from "../../hooks/useBook";
import { useFillOrder } from "../../hooks/useOrderFlows";
import { calculateFullGreeks, getDefaultVolatility, applyVolSmile } from "../../utils/blackScholes";
import { MARKET_SEED, PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "../../utils/constants";
import { fetchOptionPriceQuote, type OptionPriceQuote } from "../../utils/optionPriceQuote";
import type { MarketRow } from "./useMarketsData";
import type { UnifiedChainRow } from "../../hooks/useUnifiedChain";
import { OrderTicket } from "../trade/OrderTicket";
import { OpenOrders } from "../trade/OpenOrders";
import { refreshAfterMutation } from "../trade/orderRefresh";
import { fmtPrice, fmtStrike, fmtInt, fmtUsdCompact, expiryLabel } from "./marketsView";

/**
 * ContractInspector — the shared contract detail surface (design lock 2026-07-09).
 *
 *   mode="modal"  (Markets): a fixed-overlay discovery card over a MarketRow —
 *     premium centerpiece + greeks + payoff + "Trade →" handoff. No execution.
 *   mode="docked" (Trade): the right-rail trading inspector over a UnifiedChainRow
 *     — header/badges, protocol-quote centerpiece (+ RFQ request/re-quote),
 *     collapsible analytics (greeks + payoff), position block when held, the
 *     shared OrderTicket, then the order book + recent-trades tape + open orders.
 *
 * Both modes share the terminal token language and the same pricing path
 * (fetchOptionPriceQuote for American, calculateFullGreeks model for EUR).
 * Oracle provenance is never named in either.
 */
export type ContractInspectorProps =
  | { mode?: "modal"; row: MarketRow; onClose: () => void }
  | {
      mode: "docked";
      row: UnifiedChainRow;
      spot: number | null;
      onDone: () => void;
      onLegacyBuy: (row: UnifiedChainRow) => void;
      onClose?: () => void;
    };

export const ContractInspector: FC<ContractInspectorProps> = (props) => {
  if (props.mode === "docked") return <DockedInspector {...props} />;
  return <ModalInspector row={props.row} onClose={props.onClose} />;
};

// ============================================================================
// Payoff geometry (shared) — 300×120 viewBox polyline + strike/BE markers.
// ============================================================================
function payoffGeometry(strike: number, premium: number, isCall: boolean) {
  const W = 300, H = 120, pad = 12;
  const lo = strike * 0.72, hi = strike * 1.28;
  const pay = (S: number) => (isCall ? Math.max(S - strike, 0) : Math.max(strike - S, 0)) - premium;
  const N = 30;
  const vals: [number, number][] = [];
  for (let i = 0; i <= N; i++) {
    const S = lo + ((hi - lo) * i) / N;
    vals.push([S, pay(S)]);
  }
  let maxP = Math.max(...vals.map((v) => v[1]), premium);
  let minP = Math.min(...vals.map((v) => v[1]), -premium);
  if (maxP === minP) maxP = minP + 1;
  const mapX = (S: number) => pad + ((S - lo) / (hi - lo)) * (W - 2 * pad);
  const mapY = (p: number) => pad + ((maxP - p) / (maxP - minP)) * (H - 2 * pad);
  const zeroY = mapY(0);
  const be = isCall ? strike + premium : strike - premium;
  return {
    zeroY: zeroY.toFixed(1),
    belowH: (H - zeroY).toFixed(1),
    strikeX: mapX(strike).toFixed(1),
    beX: mapX(be).toFixed(1),
    points: vals.map((v) => `${mapX(v[0]).toFixed(1)},${mapY(v[1]).toFixed(1)}`).join(" "),
  };
}

const PayoffSvg: FC<{ geo: ReturnType<typeof payoffGeometry> }> = ({ geo }) => (
  <svg viewBox="0 0 300 120" preserveAspectRatio="none" className="mt-[6px] block h-[112px] w-full">
    <rect x="0" y="0" width="300" height={geo.zeroY} fill="var(--color-l-up)" opacity="0.06" />
    <rect x="0" y={geo.zeroY} width="300" height={geo.belowH} fill="var(--color-l-down)" opacity="0.06" />
    <line x1="0" y1={geo.zeroY} x2="300" y2={geo.zeroY} stroke="var(--color-l-hair)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
    <line x1={geo.strikeX} y1="0" x2={geo.strikeX} y2="120" stroke="var(--color-l-faint)" strokeWidth="1" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
    <polyline points={geo.points} fill="none" stroke="var(--color-l-text)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    <circle cx={geo.beX} cy={geo.zeroY} r="3" fill="var(--color-l-text)" />
  </svg>
);

const Badge: FC<{ children: ReactNode; fill?: "up" | "down"; tone?: "muted" | "up" | "faint" }> = ({ children, fill, tone }) => {
  if (fill) {
    return (
      <span
        className="rounded-[4px] px-[7px] py-[3px] font-mono-plex text-[9.5px] font-medium tracking-[0.1em]"
        style={{
          background: fill === "up" ? "var(--color-l-up)" : "var(--color-l-down)",
          color: fill === "up" ? "var(--color-l-on-up)" : "var(--color-l-on-down)",
        }}
      >
        {children}
      </span>
    );
  }
  const color = tone === "up" ? "var(--color-l-up)" : tone === "faint" ? "var(--color-l-faint)" : "var(--color-l-muted)";
  return (
    <span className="rounded-[4px] border px-[7px] py-[3px] font-mono-plex text-[9.5px] tracking-[0.1em]" style={{ color, borderColor: "var(--color-l-hair)" }}>
      {children}
    </span>
  );
};

// ============================================================================
// Docked inspector (Trade rail) — UnifiedChainRow
// ============================================================================
const ANALYTICS_KEY = "opta.trade.analytics";

const DockedInspector: FC<{
  row: UnifiedChainRow;
  spot: number | null;
  onDone: () => void;
  onLegacyBuy: (row: UnifiedChainRow) => void;
}> = ({ row, spot, onDone, onLegacyBuy }) => {
  const { publicKey } = useWallet();
  const { program } = useProgram();
  const { orders } = useBook();
  const fill = useFillOrder();

  const isCall = row.optionType === "call";
  const isAmerican = row.exerciseStyle === "american";
  const isSeries = row.provenance === "series";
  const settled = row.isSettled;
  const days = Math.max(0, (row.expiry - Date.now() / 1000) / 86_400);

  const vol = useMemo(
    () => (spot && spot > 0 ? applyVolSmile(getDefaultVolatility(row.asset), spot, row.strike, row.asset) : getDefaultVolatility(row.asset)),
    [spot, row.asset, row.strike],
  );
  const greeks = useMemo(
    () => (spot && spot > 0 ? calculateFullGreeks(row.optionType, spot, row.strike, days, vol, 0) : null),
    [spot, row.optionType, row.strike, days, vol],
  );

  // Protocol quote (RFQ) — American only; auto-fires on focus change, re-quotable.
  const useRfq = !settled && isAmerican;
  const [rfq, setRfq] = useState<OptionPriceQuote | null>(null);
  const [rfqStatus, setRfqStatus] = useState<"idle" | "loading" | "ok" | "fail">("idle");
  const [rfqAt, setRfqAt] = useState<number | null>(null);

  async function requestQuote() {
    if (!program || !useRfq) return;
    setRfqStatus("loading");
    try {
      const marketPda = PublicKey.findProgramAddressSync([Buffer.from(MARKET_SEED), Buffer.from(row.asset)], PROGRAM_ID)[0];
      const mkt: any = await (program.account as any).optionsMarket.fetch(marketPda);
      const q = await fetchOptionPriceQuote(program as any, { publicKey: marketPda, account: { pythFeedId: mkt.pythFeedId } }, {
        strike: row.strike, expiryTs: row.expiry, side: row.optionType, exerciseStyle: "american", carryRateBps: 0,
      });
      setRfq(q); setRfqAt(Date.now()); setRfqStatus("ok");
    } catch {
      setRfq(null); setRfqStatus("fail");
    }
  }

  useEffect(() => {
    let live = true;
    setRfq(null); setRfqStatus("idle"); setRfqAt(null);
    if (!program || !useRfq) return;
    (async () => {
      setRfqStatus("loading");
      try {
        const marketPda = PublicKey.findProgramAddressSync([Buffer.from(MARKET_SEED), Buffer.from(row.asset)], PROGRAM_ID)[0];
        const mkt: any = await (program.account as any).optionsMarket.fetch(marketPda);
        const q = await fetchOptionPriceQuote(program as any, { publicKey: marketPda, account: { pythFeedId: mkt.pythFeedId } }, {
          strike: row.strike, expiryTs: row.expiry, side: row.optionType, exerciseStyle: "american", carryRateBps: 0,
        });
        if (live) { setRfq(q); setRfqAt(Date.now()); setRfqStatus("ok"); }
      } catch {
        if (live) { setRfq(null); setRfqStatus("fail"); }
      }
    })();
    return () => { live = false; };
  }, [program, useRfq, row.asset, row.strike, row.expiry, row.optionType]);

  const livePremium = useRfq ? (rfq?.premiumPerContract ?? null) : null;
  const premium = livePremium ?? greeks?.premium ?? null;
  const breakeven = premium != null ? (isCall ? row.strike + premium : row.strike - premium) : null;

  const mid = row.bestBid != null && row.bestAsk != null ? (row.bestBid + row.bestAsk) / 2 : null;
  const quoteCaption = settled
    ? "Settled"
    : useRfq
      ? livePremium != null
        ? `mid · bid ${row.bestBid != null ? fmtPrice(row.bestBid) : "—"} / ask ${row.bestAsk != null ? fmtPrice(row.bestAsk) : "—"}`
        : rfqStatus === "loading" ? "Pulling a fresh signed quote — valid ~30s."
        : "No live quote. Pull a fresh signed quote — valid ~30s."
      : "Model estimate · EUR";

  // Analytics collapse (desktop default open, mobile default collapsed; persists).
  const [analyticsOpen, setAnalyticsOpen] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem(ANALYTICS_KEY);
      if (v === "0") return false;
      if (v === "1") return true;
    } catch { /* ignore */ }
    return typeof window !== "undefined" ? !window.matchMedia("(max-width: 1024px)").matches : true;
  });
  const toggleAnalytics = () => setAnalyticsOpen((v) => {
    const next = !v;
    try { localStorage.setItem(ANALYTICS_KEY, next ? "1" : "0"); } catch { /* ignore */ }
    return next;
  });

  // Held balance (series) + close-into-best-bid.
  const [held, setHeld] = useState<number | null>(null);
  const [posStatus, setPosStatus] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    let live = true;
    setHeld(null);
    const mint = row.optionMint;
    if (!isSeries || !mint || !publicKey || !program) return;
    (async () => {
      try {
        const ata = getAssociatedTokenAddressSync(new PublicKey(mint), publicKey, false, TOKEN_2022_PROGRAM_ID);
        const bal = await program.provider.connection.getTokenAccountBalance(ata);
        if (live) setHeld(Number(bal.value.amount));
      } catch { if (live) setHeld(0); }
    })();
    return () => { live = false; };
  }, [isSeries, row.optionMint, publicKey, program]);

  const itm = spot != null && (isCall ? spot > row.strike : spot < row.strike);

  async function closePosition() {
    setPosStatus(null);
    const bestBid = orders
      .filter((o) => o.optionMint === row.optionMint && o.kind === "bid")
      .sort((a, b) => b.price - a.price)[0];
    if (!bestBid) { setPosStatus({ kind: "err", msg: "No resting bid to close into." }); return; }
    setClosing(true);
    try {
      const sig = await fill.submit(bestBid, held ?? 1);
      if (sig) {
        setPosStatus({ kind: "ok", msg: `Closed · ${sig.slice(0, 8)}…` });
        if (program) refreshAfterMutation(program, { removed: (held ?? 1) >= bestBid.qty ? [bestBid.pubkey] : [] });
        onDone();
      }
    } catch (e: any) { setPosStatus({ kind: "err", msg: (e?.message ?? String(e)).slice(0, 120) }); }
    finally { setClosing(false); }
  }

  const provLabel = isSeries ? "BOOK-BACKED" : row.provenance === "epoch" ? "EPOCH" : "LEGACY";
  const payoff = premium != null ? payoffGeometry(row.strike, premium, isCall) : null;

  return (
    <div data-testid="trade-inspector" data-mint={row.optionMint ?? undefined} className="text-l-text">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-baseline gap-[8px]">
            <span className="font-sans text-[16px] font-medium text-l-text">
              {row.asset} {fmtStrike(row.strike)}{isCall ? "C" : "P"}
            </span>
            <span className="font-mono-plex text-[11px] text-l-muted">· {expiryLabel(row.expiry)}</span>
          </div>
          <div className="mt-[7px] flex flex-wrap items-center gap-[6px]">
            <Badge fill={isCall ? "up" : "down"}>{isCall ? "CALL" : "PUT"}</Badge>
            <Badge tone="muted">{isAmerican ? "AMERICAN" : "EUROPEAN"}</Badge>
            <Badge tone={isSeries ? "up" : "faint"}>{provLabel}</Badge>
          </div>
        </div>
        <span className="flex items-center gap-[5px] font-mono-plex text-[10px] uppercase tracking-[0.12em]" style={{ color: settled ? "var(--color-l-faint)" : "var(--color-l-up)" }}>
          <span className="inline-block h-[6px] w-[6px] rounded-full" style={{ background: settled ? "var(--color-l-faint)" : "var(--color-l-up)" }} />
          {settled ? "Settled" : "Live"}
        </span>
      </div>

      {/* Protocol-quote centerpiece */}
      <div className="mt-[14px] border-y border-l-hair py-[13px]">
        <div className="flex items-center justify-between">
          <span className="font-mono-plex text-[9px] uppercase tracking-[0.14em] text-l-muted">
            {settled ? "Settlement" : "Protocol quote"}
          </span>
          {useRfq && (
            <button type="button" onClick={requestQuote} disabled={rfqStatus === "loading"}
              className="font-mono-plex text-[9.5px] uppercase tracking-[0.1em] text-l-muted transition-colors hover:text-l-text disabled:opacity-50">
              {rfqStatus === "loading" ? "↻ pricing…" : rfqAt ? `↻ ${Math.max(0, Math.round((Date.now() - rfqAt) / 1000))}s ago` : "Request on-chain quote"}
            </button>
          )}
        </div>
        <div className="mt-[6px] flex items-baseline gap-[6px]">
          <span className="font-mono-plex text-[30px] font-medium leading-none tabular-nums text-l-text">
            {premium != null ? fmtPrice(premium) : "—"}
          </span>
          <span className="font-mono-plex text-[12px] text-l-muted">USDC</span>
          {mid != null && <span className="ml-auto font-mono-plex text-[11px] tabular-nums text-l-muted">mid {fmtPrice(mid)}</span>}
        </div>
        <div className="mt-[5px] font-mono-plex text-[10px] text-l-muted">{quoteCaption}</div>
        {useRfq && premium == null && rfqStatus !== "loading" && (
          <button type="button" onClick={requestQuote}
            className="mt-[9px] w-full rounded-[6px] border border-l-hair py-2 font-mono-plex text-[10.5px] uppercase tracking-[0.14em] text-l-text transition-colors hover:bg-l-surface">
            Request on-chain quote
          </button>
        )}
      </div>

      {/* Collapsible ANALYTICS — greeks + payoff */}
      <div className="border-b border-l-hair">
        <button type="button" onClick={toggleAnalytics} data-testid="analytics-toggle" aria-expanded={analyticsOpen}
          className="flex w-full items-center justify-between py-[11px]">
          <span className="font-mono-plex text-[9px] uppercase tracking-[0.14em] text-l-muted">Analytics</span>
          <span className="font-mono-plex text-[11px] text-l-muted">{analyticsOpen ? "▾" : "▸"}</span>
        </button>
        {analyticsOpen && (
          <div data-testid="analytics-body" className="pb-[13px]">
            {greeks && !settled ? (
              <div className="grid grid-cols-5 gap-[6px]">
                {[
                  ["Δ", greeks.delta.toFixed(2)],
                  ["Γ", greeks.gamma.toFixed(3)],
                  ["Θ", greeks.theta.toFixed(2)],
                  ["V", greeks.vega.toFixed(2)],
                  ["IV", `${(vol * 100).toFixed(0)}%`],
                ].map(([k, v]) => (
                  <div key={k} className="flex flex-col gap-[3px] rounded-[6px] border border-l-hair px-[8px] py-[7px]">
                    <span className="font-mono-plex text-[9px] uppercase tracking-[0.08em] text-l-muted">{k}</span>
                    <span className="font-mono-plex text-[13px] tabular-nums text-l-text">{v}</span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="font-mono-plex text-[11px] text-l-muted">Greeks unavailable — spot warming up.</div>
            )}
            {payoff && !settled && (
              <div className="mt-[12px]">
                <PayoffSvg geo={payoff} />
                <div className="mt-[5px] flex justify-between font-mono-plex text-[10px] text-l-muted">
                  <span>Strike {fmtStrike(row.strike)}</span>
                  {breakeven != null && <span>Breakeven {fmtPrice(breakeven)}</span>}
                </div>
                <div className="mt-[4px] font-mono-plex text-[9px] text-l-muted">Greeks + IV are model values.</div>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Position block — held series contracts only */}
      {isSeries && (held ?? 0) > 0 && (
        <div className="mt-[14px] rounded-[10px] border border-l-hair p-[12px]">
          <div className="mb-[9px] flex items-center justify-between">
            <span className="font-mono-plex text-[9px] uppercase tracking-[0.14em] text-l-muted">Your position</span>
            <span className="font-mono-plex text-[9.5px] uppercase tracking-[0.1em]" style={{ color: "var(--color-l-up)" }}>Long +{held}</span>
          </div>
          <div className="grid grid-cols-3 gap-[8px]">
            <PosStat label="Mark" value={greeks ? fmtPrice(greeks.premium) : "—"} />
            <PosStat label="Value" value={greeks ? fmtPrice(greeks.premium * (held ?? 0)) : "—"} />
            <PosStat label="Break-even" value={breakeven != null ? fmtPrice(breakeven) : "—"} />
          </div>
          <div className="mt-[10px] flex gap-[8px]">
            <button type="button" onClick={closePosition} disabled={closing}
              className="flex-1 rounded-[6px] border border-l-hair py-[8px] font-sans text-[12px] font-medium text-l-text transition-colors hover:bg-l-surface disabled:opacity-40 disabled:cursor-not-allowed">
              {closing ? "Closing…" : "Close"}
            </button>
            <button type="button" disabled={!(isAmerican && itm)}
              title={isAmerican ? (itm ? "Exercise runs via Portfolio" : "Out of the money") : "European — exercise at settlement"}
              className="flex-1 rounded-[6px] border border-l-hair py-[8px] font-sans text-[12px] font-medium text-l-muted transition-colors hover:text-l-text disabled:opacity-40 disabled:cursor-not-allowed">
              Exercise
            </button>
          </div>
          <div className="mt-[6px] font-mono-plex text-[8.5px] text-l-muted">Cost basis is per-fill; unrealized PnL shows once indexed.</div>
          {posStatus && (
            <p className="mt-[6px] font-mono-plex text-[10px]" style={{ color: posStatus.kind === "ok" ? "var(--color-l-up)" : "var(--color-l-down)" }}>{posStatus.msg}</p>
          )}
        </div>
      )}

      {/* Order entry — the shared ticket (docked variant, quote seeded from above) */}
      <div className="mt-[14px]">
        <OrderTicket row={row} spot={spot} onDone={onDone} onLegacyBuy={onLegacyBuy} seedQuote={rfq} variant="docked" />
      </div>

      {/* Open orders (this contract). Order book + recent-trades tape live in
          the dedicated middle column (BookAndTape) on ≥1280px, not the rail. */}
      <div className="mt-[18px] border-t border-l-hair pt-[14px]">
        <OpenOrders optionMint={row.optionMint} />
      </div>
    </div>
  );
};

const PosStat: FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex flex-col gap-[3px]">
    <span className="font-mono-plex text-[8.5px] uppercase tracking-[0.1em] text-l-muted">{label}</span>
    <span className="font-mono-plex text-[13px] tabular-nums text-l-text">{value}</span>
  </div>
);

// ============================================================================
// Modal inspector (Markets discovery) — MarketRow. Unchanged behavior.
// ============================================================================
const ModalInspector: FC<{ row: MarketRow; onClose: () => void }> = ({ row, onClose }) => {
  const navigate = useNavigate();
  const { program } = useProgram();
  const isCall = row.side === "call";
  const settled = row.status !== "open";
  const spot = row.spot;
  const days = Math.max(0, (row.expiry - Date.now() / 1000) / 86_400);

  const vol = useMemo(
    () =>
      spot && spot > 0
        ? applyVolSmile(getDefaultVolatility(row.asset), spot, row.strike, row.asset)
        : getDefaultVolatility(row.asset),
    [spot, row.asset, row.strike],
  );
  const greeks = useMemo(
    () => (!settled && spot && spot > 0 ? calculateFullGreeks(row.side, spot, row.strike, days, vol, 0) : null),
    [settled, spot, row.side, row.strike, days, vol],
  );

  const useRfq = !settled && row.exerciseStyle === "american";
  const [rfq, setRfq] = useState<OptionPriceQuote | null>(null);
  const [rfqFailed, setRfqFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setRfq(null);
    setRfqFailed(false);
    if (!program || !useRfq) return;
    (async () => {
      try {
        const marketPda = PublicKey.findProgramAddressSync(
          [Buffer.from(MARKET_SEED), Buffer.from(row.asset)],
          PROGRAM_ID,
        )[0];
        const mkt: any = await (program.account as any).optionsMarket.fetch(marketPda);
        const q = await fetchOptionPriceQuote(
          program as any,
          { publicKey: marketPda, account: { pythFeedId: mkt.pythFeedId } },
          { strike: row.strike, expiryTs: row.expiry, side: row.side, exerciseStyle: "american", carryRateBps: 0 },
        );
        if (live) setRfq(q);
      } catch {
        if (live) setRfqFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [program, useRfq, row.asset, row.strike, row.expiry, row.side, settled]);

  const livePremium = useRfq ? (rfq?.premiumPerContract ?? null) : null;
  const premium = livePremium ?? greeks?.premium ?? null;
  const rfqNote = settled
    ? ""
    : !useRfq
      ? "Model price"
      : livePremium != null
        ? "Protocol quote"
        : rfqFailed
          ? "Model estimate — live quote warming up"
          : "Pricing on-chain…";
  const breakeven = premium != null ? (isCall ? row.strike + premium : row.strike - premium) : null;

  const payoff = useMemo(() => (premium != null ? payoffGeometry(row.strike, premium, isCall) : null), [premium, row.strike, isCall]);

  const goTrade = () => {
    navigate(
      `/trade?asset=${encodeURIComponent(row.asset)}&expiry=${row.expiry}&strike=${row.strike}&side=${row.side}`,
    );
  };

  const statusLabel = settled ? (row.status === "settled" ? "Settled" : "Expired") : "Active";

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[300] flex items-end justify-center bg-l-overlay p-0 sm:items-center sm:p-10"
    >
      <div
        data-testid="inspector"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-full w-full max-w-full flex-col gap-[14px] overflow-auto rounded-t-[14px] border border-l-hair bg-l-surface-2 p-[18px] sm:w-[400px] sm:rounded-[10px]"
      >
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-[9px]">
              <span className="font-sans text-[17px] font-medium text-l-text">
                {row.asset} {fmtStrike(row.strike)}
              </span>
              <Badge fill={isCall ? "up" : "down"}>{isCall ? "CALL" : "PUT"}</Badge>
            </div>
            <div className="mt-1 flex items-center gap-[7px] font-mono-plex text-[12px] text-l-muted">
              <span>{expiryLabel(row.expiry)}</span>
              <span className="text-l-muted">·</span>
              <span className="flex items-center gap-[5px]">
                <span
                  className="inline-block h-[6px] w-[6px] rounded-full"
                  style={{ background: settled ? "var(--color-l-faint)" : "var(--color-l-up)" }}
                />
                {statusLabel}
              </span>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="px-[2px] text-[20px] leading-none text-l-muted hover:text-l-text">
            ×
          </button>
        </div>

        {/* Centerpiece: premium (live) or settlement (settled) */}
        <div className="flex items-baseline justify-between border-y border-l-hair py-[14px]">
          <span className="font-mono-plex text-[9px] uppercase tracking-[0.13em] text-l-muted">
            {settled ? "Settlement price" : "Premium / contract"}
          </span>
          <div className="flex items-baseline gap-[6px]">
            <span className="font-mono-plex text-[30px] font-medium leading-none tabular-nums text-l-text">
              {settled
                ? row.settlementPrice != null
                  ? fmtPrice(row.settlementPrice)
                  : "—"
                : premium != null
                  ? fmtPrice(premium)
                  : "—"}
            </span>
            <span className="font-mono-plex text-[12px] text-l-muted">USDC</span>
          </div>
        </div>
        {!settled && rfqNote && (
          <span className="-mt-[6px] font-mono-plex text-[10px] text-l-muted">{rfqNote}</span>
        )}

        {/* Greeks (live only) — model values */}
        {!settled && greeks && (
          <>
            <div className="grid grid-cols-5 gap-[6px]">
              {[
                ["Delta", greeks.delta.toFixed(2)],
                ["Gamma", greeks.gamma.toFixed(3)],
                ["Theta", greeks.theta.toFixed(2)],
                ["Vega", greeks.vega.toFixed(2)],
                ["IV", ((row.iv ?? vol) * 100).toFixed(0) + "%"],
              ].map(([k, v]) => (
                <div key={k} className="flex flex-col gap-[3px] rounded-[6px] border border-l-hair px-[9px] py-[8px]">
                  <span className="font-mono-plex text-[9px] uppercase tracking-[0.1em] text-l-muted">{k}</span>
                  <span className="font-mono-plex text-[14px] tabular-nums text-l-text">{v}</span>
                </div>
              ))}
            </div>
            <span className="-mt-[8px] font-mono-plex text-[9px] text-l-muted">Greeks + IV are model values.</span>
          </>
        )}

        {/* Payoff diagram (live, premium known) */}
        {!settled && payoff && (
          <div>
            <span className="font-mono-plex text-[9px] uppercase tracking-[0.13em] text-l-muted">Payoff at expiry</span>
            <PayoffSvg geo={payoff} />
            <div className="mt-[5px] flex justify-between font-mono-plex text-[10px] text-l-muted">
              <span>Strike {fmtStrike(row.strike)}</span>
              {breakeven != null && <span>Breakeven {fmtPrice(breakeven)}</span>}
            </div>
          </div>
        )}

        {/* OI · vault · spot */}
        <div className="flex justify-between border-y border-l-hair py-[11px]">
          {[
            ["Open interest", fmtInt(row.openInterest)],
            ["Vault depth", fmtUsdCompact(row.vaultTvl ?? 0)],
            ["Spot", row.spot != null ? fmtPrice(row.spot) : "—"],
          ].map(([k, v]) => (
            <div key={k} className="flex flex-col gap-[3px]">
              <span className="font-mono-plex text-[9px] uppercase tracking-[0.1em] text-l-muted">{k}</span>
              <span className="font-mono-plex text-[13px] tabular-nums text-l-text">{v}</span>
            </div>
          ))}
        </div>

        {/* Actions */}
        {!settled && (
          <div className="flex gap-[10px]">
            <button
              type="button"
              onClick={goTrade}
              className="flex-1 rounded-[6px] bg-l-up py-[11px] font-sans text-[13px] font-medium text-l-on-up transition-opacity duration-200 hover:opacity-90"
            >
              Trade →
            </button>
            <button
              type="button"
              onClick={goTrade}
              className="flex-none rounded-[6px] border border-l-muted px-[18px] py-[11px] font-sans text-[13px] font-medium text-l-text transition-colors duration-200 hover:border-l-text"
            >
              Write
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ContractInspector;
