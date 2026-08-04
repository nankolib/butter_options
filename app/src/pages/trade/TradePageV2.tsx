import type { FC } from "react";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useSurfaceMode } from "../../hooks/useSurfaceMode";
import { TerminalAppBar } from "../../components/TerminalAppBar";
import { AssetDropdown } from "./AssetDropdown";
import { ExpiryTabs } from "./ExpiryTabs";
import { expiryCountdown } from "./expiryLabel";
import { TradeChainV2, type FocusedContract } from "./TradeChainV2";
import { ContractInspector } from "../markets/ContractInspector";
import { TradeDock } from "./TradeDock";
import { BookAndTape } from "./BookAndTape";
import { BuyModal } from "./BuyModal";
import { useTradeData, type Offering } from "./useTradeData";
import { useUnifiedChain } from "../../hooks/useUnifiedChain";
import { calculateCallPremium, calculatePutPremium, getDefaultVolatility, applyVolSmile } from "../../utils/blackScholes";
import { formatAsOfUtc } from "../../utils/format";

// Lazy-load the chart-heavy surfaces so they leave the initial chunk.
const PriceChart = lazy(() => import("./PriceChart").then((m) => ({ default: m.PriceChart })));
const SimpleTradePanel = lazy(() => import("./SimpleTradePanel").then((m) => ({ default: m.SimpleTradePanel })));

const ChartFallback: FC = () => (
  <div className="flex h-full items-center justify-center">
    <p className="font-mono-plex text-[10.5px] uppercase tracking-[0.16em] text-l-muted">Loading…</p>
  </div>
);

/**
 * TradePageV2 — the terminal trading surface (design lock 2026-07-09).
 *
 * Shared TerminalAppBar + dark-default surface (useSurfaceMode), over a
 * fixed-height flex column: context strip · expiry tabs · main (symmetric chain
 * or chart, left) + docked ContractInspector (right rail) · full-width bottom
 * dock. Row click loads the docked ticket; deep-links from Markets carry
 * asset·expiry·strike·side and focus the contract directly. SIMPLE persona swaps
 * the chain for the plain-English panel beside the chart.
 *
 * Mechanics (RFQ, buy/sell/write, epoch writer-asks, deep-link intake) are the
 * shipped V2 engine — this slice is a reskin + restructure, not a rewrite.
 */
const VIEW_KEY = "opta.trade.view.v2";
const PERSONA_KEY = "opta.trade.persona";
type View = "grid" | "chart";
type Persona = "pro" | "simple";

const day = (ts: number) => Math.floor(ts / 86_400);

