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
import {
  clearPersisted, isPersistable, readPersisted, writePersisted,
} from "./persistentScanCache";

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
 *
 * Kept in step with the indexer's STALE_AFTER_SEC, which is DERIVED from
 * measured refresh intervals rather than assumed from the nominal cadence.
 * RE-DERIVED after the refresh was decoupled onto its own timer: 387 samples per
 * type over ~7h give p95 70.0s (69.1s excluding restarts), so max(90, p95 x 1.55)
 * = 110s. The old 90s sat below the PRE-decouple p95 of 129.4s, which is why a
 * healthy indexer on a slow day was flagged stale and the read path fell back.
 *
 * PER-TYPE BY CONSTRUCTION: this is applied to each endpoint's own envelope, so
 * a slow `vaults` scan cannot stale-out `series` or `markets` that refreshed
 * fine. Fallback is per account type, never wholesale.
 */
const MAX_AGE_SEC = 110;

/**
 * One slow endpoint must not hold the page hostage — it falls back instead.
 *
 * MEASURED: 4s was too tight. The unfiltered vaults collection is 3.74MB and
 * takes ~3.5s, so the abort fired mid-flight, threw away a response that was
 * nearly complete, and sent the page to a full getProgramAccounts scan — the
 * expensive thing this exists to avoid. A timeout shorter than the work is not
 * a safety valve, it is a guaranteed fallback.
 *
 * The real fix is to stop fetching every board to render one (the ?market=
 * filter takes JTO from 3.74MB to 52KB), which needs market context threaded
 * into safeFetchAll. Until then the budget matches the actual payload.
 */
const FETCH_TIMEOUT_MS = 10_000;

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

const LINEAGE_KEY = "opta:chain:lineage";

/**
 * Last-known deploy-slot lineage, read SYNCHRONOUSLY from localStorage.
 *
 * The lineage is the layout guarantee for anything on disk, and it comes from
 * /api/chain/meta — but awaiting that before touching IndexedDB would put a
 * network round-trip in front of the instant render this whole slice exists to
 * produce. So the last-known value is used optimistically and VERIFIED in the
 * background; a mismatch wipes the store.
 *
 * Optimism is safe here precisely because the persisted rows are re-validated
 * against it: the worst case is one render from the previous deploy's data,
 * immediately followed by a bust and a refetch. Being wrong for one paint beats
 * being slow on every load — and being wrong FOREVER is what the verification
 * prevents.
 */
function knownLineage(): string {
  try { return window.localStorage.getItem(LINEAGE_KEY) ?? ""; } catch { return ""; }
}

function rememberLineage(v: string): void {
  try { window.localStorage.setItem(LINEAGE_KEY, v); } catch { /* private mode */ }
}

let lineagePromise: Promise<string> | null = null;

/**
 * Resolve the lineage once per session, reconciling anything already on disk.
 *
 * MEASURED BUG: this used to be fire-and-forget, and on a FIRST visit
 * localStorage holds no lineage — so every write was skipped and the cache never
 * populated at all. The persistence only began working on the second visit,
 * which is exactly the visit that did not need it. Writes now await this.
 *
 * Reads still use the SYNCHRONOUS knownLineage(): if it is empty there is by
 * definition nothing on disk to read, so there is nothing to wait for.
 */
function ensureLineage(): Promise<string> {
  if (lineagePromise) return lineagePromise;
  lineagePromise = (async () => {
    try {
      const res = await fetch(`${BASE}/meta`);
      if (!res.ok) return knownLineage();
      const meta = await res.json();
      const fresh: string = meta?.lineage?.key ?? "";
      if (!fresh) return knownLineage();
      if (fresh !== knownLineage()) {
        // A new deployment, or the first visit. Anything already on disk
        // describes a different layout, so it goes.
        await clearPersisted();
        rememberLineage(fresh);
      }
      return fresh;
    } catch {
      // Unverified just means we keep using the last known one; the envelope
      // check still refuses anything that does not match it.
      return knownLineage();
    }
  })();
  return lineagePromise;
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

/** Raw indexer rows -> the shape safeFetchAll returns. Shared by the network and
 *  the disk paths so both go through ONE decoder. */
function hydrateRows<T>(rows: any[], rehydrate: (r: any) => unknown): IndexerResult<T>["rows"] {
  return rows.map((r) => ({ publicKey: pk(r.publicKey), account: rehydrate(r) as T }));
}

async function fetchNetwork<T>(
  name: AccountName,
  scope: string,
  rehydrate: (r: any) => unknown,
): Promise<IndexerResult<T> | null> {
  const q = scope ? `?market=${encodeURIComponent(scope)}` : "";
  const body = await getJson<any>(`${BASE}/${ENDPOINT[name]}${q}`);
  if (!body) return null;
  try {
    const out = { rows: hydrateRows<T>(body.rows, rehydrate), slot: body.slot, ageSec: body.ageSec };
    // Persist the RAW rows, never the decoded ones: structured clone would strip
    // the BN and PublicKey prototypes and hand back plausible-looking rubbish.
    if (isPersistable(name)) {
      // Awaits the lineage: without it the FIRST visit persists nothing, because
      // localStorage is empty until /meta has been read once.
      void ensureLineage().then((l) => writePersisted(l, name, scope, body.rows, body.slot));
    }
    return out;
  } catch {
    // A rehydration failure means the served shape is not what this build
    // expects — most likely a layout change on one side. Fall back rather than
    // hand a half-built object to a pricing model.
    return null;
  }
}

async function fetchFromIndexerUncoalesced<T>(
  name: AccountName,
  params?: { market?: string },
): Promise<IndexerResult<T> | null> {
  if (!servedByIndexer(name)) return null;
  const rehydrate = REHYDRATE[name];
  if (!rehydrate) return null;
  const scope = params?.market ?? "";

  // Kick lineage resolution once per session, behind the render rather than in
  // front of it. Writes await it; reads do not need to.
  void ensureLineage();

  // DISK FIRST. This is the reload path: no network in the critical path at all
  // when the record is fresh, which is the only way a hard reload approaches
  // in-app navigation.
  const persisted = await readPersisted(knownLineage(), name, scope);
  if (persisted.usable) {
    try {
      const rows = hydrateRows<T>(persisted.envelope.rows as any[], rehydrate);
      if (persisted.stale) {
        // Serve now, refresh behind it. Not awaited on purpose.
        void fetchNetwork<T>(name, scope, rehydrate);
      }
      return { rows, slot: persisted.envelope.slot, ageSec: 0 };
    } catch {
      // Stored rows no longer rehydrate under this build. Fall through to the
      // network rather than serving a half-built object.
    }
  }

  return fetchNetwork<T>(name, scope, rehydrate);
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
