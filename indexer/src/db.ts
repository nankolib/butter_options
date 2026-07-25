// =============================================================================
// db.ts — better-sqlite3 open + migrations + prepared statements
// =============================================================================
// In-process SQLite, WAL mode (the opta-tweet house pattern — its data.db-wal
// is live on the box). Single process, single writer, no server.
// =============================================================================

import Database from "better-sqlite3";
import * as fs from "node:fs";
import * as path from "node:path";

import { migrate } from "./migrations";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema";

export type DB = Database.Database;

export interface EventRow {
  id: string;
  sig: string;
  ordinal: number;
  ix_index: number | null;
  source: "log" | "ix";
  name: string;
  wallet: string | null;
  counterparty: string | null;
  vault: string | null;
  option_mint: string | null;
  kind: number | null;
  amount_usdc: number | null;
  quantity: number | null;
  fields_json: string;
  block_time: number | null;
}

export interface TxRow {
  sig: string;
  slot: number;
  block_time: number | null;
  ok: number;
  truncated: number;
}

export function openDb(dbPath: string): DB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.exec(SCHEMA_SQL);

  // Explicit, versioned migration. Never a silent reshape: an unknown version
  // throws rather than guessing.
  migrate(db);

  const after = getMeta(db, "schema_version");
  if (Number(after) !== SCHEMA_VERSION) {
    throw new Error(`Schema version mismatch after migrate: db=${after} code=${SCHEMA_VERSION}.`);
  }
  return db;
}

export function getMeta(db: DB, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function setMeta(db: DB, key: string, value: string): void {
  db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    key,
    value,
  );
}

/**
 * Persist one transaction and its extracted events atomically.
 *
 * INSERT OR IGNORE on both tables: `txs.sig` and `events.id` are deterministic,
 * so re-indexing the same signature is a no-op. This is what makes a mid-backfill
 * kill safe (acceptance criterion: restart resumes, zero dupes).
 */
export function makeWriter(db: DB) {
  const insTx = db.prepare(
    `INSERT OR IGNORE INTO txs (sig, slot, block_time, ok, truncated, indexed_at)
     VALUES (@sig, @slot, @block_time, @ok, @truncated, @indexed_at)`,
  );
  const insEvt = db.prepare(
    `INSERT OR IGNORE INTO events
       (id, sig, ordinal, ix_index, source, name, wallet, counterparty, vault,
        option_mint, kind, amount_usdc, quantity, fields_json, block_time)
     VALUES
       (@id, @sig, @ordinal, @ix_index, @source, @name, @wallet, @counterparty, @vault,
        @option_mint, @kind, @amount_usdc, @quantity, @fields_json, @block_time)`,
  );

  const run = db.transaction((tx: TxRow, events: EventRow[]) => {
    insTx.run({ ...tx, indexed_at: Math.floor(Date.now() / 1000) });
    for (const e of events) insEvt.run(e);
  });

  return (tx: TxRow, events: EventRow[]) => run(tx, events);
}

export function txCount(db: DB): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM txs").get() as { n: number }).n;
}

export function eventCount(db: DB): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n;
}

/**
 * A re-iterable source of tape rows in canonical order.
 *
 * ITEM 0 (Phase 2b). The score layer used to take `EventRow[]`, which meant the
 * whole tape lived in memory during every render — the hourly render peaked at
 * 159-193 MB against a 200 MB cgroup cap, and that number grew with the tape.
 * Passing a FACTORY instead lets each module make as many passes as it needs
 * while holding only bounded state, so memory scales with wallets + vaults
 * rather than with events.
 *
 * Purity is unaffected: the same source yields the same rows in the same order,
 * so every scoring function remains a pure function of its inputs. Tests pass
 * `() => fixtureArray`.
 */
export type TapeSource = () => Iterable<EventRow>;

const TAPE_ORDER_SQL =
  "SELECT * FROM events ORDER BY block_time ASC, sig ASC, ordinal ASC, id ASC";

/**
 * Streaming tape source. A fresh statement per pass: better-sqlite3 refuses to
 * run two concurrent iterations of the SAME statement ("this statement is
 * busy"), and nested passes are legitimate here.
 */
export function streamTape(db: DB): TapeSource {
  return () => db.prepare(TAPE_ORDER_SQL).iterate() as Iterable<EventRow>;
}

/** Materialising loader. Kept for tests and small fixtures ONLY — not for renders. */
export function loadTape(db: DB): EventRow[] {
  // TRUE CHAIN ORDER, and a total order so the SCORE layer is reproducible.
  // NOT `ORDER BY id`: ids are strings, so `<sig>:10` sorts before `<sig>:2`.
  // Ordering by the integer `ordinal` restores real intra-tx sequence, which the
  // position ledger depends on when a buy and an exercise share a transaction.
  // `id` is the final tie-break (a log row and an ix row can share an ordinal).
  return db
    .prepare("SELECT * FROM events ORDER BY block_time ASC, sig ASC, ordinal ASC, id ASC")
    .all() as EventRow[];
}
