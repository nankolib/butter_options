// =============================================================================
// WriteContractPanel — the split-cockpit LEFT panel (contract builder).
// =============================================================================
//
// EPOCH|CUSTOM segmented control at the head, then the terminal form:
//   Asset → Side → Strike → (Epoch: Tenor SINGLE|LADDER · Custom: Expiry) →
//   Quantity → Exercise → Collateral required, plus inline gate states and a
//   compact Advanced premium override.
//
// Pure presentation + controlled inputs — all resolution (cells, gates, premium)
// lives in useWriteController; this panel only renders state and raises changes.
// Exercise defaults to AMERICAN (page seeds both modes' state that way).
// =============================================================================

import type { FC } from "react";
import { useState } from "react";
import { AMERICAN_ENABLED_UI } from "../../../utils/constants";
import { tenorExpiry, type TenorLabel } from "../../../utils/tenors";
import { WriteAssetSelect } from "./WriteAssetSelect";
import { ALL_TENORS, type TenorMode, type WriteMode } from "./useWriteController";
import type { WriterFormValues } from "../WriterForm";

type Gate = { tooltip: string } | null;

type Props = {
  mode: WriteMode;
  onModeChange: (m: WriteMode) => void;
  values: WriterFormValues;
  onValuesChange: (next: WriterFormValues) => void;
  assets: string[];
  spotByTicker: Record<string, number | null | undefined>;
  spotForChosenAsset: number | null;
  unseeded: ReadonlySet<string>;
  tenorMode: TenorMode;
  onTenorModeChange: (m: TenorMode) => void;
  singleTenor: TenorLabel;
  onSingleTenorChange: (t: TenorLabel) => void;
  split: Record<TenorLabel, number>;
  onSplitChange: (next: Record<TenorLabel, number>) => void;
  minLeadSecs: number;
  collateralPerContract: number;
  totalCollateral: number;
  marketHoursBlock: Gate;
  volOracleBlock: Gate;
  americanQuoteBlock: Gate;
  ladderError: string | null;
};

const fmtUsd = (v: number, dp = 2) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

const chipDate = (label: TenorLabel, minLeadSecs: number) =>
  new Date(tenorExpiry(label, Date.now(), minLeadSecs) * 1000)
    .toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

