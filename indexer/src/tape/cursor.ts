// =============================================================================
// cursor.ts — durable cursor state
// =============================================================================
//
// Three keys, all in `meta`:
//
//   cursor_sig      the NEWEST signature fully indexed. Live-tail asks for
//                   everything strictly newer via `until`.
//   backfill_before the OLDEST signature reached while walking backwards.
//                   Resume point for a killed backfill.
//   backfill_done   "1" once the backward walk passed the floor timestamp.
//
// Because txs.sig is a PRIMARY KEY and event ids are deterministic, overlapping
// re-reads are free — the cursor only needs to be roughly right, never exact.
// =============================================================================

import { getMeta, setMeta, type DB } from "../db";

export interface CursorState {
  cursorSig: string | null;
  backfillBefore: string | null;
  backfillDone: boolean;
}

export function readCursor(db: DB): CursorState {
  return {
    cursorSig: getMeta(db, "cursor_sig"),
    backfillBefore: getMeta(db, "backfill_before"),
    backfillDone: getMeta(db, "backfill_done") === "1",
  };
}

export function setCursorSig(db: DB, sig: string): void {
  setMeta(db, "cursor_sig", sig);
}

export function setBackfillBefore(db: DB, sig: string): void {
  setMeta(db, "backfill_before", sig);
}

export function markBackfillDone(db: DB): void {
  setMeta(db, "backfill_done", "1");
}
