// =============================================================================
// normalize.ts — PURE: (RawTx) -> { TxRow, EventRow[] }
// =============================================================================
//
// No I/O, no Date, no randomness. The caller injects everything. This mirrors
// the buildSbSettlementRecord property in crank/settlementArchive.ts and is what
// makes the tape unit-testable and re-indexing deterministic.
//
// Row IDs are DETERMINISTIC — `<sig>:<ordinal>` — so INSERT OR IGNORE makes
// re-indexing a signature a no-op. That is the mechanism behind the
// "kill mid-backfill -> restart -> zero dupes" acceptance criterion.
// =============================================================================

import bs58 from "bs58";

import type { EventRow, TxRow } from "../db";
import { ALLOWLIST, type FieldMap } from "./allowlist";
import { EventDecoder, logsTruncated } from "./eventDecode";
import { matchIx } from "./ixDecode";

/** The shape returned by raw JSON-RPC getTransaction with encoding "json". */
export interface RawTx {
  slot: number;
  blockTime: number | null;
  transaction: {
    signatures: string[];
    message: {
      accountKeys: string[];
      instructions: { programIdIndex: number; accounts: number[]; data: string }[];
    };
  };
  meta: {
    err: unknown;
    logMessages?: string[] | null;
    loadedAddresses?: { writable: string[]; readonly: string[] } | null;
  } | null;
}

export interface Normalized {
  tx: TxRow;
  events: EventRow[];
}

/**
 * Full account key list for a transaction, in canonical runtime order:
 * static keys, then ALT-loaded writable, then ALT-loaded readonly.
 */
export function fullAccountKeys(raw: RawTx): string[] {
  const base = raw.transaction.message.accountKeys ?? [];
  const loaded = raw.meta?.loadedAddresses;
  if (!loaded) return base;
  return [...base, ...(loaded.writable ?? []), ...(loaded.readonly ?? [])];
}

/** JSON-safe: BN / bigint / PublicKey / Buffer -> string. No precision loss on u64. */
function jsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    // BN and PublicKey both expose toString(); prefer it over enumerating internals.
    if (typeof o.toBase58 === "function") return (o.toBase58 as () => string)();
    if (typeof o.toString === "function" && (o.constructor?.name === "BN" || "words" in o)) {
      return (o.toString as () => string)();
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(o)) out[k] = jsonSafe(v);
    return out;
  }
  return String(value);
}

/** Coerce a decoded field to a JS integer, or null. u64 arrives as BN. */
function asInt(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "bigint") return Number(value);
  const o = value as { toString?: () => string };
  if (typeof o.toString === "function") {
    const n = Number(o.toString());
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asPubkey(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  const o = value as { toBase58?: () => string };
  if (typeof o.toBase58 === "function") return o.toBase58();
  return null;
}

function applyFieldMap(data: Record<string, unknown>, map: FieldMap) {
  let amount: number | null = null;
  if (map.amountUsdc) {
    amount = asInt(data[map.amountUsdc]);
  } else if (map.amountUsdcProduct) {
    const a = asInt(data[map.amountUsdcProduct[0]]);
    const b = asInt(data[map.amountUsdcProduct[1]]);
    amount = a != null && b != null ? a * b : null;
  }
  return {
    wallet: map.wallet ? asPubkey(data[map.wallet]) : null,
    counterparty: map.counterparty ? asPubkey(data[map.counterparty]) : null,
    vault: map.vault ? asPubkey(data[map.vault]) : null,
    option_mint: map.optionMint ? asPubkey(data[map.optionMint]) : null,
    kind: map.kind ? asInt(data[map.kind]) : null,
    amount_usdc: amount,
    quantity: map.quantity ? asInt(data[map.quantity]) : null,
  };
}

/**
 * PURE. Turn one raw transaction into its tape rows.
 *
 * Failed transactions (meta.err != null) are recorded in `txs` with ok = 0 and
 * produce ZERO events — their state changes rolled back, so their logs are not
 * facts. Recording them anyway keeps the cursor monotonic and stops us from
 * re-fetching them forever.
 */
export function normalize(raw: RawTx, decoder: EventDecoder, programId: string): Normalized {
  const sig = raw.transaction.signatures[0];
  const logs = raw.meta?.logMessages ?? [];
  const ok = raw.meta?.err == null;

  const tx: TxRow = {
    sig,
    slot: raw.slot,
    block_time: raw.blockTime ?? null,
    ok: ok ? 1 : 0,
    truncated: logsTruncated(logs) ? 1 : 0,
  };

  if (!ok) return { tx, events: [] };

  const events: EventRow[] = [];
  let ordinal = 0;

  const push = (row: Omit<EventRow, "id" | "sig" | "ordinal" | "block_time">) => {
    events.push({
      id: `${sig}:${ordinal}`,
      sig,
      ordinal,
      block_time: raw.blockTime ?? null,
      ...row,
    });
    ordinal += 1;
  };

  // ---- 1. Log-derived events, in log order --------------------------------
  for (const ev of decoder.decodeLogs(logs)) {
    const map = ALLOWLIST[ev.name];
    push({
      ix_index: null,
      source: "log",
      name: ev.name,
      fields_json: JSON.stringify(jsonSafe(ev.data)),
      ...applyFieldMap(ev.data, map),
    });
  }

  // ---- 2. ix-decoded events (no event exists for these three) --------------
  const keys = fullAccountKeys(raw);
  const ixs = raw.transaction.message.instructions ?? [];
  for (let i = 0; i < ixs.length; i++) {
    const ix = ixs[i];
    if (keys[ix.programIdIndex] !== programId) continue;
    let data: Uint8Array;
    try {
      data = bs58.decode(ix.data);
    } catch {
      continue;
    }
    const ixAccounts = ix.accounts.map((idx) => keys[idx]).filter((k): k is string => k != null);
    const hit = matchIx(data, ixAccounts);
    if (!hit) continue;
    push({
      ix_index: i,
      source: "ix",
      name: hit.target.eventName,
      wallet: hit.actor,
      counterparty: null,
      vault: hit.captured.vault ?? null,
      option_mint: null,
      kind: null,
      amount_usdc: null,
      quantity: null,
      fields_json: JSON.stringify({ ix: hit.target.name, ...hit.captured }),
    });
  }

  return { tx, events };
}
