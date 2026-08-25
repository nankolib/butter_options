/**
 * Indexer read path (vC3 Rev C).
 *
 * WHY THIS EXISTS
 *   Client full-chain scanning is architecturally dead on mobile. Measured on a
 *   Seeker 2026-08-25: 5,217 SharedVault + 5,217 VaultMint per load, ~1.65 MB
 *   gzipped, 120-180s end to end, against a 60s refresh — the device never left
 *   the scan/decode cycle. See SEEKER_VC3_REVC_PROPOSAL.md.
 *
 * THE MARKET FILTER IS THE POINT, NOT AN OPTIMISATION
 *   Unfiltered `vaults` + `series` are 5.93 MB of JSON — MORE to parse than the
 *   5.26 MB of base64 they replace. Fetching them unfiltered would move the hang,
 *   not fix it. The board-scoped form is 30.9 KB + 37.0 KB gzipped.
 *   `fetchIndexerRows` therefore REFUSES to issue an unfiltered vaults/series
 *   request. That refusal is covered by a test, not just this comment.
 *
 * NEVER WORSE THAN TODAY
 *   Every failure mode — stale envelope, unhealthy meta, lineage mismatch,
 *   non-200, timeout, malformed body — returns null, and the caller falls back to
 *   the existing chain scan. The indexer can only ever make things faster.
 *
 * NEVER A SIGNATURE
 *   These rows drive display only. Transaction inputs are re-read chain-direct at
 *   sign time (solana/transactions.ts).
 */
import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import {
  INDEXER_BASE,
  INDEXER_ENABLED,
  INDEXER_EXPECTED_LINEAGE,
  INDEXER_MAX_AGE_SEC,
  INDEXER_TIMEOUT_MS
} from "../constants";

export type IndexerKind = "sharedVault" | "vaultMint" | "optionsMarket" | "epochConfig";

/** Only these four. Anything absent falls through to a direct chain read. */
export const INDEXER_ENDPOINT: Readonly<Record<IndexerKind, string>> = {
  sharedVault: "vaults",
  vaultMint: "series",
  optionsMarket: "markets",
  epochConfig: "epochs"
};

/** The two that are per-board sized. Requesting these unfiltered is a bug. */
export const BOARD_SCOPED: readonly IndexerKind[] = ["sharedVault", "vaultMint"];

export function requiresMarketFilter(kind: IndexerKind): boolean {
  return BOARD_SCOPED.includes(kind);
}

type Envelope = {
  slot?: number;
  refreshedAt?: number;
  ageSec?: number;
  stale?: boolean;
  count?: number;
  rows?: unknown[];
};

/**
 * Mirrors the web FE's isServableEnvelope (app/src/utils/chainRehydrate.ts).
 * An envelope is servable only if it is well-formed, not flagged stale, and
 * young enough. Anything else means fall back.
 */
export function isServableEnvelope(body: unknown, maxAgeSec: number): body is Envelope & { rows: unknown[] } {
  if (!body || typeof body !== "object") return false;
  const env = body as Envelope;
  if (!Array.isArray(env.rows)) return false;
  if (env.stale === true) return false;
  if (typeof env.ageSec !== "number" || !Number.isFinite(env.ageSec)) return false;
  if (env.ageSec > maxAgeSec) return false;
  return true;
}

async function getJson(url: string): Promise<any | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INDEXER_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return null;
    return await resp.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Lineage guard. The meta endpoint reports which program+deploy the rows were
 * built from. An indexer pointed at a different deploy must never silently feed
 * a field build — its rows would decode into plausible nonsense.
 */
export async function indexerLineageOk(): Promise<boolean> {
  const meta = await getJson(`${INDEXER_BASE}/meta`);
  if (!meta || typeof meta !== "object") return false;
  if (meta.healthy !== true) return false;
  const key = meta?.lineage?.key;
  return typeof key === "string" && key === INDEXER_EXPECTED_LINEAGE;
}

/**
 * Fetch one account kind. Returns raw rows, or null to mean "fall back".
 *
 * `marketKey` is REQUIRED for the board-scoped kinds. Passing null for those
 * returns null rather than issuing the 5.93 MB unfiltered request.
 */
export async function fetchIndexerRows(
  kind: IndexerKind,
  marketKey: string | null
): Promise<any[] | null> {
  if (!INDEXER_ENABLED) return null;
  if (requiresMarketFilter(kind) && !marketKey) return null;

  const path = INDEXER_ENDPOINT[kind];
  const url = marketKey && requiresMarketFilter(kind)
    ? `${INDEXER_BASE}/${path}?market=${encodeURIComponent(marketKey)}`
    : `${INDEXER_BASE}/${path}`;

  const body = await getJson(url);
  if (!isServableEnvelope(body, INDEXER_MAX_AGE_SEC)) return null;
  return body.rows as any[];
}

