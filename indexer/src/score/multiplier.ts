// =============================================================================
// multiplier.ts — Part C: consistency multiplier (PURE). Replaces streaks.
// =============================================================================
//
// active_day(wallet, UTC date) = at least one of:
//   OrderFilled  (either side; maker side only when kind != 3)
//   VaultMinted | VaultExercised | TriggerExecuted (owner) | IxSettleExpiry
// Faucet claims deliberately do NOT count — funding yourself is not activity.
//
// multiplier = min(1.0 + 0.1 * consecutive_active_days, 2.0)
// A missed day consumes a banked shield if one exists (streak preserved, event
// logged) else resets the streak to 1.0.
// Shields: +1 per completed 7-day streak, bank capped at 2.
//
// D11 (confirmed): the multiplier applied to a day's points is the multiplier
// AS OF THAT DAY — a retroactive replay, not today's rate — and it is applied
// AFTER the daily soft cap. Cap is an abuse guard on raw earnings; the
// multiplier is a reward on what survived the cap. Reversing them would let a
// 2.0x wallet bank 1,000/day through a 500/day cap.
//
// Every value here is a PROJECTION replayed from the tape. Nothing is stored
// truth, so a rules change is just a recompute.
// =============================================================================

import type { EventRow } from "../db";
import { ORDER_KIND } from "../tape/allowlist";

export const MULTIPLIER_STEP = 0.1;
export const MULTIPLIER_CAP = 2.0;
export const SHIELD_STREAK_LENGTH = 7;
export const SHIELD_BANK_MAX = 2;

export interface ShieldEvent {
  wallet: string;
  day: string;
  action: "earned" | "consumed";
}

export interface StreakState {
  wallet: string;
  currentStreak: number;
  longestStreak: number;
  shieldsBanked: number;
  shieldsConsumed: number;
  multiplier: number;
  lastActiveDay: string | null;
}

export interface MultiplierResult {
  /** wallet -> UTC date -> multiplier in force THAT day. */
  byWalletDay: Map<string, Map<string, number>>;
  state: Map<string, StreakState>;
  shieldEvents: ShieldEvent[];
}

export const utcDay = (ts: number): string => new Date(ts * 1000).toISOString().slice(0, 10);
const dayNumber = (day: string): number => Math.floor(Date.parse(`${day}T00:00:00Z`) / 86_400_000);
const fromDayNumber = (n: number): string => new Date(n * 86_400_000).toISOString().slice(0, 10);

/** Does this event count toward an active day? */
export function isActivityEvent(e: EventRow, wallet: string): boolean {
  switch (e.name) {
    case "OrderFilled":
      if (e.wallet === wallet) return true;
      // Maker side counts only when the maker is a real wallet (kind != 3).
      return e.counterparty === wallet && e.kind !== ORDER_KIND.VaultPeg;
    case "VaultMinted":
    case "VaultExercised":
    case "TriggerExecuted":
    case "IxSettleExpiry":
      return e.wallet === wallet;
    default:
      return false;
  }
}

/** Collect the set of active UTC days per wallet. */
export function activeDays(tape: readonly EventRow[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (w: string | null, ts: number | null) => {
    if (!w || ts == null) return;
    let s = out.get(w);
    if (!s) out.set(w, (s = new Set()));
    s.add(utcDay(ts));
  };

  for (const e of tape) {
    switch (e.name) {
      case "OrderFilled":
        add(e.wallet, e.block_time);
        if (e.kind !== ORDER_KIND.VaultPeg) add(e.counterparty, e.block_time);
        break;
      case "VaultMinted":
      case "VaultExercised":
      case "TriggerExecuted":
      case "IxSettleExpiry":
        add(e.wallet, e.block_time);
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * Replay streaks day by day from each wallet's first active day through `asOf`.
 * PURE — `asOf` is injected, never read from the clock.
 */
export function computeMultipliers(tape: readonly EventRow[], asOf: number): MultiplierResult {
  const active = activeDays(tape);
  const byWalletDay = new Map<string, Map<string, number>>();
  const state = new Map<string, StreakState>();
  const shieldEvents: ShieldEvent[] = [];

  const asOfDay = dayNumber(utcDay(asOf));

  for (const wallet of [...active.keys()].sort()) {
    const days = active.get(wallet)!;
    const sorted = [...days].sort();
    const first = dayNumber(sorted[0]);
    const last = Math.max(first, asOfDay);

    let streak = 0;
    let longest = 0;
    let banked = 0;
    let consumed = 0;
    let sinceShield = 0;
    const perDay = new Map<string, number>();

    for (let d = first; d <= last; d++) {
      const day = fromDayNumber(d);
      if (days.has(day)) {
        streak += 1;
        sinceShield += 1;
        if (streak > longest) longest = streak;
        if (sinceShield === SHIELD_STREAK_LENGTH) {
          sinceShield = 0;
          if (banked < SHIELD_BANK_MAX) {
            banked += 1;
            shieldEvents.push({ wallet, day, action: "earned" });
          }
        }
      } else if (banked > 0) {
        // Shield absorbs the miss: streak survives but does not advance.
        banked -= 1;
        consumed += 1;
        shieldEvents.push({ wallet, day, action: "consumed" });
      } else {
        streak = 0;
        sinceShield = 0;
      }
      // The multiplier in force ON `day` (1.0 on a reset day).
      perDay.set(day, Math.min(1 + MULTIPLIER_STEP * streak, MULTIPLIER_CAP));
    }

    byWalletDay.set(wallet, perDay);
    state.set(wallet, {
      wallet,
      currentStreak: streak,
      longestStreak: longest,
      shieldsBanked: banked,
      shieldsConsumed: consumed,
      multiplier: Math.min(1 + MULTIPLIER_STEP * streak, MULTIPLIER_CAP),
      lastActiveDay: sorted[sorted.length - 1] ?? null,
    });
  }

  return { byWalletDay, state, shieldEvents };
}

/** Multiplier in force for `wallet` on `day`; 1.0 when unknown. */
export function multiplierFor(res: MultiplierResult, wallet: string, day: string): number {
  return res.byWalletDay.get(wallet)?.get(day) ?? 1;
}
