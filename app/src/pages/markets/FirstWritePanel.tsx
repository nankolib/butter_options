// =============================================================================
// FirstWritePanel — SLICE 3: the first write, as one decision
// =============================================================================
//
// THE FUNNEL EXIT THIS CLOSES. Measured on chain 2026-08-11: 21 of 31 registered
// assets had NEVER traded a contract; 6 never had a vault at all. Creating a
// market was a dead end, and the only route on was /write — a four-gate form
// asking a first-time user for strike, expiry, quantity and full collateral,
// immediately after telling them the thing they just made is worthless until
// they supply all four.
//
// So the panel answers those questions with legal, bot-aligned defaults and
// shows them as EDITABLE fields rather than a wizard. One wallet approval.
//
// It builds NO transaction. `useWriteSubmit` is the single builder and this is
// its second consumer — a first write is literally the 1-cell degenerate case
// of the ladder path the hook already documents, so it rides the identical
// proven bundle ([CU 600K, create_and_deposit, mint_from_vault], atomic) and
// the identical txOutcome rails. No new confirm logic, no second builder.
// =============================================================================

import type { FC } from "react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { PublicKey } from "@solana/web3.js";

import { requiredCollateralPerContract } from "../../utils/collateral";
import {
  calculateCallPremium,
  calculatePutPremium,
  applyVolSmile,
  getDefaultVolatility,
} from "../../utils/blackScholes";
import { buildFirstWritePrefill, prefillStrike } from "../../utils/firstWritePrefill";
import { isMarketHours, nextOpenLabel, type AssetClass } from "../../utils/marketHours";
import { VOL_ORACLE_EXPECTED_WAIT } from "../../hooks/useVolOracleStatus";
import type { CellResult } from "../write/useWriteSubmit";

