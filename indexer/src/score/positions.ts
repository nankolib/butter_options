// =============================================================================
// positions.ts — derived holder-position ledger (PURE)
// =============================================================================
//
// Shared by rules_v1 (the held_to_settle points rule) and the quest evaluator
// (O6 Diamond Hands, W1). Extracted deliberately: two independent copies of
// subtle position accounting would drift, and a drift here silently changes who
// gets paid.
//
// Positions are keyed per (wallet, VAULT), not per mint. VaultSettled is
// vault-scoped and VaultExercised carries no mint, so vault granularity is both
// sufficient and the finest level the tape actually supports.
//
// D4 KNOWN LIMITATION — Token-2022 contract transfers never touch the program,
// so a wallet that transferred contracts out still looks long here. Measured,
// not hidden: `negativePositions` counts pairs that went negative, which can
// only happen via an inflow we could not see.
// =============================================================================

import type { EventRow } from "../db";
import { ORDER_KIND } from "../tape/allowlist";

export interface HeldToSettleAward {
  wallet: string;
  vault: string;
  /** block_time of the VaultSettled event that resolved the position. */
  ts: number;
}

export interface PositionDiagnostics {
  negativePositions: number;
  holderCountDelta: number;
  holderCountComparisons: number;
}

export interface PositionResult {
  awards: HeldToSettleAward[];
  diagnostics: PositionDiagnostics;
  /** mint -> vault, resolved from any event carrying both. */
  mintToVault: Map<string, string>;
}

export function buildMintToVault(tape: readonly EventRow[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const e of tape) {
    if (e.option_mint && e.vault && !m.has(e.option_mint)) m.set(e.option_mint, e.vault);
  }
  return m;
}

export function computePositions(tape: readonly EventRow[]): PositionResult {
  const mintToVault = buildMintToVault(tape);
  const vaultOf = (e: EventRow): string | null =>
    e.vault ?? (e.option_mint ? mintToVault.get(e.option_mint) ?? null : null);

  const positions = new Map<string, number>();
  const negativeSeen = new Set<string>();
  const awards: HeldToSettleAward[] = [];
  const diagnostics: PositionDiagnostics = {
    negativePositions: 0,
    holderCountDelta: 0,
    holderCountComparisons: 0,
  };

  const holdersFinalizedByVault = new Map<string, number>();
  for (const e of tape) {
    if (e.name === "HoldersFinalized" && e.vault) {
      try {
        const f = JSON.parse(e.fields_json) as { holders_processed?: number | string };
        holdersFinalizedByVault.set(e.vault, Number(f.holders_processed ?? 0));
      } catch {
        /* never let a parse kill scoring */
      }
    }
  }

  const move = (wallet: string | null, vault: string | null, delta: number) => {
    if (!wallet || !vault || delta === 0) return;
    const k = `${wallet}|${vault}`;
    const next = (positions.get(k) ?? 0) + delta;
    positions.set(k, next);
    if (next < 0 && !negativeSeen.has(k)) {
      negativeSeen.add(k);
      diagnostics.negativePositions += 1;
    }
  };

  for (const e of tape) {
    const vault = vaultOf(e);
    switch (e.name) {
      case "OrderFilled": {
        const qty = e.quantity ?? 0;
        const taker = e.wallet;
        const maker = e.counterparty;
        if (taker != null && maker != null && taker === maker) break; // self-trade
        if (e.kind === ORDER_KIND.Bid) {
          move(taker, vault, -qty); // taker sells into the resting bid
          move(maker, vault, +qty);
        } else if (e.kind === ORDER_KIND.ResaleAsk) {
          move(taker, vault, +qty);
          move(maker, vault, -qty);
        } else {
          move(taker, vault, +qty); // WriterAsk / VaultPeg mint fresh contracts
        }
        break;
      }
      case "VaultPurchased":
        move(e.wallet, vault, +(e.quantity ?? 0));
        break;
      case "VaultListingFilled":
        move(e.wallet, vault, +(e.quantity ?? 0));
        move(e.counterparty, vault, -(e.quantity ?? 0));
        break;
      case "VaultExercised":
        move(e.wallet, vault, -(e.quantity ?? 0));
        break;
      case "VaultSettled": {
        if (!vault) break;
        const holders: string[] = [];
        for (const [k, qty] of positions) {
          const sep = k.lastIndexOf("|");
          if (k.slice(sep + 1) === vault && qty > 0) holders.push(k.slice(0, sep));
        }
        holders.sort();
        for (const w of holders) awards.push({ wallet: w, vault, ts: e.block_time ?? 0 });

        const onChain = holdersFinalizedByVault.get(vault);
        if (onChain != null) {
          diagnostics.holderCountComparisons += 1;
          diagnostics.holderCountDelta += Math.abs(holders.length - onChain);
        }
        for (const k of [...positions.keys()]) {
          if (k.slice(k.lastIndexOf("|") + 1) === vault) positions.delete(k);
        }
        break;
      }
      default:
        break;
    }
  }

  return { awards, diagnostics, mintToVault };
}
