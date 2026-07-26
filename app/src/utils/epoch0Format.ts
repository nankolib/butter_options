// =============================================================================
// epoch0Format.ts — PURE formatting + derivation for the campaign surfaces
// =============================================================================
//
// Every value the campaign UI renders is computed here, so the components stay
// thin and the logic is testable without a DOM. The app has no test runner and
// adding one would mean an app/ reinstall on a live production frontend, so the
// deal is: logic lives here and is covered by node:test; components are dumb
// enough that the screenshot gate is adequate render coverage.
//
// BRIEF §4: numbers are mono, tabular, right-aligned — enforced at the call
// site; this module only produces the strings.
// =============================================================================

/** Board identifiers, in tab order. */
export const BOARDS = ["profit", "volume", "writer", "referrals", "social"] as const;
export type Board = (typeof BOARDS)[number];

export const BOARD_LABEL: Record<Board, string> = {
  profit: "Profit",
  volume: "Volume",
  writer: "Writer",
  referrals: "Referrals",
  social: "Social",
};

/** Right-aligned metric column heading per board. */
export const BOARD_METRIC: Record<Board, string> = {
  profit: "ROI",
  volume: "Volume",
  writer: "Premium",
  referrals: "Referees",
  social: "Posts",
};

export const isBoard = (v: string): v is Board => (BOARDS as readonly string[]).includes(v);

// ---------------------------------------------------------------------------
// Number formatting — micro-USDC in, display string out
// ---------------------------------------------------------------------------

/** micro-USDC -> "$1,234.56". Null/undefined -> em dash. */
export function usd(micro: number | null | undefined): string {
  if (micro == null || !Number.isFinite(micro)) return "—";
  const v = micro / 1e6;
  const sign = v < 0 ? "-" : "";
  return `${sign}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Fractional ROI -> "+4.83%" / "-15.81%". Null -> em dash. */
export function pct(fraction: number | null | undefined): string {
  if (fraction == null || !Number.isFinite(fraction)) return "—";
  const v = fraction * 100;
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

/** Direction class per brief §3: teal up, crimson down, muted flat. */
export type Direction = "up" | "down" | "flat";
export function direction(n: number | null | undefined): Direction {
  if (n == null || !Number.isFinite(n) || n === 0) return "flat";
  return n > 0 ? "up" : "down";
}

/** Integer with thousands separators. */
export function count(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return Math.trunc(n).toLocaleString("en-US");
}

/** Points, 0 decimals under 1000 and never more than one. */
export function points(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n >= 1000 ? Math.round(n).toLocaleString("en-US") : (Math.round(n * 10) / 10).toLocaleString("en-US");
}

/** Multiplier -> "1.4x". */
export function multiplier(m: number | null | undefined): string {
  const v = m == null || !Number.isFinite(m) ? 1 : m;
  return `${v.toFixed(1)}x`;
}

/** Wallet -> "Hw8zoB…FDP3" (mono, truncated per brief §5). */
export function truncateWallet(w: string): string {
  return w.length <= 12 ? w : `${w.slice(0, 6)}…${w.slice(-4)}`;
}

/** Unix seconds -> "14:23 UTC". Null -> "—". */
export function freshness(unix: number | null | undefined): string {
  if (unix == null || !Number.isFinite(unix) || unix <= 0) return "—";
  const d = new Date(unix * 1000);
  return `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")} UTC`;
}

// ---------------------------------------------------------------------------
// Board row -> metric cell
// ---------------------------------------------------------------------------

export interface MetricCell {
  text: string;
  dir: Direction;
}

/** The right-aligned metric for a row on a given board. */
export function metricCell(board: Board, row: Record<string, unknown>): MetricCell {
  switch (board) {
    case "profit":
      return { text: pct(row.roi as number), dir: direction(row.roi as number) };
    case "volume":
      return { text: usd(row.volume_usdc as number), dir: "flat" };
    case "writer":
      return { text: usd(row.writer_premium as number), dir: "flat" };
    case "referrals":
      return { text: count(row.referees as number), dir: "flat" };
    case "social":
      return { text: count(row.posts as number), dir: "flat" };
  }
}

// ---------------------------------------------------------------------------
// Onboarding chain
// ---------------------------------------------------------------------------

export const CHAIN_STEPS = [
  { id: "O1", label: "First fill" },
  { id: "O2", label: "First write" },
  { id: "O3", label: "Make a market" },
  { id: "O4", label: "First exercise" },
  { id: "O5", label: "Arm a trigger" },
  { id: "O6", label: "Hold to settlement" },
  { id: "O7", label: "Settle an expiry" },
] as const;

export type StepState = "done" | "next" | "locked";

/**
 * Chain is STRICTLY SEQUENTIAL (indexer D12): step n is reachable only after
 * n-1. Exactly one step is "next" — the first not-done one — and everything
 * after it is locked. A completed chain has no "next".
 */
export function chainStates(stage: number): StepState[] {
  const s = Number.isFinite(stage) ? Math.max(0, Math.min(CHAIN_STEPS.length, Math.trunc(stage))) : 0;
  return CHAIN_STEPS.map((_, i) => (i < s ? "done" : i === s ? "next" : "locked"));
}

// ---------------------------------------------------------------------------
// Degradation
// ---------------------------------------------------------------------------

export type SurfaceState = "loading" | "ready" | "empty" | "unavailable";

/**
 * One state machine for every data surface, so "API down" and "no rows yet"
 * can never be confused — the 2b lesson was that an empty result and a broken
 * result must look different to the user.
 */
export function surfaceState(args: { loading: boolean; failed: boolean; rowCount: number }): SurfaceState {
  if (args.loading) return "loading";
  if (args.failed) return "unavailable";
  return args.rowCount > 0 ? "ready" : "empty";
}

/** Empty-state copy per brief §7: one line + one action. */
export const EMPTY_COPY: Record<Board, { line: string; action: string; to: string }> = {
  profit: { line: "No ranked wallets yet.", action: "Claim faucet USDC", to: "/portfolio" },
  volume: { line: "No fills yet.", action: "Open a trade", to: "/trade" },
  writer: { line: "No premium earned yet.", action: "Write a contract", to: "/write" },
  referrals: { line: "No referrals yet.", action: "Get your code", to: "/portfolio" },
  social: { line: "No verified posts yet.", action: "Submit a post", to: "/portfolio" },
};

export const UNAVAILABLE_LINE = "Points unavailable.";
