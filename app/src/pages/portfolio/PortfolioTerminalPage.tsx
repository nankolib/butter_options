// =============================================================================
// PortfolioTerminalPage — the terminal /portfolio surface (FE terminal Slice 3).
// =============================================================================
//
// Shared TerminalAppBar + dark-default useSurfaceMode over a fixed-height flex
// column: summary strip (with the one teal Claim all) · HOLDINGS ledger · WRITTEN
// ledger · ACTIVITY · collapsed UTILITIES. All data + refetch orchestration flow
// through usePortfolioData (which CLOSES the settle/claim mutation-refresh debt:
// invalidate-before-refetch on every action). Action instruction assembly is the
// untouched legacy engine. The paper PortfolioPageLegacy stays the flag fallback.
// =============================================================================

import type { FC } from "react";
import { useEffect, useMemo, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useSurfaceMode } from "../../hooks/useSurfaceMode";
import { TerminalAppBar } from "../../components/TerminalAppBar";
import { usdcToNumber } from "../../utils/format";
import { EXERCISE_WINDOW_SECONDS, type WriterRow, type WriterRowAction } from "./writerRows";
import type { Position, PositionAction } from "./positions";
import { usePortfolioData } from "./terminal/usePortfolioData";
import { useClaimAll } from "./terminal/useClaimAll";
import { useActivity } from "./terminal/portfolioActivity";
import { useSectionCollapse } from "./terminal/useSectionCollapse";
import { buildAssetRollup } from "./terminal/assetRollup";
import { SummaryStrip } from "./terminal/SummaryStrip";
import { ByAssetSection } from "./terminal/ByAssetSection";
import { HoldingsLedger } from "./terminal/HoldingsLedger";
import { WrittenLedger } from "./terminal/WrittenLedger";
import { ActivitySection } from "./terminal/ActivitySection";
import { UtilitiesSection } from "./terminal/UtilitiesSection";
import { contractLabel, fmtCountdown } from "./terminal/portfolioUi";

