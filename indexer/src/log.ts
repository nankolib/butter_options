// =============================================================================
// log.ts — structured JSON logger (crank convention: one JSON object per line)
// =============================================================================

type Level = "info" | "warn" | "error";

function emit(level: Level, msg: string, fields?: Record<string, unknown>): void {
  const line = JSON.stringify({ t: new Date().toISOString(), level, msg, ...(fields ?? {}) });
  if (level === "error") console.error(line);
  else console.log(line);
}

export const log = {
  info: (msg: string, fields?: Record<string, unknown>) => emit("info", msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => emit("warn", msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => emit("error", msg, fields),
  /** RULE 1 boot marker — first line on stdout, asserted at deploy time. */
  boot: (fields: Record<string, unknown>) => console.log(JSON.stringify({ service: "opta-indexer", ...fields })),
};
