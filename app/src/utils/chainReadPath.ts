// =============================================================================
// utils/chainReadPath.ts — read structural chain state from the indexer
// =============================================================================
//
// WHY THIS EXISTS
//
//   /trade misses its load targets (cold ~14s against single-digit, warm ~12s
//   against <2s) and the remaining cost is not call COUNT but a handful of very
//   large responses: 2.78MB + 1.92MB getProgramAccounts at 5.5-8s each over
//   http/1.1. No client cache fixes a first load that must pull ~5.4MB of raw
//   accounts before it can draw a row.
//
//   Measured against the live endpoints, the same board arrives in ~1.0-1.5s
//   cold: 638 vaults + 638 series + 34 markets, fetched in parallel with the
//   browser cache disabled.
//
// SHAPE FIDELITY IS THE WHOLE RISK
//
//   Call sites consume Anchor's RUNTIME shape — BN for u64/i64/u128, PublicKey
//   for keys, `{ american: {} }`-style objects for enums. The indexer serves
//   JSON strings and numbers. Handing back a plain string where a BN is expected
//   does not throw at the boundary; it throws (or worse, silently misformats) far
//   away, in pricing or in a transaction argument. So everything is rehydrated to
//   the exact shape Anchor produces, and a test compares the two paths field by
//   field on real accounts.
//
// WHAT THIS IS NOT ALLOWED TO SERVE
//
//   Structural types only: SharedVault, VaultMint, OptionsMarket, EpochConfig.
//   The book, positions, balances and settlement records are never read from
//   here. R2: nothing tx-adjacent reads the index — the early-exercise gate
//   stays chain-direct, and the same test applies to any affordance-gating read.
// =============================================================================

import { PublicKey } from "@solana/web3.js";

import type { AccountName } from "../hooks/useFetchAccounts";
import { REHYDRATE, isServableEnvelope } from "./chainRehydrate";
import { registerIndexerReader } from "./indexerRegistry";

/** Off unless explicitly enabled. Ships dark and is flipped deliberately. */
export const CHAIN_READPATH_ENABLED = import.meta.env.VITE_CHAIN_READPATH === "1";

const BASE = "/api/chain";

/** Only these four. Anything absent falls through to a direct chain read. */
const ENDPOINT: Partial<Record<AccountName, string>> = {
  sharedVault: "vaults",
  vaultMint: "series",
  optionsMarket: "markets",
  epochConfig: "epochs",
};

export function servedByIndexer(name: AccountName): boolean {
  return CHAIN_READPATH_ENABLED && ENDPOINT[name] !== undefined;
}

/**
 * A response older than this is not trusted, no matter what it says. The server
 * publishes its own `stale` flag against the same threshold; this is the client
 * refusing to be told a stale answer is fresh.
 */
const MAX_AGE_SEC = 90;

/** One slow endpoint must not hold the page hostage — it falls back instead. */
const FETCH_TIMEOUT_MS = 4_000;

export interface ChainEnvelope<T> {
  slot: number;
  refreshedAt: number;
  ageSec: number;
  stale: boolean;
  count: number;
  rows: T[];
}

async function getJson<T>(path: string): Promise<ChainEnvelope<T> | null> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(path, { signal: ac.signal });
    if (!res.ok) return null;
    const body = (await res.json()) as ChainEnvelope<T>;
    // Trust nothing that cannot prove its freshness. A restart of the indexer
    // leaves it answering for minutes before its first scan lands, and an empty
    // board served confidently is worse than a slow one.
    if (!isServableEnvelope(body, MAX_AGE_SEC)) return null;
    return body;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const pk = (v: string): PublicKey => new PublicKey(v);

// ---------------------------------------------------------------------------
// The read
// ---------------------------------------------------------------------------

export interface IndexerResult<T> {
  rows: { publicKey: PublicKey; account: T }[];
  slot: number;
  ageSec: number;
}

/**
 * Fetch one account type from the indexer, in the same shape safeFetchAll
 * returns. `null` means "could not serve this" for ANY reason — disabled,
 * unreachable, stale, malformed — and the caller must fall back to chain.
 *
 * Returning null rather than throwing is deliberate: a degraded read path must
 * cost the user the old load time, never the page.
 */
/**
 * In-flight dedup, keyed by exactly what is being fetched.
 *
 * MEASURED: without this, a cold /trade fetched /api/chain/vaults THREE times
 * (3.74MB each) and /series three times, because several hooks call safeFetchAll
 * concurrently and none of them had stored a result yet. coalescedProgramAccounts
 * already solves this for the chain path; bypassing it for the indexer meant
 * re-introducing the identical burst, and the read path briefly cost MORE bytes
 * than the scans it replaced.
 */
const inflight = new Map<string, Promise<IndexerResult<unknown> | null>>();

export async function fetchFromIndexer<T>(
  name: AccountName,
  params?: { market?: string },
): Promise<IndexerResult<T> | null> {
  if (!servedByIndexer(name)) return null;
  const key = `${name}:${params?.market ?? ""}`;
  const existing = inflight.get(key);
  if (existing) return existing as Promise<IndexerResult<T> | null>;
  const p = fetchFromIndexerUncoalesced<T>(name, params);
  inflight.set(key, p as Promise<IndexerResult<unknown> | null>);
  // Clear on settle so the NEXT read is fresh rather than joining a stale
  // snapshot — same reasoning as the chain-side coalescer.
  void p.finally(() => { if (inflight.get(key) === (p as never)) inflight.delete(key); });
  return p;
}

async function fetchFromIndexerUncoalesced<T>(
  name: AccountName,
  params?: { market?: string },
): Promise<IndexerResult<T> | null> {
  if (!servedByIndexer(name)) return null;
  const rehydrate = REHYDRATE[name];
  if (!rehydrate) return null;

  const q = params?.market ? `?market=${encodeURIComponent(params.market)}` : "";
  const body = await getJson<any>(`${BASE}/${ENDPOINT[name]}${q}`);
  if (!body) return null;

  try {
    return {
      rows: body.rows.map((r) => ({
        publicKey: pk(r.publicKey),
        account: rehydrate(r) as T,
      })),
      slot: body.slot,
      ageSec: body.ageSec,
    };
  } catch {
    // A rehydration failure means the served shape is not what this build
    // expects — most likely a layout change on one side. Fall back rather than
    // hand a half-built object to a pricing model.
    return null;
  }
}

/**
 * Install the reader. Imported for side effect from the FE entry point ONLY —
 * this module carries `import.meta` and must never enter the crank's import
 * graph. Registering when the flag is off would be harmless but pointless, so
 * the gate is here rather than inside every read.
 */
if (CHAIN_READPATH_ENABLED) {
  registerIndexerReader((name, params) =>
    fetchFromIndexer(name as never, params) as never);
}
