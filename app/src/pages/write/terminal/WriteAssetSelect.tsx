// =============================================================================
// WriteAssetSelect — class-grouped asset dropdown with right-aligned spot.
// =============================================================================
//
// Modeled on the Trade page's AssetDropdown (same grouped Crypto / Equities /
// Commodities / FX shape, same viewport-safe left-anchored panel), extended for
// the Write surface: right-aligned live spot per row and a crimson "oracle
// pending" dot for tickers whose VolOracle PDA isn't seeded yet. Write-local so
// the Trade component stays untouched. Symbols are already canonical.
// =============================================================================

import type { FC } from "react";
import { useMemo, useState } from "react";
import { assetClassOf, type AssetClass } from "../../../utils/assetDisplay";

const CLASS_ORDER: AssetClass[] = ["Crypto", "Equities", "Commodities", "FX", "Other"];

/**
 * Spot for the selector rows.
 *
 * Sub-cent tokens need more than 4dp or they render as a flat "$0" and read as a
 * dead feed. BONK is the live example: spot $0.00000282 with 354 vol samples —
 * perfectly tradeable — displayed as "$0" by the old 4dp cap. (That artifact also
 * fooled the 2026-08-04 audit, which listed BONK as a dead feed; it is not.)
 * Values at or above 0.0001 keep the previous formatting exactly, so no existing
 * row changes.
 */
const fmtSpot = (v: number) => {
  if (v > 0 && v < 0.0001) {
    // toFixed, not toPrecision: toPrecision flips to exponential below ~1e-7.
    const decimals = Math.min(12, 2 - Math.floor(Math.log10(v)));
    return `$${v.toFixed(decimals)}`;
  }
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: v < 100 ? 4 : 2 })}`;
};

export const WriteAssetSelect: FC<{
  assets: string[];
  selected: string | null;
  spotByTicker: Record<string, number | null | undefined>;
  unseeded: ReadonlySet<string>;
  onChange: (a: string) => void;
}> = ({ assets, selected, spotByTicker, unseeded, onChange }) => {
  const [open, setOpen] = useState(false);

  const groups = useMemo(() => {
    const m = new Map<AssetClass, string[]>();
    for (const a of [...new Set(assets.filter((x) => x && x !== "?"))].sort()) {
      // P-5 (audit 2026-08-04): drop assets with NO price at all. USDPKR is the
      // live case — vol oracle never pushed (0/168 samples, seed_vol 0, spot
      // exactly 0) — and picking it produces a write that cannot be quoted.
      //
      // STRICTLY ZERO, not "small". The audit also flagged BONK here, wrongly:
      // BONK's spot is $0.00000282 with 354 samples, i.e. healthy. It only LOOKED
      // dead because fmtSpot capped at 4dp and printed "$0" (now fixed above).
      // A threshold big enough to catch BONK would delist every micro-cap the
      // protocol lists.
      //
      // The predicate is SPOT, deliberately not `unseeded`. `unseeded` means the
      // VolOracle PDA does not exist yet — a seconds-long race the crank closes,
      // for which the crimson "oracle pending" dot below is the designed
      // affordance. Hiding those rows would delete a feature.
      const spot = spotByTicker[a];
      if (spot == null || spot === 0) continue;
      const c = assetClassOf(a);
      if (!m.has(c)) m.set(c, []);
      m.get(c)!.push(a);
    }
    return CLASS_ORDER.filter((c) => m.has(c)).map((c) => ({ cls: c, items: m.get(c)! }));
  }, [assets, spotByTicker]);

  const selectedClass = selected ? assetClassOf(selected) : null;
  const selectedSpot = selected ? spotByTicker[selected] : null;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid="write-asset-trigger"
        className="flex w-full items-center gap-[7px] rounded-[6px] border border-l-hair bg-l-surface px-[11px] py-[8px] font-mono-plex text-[14px] text-l-text transition-colors hover:bg-l-surface-2"
      >
        <span className="tabular-nums">{selected || "Select asset"}</span>
        {selectedClass && <span className="text-[11px] text-l-muted">{selectedClass}</span>}
        {selectedSpot != null && (
          <span className="ml-auto tabular-nums text-[12px] text-l-muted">{fmtSpot(selectedSpot)}</span>
        )}
        <span className="text-[11px] text-l-muted">{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            data-testid="write-asset-panel"
            className="absolute left-0 z-50 mt-2 w-[280px] max-w-[min(280px,calc(100vw-40px))] max-h-[60vh] overflow-y-auto rounded-[8px] border border-l-hair bg-l-surface-2 p-1"
          >
            {groups.length === 0 && (
              <div className="px-2 py-3 font-mono-plex text-[12px] text-l-muted">No live markets</div>
            )}
            {groups.map(({ cls, items }) => (
              <div key={cls} className="mb-1 last:mb-0">
                <div className="px-2 py-1 font-mono-plex text-[9px] uppercase tracking-[0.14em] text-l-muted">
                  {cls}
                </div>
                <div className="flex flex-col gap-0.5">
                  {items.map((a) => {
                    const isSel = a === selected;
                    const spot = spotByTicker[a];
                    const pending = unseeded.has(a);
                    return (
                      <button
                        key={a}
                        type="button"
                        onClick={() => {
                          onChange(a);
                          setOpen(false);
                        }}
                        className={`flex items-center gap-[6px] rounded-[6px] px-2 py-1.5 text-left font-mono-plex text-[12px] tabular-nums transition-colors ${
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
                        <span>{a}</span>
                        {pending && (
                          <span
                            aria-label="Oracle pending"
                            className="h-[5px] w-[5px] flex-none rounded-full"
                            style={{ background: "var(--color-l-down)" }}
                          />
                        )}
                        <span className="ml-auto text-l-faint">{spot != null ? fmtSpot(spot) : "—"}</span>
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

export default WriteAssetSelect;
