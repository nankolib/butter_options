import type { FC } from "react";
import { useMemo, useState } from "react";
import { assetClassOf, type AssetClass } from "../../utils/assetDisplay";

/**
 * AssetDropdown — class-grouped asset selector for the v2 Trade page. Shows ONLY
 * assets with a live market, grouped by Crypto / Equities / Commodities / FX.
 * Symbols are already CANONICAL (provenance seeds hidden at the data layer);
 * grouping uses the shared assetClassOf so the class mapping is canonical too.
 */
const CLASS_ORDER: AssetClass[] = ["Crypto", "Equities", "Commodities", "FX", "Other"];
const classify = assetClassOf;

export const AssetDropdown: FC<{ assets: string[]; selected: string; onChange: (a: string) => void }> = ({ assets, selected, onChange }) => {
  const [open, setOpen] = useState(false);

  const groups = useMemo(() => {
    const m = new Map<AssetClass, string[]>();
    // Filter empty / "?" tickers so a partially-decoded market can't render a
    // blank row (BUG-1). De-dupe defensively.
    for (const a of [...new Set(assets.filter((x) => x && x !== "?"))].sort()) {
      const c = classify(a);
      if (!m.has(c)) m.set(c, []);
      m.get(c)!.push(a);
    }
    return CLASS_ORDER.filter((c) => m.has(c)).map((c) => ({ cls: c, items: m.get(c)! }));
  }, [assets]);

  const selectedClass = selected ? classify(selected) : null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-[7px] rounded-[6px] border border-l-hair bg-l-surface px-[11px] py-[6px] font-mono-plex text-[13px] text-l-text hover:bg-l-surface-2 transition-colors"
      >
        <span className="tabular-nums">{selected || "Select asset"}</span>
        {selectedClass && <span className="text-l-muted text-[11px]">{selectedClass}</span>}
        <span className="text-l-muted text-[11px]">{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          {/* Left-anchored to the trigger (it sits at the far-left gutter, so
              right-0 would push the panel off the left viewport edge) and clamped
              to the viewport width on narrow screens. */}
          <div
            data-testid="asset-dropdown-panel"
            className="absolute left-0 z-50 mt-2 w-[240px] max-w-[min(240px,calc(100vw-40px))] max-h-[60vh] overflow-y-auto rounded-[8px] border border-l-hair bg-l-surface-2 p-1"
          >
            {groups.length === 0 && (
              <div className="font-mono-plex text-[12px] text-l-muted px-2 py-3">No live markets</div>
            )}
            {groups.map(({ cls, items }) => (
              <div key={cls} className="mb-1 last:mb-0">
                <div className="font-mono-plex text-[9px] uppercase tracking-[0.14em] text-l-muted px-2 py-1">{cls}</div>
                <div className="flex flex-col gap-0.5">
                  {items.map((a) => {
                    const isSel = a === selected;
                    return (
                      <button
                        key={a}
                        type="button"
                        onClick={() => { onChange(a); setOpen(false); }}
                        className={`flex items-center gap-[6px] text-left rounded-[6px] px-2 py-1.5 font-mono-plex text-[12px] tabular-nums transition-colors ${
                          isSel ? "bg-l-surface text-l-text" : "text-l-muted hover:bg-l-surface hover:text-l-text"
                        }`}
                      >
                        {isSel && (
                          <span
                            aria-hidden="true"
                            className="h-[5px] w-[5px] flex-none rounded-full"
                            style={{ background: "var(--color-l-up)" }}
                          />
                        )}
                        {a}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};
