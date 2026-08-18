// Cross-tick account cache for the trigger keeper — 2B item 1.
//
// WHY
//   The trigger tick fetched markets AND vaults on every pass, so any tick with a
//   live order cost 3 getProgramAccounts instead of 1. gPA is the most expensive
//   RPC method there is (10 credits), and this crank is the one that exhausted the
//   key on 2026-08-06 at 5,720 gPA/day — 98.6% of all gPA traffic. Markets and
//   vaults change on the order of hours; re-reading the whole board every 5
//   minutes buys nothing.
//
// WHY NOT A PLAIN TTL
//   A pure TTL forces a choice between cost and freshness: long TTL is cheap but a
//   NEW market cannot be evaluated until it expires; short TTL picks new markets up
//   quickly but pays for the board over and over. Neither is right for a keeper
//   whose whole job is to notice things.
//
//   So the refresh has two triggers:
//     1. AGE   — a bounded staleness ceiling, so account data cannot rot silently.
//     2. MISS  — any key an order actually REFERENCES that is not in the cache
//                forces an immediate refresh, once, on that tick.
//
//   The miss path is what makes the age ceiling affordable. A market only matters
//   to this crank when an order points at it, and that is exactly the moment the
//   cache is asked for it. So a new market enters evaluation on the FIRST TICK an
//   order references it, no matter how long the TTL is, while a quiet board costs
//   nothing.
//
// COST
//   Steady state (nothing new, nothing expired): 1 gPA/tick for the orders scan,
//   which at a 300s tick is ~289 gPA/day ≈ 2,890 credits/day. Each refresh adds 2.

export interface CacheEntry {
  publicKey: { toBase58(): string };
  account: unknown;
}

export interface AccountCacheStats {
  refreshes: number;
  ageRefreshes: number;
  missRefreshes: number;
  hits: number;
  lastRefreshMs: number;
  size: number;
}

export class AccountCache<T extends CacheEntry> {
  private data: T[] | null = null;
  private keys = new Set<string>();
  private fetchedAtMs = 0;
  private stats: AccountCacheStats = {
    refreshes: 0, ageRefreshes: 0, missRefreshes: 0, hits: 0, lastRefreshMs: 0, size: 0,
  };

  constructor(
    private readonly fetcher: () => Promise<T[]>,
    private readonly ttlMs: number,
    private readonly label: string,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Return the cached set, refreshing first if it is stale OR if any of
   * `required` is absent.
   *
   * `required` is the set of keys the CALLER already knows it needs this tick —
   * for the trigger crank, the market and vault of every live order. Passing them
   * is what lets the TTL be long without ever hiding a new market.
   */
  async get(required?: Iterable<string>): Promise<T[]> {
    const t = this.now();
    let reason: "age" | "miss" | null = null;

    if (this.data === null) {
      reason = "age"; // cold start counts as age, not a miss
    } else if (t - this.fetchedAtMs >= this.ttlMs) {
      reason = "age";
    } else if (required) {
      for (const k of required) {
        if (!this.keys.has(k)) { reason = "miss"; break; }
      }
    }

    if (reason === null) {
      this.stats.hits++;
      return this.data as T[];
    }

    const fresh = await this.fetcher();
    this.data = fresh;
    this.keys = new Set(fresh.map((e) => e.publicKey.toBase58()));
    this.fetchedAtMs = t;
    this.stats.refreshes++;
    this.stats.lastRefreshMs = t;
    this.stats.size = fresh.length;
    if (reason === "age") this.stats.ageRefreshes++;
    else this.stats.missRefreshes++;
    return fresh;
  }

  /** Diagnostics for the tick heartbeat — never an authorisation to skip a read. */
  snapshot(): AccountCacheStats & { label: string; ageMs: number } {
    return {
      ...this.stats,
      label: this.label,
      ageMs: this.fetchedAtMs === 0 ? -1 : this.now() - this.fetchedAtMs,
    };
  }

  /** Test seam: drop everything so the next get() must go to the network. */
  invalidate(): void {
    this.data = null;
    this.keys.clear();
    this.fetchedAtMs = 0;
  }
}

/**
 * Refresh ceiling for markets and vaults.
 *
 * One hour = 12 ticks at the 300s cadence. The number is a STALENESS bound, not a
 * freshness mechanism: anything an order references is picked up on the tick it is
 * referenced, via the miss path. This only bounds how long changed data on an
 * ALREADY-KNOWN account can go unnoticed.
 */
export const ACCOUNT_CACHE_TTL_MS = 60 * 60 * 1000;
