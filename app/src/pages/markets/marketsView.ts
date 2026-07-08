// =============================================================================
// marketsView.ts — pure selectors + formatters over useMarketsData rows.
// =============================================================================
//
// Frame-free data layer for the terminal Markets surface. Turns MarketRow[]
// (one row per SharedVault) into: class-tab buckets, State-A asset aggregates,
// State-B expiry groups, and the pulse-tile computations. Every aggregate here
// counts LIVE contracts only (status === "open"); settled/expired are excluded
// and surfaced separately by the component's collapse section.
//
// HONESTY NOTE (design lock, Phase 0 audit): there is no trade/price time-series
// indexer, so no 24h volume / 24h % / 24h IV-move is derivable. Those tiles and
// columns were CUT. IV here is the deterministic vol MODEL (getDefaultVolatility
// + smile), not traded IV. Premia is CUMULATIVE (vault.netPremiumCollected), not
// per-day. Both are labelled as such in the UI — never presented as live tape.
// =============================================================================

import type { MarketRow } from "./useMarketsData";

export type ClassTab = "Crypto" | "Equities" | "Commodities" | "Others";
export const CLASS_TABS: ClassTab[] = ["Crypto", "Equities", "Commodities", "Others"];

/** On-chain asset_class (0 Crypto · 1 Commodity · 2 Equity · 3 FX · 4 ETF) → tab. */
export function classToTab(assetClass: number): ClassTab {
  switch (assetClass) {
    case 0:
      return "Crypto";
    case 2:
      return "Equities";
    case 1:
      return "Commodities";
    default:
      return "Others"; // 3 FX, 4 ETF, anything else
  }
}

export const isLive = (r: MarketRow): boolean => r.status === "open";

// ---- formatters -------------------------------------------------------------

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}
export function fmtPrice(n: number): string {
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  if (n >= 1) return n.toFixed(2);
  return n.toFixed(4);
}
export function fmtStrike(n: number): string {
  if (n >= 1000) return n.toLocaleString("en-US", { maximumFractionDigits: 0 });
  return String(parseFloat(n.toFixed(2)));
}
/** Compact USD: $1.84M / $420K / $92. */
export function fmtUsdCompact(n: number): string {
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + Math.round(n / 1e3) + "K";
  return "$" + Math.round(n);
}
export function fmtPct(n: number): string {
  return n.toFixed(1) + "%";
}
/** Model vol is stored as a DECIMAL (0.85 = 85%); render as a whole-percent. */
export function fmtIv(decimalVol: number): string {
  return (decimalVol * 100).toFixed(0) + "%";
}

