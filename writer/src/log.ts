// =============================================================================
// log.ts — structured single-line JSON logs + an hourly heartbeat aggregator.
// =============================================================================
// One JSON object per line (systemd-journal friendly), mirroring the crank's
// event-tagged logging. Quiet ticks emit nothing at info level; liveness is
// proven by the hourly heartbeat, which also carries the running counters
// (posted / repriced / cancelled / stranded / quote-failed).
// =============================================================================

type Level = "info" | "warn" | "error" | "fatal";

function emit(level: Level, ev: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, ev, ...fields });
  if (level === "error" || level === "fatal") console.error(line);
  else console.log(line);
}

export const log = {
  info: (ev: string, f?: Record<string, unknown>) => emit("info", ev, f),
  warn: (ev: string, f?: Record<string, unknown>) => emit("warn", ev, f),
  error: (ev: string, f?: Record<string, unknown>) => emit("error", ev, f),
  fatal: (ev: string, f?: Record<string, unknown>) => emit("fatal", ev, f),
};

/** Cumulative counters surfaced in the heartbeat; reset each heartbeat window. */
export class Heartbeat {
  private posted = 0;
  private repriced = 0;
  private cancelled = 0;
  private stranded = 0;
  private quoteFailed = 0;
  private ticks = 0;
  private lastEmit = 0;
  readonly intervalMs: number;

  constructor(intervalMs = 60 * 60 * 1000, nowMs = Date.now()) {
    this.intervalMs = intervalMs;
    this.lastEmit = nowMs;
  }

  onPost(): void { this.posted++; }
  onReprice(): void { this.repriced++; }
  onCancel(): void { this.cancelled++; }
  onStrand(): void { this.stranded++; }
  onQuoteFail(): void { this.quoteFailed++; }
  onTick(): void { this.ticks++; }

  /** Emit + reset if the window has elapsed. Call once per tick. */
  maybeEmit(nowMs = Date.now(), extra: Record<string, unknown> = {}): void {
    if (nowMs - this.lastEmit < this.intervalMs) return;
    log.info("heartbeat", {
      ticksSinceLast: this.ticks,
      posted: this.posted,
      repriced: this.repriced,
      cancelled: this.cancelled,
      stranded: this.stranded,
      quoteFailed: this.quoteFailed,
      ...extra,
    });
    this.posted = this.repriced = this.cancelled = this.stranded = this.quoteFailed = this.ticks = 0;
    this.lastEmit = nowMs;
  }

  get strandCount(): number { return this.stranded; }
}
