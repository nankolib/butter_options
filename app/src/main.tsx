import "./polyfills";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { WalletContextProvider } from "./contexts/WalletContext";
import { ErrorBoundary } from "./components/ErrorBoundary";
import App from "./App";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <WalletContextProvider>
        <App />
      </WalletContextProvider>
    </ErrorBoundary>
  </StrictMode>,
);
