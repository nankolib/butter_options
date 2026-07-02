import type { FC } from "react";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { usePaperPalette } from "../../hooks";
import { PaperGrain } from "../../components/layout";
import { AppNav } from "../../components/AppNav";
import { TradeStatementHeader } from "./TradeStatementHeader";
import { AssetDropdown } from "./AssetDropdown";
import { ExpiryTabs } from "./ExpiryTabs";
import { TradeFooter } from "./TradeFooter";
import { TradeChainV2, type FocusedContract, type DetailTarget } from "./TradeChainV2";
import { OrderTicket } from "./OrderTicket";
import { OrderBookLadder } from "./OrderBookLadder";
import { OpenOrders } from "./OpenOrders";
import { BuyModal } from "./BuyModal";
import { calculateCallPremium, calculatePutPremium, getDefaultVolatility, applyVolSmile } from "../../utils/blackScholes";

// Lazy-load the chart-heavy surfaces (lightweight-charts / TradingView embed)
// so they leave the initial chunk and load only when their surface mounts (T-perf).
const PriceChart = lazy(() => import("./PriceChart").then((m) => ({ default: m.PriceChart })));
const SimpleTradePanel = lazy(() => import("./SimpleTradePanel").then((m) => ({ default: m.SimpleTradePanel })));
const ContractDetailModal = lazy(() => import("./ContractDetailModal").then((m) => ({ default: m.ContractDetailModal })));

const ChartFallback: FC = () => (
  <div className="border border-rule rounded-md p-12 text-center my-2">
    <p className="font-mono text-[10.5px] uppercase tracking-[0.2em] text-ink-muted m-0">Loading…</p>
  </div>
);
import { useTradeData, type Offering } from "./useTradeData";
import { useUnifiedChain } from "../../hooks/useUnifiedChain";

/**
 * TradePageV2 — the new exchange Trade page (flag-gated by TRADE_V2_UI).
 *
 * Pass 1: GRID view only — the unified series+legacy chain (useUnifiedChain),
 * Deribit-style, paper aesthetic. CHART is a placeholder (Pass 3); the order
 * ticket is Pass 2. Row selection sets focused-contract state (highlight only
 * for now). View choice persists in localStorage (T1).
 *
 * Reuse: selectors + spot + ATM come from the existing useTradeData (the V1
 * data hook), so feed wiring isn't duplicated; chain rows come from the Pass-0
 * useUnifiedChain aggregate.
 */
const VIEW_KEY = "opta.trade.view.v2";
const PERSONA_KEY = "opta.trade.persona";
type View = "grid" | "chart";
type Persona = "pro" | "simple";

