import type { FC, ReactNode } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type MarketRow, type UseMarketsData } from "./useMarketsData";
import { PulseTiles } from "./PulseTiles";
import { ContractInspector } from "./ContractInspector";
import { MoneyAmount } from "../../components/MoneyAmount";
import {
  CLASS_TABS,
  aggregateAssets,
  sortAssets,
  groupByExpiry,
  liveExpiries,
  computeTiles,
  classToTab,
  defaultDir,
  fmtInt,
  fmtPrice,
  fmtIv,
  fmtStrike,
  fmtUsdCompact,
  expiryLabel,
  expiryShort,
  type ClassTab,
  type AssetSortKey,
  type ContractSortKey,
  type SortDir,
} from "./marketsView";

/**
 * MarketsTerminal — the two-level discovery table + pulse tiles.
 *
 * State A: one row per asset (class-tab filtered). State B: click an asset →
 * its live contracts grouped by expiry, with Side + Expiry chips and a
 * collapsible "Settled & expired" section. Pulse-tile headlines apply a sort to
 * the current table; any contract row (tile or table) opens the inspector.
 *
 * Aggregates count LIVE contracts only. IV = model, premia = cumulative
 * (labelled). Sits as the flex-1 body under MarketsAppBar; the protocol strip is
 * flex-none and the table/tiles scroll inside.
 */