export const PortfolioTerminalPage: FC = () => {
  const { mode, toggle } = useSurfaceMode("dark");
  const { setVisible } = useWalletModal();
  const { collapsed, toggle: toggleSection } = useSectionCollapse();

  const data = usePortfolioData();
  const {
    connected, publicKey, program, loading, positions, writerRows, vaults, vaultMints,
    markets, settlementRecords, spotPrices, refetchAll, actions, writerActions,
  } = data;

  // Ticking clock for lock countdowns (display only).
  const [nowSecs, setNowSecs] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNowSecs(Math.floor(Date.now() / 1000)), 30_000);
    return () => clearInterval(id);
  }, []);

  // option-mint → "SOL 185 C" label for the ACTIVITY contract column.
  const marketMap = useMemo(() => {
    const m = new Map<string, any>();
    markets.forEach((mk) => m.set(mk.publicKey.toBase58(), mk.account));
    return m;
  }, [markets]);
  const mintLabel = useMemo(() => {
    const m = new Map<string, string>();
    for (const vm of vaultMints) {
      const vault = vaults.find((v) => v.publicKey.equals(vm.account.vault as PublicKey));
      if (!vault) continue;
      const mkt = marketMap.get((vault.account.market as PublicKey).toBase58());
      const asset = (mkt?.assetName as string) || "?";
      const strike = usdcToNumber(vault.account.strikePrice);
      const side = "call" in vault.account.optionType ? "call" : "put";
      m.set((vm.account.optionMint as PublicKey).toBase58(), contractLabel(asset, strike, side as "call" | "put"));
    }
    return m;
  }, [vaultMints, vaults, marketMap]);
  const labelForMint = (mint: string) => mintLabel.get(mint) ?? `${mint.slice(0, 4)}…${mint.slice(-4)}`;

  const activity = useActivity(program ?? null, publicKey ?? null, labelForMint);
  const claim = useClaimAll(positions, writerRows, actions, writerActions);

  // ---- summary numbers (live-derived; no fabrication) ----
  const summary = useMemo(() => {
    const holdingsValue = positions.reduce((s, p) => s + p.currentValue, 0);
    const collateral = writerRows.reduce((s, r) => s + r.collateralDeposited, 0);
    const holderClaimable = positions
      .filter((p) => p.state === "settled-itm")
      .reduce((s, p) => s + p.currentValue, 0);
    const writerPremium = writerRows.reduce((s, r) => s + usdcToNumber(r.claimableUsdc), 0);
    const claimableNow = holderClaimable + writerPremium;
    const lockedRows = writerRows.filter((r) => r.state === "settled-locked");
    const lockedAmount = lockedRows.reduce((s, r) => s + r.collateralDeposited, 0);
    const nextUnlock = lockedRows.length
      ? Math.min(...lockedRows.map((r) => r.expiry + EXERCISE_WINDOW_SECONDS))
      : null;
    return {
      holdingsValue, collateral, claimableNow, lockedAmount,
      lockedUnlockLabel: nextUnlock ? `unlocks ${fmtCountdown(nextUnlock, nowSecs)}` : null,
    };
  }, [positions, writerRows, nowSecs]);

  // ---- per-asset profitability rollup (live even while sections collapse) ----
  const assetRows = useMemo(
    () => buildAssetRollup(positions, writerRows, spotPrices, nowSecs),
    [positions, writerRows, spotPrices, nowSecs],
  );

  // ---- action dispatchers (reuse the byte-identical flows) ----
  const handleHolder = (p: Position, action: PositionAction) => {
    switch (action) {
      case "exercise": actions.exercise(p); break;
      case "exercise-american": actions.exerciseAmerican(p); break;
      case "cancel-resale": actions.cancelResale(p); break;
      default: break; // list-resale / burn / none parked in terminal
    }
  };
  const handleWriter = (row: WriterRow, action: WriterRowAction) => {
    switch (action) {
      case "claim-premium": writerActions.claimPremium(row); break;
      case "withdraw-collateral": writerActions.withdrawCollateral(row); break;
      case "burn-unsold": writerActions.burnUnsoldEscrow(row); break;
      case "settling": break;
    }
  };

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-l-bg font-sans text-l-text">
      <TerminalAppBar mode={mode} onToggleMode={toggle} />

      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-[1180px] px-[clamp(16px,3vw,40px)] py-[clamp(20px,4vh,40px)]">
          {!connected ? (
            <div className="flex min-h-[50vh] flex-col items-center justify-center gap-3 text-center">
              <p className="font-mono-plex text-[12px] text-l-muted">Connect your wallet to view your positions.</p>
              <button
                type="button"
                onClick={() => setVisible(true)}
                className="rounded-[6px] bg-l-up px-[16px] py-[9px] font-sans text-[13px] font-medium text-l-on-up transition-opacity hover:opacity-90"
              >
                Connect wallet
              </button>
            </div>
          ) : (
            <>
              <SummaryStrip
                claimableNow={summary.claimableNow}
                lockedAmount={summary.lockedAmount}
                lockedUnlockLabel={summary.lockedUnlockLabel}
                collateral={summary.collateral}
                holdingsValue={summary.holdingsValue}
                claimableCount={claim.claimableCount}
                claiming={claim.claiming}
                progress={claim.progress}
                onClaimAll={claim.claimAll}
              />

              <ByAssetSection
                rows={assetRows}
                loading={loading}
                collapsed={collapsed("byAsset")}
                onToggle={() => toggleSection("byAsset")}
              />

              <HoldingsLedger
                positions={positions}
                loading={loading}
                onAction={handleHolder}
                busyId={actions.busyId}
                collapsed={collapsed("holdings")}
                onToggle={() => toggleSection("holdings")}
              />

              <WrittenLedger
                rows={writerRows}
                loading={loading}
                nowSecs={nowSecs}
                onAction={handleWriter}
                busyId={writerActions.busyId}
                busyLabel={writerActions.busyLabel}
                collapsed={collapsed("written")}
                onToggle={() => toggleSection("written")}
              />

              <ActivitySection
                rows={activity.rows}
                loading={activity.loading}
                collapsed={collapsed("activity")}
                onToggle={() => toggleSection("activity")}
              />

              <UtilitiesSection
                vaults={vaults}
                markets={markets}
                settlementRecords={settlementRecords}
                onRefetch={refetchAll}
                collapsed={collapsed("utilities")}
                onToggle={() => toggleSection("utilities")}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default PortfolioTerminalPage;
