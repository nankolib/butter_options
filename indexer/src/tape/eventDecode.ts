// =============================================================================
// eventDecode.ts — Anchor log-event decoding, filtered THROUGH the allowlist
// =============================================================================
//
// `emit!` writes `sol_log_data([disc8 || borsh(payload)])`, which the runtime
// renders as a `Program data: <base64>` log line. Anchor's BorshEventCoder does
// the layout work; we use it ONLY as a decoder and gate every result on the
// hand-written allowlist (allowlist.ts) so the 9 dead IDL events can never
// leak into the tape.
//
// Note there is no `emit_cpi!` anywhere in the program, so every event is a
// plain log line — no event-authority CPI parsing needed.
//
// Cross-program contamination is a non-issue: we only fetch transactions that
// touch our program, and every decoded line must additionally match one of our
// 8-byte sha256("event:<Name>") discriminators.
// =============================================================================

import { BorshEventCoder, type Idl } from "@coral-xyz/anchor";

import { ALLOWLIST } from "./allowlist";

const PROGRAM_DATA_PREFIX = "Program data: ";

export interface DecodedEvent {
  name: string;
  data: Record<string, unknown>;
  /**
   * Index of this event's `Program data:` line among ALL such lines in the tx,
   * whether or not they decoded or were allowlisted.
   *
   * THIS IS THE ID-STABILITY GUARANTEE (Phase 2a / B2). Numbering only the
   * allowlisted events made ordinals shift whenever the allowlist grew, so a
   * re-index wrote duplicates instead of being idempotent. Numbering every
   * emitted line makes an ordinal a property of the CHAIN, not of our config.
   */
  logIndex: number;
}

export class EventDecoder {
  private readonly coder: BorshEventCoder;

  constructor(idl: Idl) {
    this.coder = new BorshEventCoder(idl);
  }

  /**
   * Decode every allowlisted event from a transaction's log lines, in log order.
   * Non-`Program data:` lines, undecodable payloads, and non-allowlisted names
   * are skipped silently — this must never throw (see main.ts non-throwing rule).
   */
  decodeLogs(logs: readonly string[]): DecodedEvent[] {
    const out: DecodedEvent[] = [];
    let logIndex = -1;
    for (const line of logs) {
      if (!line.startsWith(PROGRAM_DATA_PREFIX)) continue;
      // Counted BEFORE any decode/allowlist filtering — see DecodedEvent.logIndex.
      logIndex += 1;
      const b64 = line.slice(PROGRAM_DATA_PREFIX.length);
      let decoded: { name: string; data: unknown } | null = null;
      try {
        decoded = this.coder.decode(b64);
      } catch {
        continue; // not one of ours, or a truncated payload
      }
      if (!decoded) continue;
      if (!(decoded.name in ALLOWLIST)) continue; // ← the allowlist gate
      out.push({ name: decoded.name, data: decoded.data as Record<string, unknown>, logIndex });
    }
    return out;
  }
}

/** True when the runtime truncated this tx's logs — the tape has a known hole. */
export function logsTruncated(logs: readonly string[]): boolean {
  return logs.some((l) => l.includes("Log truncated"));
}
