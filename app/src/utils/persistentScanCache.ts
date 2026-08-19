// =============================================================================
// utils/persistentScanCache.ts — the read path survives a reload
// =============================================================================
//
// WHY
//
//   Cold reached its target; warm-on-hard-reload did not, and the cause was
//   structural rather than tunable: the scan cache is IN-MEMORY, so a reload
//   throws it away and repeats the entire cold path. Measured 7.9-8.0s against a
//   <2s target, while in-app navigation — which keeps the memory cache — was
//   4.1s. Persisting across reloads is the only thing that closes that gap.
//
// WHAT IS PERSISTED, AND WHAT NEVER IS
//
//   ONLY the structural set: markets, series, mints, vaults. The never-cache
//   rule does not soften because the storage changed — it gets stricter. A stale
//   in-memory book lives for seconds; a stale PERSISTED book can be served
//   tomorrow, to a user who has since traded, from a page that looks fully
//   loaded. Books, positions, balances and triggers are never written here.
//
// WHY RAW JSON AND NOT THE DECODED ROWS
//
//   IndexedDB stores via STRUCTURED CLONE, which copies own properties and drops
//   prototypes. A PublicKey would come back as a plain object with a `_bn` field
//   and a BN as a bag of limbs — both structurally present, both useless, and
//   neither failing at the boundary. So the raw indexer JSON is persisted and
//   rehydrated on read through the same REHYDRATE path the network response
//   uses. One decoder, one shape, one place to be wrong.
//
// FAILURE POSTURE
//
//   Every failure is a MISS, never an error: no IndexedDB (private mode), quota
//   exceeded, corrupt record, wrong schema, wrong lineage. The worst outcome
//   this module may cause is the load time we already have.
// =============================================================================

/** Envelope shape version. Bumping it makes every stored record unreadable,
 *  which is the intended behaviour when the stored SHAPE changes. */
export const PERSIST_SCHEMA_VERSION = 1;

/** Served instantly on load; anything older is discarded rather than shown.
 *  Bounded deliberately — "stale-while-revalidate" is not "forever if offline". */
export const PERSIST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Beyond this a record is still SERVED but a background revalidation is
 * guaranteed. Inside it the network may still be skipped entirely.
 */
export const PERSIST_FRESH_MS = 60 * 1000;

const DB_NAME = "opta-chain";
const STORE = "scans";

/**
 * Opt-IN allowlist, deliberately duplicated from the in-memory cache rather than
 * imported from it.
 *
 * If the two ever disagree, this one is stricter by construction, and a reviewer
 * comparing them sees the disagreement. Sharing one list would mean a single
 * edit silently grants PERSISTENCE to something that was only ever meant to be
 * cached for seconds — which is the more dangerous of the two.
 */
const PERSISTABLE = new Set<string>([
  "optionsMarket",
  "vaultMint",
  "sharedVault",
  "epochConfig",
]);

/** Types that must NEVER be written to disk, named so a test can assert them. */
export const NEVER_PERSIST = [
  "restingOrder",
  "writerAskPosition",
  "writerAskPot",
  "vaultResaleListing",
  "writerPosition",
  "settlementRecord",
  "triggerOrder",
] as const;

export function isPersistable(accountName: string): boolean {
  return PERSISTABLE.has(accountName);
}

export interface PersistEnvelope {
  v: number;
  /** Deploy-slot lineage from /api/chain/meta. A mismatch busts everything. */
  lineage: string;
  accountName: string;
  scope: string;
  storedAt: number;
  slot: number;
  /** RAW indexer JSON rows — plain data, structured-clone safe. */
  rows: unknown[];
}

export type PersistVerdict =
  | { usable: false }
  | { usable: true; stale: boolean; envelope: PersistEnvelope };

/**
 * Is a stored record usable, and does it need revalidating?
 *
 * Pure, so every rejection path is testable without a browser. The dangerous
 * direction is accepting something we should not: a record from a previous
 * program deployment can decode cleanly and be entirely wrong.
 */
