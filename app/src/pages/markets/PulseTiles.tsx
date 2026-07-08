import type { FC } from "react";
import type { MarketRow } from "./useMarketsData";
import type { Tile, ContractSortKey } from "./marketsView";

/**
 * PulseTiles — the horizontal discovery strip above the table.
 *
 * Five live-only tiles (see marketsView.computeTiles). Clicking a tile's
 * HEADLINE applies its sort key to the current table state; clicking one of the
 * three contract rows opens that contract in the inspector directly. All values
 * bind to real vault/model state — no 24h figures (none are derivable).
 */
export const PulseTiles: FC<{
  tiles: Tile[];
  onHeadlineSort: (key: ContractSortKey) => void;
  onOpenRow: (row: MarketRow) => void;
}> = ({ tiles, onHeadlineSort, onOpenRow }) => (
  <div data-testid="pulse-tiles" className="flex gap-3 overflow-x-auto px-5 py-4">
    {tiles.map((t) => (
      <div
        key={t.kind}
        className="flex min-w-[190px] flex-1 flex-col gap-[9px] rounded-[10px] border border-l-hair p-[13px]"
      >
        <button
          type="button"
          onClick={() => onHeadlineSort(t.sortKey)}
          title="Sort the table by this metric"
          className="flex flex-col gap-[9px] text-left"
        >
          <span className="font-mono-plex text-[9px] uppercase tracking-[0.13em] text-l-muted">
            {t.label}
          </span>
          <span className="flex items-baseline gap-[6px]">
            <span className="font-mono-plex text-[20px] leading-none tabular-nums text-l-text">{t.big}</span>
            <span className="text-[10px] text-l-muted">{t.bigSub}</span>
          </span>
        </button>
        <div className="mt-[1px] flex flex-col gap-[5px]">
          {t.rows.map((r, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onOpenRow(r.row)}
              title="Open contract"
              className="-mx-1 flex items-center justify-between gap-2 rounded-[4px] px-1 py-[2px] transition-colors duration-150 hover:bg-l-surface-2"
            >
              <span className="whitespace-nowrap font-mono-plex text-[11px] text-l-muted">{r.code}</span>
              <span className="whitespace-nowrap font-mono-plex text-[11px] tabular-nums text-l-muted">{r.right}</span>
            </button>
          ))}
          {t.rows.length === 0 && <span className="px-1 text-[11px] text-l-muted">No live contracts</span>}
        </div>
      </div>
    ))}
  </div>
);

export default PulseTiles;
