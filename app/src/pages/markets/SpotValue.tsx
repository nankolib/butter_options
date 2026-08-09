// =============================================================================
// SpotValue — one cell that tells the truth about a missing spot price
// =============================================================================
//
// THE DEFECT THIS EXISTS FOR (fresh-wallet smoke, 2026-08-09):
//
//   /markets rendered "—" in the Spot and ATM IV columns for every asset. The
//   data was fine: all 25 assets resolved from a wallet-free path when queried
//   directly. What the page could not do was say WHICH "—" it meant, because
//   useMarketsData destructured only `{ prices, asOf }` off useSpotPrices and
//   dropped `loading` and `error` on the floor. Three different states —
//   "still fetching", "the fetch failed", "there is genuinely no price" —
//   collapsed into one glyph, so a four-second load and a dead RPC looked
//   identical, and neither looked like anything.
//
// THE RULE: an em-dash is a STATEMENT ("no price exists for this row"), not a
// shrug. It is reserved for the settled case. While the read is in flight the
// cell shows a skeleton; when the read failed it says so and carries the reason
// in its title.
//
// PROVENANCE: the failure copy never names the oracle vendor or transport — the
// user is told the price is unavailable, not which upstream produced it.
// =============================================================================

import type { FC } from "react";

/** What the spot read is currently doing, page-wide (not per row). */
export type SpotStatus = "ready" | "loading" | "error";

/**
 * Resolve the page-wide spot status from what useMarketsData exposes.
 *
 * `loading` wins over `error`: a refetch in flight after a previous failure is
 * a live attempt, and showing the stale failure through it would be a lie about
 * the present.
 */
export function spotStatusOf(loading: boolean, error: string | null): SpotStatus {
  if (loading) return "loading";
  return error ? "error" : "ready";
}

/** The reserved-width placeholder. Matches QuestPanel's skeleton idiom
 *  (flat `bg-l-surface`, no motion) — this surface does not animate. */
const SpotSkeleton: FC = () => (
  <span
    aria-hidden="true"
    data-testid="spot-skeleton"
    className="inline-block h-[9px] w-[38px] rounded-[2px] bg-l-surface align-middle"
  />
);

/**
 * A numeric cell whose value may not have arrived.
 *
 * `value != null` always wins: once a price is in hand it is shown even if a
 * later refresh is in flight or failed, because a real number beats a spinner.
 */
export const SpotValue: FC<{
  value: number | null;
  status: SpotStatus;
  format: (n: number) => string;
  /** Settled/expired rows have no live spot by definition — always "—". */
  settled?: boolean;
}> = ({ value, status, format, settled = false }) => {
  if (value != null) return <>{format(value)}</>;
  if (settled) return <>—</>;
  if (status === "loading") return <SpotSkeleton />;
  if (status === "error") {
    return (
      <span
        data-testid="spot-error"
        title="Price unavailable — the feed could not be read. Retrying automatically."
        className="cursor-help text-l-down"
      >
        n/a
      </span>
    );
  }
  return <>—</>;
};

export default SpotValue;
