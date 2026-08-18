// =============================================================================
// chain/divergence.ts — does the reflection actually match the chain?
// =============================================================================
//
// The acceptance gate for the read path. Without it, a decode bug ships a number
// that is structurally valid, semantically wrong, and wearing a correct-looking
// slot — the worst possible failure for a trading screen.
//
// THE SLOT-SKEW PROBLEM, AND WHY THIS IS NOT A NAIVE DIFF
//
//   The obvious harness compares stored rows against a fresh chain scan. It is
//   useless: the two are taken at different slots, so every account someone
//   legitimately traded against shows as a "divergence". A harness that cries
//   wolf on normal activity gets muted, and then it is not a gate at all.
//
//   So the comparison is split into two checks that are each slot-independent:
//
//   1. SELF-CONSISTENCY — the stored decoded columns must equal a fresh decode
//      of the stored raw bytes. This catches shaping, column-order and
//      type-coercion bugs. It needs no network and cannot be confused by state
//      changes, because both sides come from the same bytes.
//
//   2. CHAIN AGREEMENT — for every account whose on-chain bytes are IDENTICAL
//      to the bytes we stored, the stored columns must equal a decode of the
//      chain bytes. Accounts whose bytes differ are counted as CHANGED, not
//      divergent: different bytes at a later slot is what a live chain does.
//
//   What remains after that split is real: same bytes, different answer.
// =============================================================================

import type { DB } from "../db";
import { log } from "../log";
import type { RpcClient } from "../tape/rpc";
import { CHAIN_SPECS, type ChainKind } from "./refresh";
import { discriminatorBase58 } from "./layouts";

export interface DivergenceReport {
  kind: ChainKind;
  checked: number;
  /** Same bytes on chain and in the DB — the comparable population. */
  comparable: number;
  /** Bytes differ: the account moved between slots. Expected, not a fault. */
  changed: number;
  /** On chain but absent from the reflection. */
  missing: number;
  /** In the reflection but no longer on chain (a closed account not swept). */
  orphaned: number;
  /** SAME BYTES, DIFFERENT ANSWER. Any non-zero value here is a bug. */
  divergent: number;
  examples: string[];
}

const isDiv = (r: DivergenceReport): boolean =>
  r.divergent > 0 || r.missing > 0 || r.orphaned > 0;

/** Stored column value vs freshly decoded value, compared as strings so that
 *  SQLite's integer/boolean representation does not masquerade as a mismatch. */
function sameScalar(stored: unknown, fresh: unknown): boolean {
  if (typeof fresh === "boolean") return String(stored === 1 || stored === true) === String(fresh);
  return String(stored) === String(fresh);
}

export async function checkDivergence(
  db: DB,
  rpc: RpcClient,
  programId: string,
  opts: { fetch?: boolean } = {},
): Promise<DivergenceReport[]> {
  const reports: DivergenceReport[] = [];

  for (const spec of CHAIN_SPECS) {
    const rows = db.prepare(`SELECT * FROM ${spec.table}`).all() as any[];
    const byKey = new Map(rows.map((r) => [r.pubkey, r]));
    const rep: DivergenceReport = {
      kind: spec.kind, checked: rows.length, comparable: 0, changed: 0,
      missing: 0, orphaned: 0, divergent: 0, examples: [],
    };

    // ---- Check 1: self-consistency (no network) --------------------------
    for (const r of rows) {
      const fresh = spec.decode(Buffer.from(r.raw_b64, "base64"));
      if (!fresh) {
        rep.divergent += 1;
        if (rep.examples.length < 5) rep.examples.push(`${r.pubkey}: stored bytes no longer decode`);
        continue;
      }
      const vals = spec.values(fresh);
      const cols = spec.columns.filter((c) => c !== "pubkey");
      for (let i = 0; i < cols.length; i++) {
        if (!sameScalar(r[cols[i]], vals[i])) {
          rep.divergent += 1;
          if (rep.examples.length < 5) {
            rep.examples.push(`${r.pubkey}: ${cols[i]} stored=${r[cols[i]]} redecoded=${vals[i]}`);
          }
          break;
        }
      }
    }

    // ---- Check 2: chain agreement ----------------------------------------
    if (opts.fetch !== false) {
      let chain: { context: { slot: number }; value: { pubkey: string; account: { data: [string, string] } }[] };
      try {
        chain = await rpc.call("getProgramAccounts", [
          programId,
          {
            encoding: "base64", commitment: "confirmed", withContext: true,
            filters: [{ memcmp: { offset: 0, bytes: discriminatorBase58(spec.accountName) } }],
          },
        ]);
      } catch (e) {
        log.warn("divergence check could not reach chain", { kind: spec.kind, err: (e as Error).message });
        reports.push(rep);
        continue;
      }

      const onChain = new Set<string>();
      for (const a of chain.value ?? []) {
        const b64 = a.account.data[0];
        const buf = Buffer.from(b64, "base64");
        const decoded = spec.decode(buf);
        // An account we would reject is not expected in the reflection, so its
        // absence is correct rather than missing.
        if (!decoded) continue;
        onChain.add(a.pubkey);

        const stored = byKey.get(a.pubkey);
        if (!stored) {
          rep.missing += 1;
          if (rep.examples.length < 5) rep.examples.push(`${a.pubkey}: on chain, absent from reflection`);
          continue;
        }
        if (stored.raw_b64 !== b64) {
          // Different bytes at a later slot. This is the chain being alive.
          rep.changed += 1;
          continue;
        }
        rep.comparable += 1;
        const vals = spec.values(decoded);
        const cols = spec.columns.filter((c) => c !== "pubkey");
        for (let i = 0; i < cols.length; i++) {
          if (!sameScalar(stored[cols[i]], vals[i])) {
            rep.divergent += 1;
            if (rep.examples.length < 5) {
              rep.examples.push(`${a.pubkey}: ${cols[i]} stored=${stored[cols[i]]} chain=${vals[i]}`);
            }
            break;
          }
        }
      }

      for (const k of byKey.keys()) {
        if (!onChain.has(k)) {
          rep.orphaned += 1;
          if (rep.examples.length < 5) rep.examples.push(`${k}: in reflection, gone from chain`);
        }
      }
    }

    reports.push(rep);
  }

  // SCREAM. A divergence is not a metric to graph later — it means the read path
  // is serving wrong numbers right now, and the FE should be flipped back.
  for (const r of reports) {
    if (isDiv(r)) {
      log.error("CHAIN DIVERGENCE — read path is serving wrong data", {
        kind: r.kind, divergent: r.divergent, missing: r.missing, orphaned: r.orphaned,
        comparable: r.comparable, changed: r.changed, examples: r.examples,
      });
    } else {
      log.info("chain divergence check clean", {
        kind: r.kind, checked: r.checked, comparable: r.comparable, changed: r.changed,
      });
    }
  }
  return reports;
}

export function divergenceClean(reports: DivergenceReport[]): boolean {
  return reports.every((r) => !isDiv(r));
}
