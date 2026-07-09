import type { FC } from "react";
import { OrderBookLadder } from "./OrderBookLadder";
import { RecentTradesTape } from "./RecentTradesTape";

/**
 * BookAndTape — the order book (depth bars + spread) over the recent-trades tape.
 * Its own vertical middle column between the chain and the ticket on ≥1280px
 * (design lock 2026-07-09); stacks under the chain below 1280. Self-contained +
 * prop-driven so the shell can place it in either slot.
 */
export const BookAndTape: FC<{ optionMint: string | null; pegPrice: number | null; isSeries: boolean }> = ({
  optionMint,
  pegPrice,
  isSeries,
}) => (
  <div className="space-y-[18px] text-l-text">
    <div>
      <div className="mb-[10px] font-mono-plex text-[9px] uppercase tracking-[0.14em] text-l-muted">Order book</div>
      {isSeries && optionMint ? (
        <OrderBookLadder optionMint={optionMint} pegPrice={pegPrice} />
      ) : (
        <div className="font-mono-plex text-[11px] text-l-muted">No book — legacy/epoch contracts trade via the vault peg.</div>
      )}
    </div>
    <div className="border-t border-l-hair pt-[14px]">
      <RecentTradesTape optionMint={optionMint} />
    </div>
  </div>
);

export default BookAndTape;