// UTC date/time <-> unix-seconds (custom expiry). Mirrors ExpiryPicker.
const fmtDateInput = (ts: number | null) => {
  if (ts == null) return "";
  const d = new Date(ts * 1000);
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
};
const fmtTimeInput = (ts: number | null) => {
  if (ts == null) return "";
  const d = new Date(ts * 1000);
  const p = (n: number) => n.toString().padStart(2, "0");
  return `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};
const parseUtc = (date: string, time: string): number | null => {
  if (!date || !time) return null;
  const ts = Math.floor(Date.parse(`${date}T${time}:00Z`) / 1000);
  return Number.isFinite(ts) && ts > 0 ? ts : null;
};

export const WriteContractPanel: FC<Props> = ({
  mode,
  onModeChange,
  values,
  onValuesChange,
  assets,
  spotByTicker,
  spotForChosenAsset,
  unseeded,
  tenorMode,
  onTenorModeChange,
  singleTenor,
  onSingleTenorChange,
  split,
  onSplitChange,
  minLeadSecs,
  collateralPerContract,
  totalCollateral,
  marketHoursBlock,
  volOracleBlock,
  americanQuoteBlock,
  ladderError,
}) => {
  const [advOpen, setAdvOpen] = useState(false);
  const strikeNum = parseFloat(values.strike) || 0;
  const contractsNum = parseInt(values.contracts || "0", 10) || 0;
  const splitTotal = split.Weekly + split.Monthly + split.Quarterly;

  const moneyness = computeMoneyness(values.side, spotForChosenAsset ?? 0, strikeNum);

  const dateStr = fmtDateInput(values.expiry);
  const timeStr = fmtTimeInput(values.expiry);

  return (
    <div className="flex flex-col gap-5">
      {/* EPOCH | CUSTOM */}
      <Segmented
        options={[
          ["epoch", "Epoch"],
          ["custom", "Custom"],
        ]}
        value={mode}
        onChange={(v) => onModeChange(v as WriteMode)}
        testid="write-mode-segmented"
      />

      <Field label="Asset">
        <WriteAssetSelect
          assets={assets}
          selected={values.asset}
          spotByTicker={spotByTicker}
          unseeded={unseeded}
          onChange={(a) => onValuesChange({ ...values, asset: a })}
        />
      </Field>

      <Field label="Side">
        <Segmented
          options={[
            ["call", "Call"],
            ["put", "Put"],
          ]}
          value={values.side}
          onChange={(v) => onValuesChange({ ...values, side: v as "call" | "put" })}
        />
      </Field>

      <Field label="Strike (USDC)">
        <TerminalInput
          type="number"
          value={values.strike}
          onChange={(v) => onValuesChange({ ...values, strike: v })}
          placeholder="0.00"
          step="0.01"
          min="0"
        />
        <Hint>{moneyness ?? "Enter strike to see moneyness"}</Hint>
      </Field>

      {mode === "epoch" ? (
        <Field label="Tenor" testid="write-tenor-row">
          <Segmented
            options={[
              ["single", "Single"],
              ["ladder", "Ladder"],
            ]}
            value={tenorMode}
            onChange={(v) => onTenorModeChange(v as TenorMode)}
            testid="write-tenor-mode"
          />
          {tenorMode === "single" ? (
            <div className="mt-2 flex flex-wrap gap-2" data-testid="tenor-chips">
              {ALL_TENORS.map((t) => (
                <Chip
                  key={t}
                  active={singleTenor === t}
                  onClick={() => onSingleTenorChange(t)}
                >
                  {t} · {chipDate(t, minLeadSecs)}
                </Chip>
              ))}
            </div>
          ) : (
            <div className="mt-3 flex flex-col gap-3" data-testid="tenor-sliders">
              {ALL_TENORS.map((t) => (
                <div key={t} className="flex items-center gap-3">
                  <span className="w-[74px] font-mono-plex text-[10px] uppercase tracking-[0.14em] text-l-muted">
                    {t}
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={split[t]}
                    onChange={(e) => onSplitChange({ ...split, [t]: parseInt(e.target.value, 10) })}
                    className="h-[3px] flex-1 cursor-pointer appearance-none rounded-full bg-l-hair"
                    style={{ accentColor: "var(--color-l-up)" }}
                  />
                  <span className="w-[38px] text-right font-mono-plex text-[12px] tabular-nums text-l-text">
                    {split[t]}%
                  </span>
                </div>
              ))}
              <div
                className={`text-right font-mono-plex text-[10px] uppercase tracking-[0.14em] ${
                  splitTotal === 100 ? "text-l-muted" : "text-l-down"
                }`}
              >
                Total {splitTotal}%{splitTotal === 100 ? "" : " · must equal 100"}
              </div>
            </div>
          )}
        </Field>
      ) : (
        <Field label="Expiry" testid="write-expiry-row">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <input
                type="date"
                value={dateStr}
                onChange={(e) =>
                  onValuesChange({ ...values, expiry: parseUtc(e.target.value, timeStr), expiryPreset: "CUSTOM" })
                }
                data-testid="write-expiry-date"
                className="w-full rounded-[6px] border border-l-hair bg-l-surface px-3 py-2 font-mono-plex text-[14px] text-l-text transition-colors focus:border-l-muted focus:outline-none"
              />
            </div>
            <div className="relative">
              <input
                type="time"
                value={timeStr}
                onChange={(e) =>
                  onValuesChange({ ...values, expiry: parseUtc(dateStr, e.target.value), expiryPreset: "CUSTOM" })
                }
                data-testid="write-expiry-time"
                className="w-full rounded-[6px] border border-l-hair bg-l-surface px-3 py-2 pr-11 font-mono-plex text-[14px] text-l-text transition-colors focus:border-l-muted focus:outline-none"
              />
              <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 font-mono-plex text-[10px] tracking-[0.12em] text-l-faint">
                UTC
              </span>
            </div>
          </div>
        </Field>
      )}

      <Field label="Quantity">
        <TerminalInput
          type="number"
          value={values.contracts}
          onChange={(v) => onValuesChange({ ...values, contracts: v })}
          placeholder="1"
          step="1"
          min="1"
          testid="write-qty"
        />
        <Hint>1 contract = 1 unit of underlying</Hint>
      </Field>

      <Field label="Exercise">
        <Segmented
          options={[
            ["american", "American"],
            ["european", "European"],
          ]}
          value={values.exerciseStyle}
          onChange={(v) => onValuesChange({ ...values, exerciseStyle: v as "european" | "american" })}
          disabled={AMERICAN_ENABLED_UI ? undefined : "american"}
          testid="write-exercise"
        />
        <Hint>
          {values.exerciseStyle === "american" ? "Early exercise allowed — priced on-chain" : "Exercise at expiry only"}
        </Hint>
      </Field>

      {/* Collateral required */}
      <div className="flex items-baseline justify-between border-t border-l-hair pt-4">
        <span className="font-mono-plex text-[10px] uppercase tracking-[0.18em] text-l-muted">
          Collateral required
        </span>
        <span className="font-mono-plex text-[15px] tabular-nums text-l-text" data-testid="collateral-required">
          {contractsNum > 0 && strikeNum > 0 ? fmtUsd(totalCollateral || collateralPerContract * contractsNum) : "—"}
        </span>
      </div>

      {/* Inline gate states (terminal) */}
      {ladderError && <GateLine tone="down" label="Ladder">{ladderError}</GateLine>}
      {marketHoursBlock && <GateLine tone="down" label="Market hours">{marketHoursBlock.tooltip}</GateLine>}
      {volOracleBlock && <GateLine tone="down" label="Oracle pending">{volOracleBlock.tooltip}</GateLine>}
      {americanQuoteBlock && <GateLine tone="down" label="On-chain quote">{americanQuoteBlock.tooltip}</GateLine>}

      {/* Advanced premium override */}
      <div className="border-t border-l-hair pt-3">
        <button
          type="button"
          onClick={() => setAdvOpen((v) => !v)}
          aria-expanded={advOpen}
          className="flex w-full items-center justify-between font-mono-plex text-[10px] uppercase tracking-[0.16em] text-l-muted transition-colors hover:text-l-text"
        >
          <span>Advanced · custom premium</span>
          <span aria-hidden="true">{advOpen ? "−" : "+"}</span>
        </button>
        {advOpen && (
          <div className="mt-3 flex flex-col gap-2">
            <TerminalInput
              type="number"
              value={values.premiumPerContract}
              onChange={(v) => onValuesChange({ ...values, premiumPerContract: v })}
              placeholder="Auto · Black-Scholes"
              step="0.01"
              min="0"
            />
            <Hint>Leave empty for the model premium. A positive value lists your ask at that price.</Hint>
          </div>
        )}
      </div>
    </div>
  );
};

// ---- primitives ----

const Field: FC<{ label: string; testid?: string; children: React.ReactNode }> = ({ label, testid, children }) => (
  <div data-testid={testid}>
    <div className="mb-2 font-mono-plex text-[10px] uppercase tracking-[0.18em] text-l-muted">{label}</div>
    {children}
  </div>
);

const Hint: FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="mt-1.5 font-mono-plex text-[10px] uppercase tracking-[0.14em] text-l-faint">{children}</div>
);

const Segmented: FC<{
  options: [string, string][];
  value: string;
  onChange: (v: string) => void;
  /** A single option value to render disabled (e.g. American when the flag is off). */
  disabled?: string;
  testid?: string;
}> = ({ options, value, onChange, disabled, testid }) => (
  <div className="flex gap-px overflow-hidden rounded-[6px] border border-l-hair bg-l-hair" data-testid={testid}>
    {options.map(([v, label]) => {
      const isDisabled = disabled === v;
      const active = value === v;
      return (
        <button
          key={v}
          type="button"
          disabled={isDisabled}
          onClick={() => !isDisabled && onChange(v)}
          aria-pressed={active}
          className={`flex-1 px-[13px] py-[8px] font-sans text-[13px] font-medium transition-colors ${
            active ? "bg-l-surface-2 text-l-text" : "bg-l-surface text-l-muted hover:text-l-text"
          } ${isDisabled ? "cursor-not-allowed opacity-40 hover:text-l-muted" : ""}`}
        >
          {label}
        </button>
      );
    })}
  </div>
);

const Chip: FC<{ active: boolean; onClick: () => void; children: React.ReactNode }> = ({ active, onClick, children }) => (
  <button
    type="button"
    onClick={onClick}
    aria-pressed={active}
    className={`rounded-[6px] border px-[12px] py-[7px] font-mono-plex text-[11px] tabular-nums transition-colors ${
      active ? "border-l-up bg-l-surface-2 text-l-text" : "border-l-hair bg-l-surface text-l-muted hover:text-l-text"
    }`}
  >
    {children}
  </button>
);

const TerminalInput: FC<{
  type: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  step?: string;
  min?: string;
  testid?: string;
}> = ({ type, value, onChange, placeholder, step, min, testid }) => (
  <input
    type={type}
    value={value}
    onChange={(e) => onChange(e.target.value)}
    placeholder={placeholder}
    step={step}
    min={min}
    data-testid={testid}
    className="w-full rounded-[6px] border border-l-hair bg-l-surface px-3 py-2 font-mono-plex text-[15px] text-l-text transition-colors focus:border-l-muted focus:outline-none"
  />
);

const GateLine: FC<{ tone: "down"; label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div className="rounded-[6px] border border-l-down/40 p-3">
    <div className="mb-1 font-mono-plex text-[10px] uppercase tracking-[0.16em] text-l-down">{label}</div>
    <div className="font-sans text-[12.5px] leading-[1.5] text-l-text">{children}</div>
  </div>
);

function computeMoneyness(side: "call" | "put", spot: number, strike: number): string | null {
  if (spot <= 0 || strike <= 0) return null;
  const diff = (strike - spot) / spot;
  const absPct = Math.abs(diff * 100);
  if (absPct < 0.5) return "ATM";
  const isOtm = (side === "call" && strike > spot) || (side === "put" && strike < spot);
  return `${absPct.toFixed(1)}% ${isOtm ? "OTM" : "ITM"} · spot ${fmtUsd(spot)}`;
}

export default WriteContractPanel;
