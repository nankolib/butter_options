import type { FC } from "react";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { PublicKey } from "@solana/web3.js";
import { useProgram } from "../../hooks/useProgram";
import { calculateFullGreeks, getDefaultVolatility, applyVolSmile } from "../../utils/blackScholes";
import { MARKET_SEED, PROGRAM_ID } from "../../utils/constants";
import { fetchOptionPriceQuote, type OptionPriceQuote } from "../../utils/optionPriceQuote";
import type { MarketRow } from "./useMarketsData";
import { fmtPrice, fmtStrike, fmtInt, fmtUsdCompact, expiryLabel } from "./marketsView";

/**
 * ContractInspector — shared contract detail surface for the Markets terminal.
 *
 * Reuses the app's proven pricing path: real premium via fetchOptionPriceQuote
 * (manual simulate at 400K CU, never `.view()`) for American contracts, model
 * premium/greeks via calculateFullGreeks (same vol model used elsewhere) for
 * European. Greeks/IV are MODEL values (labelled); premium is the on-chain sim.
 *
 * `mode` is part of the contract for the future Trade docked-ticket slice —
 * "docked" is unused today (always renders the modal). Live contracts show the
 * premium centerpiece + greeks + payoff; settled/expired show the realized
 * settlement price and omit live greeks.
 */
