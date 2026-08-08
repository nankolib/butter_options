// =============================================================================
// txOutcome.ts — never tell a user "unknown if it succeeded or failed"
// =============================================================================
//
// THE INCIDENT THIS EXISTS FOR (founder smoke, 2026-08-08 08:44 UTC):
//
//   An epoch write on SOL was sent. The client waited, gave up, and showed
//   web3.js's stock message:
//
//     "Transaction was not confirmed in 30.00 seconds. It is unknown if it
//      succeeded or failed."
//
//   It had succeeded. Signature 3euJK36hdMPrDqBSuw…, err: null, landed at
//   08:44:18. The founder read "unknown", did the only sensible thing, and
//   retried. The retry ALSO succeeded, at 08:45:44. Two identical WriterAsks
//   now sit on that vault, 1 contract @ $3.164785 each, and $150 of collateral
//   is escrowed against a $75 intent.
//
//   The confirmation timing out was cosmetic. The word "unknown" was not: it is
//   what invited the second send. A client that had simply asked the chain
//   "did 3euJK36h land?" would have answered "yes" in one RPC call.
//
// THE RULE: a timeout is not an outcome, it is the absence of one. When the
// wait expires we ask the chain for the signature's status and report a FACT:
//
//   landed  — the transaction is on chain and succeeded. Say so. BLOCK retry.
//   failed  — on chain, but the program rejected it. Show the real logs.
//   dropped — genuinely not on chain. Retry is safe, and only here.
//
// Dependency-free and injectable (`getStatuses`), so the incident above is
// replayed as a unit test rather than re-lived. See txOutcome.test.ts.
// =============================================================================

/** Minimal shape of `connection.getSignatureStatuses(...).value[0]`. */
export interface SigStatus {
  slot: number;
  confirmations: number | null;
  err: unknown | null;
  confirmationStatus?: "processed" | "confirmed" | "finalized";
}

/** The only three things that can actually be true of a sent transaction. */
export type TxOutcome =
  | { kind: "landed"; signature: string; slot: number }
  | { kind: "failed"; signature: string; err: unknown; logs: string[] }
  | { kind: "dropped"; signature: string | null; reason: string };

/**
 * Pull the signature out of a confirmation error.
 *
 * web3.js attaches `.signature` to both TransactionExpiredTimeoutError and
 * TransactionExpiredBlockheightExceededError. Anchor re-throws them untouched,
 * so the property survives `provider.sendAndConfirm` and `.rpc()`.
 *
 * The message parse is a fallback, not the primary path: some wallet adapters
 * re-wrap the error and lose the property while keeping the text, which is
 * exactly the case that produced the incident's "unknown".
 */
export function signatureFromError(err: unknown): string | null {
  const e = err as { signature?: unknown; message?: unknown } | null;
  if (e && typeof e.signature === "string" && e.signature.length >= 32) return e.signature;
  const msg = typeof e?.message === "string" ? e.message : String(err ?? "");
  // "…Check signature 3euJK36h… using the Solana Explorer…"
  const m = /signature\s+([1-9A-HJ-NP-Za-km-z]{32,88})/.exec(msg);
  return m ? m[1] : null;
}

/**
 * Is this error the "we stopped waiting" case — as opposed to a real rejection?
 *
 * Deliberately matched on the TEXT as well as the class name. The classes are
 * not always reachable across bundling and wallet-adapter re-wrapping, and the
 * user-visible consequence of missing one is the exact "unknown" wording this
 * module exists to eliminate.
 */
export function isConfirmationTimeout(err: unknown): boolean {
  const e = err as { name?: unknown; message?: unknown } | null;
  const name = typeof e?.name === "string" ? e.name : "";
  if (name === "TransactionExpiredTimeoutError") return true;
  if (name === "TransactionExpiredBlockheightExceededError") return true;
  const msg = typeof e?.message === "string" ? e.message : String(err ?? "");
  if (/was not confirmed in [\d.]+ seconds/i.test(msg)) return true;
  if (/block height exceeded/i.test(msg)) return true;
  if (/Transaction expired/i.test(msg)) return true;
  return false;
}

export interface StatusFetcher {
  /** connection.getSignatureStatuses([sig], { searchTransactionHistory: true }) */
  getStatuses(sigs: string[]): Promise<(SigStatus | null)[]>;
  /** connection.getTransaction(sig, …) — logs for the `failed` case. */
  getLogs?(sig: string): Promise<string[]>;
}

/**
 * Ask the chain what actually happened to `signature`.
 *
 * `searchTransactionHistory` matters: a transaction that landed slightly before
 * we asked can already have fallen out of the recent-status cache, and without
 * the history search it reads as null — i.e. "dropped" — which would re-invite
 * the duplicate send this module prevents.
 */
export async function outcomeOfSignature(
  fetcher: StatusFetcher,
  signature: string,
): Promise<TxOutcome> {
  let statuses: (SigStatus | null)[];
  try {
    statuses = await fetcher.getStatuses([signature]);
  } catch (e) {
    // We could not ask. That is NOT evidence the transaction is absent, and
    // calling it "dropped" would authorize a retry we have not earned.
    return {
      kind: "dropped",
      signature,
      reason: `status lookup failed (${(e as Error)?.message ?? e}) — the transaction may still have landed; check the signature before resending`,
    };
  }

  const st = statuses?.[0] ?? null;
  if (!st) {
    return { kind: "dropped", signature, reason: "not found on chain" };
  }
  if (st.err) {
    let logs: string[] = [];
    if (fetcher.getLogs) {
      try {
        logs = await fetcher.getLogs(signature);
      } catch {
        logs = [];
      }
    }
    return { kind: "failed", signature, err: st.err, logs };
  }
  return { kind: "landed", signature, slot: st.slot };
}

