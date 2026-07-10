import type { FC, ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import posthog from "posthog-js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { useProgram } from "../../hooks/useProgram";
import { useBook, type BookOrder } from "../../hooks/useBook";
import { usePegFill, usePostOrder, useFillOrder, useFillWriterAsk } from "../../hooks/useOrderFlows";
import { deriveOrderPubkey } from "./orderFlows";
import { refreshAfterMutation } from "./orderRefresh";
import { planSweep, executeSweep, buildAskLevels, buildBidLevels, crossLimit } from "./marketSweep";
import { calculateCallGreeks, calculatePutGreeks, getDefaultVolatility, applyVolSmile } from "../../utils/blackScholes";
import { TOKEN_2022_PROGRAM_ID, MARKET_SEED, PROGRAM_ID, DEVNET_USDC_MINT } from "../../utils/constants";
import {
  fetchOptionPriceQuote, describeOptionPriceQuoteStatus, quoteFreshness,
  OptionPriceQuoteFailure, type OptionPriceQuote,
} from "../../utils/optionPriceQuote";
import type { UnifiedChainRow } from "../../hooks/useUnifiedChain";

// Quote-on-demand short-TTL cache, keyed by series mint (premium is per-contract,
// size-independent). Browsing the chain never touches this — only the RFQ button.
const RFQ_TTL_MS = 15_000;
const rfqCache = new Map<string, { q: OptionPriceQuote; at: number }>();

/**
 * OrderTicket — the write path for the v2 Trade page. Terminal design language
 * (design lock 2026-07-09): mono-plex numerals, hairline panels, side-colored
 * segments, one teal-fill primary submit.
 *
 * `variant`:
 *   "standalone" — full self-contained ticket (own header + RFQ request block).
 *   "docked"     — lives inside the docked ContractInspector, which owns the
 *                  header/badges + protocol-quote centerpiece + RFQ request, and
 *                  seeds this ticket's quote via `seedQuote`. Header + the RFQ
 *                  request block are suppressed to avoid duplication; every gate
 *                  (incl. H-05 American freshness) still runs off the seed quote.
 *
 * Routing (provenance × type × side):
 *   SERIES Buy·Market  → best ask: resting ask ≤ peg → fill_order; else fill_vault_peg
 *   SERIES Buy·Limit   → post_order BID (escrow USDC)
 *   SERIES Sell·Market → fill_order vs best resting BID
 *   SERIES Sell·Limit  → post_order ResaleAsk on HELD tokens (gated on balance)
 *   LEGACY Buy         → classic flow (existing BuyModal) via onLegacyBuy
 *   LEGACY Sell·Limit  → list via Portfolio (position-bound) — pointer only
 */
type Side = "buy" | "sell" | "write";
type OrderType = "market" | "limit" | "stop" | "tpsl";
const LIVE_TYPES: OrderType[] = ["market", "limit"];

const SIDE_VAR: Record<Side, string> = { buy: "--color-l-up", sell: "--color-l-down", write: "--color-l-text" };

export const OrderTicket: FC<{
  row: UnifiedChainRow;
  spot: number | null;
  onDone: () => void;
  onLegacyBuy: (row: UnifiedChainRow) => void;
  /** Pre-seed the RFQ (e.g. the inspector's on-open quote) so the ticket shows
   *  the protocol price immediately without a second click. */
  seedQuote?: OptionPriceQuote | null;
  variant?: "standalone" | "docked";
  /** Deep-link / caller-preselected side (loads the ticket ready to act). */
  initialSide?: Side;
}> = ({ row, spot, onDone, onLegacyBuy, seedQuote = null, variant = "standalone", initialSide }) => {
  const docked = variant === "docked";
  const { publicKey } = useWallet();
  const { program } = useProgram();
  const { orders } = useBook();
  const peg = usePegFill();
  const post = usePostOrder();
  const fill = useFillOrder();
  const fillWA = useFillWriterAsk();

  const [side, setSide] = useState<Side>(initialSide ?? "buy");
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
  // BUG-1: contracts the vault can still mint-on-fill. Null until the focused
  // vault is read; suppresses a Buy·Market that would route to an exhausted peg
  // and revert InsufficientVaultCollateral on-chain.
  const [pegRemaining, setPegRemaining] = useState<number | null>(null);

  const isSeries = row.provenance === "series";
  const isWrite = side === "write";
  // Pricing axis — American contracts (legacy OR series) price via the on-chain
  // get_option_price view. Routing (below) stays on `isSeries` (provenance).
  const useOnChainQuote = row.exerciseStyle === "american";

  // Follow a caller-driven side change (deep-link / row reselect).
  useEffect(() => { if (initialSide) setSide(initialSide); }, [initialSide]);

  // Reset the RFQ when the focused contract changes; seed from the caller's
  // one-shot quote when provided (inspector on-open RFQ).
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

  // BUG-1: derive remaining peg capacity from the focused vault (single-account
  // read — NOT a full scan). free = (total_collateral − early_exercise_payout) −
  // (total_options_minted − exercised_options) × collateral_per_token; remaining
  // contracts = floor(free / cpt). Only series (peg-backed) rows have a peg.
  useEffect(() => {
    let live = true;
    (async () => {
      if (!program || !isSeries) { if (live) setPegRemaining(null); return; }
      try {
        const v: any = await program.account.sharedVault.fetch(new PublicKey(row.vault));
        const cpt = v.strikePrice.toNumber(); // collateral_per_token = strike
        const net = v.totalCollateral.toNumber() - (v.earlyExercisePayout?.toNumber?.() ?? 0);
        const liveContracts = v.totalOptionsMinted.toNumber() - (v.exercisedOptions?.toNumber?.() ?? 0);
        const free = net - liveContracts * cpt;
        if (live) setPegRemaining(cpt > 0 ? Math.max(0, Math.floor(free / cpt)) : null);
      } catch { if (live) setPegRemaining(null); }
    })();
    return () => { live = false; };
  }, [program, isSeries, row.vault]);

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

  // Readouts: λ elasticity, decay (θ/day), no-liquidation reminder. λ is a greek
  // (elasticity Δ·S/V): V MUST be the model premium the delta was computed
  // against — not the transaction price — else it's an incoherent hybrid.
  const lambda = mark && mark.premium > 0 ? (mark.delta * (spot ?? 0)) / mark.premium : null;
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
      let removed: string[] = [];       // optimistically removed (fully-filled resting order)
      let added: BookOrder | undefined; // optimistically inserted (just-posted resting order)
      let sweepReport: string | null = null; // "Filled X of Y · avg $Z" for market sweeps
      const ref = { asset: row.asset, vault: row.vault, optionMint: row.optionMint! };
      const nonce = Math.floor(Date.now() / 1000);
      const me = publicKey.toBase58();
      const optimisticOrder = (kind: "bid" | "resaleAsk" | "writerAsk", qtyOverride?: number): BookOrder => ({
        pubkey: deriveOrderPubkey(row.optionMint!, publicKey, nonce),
        owner: me, optionMint: row.optionMint!, vault: row.vault, kind,
        price: limitPrice, qty: qtyOverride ?? qty, qtyInitial: qtyOverride ?? qty, nonce: String(nonce),
        createdAt: Math.floor(Date.now() / 1000),
        collateralPerContract: kind === "writerAsk" ? row.strike : 0,
      });
      // Vault peg as an ask level (American-only + priced on-chain) when a fresh
      // quote + free capacity exist.
      const pegAsk = (useOnChainQuote && rfq?.premiumPerContract != null && (pegRemaining ?? 0) > 0)
        ? rfq.premiumPerContract : null;
      if (!isSeries) {
        if (side === "buy") { onLegacyBuy(row); setBusy(false); return; }
        setStatus({ kind: "err", msg: "Legacy listings are managed in Portfolio." });
        setBusy(false); return;
      }
      if (side === "write") {
        // Write = mint-on-fill sell side: post a WriterAsk (escrows strike×qty USDC).
        sig = await post.submit(ref, "writerAsk", limitPrice, qty, nonce);
        if (sig) added = optimisticOrder("writerAsk");
      } else if (side === "buy" && type === "market") {
        // Multi-level sweep (Phase 1): [peg + resting asks] ascending, ≤4 levels
        // within slippage, in ONE tx. Self-trade: own asks filtered out.
        const levels = buildAskLevels(orders, row.optionMint!, me, pegAsk, pegRemaining ?? 0);
        const plan = planSweep({ side: "buy", qty, levels, slippagePct });
        if (!plan.legs.length) { setStatus({ kind: "err", msg: "No fillable liquidity within slippage." }); setBusy(false); return; }
        sig = await executeSweep(program!, ref, plan, slippagePct);
        if (sig) {
          removed = plan.legs.filter((l) => l.order && l.qty >= l.capacity).map((l) => l.order!.pubkey);
          phRoute = plan.legs.map((l) => l.source).join("+");
          sweepReport = `Filled ${plan.filledQty} of ${qty}${plan.filledQty < qty ? " · partial" : ""} · avg ${plan.avgPrice != null ? fmt(plan.avgPrice) : "—"}`;
        }
      } else if (side === "buy" && type === "limit") {
        // Marketable (limit ≥ best ask) → CROSS (sweep ≤ limit), then rest residual
        // at the limit (TWO-TX). Below best ask → rest a bid unchanged.
        const askLevels = buildAskLevels(orders, row.optionMint!, me, pegAsk, pegRemaining ?? 0);
        const bestAsk = askLevels.length ? Math.min(...askLevels.map((l) => l.price)) : null;
        if (bestAsk == null || limitPrice < bestAsk) {
          sig = await post.submit(ref, "bid", limitPrice, qty, nonce);
          if (sig) added = optimisticOrder("bid");
        } else {
          const cross = await crossLimit(program!, ref, { side: "buy", qty, limitPrice, taker: me, optionMint: row.optionMint!, orders, pegAsk, pegCapacity: pegRemaining ?? 0 });
          removed = cross.removed;
          const residual = qty - cross.filledQty;
          let restErr = false;
          if (residual > 0) {
            try { const rs = await post.submit(ref, "bid", limitPrice, residual, nonce); if (rs) { sig = rs; added = optimisticOrder("bid", residual); } }
            catch { restErr = true; }
          }
          if (!sig) sig = cross.sweepSigs[cross.sweepSigs.length - 1] ?? null;
          phRoute = "crossBuy";
          sweepReport = residual > 0
            ? (restErr
                ? `Filled ${cross.filledQty} of ${qty} · residual ${residual} failed to post — retry`
                : `Filled ${cross.filledQty}${cross.avgPrice != null ? ` · avg ${fmt(cross.avgPrice)}` : ""} · rested ${residual} @ ${fmt(limitPrice)}`)
            : `Filled ${cross.filledQty} of ${qty}${cross.avgPrice != null ? ` · avg ${fmt(cross.avgPrice)}` : ""}`;
        }
      } else if (side === "sell" && type === "market") {
        // Multi-level sweep into resting bids (descending), capped by held balance.
        const sellQty = Math.min(qty, held ?? 0);
        if (sellQty <= 0) { setStatus({ kind: "err", msg: "No contracts held to sell." }); setBusy(false); return; }
        const levels = buildBidLevels(orders, row.optionMint!, me);
        const plan = planSweep({ side: "sell", qty: sellQty, levels, slippagePct });
        if (!plan.legs.length) { setStatus({ kind: "err", msg: "No resting bid within slippage." }); setBusy(false); return; }
        sig = await executeSweep(program!, ref, plan, slippagePct);
        if (sig) {
          removed = plan.legs.filter((l) => l.order && l.qty >= l.capacity).map((l) => l.order!.pubkey);
          phRoute = "sweepSell";
          sweepReport = `Sold ${plan.filledQty} of ${qty}${plan.filledQty < qty ? " · partial" : ""} · avg ${plan.avgPrice != null ? fmt(plan.avgPrice) : "—"}`;
        }
      } else if (side === "sell" && type === "limit") {
        if (sellNoBalance) { setBusy(false); return; }
        // Marketable (limit ≤ best bid) → CROSS into bids, then rest residual as a
        // resale ask at the limit (TWO-TX). Above best bid → rest unchanged.
        const bidLevels = buildBidLevels(orders, row.optionMint!, me);
        const bestBid = bidLevels.length ? Math.max(...bidLevels.map((l) => l.price)) : null;
        if (bestBid == null || limitPrice > bestBid) {
          sig = await post.submit(ref, "resaleAsk", limitPrice, qty, nonce);
          if (sig) added = optimisticOrder("resaleAsk");
        } else {
          const cross = await crossLimit(program!, ref, { side: "sell", qty, limitPrice, taker: me, optionMint: row.optionMint!, orders, pegAsk: null, pegCapacity: 0 });
          removed = cross.removed;
          const residual = qty - cross.filledQty; // held ≥ qty (sellNoBalance gate) → residual is restable
          let restErr = false;
          if (residual > 0) {
            try { const rs = await post.submit(ref, "resaleAsk", limitPrice, residual, nonce); if (rs) { sig = rs; added = optimisticOrder("resaleAsk", residual); } }
            catch { restErr = true; }
          }
          if (!sig) sig = cross.sweepSigs[cross.sweepSigs.length - 1] ?? null;
          phRoute = "crossSell";
          sweepReport = residual > 0
            ? (restErr
                ? `Sold ${cross.filledQty} of ${qty} · residual ${residual} failed to post — retry`
                : `Sold ${cross.filledQty}${cross.avgPrice != null ? ` · avg ${fmt(cross.avgPrice)}` : ""} · rested ${residual} @ ${fmt(limitPrice)}`)
            : `Sold ${cross.filledQty} of ${qty}${cross.avgPrice != null ? ` · avg ${fmt(cross.avgPrice)}` : ""}`;
        }
      }
      if (sig) {
        setStatus({ kind: "ok", msg: sweepReport ? `${sweepReport} · ${sig.slice(0, 8)}…` : `Submitted · ${sig.slice(0, 8)}…` });
        const ev = side === "write" ? "trade_write_ask"
          : side === "buy" ? (type === "market" ? "trade_buy_market" : "trade_buy_limit")
          : (type === "market" ? "trade_sell_market" : "trade_sell_limit");
        posthog.capture(ev, {
          asset: row.asset, strike: row.strike, optionType: row.optionType, qty,
          price: type === "market" ? undefined : limitPrice, route: phRoute, sig,
        });
        // Two-layer refresh: optimistic (instant) + reconcile (chain truth) across
        // book, chain grid, and dock. onDone still refetches spot/legacy (td).
        refreshAfterMutation(program!, { removed, added });
        onDone();
      }
    } catch (e: any) {
      setStatus({ kind: "err", msg: (e?.message ?? String(e)).slice(0, 140) });
    } finally {
      setBusy(false);
    }
  }

  const submitting = busy || peg.submitting || post.submitting || fill.submitting || fillWA.submitting;
  // Never emit negative-zero ("$-0.0000" → "$0.0000").
  const fmt = (n: number) => {
    let s = n.toFixed(Math.abs(n) < 100 ? 4 : 2);
    if (/^-0(?:\.0+)?$/.test(s)) s = s.slice(1);
    return `$${s}`;
  };

  // Write (WriterAsk) collateral gate — series+American only; collateral = strike × qty.
  const writeNeed = row.strike * qty;
  const writeGate = !isWrite ? null
    : !isSeries ? "Write is series-only"
    : row.exerciseStyle !== "american" ? "Writer-asks are American-only"
    : (usdcBalance != null && usdcBalance < writeNeed) ? `Insufficient USDC · need ${fmt(writeNeed)}`
    : !(limitPrice > 0) ? "Set an ask price"
    : null;

  const limitGate = (!isWrite && type === "limit" && !(limitPrice > 0)) ? "Set a limit price" : null;

  // H-05: American rows must trade on a FRESH on-chain quote, never the EUR
  // model. Hard-block Buy (market/limit) and Write until the RFQ resolves fresh.
  const amerFresh = quoteFreshness(rfqLoading, rfqError, rfq);
  const needsFreshAmerQuote = useOnChainQuote && (side === "buy" || side === "write");
  const amerQuoteGate = needsFreshAmerQuote && !amerFresh.isFresh
    ? (amerFresh.statusReason ?? "Request an on-chain quote to continue")
    : null;

  // No peg-capacity button gate: the multi-level sweep routes a Buy·Market past
  // an exhausted peg to resting asks and reports an honest partial fill, so a
  // low peg no longer blocks the order.
  const disabled = submitting || sellNoBalance || !publicKey || (isWrite && !!writeGate) || !!limitGate || !!amerQuoteGate;

  return (
    <div className={docked ? "text-l-text" : "rounded-[10px] border border-l-hair bg-l-surface p-4 text-l-text"}>
      {/* Header — standalone only (docked inspector renders header/badges itself) */}
      {!docked && (
        <div className="mb-4 flex items-baseline justify-between">
          <div className="font-sans text-[16px] font-medium text-l-text">
            {row.asset} {fmtStrike(row.strike)} {row.optionType === "call" ? "Call" : "Put"}
          </div>
          <div
            className="font-mono-plex text-[9px] uppercase tracking-[0.16em]"
            style={{ color: row.provenance === "series" ? "var(--color-l-up)" : "var(--color-l-muted)" }}
          >
            {row.provenance}
          </div>
        </div>
      )}

      {/* Side — Buy / Sell / Write */}
      <Segment
        options={[["buy", "Buy"], ["sell", "Sell"], ["write", "Write"]]}
        value={side}
        onChange={(v) => setSide(v as Side)}
        colorVar={SIDE_VAR}
      />

      {/* Type — Market/Limit live, Stop/TP-SL gated. Hidden for Write (always a limit post). */}
      {!isWrite && (<>
        <div className="my-3 flex gap-px overflow-hidden rounded-[6px] border border-l-hair bg-l-hair">
          {(["market", "limit", "stop", "tpsl"] as OrderType[]).map((t) => {
            const live = LIVE_TYPES.includes(t);
            const label = t === "tpsl" ? "TP/SL" : t[0].toUpperCase() + t.slice(1);
            return (
              <button
                key={t}
                type="button"
                disabled={!live}
                onClick={() => live && setType(t)}
                title={live ? "" : "Phase 4 keeper triggers — coming soon"}
                className={`flex-1 px-2 py-2 font-mono-plex text-[10.5px] uppercase tracking-[0.14em] transition-colors ${
                  !live ? "cursor-not-allowed bg-l-surface text-l-faint"
                    : type === t ? "bg-l-surface-2 text-l-text" : "bg-l-surface text-l-muted hover:text-l-text"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
        {/* Honest inline state for the gated trigger tabs (Phase 4 placement is a
            follow-up slice: StopEntryBuy / TakeProfitSell taxonomy). */}
        <p className="-mt-1 mb-3 font-mono-plex text-[9.5px] text-l-muted">
          Stop · TP/SL — keeper triggers live on-chain; placement UI coming soon.
        </p>
      </>)}

      {/* Qty + price */}
      <Field label="Quantity">
        <NumInput value={qty} min={1} step={1} onChange={(n) => setQty(Math.max(1, n || 1))} />
      </Field>

      {(type === "limit" || isWrite) && (
        <Field label={isWrite ? "Ask price · USDC / contract" : "Limit price · USDC / contract"}>
          <NumInput value={limitPrice} min={0} step={0.0001} onChange={(n) => setLimitPrice(Math.max(0, n || 0))} />
        </Field>
      )}
      {type === "market" && !isWrite && (
        <Field label="Max slippage %">
          <NumInput value={slippagePct} min={0} step={0.5} onChange={(n) => setSlippagePct(Math.max(0, n || 0))} />
        </Field>
      )}

      {/* Write — collateral to lock (strike × qty) + wallet USDC */}
      {isWrite && (
        <div className="my-3 grid grid-cols-2 gap-px overflow-hidden rounded-[6px] border border-l-hair bg-l-hair">
          <Stat label="Collateral to lock" value={fmt(writeNeed)} sub="strike × qty" />
          <Stat label="Your USDC" value={<span data-ph-mask>{usdcBalance != null ? fmt(usdcBalance) : "…"}</span>} />
        </div>
      )}

      {!isWrite && (<>
        {/* Est price / total */}
        <div className="my-3 grid grid-cols-2 gap-px overflow-hidden rounded-[6px] border border-l-hair bg-l-hair">
          <Stat label={side === "buy" ? "Est. ask" : "Est. bid"} value={estPrice != null ? fmt(estPrice) : "—"} />
          <Stat label="Est. total" value={estTotal != null ? fmt(estTotal) : "—"} />
        </div>

        {/* λ / θ + no-liquidation badge (teal outline) */}
        <div className="mb-3 grid grid-cols-2 gap-px overflow-hidden rounded-[6px] border border-l-hair bg-l-hair">
          <Stat label="λ leverage" value={lambda != null ? `${lambda.toFixed(1)}×` : "—"} />
          <Stat label="θ decay / day" value={thetaPerDay != null ? fmt(thetaPerDay) : "—"} />
        </div>
        <div
          className="mb-3 flex items-center gap-[8px] rounded-[6px] border px-[11px] py-[8px]"
          style={{ borderColor: "var(--color-l-up)" }}
        >
          <span className="h-[6px] w-[6px] flex-none rounded-full" style={{ background: "var(--color-l-up)" }} />
          <span className="font-mono-plex text-[10.5px] text-l-text">No liquidation — max loss = premium</span>
        </div>
      </>)}

      {/* RFQ request block — standalone only. In docked mode the inspector renders
          the protocol-quote centerpiece + request/re-quote and seeds this ticket. */}
      {!docked && (useOnChainQuote ? (
        <div className="mb-3">
          <button type="button" onClick={requestQuote} disabled={rfqLoading}
            className="w-full rounded-[6px] border border-l-hair py-2 font-mono-plex text-[10.5px] uppercase tracking-[0.16em] text-l-text transition-colors hover:bg-l-surface disabled:cursor-wait disabled:opacity-50">
            {rfqLoading ? "Pricing on-chain…" : rfq ? "Re-quote" : "Request on-chain quote"}
          </button>
          {(rfq || rfqError) && (
            <div className="mt-2">
              {rfq && (
                <div className="font-mono-plex text-[13px] tabular-nums text-l-text">
                  Protocol quote · {fmt(rfq.premiumPerContract)}/contract · total {fmt(rfq.premiumPerContract * qty)}
                </div>
              )}
              <div className="mt-0.5 font-mono-plex text-[9.5px] text-l-muted">
                {describeOptionPriceQuoteStatus(rfqLoading, rfqError, rfq)}
              </div>
            </div>
          )}
        </div>
      ) : (!isWrite && (
        <button type="button" disabled title="On-chain quote is American-only; EUR uses the model price"
          className="mb-3 w-full cursor-not-allowed rounded-[6px] border border-l-hair py-2 font-mono-plex text-[10.5px] uppercase tracking-[0.16em] text-l-faint">
          Model price · EUR
        </button>
      )))}

      {/* Submit — the single teal-fill primary action */}
      <button type="button" disabled={disabled} onClick={submit}
        className={`w-full rounded-[6px] py-3 font-sans text-[13px] font-medium transition-opacity ${
          disabled ? "cursor-not-allowed bg-l-surface-2 text-l-muted" : "bg-l-up text-l-on-up hover:opacity-90"
        }`}>
        {!publicKey ? "Connect wallet"
          : submitting ? "Submitting…"
          : isWrite ? (writeGate ?? amerQuoteGate ?? `Write ${qty} · ask ${fmt(limitPrice)}`)
          : limitGate ? limitGate
          : amerQuoteGate ? amerQuoteGate
          : sellNoBalance ? "No contracts held to sell"
          : `${side === "buy" ? "Buy" : "Sell"} ${qty} · ${type === "market" ? "Market" : fmt(limitPrice)}`}
      </button>

      {isSeries && side === "sell" && type === "limit" && (
        <p className="mt-2 font-mono-plex text-[9.5px] text-l-muted">
          Sell·Limit lists held contracts (resale). Held: {held ?? "…"}.
        </p>
      )}
      {!isSeries && (
        <p className="mt-2 font-mono-plex text-[9.5px] text-l-muted">
          Legacy contract — Buy routes to the classic vault/resale flow; sell-side listing lives in Portfolio.
        </p>
      )}

      {status && (
        <p className="mt-3 font-mono-plex text-[10.5px]" style={{ color: status.kind === "ok" ? "var(--color-l-up)" : "var(--color-l-down)" }}>
          {status.msg}
        </p>
      )}
    </div>
  );
};

const fmtStrike = (n: number): string => (n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : String(n));

const Segment: FC<{
  options: [string, string][];
  value: string;
  onChange: (v: string) => void;
  colorVar?: Record<string, string>;
}> = ({ options, value, onChange, colorVar }) => (
  <div className="flex gap-px overflow-hidden rounded-[6px] border border-l-hair bg-l-hair">
    {options.map(([v, label]) => {
      const selected = value === v;
      const cv = colorVar?.[v];
      return (
        <button key={v} type="button" onClick={() => onChange(v)}
          className={`flex-1 px-3 py-2 font-sans text-[12px] font-medium transition-colors ${
            selected ? "text-l-text" : "bg-l-surface text-l-muted hover:text-l-text"
          }`}
          style={selected ? {
            background: cv ? `color-mix(in srgb, var(${cv}) 14%, transparent)` : undefined,
            color: cv && cv !== "--color-l-text" ? `var(${cv})` : undefined,
          } : undefined}>
          {label}
        </button>
      );
    })}
  </div>
);

const Field: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <div className="mb-3">
    <div className="mb-1.5 font-mono-plex text-[9.5px] uppercase tracking-[0.14em] text-l-muted">{label}</div>
    {children}
  </div>
);

const NumInput: FC<{ value: number; min: number; step: number; onChange: (n: number) => void }> = ({ value, min, step, onChange }) => (
  <input
    type="number"
    min={min}
    step={step}
    value={value}
    onChange={(e) => onChange(Number(e.target.value))}
    className="w-full rounded-[6px] border border-l-hair bg-transparent px-3 py-2 font-mono-plex text-[14px] tabular-nums text-l-text outline-none transition-colors focus:border-l-muted"
  />
);

const Stat: FC<{ label: string; value: ReactNode; sub?: string }> = ({ label, value, sub }) => (
  <div className="bg-l-surface p-3">
    <div className="mb-1.5 font-mono-plex text-[9px] uppercase tracking-[0.14em] text-l-muted">{label}</div>
    <div className="font-mono-plex text-[15px] leading-none tabular-nums text-l-text">{value}</div>
    {sub && <div className="mt-1 font-mono-plex text-[8.5px] uppercase tracking-[0.12em] text-l-muted">{sub}</div>}
  </div>
);
