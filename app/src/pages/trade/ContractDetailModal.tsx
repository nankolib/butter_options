import type { FC, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useProgram } from "../../hooks/useProgram";
import { useBook, type BookOrder } from "../../hooks/useBook";
import { usePegFill, useFillOrder } from "../../hooks/useOrderFlows";
import { calculateFullGreeks, getDefaultVolatility, applyVolSmile } from "../../utils/blackScholes";
import { TOKEN_2022_PROGRAM_ID, MARKET_SEED, PROGRAM_ID } from "../../utils/constants";
import { fetchOptionPriceQuote, type OptionPriceQuote } from "../../utils/optionPriceQuote";
import type { UnifiedChainRow } from "../../hooks/useUnifiedChain";

/**
 * ContractDetailModal — Pro-only deep dive (Pass 6). Header + 6-stat strip +
 * FE payoff diagram + full greeks + order-book ladder (real levels + labeled
 * vault peg + spread) + position row (when held) + Buy CTA. Fires exactly ONE
 * on-chain RFQ (get_option_price) on open; everything else is FE-computed.
 * Simple persona never opens this (stays jargon-free).
 */
export const ContractDetailModal: FC<{
  row: UnifiedChainRow;
  spot: number | null;
  onClose: () => void;
  onDone: () => void;
}> = ({ row, spot, onClose, onDone }) => {
  const { publicKey } = useWallet();
  const { program } = useProgram();
  const { orders } = useBook();
  const peg = usePegFill();
  const fill = useFillOrder();

  const isSeries = row.provenance === "series";
  const [rfq, setRfq] = useState<OptionPriceQuote | null>(null);
  const [rfqStatus, setRfqStatus] = useState("");
  const [held, setHeld] = useState<number | null>(null);
  const [qty, setQty] = useState(1);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const days = Math.max(0, (row.expiry - Date.now() / 1000) / 86_400);
  const dte = Math.max(0, Math.ceil(days));
  const vol = useMemo(
    () => (spot && spot > 0 ? applyVolSmile(getDefaultVolatility(row.asset), spot, row.strike, row.asset) : getDefaultVolatility(row.asset)),
    [spot, row.asset, row.strike],
  );
  const greeks = useMemo(
    () => (spot && spot > 0 ? calculateFullGreeks(row.optionType, spot, row.strike, days, vol, 0) : null),
    [spot, row.optionType, row.strike, days, vol],
  );

  // Premium for payoff/BE = the protocol RFQ when available, else the cheap mark.
  const premium = rfq?.premiumPerContract ?? greeks?.premium ?? null;
  const breakeven = premium != null ? (row.optionType === "call" ? row.strike + premium : row.strike - premium) : null;

  // One RFQ on open (series American only).
  useEffect(() => {
    let live = true;
    if (!program || !isSeries) { setRfqStatus(isSeries ? "" : "EUR — model price only"); return; }
    setRfqStatus("Pricing on-chain…");
    (async () => {
      try {
        const marketPda = PublicKey.findProgramAddressSync([Buffer.from(MARKET_SEED), Buffer.from(row.asset)], PROGRAM_ID)[0];
        const mkt: any = await (program.account as any).optionsMarket.fetch(marketPda);
        const q = await fetchOptionPriceQuote(program as any, { publicKey: marketPda, account: { pythFeedId: mkt.pythFeedId } }, {
          strike: row.strike, expiryTs: row.expiry, side: row.optionType, exerciseStyle: "american", carryRateBps: 0,
        });
        if (live) { setRfq(q); setRfqStatus(`Protocol quote · oracle spot $${q.spotUsed.toFixed(2)}`); }
      } catch { if (live) setRfqStatus("On-chain quote unavailable"); }
    })();
    return () => { live = false; };
  }, [program, row.optionMint]);

  // Held balance (series).
  useEffect(() => {
    let live = true;
    setHeld(null);
    if (!isSeries || !row.optionMint || !publicKey || !program) return;
    (async () => {
      try {
        const ata = getAssociatedTokenAddressSync(new PublicKey(row.optionMint!), publicKey, false, TOKEN_2022_PROGRAM_ID);
        const bal = await program.provider.connection.getTokenAccountBalance(ata);
        if (live) setHeld(Number(bal.value.amount));
      } catch { if (live) setHeld(0); }
    })();
    return () => { live = false; };
  }, [isSeries, row.optionMint, publicKey, program]);

  // Order book for this series: real asks + bids, plus the labeled vault peg level.
  const ladder = useMemo(() => {
    const mine = orders.filter((o) => o.optionMint === row.optionMint);
    const asks = mine.filter((o) => o.kind !== "bid").sort((a, b) => b.price - a.price); // high→low (best at bottom)
    const bids = mine.filter((o) => o.kind === "bid").sort((a, b) => b.price - a.price); // high→low (best at top)
    const pegLevel = rfq ? { price: rfq.premiumPerContract, qty: null as number | null, peg: true } : null;
    const maxQty = Math.max(1, ...mine.map((o) => o.qty));
    return { asks, bids, pegLevel, maxQty };
  }, [orders, row.optionMint, rfq]);

  const itm = spot != null && (row.optionType === "call" ? spot > row.strike : spot < row.strike);
  const fmt = (n: number) => `$${n.toFixed(n < 100 ? 4 : 2)}`;

  async function buy() {
    setStatus(null);
    if (!publicKey) { setStatus({ kind: "err", msg: "Connect a wallet" }); return; }
    if (!isSeries || !row.optionMint || premium == null) return;
    setBusy(true);
    try {
      const sig = await peg.submit({ asset: row.asset, vault: row.vault, optionMint: row.optionMint }, qty, premium * 1.15);
      if (sig) { setStatus({ kind: "ok", msg: `Bought ${qty} · ${sig.slice(0, 8)}…` }); onDone(); }
    } catch (e: any) { setStatus({ kind: "err", msg: (e?.message ?? String(e)).slice(0, 140) }); }
    finally { setBusy(false); }
  }

  async function closePosition() {
    setStatus(null);
    const bestBid = ladder.bids[0] as BookOrder | undefined;
    if (!bestBid) { setStatus({ kind: "err", msg: "No resting bid to close into." }); return; }
    setBusy(true);
    try {
      const sig = await fill.submit(bestBid, Math.min(qty, held ?? 1));
      if (sig) { setStatus({ kind: "ok", msg: `Closed · ${sig.slice(0, 8)}…` }); onDone(); }
    } catch (e: any) { setStatus({ kind: "err", msg: (e?.message ?? String(e)).slice(0, 140) }); }
    finally { setBusy(false); }
  }

  const submitting = busy || peg.submitting || fill.submitting;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 backdrop-blur-sm p-4 sm:p-8" onClick={onClose}>
      <div className="bg-paper border border-rule rounded-lg shadow-2xl w-full max-w-[920px] my-8" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-start justify-between p-6 border-b border-rule">
          <div>
            <div className="font-fraunces-text italic font-light text-ink text-[26px] leading-tight">
              {row.asset} ${row.strike} {row.optionType === "call" ? "Call" : "Put"}
            </div>
            <div className="flex items-center gap-2 mt-2">
              <Badge tone={isSeries ? "crimson" : "muted"}>{row.provenance}</Badge>
              {row.exerciseStyle === "american" && <Badge tone="muted">american</Badge>}
              <span className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-ink-muted">
                {new Date(row.expiry * 1000).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })} · {dte}d
              </span>
            </div>
          </div>
          <button type="button" onClick={onClose} className="font-mono text-ink-muted hover:text-ink text-[20px] leading-none px-2">×</button>
        </div>

        {/* Stat strip */}
        <div className="grid grid-cols-3 md:grid-cols-6 gap-px bg-rule border-b border-rule">
          <Stat label="Mark · model" value={greeks ? fmt(greeks.premium) : "—"} />
          <Stat label="Protocol · RFQ" value={rfq ? fmt(rfq.premiumPerContract) : "—"} />
          <Stat label="Spot" value={spot != null ? fmt(spot) : "—"} />
          <Stat label="IV" value={`${((rfq?.volAnnualized ?? vol) * 100).toFixed(1)}%`} />
          <Stat label="Breakeven" value={breakeven != null ? fmt(breakeven) : "—"} />
          <Stat label="DTE" value={`${dte}d`} />
        </div>

        <div className="grid lg:grid-cols-2 gap-px bg-rule">
          {/* Payoff + greeks */}
          <div className="bg-paper p-6">
            <SectionLabel>Payoff at expiry</SectionLabel>
            {spot != null && premium != null
              ? <PayoffDiagram spot={spot} strike={row.strike} premium={premium} side={row.optionType} />
              : <Empty>Spot unavailable</Empty>}
            {breakeven != null && premium != null && (
              <p className="font-sans text-[13px] text-ink-body leading-snug mt-3">
                Pay {fmt(premium)} now. Profit if {row.asset} is{" "}
                {row.optionType === "call" ? "above" : "below"} {fmt(breakeven)} by{" "}
                {new Date(row.expiry * 1000).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}.
                The most you can lose is {fmt(premium)}.
              </p>
            )}
            <SectionLabel className="mt-6">Greeks</SectionLabel>
            <div className="grid grid-cols-3 gap-3">
              {greeks ? (
                <>
                  <Greek sym="Δ" name="delta" val={greeks.delta.toFixed(3)} />
                  <Greek sym="Γ" name="gamma" val={greeks.gamma.toFixed(4)} />
                  <Greek sym="Θ" name="theta/day" val={fmt(greeks.theta)} />
                  <Greek sym="V" name="vega/1%" val={fmt(greeks.vega)} />
                  <Greek sym="ρ" name="rho/1%" val={fmt(greeks.rho)} />
                  <Greek sym="λ" name="leverage" val={`${greeks.lambda.toFixed(1)}×`} />
                </>
              ) : <Empty>—</Empty>}
            </div>
          </div>

          {/* Order book + trade */}
          <div className="bg-paper p-6">
            <SectionLabel>Order book</SectionLabel>
            <div className="font-mono text-[12px]">
              {ladder.asks.map((o) => <Level key={o.pubkey} price={o.price} qty={o.qty} max={ladder.maxQty} side="ask" />)}
              {ladder.pegLevel && <Level price={ladder.pegLevel.price} qty={null} max={ladder.maxQty} side="ask" label="vault peg" />}
              <div className="flex items-center justify-between py-1.5 my-1 border-y border-rule-soft text-ink-muted text-[10.5px] uppercase tracking-[0.18em]">
                <span>spread</span>
                <span>{ladder.asks.length && ladder.bids.length ? fmt((ladder.asks[ladder.asks.length - 1].price) - ladder.bids[0].price) : "—"}</span>
              </div>
              {ladder.bids.map((o) => <Level key={o.pubkey} price={o.price} qty={o.qty} max={ladder.maxQty} side="bid" />)}
              {!ladder.asks.length && !ladder.bids.length && !ladder.pegLevel && <Empty>No resting orders</Empty>}
            </div>
            <p className="font-mono text-[9.5px] text-ink-muted/70 mt-1">{rfqStatus}</p>

            {/* Position row */}
            {isSeries && (held ?? 0) > 0 && (
              <div className="border border-rule rounded-md p-3 mt-4">
                <div className="font-mono text-[12px] text-ink mb-2">
                  <span className="text-teal">●</span> OPEN +{held} · mark {greeks ? fmt(greeks.premium) : "—"} · value {greeks ? fmt(greeks.premium * (held ?? 0)) : "—"}
                  {breakeven != null && <> · BE {fmt(breakeven)}</>}
                </div>
                <div className="flex gap-2">
                  <button type="button" onClick={closePosition} disabled={submitting || !ladder.bids.length}
                    className="flex-1 font-mono text-[11px] uppercase tracking-[0.16em] border border-rule rounded py-2 text-ink hover:bg-paper-2 disabled:opacity-40 disabled:cursor-not-allowed">Close</button>
                  <button type="button" disabled={!(row.exerciseStyle === "american" && itm)}
                    title={row.exerciseStyle === "american" ? (itm ? "Exercise runs via Portfolio (Pyth-pull flow)" : "Out of the money") : "European — exercise at settlement"}
                    className="flex-1 font-mono text-[11px] uppercase tracking-[0.16em] border border-rule rounded py-2 text-ink-muted hover:text-ink disabled:opacity-40 disabled:cursor-not-allowed">Exercise</button>
                </div>
              </div>
            )}

            {/* Buy */}
            {isSeries && (
              <div className="mt-4">
                <div className="flex items-center gap-2 mb-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted">Qty</span>
                  <input type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
                    className="w-20 bg-transparent border border-rule rounded px-2 py-1 font-mono text-[13px] text-ink outline-none focus:border-ink" />
                  <span className="font-mono text-[11px] text-ink-muted">≈ {premium != null ? fmt(premium * qty) : "—"} total</span>
                </div>
                <button type="button" onClick={buy} disabled={submitting || !publicKey || premium == null}
                  className={`w-full font-mono text-[12px] uppercase tracking-[0.2em] rounded-md py-3 transition-colors ${
                    submitting || !publicKey || premium == null ? "bg-paper-2 text-ink-muted cursor-not-allowed" : "bg-ink text-paper hover:opacity-90"
                  }`}>
                  {!publicKey ? "Connect wallet" : submitting ? "Submitting…" : `Buy ${qty}`}
                </button>
              </div>
            )}
            {status && <p className={`font-mono text-[10.5px] mt-3 ${status.kind === "ok" ? "text-ink" : "text-crimson"}`}>{status.msg}</p>}
          </div>
        </div>
      </div>
    </div>
  );
};

