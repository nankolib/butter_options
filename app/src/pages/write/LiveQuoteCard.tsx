import type { FC } from "react";
import { useEffect, useState } from "react";
import { MoneyAmount } from "../../components/MoneyAmount";
import { HairlineRule } from "../../components/layout";
import {
  applyVolSmile,
  calculateCallPremium,
  calculatePutPremium,
  getDefaultVolatility,
} from "../../utils/blackScholes";
import { requiredCollateralPerContract } from "../../utils/collateral";

type LiveQuoteCardProps = {
  asset: string | null;
  side: "call" | "put";
  strike: number;
  /** Expiry as Unix seconds, or null when not yet chosen. */
  expiry: number | null;
  contracts: number;
  spot: number | null;
  /** True when spot is sourced from stale cache (Hermes outage > 60s). */
  spotStale?: boolean;
  /** Footer prose under the figures. */
  footnote: string;
  /** When true, render — placeholders (e.g. wallet disconnected). */
  isPlaceholder?: boolean;
};

/**
 * Sticky right-side card. Reads form values + Pyth spot, computes
 * premium via blackScholes utils, re-ticks every 30s so theta and
 * countdown drift visibly.
 *
 * Re-tick is via setInterval that bumps a local nonce — the heavy
 * compute lives in the parent's hook chain (asset, spot via
 * usePythPrices). The interval here only forces re-render so the
 * "now"-dependent fields (days-to-expiry, fair value) recompute.
 */
export const LiveQuoteCard: FC<LiveQuoteCardProps> = ({
  asset,
  side,
  strike,
  expiry,
  contracts,
  spot,
  spotStale = false,
  footnote,
  isPlaceholder = false,
}) => {
  const [, setNonce] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNonce((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const ready = !isPlaceholder && asset && strike > 0 && expiry != null && spot != null && spot > 0;

  // Baseline IV — static per-asset default. Smile-adjusted for the strike.
  const baselineIv = ready
    ? applyVolSmile(getDefaultVolatility(asset!), spot!, strike, asset!)
    : null;

  // Days to expiry (now-dependent — drives the 30s re-tick).
  const daysToExpiry = ready ? Math.max(0, (expiry! - Date.now() / 1000) / 86400) : null;

  // Per-contract premium via Black-Scholes.
  const premiumPerContract =
    ready && daysToExpiry != null && daysToExpiry > 0
      ? side === "call"
        ? calculateCallPremium(spot!, strike, daysToExpiry, baselineIv ?? 0.8)
        : calculatePutPremium(spot!, strike, daysToExpiry, baselineIv ?? 0.8)
      : null;

  const totalPremium =
    premiumPerContract != null && contracts > 0 ? premiumPerContract * contracts : null;

  // Collateral required for the user's chosen contracts. Helper lives in
  // utils/collateral.ts and mirrors programs/opta/src/utils/collateral.rs.
  const collateralPerContract = requiredCollateralPerContract(strike, side);
  const collateralRequired = contracts > 0 ? collateralPerContract * contracts : null;

  // Breakeven for the buyer (writer's max-profit threshold).
  const breakeven =
    premiumPerContract != null
      ? side === "call"
        ? strike + premiumPerContract
        : strike - premiumPerContract
      : null;

  return (
    <aside className="lg:sticky lg:top-[140px] lg:self-start">
      <div className="border border-rule rounded-md bg-paper p-6">
        <div className="flex items-center gap-2 mb-5">
          <span aria-hidden="true" className="inline-block w-[6px] h-[6px] rounded-full bg-crimson" />
          <h3 className="m-0 font-fraunces-text italic font-light text-ink text-[18px] leading-tight">
            Indicative premium
          </h3>
        </div>

        <Row label="Spot">
          {spot != null && !isPlaceholder ? (
            <>
              <MoneyAmount value={spot} />
              {spotStale && <span className="text-ink-muted"> · delayed</span>}
            </>
          ) : "—"}
        </Row>
        <Row label="Baseline IV">
          {baselineIv != null ? `${(baselineIv * 100).toFixed(1)}%` : "—"}
        </Row>
        <Row label="Premium / contract">
          {premiumPerContract != null ? <MoneyAmount value={premiumPerContract} /> : "—"}
        </Row>
        <Row label="Total premium" emphasis>
          {totalPremium != null ? (
            <span className="text-crimson"><MoneyAmount value={totalPremium} /></span>
          ) : (
            "—"
          )}
        </Row>
        <Row label="Collateral">
          {collateralRequired != null ? <MoneyAmount value={collateralRequired} /> : "—"}
        </Row>
        <Row label="Breakeven">
          {breakeven != null ? <MoneyAmount value={breakeven} /> : "—"}
        </Row>

        <HairlineRule className="my-5" weight="soft" />

        <p className="m-0 font-sans italic font-normal leading-[1.5] opacity-75 text-[13px]">
          {footnote}
        </p>
      </div>
    </aside>
  );
};

const Row: FC<{
  label: string;
  emphasis?: boolean;
  children: React.ReactNode;
}> = ({ label, emphasis = false, children }) => (
  <div
    className={`flex items-baseline justify-between py-2 ${
      emphasis ? "border-y border-rule-soft my-1" : ""
    }`}
  >
    <span className="font-mono font-medium text-[10.5px] uppercase tracking-[0.2em] text-ink-muted">
      {label}
    </span>
    <span className={`font-mono ${emphasis ? "text-[15px]" : "text-[13px]"} text-ink whitespace-nowrap`}>
      {children}
    </span>
  </div>
);

export default LiveQuoteCard;
