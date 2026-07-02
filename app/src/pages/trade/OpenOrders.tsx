import type { FC } from "react";
import { useMemo, useState } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useBook, type BookOrder } from "../../hooks/useBook";
import { useCancelOrder } from "../../hooks/useOrderFlows";
import posthog from "posthog-js";

/**
 * OpenOrders — the connected wallet's resting orders + one-click cancel.
 * Reuses the paper hairline idiom (same as OrderBookLadder). Scope to a single
 * series via `optionMint`, or pass null to list ALL of the wallet's orders.
 * Cancel → useCancelOrder (T1) → refetch the book.
 */
const KIND_LABEL: Record<string, string> = { bid: "BID", resaleAsk: "RESALE", writerAsk: "WRITER", vaultPeg: "PEG" };
const fmt = (n: number) => `$${n.toFixed(n < 100 ? 4 : 2)}`;

export const OpenOrders: FC<{ optionMint?: string | null }> = ({ optionMint = null }) => {
  const { publicKey } = useWallet();
  const { orders, refetch } = useBook();
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
      if (sig) { posthog.capture("trade_cancel", { kind: o.kind, sig }); await refetch(); }
    } catch (e: any) {
      setErr((e?.message ?? String(e)).slice(0, 120));
    } finally { setBusy(null); }
  }

  if (!publicKey) return null;

  return (
    <div className="font-mono text-[12px]">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-ink-muted mb-3">Your open orders</div>
      {mine.length === 0 ? (
        <div className="font-mono text-[11px] text-ink-muted py-3">No open orders</div>
      ) : (
        <div className="space-y-px">
          {mine.map((o) => (
            <div key={o.pubkey} className="flex items-center justify-between gap-3 py-1.5 px-1 border-b border-rule-soft last:border-0">
              <span className={`text-[9.5px] uppercase tracking-[0.14em] w-14 ${o.kind === "bid" ? "text-teal" : "text-crimson"}`}>{KIND_LABEL[o.kind] ?? o.kind}</span>
              <span className="text-ink flex-1">{fmt(o.price)}</span>
              <span className="text-ink-muted flex-1">×{o.qty}</span>
              <span className="text-ink-muted text-[10.5px] flex-1">{o.kind === "writerAsk" ? `coll ${fmt(o.collateralPerContract)}` : "—"}</span>
              <button type="button" onClick={() => onCancel(o)} disabled={busy === o.pubkey}
                className="font-mono text-[9.5px] uppercase tracking-[0.14em] border border-rule rounded px-2 py-1 text-ink hover:bg-paper-2 disabled:opacity-40 disabled:cursor-wait">
                {busy === o.pubkey ? "…" : "Cancel"}
              </button>
            </div>
          ))}
        </div>
      )}
      {err && <p className="font-mono text-[10px] text-crimson mt-2">{err}</p>}
    </div>
  );
};
