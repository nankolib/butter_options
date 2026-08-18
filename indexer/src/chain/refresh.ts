// =============================================================================
// chain/refresh.ts — scan on-chain structural accounts into the reflection tables
// =============================================================================
//
// One gPA per account kind, decoded with the exact-length/range-gated decoders
// in layouts.ts, written into `chain_*` tables. This is the ingestion half of
// the read path: the API half serves what this stores.
//
// THREE PROPERTIES THAT MATTER MORE THAN SPEED
//
//   1. SLOT-STAMPED. Every scan records the slot it was taken at
//      (`withContext: true`), and that slot travels with the data all the way to
//      the browser. A client that cannot see how stale something is cannot
//      reason about it, and "looks recent" is not a freshness guarantee.
//
//   2. DELETIONS ARE APPLIED. Accounts get CLOSED — a cancelled trigger, a
//      swept vault. An upsert-only refresh would keep serving them forever, so
//      the reflection would silently accumulate contracts that no longer exist.
//      Each refresh removes rows whose pubkey was absent from the scan.
//
//   3. NEVER SILENT. Legacy layouts share the discriminator and decode as
//      garbage (measured: 433 of 467 OptionsMarket accounts on devnet are
//      pre-migration, and Anchor itself decodes them without error into
//      assetClass=106). They are refused and COUNTED, and the count is served
//      through /api/chain/meta. Policy carried over verbatim from
//      tape/marketsRefresh.ts.
//
// A FAILED SCAN KEEPS THE PREVIOUS DATA. Serving slightly older rows with an
// honest slot beats serving nothing: the FE's degraded mode is "chain-direct,
// as slow as before", never a blank page.
// =============================================================================

import type { DB } from "../db";
import { log } from "../log";
import type { RpcClient } from "../tape/rpc";
import {
  decodeEpochConfig, decodeOptionsMarket, decodeSharedVault, decodeVaultMint,
  discriminatorBase58,
} from "./layouts";

export type ChainKind = "sharedVault" | "vaultMint" | "optionsMarket" | "epochConfig";

interface RawAccount {
  pubkey: string;
  account: { data: [string, string] };
}

interface GpaContext {
  context: { slot: number };
  value: RawAccount[];
}

interface KindSpec {
  kind: ChainKind;
  accountName: string;
  table: string;
  columns: string[];
  decode: (b: Buffer) => Record<string, unknown> | null;
  /** Ordered getters matching `columns`, minus the trailing bookkeeping ones. */
  values: (d: any) => unknown[];
}

const SPECS: KindSpec[] = [
  {
    kind: "sharedVault",
    accountName: "SharedVault",
    table: "chain_shared_vaults",
    columns: [
      "pubkey", "market", "option_type", "strike_price", "expiry", "vault_type",
      "total_collateral", "total_shares", "vault_usdc_account", "collateral_mint",
      "total_options_minted", "total_options_sold", "net_premium_collected",
      "premium_per_share_cumulative", "is_settled", "settlement_price",
      "collateral_remaining", "creator", "created_at", "bump", "carry_rate_bps",
      "exercise_style", "exercised_options", "early_exercise_payout", "spread_bps",
      "voided", "writer_ask_collateral_swept", "writer_ask_equiv_shares",
    ],
    decode: decodeSharedVault as any,
    values: (d) => [
      d.market, d.optionType, d.strikePrice, d.expiry, d.vaultType,
      d.totalCollateral, d.totalShares, d.vaultUsdcAccount, d.collateralMint,
      d.totalOptionsMinted, d.totalOptionsSold, d.netPremiumCollected,
      d.premiumPerShareCumulative, d.isSettled ? 1 : 0, d.settlementPrice,
      d.collateralRemaining, d.creator, d.createdAt, d.bump, d.carryRateBps,
      d.exerciseStyle, d.exercisedOptions, d.earlyExercisePayout, d.spreadBps,
      d.voided ? 1 : 0, d.writerAskCollateralSwept, d.writerAskEquivShares,
    ],
  },
  {
    kind: "vaultMint",
    accountName: "VaultMint",
    table: "chain_vault_mints",
    columns: [
      "pubkey", "vault", "writer", "option_mint", "premium_per_contract",
      "quantity_minted", "quantity_sold", "created_at", "bump",
    ],
    decode: decodeVaultMint as any,
    values: (d) => [
      d.vault, d.writer, d.optionMint, d.premiumPerContract,
      d.quantityMinted, d.quantitySold, d.createdAt, d.bump,
    ],
  },
  {
    kind: "optionsMarket",
    accountName: "OptionsMarket",
    table: "chain_options_markets",
    columns: ["pubkey", "asset_name", "pyth_feed_id", "asset_class", "bump", "oracle_source"],
    decode: decodeOptionsMarket as any,
    values: (d) => [d.assetName, d.pythFeedId, d.assetClass, d.bump, d.oracleSource],
  },
  {
    kind: "epochConfig",
    accountName: "EpochConfig",
    table: "chain_epoch_configs",
    columns: [
      "pubkey", "authority", "weekly_expiry_day", "weekly_expiry_hour",
      "monthly_enabled", "min_epoch_duration_days", "bump",
    ],
    decode: decodeEpochConfig as any,
    values: (d) => [
      d.authority, d.weeklyExpiryDay, d.weeklyExpiryHour,
      d.monthlyEnabled ? 1 : 0, d.minEpochDurationDays, d.bump,
    ],
  },
];

