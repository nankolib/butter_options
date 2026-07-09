import type { FC } from "react";
import { useEffect, useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { usePegFill } from "../../hooks/useOrderFlows";
import { calculateCallGreeks, calculatePutGreeks, getDefaultVolatility, applyVolSmile } from "../../utils/blackScholes";
import type { UnifiedChainRow } from "../../hooks/useUnifiedChain";

/**
 * SimpleTradePanel — the Simple persona (perps/meme one-tap mode, §5b).
 *
 * Terminal skin, F6 frame (design lock 2026-07-09): plain-English "up or down?"
 * heading, two big direction choices, an amount field with quick chips, expiry
 * chips, and ONE honest outcome line + a single primary action. Radically fewer
 * controls than Pro — no strike picking, no greeks, no chart. All numbers are
 * `font-mono-plex tabular-nums`; micro-copy is `font-sans`; no serif.
 *
 * Buys route through the SAME peg write path (usePegFill) — Simple always takes
 * the protocol peg (the natural one-tap counterparty), leaving the P2P book to
 * Pro. The auto-strike + FE preview below are unchanged; only the surface moved
 * to the dual-mode `-l-` tokens so it reads correctly in light and dark.
 */
const PRESETS = [10, 50, 100];

export const SimpleTradePanel: FC<{
  asset: string;
  spot: number | null;
  rows: UnifiedChainRow[];               // all unified rows (any expiry) for the asset
  expiries: number[];
  selectedExpiry: number;
  setSelectedExpiry: (e: number) => void;
  onDone: () => void;
}> = ({ asset, spot, rows, expiries, selectedExpiry, setSelectedExpiry, onDone }) => {
  const { publicKey } = useWallet();
  const peg = usePegFill();
  const [direction, setDirection] = useState<"up" | "down">("up");
  const [amount, setAmount] = useState(50);
  const [status, setStatus] = useState<{ kind: "ok" | "err"; msg: string } | null>(null);

  const day = (ts: number) => Math.floor(ts / 86_400);

  // Default the expiry to the first one that actually has a market for this
  // asset+direction (skip empty expiries, e.g. SOL·Up → Jul 31 not Jun 25).
  useEffect(() => {
    const want = direction === "up" ? "call" : "put";
    const has = (e: number) => rows.some((r) => r.provenance === "series" && r.optionType === want && day(r.expiry) === day(e));
    if (has(selectedExpiry)) return;
    const first = expiries.find(has);
    if (first != null) setSelectedExpiry(first);
  }, [rows, direction, expiries, selectedExpiry]);

  // Auto-strike: the ATM-closest SERIES for asset+direction+expiry.
  const auto = useMemo(() => {
    const want = direction === "up" ? "call" : "put";
    const cands = rows.filter(
      (r) => r.provenance === "series" && r.optionType === want && day(r.expiry) === day(selectedExpiry),
    );
    if (!cands.length || !spot) return cands[0] ?? null;
    return [...cands].sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0];
  }, [rows, direction, selectedExpiry, spot]);

  // Instant cheap FE BS preview (carry r=0) — no on-chain quote in Simple.
  const preview = useMemo(() => {
    if (!auto || !spot || spot <= 0) return null;
    const days = Math.max(0, (auto.expiry - Date.now() / 1000) / 86_400);
    if (days <= 0) return null;
    const vol = applyVolSmile(getDefaultVolatility(asset), spot, auto.strike, asset);
    const g = direction === "up"
      ? calculateCallGreeks(spot, auto.strike, days, vol, 0)
      : calculatePutGreeks(spot, auto.strike, days, vol, 0);
    if (g.premium <= 0) return null;
    const qty = Math.max(1, Math.floor(amount / g.premium));
    const cost = qty * g.premium;
    const breakeven = direction === "up" ? auto.strike + g.premium : auto.strike - g.premium;
    const leverage = (Math.abs(g.delta) * spot) / g.premium;
    return { premium: g.premium, qty, cost, breakeven, leverage };
  }, [auto, spot, amount, direction, asset]);

  async function buy() {
    setStatus(null);
    if (!publicKey) { setStatus({ kind: "err", msg: "Connect a wallet" }); return; }
    if (!auto || !auto.optionMint || !preview) return;
    try {
      const sig = await peg.submit(
        { asset, vault: auto.vault, optionMint: auto.optionMint },
        preview.qty,
        preview.premium * 1.15, // 15% peg cushion
      );
      if (sig) { setStatus({ kind: "ok", msg: `Bought ${preview.qty} · ${sig.slice(0, 8)}…` }); onDone(); }
    } catch (e: any) {
      setStatus({ kind: "err", msg: (e?.message ?? String(e)).slice(0, 140) });
    }
  }

  const noteLabel = (e: number) => new Date(e * 1000).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  // Expiry chip copy: "Today 22H" for a same-UTC-day expiry, else "17 JUL".
  const chipLabel = (e: number) => {
    const now = Date.now() / 1000;
    if (day(e) === day(now)) {
      const h = Math.max(0, Math.round((e - now) / 3600));
      return h > 0 ? `Today ${h}H` : "Today";
    }
    return noteLabel(e).toUpperCase();
  };

  const buyDisabled = !publicKey || !auto || !preview || peg.submitting;
  const buyLabel = !publicKey
    ? "Connect wallet"
    : !auto
      ? "No market"
      : peg.submitting
        ? "Buying…"
        : `Buy ${direction === "up" ? "Up" : "Down"} · $${(preview?.cost ?? amount).toFixed(2)}`;

  return (
    <div className="mx-auto mt-4 w-full max-w-[520px]">
      <div className="rounded-[10px] border border-l-hair bg-l-surface p-6">
        {/* Heading — plain English, no serif */}
        <h2 className="font-sans text-[22px] font-medium leading-tight text-l-text">
          Will {asset} be up or down?
        </h2>
        <p className="mt-1.5 font-sans text-[13px] leading-snug text-l-muted">
          Pick a direction and an expiry. Your risk is only what you put in.
        </p>
        {spot != null && (
          <div className="mt-2 font-mono-plex text-[12px] tabular-nums text-l-muted">
            {asset} now ${spot.toLocaleString(undefined, { maximumFractionDigits: 2 })}
          </div>
        )}

        {/* Direction — two big choices */}
        <div className="mt-5 grid grid-cols-2 gap-3">
          {(["up", "down"] as const).map((dir) => {
            const active = direction === dir;
            const c = dir === "up" ? "var(--color-l-up)" : "var(--color-l-down)";
            return (
              <button
                key={dir}
                type="button"
                onClick={() => setDirection(dir)}
                style={active ? { borderColor: c, color: c, background: `color-mix(in srgb, ${c} 12%, transparent)` } : undefined}
                className={`rounded-[6px] border py-5 transition-colors ${
                  active ? "" : "border-l-hair text-l-muted hover:text-l-text"
                }`}
              >
                <span className="font-sans text-[16px] font-medium">{dir === "up" ? "▲ Up" : "▼ Down"}</span>{" "}
                <span className="font-mono-plex text-[12px] opacity-70">/ {dir === "up" ? "CALL" : "PUT"}</span>
              </button>
            );
          })}
        </div>

        {/* Amount */}
        <div className="mt-5 mb-2 font-mono-plex text-[9px] uppercase tracking-[0.14em] text-l-muted">Amount (USDC)</div>
        <div className="flex items-center gap-2 rounded-[6px] border border-l-hair bg-l-bg px-4 py-3 transition-colors focus-within:border-l-muted">
          <span className="font-mono-plex text-[20px] leading-none text-l-muted">$</span>
          <input
            type="number"
            min={1}
            value={amount}
            onChange={(e) => setAmount(Math.max(1, Number(e.target.value) || 1))}
            className="w-full bg-transparent font-mono-plex text-[24px] leading-none tabular-nums text-l-text outline-none"
          />
        </div>
        <div className="mt-2 flex gap-2">
          {PRESETS.map((p) => {
            const active = amount === p;
            return (
              <button
                key={p}
                type="button"
                onClick={() => setAmount(p)}
                className={`flex-1 rounded-[6px] border py-1.5 font-mono-plex text-[12px] tabular-nums transition-colors ${
                  active ? "border-l-text bg-l-surface-2 text-l-text" : "border-l-hair text-l-muted hover:text-l-text"
                }`}
              >
                ${p}
              </button>
            );
          })}
          <button
            type="button"
            disabled
            title="Max = wallet balance (Pass 6)"
            className="flex-1 cursor-not-allowed rounded-[6px] border border-l-hair py-1.5 font-mono-plex text-[12px] text-l-faint"
          >
            Max
          </button>
        </div>

        {/* Expiry */}
        <div className="mb-2 mt-5 font-mono-plex text-[9px] uppercase tracking-[0.14em] text-l-muted">Expires</div>
        <div className="flex flex-wrap gap-2">
          {expiries.map((e) => {
            const active = day(e) === day(selectedExpiry);
            return (
              <button
                key={e}
                type="button"
                onClick={() => setSelectedExpiry(e)}
                className={`rounded-[6px] border px-3 py-1.5 font-mono-plex text-[12px] tabular-nums transition-colors ${
                  active ? "border-l-text bg-l-surface-2 text-l-text" : "border-l-hair text-l-muted hover:text-l-text"
                }`}
              >
                {chipLabel(e)}
              </button>
            );
          })}
        </div>

        {/* Outcome — honest, bound to the real FE preview */}
        {auto && preview ? (
          <div className="mt-5">
            <div className="flex items-start gap-2">
              <span className="mt-[6px] h-[6px] w-[6px] flex-none rounded-full" style={{ background: "var(--color-l-up)" }} />
              <span className="font-sans text-[13px] leading-snug text-l-text">
                Can't be liquidated — max loss ={" "}
                <span className="font-mono-plex tabular-nums">${preview.cost.toFixed(2)}</span>
              </span>
            </div>
            <div className="mt-1 pl-[14px] font-sans text-[12px] leading-snug text-l-muted">
              Auto-picks the <span className="font-mono-plex tabular-nums text-l-text">${auto.strike}</span> strike ·{" "}
              {preview.qty} contract{preview.qty > 1 ? "s" : ""} · profit if {asset}{" "}
              {direction === "up" ? "≥" : "≤"}{" "}
              <span className="font-mono-plex tabular-nums text-l-text">${preview.breakeven.toFixed(2)}</span> at expiry
            </div>
          </div>
        ) : (
          <div className="mt-5 font-sans text-[13px] leading-snug" style={{ color: "var(--color-l-down)" }}>
            {auto
              ? "Warming up a price…"
              : `No ${direction === "up" ? "up (call)" : "down (put)"} market yet at this expiry.`}
          </div>
        )}

        {/* Primary action — one teal button */}
        <button
          type="button"
          onClick={buy}
          disabled={buyDisabled}
          className={`mt-4 w-full rounded-[6px] py-4 font-sans text-[14px] font-medium transition-opacity ${
            buyDisabled
              ? "cursor-not-allowed border border-l-hair bg-l-surface text-l-muted"
              : "bg-l-up text-l-on-up hover:opacity-90"
          }`}
        >
          {buyLabel}
        </button>

        {status && (
          <p className={`mt-3 font-mono-plex text-[11px] leading-snug ${status.kind === "ok" ? "text-l-muted" : "text-l-down"}`}>
            {status.msg}
          </p>
        )}
      </div>
    </div>
  );
};
