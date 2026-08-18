// =============================================================================
// utils/accountScanCache.ts — SWR cache for whole-program account scans
// =============================================================================
//
// MEASURED PROBLEM (2026-08-18, real Chrome against opta.fyi/trade)
//
//   A cold /trade load fires 16 getProgramAccounts scans across 8 account types.
//   Half of them are REPEATS of a scan issued seconds earlier:
//
//     SharedVault    x2  at 3145ms, 7145ms          (2.78 MB each)
//     WriterPosition x3  at 3146ms, 5985ms, 7145ms
//     EpochConfig    x3  at 3146ms, 5985ms, 7145ms
//     OptionsMarket  x2  at 3146ms, 5985ms
//
//   coalescedProgramAccounts already merges SIMULTANEOUS identical scans, and the
//   measurement shows it doing its job — each wave above is ONE call per type,
//   not many. What it cannot help with is a scan re-issued three seconds later,
//   because by then there is nothing in flight to join. That is a cache-shaped
//   hole, and this fills it. The two are complementary, not alternatives.
//
// WHAT IS AND IS NOT CACHED — the part that matters
//
//   Cached: market/series STRUCTURE (OptionsMarket, VaultMint, SharedVault,
//   EpochConfig) — what CAN be traded. This changes when someone creates a
//   series, which is rare relative to a page load.
//
//   Never cached: the book, and anything position- or balance-shaped
//   (RestingOrder, WriterAskPosition, WriterAskPot, VaultResaleListing,
//   WriterPosition, SettlementRecord) — what IS TRUE RIGHT NOW. A stale book
//   shows a filled order as live; a stale position misstates what someone owns.
//
//   The allowlist is opt-IN. A newly added account type is UNCACHED until
//   someone puts it here on purpose, so the failure mode of forgetting is a slow
//   page rather than a wrong one.
//
// STALE-AFTER-MUTATION
//
//   invalidateAccountScans() already drops the in-flight scan after a confirmed
//   mutation — that primitive exists because a post-action refetch joining a
//   pre-action snapshot was a real shipped bug (stale UI after cancel). This
//   cache hooks the SAME call, so an entry cannot outlive the mutation that
//   invalidates it. Adding a cache without that wiring would re-open the bug
//   with a much longer window, which is why the two live in one code path.
// =============================================================================

import type { PublicKey } from "@solana/web3.js";

/**
 * Cache generation. Bumping this invalidates every persisted/held entry.
 *
 * Tied to the deployed program slot: an upgrade can change an account's layout,
 * and a decoded entry from the previous layout is not merely stale, it is
 * garbage that would render as a plausible-looking wrong number. Account sizes
 * have drifted before (SharedVault 260 -> 268 -> 276), so this is a real hazard
 * and not a theoretical one.
 */
export const SCAN_CACHE_VERSION = "485057525";

/**
 * Served without any network call. Sized to cover a single page load's repeat
 * waves (measured at 3.1s / 6.0s / 7.1s), which is the whole point.
 */
export const FRESH_MS = 15_000;

/**
 * Beyond FRESH_MS an entry is still SERVED (instantly) but a refresh is kicked
 * off behind it — classic stale-while-revalidate. Past this ceiling the entry is
 * discarded and the caller waits for real data.
 */
export const MAX_STALE_MS = 120_000;

/** Opt-IN allowlist. See the header: absence means uncached, which is safe. */
const CACHEABLE = new Set<string>([
  "optionsMarket",
  "vaultMint",
  "sharedVault",
  "epochConfig",
]);

export function isCacheableScan(accountName: string): boolean {
  return CACHEABLE.has(accountName);
}

export type ScanRow<T> = { publicKey: PublicKey; account: T };

interface Entry {
  rows: ScanRow<unknown>[];
  storedAt: number;
  /** Set while a background revalidation is running, so we start only one. */
  revalidating?: boolean;
}

const store = new Map<string, Entry>();

const keyFor = (programId: string, accountName: string) =>
  `${SCAN_CACHE_VERSION}:${programId}:${accountName}`;

export type CacheLookup<T> =
  | { hit: false }
  | { hit: true; rows: ScanRow<T>[]; stale: boolean };

/** Read-through lookup. `stale` true means "use it, but refresh behind it". */
export function lookupScan<T>(
  programId: string,
  accountName: string,
  now: number = Date.now(),
): CacheLookup<T> {
  if (!isCacheableScan(accountName)) return { hit: false };
  const key = keyFor(programId, accountName);
  const entry = store.get(key);
  if (!entry) return { hit: false };

  const age = now - entry.storedAt;
  // A clock that jumped backwards must not make an entry immortal.
  if (age < 0 || age > MAX_STALE_MS) {
    store.delete(key);
    return { hit: false };
  }
  return { hit: true, rows: entry.rows as ScanRow<T>[], stale: age > FRESH_MS };
}

export function storeScan<T>(
  programId: string,
  accountName: string,
  rows: ScanRow<T>[],
  now: number = Date.now(),
): void {
  if (!isCacheableScan(accountName)) return;
  store.set(keyFor(programId, accountName), {
    rows: rows as ScanRow<unknown>[],
    storedAt: now,
  });
}

/**
 * Mark/claim the single background revalidation slot for an entry. Returns false
 * when one is already running, so N stale readers cause ONE refresh rather than
 * N — otherwise a stale entry read by four hooks would fan back out to exactly
 * the burst this cache exists to remove.
 */
export function claimRevalidation(programId: string, accountName: string): boolean {
  const entry = store.get(keyFor(programId, accountName));
  if (!entry || entry.revalidating) return false;
  entry.revalidating = true;
  return true;
}

export function releaseRevalidation(programId: string, accountName: string): void {
  const entry = store.get(keyFor(programId, accountName));
  if (entry) entry.revalidating = false;
}

/** Drop one account type. Called from invalidateAccountScans after a mutation. */
export function invalidateScanCache(programId: string, accountName: string): void {
  store.delete(keyFor(programId, accountName));
}

/** Test seam / hard reset. */
export function clearScanCache(): void {
  store.clear();
}
