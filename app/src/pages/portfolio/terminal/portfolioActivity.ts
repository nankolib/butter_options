// =============================================================================
// portfolioActivity — adapt the bounded exchange-order scan into ACTIVITY rows.
// =============================================================================
//
// Thin adapter over tradeHistory.scanRecentActivity (the same bounded, real-data
// "recent activity" tx-scan Trade ships — ≤40 sigs → ≤40 getTransaction, never
// throws). Maps the four order events to the terminal ACTIVITY vocabulary:
//   posted·writerAsk → Wrote   posted·resaleAsk → Listed   posted·bid → Bid
//   filled           → Bought / Sold (by wallet role + side)
//   cancelled        → Cancelled       swept → Swept
//
// It covers the ORDER tape only — Exercised / Settled / Claimed fire from
// non-order instructions and need their own event decode (parked, rides the
// indexer arc). The section footnote states the bound honestly. Nothing here
// fabricates a row; unknown fields stay null.
// =============================================================================

import { useEffect, useState } from "react";
import type { Program } from "@coral-xyz/anchor";
import type { PublicKey } from "@solana/web3.js";
import { scanRecentActivity, type ActivityEvent } from "../../trade/tradeHistory";

export type ActivityTone = "up" | "down" | "neutral";

export interface ActivityRow {
  ts: number;
  verb: string;
  tone: ActivityTone;
  contract: string;
  qty: number | null;
  /** Signed USDC magnitude for the AMOUNT column, or null when not derivable. */
  amount: number | null;
  sig: string;
}

/** Map one event → (verb, tone). Bought = cash out (down); Sold = cash in (up). */
function verbFor(ev: ActivityEvent): { verb: string; tone: ActivityTone } {
  if (ev.kind === "posted") {
    if (ev.orderKind === "writerAsk") return { verb: "Wrote", tone: "neutral" };
    if (ev.orderKind === "resaleAsk") return { verb: "Listed", tone: "neutral" };
    if (ev.orderKind === "bid") return { verb: "Bid", tone: "neutral" };
    return { verb: "Quoted", tone: "neutral" };
  }
  if (ev.kind === "cancelled") return { verb: "Cancelled", tone: "neutral" };
  if (ev.kind === "swept") return { verb: "Swept", tone: "neutral" };
  // filled — a taker hitting a bid SELLS; the maker of a bid BUYS.
  const bought = (ev.side === "buy") === (ev.role === "maker");
  return bought ? { verb: "Bought", tone: "down" } : { verb: "Sold", tone: "up" };
}

export function adaptActivity(
  events: ActivityEvent[],
  labelForMint: (mint: string) => string,
): ActivityRow[] {
  return events.map((ev) => {
    const { verb, tone } = verbFor(ev);
    const gross = ev.price != null && ev.qty != null ? ev.price * ev.qty : null;
    // Sign the amount by tone: cash in (+), cash out (−); neutral rows unsigned.
    const amount = gross == null ? null : tone === "down" ? -gross : gross;
    return {
      ts: ev.ts,
      verb,
      tone,
      contract: labelForMint(ev.optionMint),
      qty: ev.qty,
      amount,
      sig: ev.sig,
    };
  });
}

/**
 * useActivity — run the bounded scan once per (wallet) and adapt. Skeleton while
 * loading; empty array when the wallet has no recent order activity.
 */
export function useActivity(
  program: Program<any> | null,
  wallet: PublicKey | null,
  labelForMint: (mint: string) => string,
): { rows: ActivityRow[]; loading: boolean } {
  const [rows, setRows] = useState<ActivityRow[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!program || !wallet) {
      setRows([]);
      return;
    }
    let live = true;
    setLoading(true);
    scanRecentActivity(program, wallet)
      .then((events) => {
        if (live) setRows(adaptActivity(events, labelForMint));
      })
      .catch(() => {
        if (live) setRows([]);
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
    // labelForMint identity churns with data; key on wallet only to avoid rescans.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [program, wallet?.toBase58()]);

  return { rows, loading };
}
