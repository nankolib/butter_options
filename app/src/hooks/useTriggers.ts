// =============================================================================
// hooks/useTriggers.ts — the caller's armed TP/SL triggers
// =============================================================================
//
// One source for both surfaces that show triggers: the chart readout strip
// (levels for the series on screen) and the Positions row (every armed leg with
// its remaining quantity and a cancel).
//
// REMAINING QUANTITY IS THE POINT. execute_trigger fills partially — fire_qty is
// min(order.quantity, available depth) and the remainder stays armed. So the UI
// must show what is LEFT, not what was originally asked for, or a half-filled
// stop reads as fully protected.
//
// COST: one getProgramAccounts scoped by a memcmp on `owner` at offset 8 (right
// after the discriminator), so the RPC returns only this wallet's orders instead
// of the whole board. This is the same method that exhausted the key on
// 2026-08-06 when it was issued unscoped every 15 seconds; here it runs on mount
// and after a mutation, filtered.
import { useCallback, useEffect, useState } from "react";
import { PublicKey } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";

import { useProgram } from "./useProgram";

export interface ArmedTrigger {
  pubkey: string;
  optionMint: string;
  vault: string;
  market: string;
  /** "tp" = TakeProfitSell, "sl" = StopLossSell. Buy-side entries are not shown
   *  here: this surface is about exits. */
  leg: "tp" | "sl" | "entry";
  /** Underlying condition price, dollars. */
  threshold: number;
  /** Fires when the underlying is at-or-above ("ge") / at-or-below ("le"). */
  comparator: "le" | "ge";
  /** Contracts STILL armed — decremented by partial fills. */
  remaining: number;
  /** Per-contract minimum proceeds. 0 means book-ineligible (6082). */
  floor: number;
  /** The paired leg, when this is half of an OCO couple. Cancel MUST pass it. */
  ocoLink: string | null;
  createdAt: number;
}

const legOf = (kind: any): ArmedTrigger["leg"] => {
  if (kind == null) return "entry";
  const k = Object.keys(kind)[0]?.toLowerCase() ?? "";
  if (k.startsWith("takeprofit")) return "tp";
  if (k.startsWith("stoploss")) return "sl";
  return "entry";
};

const cmpOf = (c: any): "le" | "ge" =>
  c && Object.keys(c)[0]?.toLowerCase().startsWith("less") ? "le" : "ge";

export function useTriggers(optionMint?: string | null) {
  const { program } = useProgram();
  const { publicKey } = useWallet();
  const [triggers, setTriggers] = useState<ArmedTrigger[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    if (!program || !publicKey) { setTriggers([]); return; }
    setLoading(true);
    try {
      // owner is the first field, so offset 8 (after the 8-byte discriminator).
      const rows = await (program.account as any).triggerOrder.all([
        { memcmp: { offset: 8, bytes: publicKey.toBase58() } },
      ]);
      const mapped: ArmedTrigger[] = rows.map((r: any) => {
        const a = r.account;
        return {
          pubkey: r.publicKey.toBase58(),
          optionMint: (a.optionMint as PublicKey).toBase58(),
          vault: (a.vault as PublicKey).toBase58(),
          market: (a.market as PublicKey).toBase58(),
          leg: legOf(a.kind),
          threshold: Number(a.thresholdUsdc?.toString() ?? 0) / 1e6,
          comparator: cmpOf(a.comparator),
          remaining: Number(a.quantity?.toString() ?? 0),
          floor: Number(a.maxPremium?.toString() ?? 0) / 1e6,
          ocoLink: a.ocoLink ? new PublicKey(a.ocoLink).toBase58() : null,
          createdAt: Number(a.createdAt?.toString() ?? 0),
        };
      })
      // A zeroed leg is an OCO sibling whose partner already fired. It cannot
      // fire again, so showing it as "armed" would misrepresent protection the
      // user no longer has. It is still cancellable from Positions for its rent.
      .filter((t: ArmedTrigger) => t.remaining > 0);
      setTriggers(mapped);
    } catch {
      setTriggers([]);
    } finally {
      setLoading(false);
    }
  }, [program, publicKey]);

  useEffect(() => { void refresh(); }, [refresh]);

  const forSeries = optionMint
    ? triggers.filter((t) => t.optionMint === optionMint)
    : triggers;

  return { triggers: forSeries, allTriggers: triggers, loading, refresh };
}
