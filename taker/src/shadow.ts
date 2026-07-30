// =============================================================================
// shadow.ts — decision recording
// =============================================================================
//
// Shadow mode's product is a JOURNAL, not a silence. Every candidate produces
// exactly one line naming the gate that stopped it, so the question "why has the
// treasury bought nothing" has an answer in the logs rather than in a debugger.
//
// The per-tick roll-up matters as much as the individual lines: a run where all
// 200 candidates were refused for `internal_owner` (the board is 232/233 ours)
// looks nothing like one where 200 were refused for `above_band`, and only the
// tally makes that visible at a glance.
// =============================================================================

import { log } from "./log";
import type { Decision, RejectReason } from "./eligibility";

export interface ShadowRow {
  orderPk: string;
  owner: string;
  mint: string;
  price: number;
  fair: number | null;
  decision: Decision;
}

export class ShadowTally {
  private readonly reasons = new Map<RejectReason, number>();
  private fills = 0;
  private notional = 0;

  record(row: ShadowRow, verbose: boolean): void {
    if (row.decision.fill) {
      this.fills++;
      this.notional += row.decision.costUsdc;
      log.info("shadow-eligible", {
        order: row.orderPk,
        owner: row.owner,
        mint: row.mint,
        qty: row.decision.quantity,
        price: +row.price.toFixed(6),
        fair: row.fair == null ? null : +row.fair.toFixed(6),
        discountBps: row.decision.bandBps,
        costUsdc: +row.decision.costUsdc.toFixed(2),
      });
      return;
    }
    const r = row.decision.reason;
    this.reasons.set(r, (this.reasons.get(r) ?? 0) + 1);
    // The board is overwhelmingly our own orders, so logging every
    // internal_owner refusal at info would bury everything else. It still counts
    // in the tally.
    if (verbose && r !== "internal_owner") {
      log.info("shadow-skip", {
        order: row.orderPk, owner: row.owner, reason: r, detail: row.decision.detail ?? null,
      });
    }
  }

  /** Emit the tick roll-up and reset. Always emits — a zero line is a fact. */
  emit(extra: Record<string, unknown> = {}): void {
    const byReason: Record<string, number> = {};
    for (const [k, v] of this.reasons) byReason[k] = v;
    log.info("shadow-tick", {
      eligible: this.fills,
      eligibleNotionalUsdc: +this.notional.toFixed(2),
      skipped: byReason,
      ...extra,
    });
    this.reasons.clear();
    this.fills = 0;
    this.notional = 0;
  }

  get eligibleCount(): number { return this.fills; }
}