export const TradePageV2: FC = () => {
  const { mode, toggle } = useSurfaceMode("dark");
  const td = useTradeData();
  const chain = useUnifiedChain();
  const [searchParams] = useSearchParams();

  const [persona, setPersona] = useState<Persona>(() =>
    (typeof localStorage !== "undefined" && localStorage.getItem(PERSONA_KEY) === "simple") ? "simple" : "pro",
  );
  useEffect(() => { try { localStorage.setItem(PERSONA_KEY, persona); } catch { /* ignore */ } }, [persona]);

  const [view, setView] = useState<View>(() => {
    const saved = typeof localStorage !== "undefined" ? localStorage.getItem(VIEW_KEY) : null;
    return saved === "chart" ? "chart" : "grid";
  });
  useEffect(() => { try { localStorage.setItem(VIEW_KEY, view); } catch { /* ignore */ } }, [view]);

  const [focused, setFocused] = useState<FocusedContract | null>(null);

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

  // Filter the unified chain to the selected asset + expiry (match by UTC day).
  const visibleRows = useMemo(
    () => chain.rows.filter((r) => r.asset === td.selectedAsset && day(r.expiry) === day(td.selectedExpiry)),
    [chain.rows, td.selectedAsset, td.selectedExpiry],
  );

  // ---- Asset universe + defaults from the UNIFIED CHAIN (BUG-1 fix) ----
  // The dropdown, default, and expiries derive from the SAME tolerant source
  // the grid renders (useUnifiedChain), so an asset can never be listed but
  // un-chartable, and SOL/BTC are never dropped by a strict/partially-loaded
  // market fetch. Assets are ranked by open interest → the default is the
  // biggest market, not an alphabetical accident. Empty/"?" names are filtered.
  const chainAssets = useMemo(() => {
    // Union the tolerant chain source with td's list (both already canonicalized
    // at the data layer) so a partial load of EITHER still populates the dropdown
    // (the empty-dropdown regression came from one source being momentarily empty).
    //
    // Ranked by MARKET BREADTH (# of live contracts), tie-broken by open interest
    // then name. Breadth — NOT raw OI — is the right "biggest market" signal: OI is
    // contracts-sold, so a thin asset with a few sold contracts (FARTCOIN) outranks
    // SOL on OI while having no live expiry to show. Breadth makes SOL the default.
    const stat = new Map<string, { rows: number; oi: number }>();
    for (const r of chain.rows) {
      if (!r.asset || r.asset === "?" || r.isSettled) continue;
      const s = stat.get(r.asset) ?? { rows: 0, oi: 0 };
      s.rows += 1;
      s.oi += r.oi;
      stat.set(r.asset, s);
    }
    for (const a of td.availableAssets) {
      if (a && !stat.has(a)) stat.set(a, { rows: 0, oi: 0 });
    }
    return [...stat.entries()]
      .sort((a, b) => b[1].rows - a[1].rows || b[1].oi - a[1].oi || a[0].localeCompare(b[0]))
      .map(([a]) => a);
  }, [chain.rows, td.availableAssets]);

  const chainExpiries = useMemo(() => {
    const now = Date.now() / 1000;
    const byDay = new Map<number, number>();
    for (const r of chain.rows) {
      if (r.asset !== td.selectedAsset || r.expiry <= now) continue;
      const dk = day(r.expiry);
      byDay.set(dk, Math.min(byDay.get(dk) ?? Infinity, r.expiry));
    }
    return [...byDay.values()].sort((a, b) => a - b);
  }, [chain.rows, td.selectedAsset]);

  // Default asset once the chain has assets: honor a deep-link ?asset, else the
  // highest-OI asset. One-shot; the shell owns the default (td no longer resets).
  const assetDefaulted = useRef(false);
  useEffect(() => {
    if (assetDefaulted.current || !chainAssets.length) return;
    const urlAsset = searchParams.get("asset");
    const canUseUrl = urlAsset && chainAssets.includes(urlAsset);
    // Wait until the chain fetch SETTLES before locking the breadth default, so a
    // partial/early set can't lock a low-breadth asset (the FARTCOIN default bug).
    // A deep-link asset applies immediately (it's an explicit choice, no ranking).
    if (!canUseUrl && chain.loading) return;
    const want = canUseUrl ? urlAsset : chainAssets[0];
    if (want && want !== td.selectedAsset) td.setSelectedAsset(want);
    assetDefaulted.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainAssets, chain.loading]);

  // Keep a valid expiry for the selected asset: honor ?expiry once, else the
  // nearest. Re-runs when the asset (hence its expiry set) changes.
  const expiryDefaulted = useRef(false);
  useEffect(() => {
    if (!chainExpiries.length) return;
    if (td.selectedExpiry && chainExpiries.includes(td.selectedExpiry)) return;
    let want = chainExpiries[0];
    const urlExpiry = searchParams.get("expiry");
    if (!expiryDefaulted.current && urlExpiry) {
      const match = chainExpiries.find((e) => day(e) === day(Number(urlExpiry)));
      if (match != null) want = match;
    }
    expiryDefaulted.current = true;
    td.setSelectedExpiry(want);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chainExpiries, td.selectedExpiry]);

  // Invalidate a stale focus when the asset/expiry selection changes.
  useEffect(() => {
    if (focused && (focused.asset !== td.selectedAsset || day(focused.expiry) !== day(td.selectedExpiry))) {
      setFocused(null);
    }
  }, [focused, td.selectedAsset, td.selectedExpiry]);

  // Deep-link focus: asset·expiry·strike·side (the reconciled canonical shape).
  // td applies asset/expiry; here we focus the matching strike+side row once the
  // unified chain has it. One-shot, retries until the row materialises.
  const deepFocusApplied = useRef(false);
  useEffect(() => {
    if (deepFocusApplied.current) return;
    const rawStrike = searchParams.get("strike");
    if (!rawStrike) { deepFocusApplied.current = true; return; }
    if (!visibleRows.length) return; // wait for the chain to load this expiry
    const strike = parseFloat(rawStrike);
    const side = searchParams.get("side"); // call | put
    const want = visibleRows.find(
      (r) => Math.abs(r.strike - strike) < 1e-6 && (!side || r.optionType === side),
    );
    if (want) { setFocused(want); deepFocusApplied.current = true; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleRows, searchParams]);

  // Pro default focus → prefer a SERIES row, else epoch → legacy → first.
  useEffect(() => {
    if (focused || persona !== "pro" || !visibleRows.length) return;
    // Don't pre-empt a pending deep-link focus.
    if (!deepFocusApplied.current && searchParams.get("strike")) return;
    const pick =
      visibleRows.find((r) => r.provenance === "series") ??
      visibleRows.find((r) => r.provenance === "epoch") ??
      visibleRows[0];
    if (pick) setFocused(pick);
  }, [visibleRows, persona, focused, searchParams]);

  const seriesCount = visibleRows.filter((r) => r.provenance === "series").length;
  const totalOi = visibleRows.reduce((n, r) => n + r.oi, 0);

  // Graceful surface state (BUG-2 fix). Once the chain yields assets we render
  // and STAY rendered — a wallet-connect refetch or a timed-out scan keeps the
  // prior rows (useUnifiedChain) so the surface never blanks. We only show the
  // spinner while genuinely first-loading, and a resolved empty/error state
  // otherwise (never an indefinite "Loading…").
  const hasAssets = chainAssets.length > 0;

  // Cheap FE mark for the focused contract — the order-book "vault peg" level
  // (display only; the precise American number is the inspector's on-chain RFQ).
  const focusedMark = useMemo(() => {
    if (!focused || !td.spot || td.spot <= 0) return null;
    const d = Math.max(0, (focused.expiry - Date.now() / 1000) / 86_400);
    if (d <= 0) return null;
    const vol = applyVolSmile(getDefaultVolatility(focused.asset), td.spot, focused.strike, focused.asset);
    return focused.optionType === "call"
      ? calculateCallPremium(td.spot, focused.strike, d, vol, 0, undefined, focused.asset)
      : calculatePutPremium(td.spot, focused.strike, d, vol, 0, undefined, focused.asset);
  }, [focused, td.spot]);

  const focusMint = (mint: string) => {
    const r = chain.rows.find((x) => x.optionMint === mint);
    if (r) {
      setFocused(r);
      if (r.asset !== td.selectedAsset) td.setSelectedAsset(r.asset);
    }
  };

  const refetchAll = () => { chain.refetch(); td.refetch(); };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-l-bg font-sans text-l-text">
      <TerminalAppBar mode={mode} onToggleMode={toggle} />

      {/* Context strip.
          BLK-6 (audit 2026-08-04): this was `h-[46px]` + no wrap, so at 390px the
          Pro|Simple + Grid|Chart group overflowed to x 386–494 — entirely outside
          the viewport, with no document scroll to reach it. No phone user could
          open the chart, for any asset. Below sm the row now WRAPS and the toggle
          group takes its own line; at sm+ every value resolves to the original
          (h-46, nowrap, py-0) so the desktop bar is pixel-identical. */}
      <div className="flex flex-none flex-wrap items-center gap-x-4 gap-y-2 border-b border-l-hair px-5 py-2 sm:h-[46px] sm:flex-nowrap sm:py-0">
        <AssetDropdown assets={chainAssets} selected={td.selectedAsset} onChange={td.setSelectedAsset} />
        <span className="font-mono-plex text-[15px] tabular-nums text-l-text">
          {td.spot != null ? `$${td.spot.toFixed(td.spot < 100 ? 4 : 2)}` : "—"}
        </span>
        {td.spotAsOf != null && (
          <span className="font-mono-plex text-[10px] tabular-nums text-l-muted">{formatAsOfUtc(td.spotAsOf)}</span>
        )}
        {td.stale && <span className="font-mono-plex text-[9px] uppercase tracking-[0.12em] text-l-faint">stale</span>}
        <span className="ml-3 whitespace-nowrap font-mono-plex text-[11px] tabular-nums text-l-muted">
          {td.selectedExpiry ? expiryCountdown(td.selectedExpiry) : ""}
        </span>

        <div className="ml-auto flex w-full items-center justify-end gap-2 sm:w-auto">
          <Toggle options={[["pro", "Pro"], ["simple", "Simple"]]} value={persona} onChange={(v) => setPersona(v as Persona)} />
          {persona === "pro" && (
            <Toggle options={[["grid", "Grid"], ["chart", "Chart"]]} value={view} onChange={(v) => setView(v as View)} />
          )}
        </div>
      </div>

      {/* Expiry tabs (Pro) */}
      {persona === "pro" && (
        <div className="flex-none border-b border-l-hair px-5 py-[9px]">
          <ExpiryTabs expiries={chainExpiries} selected={td.selectedExpiry} onSelect={td.setSelectedExpiry} />
        </div>
      )}

      {/* Main area — graceful: spinner only while first-loading; once we have
          assets we stay rendered (wallet-connect refetch never blanks); a
          resolved empty/error state instead of an indefinite spinner. */}
      {!hasAssets && chain.loading ? (
        <div className="flex flex-1 items-center justify-center">
          <p className="font-mono-plex text-[12px] uppercase tracking-[0.14em] text-l-muted">Loading from devnet…</p>
        </div>
      ) : !hasAssets ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          <p className="font-mono-plex text-[12px] text-l-muted">
            {chain.error ? "Couldn't reach devnet — the public RPC may be rate-limited." : "No active markets — visit Markets to create one."}
          </p>
          {chain.error && (
            <button
              type="button"
              onClick={refetchAll}
              className="rounded-[6px] border border-l-hair px-[13px] py-[6px] font-mono-plex text-[11px] uppercase tracking-[0.12em] text-l-text transition-colors hover:bg-l-surface"
            >
              Retry
            </button>
          )}
        </div>
      ) : persona === "simple" ? (
        <div className="flex flex-1 flex-col overflow-hidden">
          <div className="grid flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[1fr_420px]">
            <div className="hidden min-h-0 overflow-hidden border-r border-l-hair lg:block">
              <Suspense fallback={<ChartFallback />}>
                <PriceChart row={focused} spot={td.spot} />
              </Suspense>
            </div>
            <div className="overflow-auto p-5">
              <Suspense fallback={<ChartFallback />}>
                <SimpleTradePanel
                  asset={td.selectedAsset}
                  spot={td.spot}
                  rows={chain.rows.filter((r) => r.asset === td.selectedAsset)}
                  expiries={chainExpiries}
                  selectedExpiry={td.selectedExpiry}
                  setSelectedExpiry={td.setSelectedExpiry}
                  onDone={refetchAll}
                />
              </Suspense>
            </div>
          </div>
          <div className="flex-none border-t border-l-hair px-5 py-[7px] font-mono-plex text-[11px] tabular-nums text-l-muted">
            {td.selectedAsset} {td.spot != null ? `$${td.spot.toFixed(2)}` : "—"} · Expiry {td.selectedExpiry ? expiryCountdown(td.selectedExpiry) : "—"}
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-1 overflow-hidden">
            {/* Left: chain or chart. Below 1280px the book+tape stack under it. */}
            <div className="min-w-0 flex-1 overflow-auto p-4">
              {view === "grid" ? (
                <TradeChainV2
                  rows={visibleRows}
                  spot={td.spot}
                  atmStrike={td.atmStrike}
                  focused={focused}
                  onSelect={setFocused}
                />
              ) : (
                <div className="h-full min-h-0">
                  <Suspense fallback={<ChartFallback />}>
                    <PriceChart row={focused} spot={td.spot} />
                  </Suspense>
                </div>
              )}
              {focused && (
                <div className="mt-6 xl:hidden">
                  <BookAndTape optionMint={focused.optionMint} pegPrice={focusedMark} isSeries={focused.provenance === "series"} />
                </div>
              )}
            </div>

            {/* Middle: order book + tape — its own column on ≥1280px only. */}
            {focused && (
              <div className="hidden w-[264px] flex-none overflow-auto border-l border-l-hair p-4 xl:block">
                <BookAndTape optionMint={focused.optionMint} pegPrice={focusedMark} isSeries={focused.provenance === "series"} />
              </div>
            )}

            {/* Right: docked inspector rail (no book/tape — those are the middle column). */}
            <div className="w-[360px] flex-none overflow-auto border-l border-l-hair p-4">
              {focused ? (
                <ContractInspector
                  mode="docked"
                  row={focused}
                  spot={td.spot}
                  onDone={refetchAll}
                  onLegacyBuy={onLegacyBuy}
                />
              ) : (
                <div className="flex h-full items-center justify-center px-6 text-center">
                  <p className="font-mono-plex text-[11px] text-l-muted">Select a contract to trade.</p>
                </div>
              )}
            </div>
          </div>

          {/* Bottom dock */}
          <TradeDock onFocusMint={focusMint} />

          {/* Footer summary line */}
          <div className="flex-none border-t border-l-hair px-5 py-[7px] font-mono-plex text-[11px] tabular-nums text-l-muted">
            Total OI {totalOi > 0 ? totalOi.toLocaleString() : "—"} · {seriesCount} series book-backed
            {focused && <> · Focus {focused.asset} {focused.strike}{focused.optionType === "call" ? "C" : "P"}</>}
          </div>
        </>
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
          onSuccess={refetchAll}
        />
      )}
    </div>
  );
};

const Toggle: FC<{ options: [string, string][]; value: string; onChange: (v: string) => void }> = ({ options, value, onChange }) => (
  <div className="flex gap-px overflow-hidden rounded-[6px] border border-l-hair bg-l-hair">
    {options.map(([v, label]) => (
      <button key={v} type="button" onClick={() => onChange(v)}
        className={`px-[13px] py-[5px] font-sans text-[12px] font-medium transition-colors ${
          value === v ? "bg-l-surface-2 text-l-text" : "bg-l-surface text-l-muted hover:text-l-text"
        }`}>
        {label}
      </button>
    ))}
  </div>
);

export default TradePageV2;
