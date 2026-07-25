// =============================================================================
// evaluator.ts — Part D: quest engine (PURE)
// =============================================================================
//
// evaluate(tape, provenance, referrals, configs, asOf) -> completions + totals
//
// Same purity contract as rules_v1: no I/O, no Date.now(), no Math.random();
// `asOf` is injected; every Map is drained through an explicit sort.
//
// D12 (confirmed): the onboarding chain is STRICTLY SEQUENTIAL. O(n) completes
// at the first qualifying event at-or-after O(n-1)'s completion — an out-of-order
// action does not retroactively count. Backdated over a tape where most wallets
// took one or two actions in arbitrary order this yields a THIN funnel; that is
// honest, and is retuned in shadow only if degenerate.
//
// Internal wallets are evaluated (for sanity) but excluded from every board by
// the caller. That is what stops crank-gas from farming W2 with its 47
// settle_expiry calls — asserted in the tests.
// =============================================================================

import type { EventRow, TapeSource } from "../../db";
import { ORDER_KIND } from "../../tape/allowlist";
import { spanBucket } from "../../tape/marketsRefresh";
import { multiplierFor, utcDay, type MultiplierResult } from "../multiplier";
import { computePositions } from "../positions";

import questsV1 from "./quests_v1.json";

export const QUESTS_VERSION: string = questsV1.version;

export interface QuestConfig {
  version: string;
  chain: { id: string; name: string; points: number; bonus?: { id: string; points: number } }[];
  chainCompleteBonus: { id: string; name: string; points: number };
  dailies: { id: string; name: string; points: number; thresholdUsdc?: number }[];
  weeklies: {
    id: string;
    name: string;
    points: number;
    maxPerWeek?: number;
    distinctUnderlyings?: number;
    spanBonus?: { id: string; points: number; buckets: string[] };
  }[];
  referral: { refereeBondPoints: number; referrerRate: number; referrerCapFractionOfSelf: number };
}

export const DEFAULT_QUESTS = questsV1 as QuestConfig;

export interface Completion {
  wallet: string;
  questId: string;
  /** '' for one-time, 'YYYY-MM-DD' daily, 'YYYY-Www' weekly. */
  periodKey: string;
  completedAt: number;
  points: number;
}

export interface FaucetClaimRow {
  wallet: string;
  block_time: number | null;
}

export interface EvaluatorInputs {
  tape: TapeSource;
  faucetClaims: readonly FaucetClaimRow[];
  /** mint -> asset_name + class bucket, from the markets reference table. */
  underlyingOf: ReadonlyMap<string, { assetName: string; bucket: string }>;
  multipliers: MultiplierResult;
  cfg: QuestConfig;
  asOf: number;
}

export interface EvaluatorResult {
  completions: Completion[];
  /** wallet -> total quest points (dailies already multiplied). */
  totals: Map<string, number>;
  /** wallet -> highest chain step completed (0..7). */
  funnel: Map<string, number>;
}