// ---------------------------------------------------------------------------
// Row adapters — indexer JSON -> the exact shape the existing decoders produce,
// so nothing downstream can tell where a record came from.
//   u64/i64 -> decimal strings   enums -> numbers   pubkeys -> base58 strings
// ---------------------------------------------------------------------------

const bn = (v: unknown): BN => new BN(typeof v === "string" || typeof v === "number" ? String(v) : "0");
const pk = (v: unknown): PublicKey => new PublicKey(String(v));
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function hexToBytes(hex: unknown): number[] {
  const s = typeof hex === "string" ? hex.replace(/^0x/, "") : "";
  const out: number[] = [];
  for (let i = 0; i + 1 < s.length; i += 2) out.push(parseInt(s.slice(i, i + 2), 16));
  return out;
}

export function adaptVault(row: any) {
  return {
    publicKey: pk(row.publicKey),
    account: {
      market: pk(row.market),
      optionType: num(row.optionType) === 0 ? { call: {} } : { put: {} },
      strikePrice: bn(row.strikePrice),
      expiry: bn(row.expiry),
      vaultType: num(row.vaultType) === 0 ? { epoch: {} } : { custom: {} },
      totalCollateral: bn(row.totalCollateral),
      totalShares: bn(row.totalShares),
      vaultUsdcAccount: pk(row.vaultUsdcAccount),
      collateralMint: pk(row.collateralMint),
      totalOptionsMinted: bn(row.totalOptionsMinted),
      totalOptionsSold: bn(row.totalOptionsSold),
      netPremiumCollected: bn(row.netPremiumCollected),
      isSettled: row.isSettled === true,
      settlementPrice: bn(row.settlementPrice),
      collateralRemaining: bn(row.collateralRemaining),
      creator: pk(row.creator),
      createdAt: bn(row.createdAt),
      bump: num(row.bump),
      carryRateBps: bn(row.carryRateBps),
      exerciseStyle: num(row.exerciseStyle) === 1 ? { american: {} } : { european: {} },
      exercisedOptions: bn(row.exercisedOptions),
      earlyExercisePayout: bn(row.earlyExercisePayout),
      spreadBps: num(row.spreadBps),
      voided: row.voided === true
    }
  };
}

export function adaptVaultMint(row: any) {
  return {
    publicKey: pk(row.publicKey),
    account: {
      vault: pk(row.vault),
      writer: pk(row.writer),
      optionMint: pk(row.optionMint),
      premiumPerContract: bn(row.premiumPerContract),
      quantityMinted: bn(row.quantityMinted),
      quantitySold: bn(row.quantitySold),
      createdAt: bn(row.createdAt),
      bump: num(row.bump)
    }
  };
}

export function adaptMarket(row: any) {
  return {
    publicKey: pk(row.publicKey),
    account: {
      assetName: String(row.assetName ?? ""),
      pythFeedId: hexToBytes(row.pythFeedId),
      assetClass: num(row.assetClass),
      bump: num(row.bump),
      oracleSource: num(row.oracleSource)
    }
  };
}

export function adaptEpochConfig(row: any) {
  return {
    publicKey: pk(row.publicKey),
    account: {
      authority: pk(row.authority),
      weeklyExpiryDay: num(row.weeklyExpiryDay),
      weeklyExpiryHour: num(row.weeklyExpiryHour),
      monthlyEnabled: row.monthlyEnabled === true,
      minEpochDurationDays: num(row.minEpochDurationDays),
      bump: num(row.bump)
    }
  };
}

export const ADAPTER: Readonly<Record<IndexerKind, (row: any) => any>> = {
  sharedVault: adaptVault,
  vaultMint: adaptVaultMint,
  optionsMarket: adaptMarket,
  epochConfig: adaptEpochConfig
};

/** Fetch + adapt in one step. Null means fall back to the chain scan. */
export async function loadIndexerRecords(
  kind: IndexerKind,
  marketKey: string | null
): Promise<any[] | null> {
  const rows = await fetchIndexerRows(kind, marketKey);
  if (!rows) return null;
  const adapt = ADAPTER[kind];
  const out: any[] = [];
  for (const row of rows) {
    try { out.push(adapt(row)); } catch { /* one bad row must not sink the batch */ }
  }
  return out;
}
