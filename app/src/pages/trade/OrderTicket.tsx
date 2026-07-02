import type { FC, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import posthog from "posthog-js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { useProgram } from "../../hooks/useProgram";
import { useBook } from "../../hooks/useBook";
import { usePegFill, usePostOrder, useFillOrder, useFillWriterAsk } from "../../hooks/useOrderFlows";
import { calculateCallGreeks, calculatePutGreeks, getDefaultVolatility, applyVolSmile } from "../../utils/blackScholes";
import { TOKEN_2022_PROGRAM_ID, MARKET_SEED, PROGRAM_ID, DEVNET_USDC_MINT } from "../../utils/constants";
import {
  fetchOptionPriceQuote, describeOptionPriceQuoteStatus,
  OptionPriceQuoteFailure, type OptionPriceQuote,
} from "../../utils/optionPriceQuote";
import type { UnifiedChainRow } from "../../hooks/useUnifiedChain";

// Quote-on-demand short-TTL cache, keyed by series mint (premium is per-contract,
// size-independent). Browsing the chain never touches this — only the RFQ button.
const RFQ_TTL_MS = 15_000;
const rfqCache = new Map<string, { q: OptionPriceQuote; at: number }>();

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
type Side = "buy" | "sell" | "write";
type OrderType = "market" | "limit" | "stop" | "tpsl";
const LIVE_TYPES: OrderType[] = ["market", "limit"];

export const OrderTicket: FC<{
  row: UnifiedChainRow;
  spot: number | null;
  onDone: () => void;
  onLegacyBuy: (row: UnifiedChainRow) => void;
  /** Pre-seed the RFQ (e.g. the modal's one-shot on-open quote) so the ticket
   *  shows the protocol price immediately without a second click. */
  seedQuote?: OptionPriceQuote | null;
}> = ({ row, spot, onDone, onLegacyBuy, seedQuote = null }) => {
  const { publicKey } = useWallet();
  const { program } = useProgram();
  const { orders, refetch: refetchBook } = useBook();
  const peg = usePegFill();
  const post = usePostOrder();
  const fill = useFillOrder();
  const fillWA = useFillWriterAsk();

  const [side, setSide] = useState<Side>("buy");
  const [type, setType] = useState<OrderType>("market");
  const [qty, setQty] = useState(1);
  const [limitPrice, setLimitPrice] = useState<number>(0);
  const [slippagePct, setSlippagePct] = useState(5);
  const [held, setHeld] = useState<number | null>(null);
  const [usdcBalance, setUsdcBalance] = useState<number | null>(null); // dollars; for the Write collateral gate
  const [status, setStatus] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // RFQ (quote-on-demand) state.
  const [rfq, setRfq] = useState<OptionPriceQuote | null>(null);
  const [rfqLoading, setRfqLoading] = useState(false);
  const [rfqError, setRfqError] = useState<OptionPriceQuoteFailure | null>(null);

  const isSeries = row.provenance === "series";
  const isWrite = side === "write";
  // Pricing axis — American contracts (legacy OR series) price via the on-chain
  // get_option_price view. Routing (below) stays on `isSeries` (provenance).
  const useOnChainQuote = row.exerciseStyle === "american";

  // Reset the RFQ when the focused contract changes; seed from the caller's
  // one-shot quote when provided (modal on-open RFQ).
  useEffect(() => { setRfq(seedQuote); setRfqError(null); }, [row.vault, row.optionType, row.strike, seedQuote]);

  // On-chain quote-on-demand: fire get_option_price for this series (American
  // only). Short-TTL cached by mint; never auto-fires — button-triggered.
  async function requestQuote() {
    if (!program || !useOnChainQuote) return;
    const key = row.optionMint ?? `${row.vault}:${row.optionType}`;
    const hit = rfqCache.get(key);
    if (hit && Date.now() - hit.at < RFQ_TTL_MS) { setRfq(hit.q); setRfqError(null); return; }
    setRfqLoading(true); setRfqError(null);
    try {
      const marketPda = PublicKey.findProgramAddressSync([Buffer.from(MARKET_SEED), Buffer.from(row.asset)], PROGRAM_ID)[0];
      const mkt: any = await (program.account as any).optionsMarket.fetch(marketPda);
      const q = await fetchOptionPriceQuote(program as any, { publicKey: marketPda, account: { pythFeedId: mkt.pythFeedId } }, {
        strike: row.strike, expiryTs: row.expiry, side: row.optionType, exerciseStyle: "american", carryRateBps: 0,
      });
      rfqCache.set(key, { q, at: Date.now() });
      setRfq(q);
    } catch (e: any) {
      setRfqError(e instanceof OptionPriceQuoteFailure ? e : new OptionPriceQuoteFailure("unknown", null));
      setRfq(null);
    } finally {
      setRfqLoading(false);
    }
  }

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

  // USDC balance (dollars) — only needed for the Write collateral gate.
  useEffect(() => {
    let live = true;
    if (side !== "write" || !publicKey || !program) return;
    (async () => {
      try {
        const ata = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, publicKey, false, TOKEN_PROGRAM_ID);
        const bal = await program.provider.connection.getTokenAccountBalance(ata);
        if (live) setUsdcBalance(Number(bal.value.uiAmount ?? 0));
      } catch { if (live) setUsdcBalance(0); }
    })();
    return () => { live = false; };
  }, [side, publicKey, program]);

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

  // Model-price fallback. European → EUR model (correct). American → ONLY the
  // on-chain quote; never the EUR model (structurally too low). `mark` itself is
  // untouched below — Greeks keep the European approximation (accepted).
  const modelPremium = useOnChainQuote ? (rfq?.premiumPerContract ?? null) : (mark?.premium ?? null);
  // For Buy, a live RFQ (protocol ask) takes precedence over the cheap aggregate.
  const estPrice = type === "limit"
    ? limitPrice
    : ((side === "buy" ? rfq?.premiumPerContract : undefined) ?? refPrice ?? modelPremium ?? null);
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
      let phRoute: string | undefined; // buy·market dispatch route for analytics
      const ref = { asset: row.asset, vault: row.vault, optionMint: row.optionMint! };
      if (!isSeries) {
        if (side === "buy") { onLegacyBuy(row); setBusy(false); return; }
        setStatus({ kind: "err", msg: "Legacy listings are managed in Portfolio." });
        setBusy(false); return;
      }
      if (side === "write") {
        // Write = mint-on-fill sell side: post a WriterAsk (escrows strike×qty USDC).
        sig = await post.submit(ref, "writerAsk", limitPrice, qty, Math.floor(Date.now() / 1000));
      } else if (side === "buy" && type === "market") {
        // Best ask: a resting ask ≤ peg → take it; else fill the vault peg.
        const asks = orders
          .filter((o) => o.optionMint === row.optionMint && o.kind !== "bid")
          .sort((a, b) => a.price - b.price);
        const pegRef = mark?.premium ?? Infinity;
        if (asks.length && asks[0].price <= pegRef) {
          // Belt-and-suspenders on top of the shared book store: re-verify the
          // target order still exists on-chain before dispatch. A concurrent
          // cancel/fill could have closed it (→ 3012 AccountNotInitialized);
          // if so, refresh the shared book and ask the user to retry.
          const live = program
            ? await program.provider.connection.getAccountInfo(new PublicKey(asks[0].pubkey))
            : null;
          if (!live) {
            await refetchBook();
            setStatus({ kind: "err", msg: "That order just changed — book refreshed, please retry." });
            setBusy(false);
            return;
          }
          // Kind-aware: WriterAsks mint-on-fill via fill_writer_ask (distinct
          // account set); resaleAsks take contracts via fill_order.
          phRoute = asks[0].kind === "writerAsk" ? "writerAsk" : "fillOrder";
          sig = asks[0].kind === "writerAsk"
            ? await fillWA.submit(asks[0], qty)
            : await fill.submit(asks[0], qty);
        } else {
          phRoute = "peg";
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
      if (sig) {
        setStatus({ kind: "ok", msg: `Submitted · ${sig.slice(0, 8)}…` });
        const ev = side === "write" ? "trade_write_ask"
          : side === "buy" ? (type === "market" ? "trade_buy_market" : "trade_buy_limit")
          : (type === "market" ? "trade_sell_market" : "trade_sell_limit");
        posthog.capture(ev, {
          asset: row.asset, strike: row.strike, optionType: row.optionType, qty,
          price: type === "market" ? undefined : limitPrice, route: phRoute, sig,
        });
        void refetchBook();
        onDone();
      }
    } catch (e: any) {
      setStatus({ kind: "err", msg: (e?.message ?? String(e)).slice(0, 140) });
    } finally {
      setBusy(false);
    }
  }

  const submitting = busy || peg.submitting || post.submitting || fill.submitting || fillWA.submitting;
  const fmt = (n: number) => `$${n.toFixed(n < 100 ? 4 : 2)}`;

  // Write (WriterAsk) collateral gate — series+American only; collateral = strike × qty
  // (== collateral_per_contract on-chain). row.strike is the parsed vault strike, so no fetch.
  const writeNeed = row.strike * qty;
  const writeGate = !isWrite ? null
    : !isSeries ? "Write is series-only"
    : row.exerciseStyle !== "american" ? "Writer-asks are American-only"
    : (usdcBalance != null && usdcBalance < writeNeed) ? `Insufficient USDC · need ${fmt(writeNeed)}`
    : !(limitPrice > 0) ? "Set an ask price"
    : null;

  // Buy·Limit / Sell·Limit require a positive price — chain reverts (InvalidContractSize)
  // on price 0. Mirror the Write-mode gate rather than letting the tx fail.
  const limitGate = (!isWrite && type === "limit" && !(limitPrice > 0)) ? "Set a limit price" : null;

  return (
    <div className="border border-rule rounded-md p-5 bg-paper">
      {/* Header */}
      <div className="flex items-baseline justify-between mb-4">
        <div className="font-fraunces-text italic font-light text-ink text-[20px]">
          {row.asset} ${row.strike} {row.optionType === "call" ? "Call" : "Put"}
        </div>
        <div className={`font-mono text-[9px] uppercase tracking-[0.18em] ${
          row.provenance === "series" ? "text-crimson" : row.provenance === "epoch" ? "text-ink" : "text-ink-muted"
        }`}>
          {row.provenance}
        </div>
      </div>

      {/* Side */}
      <Segment options={[["buy", "Buy"], ["sell", "Sell"], ["write", "Write"]]} value={side} onChange={(v) => setSide(v as Side)} />

      {/* Type — Market/Limit live, Stop/TP-SL greyed. Hidden for Write (always a limit post). */}
      {!isWrite && (<>
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
      <p className="font-mono text-[9.5px] text-ink-muted/70 mb-3 -mt-1">Stop · TP/SL — Phase 4 keeper triggers (coming soon)</p>
      </>)}

      {/* Qty + price */}
      <Field label="Quantity">
        <input type="number" min={1} value={qty} onChange={(e) => setQty(Math.max(1, Number(e.target.value) || 1))}
          className="w-full bg-transparent border border-rule rounded px-3 py-2 font-mono text-[14px] text-ink outline-none focus:border-ink" />
      </Field>

      {(type === "limit" || isWrite) && (
        <Field label={isWrite ? "Ask price (USDC / contract)" : "Limit price (USDC / contract)"}>
          <input type="number" min={0} step="0.0001" value={limitPrice} onChange={(e) => setLimitPrice(Math.max(0, Number(e.target.value) || 0))}
            className="w-full bg-transparent border border-rule rounded px-3 py-2 font-mono text-[14px] text-ink outline-none focus:border-ink" />
        </Field>
      )}
      {type === "market" && !isWrite && (
        <Field label="Max slippage %">
          <input type="number" min={0} step="0.5" value={slippagePct} onChange={(e) => setSlippagePct(Math.max(0, Number(e.target.value) || 0))}
            className="w-full bg-transparent border border-rule rounded px-3 py-2 font-mono text-[14px] text-ink outline-none focus:border-ink" />
        </Field>
      )}

      {/* Write — collateral to lock (strike × qty) + wallet USDC */}
      {isWrite && (
        <div className="grid grid-cols-2 gap-px bg-rule border border-rule rounded-md overflow-hidden my-3">
          <Stat label="Collateral to lock" value={fmt(writeNeed)} sub="strike × qty" />
          <Stat label="Your USDC" value={<span data-ph-mask>{usdcBalance != null ? fmt(usdcBalance) : "…"}</span>} />
        </div>
      )}

      {!isWrite && (<>
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

      {/* RFQ — on-chain quote-on-demand (T5) */}
      {useOnChainQuote ? (
        <div className="mb-3">
          <button type="button" onClick={requestQuote} disabled={rfqLoading}
            className="w-full font-mono text-[10.5px] uppercase tracking-[0.18em] border border-rule rounded-md py-2 text-ink hover:bg-paper-2 transition-colors disabled:opacity-50 disabled:cursor-wait">
            {rfqLoading ? "Pricing on-chain…" : rfq ? "Re-quote" : "Request quote"}
          </button>
          {(rfq || rfqError) && (
            <div className="mt-2">
              {rfq && (
                <div className="font-mono text-[13px] text-ink">
                  Protocol quote · {fmt(rfq.premiumPerContract)}/contract · total {fmt(rfq.premiumPerContract * qty)}
                </div>
              )}
              <div className="font-mono text-[9.5px] text-ink-muted/70 mt-0.5">
                {describeOptionPriceQuoteStatus(rfqLoading, rfqError, rfq)}
              </div>
            </div>
          )}
        </div>
      ) : (
        <button type="button" disabled title="On-chain quote is American-only; EUR uses the model price"
          className="w-full font-mono text-[10.5px] uppercase tracking-[0.18em] border border-rule rounded-md py-2 mb-3 text-ink-muted/50 cursor-not-allowed">
          Request quote · model price (EUR)
        </button>
      )}
      </>)}

      {/* Submit */}
      <button type="button" disabled={submitting || sellNoBalance || !publicKey || (isWrite && !!writeGate) || !!limitGate}
        onClick={submit}
        className={`w-full font-mono text-[12px] uppercase tracking-[0.2em] rounded-md py-3 transition-colors ${
          submitting || sellNoBalance || !publicKey || (isWrite && !!writeGate) || !!limitGate ? "bg-paper-2 text-ink-muted cursor-not-allowed" : "bg-ink text-paper hover:opacity-90"
        }`}>
        {!publicKey ? "Connect wallet"
          : submitting ? "Submitting…"
          : isWrite ? (writeGate ?? `Write ${qty} · ask ${fmt(limitPrice)}`)
          : limitGate ? limitGate
          : sellNoBalance ? "No contracts held to sell"
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