/** ISO-8601 week key, e.g. 2026-W30. */
export function isoWeek(ts: number): string {
  const d = new Date(ts * 1000);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const dt = new Date(t);
  // ISO: Thursday of the current week determines the year.
  const dayNum = (dt.getUTCDay() + 6) % 7;
  dt.setUTCDate(dt.getUTCDate() - dayNum + 3);
  const isoYear = dt.getUTCFullYear();
  const firstThu = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThu.getUTCDay() + 6) % 7;
  firstThu.setUTCDate(firstThu.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((dt.getTime() - firstThu.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, "0")}`;
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/**
 * ITEM 0 (Phase 2b) — SELECTIVE RETENTION.
 *
 * This used to hold whole `EventRow` objects per wallet, which meant the render
 * kept a large slice of the tape alive. It now retains only the few scalars the
 * quest rules actually read, and only for the ~8 chain-relevant event types.
 * On the live tape that is ~140 retained records versus 42,444 OrderPosted /
 * OrderCancelled rows that no quest rule ever looks at.
 */
interface Ev {
  ts: number;
  mint: string | null;
  amount: number;
}

interface WalletActivity {
  fillsTaker: Ev[];
  fillsMakerReal: Ev[]; // kind != 3
  mints: Ev[];
  exercises: Ev[];
  triggersPlaced: Ev[];
  triggersExecuted: Ev[];
  keeperActions: Ev[]; // IxSettleExpiry | IxCreateMarket
  settleExpiries: Ev[];
}

function blankActivity(): WalletActivity {
  return {
    fillsTaker: [],
    fillsMakerReal: [],
    mints: [],
    exercises: [],
    triggersPlaced: [],
    triggersExecuted: [],
    keeperActions: [],
    settleExpiries: [],
  };
}

const toEv = (e: EventRow): Ev => ({
  ts: e.block_time ?? 0,
  mint: e.option_mint,
  amount: e.amount_usdc ?? 0,
});

export function evaluate(input: EvaluatorInputs): EvaluatorResult {
  const { tape, faucetClaims, underlyingOf, multipliers, cfg, asOf } = input;

  // ---- Index activity per wallet -----------------------------------------
  const act = new Map<string, WalletActivity>();
  const get = (w: string) => {
    let a = act.get(w);
    if (!a) act.set(w, (a = blankActivity()));
    return a;
  };

  for (const e of tape()) {
    switch (e.name) {
      case "OrderFilled":
        if (e.wallet) get(e.wallet).fillsTaker.push(toEv(e));
        if (e.counterparty && e.kind !== ORDER_KIND.VaultPeg) get(e.counterparty).fillsMakerReal.push(toEv(e));
        break;
      case "VaultMinted":
        if (e.wallet) get(e.wallet).mints.push(toEv(e));
        break;
      case "VaultExercised":
        if (e.wallet) get(e.wallet).exercises.push(toEv(e));
        break;
      case "TriggerPlaced":
        if (e.wallet) get(e.wallet).triggersPlaced.push(toEv(e));
        break;
      case "TriggerExecuted":
        if (e.wallet) get(e.wallet).triggersExecuted.push(toEv(e));
        break;
      case "IxSettleExpiry":
        if (e.wallet) {
          get(e.wallet).keeperActions.push(toEv(e));
          get(e.wallet).settleExpiries.push(toEv(e));
        }
        break;
      case "IxCreateMarket":
        if (e.wallet) get(e.wallet).keeperActions.push(toEv(e));
        break;
      default:
        break;
    }
  }

  const positions = computePositions(tape);
  const heldByWallet = new Map<string, Ev[]>();
  for (const a of positions.awards) {
    const ev: Ev = { ts: a.ts, mint: null, amount: 0 };
    const list = heldByWallet.get(a.wallet);
    if (list) list.push(ev);
    else heldByWallet.set(a.wallet, [ev]);
  }

  const faucetByWallet = new Map<string, number[]>();
  for (const c of faucetClaims) {
    if (c.block_time == null) continue;
    const list = faucetByWallet.get(c.wallet);
    if (list) list.push(c.block_time);
    else faucetByWallet.set(c.wallet, [c.block_time]);
  }

  const completions: Completion[] = [];
  const totals = new Map<string, number>();
  const funnel = new Map<string, number>();

  const wallets = [...new Set([...act.keys(), ...heldByWallet.keys(), ...faucetByWallet.keys()])].sort();

  for (const wallet of wallets) {
    const a = act.get(wallet) ?? blankActivity();
    let questPoints = 0;

    const award = (questId: string, periodKey: string, completedAt: number, points: number) => {
      completions.push({ wallet, questId, periodKey, completedAt, points: round4(points) });
      questPoints += points;
    };

    // ---- Onboarding chain — STRICTLY SEQUENTIAL (D12) ---------------------
    const firstAtOrAfter = (rows: readonly Ev[], after: number): number | null => {
      let best: number | null = null;
      for (const r of rows) {
        if (r.ts >= after && (best === null || r.ts < best)) best = r.ts;
      }
      return best;
    };

    let unlockAt = 0;
    let step = 0;
    let o5OrderMints: Set<string> | null = null;

    for (const q of cfg.chain) {
      let at: number | null = null;
      switch (q.id) {
        case "O1":
          at = firstAtOrAfter(a.fillsTaker, unlockAt);
          break;
        case "O2":
          at = firstAtOrAfter(a.mints, unlockAt);
          break;
        case "O3":
          at = firstAtOrAfter(a.fillsMakerReal, unlockAt);
          break;
        case "O4":
          at = firstAtOrAfter(a.exercises, unlockAt);
          break;
        case "O5":
          at = firstAtOrAfter(a.triggersPlaced, unlockAt);
          if (at != null) {
            o5OrderMints = new Set(a.triggersPlaced.filter((r) => r.ts === at).map((r) => r.mint ?? ""));
          }
          break;
        case "O6": {
          at = firstAtOrAfter(heldByWallet.get(wallet) ?? [], unlockAt);
          break;
        }
        case "O7":
          at = firstAtOrAfter(a.keeperActions, unlockAt);
          break;
        default:
          break;
      }
      if (at == null) break;
      award(q.id, "", at, q.points);
      step += 1;
      unlockAt = at;

      // O5 bonus: the SAME trigger order later fired.
      if (q.id === "O5" && q.bonus) {
        const fired = a.triggersExecuted.find(
          (r) => r.ts >= at! && (!o5OrderMints?.size || o5OrderMints.has(r.mint ?? "")),
        );
        if (fired) award(q.bonus.id, "", fired.ts, q.bonus.points);
      }
    }
    funnel.set(wallet, step);
    if (step === cfg.chain.length) {
      award(cfg.chainCompleteBonus.id, "", unlockAt, cfg.chainCompleteBonus.points);
    }

    // ---- Dailies (UTC), multiplier-eligible ------------------------------
    const takerByDay = new Map<string, number>();
    for (const f of a.fillsTaker) {
      const d = utcDay(f.ts);
      takerByDay.set(d, (takerByDay.get(d) ?? 0) + f.amount);
    }
    const makerDays = new Set(a.fillsMakerReal.map((f) => utcDay(f.ts)));
    const faucetDays = new Set((faucetByWallet.get(wallet) ?? []).map((t) => utcDay(t)));

    for (const q of cfg.dailies) {
      let days: string[] = [];
      if (q.id === "D1") {
        days = [...takerByDay.entries()].filter(([, v]) => v >= (q.thresholdUsdc ?? 0)).map(([d]) => d);
      } else if (q.id === "D2") {
        days = [...makerDays].filter((d) => takerByDay.has(d));
      } else if (q.id === "D3") {
        days = [...faucetDays];
      }
      for (const d of days.sort()) {
        // D11: multiplier as of THAT day, applied to the daily award.
        const m = multiplierFor(multipliers, wallet, d);
        award(q.id, d, Math.floor(Date.parse(`${d}T00:00:00Z`) / 1000), q.points * m);
      }
    }

    // ---- Weeklies (ISO), NOT multiplier-eligible -------------------------
    for (const q of cfg.weeklies) {
      if (q.id === "W1") {
        const weeks = new Set((heldByWallet.get(wallet) ?? []).map((h) => isoWeek(h.ts)));
        for (const w of [...weeks].sort()) award(q.id, w, 0, q.points);
      } else if (q.id === "W2") {
        const byWeek = new Map<string, number>();
        for (const s of a.settleExpiries) {
          const w = isoWeek(s.ts);
          byWeek.set(w, (byWeek.get(w) ?? 0) + 1);
        }
        for (const w of [...byWeek.keys()].sort()) {
          const n = Math.min(byWeek.get(w)!, q.maxPerWeek ?? 1);
          award(q.id, w, 0, q.points * n);
        }
      } else if (q.id === "W3") {
        const byWeek = new Map<string, { names: Set<string>; buckets: Set<string> }>();
        const allFills = [...a.fillsTaker, ...a.fillsMakerReal];
        for (const f of allFills) {
          if (!f.mint) continue;
          const u = underlyingOf.get(f.mint);
          if (!u) continue;
          const w = isoWeek(f.ts);
          let acc = byWeek.get(w);
          if (!acc) byWeek.set(w, (acc = { names: new Set(), buckets: new Set() }));
          acc.names.add(u.assetName);
          acc.buckets.add(u.bucket);
        }
        for (const w of [...byWeek.keys()].sort()) {
          const acc = byWeek.get(w)!;
          if (acc.names.size < (q.distinctUnderlyings ?? 3)) continue;
          award(q.id, w, 0, q.points);
          // D10: {Equity, ETF} already collapsed into one 'equity' bucket.
          if (q.spanBonus && q.spanBonus.buckets.every((b) => acc.buckets.has(b))) {
            award(q.spanBonus.id, w, 0, q.spanBonus.points);
          }
        }
      }
    }

    totals.set(wallet, round4(questPoints));
  }

  completions.sort(
    (x, y) =>
      (x.wallet < y.wallet ? -1 : x.wallet > y.wallet ? 1 : 0) ||
      (x.questId < y.questId ? -1 : x.questId > y.questId ? 1 : 0) ||
      (x.periodKey < y.periodKey ? -1 : x.periodKey > y.periodKey ? 1 : 0),
  );

  void asOf;
  return { completions, totals, funnel };
}
