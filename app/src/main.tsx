import "./polyfills";
// Side-effect import: installs the indexer read path when VITE_CHAIN_READPATH=1.
// FE ONLY — this module carries `import.meta` and must never reach the crank's
// import graph (see utils/indexerRegistry.ts).
import "./utils/chainReadPath";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import posthog from "posthog-js";
import { Analytics } from "@vercel/analytics/react";
import { SpeedInsights } from "@vercel/speed-insights/react";
import { WalletContextProvider } from "./contexts/WalletContext";
import { ErrorBoundary } from "./components/ErrorBoundary";
import App from "./App";
import "./index.css";

// PostHog — product analytics + session replay. US Cloud. Autocapture covers all
// clicks/inputs (input VALUES are never sent by autocapture); replay masks every
// input value + any [data-ph-mask] element (wallet addresses / balances).
const PH_KEY = import.meta.env.VITE_POSTHOG_KEY;

/**
 * Analytics must not sit in front of first paint. init() opens connections and
 * starts session recording, and it used to run synchronously BEFORE createRoot,
 * so every visitor waited on telemetry before seeing anything (its web-vitals
 * fetch alone was measured at 6.2s on a cold load, competing for sockets with
 * the data the page actually needs).
 *
 * Deferred to the first idle slice after render. Nothing here is load-bearing
 * for the UI, and PostHog queues events raised before init resolves, so
 * autocapture and pageview coverage are unchanged — only the ordering moves.
 */
function initAnalytics() {
  if (!PH_KEY) return;
  posthog.init(PH_KEY, {
    api_host: "https://us.i.posthog.com",
    ui_host: "https://us.posthog.com",
    autocapture: true,
    capture_pageview: true,
    capture_pageleave: true,
    session_recording: {
      maskAllInputs: true,
      maskTextSelector: "[data-ph-mask]",
    },
    person_profiles: "identified_only",
  });
}

const schedule: (cb: () => void) => void =
  typeof window !== "undefined" && "requestIdleCallback" in window
    ? (cb) => (window as any).requestIdleCallback(cb, { timeout: 3000 })
    : (cb) => setTimeout(cb, 0);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <WalletContextProvider>
        <App />
      </WalletContextProvider>
      <Analytics />
      <SpeedInsights />
    </ErrorBoundary>
  </StrictMode>,
);

schedule(initAnalytics);
