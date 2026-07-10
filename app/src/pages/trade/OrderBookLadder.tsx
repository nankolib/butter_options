import type { FC, ReactNode } from "react";
import { useMemo } from "react";
import { useBook } from "../../hooks/useBook";

/**
 * OrderBookLadder — reusable depth ladder for a series (Pass 8 extraction).
 * Real asks (down/crimson, high→low) + the labeled VAULT PEG offer band +
 * spread + bids (up/teal, high→low). Terminal design language (design lock
 * 2026-07-09): -l- tokens invert automatically for light/dark; numbers are
 * font-mono-plex tabular-nums, right-aligned; labels are small-caps eyebrows.
 *
 * Depth bars are CUMULATIVE (design brief §7): each level's bar scales to the
 * running Σ resting size walking from the best price OUTWARD on that side, over
 * the deepest side's total — a Deribit-style depth ramp. The vault-peg level is
 * excluded from the cumulative sums (its size is unbounded) and shown as a
 * distinct labeled band. Used by both the contract-detail modal and the Pro
 * chart-page terminal.
 */
const fmt = (n: number) => `$${n.toFixed(n < 100 ? 4 : 2)}`;

export const OrderBookLadder: FC<{ optionMint: string | null; pegPrice: number | null }> = ({ optionMint, pegPrice }) => {
  const { orders } = useBook();
  const { asks, bids, askCum, bidCum, maxCum } = useMemo(() => {
    const mine = optionMint ? orders.filter((o) => o.optionMint === optionMint) : [];
    const asks = mine.filter((o) => o.kind !== "bid").sort((a, b) => b.price - a.price); // high→low (best/lowest at bottom)
    const bids = mine.filter((o) => o.kind === "bid").sort((a, b) => b.price - a.price); // high→low (best/highest at top)

    // Cumulative resting size, walking from the best price outward on each side.
    // Asks: best = lowest = bottom row → suffix-sum upward (worst/top holds the
    // full side total). Bids: best = highest = top row → prefix-sum downward.
    const askCum: number[] = new Array(asks.length);
    let run = 0;
    for (let i = asks.length - 1; i >= 0; i--) {
      run += asks[i].qty;
      askCum[i] = run;
    }
    const askTotal = run;
    const bidCum: number[] = new Array(bids.length);
    run = 0;
    for (let i = 0; i < bids.length; i++) {
      run += bids[i].qty;
      bidCum[i] = run;
    }
    const bidTotal = run;
    // Shared scale across both sides so bar widths compare honestly; the deepest
    // side's outermost level reaches 100%. Peg qty is excluded (never summed).
    const maxCum = Math.max(1, askTotal, bidTotal);
    return { asks, bids, askCum, bidCum, maxCum };
  }, [orders, optionMint]);

  const spread = asks.length && bids.length ? asks[asks.length - 1].price - bids[0].price : null;
  const empty = !asks.length && !bids.length && pegPrice == null;

  return (
    <div className="font-mono-plex text-[12px] text-l-text">
      {asks.map((o, i) => (
        <Level
          key={o.pubkey}
          price={o.price}
          qty={o.qty}
          cum={askCum[i]}
          maxCum={maxCum}
          side="ask"
          writer={o.kind === "writerAsk"}
          collateral={o.kind === "writerAsk" ? o.collateralPerContract : null}
        />
      ))}

      {pegPrice != null && (
        <div className="relative flex items-center justify-between rounded-[6px] bg-l-surface px-[6px] py-[4px]">
          <span className="font-mono-plex text-[12px] tabular-nums" style={{ color: "var(--color-l-down)" }}>
            {fmt(pegPrice)}
          </span>
          <span className="font-mono-plex text-[9px] uppercase tracking-[0.14em] text-l-muted">vault</span>
        </div>
      )}

      <div className="flex items-center justify-between border-y border-l-hair px-[6px] py-[6px] my-[3px]">
        <span className="font-mono-plex text-[9px] uppercase tracking-[0.14em] text-l-muted">Spread</span>
        <span className="font-mono-plex text-[11px] tabular-nums text-l-muted">{spread != null ? fmt(spread) : "—"}</span>
      </div>

      {bids.map((o, i) => (
        <Level key={o.pubkey} price={o.price} qty={o.qty} cum={bidCum[i]} maxCum={maxCum} side="bid" />
      ))}

      {empty && <div className="font-mono-plex text-[11px] text-l-muted py-4">No resting orders</div>}
    </div>
  );
};

const Level: FC<{
  price: number;
  qty: number | null;
  cum: number;
  maxCum: number;
  side: "ask" | "bid";
  writer?: boolean;
  collateral?: number | null;
}> = ({ price, qty, cum, maxCum, side, writer, collateral }) => {
  const isAsk = side === "ask";
  const tone = isAsk ? "var(--color-l-down)" : "var(--color-l-up)";
  const barW = Math.min(100, (cum / maxCum) * 100);
  return (
    <div className="relative flex items-center justify-between px-[6px] py-[3px]">
      {/* Cumulative depth bar — anchored to the size (right) edge, behind text. */}
      <div
        className="absolute inset-y-0 right-0 transition-[width] duration-150 ease-opta"
        style={{ width: `${barW}%`, background: tone, opacity: 0.12 }}
      />
      <span className="relative z-[1] flex items-center gap-[6px] font-mono-plex text-[12px] tabular-nums" style={{ color: tone }}>
        {fmt(price)}
        {writer && (
          <span
            className="font-mono-plex text-[8.5px] uppercase tracking-[0.14em] text-l-muted"
            title="Writer-ask — mint-on-fill"
          >
            W
          </span>
        )}
      </span>
      <span className="relative z-[1] flex items-baseline gap-[6px] font-mono-plex text-[12px] tabular-nums text-l-muted">
        <span>{qty ?? "—"}</span>
        {collateral != null && <span className="text-[10px] text-l-muted">coll ${collateral.toFixed(collateral < 100 ? 2 : 0)}</span>}
      </span>
    </div>
  );
};
