// =============================================================================
// ExerciseStyleBadge.tsx — EUR/AMER style pill for Portfolio ledger rows.
// =============================================================================
//
// Shared by both the buyer (PositionsTable) and writer (WriterPositionsTable)
// ledgers so the badge renders identically on both. Mirrors the existing
// muted mono-uppercase subtitle + rounded-full pill conventions already used
// in those tables (e.g. the asset full-name line and the action buttons) —
// no new design tokens. American gets the stronger ink treatment so the (new,
// early-exercisable) style stands out against the muted European default.
//
// Data source: SharedVault.exercise_style, surfaced as Position.exerciseStyle
// / WriterRow.exerciseStyle by the row builders (positions.ts / writerRows.ts).
// =============================================================================

import type { FC } from "react";

export const ExerciseStyleBadge: FC<{ style: "european" | "american" }> = ({
  style,
}) => {
  const isAmerican = style === "american";
  return (
    <span
      className={`inline-block font-mono font-medium text-[9.5px] uppercase tracking-[0.16em] rounded-full border px-2 py-[2px] ${
        isAmerican ? "border-ink text-ink" : "border-rule text-ink-muted"
      }`}
    >
      {isAmerican ? "American" : "European"}
    </span>
  );
};

export default ExerciseStyleBadge;
