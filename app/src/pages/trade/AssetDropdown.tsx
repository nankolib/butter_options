import type { FC } from "react";
import { useMemo, useState } from "react";

/**
 * AssetDropdown — class-grouped asset selector for the v2 Trade page (Pass 8 A).
 * Replaces the flat chip row; shows ONLY assets with a live market, grouped by
 * Crypto / Equities / Commodities / FX. Scales as more markets are written.
 */
type AssetClass = "Crypto" | "Equities" | "Commodities" | "FX" | "Other";
const CLASS_ORDER: AssetClass[] = ["Crypto", "Equities", "Commodities", "FX", "Other"];

const CRYPTO = new Set(["BTC", "ETH", "SOL", "XRP", "FARTCOIN"]);
const EQUITIES = new Set(["AAPL", "MSFT", "NVDA", "MSTR", "TSLA", "CRCL"]);

function classify(asset: string): AssetClass {
  const a = asset.toUpperCase();
  if (CRYPTO.has(a)) return "Crypto";
  if (EQUITIES.has(a)) return "Equities";
  if (a.includes("XAU") || a.includes("XAG") || a.includes("OIL")) return "Commodities";
  if (a.includes("PKR") || /^[A-Z]{3}[A-Z]{3}$/.test(a)) return "FX"; // e.g. USDPKR
  return "Other";
}

export const AssetDropdown: FC<{ assets: string[]; selected: string; onChange: (a: string) => void }> = ({ assets, selected, onChange }) => {
  const [open, setOpen] = useState(false);

  const groups = useMemo(() => {
    const m = new Map<AssetClass, string[]>();
    for (const a of [...assets].sort()) {
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
        className="flex items-center gap-2 rounded-full border border-rule px-4 py-[7px] font-mono font-medium text-[11px] uppercase tracking-[0.18em] text-ink hover:border-ink transition-colors"
      >
        <span className="text-crimson">{selected || "Select asset"}</span>
        {selectedClass && <span className="text-ink-muted text-[9px]">· {selectedClass}</span>}
        <span className="text-ink-muted">{open ? "▴" : "▾"}</span>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-2 w-[240px] max-h-[60vh] overflow-y-auto bg-paper border border-rule rounded-md shadow-2xl p-2">
            {groups.length === 0 && (
              <div className="font-mono text-[11px] text-ink-muted px-2 py-3">No live markets</div>
            )}
            {groups.map(({ cls, items }) => (
              <div key={cls} className="mb-2 last:mb-0">
                <div className="font-mono text-[9px] uppercase tracking-[0.2em] text-ink-muted px-2 py-1">{cls}</div>
                <div className="grid grid-cols-2 gap-1">
                  {items.map((a) => (
                    <button
                      key={a}
                      type="button"
                      onClick={() => { onChange(a); setOpen(false); }}
                      className={`text-left rounded px-2 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] transition-colors ${
                        a === selected ? "bg-ink text-paper" : "text-ink-body hover:bg-paper-2"
                      }`}
                    >
                      {a}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};