export interface RefreshResult {
  kind: ChainKind;
  slot: number;
  fetched: number;
  stored: number;
  rejected: number;
  removed: number;
  rejectedBySize: Record<number, number>;
  error?: string;
}

function recordMeta(db: DB, r: RefreshResult, now: number): void {
  db.prepare(
    `INSERT INTO chain_refresh_meta (kind, slot, refreshed_at, fetched, stored, rejected, rejected_json, last_error)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(kind) DO UPDATE SET
       slot = excluded.slot, refreshed_at = excluded.refreshed_at,
       fetched = excluded.fetched, stored = excluded.stored,
       rejected = excluded.rejected, rejected_json = excluded.rejected_json,
       last_error = excluded.last_error`,
  ).run(r.kind, r.slot, now, r.fetched, r.stored, r.rejected, JSON.stringify(r.rejectedBySize), r.error ?? null);
}

async function refreshOne(db: DB, rpc: RpcClient, programId: string, spec: KindSpec): Promise<RefreshResult> {
  const now = Math.floor(Date.now() / 1000);
  const base: RefreshResult = {
    kind: spec.kind, slot: 0, fetched: 0, stored: 0, rejected: 0, removed: 0, rejectedBySize: {},
  };

  let res: GpaContext;
  try {
    res = await rpc.call<GpaContext>("getProgramAccounts", [
      programId,
      {
        encoding: "base64",
        commitment: "confirmed",
        // The slot is the whole point of the freshness contract, so it is asked
        // for explicitly rather than inferred from wall-clock time.
        withContext: true,
        filters: [{ memcmp: { offset: 0, bytes: discriminatorBase58(spec.accountName) } }],
      },
    ]);
  } catch (e) {
    const error = (e as Error).message;
    // Keep whatever is already stored. Its slot is honest and older; a wiped
    // table would turn a slow page into a blank one.
    log.warn(`chain refresh failed — keeping previous ${spec.kind} rows`, { err: error });
    const prev = db.prepare("SELECT slot FROM chain_refresh_meta WHERE kind = ?").get(spec.kind) as { slot: number } | undefined;
    const out = { ...base, slot: prev?.slot ?? 0, error };
    recordMeta(db, out, now);
    return out;
  }

  const accounts = res?.value ?? [];
  const slot = res?.context?.slot ?? 0;
  if (!Array.isArray(accounts)) return { ...base, slot };

  const placeholders = spec.columns.map(() => "?").join(", ");
  const updates = spec.columns
    .filter((c) => c !== "pubkey")
    .concat(["raw_b64", "layout_len", "slot", "refreshed_at"])
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  const ins = db.prepare(
    `INSERT INTO ${spec.table} (${spec.columns.join(", ")}, raw_b64, layout_len, slot, refreshed_at)
     VALUES (${placeholders}, ?, ?, ?, ?)
     ON CONFLICT(pubkey) DO UPDATE SET ${updates}`,
  );

  const rejectedBySize: Record<number, number> = {};
  const seen: string[] = [];
  let stored = 0;

  db.transaction(() => {
    for (const a of accounts) {
      const b64 = a.account.data[0];
      const buf = Buffer.from(b64, "base64");
      const decoded = spec.decode(buf);
      if (!decoded) {
        rejectedBySize[buf.length] = (rejectedBySize[buf.length] ?? 0) + 1;
        continue;
      }
      ins.run(a.pubkey, ...spec.values(decoded), b64, buf.length, slot, now);
      seen.push(a.pubkey);
      stored += 1;
    }
  })();

  // Apply deletions. An account that was closed on chain must stop being served,
  // or the reflection accumulates contracts that no longer exist.
  let removed = 0;
  if (seen.length > 0) {
    db.transaction(() => {
      const CHUNK = 400; // SQLite variable ceiling; chunked rather than assumed safe
      const keep = new Set(seen);
      const existing = db.prepare(`SELECT pubkey FROM ${spec.table}`).all() as { pubkey: string }[];
      const gone = existing.map((r) => r.pubkey).filter((k) => !keep.has(k));
      for (let i = 0; i < gone.length; i += CHUNK) {
        const slice = gone.slice(i, i + CHUNK);
        db.prepare(
          `DELETE FROM ${spec.table} WHERE pubkey IN (${slice.map(() => "?").join(",")})`,
        ).run(...slice);
        removed += slice.length;
      }
    })();
  }

  const rejected = accounts.length - stored;
  const out: RefreshResult = {
    kind: spec.kind, slot, fetched: accounts.length, stored, rejected, removed, rejectedBySize,
  };
  recordMeta(db, out, now);

  // NEVER SILENT. A rejected account is one the read path cannot serve; on
  // OptionsMarket that is the majority on devnet and it is expected, but it must
  // be visible rather than inferred from a smaller-than-expected board.
  log.info("chain refresh", {
    kind: spec.kind, slot, fetched: accounts.length, stored, rejectedLegacyLayout: rejected,
    removedClosed: removed, rejectedBySize,
  });
  return out;
}

/** Refresh every structural kind. Sequential on purpose: these are the heaviest
 *  scans the box makes, and firing them together is how the RPC budget dies. */
export async function refreshChain(db: DB, rpc: RpcClient, programId: string): Promise<RefreshResult[]> {
  const out: RefreshResult[] = [];
  for (const spec of SPECS) out.push(await refreshOne(db, rpc, programId, spec));
  return out;
}

export const CHAIN_SPECS = SPECS;
