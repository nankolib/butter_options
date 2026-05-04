// =============================================================================
// WriterSummaryBand.tsx — D8 Pattern B sibling band for writer ledger.
// =============================================================================
//
// Renders only when the connected wallet has at least one WriterPosition
// (i.e. rows.length > 0). Composes the existing SummaryBand internally
// so the visual register — paper background, hairline gap-px rules,
// mono-uppercase labels, clamp-sized numerals — stays identical to the
// buyer-side band without copy-paste drift. The "sibling" framing of
// D8 Pattern B is about *call-site* separation in PortfolioPage, not
// component duplication.
//
// Cells:
//   1. Vaults Written     — count of all writer rows
//      sub: "Open · N" plus " · M settled" if M > 0
//   2. Collateral Locked  — Σ deposited_collateral on LIVE + EXPIRED-PENDING
//      sub: "Live + pending · USDC"
//   3. Claimable Premium  — Σ getUnclaimedPremium across all rows (BN-precise)
//      sub: "From buyer purchases · USDC"
//   4. Premium Realized   — Σ premium_claimed across all rows
//      sub: "From settled premium · USDC"
//
// Cell 4 ("Premium Realized") is the demo-theater anchor: per D5b, after
// a successful claimPremium the WriterRow re-fetches via onSuccess →
// refetchAll → useVaults().refetch, which bumps the row's premiumClaimed
// field, which flows here and the cell ticks up live within ~2 seconds.
// =============================================================================

import type { FC } from "react";
import { useMemo } from "react";
import BN from "bn.js";
import { MoneyAmount } from "../../components/MoneyAmount";
import { SummaryBand, type SummaryCell } from "./SummaryBand";
import type { WriterRow } from "./writerRows";

type WriterSummaryBandProps = {
  rows: WriterRow[];
};

export const WriterSummaryBand: FC<WriterSummaryBandProps> = ({ rows }) => {
  const cells = useMemo(() => computeCells(rows), [rows]);
  // D9 — when the wallet has no writer positions, suppress the band
  // entirely. Hooks must run before the early return to keep order
  // stable across renders.
  if (rows.length === 0) return null;
  return <SummaryBand cells={cells} />;
};

function computeCells(
  rows: WriterRow[],
): [SummaryCell, SummaryCell, SummaryCell, SummaryCell] {
  const openCount = rows.filter((r) => r.state === "live").length;
  const settledCount = rows.filter(
    (r) =>
      r.state === "settled-itm" ||
      r.state === "settled-otm" ||
      r.state === "settled-locked",
  ).length;

  // Cell 1 — Vaults Written
  const vaultsCount = rows.length;
  const vaultsSubParts = [`Open · ${openCount}`];
  if (settledCount > 0) {
    vaultsSubParts.push(`${settledCount} settled`);
  }
  const vaultsSub = vaultsSubParts.join(" · ");

  // Cell 2 — Collateral Locked. Settled vaults are excluded: once is_settled
  // is true, the writer's collateral is either (a) about to be paid out via
  // withdraw_post_settlement, or (b) already paid (zeroed). Either way it's
  // no longer "locked".
  const collateralLocked = rows
    .filter((r) => r.state === "live" || r.state === "expired-pending")
    .reduce((sum, r) => sum + r.collateralDeposited, 0);

  // Cell 3 — Claimable Premium. Sum BN micro-USDC values to preserve
  // precision when many rows have small accruals; convert to USDC float
  // at display time. BN.toNumber() is safe here — max realistic claimable
  // is millions of USDC, far below 2^53.
  const claimableSumBN = rows.reduce(
    (acc, r) => acc.add(r.claimableUsdc),
    new BN(0),
  );
  const claimableUsd = claimableSumBN.toNumber() / 1_000_000;

  // Cell 4 — Premium Realized. Plain number sum (premiumClaimed is already
  // converted to USDC float in writerRows.ts via usdcToNumber).
  const realizedSum = rows.reduce((sum, r) => sum + r.premiumClaimed, 0);

  return [
    {
      label: "Vaults Written",
      value: vaultsCount.toString(),
      sub: vaultsSub,
    },
    {
      label: "Collateral Locked",
      value: <MoneyAmount value={collateralLocked} />,
      sub: "Live + pending · USDC",
    },
    {
      label: "Claimable Premium",
      value: <MoneyAmount value={claimableUsd} />,
      sub: "From buyer purchases · USDC",
    },
    {
      label: "Premium Realized",
      value: <MoneyAmount value={realizedSum} />,
      sub: "From settled premium · USDC",
    },
  ];
}

export default WriterSummaryBand;
