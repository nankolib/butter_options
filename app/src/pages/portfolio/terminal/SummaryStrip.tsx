// =============================================================================
// SummaryStrip — CLAIMABLE NOW · LOCKED · COLLATERAL · HOLDINGS VALUE + Claim all.
// =============================================================================
// The one teal primary on the page (Claim all). Numbers are live-derived; the
// CLAIMABLE NOW figure sums cleanly-known claimables (holder settled payouts +
// writer unclaimed premium) — residual collateral withdrawals are actionable via
// Claim all but not summed here (their exact pro-rata is computed on-chain; we
// never fabricate it). Mobile: 2×2 stat grid + full-width Claim all.
// =============================================================================

import type { FC } from "react";
import { fmtUsd } from "./portfolioUi";

const Stat: FC<{ label: string; value: string; sub?: string; tone?: "up" | "text" | "faint" }> = ({
  label, value, sub, tone = "text",
}) => (
  <div className="min-w-0">
    <div className="font-mono-plex text-[9px] uppercase tracking-[0.16em] text-l-faint">{label}</div>
    <div
      className={`mt-1 font-mono-plex text-[19px] tabular-nums ${
        tone === "up" ? "text-l-up-text" : tone === "faint" ? "text-l-faint" : "text-l-text"
      }`}
    >
      {value}
    </div>
    {sub && <div className="mt-0.5 font-mono-plex text-[10px] tabular-nums text-l-faint">{sub}</div>}
  </div>
);

export const SummaryStrip: FC<{
  claimableNow: number;
  lockedAmount: number;
  lockedUnlockLabel: string | null;
  collateral: number;
  holdingsValue: number;
  claimableCount: number;
  claiming: boolean;
  progress: { k: number; n: number } | null;
  onClaimAll: () => void;
}> = ({
  claimableNow, lockedAmount, lockedUnlockLabel, collateral, holdingsValue,
  claimableCount, claiming, progress, onClaimAll,
}) => (
  <div className="mb-8 flex flex-col gap-4 border-b border-l-hair pb-6 sm:flex-row sm:items-end sm:justify-between">
    <div className="grid grid-cols-2 gap-x-10 gap-y-4 sm:flex sm:gap-x-12" data-testid="summary-strip">
      <Stat label="Claimable now" value={fmtUsd(claimableNow)} tone={claimableNow > 0 ? "up" : "text"} />
      <Stat
        label="Locked"
        value={fmtUsd(lockedAmount)}
        sub={lockedUnlockLabel ?? undefined}
        tone={lockedAmount > 0 ? "faint" : "text"}
      />
      <Stat label="Collateral" value={fmtUsd(collateral)} />
      <Stat label="Holdings value" value={fmtUsd(holdingsValue)} />
    </div>

    <button
      type="button"
      onClick={onClaimAll}
      disabled={claimableCount === 0 || claiming}
      data-testid="claim-all"
      className="inline-flex w-full items-center justify-center rounded-[6px] bg-l-up px-[18px] py-[10px] font-sans text-[13px] font-medium text-l-on-up transition-opacity duration-300 ease-opta hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40 sm:w-auto"
    >
      {claiming && progress ? `Claiming ${progress.k}/${progress.n}…` : `Claim all${claimableCount ? ` (${claimableCount})` : ""}`}
    </button>
  </div>
);

export default SummaryStrip;