export function evaluateEnvelope(
  raw: unknown,
  expected: { lineage: string; accountName: string; scope: string },
  now: number = Date.now(),
): PersistVerdict {
  const e = raw as PersistEnvelope | null;
  if (!e || typeof e !== "object") return { usable: false };
  if (e.v !== PERSIST_SCHEMA_VERSION) return { usable: false };
  // Lineage is the layout guarantee. An upgrade can move fields inside an
  // account, so a record from the previous deploy is not stale — it is garbage
  // that will rehydrate into plausible wrong numbers.
  if (!e.lineage || e.lineage !== expected.lineage) return { usable: false };
  if (e.accountName !== expected.accountName) return { usable: false };
  if ((e.scope ?? "") !== expected.scope) return { usable: false };
  if (!Array.isArray(e.rows)) return { usable: false };
  if (typeof e.storedAt !== "number" || !Number.isFinite(e.storedAt)) return { usable: false };

  const age = now - e.storedAt;
  // Negative age = a clock that moved backwards. Treat as unusable rather than
  // letting a record look permanently fresh.
  if (age < 0 || age > PERSIST_MAX_AGE_MS) return { usable: false };
  return { usable: true, stale: age > PERSIST_FRESH_MS, envelope: e };
}

// ---------------------------------------------------------------------------
// IndexedDB adapter — every path degrades to a miss
// ---------------------------------------------------------------------------

const keyOf = (lineage: string, accountName: string, scope: string) =>
  `${lineage}|${accountName}|${scope}`;

let dbPromise: Promise<IDBDatabase | null> | null = null;

/** Feature-detected. Private mode and locked-down browsers simply have none. */
function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== "undefined" && indexedDB !== null;
  } catch {
    return false;
  }
}

function openDb(): Promise<IDBDatabase | null> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    if (!idbAvailable()) { resolve(null); return; }
    let req: IDBOpenDBRequest;
    try { req = indexedDB.open(DB_NAME, 1); } catch { resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
  return dbPromise;
}

export async function readPersisted(
  lineage: string,
  accountName: string,
  scope: string,
  now: number = Date.now(),
): Promise<PersistVerdict> {
  if (!isPersistable(accountName) || !lineage) return { usable: false };
  const db = await openDb();
  if (!db) return { usable: false };
  try {
    const raw = await new Promise<unknown>((resolve) => {
      const tx = db.transaction(STORE, "readonly");
      const rq = tx.objectStore(STORE).get(keyOf(lineage, accountName, scope));
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => resolve(null);
      tx.onerror = () => resolve(null);
    });
    return evaluateEnvelope(raw, { lineage, accountName, scope }, now);
  } catch {
    // A corrupt store must read as "nothing here", not as a page-breaking throw.
    return { usable: false };
  }
}

export async function writePersisted(
  lineage: string,
  accountName: string,
  scope: string,
  rows: unknown[],
  slot: number,
  now: number = Date.now(),
): Promise<void> {
  // The guard is here rather than at the call site so there is exactly ONE place
  // that decides what may reach disk.
  if (!isPersistable(accountName) || !lineage) return;
  const db = await openDb();
  if (!db) return;
  const envelope: PersistEnvelope = {
    v: PERSIST_SCHEMA_VERSION, lineage, accountName, scope, storedAt: now, slot, rows,
  };
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      // Quota errors land here and are swallowed on purpose: failing to CACHE
      // must never fail the read that produced the data.
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
      tx.objectStore(STORE).put(envelope, keyOf(lineage, accountName, scope));
    });
  } catch {
    /* ignore */
  }
}

/** Drop everything. Used on a lineage change and after a confirmed mutation. */
export async function clearPersisted(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
      tx.objectStore(STORE).clear();
    });
  } catch {
    /* ignore */
  }
}

/** Test seam. */
export function _resetDbHandle(): void {
  dbPromise = null;
}
