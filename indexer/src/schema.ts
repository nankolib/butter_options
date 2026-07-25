// =============================================================================
// schema.ts — DDL, versioned. Kept as a TS template string (not a .sql file) so
// `dist/` is self-contained without a copy step.
// =============================================================================
//
// THREE LAYERS, strictly separated:
//   TAPE       (txs, events)  — immutable indexed facts. Append-only. NEVER
//                               rewritten. INSERT OR IGNORE keyed on
//                               deterministic PKs, so re-indexing is idempotent.
//   PROJECTION (wallets)      — rebuildable classification. Safe to UPDATE.
//   SCORE      (scores)       — pure recomputable function over the tape,
//                               keyed by rules_version so old runs survive.
// =============================================================================

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
-- ============ META ============
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ============ TAPE (append-only, NEVER rewritten) ============
CREATE TABLE IF NOT EXISTS txs (
  sig        TEXT PRIMARY KEY,
  slot       INTEGER NOT NULL,
  block_time INTEGER,
  ok         INTEGER NOT NULL,
  truncated  INTEGER NOT NULL DEFAULT 0,
  indexed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_txs_slot ON txs(slot);
CREATE INDEX IF NOT EXISTS idx_txs_time ON txs(block_time);

CREATE TABLE IF NOT EXISTS events (
  id           TEXT PRIMARY KEY,
  sig          TEXT NOT NULL,
  ordinal      INTEGER NOT NULL,
  ix_index     INTEGER,
  source       TEXT NOT NULL,
  name         TEXT NOT NULL,
  wallet       TEXT,
  counterparty TEXT,
  vault        TEXT,
  option_mint  TEXT,
  kind         INTEGER,
  amount_usdc  INTEGER,
  quantity     INTEGER,
  fields_json  TEXT NOT NULL,
  block_time   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_evt_wallet_time ON events(wallet, block_time);
CREATE INDEX IF NOT EXISTS idx_evt_name_time   ON events(name, block_time);
CREATE INDEX IF NOT EXISTS idx_evt_cparty_time ON events(counterparty, block_time);
CREATE INDEX IF NOT EXISTS idx_evt_mint_time   ON events(option_mint, block_time);
CREATE INDEX IF NOT EXISTS idx_evt_vault       ON events(vault);

-- ============ PROJECTION (rebuildable, NOT tape) ============
CREATE TABLE IF NOT EXISTS wallets (
  pubkey      TEXT PRIMARY KEY,
  is_internal INTEGER NOT NULL,
  label       TEXT,
  first_seen  INTEGER,
  last_seen   INTEGER
);

-- ============ SCORE (fully recomputable, versioned) ============
CREATE TABLE IF NOT EXISTS scores (
  rules_version  TEXT NOT NULL,
  wallet         TEXT NOT NULL,
  points         REAL NOT NULL,
  points_capped  REAL NOT NULL,
  breakdown_json TEXT NOT NULL,
  computed_at    INTEGER NOT NULL,
  PRIMARY KEY (rules_version, wallet)
);
`;
