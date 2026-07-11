import type { FC } from "react";
import { useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "../../hooks/useProgram";
import { useBook, type BookOrder } from "../../hooks/useBook";
import { useCancelOrder } from "../../hooks/useOrderFlows";
import { SolscanLink } from "../../components/SolscanLink";
import { refreshAfterMutation } from "./orderRefresh";
import posthog from "posthog-js";

/**
 * OpenOrders — the connected wallet's resting orders + one-click cancel.
 * Terminal design language (design lock 2026-07-09): hairline rows, mono-plex
 * numerics, up/down side accents. Scope to a single series via `optionMint`, or
 * pass null to list ALL of the wallet's orders. Self-contained + prop-driven so
 * it drops into the Trade bottom dock unchanged. Cancel → useCancelOrder (T1) →
 * refetch the book.
 */
const KIND_LABEL: Record<string, string> = { bid: "BID", resaleAsk: "RESALE", writerAsk: "WRITER", vaultPeg: "PEG" };
const fmt = (n: number) => `$${n.toFixed(n < 100 ? 4 : 2)}`;
// bid is the buy (up) side; every ask/peg variant is the sell (down) side.
const isBuySide = (kind: string) => kind === "bid";

export const OpenOrders: FC<{ optionMint?: string | null }> = ({ optionMint = null }) => {
  const { publicKey } = useWallet();
  const { program } = useProgram();
  const { orders } = useBook();
  const cancel = useCancelOrder();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const mine = useMemo(() => {
    if (!publicKey) return [];
    const me = publicKey.toBase58();
    return orders
      .filter((o) => o.owner === me && (!optionMint || o.optionMint === optionMint))
      .sort((a, b) => b.createdAt - a.createdAt);
  }, [orders, publicKey, optionMint]);

  async function onCancel(o: BookOrder) {
    setErr(null); setBusy(o.pubkey);
    try {
      const sig = await cancel.submit(o);
      if (sig && program) {
        posthog.capture("trade_cancel", { kind: o.kind, sig });
        // Optimistic remove + reconcile: book, chain grid, and dock all refresh.
        refreshAfterMutation(program, { removed: [o.pubkey] });
      }
    } catch (e: any) {
      setErr((e?.message ?? String(e)).slice(0, 120));
    } finally { setBusy(null); }
  }

  if (!publicKey) return null;

  return (
    <div className="text-l-text">
      <div className="font-mono-plex text-[9px] uppercase tracking-[0.14em] text-l-muted mb-[10px]">Your open orders</div>
      {mine.length === 0 ? (
        <div className="font-mono-plex text-[11px] text-l-muted py-3">No open orders</div>
      ) : (
        <div className="overflow-hidden rounded-[10px] border border-l-hair">
          {/* Header */}
          <div
            className="grid h-[28px] items-center border-b border-l-hair bg-l-surface"
            style={{ gridTemplateColumns: "72px 1fr 60px minmax(88px,1fr) 118px" }}
          >
            <span className="px-3 font-mono-plex text-[9px] uppercase tracking-[0.1em] text-l-muted">Side</span>
            <span className="px-3 text-right font-mono-plex text-[9px] uppercase tracking-[0.1em] text-l-muted">Price</span>
            <span className="px-3 text-right font-mono-plex text-[9px] uppercase tracking-[0.1em] text-l-muted">Qty</span>
            <span className="px-3 text-right font-mono-plex text-[9px] uppercase tracking-[0.1em] text-l-muted">Collateral</span>
            <span className="px-3" />
          </div>
          {mine.map((o) => {
            const buy = isBuySide(o.kind);
            return (
              <div
                key={o.pubkey}
                className="grid h-[32px] items-center border-b border-l-hair last:border-0 hover:bg-l-surface"
                style={{ gridTemplateColumns: "72px 1fr 60px minmax(88px,1fr) 118px" }}
              >
                <span className="flex items-center gap-[6px] px-3">
                  <span
                    className="h-[6px] w-[6px] flex-none rounded-full"
                    style={{ background: buy ? "var(--color-l-up)" : "var(--color-l-down)" }}
                  />
                  <span
                    className="font-mono-plex text-[9.5px] uppercase tracking-[0.12em]"
                    style={{ color: buy ? "var(--color-l-up)" : "var(--color-l-down)" }}
                  >
                    {KIND_LABEL[o.kind] ?? o.kind}
                  </span>
                </span>
                <span className="px-3 text-right font-mono-plex text-[12px] tabular-nums text-l-text">{fmt(o.price)}</span>
                <span className="px-3 text-right font-mono-plex text-[12px] tabular-nums text-l-muted">×{o.qty}</span>
                <span className="px-3 text-right font-mono-plex text-[11px] tabular-nums text-l-muted">
                  {o.kind === "writerAsk" ? fmt(o.collateralPerContract) : "—"}
                </span>
                <span className="flex items-center justify-end gap-2 px-3">
                  <button
                    type="button"
                    onClick={() => onCancel(o)}
                    disabled={busy === o.pubkey}
                    className="font-mono-plex text-[9.5px] uppercase tracking-[0.12em] rounded-[6px] border px-[9px] py-[4px] text-l-down transition-colors hover:bg-l-surface disabled:opacity-40 disabled:cursor-wait"
                    style={{ borderColor: "var(--color-l-down)" }}
                  >
                    {busy === o.pubkey ? "…" : "Cancel"}
                  </button>
                  <SolscanLink kind="account" id={o.pubkey} label="order" />
                </span>
              </div>
            );
          })}
        </div>
      )}
      {err && <p className="font-mono-plex text-[10px] text-l-down mt-2">{err}</p>}
    </div>
  );
};
