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

export const SCHEMA_VERSION = 5;

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

-- ============ v2 TAPE — capital provenance (Part A) ============
-- Independently sourced (faucet wallet + per-ATA cursors), so these are tape,
-- not projections: they record transfers that happened, and are append-only.
CREATE TABLE IF NOT EXISTS faucet_claims (
  sig        TEXT PRIMARY KEY,
  wallet     TEXT NOT NULL,
  kind       TEXT NOT NULL,          -- 'usdc' | 'sol'
  amount     INTEGER NOT NULL,       -- micro-USDC, or lamports for kind='sol'
  block_time INTEGER
);
CREATE INDEX IF NOT EXISTS idx_fc_wallet ON faucet_claims(wallet, block_time);

CREATE TABLE IF NOT EXISTS capital_flows (
  id           TEXT PRIMARY KEY,     -- <sig>:<ordinal>
  wallet       TEXT NOT NULL,
  direction    TEXT NOT NULL,        -- 'in' | 'out'
  source       TEXT NOT NULL,        -- 'faucet' | 'external'
  amount_usdc  INTEGER NOT NULL,
  counterparty TEXT,
  block_time   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_cf_wallet ON capital_flows(wallet, block_time);

-- token account -> owner cache. A transfer names ATAs, not wallets; resolving
-- the owner needs a chain read, so it is cached (immutable once created).
CREATE TABLE IF NOT EXISTS token_accounts (
  ata      TEXT PRIMARY KEY,
  owner    TEXT NOT NULL,
  mint     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ta_owner ON token_accounts(owner, mint);

-- Is this pubkey a real WALLET, or a program/mint/PDA that merely happens to
-- own a token account? A user wallet is owned by the System Program (or does
-- not exist on chain yet). Anything else -- a mint, a PDA, a token account --
-- is not a person and must never reach a leaderboard.
--
-- This exists because a REAL USDC token account was found whose on-chain owner
-- field is the wrapped-SOL MINT address. Nothing was misparsed; someone simply
-- created an account that way and the faucet paid it. No amount of length
-- checking catches that -- only asking the chain what the owner actually is.
CREATE TABLE IF NOT EXISTS account_kinds (
  pubkey     TEXT PRIMARY KEY,
  is_wallet  INTEGER NOT NULL,
  checked_at INTEGER NOT NULL
);

-- Per-ATA cursor for the Part A external-flow loop (D9: eligible wallets only).
CREATE TABLE IF NOT EXISTS ata_cursors (
  ata        TEXT PRIMARY KEY,
  wallet     TEXT NOT NULL,
  cursor_sig TEXT,
  updated_at INTEGER
);

-- ============ v2 REFERENCE (rebuildable from chain) ============
-- market -> underlying, for quest W3. Refreshed by gPA, not by the tape.
CREATE TABLE IF NOT EXISTS markets (
  pubkey      TEXT PRIMARY KEY,
  asset_name  TEXT NOT NULL,
  asset_class INTEGER NOT NULL,      -- 0 Crypto 1 Commodity 2 Equity 3 FX 4 ETF
  refreshed_at INTEGER
);

-- ============ v3 WRITE-PATH TABLES (Phase 2b) ===============================
-- A code must be able to exist BEFORE anyone binds to it, which the v2 shape
-- (referee_wallet NOT NULL UNIQUE) could not express. Split in two.
CREATE TABLE IF NOT EXISTS referral_codes (
  code       TEXT PRIMARY KEY,
  wallet     TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- One row per REFEREE (a wallet can be referred exactly once).
-- NOTE: there is deliberately no activated_at column. Activation is "the
-- referee completed O3", which the tape already knows; storing it would create
-- a second source of truth that a recompute could contradict.
CREATE TABLE IF NOT EXISTS referrals (
  referee_wallet  TEXT PRIMARY KEY,
  code            TEXT NOT NULL,
  referrer_wallet TEXT NOT NULL,
  bound_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ref_referrer ON referrals(referrer_wallet);

-- X handle <-> wallet, 1:1 in BOTH directions (PK on one, UNIQUE on the other).
CREATE TABLE IF NOT EXISTS wallet_handles (
  wallet   TEXT PRIMARY KEY,
  x_handle TEXT NOT NULL UNIQUE,
  bound_at INTEGER NOT NULL
);

-- Signed-request replay protection.
CREATE TABLE IF NOT EXISTS nonces (
  nonce      TEXT PRIMARY KEY,
  wallet     TEXT NOT NULL,
  action     TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_nonce_exp ON nonces(expires_at);

-- Per-wallet, per-action write cooldown (on top of nginx limit_req).
CREATE TABLE IF NOT EXISTS write_cooldowns (
  wallet  TEXT NOT NULL,
  action  TEXT NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (wallet, action)
);

-- One row PER TWEET. x_handle is deliberately NOT unique here: a handle posts
-- many tweets. The 1:1 handle<->wallet binding lives in wallet_handles.
-- v2 had a UNIQUE index here, which made a wallet second post fail; the
-- v2->v3 migration drops it.
CREATE TABLE IF NOT EXISTS social_posts (
  tweet_id    TEXT PRIMARY KEY,
  wallet      TEXT NOT NULL,
  x_handle    TEXT NOT NULL,
  verified_at INTEGER,
  points      REAL
);
CREATE INDEX IF NOT EXISTS idx_social_wallet ON social_posts(wallet, verified_at);

CREATE TABLE IF NOT EXISTS bounty_submissions (
  id        TEXT PRIMARY KEY,
  wallet    TEXT NOT NULL,
  kind      TEXT NOT NULL,
  proof_url TEXT,
  status    TEXT NOT NULL,           -- 'pending' | 'approved' | 'rejected'
  points    REAL
);

-- ============ v2 SCORE PROJECTIONS (dropped + rebuilt every recompute) ======
CREATE TABLE IF NOT EXISTS wallet_metrics (
  wallet          TEXT PRIMARY KEY,
  faucet_in       INTEGER NOT NULL,
  external_in     INTEGER NOT NULL,
  external_out    INTEGER NOT NULL,
  pct_faucet      REAL,
  usdc_in         INTEGER NOT NULL,
  usdc_out        INTEGER NOT NULL,
  deployed        INTEGER NOT NULL,
  realized_pnl    INTEGER NOT NULL,
  roi             REAL,
  volume_usdc     INTEGER NOT NULL,
  writer_premium  INTEGER NOT NULL,
  profit_eligible INTEGER NOT NULL,
  ineligible_reason TEXT
);

CREATE TABLE IF NOT EXISTS quest_completions (
  quests_version TEXT NOT NULL,
  wallet         TEXT NOT NULL,
  quest_id       TEXT NOT NULL,
  period_key     TEXT NOT NULL,      -- '' one-time | 'YYYY-MM-DD' | 'YYYY-Www'
  completed_at   INTEGER NOT NULL,
  points         REAL NOT NULL,
  PRIMARY KEY (quests_version, wallet, quest_id, period_key)
);

CREATE TABLE IF NOT EXISTS streak_state (
  wallet            TEXT PRIMARY KEY,
  current_streak    INTEGER NOT NULL,
  longest_streak    INTEGER NOT NULL,
  shields_banked    INTEGER NOT NULL,
  shields_consumed  INTEGER NOT NULL,
  multiplier        REAL NOT NULL,
  last_active_day   TEXT
);

CREATE TABLE IF NOT EXISTS shield_events (
  wallet   TEXT NOT NULL,
  day      TEXT NOT NULL,
  action   TEXT NOT NULL,            -- 'earned' | 'consumed'
  PRIMARY KEY (wallet, day, action)
);
`;
