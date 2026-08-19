// =============================================================================
// chain/handlers.ts — read-only endpoints for the FE chain read path
// =============================================================================
//
// Serves the reflection tables written by chain/refresh.ts. Read-only, GET-only,
// unauthenticated: every byte here is public on chain already, and requiring a
// credential to read public state would only add a failure mode.
//
// EVERY RESPONSE IS SLOT-STAMPED. `slot` is the slot the scan was taken at and
// `ageSec` is how long ago. The client is expected to USE these — the read path
// falls back to a direct chain read when the data is too old, which is only
// possible if staleness is visible. A response that omits its own freshness
// forces the client to guess, and clients guess optimistically.
//
// NOT SERVED, DELIBERATELY: the book, positions, balances, settlement records.
// The rule is not size, it is what a stale answer costs. See schema.ts.
// =============================================================================

import type { DB } from "../db";
import type { ApiResponse } from "../api/handlers";
import type { ChainKind } from "./refresh";

/** Beyond this the FE should stop trusting us and read chain directly. Chosen
 *  against the 30s SharedVault cadence: three missed refreshes is a fault, not
 *  jitter. */
export const STALE_AFTER_SEC = 90;

interface MetaRow {
  kind: string;
  slot: number;
  refreshed_at: number;
  fetched: number;
  stored: number;
  rejected: number;
  rejected_json: string;
  last_error: string | null;
}

function metaFor(db: DB, kind: ChainKind): MetaRow | undefined {
  return db.prepare("SELECT * FROM chain_refresh_meta WHERE kind = ?").get(kind) as MetaRow | undefined;
}

function envelope(db: DB, kind: ChainKind, rows: unknown[], now: number) {
  const m = metaFor(db, kind);
  const refreshedAt = m?.refreshed_at ?? 0;
  const ageSec = refreshedAt > 0 ? now - refreshedAt : -1;
  return {
    slot: m?.slot ?? 0,
    refreshedAt,
    ageSec,
    // The server states its own opinion of freshness so every client applies the
    // same threshold rather than each inventing one.
    stale: ageSec < 0 || ageSec > STALE_AFTER_SEC,
    count: rows.length,
    rejected: m?.rejected ?? 0,
    rows,
  };
}

const num = (v: string | null, dflt: number, max: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(n, max) : dflt;
};

// ---------------------------------------------------------------------------
// Collections
// ---------------------------------------------------------------------------

/**
 * Hard ceiling on ?keys=. A URL is not a request body: past a few hundred keys
 * the query string starts running into proxy limits, and an unbounded IN(...)
 * is a trivially abusable read amplifier on a public endpoint.
 *
 * Over the cap the endpoint does NOT silently truncate — a truncated board is
 * indistinguishable from a small one. It returns 400 so the caller falls back to
 * a path that can answer completely.
 */
export const MAX_VAULT_KEYS = 200;

export function getChainVaults(db: DB, params: URLSearchParams, now = Math.floor(Date.now() / 1000)): ApiResponse {
  // `keys` serves the positions dock: it holds a handful of vaults and needed
  // ALL 4,655 to describe them, because "which vaults back my positions" is
  // answerable only by the wallet. Fetching exactly those is the whole point.
  const keysRaw = params.get("keys");
  if (keysRaw != null) {
    const keys = keysRaw.split(",").map((k) => k.trim()).filter(Boolean);
    if (keys.length === 0) {
      return { status: 200, body: envelope(db, "sharedVault", [], now) };
    }
    if (keys.length > MAX_VAULT_KEYS) {
      return { status: 400, body: { error: "too_many_keys", max: MAX_VAULT_KEYS } };
    }
    const rows = db.prepare(
      `SELECT * FROM chain_shared_vaults WHERE pubkey IN (${keys.map(() => "?").join(",")})`,
    ).all(...keys);
    return { status: 200, body: envelope(db, "sharedVault", rows.map(shapeVault), now) };
  }

  // `market` narrows to one board, which is what the trade page actually needs;
  // the unfiltered form stays available because the markets page spans all of
  // them. Both are served from the same rows.
  const market = params.get("market");
  const limit = num(params.get("limit"), 20_000, 20_000);
  const rows = market
    ? db.prepare(
        `SELECT * FROM chain_shared_vaults WHERE market = ? ORDER BY expiry ASC, strike_price ASC LIMIT ?`,
      ).all(market, limit)
    : db.prepare(
        `SELECT * FROM chain_shared_vaults ORDER BY expiry ASC, strike_price ASC LIMIT ?`,
      ).all(limit);
  return { status: 200, body: envelope(db, "sharedVault", rows.map(shapeVault), now) };
}

