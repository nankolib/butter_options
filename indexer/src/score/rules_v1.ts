// =============================================================================
// rules_v1.ts — PURE: (tape, config, asOf) -> WalletScore[]
// =============================================================================
//
// No I/O, no Date.now(), no Math.random(). `asOf` is injected by the caller.
// Given an identical tape and config this returns an identical result, which is
// the whole point of the TAPE/SCORE split: rules change -> full recompute ->
// reproducible.
//
// DETERMINISM CONTRACT
//   - the tape arrives pre-sorted (block_time ASC, id ASC) from db.loadTape()
//   - every Map is drained through an explicit sort before it reaches output
//   - final ranking is points_capped DESC, then wallet ASC (total order, no ties)
//
// D3 HARD RULE — VaultPeg maker is a PDA, not a wallet.
//   events.rs:296-304 is explicit: on a fill_vault_peg fill (kind == 3) the
//   `maker` field carries the SharedVault PDA. Crediting it would put a program
//   account at the top of the leaderboard. Maker credit is skipped for kind == 3.
//   kind == 2 (WriterAsk) was verified to carry a real wallet
//   (fill_writer_ask.rs:43,263 -> maker = ctx.accounts.order.owner).
//
// D4 KNOWN LIMITATION — held-to-settle is DERIVED, and Token-2022 transfers are
//   invisible to the program tape. A wallet that transferred contracts out is
//   still credited. The magnitude is measured (diagnostics.negativePositions,
//   diagnostics.holderCountDelta) and reported in shadow.md rather than hidden.
// =============================================================================

import type { EventRow } from "../db";
import { ORDER_KIND } from "../tape/allowlist";

export const RULES_VERSION = "v1";

export interface RulesConfig {
  takerPtsPerUsdc: number;
  makerPtsPerUsdc: number;
  exercisePts: number;
  heldToSettlePts: number;
  triggerExecutedPts: number;
  settleExpiryPts: number;
  createMarketFirstPts: number;
  createMarketFloorPts: number;
  dailyCapPoints: number;
  overCapMultiplier: number;
}

export const DEFAULT_RULES: RulesConfig = {
  takerPtsPerUsdc: 1,
  makerPtsPerUsdc: 0.5,
  exercisePts: 25,
  heldToSettlePts: 10,
  triggerExecutedPts: 15,
  settleExpiryPts: 50,
  createMarketFirstPts: 100,
  createMarketFloorPts: 5,
  dailyCapPoints: 500,
  overCapMultiplier: 0.1,
};

export interface WalletScore {
  wallet: string;
  points: number;
  pointsCapped: number;
  breakdown: Record<string, number>;
}

export interface Diagnostics {
  /** (wallet,vault) pairs that went negative — proof of invisible inflow (D4). */
  negativePositions: number;
  /** Σ |derived holders at settle − HoldersFinalized.holders_processed|. */
  holderCountDelta: number;
  /** Settled vaults for which a HoldersFinalized row exists to compare against. */
  holderCountComparisons: number;
  selfTradesZeroed: number;
  pegMakerCreditsSkipped: number;
}

export interface ScoreResult {
  rulesVersion: string;
  asOf: number;
  scores: WalletScore[];
  diagnostics: Diagnostics;
}

interface Contribution {
  wallet: string;
  ts: number;
  rule: string;
  points: number;
  seq: number;
}

const USDC = 1_000_000;
const round4 = (n: number) => Math.round(n * 1e4) / 1e4;
const dayKey = (ts: number) => Math.floor(ts / 86400);

