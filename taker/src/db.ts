// =============================================================================
// db.ts — the taker's own SQLite state (/opt/opta-taker/taker.db)
// =============================================================================
//
// DELIBERATELY SEPARATE from the indexer's points.db. The indexer's database is
// the campaign's system of record and is rebuildable from chain; this one holds
// spend counters that MUST survive a restart and cannot be reconstructed cheaply
// mid-day. Sharing a file would also let a taker bug corrupt the leaderboard.
//
// Every budget number in here is human USDC (not micro), because the caps are
// expressed in dollars and a unit mismatch on a spend counter is the failure
// nobody notices until the float is gone.
// =============================================================================

import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { utcDay } from "./budget";

export const SCHEMA_VERSION = 1;

export type Db = Database.Database;

export function openDb(dbPath: string): Db {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = FULL"); // a lost spend row means a doubled budget
  migrate(db);
  return db;
}

function migrate(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

    -- Per-seller, per-UTC-day spend. The anti-farm limit.
    CREATE TABLE IF NOT EXISTS budget_ledger (
      day         TEXT NOT NULL,
      wallet      TEXT NOT NULL,
      spent_usdc  REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (day, wallet)
    );

    -- Whole-bot daily spend. Catches coordinated sellers and model bugs, which
    -- per-wallet caps cannot see.
    CREATE TABLE IF NOT EXISTS budget_global (
      day         TEXT PRIMARY KEY,
      spent_usdc  REAL NOT NULL DEFAULT 0
    );

    -- Single-row key/value for capital currently at risk. Not derived from
    -- fills: positions settle and resell, and float must fall when they do.
    CREATE TABLE IF NOT EXISTS float_state (k TEXT PRIMARY KEY, v REAL NOT NULL);

    CREATE TABLE IF NOT EXISTS fills (
      sig        TEXT PRIMARY KEY,
      order_pk   TEXT NOT NULL,
      owner      TEXT NOT NULL,
      mint       TEXT NOT NULL,
      qty        INTEGER NOT NULL,
      price      REAL NOT NULL,
      fair       REAL NOT NULL,
      band_bps   INTEGER NOT NULL,
      ts         INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_fills_owner_ts ON fills(owner, ts);

    -- First-sighting clock for the fill delay. Persisted so a restart cannot
    -- re-roll a seller a fresh (or shorter) wait.
    CREATE TABLE IF NOT EXISTS seen_orders (
      order_pk       TEXT PRIMARY KEY,
      first_seen_ts  INTEGER NOT NULL,
      delay_until_ts INTEGER NOT NULL
    );
  `);
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  db.prepare("INSERT OR IGNORE INTO float_state (k, v) VALUES ('float_usdc', 0)").run();
}

// --- reads -------------------------------------------------------------------

export function walletSpentToday(db: Db, wallet: string, nowSecs: number): number {
  const r = db.prepare("SELECT spent_usdc FROM budget_ledger WHERE day = ? AND wallet = ?")
    .get(utcDay(nowSecs), wallet) as { spent_usdc: number } | undefined;
  return r?.spent_usdc ?? 0;
}

export function globalSpentToday(db: Db, nowSecs: number): number {
  const r = db.prepare("SELECT spent_usdc FROM budget_global WHERE day = ?")
    .get(utcDay(nowSecs)) as { spent_usdc: number } | undefined;
  return r?.spent_usdc ?? 0;
}

export function readFloat(db: Db): number {
  const r = db.prepare("SELECT v FROM float_state WHERE k = 'float_usdc'").get() as { v: number } | undefined;
  return r?.v ?? 0;
}

/**
 * First sighting of an order, and the instant it becomes fillable. Written on
 * first sight and never updated — see the restart note above.
 */
export function seeOrder(db: Db, orderPk: string, nowSecs: number, delaySecs: number): number {
  const row = db.prepare("SELECT delay_until_ts FROM seen_orders WHERE order_pk = ?")
    .get(orderPk) as { delay_until_ts: number } | undefined;
  if (row) return row.delay_until_ts;
  const until = nowSecs + delaySecs;
  db.prepare("INSERT INTO seen_orders (order_pk, first_seen_ts, delay_until_ts) VALUES (?, ?, ?)")
    .run(orderPk, nowSecs, until);
  return until;
}

// --- writes ------------------------------------------------------------------

/**
 * Record a fill and move all three counters. ONE transaction: a fill that lands
 * on chain but only half-lands in the ledger under-counts spend, and the next
 * tick then believes it has budget it already used.
 */
export function recordFill(
  db: Db,
  f: { sig: string; orderPk: string; owner: string; mint: string; qty: number; price: number; fair: number; bandBps: number; ts: number },
): void {
  const day = utcDay(f.ts);
  const cost = f.qty * f.price;
  db.transaction(() => {
    db.prepare(`INSERT OR IGNORE INTO fills (sig, order_pk, owner, mint, qty, price, fair, band_bps, ts)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(f.sig, f.orderPk, f.owner, f.mint, f.qty, f.price, f.fair, f.bandBps, f.ts);
    db.prepare(`INSERT INTO budget_ledger (day, wallet, spent_usdc) VALUES (?, ?, ?)
                ON CONFLICT(day, wallet) DO UPDATE SET spent_usdc = spent_usdc + excluded.spent_usdc`)
      .run(day, f.owner, cost);
    db.prepare(`INSERT INTO budget_global (day, spent_usdc) VALUES (?, ?)
                ON CONFLICT(day) DO UPDATE SET spent_usdc = spent_usdc + excluded.spent_usdc`)
      .run(day, cost);
    db.prepare("UPDATE float_state SET v = MAX(0, v + ?) WHERE k = 'float_usdc'").run(cost);
  })();
}

/** Lower the float when capital comes back (settlement, exercise, resale). */
export function releaseFloat(db: Db, recoveredUsdc: number): void {
  db.prepare("UPDATE float_state SET v = MAX(0, v - ?) WHERE k = 'float_usdc'").run(recoveredUsdc);
}

/** Drop sighting rows for orders that no longer rest. Keeps the table bounded. */
export function pruneSeen(db: Db, liveOrderPks: Set<string>, nowSecs: number): number {
  // Only prune rows older than a day — an order missing from ONE scan (RPC
  // hiccup, pagination) must not reset its delay clock on the next tick.
  const stale = db.prepare("SELECT order_pk FROM seen_orders WHERE first_seen_ts < ?")
    .all(nowSecs - 86_400) as { order_pk: string }[];
  const gone = stale.filter((r) => !liveOrderPks.has(r.order_pk));
  const del = db.prepare("DELETE FROM seen_orders WHERE order_pk = ?");
  db.transaction(() => { for (const r of gone) del.run(r.order_pk); })();
  return gone.length;
}
