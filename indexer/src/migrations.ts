// =============================================================================
// migrations.ts — explicit, versioned schema migrations
// =============================================================================
//
// The tape is append-only, but it is DERIVED FROM CHAIN — so rebuilding it is
// always safe. It is not a source of truth; the chain is. That is what makes a
// destructive v1 -> v2 migration acceptable where a schema reshape would not be.
//
// v1 -> v2 REBUILDS THE TAPE. Two reasons, both of which make v1 rows unusable:
//
//   1. ID SCHEME (B2). v1 numbered `ordinal` over ALLOWLISTED events only, so
//      growing the allowlist renumbered rows and a re-index wrote duplicates
//      instead of being idempotent. v2 numbers over ALL `Program data:` lines,
//      making the id a property of the chain. v1 and v2 ids are incompatible.
//
//   2. ALLOWLIST (B3). v2 adds 5 events, most importantly
//      VaultPostSettlementWithdraw — the main writer settlement payout path.
//      Without a historical re-walk the PnL identity cannot reconcile.
//
// Cursors are cleared so the backfill re-walks from scratch. Everything else in
// v2 is additive (see schema.ts).
// =============================================================================

import { log } from "./log";
import { SCHEMA_VERSION } from "./schema";
import type { DB } from "./db";

function currentVersion(db: DB): number {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
    | { value: string }
    | undefined;
  return row ? Number(row.value) : 0;
}

/** v1 -> v2. Destructive to the TAPE only; all other data is additive. */
function migrateV1toV2(db: DB): void {
  const before = db.prepare("SELECT COUNT(*) AS n FROM txs").get() as { n: number };
  log.info("migration v1->v2: rebuilding tape", {
    reason: "id-scheme (B2) + allowlist expansion (B3)",
    txsDropped: before.n,
  });

  db.transaction(() => {
    db.exec("DELETE FROM events");
    db.exec("DELETE FROM txs");
    db.exec("DELETE FROM wallets");
    db.exec("DELETE FROM scores");
    db.prepare("DELETE FROM meta WHERE key IN ('cursor_sig','backfill_before','backfill_done')").run();
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version','2') " + "ON CONFLICT(key) DO UPDATE SET value = '2'").run();
  })();

  log.info("migration v1->v2 complete — backfill will re-walk from scratch");
}

/**
 * Bring the DB up to SCHEMA_VERSION. Called after the CREATE TABLE IF NOT EXISTS
 * pass, so v2 tables already exist by the time we get here.
 */
export function migrate(db: DB): void {
  let v = currentVersion(db);
  if (v === 0) {
    // Fresh database — schema.ts already created everything at the current version.
    db.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      String(SCHEMA_VERSION),
    );
    return;
  }
  if (v === 1) {
    migrateV1toV2(db);
    v = 2;
  }
  if (v !== SCHEMA_VERSION) {
    throw new Error(
      `No migration path from schema v${v} to v${SCHEMA_VERSION}. Refusing to run — ` +
        `the tape must never be silently reshaped.`,
    );
  }
}
