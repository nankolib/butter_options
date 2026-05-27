import { useEffect } from "react";
import { showToast } from "../components/Toast";

// =============================================================================
// useVersionCheck — non-blocking "new version available" self-heal
// =============================================================================
//
// The deployed bundle bakes in __BUILD_ID__ (the git short SHA at build
// time; see vite.config.ts). At build time we also emit /version.json
// carrying the same id. This hook polls that file and, when the served
// id differs from the baked id, surfaces a sticky "refresh to apply"
// toast. The refresh is ALWAYS user-initiated — we never force a reload,
// because reloading mid-transaction is worse than running a stale bundle.
//
// Guards:
//   - 30s minimum-uptime gate before the first check, so a fresh load that
//     lands during a CDN edge-consistency window doesn't false-positive.
//   - Skipped while the tab is hidden.
//   - 60s throttle between checks so focus/visibility bursts don't hammer.
//   - De-duped per remote build id: the toast fires once per new build; a
//     dismissed toast won't re-nag for the same build, but a newer build
//     re-triggers it.
//   - Fail-silent: any network/parse error is swallowed (no toast on blips,
//     and in dev /version.json is absent so this is simply a no-op).
// =============================================================================

const MIN_UPTIME_MS = 30_000; // gate before first poll
const POLL_INTERVAL_MS = 300_000; // 5 min
const CHECK_THROTTLE_MS = 60_000; // min gap between any two checks

export function useVersionCheck(): void {
  useEffect(() => {
    const mountTime = Date.now();
    let lastCheck = 0;
    let notified: string | null = null;

    async function check(): Promise<void> {
      if (document.hidden) return;
      const now = Date.now();
      if (now - mountTime < MIN_UPTIME_MS) return; // uptime gate
      if (now - lastCheck < CHECK_THROTTLE_MS) return; // throttle
      lastCheck = now;
      try {
        const resp = await fetch("/version.json", { cache: "no-store" });
        if (!resp.ok) return;
        const data = await resp.json();
        const remote = typeof data?.buildId === "string" ? data.buildId : null;
        if (!remote || remote === __BUILD_ID__ || remote === notified) return;
        notified = remote;
        showToast({
          type: "info",
          title: "A new version is available",
          message: "Refresh to apply the latest update.",
          sticky: true,
          action: { label: "Refresh", onClick: () => window.location.reload() },
        });
      } catch {
        // fail-silent — network blip, parse error, or dev (no version.json)
      }
    }

    let intervalId: number | undefined;
    const firstTimer = window.setTimeout(() => {
      void check();
      intervalId = window.setInterval(() => void check(), POLL_INTERVAL_MS);
    }, MIN_UPTIME_MS);

    const onVisible = () => {
      if (!document.hidden) void check();
    };
    const onFocus = () => void check();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", onFocus);

    return () => {
      window.clearTimeout(firstTimer);
      if (intervalId !== undefined) window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", onFocus);
    };
  }, []);
}
