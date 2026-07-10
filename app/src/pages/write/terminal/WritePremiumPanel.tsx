// =============================================================================
// WritePremiumPanel — terminal premium centerpiece + greeks (right rail).
// =============================================================================
//
// A terminal restyle of LiveQuoteCard: same honest quote logic (European =
// off-chain Black-Scholes; American = on-chain BS-2002 via useOptionPriceQuote,
// with the stale/warmup indicative fallback), re-laid-out as the split-cockpit
// right panel — a `PREMIUM · …` eyebrow, the premium centerpiece (largest
// numeral on the page, Plex Mono tabular), a `total received · X.XX / ct`
// subline, a greeks grid, a hairline, and the collateral-total row.
//
// Greeks are FE-computed (calculateCall/PutGreeks) from spot · strike · days ·
// IV, where IV = the on-chain volAnnualized (American) or the baseline smile
// (European). Breakeven = strike ± premium. Display-only — zero tx impact.
// =============================================================================

import type { FC } from "react";
import { useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import {
  applyVolSmile,
  calculateCallPremium,
  calculatePutPremium,
  calculateCallGreeks,
  calculatePutGreeks,
  getDefaultVolatility,
} from "../../../utils/blackScholes";
import { requiredCollateralPerContract } from "../../../utils/collateral";
import { useOptionPriceQuote } from "../../../hooks/useOptionPriceQuote";
import { describeOptionPriceQuoteStatus } from "../../../utils/optionPriceQuote";

type Props = {
  asset: string | null;
  side: "call" | "put";
  exerciseStyle: "european" | "american";
  market: { publicKey: PublicKey; account: any } | null;
  strike: number;
  /** Front/active expiry as Unix seconds, or null when not yet resolved. */
  expiry: number | null;
  /** Total contracts across all cells (drives "total received"). */
  contracts: number;
  spot: number | null;
  spotStale?: boolean;
  /** True when the wallet is disconnected — render placeholders, not numbers. */
  isPlaceholder?: boolean;
  /** Footnote prose under the collateral row. */
  footnote: string;
};

const fmtUsd = (v: number, dp = 2) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

export const WritePremiumPanel: FC<Props> = ({
  asset,
  side,
  exerciseStyle,
  market,
  strike,
  expiry,
  contracts,
  spot,
  spotStale = false,
  isPlaceholder = false,
  footnote,
}) => {
  const isAmerican = exerciseStyle === "american";

  // Re-tick every 30s so theta / countdown drift visibly.
  const [, setNonce] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setNonce((n) => n + 1), 30_000);
    return () => clearInterval(id);
  }, []);

  const baseReady = Boolean(!isPlaceholder && asset && strike > 0 && expiry != null);
  const ready = baseReady && spot != null && spot > 0;

  // ---- European (off-chain Black-Scholes) ----
  const baselineIv = ready ? applyVolSmile(getDefaultVolatility(asset!), spot!, strike, asset!) : null;
  const daysToExpiry = ready ? Math.max(0, (expiry! - Date.now() / 1000) / 86400) : null;
  const bsPremiumPerContract =
    ready && daysToExpiry != null && daysToExpiry > 0
      ? side === "call"
        ? calculateCallPremium(spot!, strike, daysToExpiry, baselineIv ?? 0.8)
        : calculatePutPremium(spot!, strike, daysToExpiry, baselineIv ?? 0.8)
      : null;

  // ---- American (on-chain get_option_price view, lazy + debounced) ----
  const amerParams =
    isAmerican && baseReady && expiry != null
      ? { strike, expiryTs: expiry, side, exerciseStyle: "american" as const, carryRateBps: 0 }
      : null;
  const { quote: amerQuote, error: amerError, loading: amerLoading } = useOptionPriceQuote(
    isAmerican && baseReady,
    market,
    amerParams,
  );

  // Stale / warming oracle → indicative European estimate + advisory (never blocks).
  const oracleUnavailableKind =
    isAmerican && (amerError?.kind === "oracle-stale" || amerError?.kind === "oracle-warmup")
      ? amerError.kind
      : null;
  const useIndicative = oracleUnavailableKind != null && bsPremiumPerContract != null;
  const oracleAdvisory =
    oracleUnavailableKind === "oracle-stale"
      ? "On-chain oracle is stale — writes will fail until a fresh price pushes."
      : oracleUnavailableKind === "oracle-warmup"
        ? "On-chain oracle is still warming up — writes unavailable until it has enough samples."
        : null;

  // ---- Resolved display values ----
  const iv = isAmerican
    ? useIndicative
      ? baselineIv
      : amerQuote?.volAnnualized ?? null
    : baselineIv;
  const ivLabel = isAmerican ? (useIndicative ? "IV · IND" : "IV") : "IV";
  const premiumPerContract = isAmerican
    ? useIndicative
      ? bsPremiumPerContract
      : amerQuote?.premiumPerContract ?? null
    : bsPremiumPerContract;

  const totalReceived =
    premiumPerContract != null && contracts > 0 ? premiumPerContract * contracts : null;

  const collateralPerContract = requiredCollateralPerContract(strike, side);
  const collateralTotal = contracts > 0 ? collateralPerContract * contracts : null;

  const breakeven =
    premiumPerContract != null
      ? side === "call"
        ? strike + premiumPerContract
        : strike - premiumPerContract
      : null;

  // Greeks — FE-computed from the resolved IV. Uses the display spot, or the
  // oracle's own spot when the American quote carried it (Hermes spot momentarily
  // null). days from the active expiry.
  const spotForGreeks = spot ?? (isAmerican ? amerQuote?.spotUsed ?? null : null);
  const daysForGreeks = expiry != null ? Math.max(0, (expiry - Date.now() / 1000) / 86400) : 0;
  const greeks =
    spotForGreeks != null && spotForGreeks > 0 && strike > 0 && daysForGreeks > 0 && iv != null
      ? side === "call"
        ? calculateCallGreeks(spotForGreeks, strike, daysForGreeks, iv)
        : calculatePutGreeks(spotForGreeks, strike, daysForGreeks, iv)
      : null;

  const amerStatus =
    isAmerican && baseReady && !oracleAdvisory
      ? describeOptionPriceQuoteStatus(amerLoading, amerError, amerQuote)
      : null;

  const loadingCenterpiece = isAmerican && baseReady && amerLoading && premiumPerContract == null;
  const eyebrow = isAmerican ? "PREMIUM · BS-2002" : "PREMIUM · BLACK-SCHOLES";
  const perCt = premiumPerContract != null && contracts > 0 ? premiumPerContract : null;

  return (
    <div className="flex h-full flex-col">
      <div className="font-mono-plex text-[10px] uppercase tracking-[0.18em] text-l-muted">
        {eyebrow}
      </div>

      {/* Centerpiece — the largest numeral on the page */}
      <div className="mt-3" data-testid="premium-centerpiece">
        {loadingCenterpiece ? (
          <div className="h-[46px] w-[62%] animate-l-pulse rounded-[4px] bg-l-surface-2" />
        ) : (
          <div className="font-mono-plex text-[46px] font-medium leading-none tabular-nums text-l-text">
            {totalReceived != null ? fmtUsd(totalReceived) : "—"}
          </div>
        )}
        <div className="mt-2 font-mono-plex text-[11px] tabular-nums text-l-muted">
          total received
          {perCt != null && <> · {fmtUsd(perCt)} / ct</>}
          {spotStale && !isPlaceholder && spot != null && <> · spot delayed</>}
        </div>
      </div>

      {useIndicative && (
        <div className="mt-2 font-mono-plex text-[9.5px] uppercase tracking-[0.14em] text-l-muted">
          indicative — not the on-chain price
        </div>
      )}

      {/* Greeks grid */}
      <div className="mt-6 grid grid-cols-3 gap-x-6 gap-y-4">
        <Greek label="DELTA" value={greeks ? greeks.delta.toFixed(3) : "—"} />
        <Greek label="GAMMA" value={greeks ? greeks.gamma.toFixed(4) : "—"} />
        <Greek label="THETA" value={greeks ? greeks.theta.toFixed(3) : "—"} />
        <Greek label="VEGA" value={greeks ? greeks.vega.toFixed(3) : "—"} />
        <Greek label={ivLabel} value={iv != null ? `${(iv * 100).toFixed(1)}%` : "—"} />
        <Greek label="BREAKEVEN" value={breakeven != null ? fmtUsd(breakeven) : "—"} />
      </div>

      {amerStatus && (
        <div className="mt-4 font-mono-plex text-[10px] uppercase tracking-[0.14em] text-l-muted">
          {amerStatus}
        </div>
      )}
      {oracleAdvisory && (
        <div className="mt-4 rounded-[6px] border border-l-down/40 p-3 font-sans text-[12.5px] leading-[1.5] text-l-text">
          {oracleAdvisory}
        </div>
      )}

      <div className="my-6 h-px w-full bg-l-hair" />

      <div className="flex items-baseline justify-between">
        <span className="font-mono-plex text-[10px] uppercase tracking-[0.18em] text-l-muted">
          Collateral total
        </span>
        <span className="font-mono-plex text-[15px] tabular-nums text-l-text">
          {collateralTotal != null ? fmtUsd(collateralTotal) : "—"}
        </span>
      </div>

      <p className="mt-auto pt-6 font-sans text-[12px] leading-[1.55] text-l-muted">{footnote}</p>
    </div>
  );
};

const Greek: FC<{ label: string; value: string }> = ({ label, value }) => (
  <div>
    <div className="font-mono-plex text-[9px] uppercase tracking-[0.14em] text-l-faint">{label}</div>
    <div className="mt-1 font-mono-plex text-[15px] tabular-nums text-l-text">{value}</div>
  </div>
);

export default WritePremiumPanel;
