// =============================================================================
// components/NumericField.tsx — the one numeric input
// =============================================================================
//
// Every numeric field in the app routes through here. Per-field patches were
// explicitly rejected: the same two bugs appeared independently in the ticket's
// shared NumInput and again in the TP/SL fields written months later, because
// each was written from scratch and each got the intermediate states wrong.
//
// WHY type="text"
//   type="number" hands JavaScript an EMPTY e.target.value for input the browser
//   considers invalid — "0.0." and, in some engines, a lone "-". So the very
//   states we need to preserve arrive as "", indistinguishable from a cleared
//   field. inputMode="decimal" still raises the numeric keypad on mobile, which
//   is the part that actually mattered.
//
// CONTRACT
//   The parent keeps its numeric state exactly as before, so submitted values are
//   unchanged for valid input. This component owns only the RAW STRING between
//   keystrokes, and reports a parsed number as the user types. Clamping happens on
//   blur (and again at submit, in the parent).
// =============================================================================

import type { FC } from "react";
import { useEffect, useRef, useState } from "react";

import {
  applyNumericInput, commitNumericInput, numericStateFrom,
  type NumericFieldOpts, type NumericState,
} from "../utils/numericInput";

export interface NumericFieldProps extends NumericFieldOpts {
  /** Committed numeric value owned by the parent. */
  value: number;
  /** Parsed value on each accepted keystroke; NaN while mid-type. */
  onChange: (n: number) => void;
  /** Used when the field is empty or unparseable at blur. */
  fallback?: number;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
  "aria-label"?: string;
}

export const NumericField: FC<NumericFieldProps> = ({
  value, onChange, min, max, integer, fallback = 0,
  placeholder, className, disabled, id, ...rest
}) => {
  const opts: NumericFieldOpts = { min, max, integer };
  const [state, setState] = useState<NumericState>(() => numericStateFrom(value));
  // Tracks what WE last reported, so a parent echoing our own value back does not
  // count as an external change and clobber the string being typed.
  const lastReported = useRef<number>(value);

  useEffect(() => {
    if (value === lastReported.current) return;      // our own echo — ignore
    if (Number.isFinite(state.value) && state.value === value) return;
    // A genuine external change (prefill, reset). Adopt it.
    lastReported.current = value;
    setState(numericStateFrom(value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <input
      id={id}
      // See the header: type="number" destroys the intermediate states.
      type="text"
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      disabled={disabled}
      placeholder={placeholder}
      className={className}
      value={state.raw}
      onChange={(e) => {
        const next = applyNumericInput(e.target.value, opts);
        if (!next) return;                 // rejected keystroke: field unchanged
        setState(next);
        // Do NOT report NaN. Callers wrap onChange with things like
        // `Math.max(1, n || 1)`, which would turn a mid-type NaN back into a
        // number, push it down as a new prop, and snap the field back to it —
        // re-creating the exact bug this component exists to remove. While the
        // string is unparseable the parent simply keeps its last good value; the
        // field still shows what was typed, and blur settles it.
        if (!Number.isNaN(next.value)) {
          lastReported.current = next.value;
          onChange(next.value);
        }
      }}
      onBlur={() => {
        // Settle: clamp, normalise, and show the user what will actually be sent.
        const c = commitNumericInput(state, opts, fallback);
        setState(c);
        lastReported.current = c.value;
        onChange(c.value);
      }}
      {...rest}
    />
  );
};

export default NumericField;
