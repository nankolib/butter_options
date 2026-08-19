// =============================================================================
// canary/journal.ts — ledger-before-send, so a killed run leaves a trail
// =============================================================================
//
// WHY A FILE AND NOT try/finally
//
//   In-process cleanup cannot survive SIGKILL, by definition. A canary that
//   posts a resting bid and is then killed leaves that bid on the book with
//   nobody's cleanup path still running. The only thing that survives is
//   something written to disk BEFORE the action was sent.
//
//   So every on-chain action is journalled in three phases:
//
//     PENDING    written BEFORE the send. If the process dies here we do not
//                know whether it landed, so the sweep must CHECK THE CHAIN.
//     SENT       signature recorded, not yet confirmed.
//     CONFIRMED  landed; the expected on-chain state is now real.
//     CLEARED    the state this action created has been undone (cancelled), or
//                consumed (a bid that got filled — success, not an orphan).
//
//   PENDING is the state that matters. "I was about to send" is the only honest
//   thing you can write before sending, and it is exactly what a naive journal
//   omits — writing only after success leaves the killed-mid-send case invisible.
//
// TWO JOURNALS, ONE PER SIGNING HOST
//
//   The trigger owner (admin) signs locally; the bid counterparty (writer bot)
//   signs on the VPS, because its key is VPS-only and keys do not move. A sweep
//   can only cancel what its own key can sign for, so each host keeps its own
//   journal and sweeps its own state. Neither can clean up the other's.
// =============================================================================

import * as fs from "fs";
import * as path from "path";

export type ActionKind = "bid-post" | "trigger-place" | "bid-cancel" | "trigger-cancel";
export type ActionStatus = "PENDING" | "SENT" | "CONFIRMED" | "CLEARED" | "FAILED";

export interface JournalAction {
  seq: number;
  kind: ActionKind;
  /** Which key signs this — and therefore which sweep can undo it. */
  host: "local" | "box";
  status: ActionStatus;
  /** Enough to FIND the state on chain without re-deriving it from context. */
  expect: Record<string, string | number>;
  sig?: string;
  at: string;
  note?: string;
}

export interface JournalFile {
  runId: string;
  startedAt: string;
  roles: { owner: string; payer: string; counterparty: string };
  series: { optionMint: string; vault: string; market: string; asset: string };
  actions: JournalAction[];
  finishedAt?: string;
  outcome?: string;
}

export function journalPath(dir: string, runId: string): string {
  return path.join(dir, `canary-${runId}.json`);
}

export function initJournal(
  file: string,
  runId: string,
  roles: JournalFile["roles"],
  series: JournalFile["series"],
): JournalFile {
  const j: JournalFile = {
    runId, startedAt: new Date().toISOString(), roles, series, actions: [],
  };
  writeJournal(file, j);
  return j;
}

/** fsync so a kill immediately after the call cannot lose the record. A journal
 *  that is still in the page cache when the process dies is not a journal. */
export function writeJournal(file: string, j: JournalFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeSync(fd, JSON.stringify(j, null, 2));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  // Atomic replace: a reader never sees a half-written journal.
  fs.renameSync(tmp, file);
}

export function readJournal(file: string): JournalFile | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as JournalFile;
  } catch {
    return null;
  }
}

/** Record intent BEFORE sending. Returns the seq to update afterwards. */
export function recordPending(
  file: string, j: JournalFile, kind: ActionKind, host: "local" | "box",
  expect: JournalAction["expect"],
): number {
  const seq = j.actions.length + 1;
  j.actions.push({ seq, kind, host, status: "PENDING", expect, at: new Date().toISOString() });
  writeJournal(file, j);
  return seq;
}

export function updateAction(
  file: string, j: JournalFile, seq: number,
  patch: Partial<Pick<JournalAction, "status" | "sig" | "note">>,
): void {
  const a = j.actions.find((x) => x.seq === seq);
  if (!a) return;
  Object.assign(a, patch, { at: new Date().toISOString() });
  writeJournal(file, j);
}

/**
 * Actions that may have left on-chain state this host is responsible for.
 *
 * PENDING is included deliberately: we do not know whether it landed, and
 * assuming it did not is how an orphan survives. The sweep resolves the
 * uncertainty by looking at the chain, which is the only authority.
 */
export function needsSweep(j: JournalFile, host: "local" | "box"): JournalAction[] {
  const creating: ActionKind[] = ["bid-post", "trigger-place"];
  return j.actions.filter(
    (a) => a.host === host && creating.includes(a.kind)
      && (a.status === "PENDING" || a.status === "SENT" || a.status === "CONFIRMED"),
  );
}

/** Journals with anything left to resolve, oldest first. */
export function openJournals(dir: string, host: "local" | "box"): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.startsWith("canary-") && f.endsWith(".json"))
    .map((f) => path.join(dir, f))
    .filter((p) => {
      const j = readJournal(p);
      return !!j && needsSweep(j, host).length > 0;
    })
    .sort();
}
