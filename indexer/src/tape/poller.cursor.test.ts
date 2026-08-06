// =============================================================================
// poller.cursor.test.ts — the cursor must never advance past un-ingested work.
// =============================================================================
//
// THE STANDING GUARANTEE THE PUBLIC CAMPAIGN RUNS ON: if ingestion is offline
// while events land on chain, the tape must resume from the persisted cursor and
// walk the hole. A skipped signature is a wallet that earned points and never got
// them, and nothing downstream would ever notice — recompute would happily score
// a tape with a hole in it and report success.
//
// THE LATENT DEFECT THIS COVERS (found 2026-08-07, had NOT yet fired):
//
//   Poller.ingest() swallows a failed getTransactionBatch — it logs, counts a
//   fetchFailure, and `continue`s. It never throws. So back in tail():
//
//       for (const page of pages.reverse()) await this.ingest(page, stats);
//       setCursorSig(this.db, newest);          // <-- runs unconditionally
//
//   the cursor advances to `newest` even when every transaction in the window
//   failed to fetch. The next tick asks for everything strictly newer than a
//   cursor that was never actually ingested, and those signatures are gone for
//   good.
//
//   During the 2026-08-06 Helius outage this did NOT fire: getSignaturesForAddress
//   failed first, so tail() threw before reaching ingest and the cursor correctly
//   stayed put. The defect needs the narrower case — signatures fetch fine,
//   transactions do not — which is exactly what a partial provider degradation
//   looks like, and what a per-method credit limit produces.
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { openDb } from "../db";
import { readCursor } from "./cursor";
import { Poller } from "./poller";

const PROGRAM = "CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq";

function tmpDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opta-cursor-"));
  return { db: openDb(path.join(dir, "t.db")), dir };
}

const cfg = {
  programId: PROGRAM,
  batchSize: 10,
  backfillFloorTs: 0,
} as never;

const decoder = { decode: () => [] } as never;

/** Signatures newest-first, as the RPC returns them. */
const sig = (n: number, t: number) => ({ signature: `sig${n}`, blockTime: t, err: null });

test("GUARANTEE: the cursor never advances past transactions that failed to ingest", () => {
  const { db, dir } = tmpDb();

  // Ten signatures land while the transaction endpoint is degraded: signature
  // listing works, getTransactionBatch does not. This is the partial-degradation
  // shape — a per-method credit limit, not a full outage.
  const sigs = Array.from({ length: 10 }, (_, i) => sig(i, 1_780_000_000 + i));

  const rpc = {
    getSignaturesForAddress: async () => sigs,
    getTransactionBatch: async () => {
      throw new Error('503 Service Unavailable: {"code":-32603}');
    },
  } as never;

  const p = new Poller(db, rpc, decoder, cfg);
  return p.tail().then((stats) => {
    // Every transaction failed to fetch.
    assert.equal(stats.txsIndexed, 0, "nothing should have been indexed");
    assert.ok(stats.fetchFailures > 0, "the failures should be counted");

    // THE ASSERTION THAT MATTERS. On the pre-fix code the cursor is `sig0`
    // (pages[0][0]) and those ten signatures can never be reached again.
    const after = readCursor(db).cursorSig;
    assert.equal(
      after,
      null,
      `cursor advanced to ${after} over 10 un-ingested signatures — they are now unreachable`,
    );

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test("GUARANTEE: a PARTIAL ingest does not advance the cursor either", () => {
  const { db, dir } = tmpDb();
  const sigs = Array.from({ length: 20 }, (_, i) => sig(i, 1_780_000_000 + i));

  // First batch succeeds, second throws — the half-written case. Advancing here
  // would strand the second half exactly as a total failure strands all of it.
  let call = 0;
  const rpc = {
    getSignaturesForAddress: async () => sigs,
    getTransactionBatch: async (batch: string[]) => {
      call += 1;
      if (call > 1) throw new Error('503 Service Unavailable: {"code":-32603}');
      return batch.map(() => null); // fetched, but nothing decodable
    },
  } as never;

  const p = new Poller(db, rpc, decoder, cfg);
  return p.tail().then(() => {
    assert.equal(
      readCursor(db).cursorSig,
      null,
      "a partially-failed tick must leave the cursor where it was",
    );
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test("a CLEAN tick still advances the cursor — the fix must not freeze ingestion", () => {
  const { db, dir } = tmpDb();
  const sigs = [sig(2, 1_780_000_002), sig(1, 1_780_000_001), sig(0, 1_780_000_000)];

  const rpc = {
    getSignaturesForAddress: async () => sigs,
    // Return nulls: fetched successfully, simply nothing to decode. That is a
    // healthy tick, not a failure, and it MUST advance.
    getTransactionBatch: async (batch: string[]) => batch.map(() => null),
  } as never;

  const p = new Poller(db, rpc, decoder, cfg);
  return p.tail().then(() => {
    assert.equal(
      readCursor(db).cursorSig,
      "sig2",
      "a clean tick must advance to the newest signature",
    );
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
