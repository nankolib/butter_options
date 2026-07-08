import { useCallback, useLayoutEffect, useState } from "react";

/**
 * Light/dark mode controller for the one-viewport Landing.
 *
 * Contract (per design lock 2026-07-08):
 *   - Defaults to LIGHT always. Deliberately ignores prefers-color-scheme —
 *     the landing opens light regardless of OS theme.
 *   - Persists the user's choice to localStorage ("opta-landing-mode").
 *   - Must still render if storage is unavailable (private mode, blocked
 *     cookies): every storage access is wrapped so a throw degrades to the
 *     light default instead of crashing the page.
 *
 * Sets data-mode="light|dark" on <html> in a layout effect (before paint,
 * no flash) and clears it on unmount so trader/docs routes are untouched.
 * The CSS in index.css keys the whole landing palette off this attribute.
 */
const STORAGE_KEY = "opta-landing-mode";
type Mode = "light" | "dark";

function readStoredMode(): Mode {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

export function useLandingMode() {
  const [mode, setMode] = useState<Mode>(readStoredMode);

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

export default useLandingMode;
