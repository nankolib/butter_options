import type { FC } from "react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { PublicKey } from "@solana/web3.js";
import { ExpiryPicker, type ExpiryPresetId } from "./ExpiryPicker";

export type WriterFormValues = {
  asset: string | null;
  side: "call" | "put";
  /** Strike in USDC (human-readable). Empty string when unset. */
  strike: string;
  contracts: string;
  /** For Custom mode: resolved Unix-seconds expiry. For Epoch mode: provided by parent (next Friday). */
  expiry: number | null;
  expiryPreset: ExpiryPresetId;
  /**
   * Optional premium-per-contract override (USDC, human-readable). Empty
   * string = use the B-S-derived default. Non-empty + parsed > 0 =
   * sophisticated-writer override. MED-6: surfaced via collapsible
   * Advanced section so default writers don't see the input.
   */
  premiumPerContract: string;
};

export type AssetOption = {
  /** Asset ticker (e.g. "SOL"). Drives the chip label and is the unique key. */
  ticker: string;
  /** A representative market account whose pythFeedId and assetClass we'll reuse on submit. */
  market: { publicKey: PublicKey; account: any };
};

type WriterFormProps = {
  mode: "epoch" | "custom";
  values: WriterFormValues;
  onChange: (next: WriterFormValues) => void;
  /** Asset chips derived from existing on-chain markets. Empty list = empty state. */
  assets: AssetOption[];
  /** For Epoch mode: read-only label for "settles next Friday". Ignored in Custom. */
  epochExpiryLabel?: string;
  /** Live spot for the currently chosen asset. Drives the moneyness hint. Null when missing. */
  spotForChosenAsset: number | null;
  /** Wallet connection — controls submit-button copy and enabled state. */
  connected: boolean;
  /** Submit-in-flight flag; disables CTA. */
  submitting: boolean;
  /** Optional stage label rendered next to the CTA while submitting (e.g. "2/4 · Creating vault"). */
  stageLabel: string | null;
  onSubmit: () => void;
  /** Triggered when CTA is clicked while disconnected — parent opens wallet modal. */
  onConnectClick: () => void;
};

/**
 * Shared form for Epoch and Custom vault flows. Mode-specific tail:
 *   - Epoch: read-only "settles next Friday" line (no expiry input).
 *   - Custom: ExpiryPicker with preset row + date/time inputs.
 *
 * Asset chips render only assets that already have on-chain markets;
 * when the asset list is empty the form renders a clean empty-state
 * with a link to /markets.
 *
 * Strike is a free-form numeric input with a live moneyness hint
 * (vs spot from usePythPrices, passed in via spotForChosenAsset).
 */
