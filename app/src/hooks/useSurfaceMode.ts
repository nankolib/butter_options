import { useCallback, useLayoutEffect, useState } from "react";

/**
 * Light/dark controller for a data-mode app surface (the Markets terminal).
 *
 * Mirrors useLandingMode but DARK by default — the trading surface opens dark
 * per the design lock, regardless of OS theme. Sets data-mode="light|dark" on
 * <html> in a layout effect (before paint, no flash) and clears it on unmount
 * so other routes (which use data-paper, not data-mode) are untouched. The CSS
 * in index.css keys the --color-l-* token set off this attribute.
 *
 * Persisted under a key distinct from the landing's, so the two surfaces keep
 * independent preferences. Every storage access is wrapped so a throw (private
 * mode, blocked cookies) degrades to the default instead of crashing.
 */
const STORAGE_KEY = "opta-app-mode";
type Mode = "light" | "dark";

function readStoredMode(defaultMode: Mode): Mode {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === "light" || v === "dark" ? v : defaultMode;
  } catch {
    return defaultMode;
  }
}

export function useSurfaceMode(defaultMode: Mode = "dark") {
  const [mode, setMode] = useState<Mode>(() => readStoredMode(defaultMode));

  useLayoutEffect(() => {
    document.documentElement.setAttribute("data-mode", mode);
    return () => {
      document.documentElement.removeAttribute("data-mode");
    };
  }, [mode]);

  const toggle = useCallback(() => {
    setMode((prev) => {
      const next: Mode = prev === "dark" ? "light" : "dark";
      try {
        window.localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* storage unavailable — keep the in-memory toggle working anyway */
      }
      return next;
    });
  }, []);

  return { mode, toggle };
}

export default useSurfaceMode;
