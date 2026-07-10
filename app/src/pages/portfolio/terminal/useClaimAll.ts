// =============================================================================
// useClaimAll — sequential "Claim all" over the claimable set. Pure FE loop, no
// new instruction: each item fires its EXISTING per-row flow (one approval each).
// =============================================================================
//
// Claimable set (three classes), deduped by the writer state machine so a row is
// only ever in ONE bucket:
//   • Writer premium   — live rows with claimable premium > 0     → claim_premium
//   • Writer residual  — settled + UNLOCKED rows                  → withdraw_post_settlement
//                        (auto-claims premium internally per HIGH-01 — so a
//                         settled-unlocked row is EXCLUDED from the premium pass;
//                         never fire both on the same row)
//   • Holder payout    — settled-ITM holdings                     → exercise_from_vault
//
// Excluded by design: American early-exercise (discretionary, fresh-Pyth post),
// resale list/cancel, dust-burn. Sequential + continue-on-failure (each flow
// swallows its own error and toasts) — the Write-ladder cell pattern. Each flow
// reconciles via its own onSuccess → refetchAll, so state converges progressively
// and once more at the end.
// =============================================================================

import { useCallback, useMemo, useState } from "react";
import type { Position } from "../positions";
import type { WriterRow } from "../writerRows";
import type { PortfolioActions } from "../usePortfolioActions";
import type { WriterActions } from "../useWriterActions";

export type ClaimItem =
  | { kind: "writer-premium"; id: string; label: string; run: () => Promise<void> }
  | { kind: "writer-residual"; id: string; label: string; run: () => Promise<void> }
  | { kind: "holder-payout"; id: string; label: string; run: () => Promise<void> };

/** Build the deduped claimable set. Pure — drives both the count and the loop. */
export function buildClaimSet(
  positions: Position[],
  writerRows: WriterRow[],
  actions: PortfolioActions,
  writerActions: WriterActions,
): ClaimItem[] {
  const items: ClaimItem[] = [];

  for (const row of writerRows) {
    // Settled + UNLOCKED (settled-itm / settled-otm are the unlocked settled
    // states; settled-locked is separate) → withdraw (auto-claims premium).
    if (row.state === "settled-itm" || row.state === "settled-otm") {
      items.push({
        kind: "writer-residual",
        id: row.id,
        label: `Withdraw ${row.asset} ${row.strike}${row.side === "call" ? "C" : "P"}`,
        run: () => writerActions.withdrawCollateral(row),
      });
      continue; // never also add the premium pass for this row
    }
    // Live with claimable premium → claim (settled-locked is excluded: still locked).
    if (row.state === "live" && !row.claimableUsdc.isZero()) {
      items.push({
        kind: "writer-premium",
        id: row.id,
        label: `Claim ${row.asset} ${row.strike}${row.side === "call" ? "C" : "P"} premium`,
        run: () => writerActions.claimPremium(row),
      });
    }
  }

  for (const p of positions) {
    if (p.state === "settled-itm") {
      items.push({
        kind: "holder-payout",
        id: p.id,
        label: `Claim ${p.asset} ${p.strike}${p.side === "call" ? "C" : "P"} payout`,
        run: () => actions.exercise(p),
      });
    }
  }

  return items;
}

export function useClaimAll(
  positions: Position[],
  writerRows: WriterRow[],
  actions: PortfolioActions,
  writerActions: WriterActions,
) {
  const [progress, setProgress] = useState<{ k: number; n: number } | null>(null);

  const items = useMemo(
    () => buildClaimSet(positions, writerRows, actions, writerActions),
    [positions, writerRows, actions, writerActions],
  );

  const claimAll = useCallback(async () => {
    if (items.length === 0 || progress) return;
    try {
      for (let i = 0; i < items.length; i++) {
        setProgress({ k: i + 1, n: items.length });
        // Each flow swallows its own error + toasts, so a failure never aborts
        // the loop — the next claimable still runs.
        await items[i].run();
      }
    } finally {
      setProgress(null);
    }
  }, [items, progress]);

  return {
    claimableCount: items.length,
    claiming: progress != null,
    progress,
    claimAll,
  };
}