export function getChainSeries(db: DB, params: URLSearchParams, now = Math.floor(Date.now() / 1000)): ApiResponse {
  const vault = params.get("vault");
  // `market` matters more than it looks. Unfiltered, this collection is 485 KB
  // gzipped and would dominate the whole read path — larger than every other
  // endpoint combined. The trade page only ever needs the series belonging to
  // the board on screen, so it joins through the vault rather than shipping the
  // other 33 markets to every visitor.
  const market = params.get("market");
  const limit = num(params.get("limit"), 20_000, 20_000);
  let rows: unknown[];
  if (vault) {
    rows = db.prepare(`SELECT * FROM chain_vault_mints WHERE vault = ? LIMIT ?`).all(vault, limit);
  } else if (market) {
    rows = db.prepare(
      `SELECT m.* FROM chain_vault_mints m
       JOIN chain_shared_vaults v ON v.pubkey = m.vault
       WHERE v.market = ? LIMIT ?`,
    ).all(market, limit);
  } else {
    rows = db.prepare(`SELECT * FROM chain_vault_mints LIMIT ?`).all(limit);
  }
  return { status: 200, body: envelope(db, "vaultMint", rows.map(shapeMint), now) };
}

export function getChainMarkets(db: DB, _params: URLSearchParams, now = Math.floor(Date.now() / 1000)): ApiResponse {
  // Each market carries its LIVE vault count.
  //
  // Without this the client is stuck: it wants to fetch only the board on
  // screen, but the list of boards WORTH SHOWING is "assets with at least one
  // unexpired vault" — which previously required pulling all 4,655 vaults just
  // to discover which 34 markets have any. That is the whole cost being
  // removed, paid to decide what not to pay for.
  //
  // Counting here is cheap (an indexed group-by over local SQLite) and adds a
  // few bytes to a 7KB response, so the client can pick a board and then fetch
  // exactly that board.
  const rows = db.prepare(
    `SELECT m.*,
            (SELECT COUNT(*) FROM chain_shared_vaults v WHERE v.market = m.pubkey) AS vault_count,
            (SELECT COUNT(*) FROM chain_shared_vaults v
              WHERE v.market = m.pubkey AND CAST(v.expiry AS INTEGER) > ?) AS live_vault_count
       FROM chain_options_markets m
      ORDER BY m.asset_name ASC`,
  ).all(now);
  return { status: 200, body: envelope(db, "optionsMarket", rows.map(shapeMarket), now) };
}

export function getChainEpochs(db: DB, _params: URLSearchParams, now = Math.floor(Date.now() / 1000)): ApiResponse {
  const rows = db.prepare(`SELECT * FROM chain_epoch_configs`).all();
  return { status: 200, body: envelope(db, "epochConfig", rows.map(shapeEpoch), now) };
}

// ---------------------------------------------------------------------------
// /meta — the freshness and lineage contract
// ---------------------------------------------------------------------------