export const ContractInspector: FC<{
  row: MarketRow;
  mode?: "modal" | "docked";
  onClose: () => void;
}> = ({ row, onClose }) => {
  const navigate = useNavigate();
  const { program } = useProgram();
  const isCall = row.side === "call";
  const settled = row.status !== "open";
  const spot = row.spot;
  const days = Math.max(0, (row.expiry - Date.now() / 1000) / 86_400);

  const vol = useMemo(
    () =>
      spot && spot > 0
        ? applyVolSmile(getDefaultVolatility(row.asset), spot, row.strike, row.asset)
        : getDefaultVolatility(row.asset),
    [spot, row.asset, row.strike],
  );
  const greeks = useMemo(
    () => (!settled && spot && spot > 0 ? calculateFullGreeks(row.side, spot, row.strike, days, vol, 0) : null),
    [settled, spot, row.side, row.strike, days, vol],
  );

  // On-chain RFQ for American live contracts; else model price.
  const useRfq = !settled && row.exerciseStyle === "american";
  const [rfq, setRfq] = useState<OptionPriceQuote | null>(null);
  const [rfqFailed, setRfqFailed] = useState(false);
  useEffect(() => {
    let live = true;
    setRfq(null);
    setRfqFailed(false);
    if (!program || !useRfq) return;
    (async () => {
      try {
        const marketPda = PublicKey.findProgramAddressSync(
          [Buffer.from(MARKET_SEED), Buffer.from(row.asset)],
          PROGRAM_ID,
        )[0];
        const mkt: any = await (program.account as any).optionsMarket.fetch(marketPda);
        const q = await fetchOptionPriceQuote(
          program as any,
          { publicKey: marketPda, account: { pythFeedId: mkt.pythFeedId } },
          { strike: row.strike, expiryTs: row.expiry, side: row.side, exerciseStyle: "american", carryRateBps: 0 },
        );
        if (live) setRfq(q);
      } catch {
        // Stale/cold oracle or read-only RPC → fall back to the model premium
        // (real: derived from live spot + the vol model, and labelled as such).
        if (live) setRfqFailed(true);
      }
    })();
    return () => {
      live = false;
    };
  }, [program, useRfq, row.asset, row.strike, row.expiry, row.side, settled]);

  // On-chain quote when it resolves; otherwise the model premium (never a
  // placeholder). rfqNote states which source the centerpiece reflects.
  const livePremium = useRfq ? (rfq?.premiumPerContract ?? null) : null;
  const premium = livePremium ?? greeks?.premium ?? null;
  const rfqNote = settled
    ? ""
    : !useRfq
      ? "Model price"
      : livePremium != null
        ? "Protocol quote"
        : rfqFailed
          ? "Model estimate — live quote warming up"
          : "Pricing on-chain…";
  const breakeven = premium != null ? (isCall ? row.strike + premium : row.strike - premium) : null;

  // ---- payoff geometry (300×120 viewBox) ----
  const payoff = useMemo(() => {
    if (premium == null) return null;
    const W = 300, H = 120, pad = 12;
    const S0 = row.strike, prem = premium;
    const lo = S0 * 0.72, hi = S0 * 1.28;
    const pay = (S: number) => (isCall ? Math.max(S - S0, 0) : Math.max(S0 - S, 0)) - prem;
    const N = 30;
    const vals: [number, number][] = [];
    for (let i = 0; i <= N; i++) {
      const S = lo + ((hi - lo) * i) / N;
      vals.push([S, pay(S)]);
    }
    let maxP = Math.max(...vals.map((v) => v[1]), prem);
    let minP = Math.min(...vals.map((v) => v[1]), -prem);
    if (maxP === minP) maxP = minP + 1;
    const mapX = (S: number) => pad + ((S - lo) / (hi - lo)) * (W - 2 * pad);
    const mapY = (p: number) => pad + ((maxP - p) / (maxP - minP)) * (H - 2 * pad);
    const zeroY = mapY(0);
    const be = isCall ? S0 + prem : S0 - prem;
    return {
      zeroY: zeroY.toFixed(1),
      belowH: (H - zeroY).toFixed(1),
      strikeX: mapX(S0).toFixed(1),
      beX: mapX(be).toFixed(1),
      points: vals.map((v) => `${mapX(v[0]).toFixed(1)},${mapY(v[1]).toFixed(1)}`).join(" "),
    };
  }, [premium, row.strike, isCall]);

  const goTrade = () => {
    navigate(
      `/trade?asset=${encodeURIComponent(row.asset)}&expiry=${row.expiry}&strike=${row.strike}&side=${row.side}`,
    );
  };

  const statusLabel = settled ? (row.status === "settled" ? "Settled" : "Expired") : "Active";

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-[300] flex items-end justify-center bg-l-overlay p-0 sm:items-center sm:p-10"
    >
      <div
        data-testid="inspector"
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-full w-full max-w-full flex-col gap-[14px] overflow-auto rounded-t-[14px] border border-l-hair bg-l-surface-2 p-[18px] sm:w-[400px] sm:rounded-[10px]"
      >
        {/* Header */}
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-[9px]">
              <span className="font-sans text-[17px] font-medium text-l-text">
                {row.asset} {fmtStrike(row.strike)}
              </span>
              <span
                className="rounded-[4px] px-[7px] py-[3px] font-mono-plex text-[10px] font-medium tracking-[0.1em]"
                style={{
                  background: isCall ? "var(--color-l-up)" : "var(--color-l-down)",
                  color: isCall ? "var(--color-l-on-up)" : "var(--color-l-on-down)",
                }}
              >
                {isCall ? "CALL" : "PUT"}
              </span>
            </div>
            <div className="mt-1 flex items-center gap-[7px] font-mono-plex text-[12px] text-l-muted">
              <span>{expiryLabel(row.expiry)}</span>
              <span className="text-l-muted">·</span>
              <span className="flex items-center gap-[5px]">
                <span
                  className="inline-block h-[6px] w-[6px] rounded-full"
                  style={{ background: settled ? "var(--color-l-faint)" : "var(--color-l-up)" }}
                />
                {statusLabel}
              </span>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="px-[2px] text-[20px] leading-none text-l-muted hover:text-l-text">
            ×
          </button>
        </div>

        {/* Centerpiece: premium (live) or settlement (settled) */}
        <div className="flex items-baseline justify-between border-y border-l-hair py-[14px]">
          <span className="font-mono-plex text-[9px] uppercase tracking-[0.13em] text-l-muted">
            {settled ? "Settlement price" : "Premium / contract"}
          </span>
          <div className="flex items-baseline gap-[6px]">
            <span className="font-mono-plex text-[30px] font-medium leading-none tabular-nums text-l-text">
              {settled
                ? row.settlementPrice != null
                  ? fmtPrice(row.settlementPrice)
                  : "—"
                : premium != null
                  ? fmtPrice(premium)
                  : "—"}
            </span>
            <span className="font-mono-plex text-[12px] text-l-muted">USDC</span>
          </div>
        </div>
        {!settled && rfqNote && (
          <span className="-mt-[6px] font-mono-plex text-[10px] text-l-muted">{rfqNote}</span>
        )}

        {/* Greeks (live only) — model values */}
        {!settled && greeks && (
          <>
            <div className="grid grid-cols-5 gap-[6px]">
              {[
                ["Delta", greeks.delta.toFixed(2)],
                ["Gamma", greeks.gamma.toFixed(3)],
                ["Theta", greeks.theta.toFixed(2)],
                ["Vega", greeks.vega.toFixed(2)],
                ["IV", ((row.iv ?? vol) * 100).toFixed(0) + "%"],
              ].map(([k, v]) => (
                <div key={k} className="flex flex-col gap-[3px] rounded-[6px] border border-l-hair px-[9px] py-[8px]">
                  <span className="font-mono-plex text-[9px] uppercase tracking-[0.1em] text-l-muted">{k}</span>
                  <span className="font-mono-plex text-[14px] tabular-nums text-l-text">{v}</span>
                </div>
              ))}
            </div>
            <span className="-mt-[8px] font-mono-plex text-[9px] text-l-muted">Greeks + IV are model values.</span>
          </>
        )}

        {/* Payoff diagram (live, premium known) */}
        {!settled && payoff && (
          <div>
            <span className="font-mono-plex text-[9px] uppercase tracking-[0.13em] text-l-muted">Payoff at expiry</span>
            <svg viewBox="0 0 300 120" preserveAspectRatio="none" className="mt-[6px] block h-[118px] w-full">
              <rect x="0" y="0" width="300" height={payoff.zeroY} fill="var(--color-l-up)" opacity="0.06" />
              <rect x="0" y={payoff.zeroY} width="300" height={payoff.belowH} fill="var(--color-l-down)" opacity="0.06" />
              <line x1="0" y1={payoff.zeroY} x2="300" y2={payoff.zeroY} stroke="var(--color-l-hair)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              <line x1={payoff.strikeX} y1="0" x2={payoff.strikeX} y2="120" stroke="var(--color-l-faint)" strokeWidth="1" strokeDasharray="2 3" vectorEffect="non-scaling-stroke" />
              <polyline points={payoff.points} fill="none" stroke="var(--color-l-text)" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
              <circle cx={payoff.beX} cy={payoff.zeroY} r="3" fill="var(--color-l-text)" />
            </svg>
            <div className="mt-[5px] flex justify-between font-mono-plex text-[10px] text-l-muted">
              <span>Strike {fmtStrike(row.strike)}</span>
              {breakeven != null && <span>Breakeven {fmtPrice(breakeven)}</span>}
            </div>
          </div>
        )}

        {/* OI · vault · spot */}
        <div className="flex justify-between border-y border-l-hair py-[11px]">
          {[
            ["Open interest", fmtInt(row.openInterest)],
            ["Vault depth", fmtUsdCompact(row.vaultTvl ?? 0)],
            ["Spot", row.spot != null ? fmtPrice(row.spot) : "—"],
          ].map(([k, v]) => (
            <div key={k} className="flex flex-col gap-[3px]">
              <span className="font-mono-plex text-[9px] uppercase tracking-[0.1em] text-l-muted">{k}</span>
              <span className="font-mono-plex text-[13px] tabular-nums text-l-text">{v}</span>
            </div>
          ))}
        </div>

        {/* Actions */}
        {!settled && (
          <div className="flex gap-[10px]">
            <button
              type="button"
              onClick={goTrade}
              className="flex-1 rounded-[6px] bg-l-up py-[11px] font-sans text-[13px] font-medium text-l-on-up transition-opacity duration-200 hover:opacity-90"
            >
              Trade →
            </button>
            <button
              type="button"
              onClick={goTrade}
              className="flex-none rounded-[6px] border border-l-muted px-[18px] py-[11px] font-sans text-[13px] font-medium text-l-text transition-colors duration-200 hover:border-l-text"
            >
              Write
            </button>
          </div>
        )}
      </div>
    </div>
  );
};

export default ContractInspector;
