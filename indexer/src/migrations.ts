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
/**
 * v2 -> v3. ADDITIVE ONLY — the tape is untouched.
 *
 * The v2 `referrals` table could not hold a code with no referee yet, which the
 * `POST /referral/code` endpoint requires, so it is replaced by
 * `referral_codes` + a reshaped `referrals`. Both were EMPTY in v2 (the write
 * path did not exist), so nothing is lost; the drop is safe by inspection, and
 * the code asserts that rather than assuming it.
 */
function migrateV2toV3(db: DB): void {
  const legacy = db.prepare("SELECT COUNT(*) AS n FROM referrals").get() as { n: number };
  if (legacy.n > 0) {
    throw new Error(
      `v2->v3 expected an empty legacy referrals table but found ${legacy.n} rows. ` +
        `Refusing to drop user data — migrate by hand.`,
    );
  }
  db.transaction(() => {
    // v2 put a UNIQUE index on social_posts.x_handle. That is wrong: the table
    // is one row per TWEET and a handle posts many tweets, so a wallet's SECOND
    // submission would have failed with a constraint error. The 1:1
    // handle<->wallet binding belongs in `wallet_handles`, which v3 adds.
    // Caught by the daily-cap test, which needed three posts from one handle.
    db.exec("DROP INDEX IF EXISTS idx_social_handle");
    db.exec("DROP TABLE IF EXISTS referrals");
    db.exec(`CREATE TABLE referrals (
      referee_wallet  TEXT PRIMARY KEY,
      code            TEXT NOT NULL,
      referrer_wallet TEXT NOT NULL,
      bound_at        INTEGER NOT NULL)`);
    db.exec("CREATE INDEX IF NOT EXISTS idx_ref_referrer ON referrals(referrer_wallet)");
    db.prepare("UPDATE meta SET value = '3' WHERE key = 'schema_version'").run();
  })();
  log.info("migration v2->v3 complete — referral tables reshaped, tape untouched");
}

/**
 * v3 -> v4. Purges POISONED provenance and re-walks it.
 *
 * The v2/v3 token-account resolver guarded on `buf.length < 72`, but an SPL Mint
 * is 82 bytes, so mints were parsed as token accounts with garbage owner/mint
 * fields. The wrapped-SOL mint consequently appeared in wallet_metrics — on the
 * PROFIT BOARD — holding a $10,000 faucet balance.
 *
 * token_accounts is a pure cache and faucet_claims / capital_flows are derived
 * from a mere 45 faucet signatures plus ~15 ATA cursors, so the honest fix is to
 * drop all of it and let the corrected parser rebuild it on the next capital
 * tick. Cheap, bounded, and provably free of the bad rows — as opposed to trying
 * to identify which cached entries were misparsed.
 *
 * The main TAPE (txs/events) is untouched: it never used this resolver.
 */
function migrateV3toV4(db: DB): void {
  const before = db.prepare("SELECT COUNT(*) AS n FROM token_accounts").get() as { n: number };
  const claims = db.prepare("SELECT COUNT(*) AS n FROM faucet_claims").get() as { n: number };
  db.transaction(() => {
    db.exec("DELETE FROM token_accounts");
    db.exec("DELETE FROM faucet_claims");
    db.exec("DELETE FROM capital_flows");
    db.exec("DELETE FROM ata_cursors");
    db.exec("DELETE FROM wallet_metrics");
    db.prepare("DELETE FROM meta WHERE key = 'faucet_cursor_sig'").run();
    db.prepare("UPDATE meta SET value = '4' WHERE key = 'schema_version'").run();
  })();
  log.info("migration v3->v4 complete — provenance purged, will re-walk with the fixed parser", {
    tokenAccountsDropped: before.n,
    faucetClaimsDropped: claims.n,
  });
}

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
  if (v === 2) {
    migrateV2toV3(db);
    v = 3;
  }
  if (v === 3) {
    migrateV3toV4(db);
    v = 4;
  }
  if (v !== SCHEMA_VERSION) {
    throw new Error(
      `No migration path from schema v${v} to v${SCHEMA_VERSION}. Refusing to run — ` +
        `the tape must never be silently reshaped.`,
    );
  }
}
