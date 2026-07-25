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
 */
export function rebuildWallets(db: DB): void {
  const rows = db
    .prepare(
      `SELECT pubkey, MIN(bt) AS first_seen, MAX(bt) AS last_seen FROM (
         SELECT wallet       AS pubkey, block_time AS bt FROM events WHERE wallet       IS NOT NULL
         UNION ALL
         SELECT counterparty AS pubkey, block_time AS bt FROM events WHERE counterparty IS NOT NULL
       ) GROUP BY pubkey`,
    )
    .all() as { pubkey: string; first_seen: number | null; last_seen: number | null }[];

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