export const WriterForm: FC<WriterFormProps> = ({
  mode,
  values,
  onChange,
  assets,
  epochExpiryLabel,
  spotForChosenAsset,
  connected,
  submitting,
  stageLabel,
  onSubmit,
  onConnectClick,
}) => {
  // If the chosen asset disappears from the asset list (e.g. data refresh
  // dropped it), reset to first available.
  useEffect(() => {
    if (values.asset && !assets.some((a) => a.ticker === values.asset)) {
      onChange({ ...values, asset: assets[0]?.ticker ?? null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assets.map((a) => a.ticker).join(",")]);

  const strikeNum = parseFloat(values.strike) || 0;
  const moneyness = useMemo(
    () => computeMoneyness(values.side, spotForChosenAsset ?? 0, strikeNum),
    [values.side, spotForChosenAsset, strikeNum],
  );

  const contractsNum = parseInt(values.contracts || "0", 10) || 0;

  if (assets.length === 0) {
    return (
      <div className="border border-rule rounded-md p-12 text-center">
        <p className="font-sans italic font-normal leading-[1.55] opacity-70 text-[15px] m-0 mb-3">
          No markets registered yet — create one on Markets first.
        </p>
        <Link
          to="/markets"
          className="inline-flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.2em] text-ink no-underline border-b border-ink pb-0.5 hover:border-crimson hover:text-crimson transition-colors duration-300 ease-opta"
        >
          → Markets
        </Link>
      </div>
    );
  }

  // CTA gate. Submit allowed only if every required field is populated AND
  // (Custom only) expiry resolves to a future timestamp.
  const expiryReady =
    mode === "epoch" ||
    (values.expiry != null && values.expiry > Math.floor(Date.now() / 1000));
  const fieldsReady =
    !!values.asset && strikeNum > 0 && contractsNum > 0 && expiryReady;

  return (
    <div className="space-y-6">
      <Field label="Asset">
        <div className="flex flex-wrap gap-2">
          {assets.map((a) => (
            <button
              key={a.ticker}
              type="button"
              onClick={() => onChange({ ...values, asset: a.ticker })}
              aria-pressed={values.asset === a.ticker}
              className={`rounded-full border px-[14px] py-[6px] font-mono text-[10.5px] uppercase tracking-[0.18em] transition-colors duration-300 ease-opta ${
                values.asset === a.ticker
                  ? "border-ink bg-ink text-paper"
                  : "border-rule text-ink opacity-65 hover:opacity-100 hover:border-ink"
              }`}
            >
              {a.ticker}
            </button>
          ))}
        </div>
      </Field>

      <Field label="Side">
        <div className="flex gap-2">
          <SideButton
            active={values.side === "call"}
            onClick={() => onChange({ ...values, side: "call" })}
          >
            Call
          </SideButton>
          <SideButton
            active={values.side === "put"}
            onClick={() => onChange({ ...values, side: "put" })}
          >
            Put
          </SideButton>
        </div>
      </Field>

      <Field label="Strike (USDC)">
        <input
          type="number"
          value={values.strike}
          onChange={(e) => onChange({ ...values, strike: e.target.value })}
          placeholder="0.00"
          step="0.01"
          min="0"
          className="w-full bg-paper-2 border border-rule rounded-sm px-3 py-2 font-mono text-[14px] text-ink focus:outline-none focus:border-ink transition-colors duration-200"
        />
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] opacity-55 mt-1.5">
          {moneyness ?? "Spot — enter strike to see moneyness"}
        </div>
      </Field>

      <Field label="Contracts">
        <input
          type="number"
          value={values.contracts}
          onChange={(e) => onChange({ ...values, contracts: e.target.value })}
          placeholder="1"
          step="1"
          min="1"
          className="w-full bg-paper-2 border border-rule rounded-sm px-3 py-2 font-mono text-[14px] text-ink focus:outline-none focus:border-ink transition-colors duration-200"
        />
        <div className="font-mono text-[10px] uppercase tracking-[0.18em] opacity-55 mt-1.5">
          1 contract = 1 unit of underlying
        </div>
      </Field>

      {mode === "epoch" ? (
        <div>
          <div className="font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-65 mb-2">
            Expiry
          </div>
          <div className="border border-rule-soft rounded-sm p-3 font-mono text-[12px] text-ink">
            <span className="opacity-65">Settles next Friday · </span>
            <span>{epochExpiryLabel ?? "—"}</span>
          </div>
        </div>
      ) : (
        <ExpiryPicker
          preset={values.expiryPreset}
          value={values.expiry}
          onChange={(next) =>
            onChange({ ...values, expiry: next.value, expiryPreset: next.preset })
          }
        />
      )}

      <AdvancedSection
        premiumPerContract={values.premiumPerContract}
        onChange={(next) => onChange({ ...values, premiumPerContract: next })}
      />

      <button
        type="button"
        onClick={connected ? onSubmit : onConnectClick}
        disabled={connected && (submitting || !fieldsReady)}
        className="w-full inline-flex items-center justify-center gap-2 rounded-full border border-ink bg-ink text-paper px-4 py-3 font-mono text-[11px] uppercase tracking-[0.2em] hover:bg-transparent hover:text-ink transition-colors duration-300 ease-opta disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-ink disabled:hover:text-paper"
      >
        {!connected
          ? "Connect Wallet to Write"
          : submitting
            ? stageLabel ?? "Submitting…"
            : "Deposit and Write"}
        {!submitting && <span aria-hidden="true">→</span>}
      </button>
    </div>
  );
};

const Field: FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <div className="font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-65 mb-2">
      {label}
    </div>
    {children}
  </div>
);

const SideButton: FC<{
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}> = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`flex-1 rounded-sm border py-2.5 font-mono text-[11.5px] uppercase tracking-[0.2em] transition-colors duration-300 ease-opta ${
      active
        ? "border-ink bg-ink text-paper"
        : "border-rule text-ink opacity-65 hover:opacity-100 hover:border-ink"
    }`}
  >
    <span className="inline-flex items-center gap-2 justify-center">
      <span aria-hidden="true" className="inline-block w-[6px] h-[6px] rounded-full bg-crimson" />
      {children}
    </span>
  </button>
);

/**
 * MED-6: collapsible Advanced section exposing a premium-per-contract
 * override. Default state: closed; the form behaves as before with
 * B-S-derived premium computed at submit time. Open: a single numeric
 * input that, when populated with a positive value, overrides the B-S
 * default. The handleSubmit logic in EpochVaultSection / CustomVaultSection
 * parses this string and prefers the override iff valid.
 */
const AdvancedSection: FC<{
  premiumPerContract: string;
  onChange: (next: string) => void;
}> = ({ premiumPerContract, onChange }) => {
  const [open, setOpen] = useState(false);
  return (
    <div className="border border-rule-soft rounded-sm">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="w-full flex items-center justify-between px-3 py-2 font-mono text-[10.5px] uppercase tracking-[0.18em] opacity-65 hover:opacity-100 transition-opacity duration-200"
      >
        <span>Advanced</span>
        <span aria-hidden="true">{open ? "−" : "+"}</span>
      </button>
      {open && (
        <div className="px-3 pb-3 pt-1 space-y-2 border-t border-rule-soft">
          <div className="font-mono text-[10.5px] uppercase tracking-[0.2em] opacity-65">
            Premium per contract (USDC)
          </div>
          <input
            type="number"
            value={premiumPerContract}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Auto · uses Black-Scholes"
            step="0.01"
            min="0"
            className="w-full bg-paper-2 border border-rule rounded-sm px-3 py-2 font-mono text-[13px] text-ink focus:outline-none focus:border-ink transition-colors duration-200"
          />
          <div className="font-sans italic font-normal leading-[1.5] opacity-75 text-[12.5px]">
            Leave empty to use the Black-Scholes-derived premium. Set a positive
            value to override — your vault will list at that price regardless of
            the B-S model.
          </div>
        </div>
      )}
    </div>
  );
};

function computeMoneyness(
  side: "call" | "put",
  spot: number,
  strike: number,
): string | null {
  if (spot <= 0 || strike <= 0) return null;
  const diff = (strike - spot) / spot;
  const absPct = Math.abs(diff * 100);
  if (absPct < 0.5) return "ATM";
  const callOtm = side === "call" && strike > spot;
  const putOtm = side === "put" && strike < spot;
  const isOtm = callOtm || putOtm;
  return `${absPct.toFixed(1)}% ${isOtm ? "OTM" : "ITM"} · spot $${spot.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

export default WriterForm;