export function score(tape: readonly EventRow[], cfg: RulesConfig, asOf: number): ScoreResult {
  const contributions: Contribution[] = [];
  const diagnostics: Diagnostics = {
    negativePositions: 0,
    holderCountDelta: 0,
    holderCountComparisons: 0,
    selfTradesZeroed: 0,
    pegMakerCreditsSkipped: 0,
  };
  let seq = 0;

  const add = (wallet: string | null, ts: number | null, rule: string, points: number) => {
    if (!wallet || points === 0) return;
    contributions.push({ wallet, ts: ts ?? 0, rule, points, seq: seq++ });
  };

  // ---- Pass 1: mint -> vault map (VaultListingFilled carries no vault) ------
  const mintToVault = new Map<string, string>();
  for (const e of tape) {
    if (e.option_mint && e.vault && !mintToVault.has(e.option_mint)) {
      mintToVault.set(e.option_mint, e.vault);
    }
  }
  const vaultOf = (e: EventRow): string | null =>
    e.vault ?? (e.option_mint ? mintToVault.get(e.option_mint) ?? null : null);

  // ---- Pass 2: contributions + holder-position ledger ----------------------
  // Ledger is per (wallet, vault): VaultSettled is vault-scoped and VaultExercised
  // carries no mint, so vault granularity is both sufficient and the finest level
  // the tape actually supports.
  const positions = new Map<string, number>();
  const negativeSeen = new Set<string>();
  const posKey = (w: string, v: string) => `${w}|${v}`;

  const move = (wallet: string | null, vault: string | null, delta: number) => {
    if (!wallet || !vault || delta === 0) return;
    const k = posKey(wallet, vault);
    const next = (positions.get(k) ?? 0) + delta;
    positions.set(k, next);
    if (next < 0 && !negativeSeen.has(k)) {
      negativeSeen.add(k);
      diagnostics.negativePositions += 1;
    }
  };

  const marketsByCreator = new Map<string, number>();
  const holdersFinalizedByVault = new Map<string, number>();
  for (const e of tape) {
    if (e.name === "HoldersFinalized" && e.vault) {
      try {
        const f = JSON.parse(e.fields_json) as { holders_processed?: number | string };
        holdersFinalizedByVault.set(e.vault, Number(f.holders_processed ?? 0));
      } catch {
        /* fields_json is always ours, but never let a parse kill scoring */
      }
    }
  }

  for (const e of tape) {
    const vault = vaultOf(e);

    switch (e.name) {
      case "OrderFilled": {
        const usdc = (e.amount_usdc ?? 0) / USDC;
        const qty = e.quantity ?? 0;
        const taker = e.wallet;
        const maker = e.counterparty;
        const isPeg = e.kind === ORDER_KIND.VaultPeg;
        const selfTrade = taker != null && maker != null && taker === maker;

        if (selfTrade) {
          diagnostics.selfTradesZeroed += 1;
          break; // zero both sides, and no position change either
        }

        add(taker, e.block_time, "fill_taker", usdc * cfg.takerPtsPerUsdc);
        if (isPeg) {
          diagnostics.pegMakerCreditsSkipped += 1; // D3 hard rule
        } else {
          add(maker, e.block_time, "fill_maker", usdc * cfg.makerPtsPerUsdc);
        }

        // Position deltas. Filling a Bid means the TAKER is selling.
        if (e.kind === ORDER_KIND.Bid) {
          move(taker, vault, -qty);
          move(maker, vault, +qty);
        } else if (e.kind === ORDER_KIND.ResaleAsk) {
          move(taker, vault, +qty);
          move(maker, vault, -qty);
        } else {
          // WriterAsk / VaultPeg — contracts are minted fresh, maker holds nothing.
          move(taker, vault, +qty);
        }
        break;
      }

      case "VaultPurchased":
        move(e.wallet, vault, +(e.quantity ?? 0));
        break;

      case "VaultListingFilled":
        move(e.wallet, vault, +(e.quantity ?? 0)); // buyer
        move(e.counterparty, vault, -(e.quantity ?? 0)); // seller
        break;

      case "VaultExercised":
        add(e.wallet, e.block_time, "exercise", cfg.exercisePts);
        move(e.wallet, vault, -(e.quantity ?? 0));
        break;

      case "TriggerExecuted":
        add(e.wallet, e.block_time, "trigger_executed", cfg.triggerExecutedPts);
        break;

      case "IxSettleExpiry":
        add(e.wallet, e.block_time, "settle_expiry", cfg.settleExpiryPts);
        break;

      case "IxCreateMarket": {
        if (!e.wallet) break;
        const n = (marketsByCreator.get(e.wallet) ?? 0) + 1;
        marketsByCreator.set(e.wallet, n);
        const pts = Math.max(cfg.createMarketFirstPts / n, cfg.createMarketFloorPts);
        add(e.wallet, e.block_time, "create_market", pts);
        break;
      }

      case "VaultSettled": {
        if (!vault) break;
        // Award every wallet still net-long this vault at settlement.
        const holders: string[] = [];
        for (const [k, qty] of positions) {
          const [w, v] = k.split("|");
          if (v === vault && qty > 0) holders.push(w);
        }
        holders.sort(); // determinism: Map order is insertion order, sort anyway
        for (const w of holders) add(w, e.block_time, "held_to_settle", cfg.heldToSettlePts);

        // D4 diagnostic: compare against the on-chain aggregate where available.
        const onChain = holdersFinalizedByVault.get(vault);
        if (onChain != null) {
          diagnostics.holderCountComparisons += 1;
          diagnostics.holderCountDelta += Math.abs(holders.length - onChain);
        }

        // Positions in a settled vault are resolved — clear them.
        for (const k of [...positions.keys()]) {
          if (k.endsWith(`|${vault}`)) positions.delete(k);
        }
        break;
      }

      default:
        break;
    }
  }

  // ---- Pass 3: per-wallet, per-UTC-day soft cap ----------------------------
  contributions.sort((a, b) => a.ts - b.ts || a.seq - b.seq);

  const byWallet = new Map<string, Contribution[]>();
  for (const c of contributions) {
    const list = byWallet.get(c.wallet);
    if (list) list.push(c);
    else byWallet.set(c.wallet, [c]);
  }

  const scores: WalletScore[] = [];
  for (const wallet of [...byWallet.keys()].sort()) {
    const list = byWallet.get(wallet)!;
    const dayRaw = new Map<number, number>();
    const breakdown: Record<string, number> = {};
    let raw = 0;
    let capped = 0;

    for (const c of list) {
      const d = dayKey(c.ts);
      const used = dayRaw.get(d) ?? 0;
      const room = Math.max(0, cfg.dailyCapPoints - used);
      const full = Math.min(c.points, room);
      const over = c.points - full;
      const eff = full + over * cfg.overCapMultiplier;

      dayRaw.set(d, used + c.points);
      raw += c.points;
      capped += eff;
      breakdown[c.rule] = round4((breakdown[c.rule] ?? 0) + eff);
    }

    scores.push({ wallet, points: round4(raw), pointsCapped: round4(capped), breakdown });
  }

  // Total order: capped DESC, then wallet ASC. No ties, so output is byte-stable.
  scores.sort((a, b) => b.pointsCapped - a.pointsCapped || (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));

  return { rulesVersion: RULES_VERSION, asOf, scores, diagnostics };
}
