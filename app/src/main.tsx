import "./polyfills";

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
if (PH_KEY) {
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
