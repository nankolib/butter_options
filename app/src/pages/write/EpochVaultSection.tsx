import type { FC } from "react";
import { useMemo } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { SectionNumber } from "../../components/layout";
import { showToast } from "../../components/Toast";
import { WriterForm, type WriterFormValues, type AssetOption } from "./WriterForm";
import { LiveQuoteCard } from "./LiveQuoteCard";
import {
  applyVolSmile,
  calculateCallPremium,
  calculatePutPremium,
  getDefaultVolatility,
} from "../../utils/blackScholes";
import { requiredCollateralPerContract } from "../../utils/collateral";
import { useWriteSubmit, type WriteSubmitResult } from "./useWriteSubmit";
import { decodeError } from "../../utils/errorDecoder";
import {
  isMarketHours,
  buildMarketClosedTooltip,
  type AssetClass,
} from "../../utils/marketHours";

type EpochVaultSectionProps = {
  values: WriterFormValues;
  onChange: (next: WriterFormValues) => void;
  assets: AssetOption[];
  spotForChosenAsset: number | null;
  spotStale: boolean;
  /** Computed expiry timestamp for next Friday (Unix seconds). */
  epochExpiryTs: number;
  /** Pretty label for the expiry, rendered in the form's read-only tail. */
  epochExpiryLabel: string;
  /** Called on successful submit so the page can render its banner. */
  onSuccess: (result: WriteSubmitResult & { kind: "epoch" | "custom" }) => void;
  /** W1 vol-oracle gate inputs. See CustomVaultSection for full notes. */
  unseededTickers: ReadonlySet<string>;
  checkVolOracle: (feedIdHex: string) => Promise<boolean>;
};

/**
 * § 01 · Epoch vault section. RECOMMENDED pill in the header,
 * italic tagline on the right, paired form + LiveQuoteCard underneath.
 *
 * Form values are owned by the parent (WritePage) so each section's
 * values persist when the user scrolls between sections without
 * losing input.
 */
