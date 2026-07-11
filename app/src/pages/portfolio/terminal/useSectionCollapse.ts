// =============================================================================
// useSectionCollapse — per-section collapse state, persisted to localStorage.
// =============================================================================
// Presentation only: collapsing a section hides its body but the data hooks live
// in the page and keep running (summary strip + BY ASSET stay live). Key
// `opta.portfolio.sections.v1`. Defaults: everything expanded except UTILITIES.
// =============================================================================

import { useCallback, useState } from "react";

export type SectionKey = "byAsset" | "holdings" | "written" | "activity" | "utilities";

const STORAGE_KEY = "opta.portfolio.sections.v1";

// true = collapsed. Defaults match the shipped surface (UTILITIES collapsed).
const DEFAULTS: Record<SectionKey, boolean> = {
  byAsset: false,
  holdings: false,
  written: false,
  activity: false,
  utilities: true,
};

function read(): Record<SectionKey, boolean> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<Record<SectionKey, boolean>>;
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

export function useSectionCollapse() {
  const [state, setState] = useState<Record<SectionKey, boolean>>(read);

  const toggle = useCallback((key: SectionKey) => {
    setState((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* storage unavailable — keep the in-memory toggle working */
      }
      return next;
    });
  }, []);

  const collapsed = useCallback((key: SectionKey) => state[key], [state]);

  return { collapsed, toggle };
}

export default useSectionCollapse;