export const MarketsTerminal: FC<{ data: UseMarketsData }> = ({ data }) => {
  const { rows, summary, loading } = data;

  const [view, setView] = useState<"assets" | "contracts">("assets");
  const [tab, setTab] = useState<ClassTab>("Crypto");
  const [selAsset, setSelAsset] = useState<string | null>(null);
  const [sideFilter, setSideFilter] = useState<"all" | "call" | "put">("all");
  const [expFilter, setExpFilter] = useState<number | null>(null);
  const [settledOpen, setSettledOpen] = useState(false);
  const [assetSort, setAssetSort] = useState<{ key: AssetSortKey; dir: SortDir }>({ key: "oiSum", dir: "desc" });
  const [ctSort, setCtSort] = useState<{ key: ContractSortKey; dir: SortDir }>({ key: "strike", dir: "asc" });
  const [combo, setCombo] = useState("");
  const [comboOpen, setComboOpen] = useState(false);
  const [inspect, setInspect] = useState<MarketRow | null>(null);

  // Any filter / breadcrumb / state change resets the scroll body to the top so
  // the layout lands in a defined position (tiles fully visible above the sticky
  // bar) — a shrinking list can otherwise strand a stale scrollTop and leave the
  // tiles half-clipped by the container's top edge. Runs after commit (post-DOM),
  // overriding the browser's clamp; overflow-anchor:none on the body stops mid-
  // interaction scroll anchoring from re-stranding it.
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [view, selAsset, sideFilter, expFilter, tab]);

  const tiles = useMemo(() => computeTiles(rows), [rows]);
  const aggs = useMemo(() => aggregateAssets(rows), [rows]);
  // Protocol strip OI counts LIVE contracts only (mandate: no settled/expired in
  // aggregates); TVL + cumulative premia are protocol-wide totals from summary.
  const liveOi = useMemo(() => rows.reduce((s, r) => (r.status === "open" ? s + r.openInterest : s), 0), [rows]);

  // ---- State A rows (class-filtered, sorted) ----
  const assetRows = useMemo(
    () => sortAssets(aggs.filter((a) => a.tab === tab), assetSort.key, assetSort.dir),
    [aggs, tab, assetSort],
  );

  // ---- State B: live + settled for the selected asset ----
  const forAsset = useMemo(() => rows.filter((r) => r.asset === selAsset), [rows, selAsset]);
  const liveForAsset = useMemo(() => forAsset.filter((r) => r.status === "open"), [forAsset]);
  const settledForAsset = useMemo(() => forAsset.filter((r) => r.status !== "open"), [forAsset]);
  const filteredLive = useMemo(() => {
    let l = liveForAsset;
    if (sideFilter !== "all") l = l.filter((r) => r.side === sideFilter);
    if (expFilter != null) l = l.filter((r) => r.expiry === expFilter);
    return l;
  }, [liveForAsset, sideFilter, expFilter]);
  const groups = useMemo(() => groupByExpiry(filteredLive, ctSort.dir), [filteredLive, ctSort.dir]);
  const expiries = useMemo(() => liveExpiries(liveForAsset), [liveForAsset]);

  const openAsset = (asset: string) => {
    const cls = aggs.find((a) => a.asset === asset)?.assetClass ?? 0;
    setTab(classToTab(cls));
    setSelAsset(asset);
    setView("contracts");
    setSideFilter("all");
    setExpFilter(null);
    setSettledOpen(false);
    setCtSort({ key: "strike", dir: "asc" });
    setComboOpen(false);
    setCombo("");
  };
  const backToAssets = () => {
    setView("assets");
    setSelAsset(null);
    setAssetSort({ key: "oiSum", dir: "desc" });
  };

  const sortAsset = (key: AssetSortKey) =>
    setAssetSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: defaultDir(key) as SortDir }));
  const sortContract = (key: ContractSortKey) =>
    setCtSort((s) => (s.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: defaultDir(key) as SortDir }));

  // Tile headline → sort the current table (map contract key → asset key in State A).
  const onTileSort = (key: ContractSortKey) => {
    if (view === "contracts") return sortContract(key);
    const map: Partial<Record<ContractSortKey, AssetSortKey>> = {
      openInterest: "oiSum",
      vaultTvl: "vaultDepthSum",
      iv: "atmIv",
      expiry: "nearestExpiryTs",
    };
    const ak = map[key];
    if (ak) sortAsset(ak);
  };

  // ---- combobox ----
  const q = combo.trim().toUpperCase();
  const comboItems = useMemo(
    () =>
      sortAssets(
        aggs.filter((a) => !q || a.asset.toUpperCase().includes(q) || a.tab.toUpperCase().includes(q)),
        "oiSum",
        "desc",
      ).slice(0, 8),
    [aggs, q],
  );

  const A_COLS = "minmax(120px,1.2fr) 100px 90px 100px 116px 84px 120px";
  const B_COLS = "84px 92px 108px 96px 72px 96px 108px 96px";

  return (
    <div data-testid="markets-terminal" data-view={view} data-loading={loading ? "1" : "0"} className="flex flex-1 flex-col overflow-hidden bg-l-bg text-l-text">
      {/* Protocol strip */}
      <div className="flex h-[34px] flex-none items-center gap-0 overflow-x-auto border-b border-l-hair px-5">
        <StripCell label="Active markets" value={summary.loaded ? String(summary.activeMarkets) : "—"} />
        <StripCell label="Open interest · live" value={summary.loaded ? fmtInt(liveOi) : "—"} />
        <StripCell label="Vault TVL" value={summary.loaded ? <MoneyAmount value={summary.vaultTvl} /> : "—"} />
        <StripCell label="Premia · cumulative" value={summary.loaded ? <MoneyAmount value={summary.premiaWritten} /> : "—"} last />
      </div>

      {/* Scroll body — a plain block (NOT flex-col): as a flex column its children
          are flex items with flex-shrink:1, so a tall State-B table would COMPRESS
          the pulse tiles (to ~38px) instead of scrolling, half-clipping their
          headlines. Block flow keeps every child at natural height and lets the
          overflow scroll. flex-1 still sizes the body within the outer column. */}
      <div ref={scrollRef} data-testid="scroll-body" className="flex-1 overflow-auto [overflow-anchor:none]">
        <PulseTiles tiles={tiles} onHeadlineSort={onTileSort} onOpenRow={setInspect} />

        {/* Discovery row — sticky under the protocol strip. Opaque bg + top-0 so
            the pulse tiles above scroll cleanly UNDER it (never half-clipped);
            z-20 keeps it (and its combobox dropdown) above the table body. */}
        <div className="sticky top-0 z-20 flex flex-col gap-[11px] border-b border-l-hair bg-l-bg px-5 pb-3 pt-[12px]">
          <div className="flex flex-wrap items-center gap-[14px]">
            {view === "assets" ? (
              <div className="flex gap-[2px] border-b border-l-hair">
                {CLASS_TABS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    data-testid="class-tab"
                    data-tab={c}
                    onClick={() => setTab(c)}
                    className={`-mb-px border-b-2 px-[14px] py-[7px] font-sans text-[13px] font-medium transition-colors ${
                      tab === c ? "border-l-text text-l-text" : "border-transparent text-l-muted hover:text-l-text"
                    }`}
                  >
                    {c}
                  </button>
                ))}
              </div>
            ) : (
              <div className="flex items-center gap-[12px]">
                <button
                  type="button"
                  onClick={backToAssets}
                  className="inline-flex items-center gap-[6px] rounded-[6px] border border-l-hair px-[11px] py-[5px] font-sans text-[13px] text-l-muted hover:text-l-text"
                >
                  ← Markets
                </button>
                <div className="flex items-center gap-[7px] font-mono-plex text-[13px]">
                  <button type="button" onClick={backToAssets} className="text-l-muted hover:text-l-text">
                    {tab}
                  </button>
                  <span className="text-l-muted">/</span>
                  <span className="text-l-text">{selAsset}</span>
                  {expFilter != null && (
                    <>
                      <span className="text-l-muted">/</span>
                      <button type="button" onClick={() => setExpFilter(null)} className="text-l-text hover:text-l-muted">
                        {expiryShort(expFilter)}
                      </button>
                    </>
                  )}
                </div>
              </div>
            )}

            {/* Combobox */}
            <div className="relative ml-auto">
              <div className="flex min-w-[236px] items-center gap-2 rounded-[6px] border border-l-hair bg-l-surface px-[10px] py-[6px]">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--color-l-faint)" strokeWidth="2" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" />
                  <path d="M21 21l-4.3-4.3" />
                </svg>
                <input
                  placeholder="Jump to asset"
                  value={combo}
                  onChange={(e) => {
                    setCombo(e.target.value);
                    setComboOpen(true);
                  }}
                  onFocus={() => setComboOpen(true)}
                  onBlur={() => window.setTimeout(() => setComboOpen(false), 160)}
                  className="min-w-0 flex-1 bg-transparent font-sans text-[13px] text-l-text outline-none placeholder:text-l-muted"
                />
                <span className="rounded-[4px] border border-l-hair px-[5px] py-[1px] font-mono-plex text-[10px] text-l-muted">⌘K</span>
              </div>
              {comboOpen && (
                <div className="absolute right-0 top-[calc(100%+6px)] z-40 max-h-[320px] w-[290px] overflow-auto rounded-[8px] border border-l-hair bg-l-surface-2 p-1">
                  {comboItems.map((it) => (
                    <button
                      key={it.asset}
                      type="button"
                      onMouseDown={(e) => {
                        e.preventDefault();
                        openAsset(it.asset);
                      }}
                      className="flex w-full items-center justify-between gap-3 rounded-[6px] px-[9px] py-[8px] hover:bg-l-surface"
                    >
                      <span className="flex items-center gap-[9px]">
                        <span className="font-mono-plex text-[13px] text-l-text">{it.asset}</span>
                        <span className="text-[11px] text-l-muted">{it.tab}</span>
                      </span>
                      <span className="font-mono-plex text-[12px] tabular-nums text-l-muted">
                        {it.spot != null ? fmtPrice(it.spot) : "—"}
                      </span>
                    </button>
                  ))}
                  {comboItems.length === 0 && <div className="px-[10px] py-3 text-[12px] text-l-muted">No matching asset</div>}
                </div>
              )}
            </div>
          </div>

          {/* Side + Expiry chips (State B) */}
          {view === "contracts" && (
            <div className="flex flex-wrap items-center gap-[20px]">
              <ChipGroup label="Side">
                <Chip active={sideFilter === "all"} onClick={() => setSideFilter("all")}>All</Chip>
                <Chip active={sideFilter === "call"} onClick={() => setSideFilter("call")} accent="up">Calls</Chip>
                <Chip active={sideFilter === "put"} onClick={() => setSideFilter("put")} accent="down">Puts</Chip>
              </ChipGroup>
              <ChipGroup label="Expiry">
                <Chip active={expFilter == null} onClick={() => setExpFilter(null)}>All</Chip>
                {expiries.map((e) => (
                  <Chip key={e} active={expFilter === e} onClick={() => setExpFilter(e)} testid="expiry-chip">
                    {expiryShort(e)}
                  </Chip>
                ))}
              </ChipGroup>
            </div>
          )}
        </div>

        {/* Table */}
        <div className="px-5 pb-6">
          <div className="overflow-hidden rounded-[10px] border border-l-hair">
            <div className="overflow-x-auto">
              <div className="min-w-[820px]">
                {view === "assets" ? (
                  <>
                    <div className="grid h-[34px] items-center border-b border-l-hair bg-l-surface" style={{ gridTemplateColumns: A_COLS }}>
                      <SortH label="Asset" k="asset" cur={assetSort} on={sortAsset} />
                      <SortH label="Spot" k="spot" cur={assetSort} on={sortAsset} right />
                      <SortH label="ATM IV" k="atmIv" cur={assetSort} on={sortAsset} right />
                      <SortH label="OI" k="oiSum" cur={assetSort} on={sortAsset} right />
                      <SortH label="Vault depth" k="vaultDepthSum" cur={assetSort} on={sortAsset} right />
                      <SortH label="Markets" k="marketCount" cur={assetSort} on={sortAsset} right />
                      <SortH label="Nearest exp" k="nearestExpiryTs" cur={assetSort} on={sortAsset} />
                    </div>
                    {assetRows.map((a) => (
                      <button
                        key={a.asset}
                        type="button"
                        data-testid="asset-row"
                        data-asset={a.asset}
                        onClick={() => openAsset(a.asset)}
                        title="View contracts"
                        className="grid h-[34px] w-full items-center border-b border-l-hair text-left hover:bg-l-surface"
                        style={{ gridTemplateColumns: A_COLS }}
                      >
                        <Cell className="font-sans text-[13px] font-medium text-l-text">{a.asset}</Cell>
                        <Cell right>{a.spot != null ? fmtPrice(a.spot) : "—"}</Cell>
                        <Cell right muted>{a.atmIv != null ? fmtIv(a.atmIv) : "—"}</Cell>
                        <Cell right>{fmtInt(a.oiSum)}</Cell>
                        <Cell right>{fmtUsdCompact(a.vaultDepthSum)}</Cell>
                        <Cell right muted>{String(a.marketCount)}</Cell>
                        <Cell muted>{a.nearestExpiryTs !== Infinity ? expiryShort(a.nearestExpiryTs) : "—"}</Cell>
                      </button>
                    ))}
                    {!loading && assetRows.length === 0 && (
                      <div className="px-3 py-6 text-[13px] text-l-muted">No live markets in {tab}.</div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="grid h-[34px] items-center border-b border-l-hair bg-l-surface" style={{ gridTemplateColumns: B_COLS }}>
                      <SortH label="Side" k="side" cur={ctSort} on={sortContract} />
                      <SortH label="Strike" k="strike" cur={ctSort} on={sortContract} right />
                      <SortH label="Expiry" k="expiry" cur={ctSort} on={sortContract} />
                      <SortH label="Spot" k="spot" cur={ctSort} on={sortContract} right />
                      <SortH label="IV" k="iv" cur={ctSort} on={sortContract} right />
                      <SortH label="OI" k="openInterest" cur={ctSort} on={sortContract} right />
                      <SortH label="Vault" k="vaultTvl" cur={ctSort} on={sortContract} right />
                      <SortH label="Status" k="status" cur={ctSort} on={sortContract} />
                    </div>
                    {groups.map((g) => (
                      <div key={g.ts}>
                        {expFilter == null && (
                          <div className="flex h-[28px] items-center gap-[9px] border-b border-l-hair bg-l-surface px-3">
                            <span className="font-mono-plex text-[11px] tracking-[0.1em] text-l-muted">{g.label}</span>
                            <span className="font-mono-plex text-[10px] text-l-muted">
                              {g.rows.length} {g.rows.length === 1 ? "contract" : "contracts"}
                            </span>
                          </div>
                        )}
                        {g.rows.map((r) => (
                          <ContractRow key={r.publicKey.toBase58()} r={r} cols={B_COLS} onOpen={() => setInspect(r)} />
                        ))}
                      </div>
                    ))}
                    {filteredLive.length === 0 && (
                      <div className="px-3 py-6 text-[13px] text-l-muted">No live contracts match these filters.</div>
                    )}

                    {/* Settled & expired collapse */}
                    {settledForAsset.length > 0 && (
                      <>
                        <button
                          type="button"
                          data-testid="settled-toggle"
                          onClick={() => setSettledOpen((v) => !v)}
                          className="flex h-[32px] w-full items-center gap-2 border-b border-l-hair bg-l-surface px-3 hover:bg-l-surface-2"
                        >
                          <span className="w-[10px] text-[11px] text-l-muted">{settledOpen ? "▾" : "▸"}</span>
                          <span className="font-mono-plex text-[11px] tracking-[0.08em] text-l-muted">
                            Settled &amp; expired ({settledForAsset.length})
                          </span>
                        </button>
                        {settledOpen &&
                          settledForAsset
                            .slice()
                            .sort((a, b) => b.expiry - a.expiry)
                            .map((r) => (
                              <ContractRow key={r.publicKey.toBase58()} r={r} cols={B_COLS} onOpen={() => setInspect(r)} settled />
                            ))}
                      </>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>
          <div className="mt-[10px] flex justify-between font-mono-plex text-[11px] text-l-muted">
            <span>
              {view === "assets"
                ? `Showing ${assetRows.length} ${assetRows.length === 1 ? "asset" : "assets"} · ${tab}`
                : `Showing ${filteredLive.length} live ${filteredLive.length === 1 ? "contract" : "contracts"} · ${selAsset}`}
            </span>
            <span>
              sorted by {view === "assets" ? assetSort.key : ctSort.key} {(view === "assets" ? assetSort.dir : ctSort.dir) === "asc" ? "↑" : "↓"}
            </span>
          </div>
        </div>
      </div>

      {inspect && <ContractInspector row={inspect} mode="modal" onClose={() => setInspect(null)} />}
    </div>
  );
};

// ---- small presentational pieces -------------------------------------------

const StripCell: FC<{ label: string; value: ReactNode; last?: boolean }> = ({ label, value, last }) => (
  <div className={`flex items-baseline gap-2 whitespace-nowrap pr-5 ${last ? "" : "mr-5 border-r border-l-hair"}`}>
    <span className="font-mono-plex text-[9px] uppercase tracking-[0.14em] text-l-muted">{label}</span>
    <span className="font-mono-plex text-[13px] tabular-nums text-l-text">{value}</span>
  </div>
);

const SortH = <K extends string>({
  label,
  k,
  cur,
  on,
  right,
}: {
  label: string;
  k: K;
  cur: { key: K; dir: SortDir };
  on: (k: K) => void;
  right?: boolean;
}) => (
  <button
    type="button"
    onClick={() => on(k)}
    className={`flex items-center gap-[3px] px-3 font-mono-plex text-[9px] uppercase tracking-[0.1em] text-l-muted ${right ? "justify-end" : "justify-start"}`}
  >
    {label}
    <span className="text-[10px] text-l-text">{cur.key === k ? (cur.dir === "asc" ? "↑" : "↓") : ""}</span>
  </button>
);

const Cell: FC<{ children: ReactNode; right?: boolean; muted?: boolean; className?: string }> = ({
  children,
  right,
  muted,
  className,
}) => (
  <span
    className={`px-3 font-mono-plex text-[12px] tabular-nums ${right ? "text-right" : ""} ${muted ? "text-l-muted" : "text-l-text"} ${className ?? ""}`}
  >
    {children}
  </span>
);

const ContractRow: FC<{ r: MarketRow; cols: string; onOpen: () => void; settled?: boolean }> = ({ r, cols, onOpen, settled }) => {
  // Settled/expired rows are the one legit --text-3 (l-faint) use — genuinely
  // de-emphasized content, not labels. Live rows keep --text-2 (l-muted) / text.
  const num = settled ? "text-l-faint" : "text-l-text";
  const sub = settled ? "text-l-faint" : "text-l-muted";
  const sideColor = settled ? "var(--color-l-faint)" : r.side === "call" ? "var(--color-l-up)" : "var(--color-l-down)";
  const statusColor = settled ? "var(--color-l-faint)" : r.status === "open" ? "var(--color-l-up)" : "var(--color-l-down)";
  const statusLabel = r.status === "settled" ? "Settled" : r.status === "expired" ? "Expired" : "Active";
  return (
    <button
      type="button"
      data-testid="contract-row"
      data-settled={settled ? "1" : "0"}
      onClick={onOpen}
      title="Open inspector"
      className="grid h-[31px] w-full items-center border-b border-l-hair text-left hover:bg-l-surface"
      style={{ gridTemplateColumns: cols }}
    >
      <span className="flex items-center gap-[6px] px-3">
        <span className="h-[6px] w-[6px] flex-none rounded-full" style={{ background: sideColor }} />
        <span className={`text-[12px] ${sub}`}>{r.side === "call" ? "Call" : "Put"}</span>
      </span>
      <span className={`px-3 text-right font-mono-plex text-[12px] tabular-nums ${num}`}>{fmtStrike(r.strike)}</span>
      <span className={`px-3 font-mono-plex text-[12px] ${sub}`}>{expiryLabel(r.expiry)}</span>
      <span className={`px-3 text-right font-mono-plex text-[12px] tabular-nums ${num}`}>{r.spot != null ? fmtPrice(r.spot) : "—"}</span>
      <span className={`px-3 text-right font-mono-plex text-[12px] tabular-nums ${num}`}>{settled || r.iv == null ? "—" : fmtIv(r.iv)}</span>
      <span className={`px-3 text-right font-mono-plex text-[12px] tabular-nums ${num}`}>{settled ? "—" : fmtInt(r.openInterest)}</span>
      <span className={`px-3 text-right font-mono-plex text-[12px] tabular-nums ${num}`}>{fmtUsdCompact(r.vaultTvl ?? 0)}</span>
      <span className="flex items-center gap-[6px] px-3">
        <span className="h-[6px] w-[6px] flex-none rounded-full" style={{ background: statusColor }} />
        <span className={`text-[12px] ${sub}`}>{statusLabel}</span>
      </span>
    </button>
  );
};

const ChipGroup: FC<{ label: string; children: ReactNode }> = ({ label, children }) => (
  <div className="flex items-center gap-[10px]">
    <span className="font-mono-plex text-[9px] uppercase tracking-[0.13em] text-l-muted">{label}</span>
    <div className="flex flex-wrap gap-[6px]">{children}</div>
  </div>
);

const Chip: FC<{ active: boolean; onClick: () => void; accent?: "up" | "down"; testid?: string; children: ReactNode }> = ({
  active,
  onClick,
  accent,
  testid,
  children,
}) => (
  <button
    type="button"
    data-testid={testid}
    onClick={onClick}
    className={`rounded-[6px] border px-[11px] py-[5px] font-sans text-[12px] transition-colors ${
      active
        ? accent === "up"
          ? "border-l-up bg-l-surface text-l-text"
          : accent === "down"
            ? "border-l-down bg-l-surface text-l-text"
            : "border-l-text bg-l-surface text-l-text"
        : "border-l-hair text-l-muted hover:text-l-text"
    }`}
  >
    {children}
  </button>
);

export default MarketsTerminal;
