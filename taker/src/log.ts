// =============================================================================
// log.ts — structured single-line JSON logs + heartbeat (vendored from writer/)
// =============================================================================
// One JSON object per line, systemd-journal friendly. Quiet ticks emit nothing
// at info level; liveness is proven by the hourly heartbeat.
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

/**
 * Hourly counters. `considered`/`eligible` matter more than `filled` in shadow —
 * a bot that fills nothing because it saw nothing looks identical in the journal
 * to one that fills nothing because every gate refused, and those are opposite
 * problems.
 */
export class Heartbeat {
  private scanned = 0;
  private considered = 0;
  private eligible = 0;
  private filled = 0;
  private errors = 0;
  private ticks = 0;
  private lastEmit: number;
  readonly intervalMs: number;

  constructor(intervalMs = 60 * 60 * 1000, nowMs = Date.now()) {
    this.intervalMs = intervalMs;
    this.lastEmit = nowMs;
  }

  onScan(n: number): void { this.scanned += n; }
  onConsider(): void { this.considered++; }
  onEligible(): void { this.eligible++; }
  onFill(): void { this.filled++; }
  onError(): void { this.errors++; }
  onTick(): void { this.ticks++; }

  maybeEmit(nowMs = Date.now(), extra: Record<string, unknown> = {}): void {
    if (nowMs - this.lastEmit < this.intervalMs) return;
    log.info("heartbeat", {
      ticksSinceLast: this.ticks,
      scanned: this.scanned,
      considered: this.considered,
      eligible: this.eligible,
      filled: this.filled,
      errors: this.errors,
      ...extra,
    });
    this.scanned = this.considered = this.eligible = this.filled = this.errors = this.ticks = 0;
    this.lastEmit = nowMs;
  }
}
