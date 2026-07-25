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

import type { TapeSource } from "../db";
import { ORDER_KIND } from "../tape/allowlist";
import { computePositions } from "./positions";

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
  /**
   * D15 (Phase 2b): post-cap points attributed to the UTC day they were earned.
   * Phase 2a multiplied a wallet's total by its AVERAGE multiplier because this
   * breakdown did not exist — an approximation that over-credited quiet days and
   * under-credited streak days. The caller now multiplies each day at THAT day's
   * rate, which is what D11 actually specifies.
   */
  perDay: Record<string, number>;
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

export function score(tape: TapeSource, cfg: RulesConfig, asOf: number): ScoreResult {
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

  // ---- Pass 1: the shared position ledger --------------------------------
  // Held-to-settle derivation lives in positions.ts so rules_v1 and the quest
  // evaluator cannot drift apart on subtle position accounting.
  const posResult = computePositions(tape);
  diagnostics.negativePositions = posResult.diagnostics.negativePositions;
  diagnostics.holderCountDelta = posResult.diagnostics.holderCountDelta;
  diagnostics.holderCountComparisons = posResult.diagnostics.holderCountComparisons;

  const heldAwards = posResult.awards;

  // ---- Pass 2: contributions ----------------------------------------------
  const marketsByCreator = new Map<string, number>();

  for (const e of tape()) {
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
        void qty; // position deltas are owned by positions.ts
        break;
      }

      case "VaultExercised":
        add(e.wallet, e.block_time, "exercise", cfg.exercisePts);
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

      default:
        break;
    }
  }

  // Held-to-settle awards come from the shared ledger, already in vault order.
  for (const a of heldAwards) add(a.wallet, a.ts, "held_to_settle", cfg.heldToSettlePts);

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
    const perDayAcc = new Map<string, number>();
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
      // D15: retain the post-cap amount against its UTC day so the caller can
      // apply that day's multiplier instead of a whole-wallet average.
      const dayStr = new Date(c.ts * 1000).toISOString().slice(0, 10);
      perDayAcc.set(dayStr, (perDayAcc.get(dayStr) ?? 0) + eff);
    }

    const perDay: Record<string, number> = {};
    for (const k of [...perDayAcc.keys()].sort()) perDay[k] = round4(perDayAcc.get(k)!);

    scores.push({ wallet, points: round4(raw), pointsCapped: round4(capped), breakdown, perDay });
  }

  // Total order: capped DESC, then wallet ASC. No ties, so output is byte-stable.
  scores.sort((a, b) => b.pointsCapped - a.pointsCapped || (a.wallet < b.wallet ? -1 : a.wallet > b.wallet ? 1 : 0));

  return { rulesVersion: RULES_VERSION, asOf, scores, diagnostics };
}
