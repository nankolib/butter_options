import type { FC, ReactNode } from "react";
import { useMemo } from "react";
import { useBook } from "../../hooks/useBook";

/**
 * OrderBookLadder — reusable depth ladder for a series (Pass 8 extraction).
 * Real asks (crimson, high→low) + the labeled VAULT PEG ask level + spread +
 * bids (teal, high→low). Depth bars scale to the largest qty on the book.
 * Used by both the contract-detail modal and the Pro chart-page terminal.
 */
const fmt = (n: number) => `$${n.toFixed(n < 100 ? 4 : 2)}`;

export const OrderBookLadder: FC<{ optionMint: string | null; pegPrice: number | null }> = ({ optionMint, pegPrice }) => {
  const { orders } = useBook();
  const { asks, bids, maxQty } = useMemo(() => {
    const mine = optionMint ? orders.filter((o) => o.optionMint === optionMint) : [];
    return {
      asks: mine.filter((o) => o.kind !== "bid").sort((a, b) => b.price - a.price), // high→low (best at bottom)
      bids: mine.filter((o) => o.kind === "bid").sort((a, b) => b.price - a.price), // high→low (best at top)
      maxQty: Math.max(1, ...mine.map((o) => o.qty)),
    };
  }, [orders, optionMint]);

  const spread = asks.length && bids.length ? asks[asks.length - 1].price - bids[0].price : null;
  const empty = !asks.length && !bids.length && pegPrice == null;

  return (
    <div className="font-mono text-[12px]">
      {asks.map((o) => <Level key={o.pubkey} price={o.price} qty={o.qty} max={maxQty} side="ask" writer={o.kind === "writerAsk"} collateral={o.kind === "writerAsk" ? o.collateralPerContract : null} />)}
      {pegPrice != null && <Level price={pegPrice} qty={null} max={maxQty} side="ask" label="vault peg" />}
      <div className="flex items-center justify-between py-1.5 my-1 border-y border-rule-soft text-ink-muted text-[10.5px] uppercase tracking-[0.18em]">
        <span>spread</span>
        <span>{spread != null ? fmt(spread) : "—"}</span>
      </div>
      {bids.map((o) => <Level key={o.pubkey} price={o.price} qty={o.qty} max={maxQty} side="bid" />)}
      {empty && <div className="font-mono text-[11px] text-ink-muted py-4">No resting orders</div>}
    </div>
  );
};

const Level: FC<{ price: number; qty: number | null; max: number; side: "ask" | "bid"; label?: ReactNode; writer?: boolean; collateral?: number | null }> = ({ price, qty, max, side, label, writer, collateral }) => (
  <div className="relative flex items-center justify-between py-1 px-1">
    <div className={`absolute inset-y-0 right-0 ${side === "ask" ? "bg-crimson/10" : "bg-teal/10"}`} style={{ width: qty ? `${Math.min(100, (qty / max) * 100)}%` : "0%" }} />
    <span className={`relative ${side === "ask" ? "text-crimson" : "text-teal"}`}>
      ${price.toFixed(price < 100 ? 4 : 2)}
      {writer && <span className="ml-1.5 text-[8.5px] uppercase tracking-[0.14em] text-ink-muted" title="Writer-ask — mint-on-fill">W</span>}
    </span>
    <span className="relative text-ink-muted">
      {label ?? (qty ?? "—")}
      {collateral != null && <span className="ml-1.5 text-[9px] text-ink-muted/70">coll ${collateral.toFixed(collateral < 100 ? 2 : 0)}</span>}
    </span>
  </div>
);
