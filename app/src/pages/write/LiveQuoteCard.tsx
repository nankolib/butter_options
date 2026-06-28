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

  // Base readiness — everything the American on-chain quote needs. It carries
  // the oracle's OWN spot, so it does NOT require the Hermes display spot; a
  // transient Hermes-spot miss must not suppress it.
  const baseReady = Boolean(!isPlaceholder && asset && strike > 0 && expiry != null);
  // Full readiness for the European client-side estimate, which genuinely needs
  // a spot client-side (calculateCallPremium / applyVolSmile take spot).
  const ready = baseReady && spot != null && spot > 0;

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
  // Gated on baseReady (NOT `ready`) — the on-chain quote carries the oracle's
  // own spot, so it fires even when the Hermes display spot is momentarily null.
  // The shared hook owns the debounce + .view() call. carry 0 matches createSharedVault.
  const amerParams =
    isAmerican && baseReady && expiry != null
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
  } = useOptionPriceQuote(isAmerican && baseReady, market, amerParams);

  // ---- Stale/warming-oracle fallback (Phase 2c-FE) ----
  // When the American on-chain quote reverts because the vol oracle is STALE or
  // still WARMING, the write WILL fail on-chain — but the page shouldn't go blank.
  // Show the European client-side estimate as an INDICATIVE figure (if a spot is
  // available) + a tailored advisory. ONLY these two revert kinds trigger this;
  // every other error keeps its existing muted status line. NEVER disables the
  // write button (the program is the real gate — advisory, not blocking).
  const oracleUnavailableKind =
    isAmerican &&
    (amerError?.kind === "oracle-stale" || amerError?.kind === "oracle-warmup")
      ? amerError.kind
      : null;
  const useIndicative = oracleUnavailableKind != null && bsPremiumPerContract != null;
  const oracleAdvisory =
    oracleUnavailableKind === "oracle-stale"
      ? "On-chain oracle is stale — writes will fail until a fresh price pushes (typically after market open / on an SB-sourced market)."
      : oracleUnavailableKind === "oracle-warmup"
        ? "On-chain oracle is still warming up — writes unavailable until it has enough samples."
        : null;

  // ---- Display values (branch on style) ----
  const displayIv = isAmerican
    ? useIndicative
      ? baselineIv
      : amerQuote?.volAnnualized ?? null
    : baselineIv;
  const ivLabel = isAmerican
    ? useIndicative
      ? "Indicative IV"
      : "On-chain IV"
    : "Baseline IV";
  const premiumPerContract = isAmerican
    ? useIndicative
      ? bsPremiumPerContract
      : amerQuote?.premiumPerContract ?? null
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

  // SPOT row value: the Hermes display spot, or — when American + the Hermes spot
  // is null but the on-chain quote succeeded — the oracle's own spot from the
  // quote. Degrades to "—" only when BOTH are null; never blanks the premium rows.
  const spotFromOracle = spot == null && isAmerican && amerQuote?.spotUsed != null;
  const displaySpot = spot ?? (isAmerican ? amerQuote?.spotUsed ?? null : null);

  // Gated on baseReady (NOT `ready`) so the status/advisory show whenever the
  // quote actually ran — independent of the Hermes display spot. For the
  // stale/warmup case the prominent advisory below replaces the muted line; keep
  // the muted line for every other state (loading, fresh quote, other reverts).
  const amerStatus =
    isAmerican && baseReady && !oracleAdvisory
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
          {displaySpot != null && !isPlaceholder ? (
            <>
              <MoneyAmount value={displaySpot} />
              {spotStale && !spotFromOracle && (
                <span className="text-ink-muted"> · delayed</span>
              )}
              {spotFromOracle && <span className="text-ink-muted"> · oracle</span>}
            </>
          ) : "—"}
        </Row>
        <Row label={ivLabel}>
          {displayIv != null ? `${(displayIv * 100).toFixed(1)}%` : "—"}
        </Row>
        <Row label="Premium / contract">
          {premiumPerContract != null ? <MoneyAmount value={premiumPerContract} /> : "—"}
        </Row>
        {useIndicative && (
          <div className="font-mono font-medium text-[9.5px] uppercase tracking-[0.16em] text-ink-muted -mt-1 mb-1 text-right leading-[1.5]">
            indicative — not the on-chain price
          </div>
        )}
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

        {/* Prominent, unmissable advisory for a stale/warming oracle — the write
            will fail on-chain. Informational only; the Create/Write button stays
            enabled (the program is the real gate). */}
        {oracleAdvisory && (
          <div className="border border-crimson/30 rounded-sm p-3 mt-3 font-sans italic font-medium leading-[1.5] text-ink-body text-[13px]">
            {oracleAdvisory}
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
