// =============================================================================
// log.ts — structured JSON logger (crank convention: one JSON object per line)
// =============================================================================

type Level = "info" | "warn" | "error";

/**
 * One-shot scripts whose STDOUT IS A PAYLOAD send the log stream to stderr.
 *
 * `recompute --json` is a determinism harness: its stdout is hashed and diffed.
 * A single incidental log line — a schema migration firing on the first of
 * three runs — made run 1 differ from runs 2 and 3 and looked exactly like
 * non-determinism in the scoring engine. The long-running service does NOT set
 * this: its stdout stays as-is, so the RULE 1 boot marker is untouched.
 */
let stream: "stdout" | "stderr" = "stdout";
export function logToStderr(): void {
  stream = "stderr";
}

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(fields ?? {}) });
  if (level === "error" || stream === "stderr") console.error(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
  /** RULE 1 boot marker — first line on stdout, asserted at deploy time. */
  boot: (fields: Record<string, unknown>) => console.log(JSON.stringify({ service: "opta-indexer", ...fields })),
};