/**
 * Resolve a confirmation error into a fact.
 *
 * Non-timeout errors are rejections we already understand — they pass straight
 * through as `failed`. Only the "we stopped waiting" case triggers a lookup.
 */
export async function resolveConfirmationError(
  fetcher: StatusFetcher,
  err: unknown,
): Promise<TxOutcome> {
  const sig = signatureFromError(err);

  if (!isConfirmationTimeout(err)) {
    return { kind: "failed", signature: sig ?? "", err, logs: extractLogs(err) };
  }
  if (!sig) {
    // Timed out with no signature to check. Rare, and the one case where we
    // genuinely cannot tell — so say that, and still do not invite a retry.
    return {
      kind: "dropped",
      signature: null,
      reason: "confirmation timed out before a signature was available",
    };
  }
  return outcomeOfSignature(fetcher, sig);
}

/**
 * Adapt a web3.js Connection to StatusFetcher. Duck-typed on purpose — importing
 * @solana/web3.js here would drag a runtime dependency into a module whose whole
 * value is being testable without one.
 */
export function statusFetcher(conn: {
  getSignatureStatuses(
    sigs: string[],
    cfg?: { searchTransactionHistory?: boolean },
  ): Promise<{ value: (SigStatus | null)[] }>;
  getTransaction?(
    sig: string,
    cfg?: { commitment?: string; maxSupportedTransactionVersion?: number },
  ): Promise<{ meta?: { logMessages?: string[] | null } | null } | null>;
}): StatusFetcher {
  return {
    async getStatuses(sigs) {
      // searchTransactionHistory: see outcomeOfSignature — without it a tx that
      // landed moments ago can read as absent.
      const r = await conn.getSignatureStatuses(sigs, { searchTransactionHistory: true });
      return r.value;
    },
    async getLogs(sig) {
      if (!conn.getTransaction) return [];
      const tx = await conn.getTransaction(sig, {
        commitment: "confirmed",
        maxSupportedTransactionVersion: 0,
      });
      return tx?.meta?.logMessages ?? [];
    },
  };
}

/** An Error whose message is a FACT about the chain, with the outcome attached
 *  so a UI can block its retry button rather than parse prose. */
export class TxOutcomeError extends Error {
  readonly outcome: TxOutcome;
  readonly signature: string | null;
  readonly retryAllowed: boolean;
  constructor(outcome: TxOutcome) {
    super(describeOutcome(outcome));
    this.name = "TxOutcomeError";
    this.outcome = outcome;
    this.signature = outcome.signature || null;
    this.retryAllowed = retryAllowed(outcome);
  }
}

/**
 * Wrap ANY send path — Anchor `.rpc()`, `provider.sendAndConfirm`, or a raw
 * send+confirm — so a confirmation timeout is resolved into a fact before it
 * reaches the user.
 *
 * This is deliberately a catch-side decorator. It builds no instructions, signs
 * nothing, and changes no account list, so it can go around the prod-proven fill
 * paths without altering a byte of what they send.
 *
 * A `landed` outcome is still thrown, not returned: the caller asked to confirm
 * and we could not, so the optimistic path must not continue as if it had. But
 * the error now says the transaction succeeded and carries retryAllowed=false.
 */
export async function withResolvedOutcome<T>(
  conn: Parameters<typeof statusFetcher>[0],
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof TxOutcomeError) throw err;
    if (!isConfirmationTimeout(err)) throw err; // a real rejection, untouched
    throw new TxOutcomeError(await resolveConfirmationError(statusFetcher(conn), err));
  }
}

/** Program logs off a thrown SendTransactionError / AnchorError, if present. */
export function extractLogs(err: unknown): string[] {
  const e = err as { logs?: unknown; transactionLogs?: unknown } | null;
  if (Array.isArray(e?.logs)) return e!.logs as string[];
  if (Array.isArray(e?.transactionLogs)) return e!.transactionLogs as string[];
  return [];
}

/**
 * May the caller offer a retry button?
 *
 * ONLY for `dropped`. A landed transaction retried is a duplicate position — on
 * the write path specifically, a second WriterAsk escrowing a second lot of
 * collateral. This is the whole point of the module.
 */
export function retryAllowed(outcome: TxOutcome): boolean {
  return outcome.kind === "dropped";
}

/** User-facing sentence. Never contains the word "unknown". */
export function describeOutcome(outcome: TxOutcome): string {
  switch (outcome.kind) {
    case "landed":
      return `Confirmed on chain (slot ${outcome.slot}). It just took longer than the wait — do not resend.`;
    case "failed":
      return outcome.logs.length > 0
        ? `Rejected on chain: ${summarizeLogs(outcome.logs)}`
        : "Rejected on chain.";
    case "dropped":
      return `Not on chain — ${outcome.reason}. Safe to send again.`;
  }
}

/**
 * Last meaningful program log line — the part a user can act on.
 *
 * The runtime's own trailing line, "Program <id> failed: custom program error",
 * is skipped: it always matches an error search and always ends the log, so a
 * naive backwards scan returns it every time and tells the user nothing. The
 * line that matters is the `Program log:` the program emitted just before —
 * "Error Code: SelfTrade. Error Number: 6014."
 */
const RUNTIME_TAIL = /^Program [1-9A-HJ-NP-Za-km-z]{32,44} (failed|consumed|success)/i;

function summarizeLogs(logs: string[]): string {
  const meaningful = logs.filter((l) => !RUNTIME_TAIL.test(l.trim()));
  for (let i = meaningful.length - 1; i >= 0; i--) {
    const l = meaningful[i];
    if (/Error|panicked|insufficient/i.test(l)) return l.trim();
  }
  return meaningful[meaningful.length - 1]?.trim() ?? logs[logs.length - 1]?.trim() ?? "";
}
