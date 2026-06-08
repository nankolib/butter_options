import type { FC } from "react";
import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { MoneyAmount } from "../../components/MoneyAmount";
import { HairlineRule } from "../../components/layout";
import {
  applyVolSmile,
  calculateCallPremium,
  calculatePutPremium,
  getDefaultVolatility,
} from "../../utils/blackScholes";
import { requiredCollateralPerContract } from "../../utils/collateral";
import { useOptionPriceQuote } from "../../hooks/useOptionPriceQuote";
import { describeOptionPriceQuoteStatus } from "../../utils/optionPriceQuote";

type LiveQuoteCardProps = {
  asset: string | null;
  side: "call" | "put";
  /**
   * European = off-chain Black-Scholes preview (default). American = on-chain
   * BS-2002 quote via get_option_price. While AMERICAN_ENABLED_UI is false the
   * Write toggle can't select American, so this branch is dark in production;
   * it lights up for the local eyeball pass and at Stage I.
   */
  exerciseStyle: "european" | "american";
  /** Chosen asset's market — needed to derive the vol_oracle PDA for the
   *  American on-chain quote. Null when no asset is selected. */
  market: { publicKey: PublicKey; account: any } | null;
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
 * Sticky right-side card. Reads form values + Pyth spot, computes premium via
 * blackScholes utils (European) OR the on-chain get_option_price view
 * (American), re-ticks every 30s so theta and countdown drift visibly.
 *
 * American branch: debounced .view() call (no wallet popup — empty signers)
 * priced against the live VolOracle. Premium + IV come from the protocol; the
 * headline Spot row stays live Hermes, with the oracle's spot + timestamp
 * shown in a sub-line so the (possibly minutes-old) on-chain snapshot is
 * explicit. Reverts (warmup / stale / not-initialized) degrade to a muted
 * status line rather than crashing the card.
 */
export const LiveQuoteCard: FC<LiveQuoteCardProps> = ({
  asset,
  side,
  exerciseStyle,
  market,
  strike,
  expiry,
  contracts,
  spot,
  spotStale = false,
  footnote,
  isPlaceholder = false,
}) => {
  const isAmerican = exerciseStyle === "american";

  const [, setNonce] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNonce((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const ready = Boolean(
    !isPlaceholder && asset && strike > 0 && expiry != null && spot != null && spot > 0,
  );

  // ---- European (off-chain Black-Scholes) ----
  // Baseline IV — static per-asset default. Smile-adjusted for the strike.
  const baselineIv = ready
    ? applyVolSmile(getDefaultVolatility(asset!), spot!, strike, asset!)
    : null;
  // Days to expiry (now-dependent — drives the 30s re-tick).
  const daysToExpiry = ready ? Math.max(0, (expiry! - Date.now() / 1000) / 86400) : null;
  const bsPremiumPerContract =
    ready && daysToExpiry != null && daysToExpiry > 0
      ? side === "call"
        ? calculateCallPremium(spot!, strike, daysToExpiry, baselineIv ?? 0.8)
        : calculatePutPremium(spot!, strike, daysToExpiry, baselineIv ?? 0.8)
      : null;

  // ---- American (on-chain get_option_price view, lazy + debounced) ----
  // Only fetches when American + inputs ready (enabled gate); the shared hook
  // owns the debounce + .view() call. carry 0 matches createSharedVault.
  const amerParams =
    isAmerican && ready && expiry != null
      ? {
          strike,
          expiryTs: expiry,
          side,
          exerciseStyle: "american" as const,
          carryRateBps: 0,
        }
      : null;
  const {
    quote: amerQuote,
    error: amerError,
    loading: amerLoading,
  } = useOptionPriceQuote(isAmerican && ready, market, amerParams);

  // ---- Display values (branch on style) ----
  const displayIv = isAmerican ? amerQuote?.volAnnualized ?? null : baselineIv;
  const ivLabel = isAmerican ? "On-chain IV" : "Baseline IV";
  const premiumPerContract = isAmerican
    ? amerQuote?.premiumPerContract ?? null
    : bsPremiumPerContract;

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

  const amerStatus =
    isAmerican && ready
      ? describeOptionPriceQuoteStatus(amerLoading, amerError, amerQuote)
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
        <Row label={ivLabel}>
          {displayIv != null ? `${(displayIv * 100).toFixed(1)}%` : "—"}
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

        {amerStatus && (
          <div className="font-mono font-medium text-[10px] uppercase tracking-[0.16em] text-ink-muted mt-3 leading-[1.5]">
            {amerStatus}
          </div>
        )}

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
