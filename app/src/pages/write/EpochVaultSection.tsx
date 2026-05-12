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
import { trackOptaEvent } from "../../utils/analytics";

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

  const handleSubmit = async () => {
    if (!chosen || strikeNum <= 0 || contractsNum <= 0) return;
    try {
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
        if (result.vaultCreated) {
          trackOptaEvent("vault_create_success", {
            vault: result.vaultPda.toBase58(),
            asset: chosen.ticker,
            strike: strikeNum,
            expiry: epochExpiryTs,
            type: values.side,
            vault_type: "epoch",
            collateral_usdc: collateral,
            tx: result.txSignature,
          });
        }
        trackOptaEvent("vault_mint_success", {
          vault: result.vaultPda.toBase58(),
          asset: chosen.ticker,
          strike: strikeNum,
          expiry: epochExpiryTs,
          type: values.side,
          qty: contractsNum,
          premium_per_contract: Math.max(premiumPerContract, 0.000001),
          tx: result.txSignature,
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