const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
/** UTC "31 JUL 26" for table/inspector. */
export function expiryLabel(ts: number): string {
  const d = new Date(ts * 1000);
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${day} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
}
/** UTC "31 JUL" for chips / codes. */
export function expiryShort(ts: number): string {
  const d = new Date(ts * 1000);
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${day} ${MONTHS[d.getUTCMonth()]}`;
}
/** Whole days to expiry from now (floored at 0). */
export function daysToExpiry(ts: number): number {
  return Math.max(0, Math.ceil((ts - Date.now() / 1000) / 86_400));
}
/** Contract code: "SOL 180C 31JUL". */
export function contractCode(r: MarketRow): string {
  return `${r.asset} ${fmtStrike(r.strike)}${r.side === "call" ? "C" : "P"} ${expiryShort(r.expiry).replace(" ", "")}`;
}

// ---- State A: asset aggregates ---------------------------------------------

export type AssetAgg = {
  asset: string;
  assetClass: number;
  tab: ClassTab;
  spot: number | null;
  /** Model IV of the strike nearest spot among live contracts. */
  atmIv: number | null;
  oiSum: number;
  vaultDepthSum: number;
  premiaSum: number;
  marketCount: number;
  nearestExpiryTs: number;
};

export function aggregateAssets(rows: MarketRow[]): AssetAgg[] {
  const by = new Map<string, MarketRow[]>();
  for (const r of rows) {
    if (!isLive(r)) continue;
    const list = by.get(r.asset) ?? [];
    list.push(r);
    by.set(r.asset, list);
  }
  const out: AssetAgg[] = [];
  for (const [asset, list] of by.entries()) {
    const spot = list[0].spot;
    let atm: MarketRow | null = null;
    if (spot != null) {
      atm = list.reduce(
        (best, r) => (Math.abs(r.strike - spot) < Math.abs(best.strike - spot) ? r : best),
        list[0],
      );
    }
    out.push({
      asset,
      assetClass: list[0].assetClass,
      tab: classToTab(list[0].assetClass),
      spot,
      atmIv: atm?.iv ?? null,
      oiSum: list.reduce((s, r) => s + r.openInterest, 0),
      vaultDepthSum: list.reduce((s, r) => s + (r.vaultTvl ?? 0), 0),
      premiaSum: list.reduce((s, r) => s + r.premiaWritten, 0),
      marketCount: list.length,
      nearestExpiryTs: list.reduce((m, r) => Math.min(m, r.expiry), Infinity),
    });
  }
  return out;
}

// ---- sorting ----------------------------------------------------------------

export type AssetSortKey = "asset" | "spot" | "atmIv" | "oiSum" | "vaultDepthSum" | "marketCount" | "nearestExpiryTs";
export type ContractSortKey = "side" | "strike" | "expiry" | "spot" | "iv" | "openInterest" | "vaultTvl" | "status";
export type SortDir = "asc" | "desc";

const numAsc = new Set<string>(["asset", "nearestExpiryTs", "strike", "expiry", "side", "status", "marketCount"]);

/** Default direction when a sort key is first selected (asc for labels/dates/strike). */
export function defaultDir(key: string): SortDir {
  return numAsc.has(key) ? "asc" : "desc";
}

export function sortAssets(aggs: AssetAgg[], key: AssetSortKey, dir: SortDir): AssetAgg[] {
  const s = dir === "asc" ? 1 : -1;
  return [...aggs].sort((a, b) => {
    if (key === "asset") return s * a.asset.localeCompare(b.asset);
    const av = (a[key] ?? 0) as number;
    const bv = (b[key] ?? 0) as number;
    return s * (av - bv);
  });
}

export function sortContracts(rows: MarketRow[], key: ContractSortKey, dir: SortDir): MarketRow[] {
  const s = dir === "asc" ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (key === "side") return s * a.side.localeCompare(b.side);
    if (key === "status") return s * a.status.localeCompare(b.status);
    const av = (a[key] ?? 0) as number;
    const bv = (b[key] ?? 0) as number;
    return s * (av - bv);
  });
}

// ---- State B: expiry groups -------------------------------------------------

export type ExpiryGroup = { ts: number; label: string; rows: MarketRow[] };

/** Live contracts for one asset, grouped by expiry (nearest first), strike-sorted. */
export function groupByExpiry(rows: MarketRow[], strikeDir: SortDir = "asc"): ExpiryGroup[] {
  const by = new Map<number, MarketRow[]>();
  for (const r of rows) {
    const list = by.get(r.expiry) ?? [];
    list.push(r);
    by.set(r.expiry, list);
  }
  return [...by.keys()]
    .sort((a, b) => a - b)
    .map((ts) => ({ ts, label: expiryLabel(ts), rows: sortContracts(by.get(ts)!, "strike", strikeDir) }));
}

/** Distinct live expiries for an asset, nearest first (for the chip row). */
export function liveExpiries(rows: MarketRow[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const r of [...rows].sort((a, b) => a.expiry - b.expiry)) {
    if (seen.has(r.expiry)) continue;
    seen.add(r.expiry);
    out.push(r.expiry);
  }
  return out;
}

// ---- pulse tiles (live only) ------------------------------------------------

export type TileRow = { row: MarketRow; code: string; right: string };
export type TileKind = "oi" | "iv" | "premia" | "expiring" | "depth";
export type Tile = {
  kind: TileKind;
  /** Table sort key this tile's headline applies when clicked. */
  sortKey: ContractSortKey;
  label: string;
  big: string;
  bigSub: string;
  rows: TileRow[];
};

const top = (arr: MarketRow[], sel: (r: MarketRow) => number, n = 3) =>
  [...arr].sort((a, b) => sel(b) - sel(a)).slice(0, n);

/** Five live-only tiles. All values bind to real vault/model state; no 24h. */
export function computeTiles(rows: MarketRow[]): Tile[] {
  const live = rows.filter(isLive);
  const withIv = live.filter((r) => r.iv != null);
  const exp7 = live.filter((r) => daysToExpiry(r.expiry) < 7).sort((a, b) => a.expiry - b.expiry);

  const oiTotal = live.reduce((s, r) => s + r.openInterest, 0);
  const premiaTotal = live.reduce((s, r) => s + r.premiaWritten, 0);
  const depthTotal = live.reduce((s, r) => s + (r.vaultTvl ?? 0), 0);
  const maxIv = withIv.reduce((m, r) => Math.max(m, r.iv ?? 0), 0);

  return [
    {
      kind: "oi",
      sortKey: "openInterest",
      label: "Top open interest",
      big: fmtInt(oiTotal),
      bigSub: "contracts open",
      rows: top(live, (r) => r.openInterest).map((r) => ({ row: r, code: contractCode(r), right: fmtInt(r.openInterest) })),
    },
    {
      kind: "depth",
      sortKey: "vaultTvl",
      label: "Widest vault depth",
      big: fmtUsdCompact(depthTotal),
      bigSub: "collateral",
      rows: top(live, (r) => r.vaultTvl ?? 0).map((r) => ({ row: r, code: contractCode(r), right: fmtUsdCompact(r.vaultTvl ?? 0) })),
    },
    {
      kind: "iv",
      sortKey: "iv",
      label: "Highest IV · model",
      big: withIv.length ? fmtIv(maxIv) : "—",
      bigSub: "peak",
      rows: top(withIv, (r) => r.iv ?? 0).map((r) => ({ row: r, code: contractCode(r), right: fmtIv(r.iv ?? 0) })),
    },
    {
      kind: "premia",
      sortKey: "vaultTvl",
      label: "Most premia · cumulative",
      big: fmtUsdCompact(premiaTotal),
      bigSub: "since inception",
      rows: top(live, (r) => r.premiaWritten).map((r) => ({ row: r, code: contractCode(r), right: fmtUsdCompact(r.premiaWritten) })),
    },
    {
      kind: "expiring",
      sortKey: "expiry",
      label: "Expiring < 7d",
      big: String(exp7.length),
      bigSub: exp7.length ? "nearest " + expiryShort(exp7[0].expiry) : "none",
      rows: exp7.slice(0, 3).map((r) => ({ row: r, code: contractCode(r), right: daysToExpiry(r.expiry) + "d" })),
    },
  ];
}