export function getChainMeta(
  db: DB,
  lineage: { programId: string; deploySlot: number | null },
  now = Math.floor(Date.now() / 1000),
): ApiResponse {
  const kinds: ChainKind[] = ["sharedVault", "vaultMint", "optionsMarket", "epochConfig"];
  const per: Record<string, unknown> = {};
  let healthy = true;
  let oldest = 0;

  for (const k of kinds) {
    const m = metaFor(db, k);
    const age = m?.refreshed_at ? now - m.refreshed_at : -1;
    const stale = age < 0 || age > STALE_AFTER_SEC;
    if (stale || m?.last_error) healthy = false;
    if (age > oldest) oldest = age;
    per[k] = {
      slot: m?.slot ?? 0,
      refreshedAt: m?.refreshed_at ?? 0,
      ageSec: age,
      stale,
      fetched: m?.fetched ?? 0,
      stored: m?.stored ?? 0,
      // NEVER SILENT, surfaced rather than buried in a log line nobody reads.
      rejected: m?.rejected ?? 0,
      rejectedBySize: m?.rejected_json ? JSON.parse(m.rejected_json) : {},
      lastError: m?.last_error ?? null,
    };
  }

  return {
    status: 200,
    body: {
      healthy,
      oldestAgeSec: oldest,
      staleAfterSec: STALE_AFTER_SEC,
      // LINEAGE. The FE keys its client-side cache on this: a program upgrade
      // can change an account layout, and a cached decode from the previous
      // layout is not stale, it is garbage that renders as a plausible number.
      // Changing lineage must invalidate everything the client holds.
      lineage: {
        programId: lineage.programId,
        deploySlot: lineage.deploySlot,
        key: `${lineage.programId}:${lineage.deploySlot ?? "unknown"}`,
      },
      kinds: per,
    },
  };
}

// ---------------------------------------------------------------------------
// Row shaping — DB snake_case to the camelCase the FE decoders already speak
// ---------------------------------------------------------------------------
//
// raw_b64 is deliberately NOT served. It exists so the indexer can re-decode
// after a layout change without re-scanning; shipping it would multiply payload
// size by the exact factor this whole read path exists to remove.

const shapeVault = (r: any) => ({
  publicKey: r.pubkey,
  market: r.market,
  optionType: r.option_type,
  strikePrice: r.strike_price,
  expiry: r.expiry,
  vaultType: r.vault_type,
  totalCollateral: r.total_collateral,
  totalShares: r.total_shares,
  vaultUsdcAccount: r.vault_usdc_account,
  collateralMint: r.collateral_mint,
  totalOptionsMinted: r.total_options_minted,
  totalOptionsSold: r.total_options_sold,
  netPremiumCollected: r.net_premium_collected,
  premiumPerShareCumulative: r.premium_per_share_cumulative,
  isSettled: r.is_settled === 1,
  settlementPrice: r.settlement_price,
  collateralRemaining: r.collateral_remaining,
  creator: r.creator,
  createdAt: r.created_at,
  bump: r.bump,
  carryRateBps: r.carry_rate_bps,
  exerciseStyle: r.exercise_style,
  exercisedOptions: r.exercised_options,
  earlyExercisePayout: r.early_exercise_payout,
  spreadBps: r.spread_bps,
  voided: r.voided === 1,
  writerAskCollateralSwept: r.writer_ask_collateral_swept,
  writerAskEquivShares: r.writer_ask_equiv_shares,
});

const shapeMint = (r: any) => ({
  publicKey: r.pubkey,
  vault: r.vault,
  writer: r.writer,
  optionMint: r.option_mint,
  premiumPerContract: r.premium_per_contract,
  quantityMinted: r.quantity_minted,
  quantitySold: r.quantity_sold,
  createdAt: r.created_at,
  bump: r.bump,
});

const shapeMarket = (r: any) => ({
  publicKey: r.pubkey,
  assetName: r.asset_name,
  pythFeedId: r.pyth_feed_id,
  assetClass: r.asset_class,
  bump: r.bump,
  oracleSource: r.oracle_source,
  // Counts are indexer-only metadata, NOT part of the on-chain account. They are
  // additive, so a consumer rehydrating an OptionsMarket ignores them and its
  // shape still matches Anchor exactly (the fidelity check asserts that).
  vaultCount: r.vault_count ?? undefined,
  liveVaultCount: r.live_vault_count ?? undefined,
});

const shapeEpoch = (r: any) => ({
  publicKey: r.pubkey,
  authority: r.authority,
  weeklyExpiryDay: r.weekly_expiry_day,
  weeklyExpiryHour: r.weekly_expiry_hour,
  monthlyEnabled: r.monthly_enabled === 1,
  minEpochDurationDays: r.min_epoch_duration_days,
  bump: r.bump,
});