export const EpochVaultSection: FC<EpochVaultSectionProps> = ({
  values,
  onChange,
  assets,
  spotForChosenAsset,
  spotStale,
  epochExpiryTs,
  epochExpiryLabel,
  onSuccess,
  unseededTickers,
  checkVolOracle,
}) => {
  const { connected } = useWallet();
  const { setVisible } = useWalletModal();
  const { submitting, stageLabel, submit } = useWriteSubmit();

  const contractsNum = parseInt(values.contracts || "0", 10) || 0;
  const strikeNum = parseFloat(values.strike) || 0;

  const chosen = useMemo(
    () => assets.find((a) => a.ticker === values.asset) ?? null,
    [assets, values.asset],
  );

  // W3 market-hours gate. Epoch expiry is fixed at 08:00 UTC, which is
  // ALWAYS before NYSE opens (13:30 UTC DST / 14:30 UTC standard) — so for
  // equity/ETF assets the Epoch flow is structurally un-settleable until
  // EpochConfig supports a per-asset-class hour. v1 blocks at submit.
  const marketHoursBlock = useMemo<{ tooltip: string } | null>(() => {
    if (!chosen) return null;
    const assetClass = chosen.market.account.assetClass as AssetClass;
    const result = isMarketHours(epochExpiryTs, assetClass);
    if (result.ok) return null;
    return {
      tooltip: buildMarketClosedTooltip(result, Math.floor(Date.now() / 1000)),
    };
  }, [chosen, epochExpiryTs]);

  // W1 vol-oracle gate. See CustomVaultSection for full notes.
  const volOracleBlock = useMemo<{ tooltip: string } | null>(() => {
    if (!chosen) return null;
    if (!unseededTickers.has(chosen.ticker)) return null;
    return {
      tooltip: `Vol oracle for ${chosen.ticker} not yet seeded. New markets need ~1 hour for the oracle crank to initialize the oracle. Try again later, or contact support if this persists past 24 hours.`,
    };
  }, [chosen, unseededTickers]);

  const handleSubmit = async () => {
    if (!chosen || strikeNum <= 0 || contractsNum <= 0) return;
    try {
      // W1 submit-click pre-flight — see CustomVaultSection for full notes.
      const feedIdHex = Buffer.from(chosen.market.account.pythFeedId as number[]).toString("hex");
      const oracleOk = await checkVolOracle(feedIdHex);
      if (!oracleOk) {
        throw new Error(
          `Vol oracle for ${chosen.ticker} not yet seeded. New markets need ~1 hour for the oracle crank to initialize the oracle. Try again later, or contact support if this persists past 24 hours.`,
        );
      }

      // MED-6: prefer Advanced-mode override if writer provided a valid
      // positive value. Empty string or invalid input falls back to the
      // Black-Scholes-derived default (matches LiveQuoteCard's preview).
      const overrideStr = values.premiumPerContract.trim();
      const overrideNum = overrideStr ? parseFloat(overrideStr) : NaN;
      const useOverride = !isNaN(overrideNum) && overrideNum > 0;

      const spot = spotForChosenAsset ?? 0;
      const baselineIv =
        spot > 0
          ? applyVolSmile(getDefaultVolatility(chosen.ticker), spot, strikeNum, chosen.ticker)
          : getDefaultVolatility(chosen.ticker);
      const days = Math.max(0, (epochExpiryTs - Date.now() / 1000) / 86400);
      const bsPremium =
        spot > 0 && days > 0
          ? values.side === "call"
            ? calculateCallPremium(spot, strikeNum, days, baselineIv)
            : calculatePutPremium(spot, strikeNum, days, baselineIv)
          : 0;
      const premiumPerContract = useOverride ? overrideNum : bsPremium;
      const collateralPerContract = requiredCollateralPerContract(strikeNum, values.side);
      const collateral = collateralPerContract * contractsNum;

      const result = await submit({
        market: chosen.market,
        side: values.side,
        strike: strikeNum,
        expiry: epochExpiryTs,
        contracts: contractsNum,
        premiumPerContract: Math.max(premiumPerContract, 0.000001),
        collateral,
        vaultType: "epoch",
      });

      if (result) {
        showToast({
          type: "success",
          title: "Epoch vault written",
          message: `${contractsNum} ${chosen.ticker} ${values.side.toUpperCase()} contracts minted`,
          txSignature: result.txSignature,
        });
        onSuccess({ ...result, kind: "epoch" });
      }
    } catch (err: any) {
      const msg = decodeError(err);
      showToast({
        type: "error",
        title: "Write failed",
        message: msg,
      });
    }
  };

  return (
    <section className="mt-16">
      <div className="flex flex-wrap items-end justify-between gap-6 mb-8">
        <div className="flex items-center gap-4">
          <SectionNumber number="01" label="Epoch vault" />
          <span className="inline-flex items-center font-mono text-[10px] uppercase tracking-[0.2em] border border-crimson rounded-full px-2.5 py-1 text-crimson">
            Recommended
          </span>
        </div>
        <p className="m-0 max-w-[420px] font-sans italic font-normal leading-[1.5] opacity-75 text-[14px]">
          Weekly settlement, every Friday. Writers deposit USDC and receive
          writer-share tokens that earn premium as buyers fill the strike.
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_360px] gap-x-12 gap-y-10">
        <WriterForm
          mode="epoch"
          values={values}
          onChange={onChange}
          assets={assets}
          epochExpiryLabel={epochExpiryLabel}
          spotForChosenAsset={spotForChosenAsset}
          connected={connected}
          submitting={submitting}
          stageLabel={stageLabel}
          onSubmit={handleSubmit}
          onConnectClick={() => setVisible(true)}
          marketHoursBlock={marketHoursBlock}
          volOracleBlock={volOracleBlock}
          unseededTickers={unseededTickers}
        />
        <LiveQuoteCard
          asset={values.asset}
          side={values.side}
          strike={strikeNum}
          expiry={epochExpiryTs}
          contracts={contractsNum}
          spot={spotForChosenAsset}
          spotStale={spotStale}
          isPlaceholder={!connected}
          footnote="Premium is paid into the vault as buyers fill — accrued share-by-share, claimable on settlement."
        />
      </div>
    </section>
  );
};

export default EpochVaultSection;
