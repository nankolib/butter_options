// =============================================================================
// poller.ts — signature paging + batched fetch + persist
// =============================================================================
//
// NON-THROWING BY CONSTRUCTION (the settlementArchive.ts property): a failure to
// fetch or normalize one transaction logs, increments a counter, and moves on.
// It must never kill the loop. The only errors allowed to propagate are ones
// that mean the whole page is untrustworthy (an RPC transport failure), and the
// caller catches those per tick.
// =============================================================================

import type { Config } from "../env";
import { log } from "../log";
import { makeWriter, type DB } from "../db";
import { markBackfillDone, readCursor, setBackfillBefore, setCursorSig } from "./cursor";
import type { EventDecoder } from "./eventDecode";
import { normalize, type RawTx } from "./normalize";
import type { RpcClient, SignatureInfo } from "./rpc";

export interface PollStats {
  txsSeen: number;
  txsIndexed: number;
  eventsIndexed: number;
  fetchFailures: number;
  normalizeFailures: number;
  truncated: number;
}

function emptyStats(): PollStats {
  return { txsSeen: 0, txsIndexed: 0, eventsIndexed: 0, fetchFailures: 0, normalizeFailures: 0, truncated: 0 };
}

export class Poller {
  private readonly write: ReturnType<typeof makeWriter>;

  constructor(
    private readonly db: DB,
    private readonly rpc: RpcClient,
    private readonly decoder: EventDecoder,
    private readonly cfg: Config,
  ) {
    this.write = makeWriter(db);
  }

  /** Fetch + normalize + persist one page of signatures. Never throws per-tx. */
  private async ingest(sigs: SignatureInfo[], stats: PollStats): Promise<void> {
    for (let i = 0; i < sigs.length; i += this.cfg.batchSize) {
      const slice = sigs.slice(i, i + this.cfg.batchSize);
      let results: (unknown | null)[];
      try {
        results = await this.rpc.getTransactionBatch(slice.map((s) => s.signature));
      } catch (e) {
        stats.fetchFailures += slice.length;
        log.warn("batch fetch failed", { n: slice.length, err: (e as Error).message });
        continue;
      }
      for (let j = 0; j < slice.length; j++) {
        stats.txsSeen += 1;
        const raw = results[j] as RawTx | null;
        if (!raw) {
          stats.fetchFailures += 1;
          continue;
        }
        try {
          const { tx, events } = normalize(raw, this.decoder, this.cfg.programId);
          this.write(tx, events);
          stats.txsIndexed += 1;
          stats.eventsIndexed += events.length;
          if (tx.truncated) stats.truncated += 1;
        } catch (e) {
          stats.normalizeFailures += 1;
          log.warn("normalize failed", { sig: slice[j].signature, err: (e as Error).message });
        }
      }
    }
  }

  /**
   * Walk backwards from the newest signature to the configured floor.
   * Resumable: a kill mid-walk restarts from `backfill_before`.
   */
  async backfill(): Promise<PollStats> {
    const stats = emptyStats();
    let state = readCursor(this.db);
    if (state.backfillDone) return stats;

    let before: string | undefined = state.backfillBefore ?? undefined;
    let pages = 0;

    for (;;) {
      const page = await this.rpc.getSignaturesForAddress(this.cfg.programId, { limit: 1000, before });
      if (page.length === 0) {
        markBackfillDone(this.db);
        log.info("backfill complete (empty page)", { pages, ...stats });
        break;
      }

      // On the very first page of a fresh backfill, the newest signature becomes
      // the live-tail high-water mark.
      if (!before && !state.cursorSig) {
        setCursorSig(this.db, page[0].signature);
        state = readCursor(this.db);
      }

      await this.ingest(page, stats);

      const oldest = page[page.length - 1];
      setBackfillBefore(this.db, oldest.signature);
      before = oldest.signature;
      pages += 1;

      log.info("backfill page", {
        pages,
        oldestTime: oldest.blockTime ? new Date(oldest.blockTime * 1000).toISOString() : null,
        txsIndexed: stats.txsIndexed,
        eventsIndexed: stats.eventsIndexed,
      });

      if (oldest.blockTime != null && oldest.blockTime < this.cfg.backfillFloor) {
        markBackfillDone(this.db);
        log.info("backfill complete (floor reached)", { pages, ...stats });
        break;
      }
    }
    return stats;
  }

  /** Index everything strictly newer than the cursor. */
  async tail(): Promise<PollStats> {
    const stats = emptyStats();
    const state = readCursor(this.db);

    // Collect newest-first pages until we reach the cursor, then ingest oldest-first.
    const pages: SignatureInfo[][] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.rpc.getSignaturesForAddress(this.cfg.programId, {
        limit: 1000,
        before,
        until: state.cursorSig ?? undefined,
      });
      if (page.length === 0) break;
      pages.push(page);
      if (page.length < 1000) break;
      before = page[page.length - 1].signature;
    }
    if (pages.length === 0) return stats;

    const newest = pages[0][0].signature;
    for (const page of pages.reverse()) await this.ingest(page, stats);
    setCursorSig(this.db, newest);
    return stats;
  }
}
