// Persistent finalize cache — D1, ticket 86eyn66b4.
//
// THE PROBLEM
//   `fullyFinalized` was `new Set<string>()`, rebuilt from nothing on every crank
//   start. A vault must be fully scanned before it can enter the set, so each
//   process lifetime re-paid a 10-credit getProgramAccounts for every settled
//   vault. Measured 2026-08-15: 6,215 scans, 3,388 vaults marked, 2 process
//   lifetimes, and txSent=0 for the entire day.
//
// THE RISK THIS INTRODUCES
//   The in-memory set had an accidental safety property: a wrong entry evaporated
//   on the next restart. Persisting it makes a wrong entry permanent, and a
//   wrongly-suppressed vault means somebody never gets paid.
//
//   So membership is NOT sufficient authority to skip. Every suppression is
//   re-checked against live on-chain state, and entries expire so the gate
//   self-heals the way restarts used to. See finalizeCache.test.ts — the naive
//   "just persist the Set" version fails five of those tests.
//
// WHAT IS DELIBERATELY NOT CHANGED
//   The predicate that decides a vault is *finished* (bot.ts: all four passes
//   empty and no progress) is untouched. It is covered by dated verification
//   86eyn5kx8 (2026-08-28). This module only makes an existing decision durable.
import * as fs from "fs";
import * as path from "path";

/** One persisted "this vault looked finished" observation. */
export interface DoneEntry {
  markedAtSec: number;
}

/** The live on-chain facts that can veto a suppression. */
export interface VaultGateState {
  isSettled: boolean;
  collateralRemaining: bigint;
}

/**
 * How long a "finished" observation is trusted before the vault is re-scanned
 * once to confirm. This is the self-healing budget: a wrong entry costs at most
 * one week of missed scans rather than forever. One re-scan per vault per week is
 * ~3,400 gPA/week (~4,900 credits/week), which is noise against the ~62,000
 * credits/day the sweep was burning.
 */
export const DEFAULT_MAX_ENTRY_AGE_SEC = 7 * 24 * 60 * 60;

/** Guard against a corrupt file growing without bound. */
const MAX_ENTRIES = 100_000;
const FILE_VERSION = 1;

interface CacheFile {
  version: number;
  entries: Record<string, DoneEntry>;
}

/**
 * The safety kernel. Decides whether a persisted entry is allowed to suppress a
 * scan. Pure and side-effect free so it can be tested exhaustively.
 *
 * Returns true ONLY when skipping is provably safe. Every uncertain case — no
 * entry, unsettled vault, collateral still present, stale entry, clock skew,
 * malformed input — returns false and costs one scan. Scanning unnecessarily
 * wastes 10 credits; skipping wrongly withholds somebody's money.
 */
export function entryMaySuppressScan(
  entry: DoneEntry | undefined,
  state: VaultGateState,
  nowSec: number,
  maxAgeSec: number,
): boolean {
  if (entry === undefined || entry === null) return false;

  // A vault that has not settled can still take deposits and gain collateral
  // before expiry, so a past "finished" observation says nothing about it now.
  if (state.isSettled !== true) return false;

  // Anything still owed to anybody keeps the vault in scope, unconditionally.
  // This is the property that gates the ship.
  if (state.collateralRemaining > 0n) return false;

  const marked = entry.markedAtSec;
  if (typeof marked !== "number" || !Number.isFinite(marked) || marked <= 0) {
    return false;
  }
  // A future timestamp means clock skew or a hand-edited file. Treat corrupt
  // input as untrusted rather than as an immortal entry.
  if (marked > nowSec) return false;
  if (nowSec - marked > maxAgeSec) return false;

  return true;
}

/**
 * Disk-backed replacement for the in-memory Set. Keeps the same `has`/`add`
 * shape at the call site, but every read is authorised by entryMaySuppressScan.
 */
export class PersistentFinalizeCache {
  private entries = new Map<string, DoneEntry>();
  private dirty = false;

  private constructor(
    private readonly filePath: string,
    private readonly maxAgeSec: number,
    private readonly log: (level: string, msg: string, extra?: unknown) => void,
  ) {}

  static load(
    filePath: string,
    log: (level: string, msg: string, extra?: unknown) => void,
    maxAgeSec: number = DEFAULT_MAX_ENTRY_AGE_SEC,
  ): PersistentFinalizeCache {
    const cache = new PersistentFinalizeCache(filePath, maxAgeSec, log);
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const parsed = JSON.parse(raw) as CacheFile;
      if (!parsed || parsed.version !== FILE_VERSION || typeof parsed.entries !== "object") {
        log("warn", "finalize cache: unrecognised file, starting empty", {
          path: filePath,
          version: parsed?.version,
        });
        return cache;
      }
      let loaded = 0;
      for (const [k, v] of Object.entries(parsed.entries)) {
        if (loaded >= MAX_ENTRIES) break;
        if (v && typeof v.markedAtSec === "number" && Number.isFinite(v.markedAtSec)) {
          cache.entries.set(k, { markedAtSec: v.markedAtSec });
          loaded++;
        }
      }
      log("info", "finalize cache loaded", { path: filePath, entries: loaded });
    } catch (err) {
      // A missing file on first run is the normal path, not an error.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") {
        log("info", "finalize cache: no existing file, starting empty", { path: filePath });
      } else {
        log("warn", "finalize cache: unreadable, starting empty", {
          path: filePath,
          err: String(err),
        });
      }
    }
    return cache;
  }

  /**
   * True iff this vault may be skipped right now. Named to make the call site
   * read as an authorisation rather than a membership test — `has()` invited the
   * assumption that presence alone was enough.
   */
  maySuppress(vaultKey: string, state: VaultGateState, nowSec: number): boolean {
    return entryMaySuppressScan(this.entries.get(vaultKey), state, nowSec, this.maxAgeSec);
  }

  /** Record that a vault looked finished. Persisted on the next flush(). */
  add(vaultKey: string, nowSec: number): void {
    if (this.entries.size >= MAX_ENTRIES && !this.entries.has(vaultKey)) return;
    this.entries.set(vaultKey, { markedAtSec: nowSec });
    this.dirty = true;
  }

  /** Present in the file at all — diagnostics only, never an authorisation. */
  size(): number {
    return this.entries.size;
  }

  /** Drop entries older than the trust window so the file cannot grow forever. */
  prune(nowSec: number): number {
    let removed = 0;
    for (const [k, v] of this.entries) {
      if (nowSec - v.markedAtSec > this.maxAgeSec) {
        this.entries.delete(k);
        removed++;
      }
    }
    if (removed > 0) this.dirty = true;
    return removed;
  }

  /**
   * Atomic write: a torn file would be read back as "unrecognised" and silently
   * cost a full re-scan, so write a temp file and rename over the target.
   */
  flush(): void {
    if (!this.dirty) return;
    const payload: CacheFile = {
      version: FILE_VERSION,
      entries: Object.fromEntries(this.entries),
    };
    const tmp = `${this.filePath}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
      fs.renameSync(tmp, this.filePath);
      this.dirty = false;
    } catch (err) {
      // Losing the file costs credits, never correctness — the sweep just
      // re-scans. Log and carry on rather than taking the crank down.
      this.log("warn", "finalize cache: flush failed", {
        path: this.filePath,
        err: String(err),
      });
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* best effort */
      }
    }
  }
}
