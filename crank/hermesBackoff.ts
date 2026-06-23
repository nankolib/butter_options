// ============================================================================
// crank/hermesBackoff.ts — shared Hermes AIMD backoff (extracted, Phase 4 P2)
// ============================================================================
//
// The settle loop (bot.ts) has an inline AIMD backoff against Hermes 429/5xx.
// The trigger loop needs the SAME discipline (a Hermes hiccup must back off,
// not hot-loop). Rather than duplicate the algorithm, the canonical state
// machine lives here as pure functions. The trigger loop uses it directly.
//
// NOTE: bot.ts's settle loop still carries its own inline copy (pre-existing);
// converging it onto this helper is a mechanical follow-up deliberately NOT
// done in this off-chain pass (it would touch the live settle path). See the
// P2 report OPEN QUESTIONS.
//
// Multiplicative-increase on 429/5xx, additive-ish decrease (halve toward base)
// after N consecutive OKs — the exact shape of bot.ts:566-592.
// ============================================================================

export interface BackoffState {
  /** Current paced delay (ms). Starts at base; grows on 429/5xx; halves back. */
  currentMs: number;
  /** Consecutive successes since the last increase (drives recovery). */
  consecutiveOk: number;
}

export const DEFAULT_BACKOFF_BASE_MS = 500;
export const DEFAULT_BACKOFF_CEILING_MS = 10_000;
/** Multiplicative-increase factor on 429/5xx. */
export const BACKOFF_MULTIPLIER = 2;
/** Consecutive-success threshold before halving currentMs toward base. */
export const BACKOFF_RECOVER_AFTER_N_OK = 3;

export function mkBackoff(baseMs: number = DEFAULT_BACKOFF_BASE_MS): BackoffState {
  return { currentMs: baseMs, consecutiveOk: 0 };
}

/** On a rate-limit / 5xx: multiply currentMs up to the ceiling; reset OK streak. */
export function backoffOn429(
  s: BackoffState,
  ceilingMs: number = DEFAULT_BACKOFF_CEILING_MS,
  multiplier: number = BACKOFF_MULTIPLIER,
): void {
  s.currentMs = Math.min(s.currentMs * multiplier, ceilingMs);
  s.consecutiveOk = 0;
}

/** On a success: only meaningful above base — after N OKs, halve toward base. */
export function backoffOnOk(
  s: BackoffState,
  baseMs: number = DEFAULT_BACKOFF_BASE_MS,
  recoverAfterN: number = BACKOFF_RECOVER_AFTER_N_OK,
): void {
  if (s.currentMs <= baseMs) return;
  s.consecutiveOk += 1;
  if (s.consecutiveOk >= recoverAfterN) {
    s.currentMs = Math.max(Math.floor(s.currentMs / 2), baseMs);
    s.consecutiveOk = 0;
  }
}

/** Coarse classification of a Hermes failure (mirrors bot.ts classifySettleError). */
export function classifyHermesError(err: unknown): "rate-limit" | "no-update" | "other" {
  const s = String(err);
  if (s.includes("HTTP 429") || s.includes("HTTP 503") || s.includes("HTTP 502")) {
    return "rate-limit";
  }
  if (s.includes("HTTP 404")) return "no-update";
  return "other";
}
