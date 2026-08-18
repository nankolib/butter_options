// =============================================================================
// portfolio/ArmedTriggersSection.tsx — armed TP/SL exits, with cancel
// =============================================================================
//
// Shows REMAINING quantity, not the quantity originally asked for. execute_trigger
// fills partially — fire_qty is min(order.quantity, depth) and the remainder stays
// armed — so a half-filled stop that displayed its original size would read as
// fully protected when it is not.
//
// CANCEL PASSES THE REAL PEER. A linked leg cancelled with a null peer builds
// fine and is rejected on chain (6087) for exactly the orders OCO exists to
// protect. Cancel is also how the survivor gets unlinked: the program clears the
// peer's oco_link, so the remaining leg stays cancellable and fireable alone.
// =============================================================================

import type { FC } from "react";
import { useState } from "react";
import { PublicKey, Transaction, ComputeBudgetProgram } from "@solana/web3.js";
import { useWallet } from "@solana/wallet-adapter-react";

import { useProgram } from "../../hooks/useProgram";
import { useTriggers, type ArmedTrigger } from "../../hooks/useTriggers";
import { buildTriggerCancelFor } from "../../utils/triggerBundle";
import {
  sendWithFreshBlockhash, type SendableProvider, type SendPhase,
} from "../../utils/sendWithFreshBlockhash";
import { DEVNET_USDC_MINT } from "../../utils/constants";

const fmt = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 4 })}`;

const legLabel = (t: ArmedTrigger) =>
  t.leg === "tp" ? "Take profit" : t.leg === "sl" ? "Stop loss" : "Stop entry";

export const ArmedTriggersSection: FC = () => {
  const { program } = useProgram();
  const { publicKey } = useWallet();
  const { triggers, loading, refresh } = useTriggers();
  const [busy, setBusy] = useState<string | null>(null);
  const [phase, setPhase] = useState<SendPhase | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function cancel(t: ArmedTrigger) {
    if (!program || !publicKey) return;
    setBusy(t.pubkey); setErr(null); setPhase(null);
    try {
      // The peer comes from the FETCHED account, so a linked leg cannot be
      // cancelled peerless. buildTriggerCancelFor throws rather than guess.
      const ix = await buildTriggerCancelFor(
        { program, owner: publicKey, usdcMint: DEVNET_USDC_MINT },
        new PublicKey(t.pubkey),
        { ocoLink: t.ocoLink ? new PublicKey(t.ocoLink) : null },
      );
      await sendWithFreshBlockhash(
        program.provider as unknown as SendableProvider,
        () => {
          const tx = new Transaction();
          tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }));
          tx.add(ix);
          return tx;
        },
        { onPhase: setPhase },
      );
      await refresh();
    } catch (e: any) {
      setErr(String(e?.message ?? e).slice(0, 180));
    } finally {
      setBusy(null); setPhase(null);
    }
  }

  if (loading && triggers.length === 0) {
    return (
      <p className="py-4 font-mono-plex text-[11px] text-l-muted">Loading armed exits…</p>
    );
  }
  if (triggers.length === 0) return null;

  return (
    <section className="mt-6">
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="font-mono-plex text-[9px] uppercase tracking-[0.2em] text-l-muted">
          Armed exits
        </h3>
        <span className="font-mono-plex text-[9.5px] text-l-faint">
          watched by the keeper · fires on the underlying
        </span>
      </div>

      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-l-hair">
            {["Leg", "Condition", "Remaining", "Min proceeds", ""].map((h, i) => (
              <th
                key={h + i}
                className={`py-2 font-mono-plex text-[9px] uppercase tracking-[0.14em] text-l-muted ${
                  i === 0 ? "text-left" : i === 4 ? "text-right" : "text-right"
                }`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {triggers.map((t) => (
            <tr key={t.pubkey} className="border-b border-l-hair">
              <td className="py-[7px] text-left font-mono-plex text-[12px] text-l-text">
                {legLabel(t)}
                {t.ocoLink && (
                  <span className="ml-2 font-mono-plex text-[9px] text-l-faint" title="One-cancels-other: if this fires, the paired leg is cancelled in the same transaction">
                    OCO
                  </span>
                )}
              </td>
              <td className="py-[7px] text-right font-mono-plex text-[12px] tabular-nums text-l-text">
                {t.comparator === "ge" ? "≥ " : "≤ "}{fmt(t.threshold)}
              </td>
              <td className="py-[7px] text-right font-mono-plex text-[12px] tabular-nums text-l-text">
                {t.remaining}
              </td>
              <td className="py-[7px] text-right font-mono-plex text-[12px] tabular-nums text-l-muted">
                {t.floor > 0 ? fmt(t.floor) : (
                  <span title="A floor of 0 is book-ineligible on chain (6082): this leg will not sell into the book">
                    none
                  </span>
                )}
              </td>
              <td className="py-[7px] text-right">
                <button
                  type="button"
                  disabled={busy === t.pubkey}
                  onClick={() => void cancel(t)}
                  className="font-mono-plex text-[10.5px] uppercase tracking-[0.12em] text-l-muted hover:text-l-text disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy === t.pubkey ? (phase ?? "cancelling") : "Cancel"}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {err && (
        <p className="mt-2 font-mono-plex text-[10px] text-l-danger">{err}</p>
      )}
      <p className="mt-2 font-mono-plex text-[9.5px] leading-[1.5] text-l-faint">
        Remaining is what is still armed — a partial fill leaves the rest working.
        Cancelling one leg of an OCO pair unlinks the other, which stays armed on its own.
      </p>
    </section>
  );
};

export default ArmedTriggersSection;
