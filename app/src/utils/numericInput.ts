// =============================================================================
// utils/numericInput.ts — the typing state machine for every numeric field
// =============================================================================
//
// WHAT WENT WRONG (founder walkthrough, 2026-08-18)
//
//   TP/SL price refused "0". On JTO (~0.0158) that makes the field UNTYPEABLE:
//   every path to a sub-$1 price starts with a character the field threw away.
//   The walkthrough stalled there.
//
//   Quantity could not be emptied — clearing it snapped back to a number, so
//   changing 1 to 2 meant typing "12" and deleting the "1".
//
// WHY, EXACTLY
//
//   Both fields stored a PARSED NUMBER and re-rendered it as the input's value:
//
//     value={qty}                      onChange={e => setQty(Number(e.target.value))}
//     value={tpPrice || ""}            onChange={e => setTpPrice(Number(e.target.value) || 0)}
//
//   Number("") is 0, so clearing snaps back. Number("0") is 0, and `0 || ""`
//   renders as empty — so the "0" you just typed disappears, and "0." and "0.0"
//   can never exist. The intermediate states of typing a decimal are exactly the
//   states these expressions destroy.
//
// THE RULE THIS MODULE ENCODES
//
//   While typing, the field owns a RAW STRING and shows it back verbatim.
//   "", "0", "0.", ".5", "0.0" are all legal in-progress states. Parsing,
//   clamping and validation happen on BLUR and on SUBMIT — never on keystroke.
//
//   Pure and DOM-free so the whole state machine can be tested by feeding it one
//   character at a time, which is how the bug would have been caught.
// =============================================================================

export interface NumericFieldOpts {
  min?: number;
  max?: number;
  /** Reject a decimal point entirely (quantity, contract counts). */
  integer?: boolean;
}

export interface NumericState {
  /** Exactly what the user sees. Never a re-stringified number mid-type. */
  raw: string;
  /** Parsed value for callers. NaN while the raw string is not yet a number. */
  value: number;
}

/** Intermediate states a decimal passes through. Deliberately permissive:
 *  "" (cleared), "0", "0.", ".", ".5", "12.30". No sign — every field here is
 *  a price, a quantity or a percentage, none of which may be negative. */
const DECIMAL_IN_PROGRESS = /^(?:\d*\.?\d*)$/;
const INTEGER_IN_PROGRESS = /^\d*$/;

/**
 * Decide whether a keystroke is allowed to land, and what the field then holds.
 *
 * Returns null when the input should be REJECTED (the field keeps its previous
 * state) — letters, a second decimal point, a minus sign.
 */
export function applyNumericInput(
  next: string,
  opts: NumericFieldOpts = {},
): NumericState | null {
  const pattern = opts.integer ? INTEGER_IN_PROGRESS : DECIMAL_IN_PROGRESS;
  if (!pattern.test(next)) return null;

  // "" and "." and "0." are legal to HOLD but do not parse to a number yet. NaN
  // is the honest answer for "the user is still typing", and callers must not
  // treat it as 0 — that conflation is the original bug.
  const value = next === "" || next === "." ? Number.NaN : Number(next);
  return { raw: next, value: Number.isNaN(value) ? Number.NaN : value };
}

/**
 * Settle the field: called on blur and before submit, never on keystroke.
 *
 * An unparseable or empty field falls back to `fallback` (0 for optional legs,
 * or a minimum for required ones). A parseable value is clamped into range and
 * the raw string is rewritten to match, so the user sees what will be sent.
 */
export function commitNumericInput(
  state: NumericState,
  opts: NumericFieldOpts = {},
  fallback = 0,
): NumericState {
  let v = Number.isNaN(state.value) ? fallback : state.value;
  if (opts.integer) v = Math.trunc(v);
  if (opts.min != null && v < opts.min) v = opts.min;
  if (opts.max != null && v > opts.max) v = opts.max;
  // Re-stringify ONLY here. Doing it on keystroke is what ate the "0".
  return { raw: String(v), value: v };
}

/** Seed the field from a numeric prop (initial render, or a parent prefill). */
export function numericStateFrom(value: number): NumericState {
  if (!Number.isFinite(value)) return { raw: "", value: Number.NaN };
  return { raw: String(value), value };
}

/**
 * The value a caller should SUBMIT. Callers keep their existing numeric state,
 * so submitted values for valid input are byte-identical to before this change —
 * only the typing experience differs.
 */
export function submittedValue(state: NumericState, opts: NumericFieldOpts = {}, fallback = 0): number {
  return commitNumericInput(state, opts, fallback).value;
}