const fmtUsd = (v: number, dp = 2) =>
  `$${v.toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;

const expiryLabel = (ts: number) =>
  new Date(ts * 1000)
    .toLocaleString("en-GB", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    })
    .toUpperCase() + " UTC";

export type FirstWriteState =
  | { kind: "idle" }
  | { kind: "submitting"; label: string }
  | { kind: "done"; cell: CellResult }
  | { kind: "failed"; message: string };

export interface FirstWriteSubmitArgs {
  side: "call" | "put";
  strike: number;
  expiry: number;
  contracts: number;
  collateral: number;
  premiumPerContract: number;
}

export const FirstWritePanel: FC<{
  assetName: string;
  assetClass: number;
  /** Live spot from the vol oracle, or null while the Pyth arm is still warming. */
  spot: number | null;
  /** False until the VolOracle PDA exists (2A's poll). SB-curated is born true. */
  oracleReady: boolean;
  /** Min epoch lead in seconds — slots inside it are rejected on-chain (6021). */
  minLeadSecs: number;
  connected: boolean;
  state: FirstWriteState;
  onSubmit: (args: FirstWriteSubmitArgs) => void;
  onConnect: () => void;
  onSkip: () => void;
  marketPda: PublicKey | null;
}> = ({
  assetName,
  assetClass,
  spot,
  oracleReady,
  minLeadSecs,
  connected,
  state,
  onSubmit,
  onConnect,
  onSkip,
}) => {
  const prefill = useMemo(
    () => buildFirstWritePrefill({ spot, assetClass, nowMs: Date.now(), minLeadSecs }),
    // Deliberately computed once per mount-ish: re-deriving on every render would
    // fight the user's edits below. Spot arriving later fills the strike via the
    // `strikeValue` fallback rather than resetting the form.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [assetClass, minLeadSecs, spot === null],
  );

  const [side, setSide] = useState<"call" | "put">(prefill.side);
  const [strikeEdit, setStrikeEdit] = useState<string | null>(null);
  const [qty, setQty] = useState("1");
  const [expiry, setExpiry] = useState<number | null>(prefill.expiry);

  // The strike the user sees: their edit if they made one, else the prefill,
  // else — once spot lands — the prefill derived from it. This is why a Pyth
  // market can render the panel while warming without the form jumping.
  const derivedStrike = prefill.strike ?? (spot !== null ? prefillStrike(spot, assetClass) : null);
  const strikeValue = strikeEdit ?? (derivedStrike !== null ? String(derivedStrike) : "");
  const strikeNum = parseFloat(strikeValue) || 0;
  const contracts = parseInt(qty || "0", 10) || 0;

  const collateralPer = requiredCollateralPerContract(strikeNum, side);
  const totalCollateral = collateralPer * contracts;

  const premiumPer = useMemo(() => {
    if (!(spot && spot > 0) || !(strikeNum > 0) || expiry === null) return 0;
    const days = Math.max(0, (expiry - Date.now() / 1000) / 86_400);
    if (days <= 0) return 0;
    const iv = applyVolSmile(getDefaultVolatility(assetName), spot, strikeNum, assetName);
    return side === "call"
      ? calculateCallPremium(spot, strikeNum, days, iv)
      : calculatePutPremium(spot, strikeNum, days, iv);
  }, [spot, strikeNum, expiry, side, assetName]);

  // ---- gates (see the SLICE 3 gate table) ----------------------------------
  // ladderError: N/A — one cell.
  // volOracleBlock: `oracleReady`, from 2A's poll.
  // marketHours: asked here so an EDITED expiry cannot slip through illegal.
  const hoursBlock = useMemo(() => {
    if (expiry === null) return "Pick an expiry.";
    const r = isMarketHours(expiry, assetClass as AssetClass);
    if (r.ok) return null;
    const next = (r as { nextValidUnixSec?: number }).nextValidUnixSec;
    return next !== undefined
      ? `${assetName} settles when its venue is open — ${nextOpenLabel(next)}.`
      : r.reason;
  }, [expiry, assetClass, assetName]);

  const fieldsReady = strikeNum > 0 && contracts > 0 && expiry !== null;
  const blocked = !oracleReady || !!hoursBlock || !fieldsReady;
  const busy = state.kind === "submitting";

  // ---- done ---------------------------------------------------------------
  if (state.kind === "done") {
    const c = state.cell;
    return (
      <div className="mt-4 rounded-[8px] border border-l-hair bg-l-surface p-4" data-testid="first-write-done">
        <div className="font-mono-plex text-[10px] uppercase tracking-[0.18em] text-l-up-text">
          ● Series live
        </div>
        <div className="mt-2 font-mono-plex text-[15px] text-l-text">
          {assetName} {strikeNum}
          {side === "call" ? "C" : "P"} — your ask is on the book
        </div>
        <p className="mt-1.5 font-mono-plex text-[11px] leading-[1.6] text-l-muted">
          {c.contracts} contract{c.contracts === 1 ? "" : "s"} · {fmtUsd(c.collateral)} collateral
          committed. It fills when someone buys it.
        </p>
        <div className="mt-3">
          <Link
            to={`/trade?asset=${encodeURIComponent(assetName)}`}
            data-testid="view-on-trade"
            className="inline-flex items-center justify-center rounded-[6px] bg-l-up px-[16px] py-[8px] font-sans text-[13px] font-medium text-l-on-up no-underline transition-opacity hover:opacity-90"
          >
            View on trade →
          </Link>
        </div>
      </div>
    );
  }

  // ---- form ---------------------------------------------------------------
  return (
    <div className="mt-4 rounded-[8px] border border-l-hair bg-l-surface p-4" data-testid="first-write-panel">
      <div className="flex items-baseline justify-between">
        <span className="font-mono-plex text-[10px] uppercase tracking-[0.18em] text-l-muted">
          Write the first option
        </span>
        <button
          type="button"
          onClick={onSkip}
          data-testid="first-write-skip"
          className="font-mono-plex text-[10px] uppercase tracking-[0.12em] text-l-faint transition-colors hover:text-l-text"
        >
          Skip for now
        </button>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        {/* side */}
        <div>
          <FieldLabel>Side</FieldLabel>
          <div className="flex gap-1">
            {(["call", "put"] as const).map((s) => (
              <button
                key={s}
                type="button"
                disabled={busy}
                onClick={() => setSide(s)}
                aria-pressed={side === s}
                data-testid={`first-write-side-${s}`}
                className={`flex-1 rounded-[5px] border px-2 py-[5px] font-mono-plex text-[11px] uppercase tracking-[0.1em] transition-colors ${
                  side === s ? "border-l-text bg-l-bg text-l-text" : "border-l-hair text-l-muted hover:text-l-text"
                } disabled:opacity-50`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {/* strike */}
        <div>
          <FieldLabel>Strike · USDC</FieldLabel>
          <input
            type="text"
            inputMode="decimal"
            value={strikeValue}
            disabled={busy}
            onChange={(e) => setStrikeEdit(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder={spot === null ? "waiting for price…" : ""}
            data-testid="first-write-strike"
            className="w-full rounded-[5px] border border-l-hair bg-l-bg px-2 py-[5px] font-mono-plex text-[13px] tabular-nums text-l-text outline-none focus:border-l-text disabled:opacity-50"
          />
        </div>

        {/* qty */}
        <div>
          <FieldLabel>Contracts</FieldLabel>
          <input
            type="text"
            inputMode="numeric"
            value={qty}
            disabled={busy}
            onChange={(e) => setQty(e.target.value.replace(/[^0-9]/g, ""))}
            data-testid="first-write-qty"
            className="w-full rounded-[5px] border border-l-hair bg-l-bg px-2 py-[5px] font-mono-plex text-[13px] tabular-nums text-l-text outline-none focus:border-l-text disabled:opacity-50"
          />
        </div>

        {/* expiry */}
        <div>
          <FieldLabel>Expiry</FieldLabel>
          <div
            className="rounded-[5px] border border-l-hair bg-l-bg px-2 py-[5px] font-mono-plex text-[11px] text-l-text"
            data-testid="first-write-expiry"
          >
            {expiry !== null ? expiryLabel(expiry) : "—"}
          </div>
        </div>
      </div>

      {/* economics */}
      <div className="mt-3 flex items-baseline justify-between border-t border-l-hair pt-2.5 font-mono-plex text-[11px]">
        <span className="text-l-muted">
          Collateral <span className="tabular-nums text-l-text">{fmtUsd(totalCollateral)}</span>
        </span>
        <span className="text-l-muted">
          Premium if filled{" "}
          <span className="tabular-nums text-l-up-text">{fmtUsd(premiumPer * contracts)}</span>
        </span>
      </div>

      {/* gates + primary */}
      <div className="mt-3 flex items-center gap-3">
        <button
          type="button"
          disabled={connected && (busy || blocked)}
          onClick={
            connected
              ? () =>
                  onSubmit({
                    side,
                    strike: strikeNum,
                    expiry: expiry!,
                    contracts,
                    collateral: totalCollateral,
                    // mint_from_vault ignores premium on the American branch, but
                    // the cell shape requires it and a zero would read as free.
                    premiumPerContract: Math.max(premiumPer, 0.000001),
                  })
              : onConnect
          }
          data-testid="first-write-submit"
          className="inline-flex items-center justify-center rounded-[6px] bg-l-up px-[16px] py-[8px] font-sans text-[13px] font-medium text-l-on-up transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {!connected
            ? "Connect wallet"
            : busy
              ? state.label
              : `Write ${contracts || 0} ${side}${contracts === 1 ? "" : "s"}`}
        </button>

        {connected && !oracleReady && (
          <span className="font-mono-plex text-[10.5px] text-l-muted" data-testid="first-write-warming">
            Pricing warming — {VOL_ORACLE_EXPECTED_WAIT}. Fields stay editable.
          </span>
        )}
        {connected && oracleReady && hoursBlock && (
          <span className="font-mono-plex text-[10.5px] text-l-muted" data-testid="first-write-hours">
            {hoursBlock}
          </span>
        )}
      </div>

      {state.kind === "failed" && (
        <p className="mt-2 font-mono-plex text-[10.5px] text-l-down" data-testid="first-write-failed">
          {state.message}
        </p>
      )}

      <p className="mt-2.5 font-mono-plex text-[10px] leading-[1.6] text-l-faint">
        You post collateral now and keep the premium if it expires worthless. One approval.
      </p>
    </div>
  );
};

const FieldLabel: FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="mb-1 font-mono-plex text-[9px] uppercase tracking-[0.14em] text-l-faint">{children}</div>
);

export default FirstWritePanel;