export const TradePageV2: FC = () => {
  usePaperPalette();
  const td = useTradeData();
  const chain = useUnifiedChain();

  const [persona, setPersona] = useState<Persona>(() =>
    (typeof localStorage !== "undefined" && localStorage.getItem(PERSONA_KEY) === "simple") ? "simple" : "pro",
  );
  useEffect(() => { try { localStorage.setItem(PERSONA_KEY, persona); } catch { /* ignore */ } }, [persona]);

  const [view, setView] = useState<View>(() => {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem(VIEW_KEY) : null;
    return saved === "chart" ? "chart" : "grid";
  });
  useEffect(() => {
    try { localStorage.setItem(VIEW_KEY, view); } catch { /* ignore */ }
  }, [view]);

  const [focused, setFocused] = useState<FocusedContract | null>(null);
  const [detailTarget, setDetailTarget] = useState<DetailTarget | null>(null);

  // Legacy Buy bridges to the existing classic BuyModal (purchase_from_vault /
  // buy_v2_resale) — reuse, not reimplementation.
  const [buyTarget, setBuyTarget] = useState<{
    offerings: Offering[]; side: "call" | "put"; asset: string; strike: number;
    expiry: number; fairPremium: number; ivSmiled: number; spot: number | null;
    stale: boolean; initialSelected: Offering | null;
  } | null>(null);

  const onLegacyBuy = (r: FocusedContract) => {
    const cr = td.rows.find((x) => x.strike === r.strike);
    if (!cr) return;
    const offerings = r.optionType === "call" ? cr.callOfferings : cr.putOfferings;
    setBuyTarget({
      offerings, side: r.optionType, asset: td.selectedAsset, strike: r.strike,
      expiry: td.selectedExpiry, fairPremium: r.optionType === "call" ? cr.callPremium : cr.putPremium,
      ivSmiled: cr.ivSmiled, spot: td.spot, stale: td.stale,
      initialSelected: offerings.find((o) => !(o.kind === "resale" && o.isSelfListing)) ?? null,
    });
  };

  const monthLabel = useMemo(
    () => new Date().toLocaleDateString("en-US", { month: "long", year: "numeric" }),
    [],
  );
  const timestampLabel = useMemo(() => {
    const now = new Date();
    const datePart = now.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
    const timePart = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
    return `${datePart} · ${timePart} UTC`;
  }, []);

  // Cheap FE mark for the focused contract — used as the chart-page ladder's
  // "vault peg" level (display only; no eager on-chain view, T6).
  const focusedMark = useMemo(() => {
    if (!focused || !td.spot || td.spot <= 0) return null;
    const d = Math.max(0, (focused.expiry - Date.now() / 1000) / 86_400);
    if (d <= 0) return null;
    const vol = applyVolSmile(getDefaultVolatility(focused.asset), td.spot, focused.strike, focused.asset);
    return focused.optionType === "call"
      ? calculateCallPremium(td.spot, focused.strike, d, vol, 0, undefined, focused.asset)
      : calculatePutPremium(td.spot, focused.strike, d, vol, 0, undefined, focused.asset);
  }, [focused, td.spot]);

  // Filter the unified chain to the selected asset + expiry (match by UTC day).
  const day = (ts: number) => Math.floor(ts / 86_400);
  const visibleRows = useMemo(
    () =>
      chain.rows.filter(
        (r) => r.asset === td.selectedAsset && day(r.expiry) === day(td.selectedExpiry),
      ),
    [chain.rows, td.selectedAsset, td.selectedExpiry],
  );

  // Pro default focus → the SERIES row (the seeded $75) on load, not the legacy.
  useEffect(() => {
    if (focused || persona !== "pro" || !visibleRows.length) return;
    const series = visibleRows.find((r) => r.provenance === "series");
    if (series) setFocused(series);
  }, [visibleRows, persona, focused]);

  const seriesCount = visibleRows.filter((r) => r.provenance === "series").length;
  const totalOi = visibleRows.reduce((n, r) => n + r.oi, 0);

  const loading = td.loading || chain.loading;

  return (
    <div className="relative bg-paper text-ink overflow-x-hidden min-h-screen">
      <PaperGrain />
      <AppNav />
      <main className="mx-auto w-full max-w-[1280px] px-[clamp(20px,4vw,56px)] pt-[120px] pb-[clamp(40px,8vh,80px)]">
        <TradeStatementHeader
          monthLabel={monthLabel}
          timestampLabel={timestampLabel}
          assets={td.availableAssets}
          selectedAsset={td.selectedAsset}
          onAssetChange={td.setSelectedAsset}
          assetSelector={
            <AssetDropdown
              assets={td.availableAssets}
              selected={td.selectedAsset}
              onChange={td.setSelectedAsset}
            />
          }
        />

        {/* Persona toggle — Pro | Simple (sticky, T1) */}
        <div className="flex items-center justify-between gap-4 my-6 flex-wrap">
          <div className="flex items-center gap-px bg-rule border border-rule rounded-md w-fit overflow-hidden">
            {(["pro", "simple"] as Persona[]).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPersona(p)}
                className={`font-mono text-[11px] uppercase tracking-[0.2em] px-6 py-2 transition-colors ${
                  persona === p ? "bg-ink text-paper" : "bg-paper text-ink-muted hover:text-ink"
                }`}
              >
                {p}
              </button>
            ))}
          </div>

          {/* GRID | CHART sub-toggle lives inside Pro only */}
          {persona === "pro" && (
            <div className="flex items-center gap-px bg-rule border border-rule rounded-md w-fit overflow-hidden">
              {(["grid", "chart"] as View[]).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={`font-mono text-[11px] uppercase tracking-[0.2em] px-5 py-2 transition-colors ${
                    view === v ? "bg-ink text-paper" : "bg-paper text-ink-muted hover:text-ink"
                  }`}
                >
                  {v}
                </button>
              ))}
            </div>
          )}
        </div>

        {loading ? (
          <div className="border border-rule rounded-md p-12 text-center">
            <p className="font-sans italic font-medium leading-[1.55] text-ink-body text-[15px] m-0">
              Loading from devnet…
            </p>
          </div>
        ) : td.availableAssets.length === 0 ? (
          <div className="border border-rule rounded-md p-12 text-center">
            <p className="font-sans italic font-medium leading-[1.55] text-ink-body text-[15px] m-0">
              No active markets — visit Markets to create one.
            </p>
          </div>
        ) : persona === "simple" ? (
          <Suspense fallback={<ChartFallback />}>
            <SimpleTradePanel
              asset={td.selectedAsset}
              spot={td.spot}
              rows={chain.rows.filter((r) => r.asset === td.selectedAsset)}
              expiries={td.availableExpiries}
              selectedExpiry={td.selectedExpiry}
              setSelectedExpiry={td.setSelectedExpiry}
              onDone={() => { chain.refetch(); td.refetch(); }}
            />
          </Suspense>
        ) : (
          <>
            <ExpiryTabs
              expiries={td.availableExpiries}
              selected={td.selectedExpiry}
              onSelect={td.setSelectedExpiry}
            />

            {view === "grid" ? (
              <div className={focused ? "grid lg:grid-cols-[1fr_360px] gap-8 items-start" : ""}>
                <TradeChainV2
                  rows={visibleRows}
                  spot={td.spot}
                  atmStrike={td.atmStrike}
                  focused={focused}
                  onSelect={setFocused}
                  onShowDetails={setDetailTarget}
                />
                {focused && (
                  <div className="lg:sticky lg:top-[120px] space-y-6">
                    <OrderTicket
                      row={focused}
                      spot={td.spot}
                      onDone={() => { chain.refetch(); td.refetch(); }}
                      onLegacyBuy={onLegacyBuy}
                    />
                    <div className="border border-rule rounded-md p-5 bg-paper">
                      <OpenOrders optionMint={focused.optionMint} />
                    </div>
                  </div>
                )}
              </div>
            ) : focused ? (
              <>
                {/* Aligned band: chart (left, fills) + ticket (right, drives height).
                    items-stretch makes both columns equal-height → tops & bottoms flush. */}
                <div className="grid lg:grid-cols-[1fr_360px] gap-8 items-stretch">
                  <Suspense fallback={<ChartFallback />}>
                    <PriceChart row={focused} spot={td.spot} />
                  </Suspense>
                  <OrderTicket
                    row={focused}
                    spot={td.spot}
                    onDone={() => { chain.refetch(); td.refetch(); }}
                    onLegacyBuy={onLegacyBuy}
                  />
                </div>
                {/* Order book sits BELOW the band, under the left column. */}
                <div className="border border-rule rounded-md p-5 mt-6 lg:mr-[392px]">
                  <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-muted mb-3">Order book</div>
                  <OrderBookLadder optionMint={focused.optionMint} pegPrice={focusedMark} />
                </div>
                <div className="border border-rule rounded-md p-5 mt-6 lg:mr-[392px]">
                  <OpenOrders optionMint={focused.optionMint} />
                </div>
              </>
            ) : (
              <Suspense fallback={<ChartFallback />}>
                <PriceChart row={null} spot={td.spot} />
              </Suspense>
            )}

            {/* Minimal summary band (reused hairline rhythm). */}
            <div className="grid grid-cols-3 gap-px bg-rule border-y border-rule mt-12">
              {[
                { label: "Total OI", value: totalOi > 0 ? totalOi.toLocaleString() : "—", sub: "Contracts · this expiry" },
                { label: "Series", value: seriesCount > 0 ? String(seriesCount) : "—", sub: "Book-backed contracts" },
                { label: "Focused", value: focused ? `$${focused.strike} ${focused.optionType}` : "—", sub: focused ? focused.provenance : "Select a contract" },
              ].map((c, i) => (
                <div key={i} className="bg-paper p-6 md:p-7">
                  <div className="font-mono font-medium text-[11px] uppercase tracking-[0.2em] text-ink-muted mb-5">{c.label}</div>
                  <div className="font-mono font-normal text-[clamp(20px,2.2vw,28px)] leading-[0.95] text-ink mb-3">{c.value}</div>
                  <div className="font-mono font-medium text-[10.5px] uppercase tracking-[0.18em] text-ink-muted">{c.sub}</div>
                </div>
              ))}
            </div>
          </>
        )}

        <TradeFooter />
      </main>

      {detailTarget && (
        <Suspense fallback={null}>
          <ContractDetailModal
            call={detailTarget.call}
            put={detailTarget.put}
            initialSide={detailTarget.side}
            spot={td.spot}
            onClose={() => setDetailTarget(null)}
            onDone={() => { chain.refetch(); td.refetch(); }}
            onLegacyBuy={onLegacyBuy}
          />
        </Suspense>
      )}

      {buyTarget && (
        <BuyModal
          asset={buyTarget.asset}
          side={buyTarget.side}
          strike={buyTarget.strike}
          expiry={buyTarget.expiry}
          spot={buyTarget.spot}
          stale={buyTarget.stale}
          fairPremium={buyTarget.fairPremium}
          ivSmiled={buyTarget.ivSmiled}
          offerings={buyTarget.offerings}
          initialSelected={buyTarget.initialSelected}
          onClose={() => setBuyTarget(null)}
          onSuccess={() => { chain.refetch(); td.refetch(); }}
        />
      )}
    </div>
  );
};

export default TradePageV2;