// ---- payoff SVG ----
const PayoffDiagram: FC<{ spot: number; strike: number; premium: number; side: "call" | "put" }> = ({ spot, strike, premium, side }) => {
  const W = 360, H = 160, pad = 8;
  const lo = Math.min(strike, spot) * 0.6, hi = Math.max(strike, spot) * 1.4;
  const pnl = (s: number) => (side === "call" ? Math.max(s - strike, 0) : Math.max(strike - s, 0)) - premium;
  const pts = Array.from({ length: 60 }, (_, i) => { const s = lo + ((hi - lo) * i) / 59; return { s, p: pnl(s) }; });
  const maxP = Math.max(...pts.map((p) => p.p), premium), minP = Math.min(...pts.map((p) => p.p), -premium);
  const x = (s: number) => pad + ((s - lo) / (hi - lo)) * (W - 2 * pad);
  const y = (p: number) => pad + (1 - (p - minP) / (maxP - minP || 1)) * (H - 2 * pad);
  const be = side === "call" ? strike + premium : strike - premium;
  const poly = pts.map((p) => `${x(p.s).toFixed(1)},${y(p.p).toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: 160 }}>
      <line x1={pad} y1={y(0)} x2={W - pad} y2={y(0)} stroke="#D8CFBE" strokeWidth="1" />
      <line x1={x(be)} y1={pad} x2={x(be)} y2={H - pad} stroke="#0F766E" strokeWidth="1" strokeDasharray="3 3" />
      <line x1={x(spot)} y1={pad} x2={x(spot)} y2={H - pad} stroke="#504B41" strokeWidth="0.75" strokeDasharray="1 3" />
      <polyline points={poly} fill="none" stroke="#D7263D" strokeWidth="1.75" />
      <text x={x(be)} y={H - 1} fontSize="8" fill="#0F766E" textAnchor="middle" fontFamily="monospace">BE</text>
      <text x={x(spot)} y={10} fontSize="8" fill="#504B41" textAnchor="middle" fontFamily="monospace">spot</text>
    </svg>
  );
};

const Level: FC<{ price: number; qty: number | null; max: number; side: "ask" | "bid"; label?: string }> = ({ price, qty, max, side, label }) => (
  <div className="relative flex items-center justify-between py-1 px-1">
    <div className={`absolute inset-y-0 ${side === "ask" ? "right-0 bg-crimson/10" : "right-0 bg-teal/10"}`} style={{ width: qty ? `${Math.min(100, (qty / max) * 100)}%` : "0%" }} />
    <span className={`relative ${side === "ask" ? "text-crimson" : "text-teal"}`}>${price.toFixed(price < 100 ? 4 : 2)}</span>
    <span className="relative text-ink-muted">{label ?? (qty ?? "—")}</span>
  </div>
);

const Stat: FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="bg-paper p-3">
    <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-ink-muted mb-1">{label}</div>
    <div className="font-mono text-[14px] text-ink leading-none">{value}</div>
  </div>
);
const Greek: FC<{ sym: string; name: string; val: string }> = ({ sym, name, val }) => (
  <div className="border border-rule-soft rounded p-2">
    <div className="font-mono text-[13px] text-ink">{sym} <span className="text-ink-muted text-[9px] uppercase tracking-[0.14em]">{name}</span></div>
    <div className="font-mono text-[13px] text-ink-body mt-0.5">{val}</div>
  </div>
);
const SectionLabel: FC<{ children: ReactNode; className?: string }> = ({ children, className = "" }) => (
  <div className={`font-mono text-[10px] uppercase tracking-[0.2em] text-ink-muted mb-3 ${className}`}>{children}</div>
);
const Empty: FC<{ children: ReactNode }> = ({ children }) => (
  <div className="font-mono text-[11px] text-ink-muted py-4">{children}</div>
);
const Badge: FC<{ children: ReactNode; tone: "crimson" | "muted" }> = ({ children, tone }) => (
  <span className={`font-mono text-[8.5px] uppercase tracking-[0.18em] px-2 py-0.5 rounded-full border ${tone === "crimson" ? "text-crimson border-crimson/40" : "text-ink-muted border-rule"}`}>{children}</span>
);
