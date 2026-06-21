import type { FC, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { useProgram } from "../../hooks/useProgram";
import { useBook } from "../../hooks/useBook";
import { usePegFill, usePostOrder, useFillOrder } from "../../hooks/useOrderFlows";
import { calculateCallGreeks, calculatePutGreeks, getDefaultVolatility, applyVolSmile } from "../../utils/blackScholes";
import { TOKEN_2022_PROGRAM_ID } from "../../utils/constants";
import type { UnifiedChainRow } from "../../hooks/useUnifiedChain";

/**
 * OrderTicket — the write path for the v2 Trade page (Pass 2).
 *
 * Order types: Market | Limit (live). Stop / TP/SL are greyed "coming soon"
 * (Phase 4 keeper triggers — no handlers, no local triggers, T4).
 *
 * Routing (provenance × type × side):
 *   SERIES Buy·Market  → best ask: resting ask ≤ peg → fill_order; else fill_vault_peg
 *   SERIES Buy·Limit   → post_order BID (escrow USDC)
 *   SERIES Sell·Market → fill_order vs best resting BID
 *   SERIES Sell·Limit  → post_order ResaleAsk on HELD tokens (gated on balance)
 *   LEGACY Buy         → classic flow (existing BuyModal) via onLegacyBuy
 *   LEGACY Sell·Limit  → list via Portfolio (position-bound) — pointer only
 *
 * RFQ: "Request quote" renders but is NOT wired to the on-chain get_option_price
 * view this pass — that quote-on-demand + caching is Pass 4 (T5/T6).
 */
type Side = "buy" | "sell";
type OrderType = "market" | "limit" | "stop" | "tpsl";
const LIVE_TYPES: OrderType[] = ["market", "limit"];

export const OrderTicket: FC<{
  row: UnifiedChainRow;
  spot: number | null;
  onDone: () => void;
  onLegacyBuy: (row: UnifiedChainRow) => void;
}> = ({ row, spot, onDone, onLegacyBuy }) => {
  const { publicKey } = useWallet();
  const { program } = useProgram();
  const { orders } = useBook();
  const peg = usePegFill();
  const post = usePostOrder();
  const fill = useFillOrder();

  const [side, setSide] = useState<Side>("buy");
  const [type, setType] = useState<OrderType>("market");
  const [qty, setQty] = useState(1);
  const [limitPrice, setLimitPrice] = useState<number>(0);
  const [slippagePct, setSlippagePct] = useState(5);
  const [held, setHeld] = useState<number | null>(null);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const isSeries = row.provenance === "series";

  // Held balance of the focused series mint (for Sell·Limit gate + Sell·Market).
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

  // est. reference price off the cheap aggregate (Pass-0): ask for buy, bid for sell.
  const refPrice = side === "buy" ? row.bestAsk : row.bestBid;
  const days = Math.max(0, (row.expiry - Date.now() / 1000) / 86_400);

  // Cheap mark (carry r=0) as the fallback reference + greeks input.
  const mark = useMemo(() => {
    if (!spot || spot <= 0 || days <= 0) return null;
    const vol = getDefaultVolatility(row.asset);
    const g = row.optionType === "call"
      ? calculateCallGreeks(spot, row.strike, days, applyVolSmile(vol, spot, row.strike, row.asset), 0)
      : calculatePutGreeks(spot, row.strike, days, applyVolSmile(vol, spot, row.strike, row.asset), 0);
    return g;
  }, [spot, days, row.asset, row.optionType, row.strike]);

  const estPrice = (type === "limit" ? limitPrice : refPrice) ?? mark?.premium ?? null;
  const estTotal = estPrice != null ? estPrice * qty : null;

  // Readouts (T-spec): λ elasticity, decay (θ/day), no-liquidation reminder.
  const lambda = mark && estPrice && estPrice > 0 ? (mark.delta * (spot ?? 0)) / estPrice : null;
  const thetaPerDay = mark?.theta ?? null;

  // Pre-fill the limit price with the cheap mark when switching to Limit.
  useEffect(() => {
    if (type === "limit" && limitPrice === 0 && mark?.premium) setLimitPrice(Number(mark.premium.toFixed(4)));
  }, [type, mark]);

  const sellNoBalance = isSeries && side === "sell" && type === "limit" && (held ?? 0) < qty;

  async function submit() {
    setStatus(null);
    if (!publicKey) { setStatus({ kind: "err", msg: "Connect a wallet" }); return; }
    setBusy(true);
    try {
      let sig: string | null = null;
      const ref = { asset: row.asset, vault: row.vault, optionMint: row.optionMint! };
      if (!isSeries) {
        if (side === "buy") { onLegacyBuy(row); setBusy(false); return; }
        setStatus({ kind: "err", msg: "Legacy listings are managed in Portfolio." });
        setBusy(false); return;
      }
      if (side === "buy" && type === "market") {
        // Best ask: a resting ask ≤ peg → take it; else fill the vault peg.
        const asks = orders
          .filter((o) => o.optionMint === row.optionMint && o.kind !== "bid")
          .sort((a, b) => a.price - b.price);
        const pegRef = mark?.premium ?? Infinity;
        if (asks.length && asks[0].price <= pegRef) {
          sig = await fill.submit(asks[0], qty);
        } else {
          const maxPremium = (estPrice ?? mark?.premium ?? 0) * (1 + slippagePct / 100);
          sig = await peg.submit(ref, qty, maxPremium > 0 ? maxPremium : 1_000_000);
        }
      } else if (side === "buy" && type === "limit") {
        sig = await post.submit(ref, "bid", limitPrice, qty, Math.floor(Date.now() / 1000));
      } else if (side === "sell" && type === "market") {
        const bids = orders
          .filter((o) => o.optionMint === row.optionMint && o.kind === "bid")
          .sort((a, b) => b.price - a.price);
        if (!bids.length) { setStatus({ kind: "err", msg: "No resting bid to sell into." }); setBusy(false); return; }
        sig = await fill.submit(bids[0], qty);
      } else if (side === "sell" && type === "limit") {
        if (sellNoBalance) { setBusy(false); return; }
        sig = await post.submit(ref, "resaleAsk", limitPrice, qty, Math.floor(Date.now() / 1000));
      }
      if (sig) { setStatus({ kind: "ok", msg: `Submitted · ${sig.slice(0, 8)}…` }); onDone(); }
    } catch (e: any) {
      setStatus({ kind: "err", msg: (e?.message ?? String(e)).slice(0, 140) });
    } finally {
      setBusy(false);
    }
  }

  const submitting = busy || peg.submitting || post.submitting || fill.submitting;
  const fmt = (n: number) => `$${n.toFixed(n < 100 ? 4 : 2)}`;

  return (
    <div className="border border-rule rounded-md p-5 bg-paper">
      {/* Header */}
      <div className="flex items-baseline justify-between mb-4">
        <div className="font-fraunces-text italic font-light text-ink text-[20px]">
          {row.asset} ${row.strike} {row.optionType === "call" ? "Call" : "Put"}
        </div>
        <div className={`font-mono text-[9px] uppercase tracking-[0.18em] ${isSeries ? "text-crimson" : "text-ink-muted"}`}>
          {row.provenance}
        </div>
      </div>

      {/* Side */}
      <Segment options={[["buy", "Buy"], ["sell", "Sell"]]} value={side} onChange={(v) => setSide(v as Side)} />

      {/* Type — Market/Limit live, Stop/TP-SL greyed */}
      <div className="flex gap-px bg-rule border border-rule rounded-md overflow-hidden my-3">
        {(["market", "limit", "stop", "tpsl"] as OrderType[]).map((t) => {
          const live = LIVE_TYPES.includes(t);
          const label = t === "tpsl" ? "TP/SL" : t[0].toUpperCase() + t.slice(1);
          return (
            <button
              key={t}
              type="button"
              disabled={!live}
              onClick={() => live && setType(t)}
              title={live ? "" : "Phase 4 — coming soon"}
              className={`flex-1 font-mono text-[10.5px] uppercase tracking-[0.16em] px-2 py-2 transition-colors ${
                !live ? "bg-paper text-ink-muted/40 cursor-not-allowed"
                  : type === t ? "bg-ink text-paper" : "bg-paper text-ink-muted hover:text-ink"
              }`}
            >
              {label}{!live && " ·"}
            </button>
          );
        })}
      </div>
      {!LIVE_TYPES.includes(type) ? null : null}
      <p className="font-mono text-[9.5px] text-ink-muted/70 mb-3 -mt-1">Stop · TP/SL — Phase 4 keeper triggers (coming soon)</p>

      {/* Qty + price */}
      <Field label="Quantity">
        <input type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
          className="w-full bg-transparent border border-rule rounded px-3 py-2 font-mono text-[14px] text-ink outline-none focus:border-ink" />
      </Field>

      {type === "limit" && (
        <Field label="Limit price (USDC / contract)">
          <input type="number" min={0} step="0.0001" value={limitPrice} onChange={(e) => setLimitPrice(Math.max(0, Number(e.target.value) || 0))}
            className="w-full bg-transparent border border-rule rounded px-3 py-2 font-mono text-[14px] text-ink outline-none focus:border-ink" />
        </Field>
      )}
      {type === "market" && (
        <Field label="Max slippage %">
          <input type="number" min={0} step="0.5" value={slippagePct} onChange={(e) => setSlippagePct(Math.max(0, Number(e.target.value) || 0))}
            className="w-full bg-transparent border border-rule rounded px-3 py-2 font-mono text-[14px] text-ink outline-none focus:border-ink" />
        </Field>
      )}

      {/* Est price / total */}
      <div className="grid grid-cols-2 gap-px bg-rule border border-rule rounded-md overflow-hidden my-3">
        <Stat label={side === "buy" ? "Est. ask" : "Est. bid"} value={estPrice != null ? fmt(estPrice) : "—"} />
        <Stat label="Est. total" value={estTotal != null ? fmt(estTotal) : "—"} />
      </div>

      {/* Readouts */}
      <div className="grid grid-cols-3 gap-px bg-rule border border-rule rounded-md overflow-hidden mb-3">
        <Stat label="λ leverage" value={lambda != null ? `${lambda.toFixed(1)}×` : "—"} />
        <Stat label="θ decay / day" value={thetaPerDay != null ? fmt(thetaPerDay) : "—"} />
        <Stat label="Liquidation" value="None" sub="max loss = premium" />
      </div>

      {/* RFQ — Pass 4 (not wired) */}
      <button type="button" disabled title="Quote-on-demand ships in Pass 4"
        className="w-full font-mono text-[10.5px] uppercase tracking-[0.18em] border border-rule rounded-md py-2 mb-3 text-ink-muted/50 cursor-not-allowed">
        Request quote · Pass 4
      </button>

      {/* Submit */}
      <button type="button" disabled={submitting || sellNoBalance || !publicKey}
        onClick={submit}
        className={`w-full font-mono text-[12px] uppercase tracking-[0.2em] rounded-md py-3 transition-colors ${
          submitting || sellNoBalance || !publicKey ? "bg-paper-2 text-ink-muted cursor-not-allowed" : "bg-ink text-paper hover:opacity-90"
        }`}>
        {!publicKey ? "Connect wallet"
          : sellNoBalance ? "No contracts held to sell"
          : submitting ? "Submitting…"
          : `${side === "buy" ? "Buy" : "Sell"} ${qty} · ${type === "market" ? "Market" : "Limit"}`}
      </button>

      {isSeries && side === "sell" && type === "limit" && (
        <p className="font-mono text-[9.5px] text-ink-muted/70 mt-2">
          Sell·Limit lists held contracts (resale). Held: {held ?? "…"}. Writing new contracts to sell is Phase 3.
        </p>
      )}
      {!isSeries && (
        <p className="font-mono text-[9.5px] text-ink-muted/70 mt-2">
          Legacy contract — Buy routes to the classic vault/resale flow; sell-side listing lives in Portfolio.
        </p>
      )}

      {status && (
        <p className={`font-mono text-[10.5px] mt-3 ${status.kind === "ok" ? "text-ink" : "text-crimson"}`}>{status.msg}</p>
      )}
    </div>
  );
};

const Segment: FC<{ options: [string, string][]; value: string; onChange: (v: string) => void }> = ({ options, value, onChange }) => (
  <div className="flex gap-px bg-rule border border-rule rounded-md overflow-hidden">
    {options.map(([v, label]) => (
      <button key={v} type="button" onClick={() => onChange(v)}
        className={`flex-1 font-mono text-[11px] uppercase tracking-[0.18em] px-3 py-2 transition-colors ${
          value === v ? "bg-ink text-paper" : "bg-paper text-ink-muted hover:text-ink"
        }`}>
        {label}
      </button>
    ))}
  </div>
);

const Field: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <div className="mb-3">
    <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted mb-1.5">{label}</div>
    {children}
  </div>
);

const Stat: FC<{ label: string; value: ReactNode; sub?: string }> = ({ label, value, sub }) => (
  <div className="bg-paper p-3">
    <div className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-ink-muted mb-1.5">{label}</div>
    <div className="font-mono text-[15px] text-ink leading-none">{value}</div>
    {sub && <div className="font-mono text-[8.5px] uppercase tracking-[0.14em] text-ink-muted mt-1">{sub}</div>}
  </div>
);
