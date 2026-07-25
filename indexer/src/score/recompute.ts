// =============================================================================
// recompute.ts — rebuild the PROJECTION + SCORE layers from the tape
// =============================================================================
// Both are fully derived. Dropping and rebuilding them is always safe; the tape
// is never touched.
// =============================================================================

import { loadTape, type DB } from "../db";
import { INTERNAL_WALLETS, isInternal, labelFor } from "../registry";
import { DEFAULT_RULES, RULES_VERSION, score, type RulesConfig, type ScoreResult } from "./rules_v1";

/**
 * Rebuild `wallets` from the tape + registry.ts (D2: classification lives here,
 * never on the immutable tape, so changing the registry needs no re-index).
 *
 * PDA EXCLUSION. `counterparty` is harvested alongside `wallet`, and on a
 * VaultPeg fill (kind == 3) the maker is the SharedVault PDA, not a person
 * (events.rs:296-304). The D3 rule already denies those points, but without
 * this filter they would still be COUNTED as unique external wallets and
 * inflate the campaign's headline metric. Any pubkey that appears in
 * `events.vault` is a program account by construction and is excluded here —
 * a broader and more durable test than special-casing kind == 3.
 */
export function rebuildWallets(db: DB): void {
  const vaultSet = new Set(
    (db.prepare("SELECT DISTINCT vault AS v FROM events WHERE vault IS NOT NULL").all() as { v: string }[]).map(
      (r) => r.v,
    ),
  );

  const rows = (
    db
      .prepare(
        `SELECT pubkey, MIN(bt) AS first_seen, MAX(bt) AS last_seen FROM (
         SELECT wallet       AS pubkey, block_time AS bt FROM events WHERE wallet       IS NOT NULL
         UNION ALL
         SELECT counterparty AS pubkey, block_time AS bt FROM events WHERE counterparty IS NOT NULL
       ) GROUP BY pubkey`,
      )
      .all() as { pubkey: string; first_seen: number | null; last_seen: number | null }[]
  ).filter((r) => !vaultSet.has(r.pubkey));

  // The projection is rebuildable: drop any PDA a previous (pre-filter) run left.
  const dropPda = db.prepare("DELETE FROM wallets WHERE pubkey = ?");
  db.transaction(() => {
    for (const v of vaultSet) dropPda.run(v);
  })();

  const upsert = db.prepare(
    `INSERT INTO wallets (pubkey, is_internal, label, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(pubkey) DO UPDATE SET
       is_internal = excluded.is_internal,
       label       = excluded.label,
       first_seen  = excluded.first_seen,
       last_seen   = excluded.last_seen`,
  );

  db.transaction(() => {
    for (const r of rows) {
      upsert.run(r.pubkey, isInternal(r.pubkey) ? 1 : 0, labelFor(r.pubkey), r.first_seen, r.last_seen);
    }
    // Registry wallets that have not appeared on the tape yet still get a row,
    // so the internal set is always fully represented.
    for (const w of INTERNAL_WALLETS) {
      upsert.run(w.pubkey, 1, w.label, null, null);
    }
  })();
}

export interface RecomputeResult extends ScoreResult {
  externalCount: number;
  internalCount: number;
}

/** Full recompute. `asOf` is injected — rules_v1 never reads the clock. */
export function recompute(db: DB, asOf: number, cfg: RulesConfig = DEFAULT_RULES): RecomputeResult {
  rebuildWallets(db);

  const tape = loadTape(db);
  const result = score(tape, cfg, asOf);

  const ins = db.prepare(
    `INSERT INTO scores (rules_version, wallet, points, points_capped, breakdown_json, computed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(rules_version, wallet) DO UPDATE SET
       points         = excluded.points,
       points_capped  = excluded.points_capped,
       breakdown_json = excluded.breakdown_json,
       computed_at    = excluded.computed_at`,
  );

  db.transaction(() => {
    db.prepare("DELETE FROM scores WHERE rules_version = ?").run(RULES_VERSION);
    for (const s of result.scores) {
      ins.run(RULES_VERSION, s.wallet, s.points, s.pointsCapped, JSON.stringify(s.breakdown), asOf);
    }
  })();

  let externalCount = 0;
  let internalCount = 0;
  for (const s of result.scores) {
    if (isInternal(s.wallet)) internalCount += 1;
    else externalCount += 1;
  }

  return { ...result, externalCount, internalCount };
}
