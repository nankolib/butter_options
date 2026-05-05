import { Component, type ReactNode, type ErrorInfo } from "react";

type Props = {
  children: ReactNode;
};

type State = {
  error: Error | null;
};

/**
 * App-root error boundary.
 *
 * Mounted outside WalletContextProvider in main.tsx so it catches the
 * MED-3 cluster-coherence throw (WalletContext.tsx:38) and any other
 * render-phase error in the tree below. Without this boundary, a
 * thrown render error produces a blank document.documentElement in
 * production — visible only via console.error.
 *
 * Recovery: full page reload. The error states that lead to the
 * boundary firing (cluster mismatch, deserialise failure on first
 * render, missing critical context) are not reset by toggling local
 * state — a fresh page load is the most reliable path back to a
 * working tree, and gives the user a clear single CTA.
 *
 * No external error-reporting service is wired up. The boundary logs
 * the captured error and component stack to console.error so the
 * forensic trail is at least visible in DevTools and the browser's
 * crash reporter.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error("[opta] ErrorBoundary caught render error:", error);
    console.error("[opta] Component stack:", errorInfo.componentStack);
  }

  render(): ReactNode {
    if (this.state.error == null) {
      return this.props.children;
    }
    return (
      <div className="min-h-screen bg-paper text-ink flex items-center justify-center px-6">
        <div className="max-w-md w-full text-center">
          <h1 className="m-0 mb-6 font-fraunces-display font-light leading-[0.92] tracking-[-0.04em] text-[clamp(40px,6vw,72px)]">
            Something went wrong<span className="italic font-fraunces-display-em text-crimson">.</span>
          </h1>
          <p className="m-0 mb-8 font-fraunces-text italic font-light leading-[1.5] opacity-70 text-[15px]">
            Please reload to try again. If the issue persists, the technical detail below may help diagnose.
          </p>
          <pre className="font-mono text-[11px] text-left bg-paper-2 border border-rule rounded-md p-4 mb-8 overflow-auto whitespace-pre-wrap break-words">
            {this.state.error.message}
          </pre>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="rounded-full border border-ink bg-ink text-paper px-6 py-3 font-mono text-[11px] uppercase tracking-[0.2em] hover:bg-transparent hover:text-ink transition-colors duration-300 ease-opta"
          >
            Reload page
          </button>
        </div>
      </div>
    );
  }
}

export default ErrorBoundary;
