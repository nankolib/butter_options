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

// =============================================================================
// Polling confirmation — do not let a websocket decide whether a trade worked
// =============================================================================
//
// THE INCIDENT THIS EXISTS FOR (prod, 2026-08-09):
//
//   EVERY market buy sat "Submitting…" for 30 seconds and then reported the
//   D2 fallback. The fallback was correct every time — the transactions had
//   landed in normal time — but a path built for the rare case was running at
//   a 100% rate, which means it was not the fallback, it was the mechanism.
//
//   Cause, measured rather than guessed. Anchor's sendAndConfirmRawTransaction
//   calls `connection.confirmTransaction(signature, commitment)` whenever no
//   blockhash is passed, and this app never passes one. That signature-only
//   overload selects web3.js's LEGACY strategy, whose only completion path is
//   `onSignature` — a websocket `signatureSubscribe`. It contains no HTTP
//   polling of any kind; its only other exit is a setTimeout. So if the socket
//   never opens, the strategy cannot succeed, only expire.
//
//   And the socket could not open: nginx fronting rpc.opta.fyi carried
//   `proxy_set_header Connection ""` with no `Upgrade` header, so the upgrade
//   was stripped and the handshake came back 404. web3.js logged "ws error:
//   Unexpected server response: 404" on a retry loop for the whole wait.
//
//   Three timings against the prod endpoint, same transaction:
//     getSignatureStatuses poll @1s      →    902 ms  (confirmed, first poll)
//     confirmTransaction(sig)            → 30 468 ms  TransactionExpiredTimeout
//     confirmTransaction({bh, lvbh})     → 50 008 ms  BlockheightExceeded
//
//   The third number is the one that matters for the fix: passing a blockhash
//   is NOT the answer. That strategy polls getBlockHeight only to decide when
//   to GIVE UP; the success signal is still `onSignature`. With a dead socket
//   it fails slower. HTTP polling for the status is the only strategy that
//   completes without a websocket.
//
// THE RULE: confirmation is a question the chain can answer over plain HTTP.
// Asking it that way costs one request per second and works whenever the RPC
// works at all. A websocket is an optimisation, never a dependency.
// =============================================================================

/** How often to ask, and how long before we call it dropped. The cap matches
 *  Anchor's own outer resend loop so a genuinely dropped transaction surfaces
 *  as `dropped` rather than being resent underneath us. */
export const POLL_INTERVAL_MS = 1000;
export const POLL_TIMEOUT_MS = 60_000;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Wait for `signature` to reach commitment by polling the chain.
 *
 * Returns the same three-way TxOutcome the rest of this module speaks, so a
 * caller never has to distinguish "the wait ended" from "the transaction
 * ended". `sleep` is injectable so the tests do not spend real seconds.
 */
export async function confirmByPolling(
  fetcher: StatusFetcher,
  signature: string,
  opts: {
    intervalMs?: number;
    timeoutMs?: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  } = {},
): Promise<TxOutcome> {
  const intervalMs = opts.intervalMs ?? POLL_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? POLL_TIMEOUT_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const now = opts.now ?? (() => Date.now());

  const started = now();
  let lastError: unknown = null;

  for (;;) {
    try {
      const st = (await fetcher.getStatuses([signature]))?.[0] ?? null;
      if (st) {
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
        // `confirmationStatus` is absent on some RPC shapes; a non-null status
        // with no error and confirmations settled is already good enough to
        // stop waiting, which is exactly what the legacy strategy would have
        // reported off the socket.
        const cs = st.confirmationStatus;
        if (cs === undefined || cs === "confirmed" || cs === "finalized") {
          return { kind: "landed", signature, slot: st.slot };
        }
      }
    } catch (e) {
      // A failed poll is not evidence of absence — keep asking until the
      // deadline, then report the lookup failure rather than inventing one.
      lastError = e;
    }

    if (now() - started >= timeoutMs) {
      return {
        kind: "dropped",
        signature,
        reason: lastError
          ? `status lookup kept failing (${(lastError as Error)?.message ?? lastError}) — the transaction may still have landed; check the signature before resending`
          : `not on chain after ${Math.round(timeoutMs / 1000)}s`,
      };
    }
    await sleep(intervalMs);
  }
}

/** The subset of Connection that the polling confirm actually needs. */
type ConfirmableConnection = Parameters<typeof statusFetcher>[0];

/**
 * Return `conn` with `confirmTransaction` replaced by the polling strategy.
 *
 * A Proxy rather than a subclass or Object.create: every other member is read
 * straight off the real Connection and bound to it, so all internal state and
 * private bookkeeping keep working and `instanceof Connection` still holds.
 * Nothing else about the connection changes.
 *
 * This is deliberately applied at the CONNECTION, not at the six prod-proven
 * fill paths: it fixes `.rpc()`, `sendAndConfirm`, and every direct
 * `confirmTransaction` call at once without altering a byte of what any of
 * them send.
 */
export function withPollingConfirm<T extends ConfirmableConnection>(
  conn: T,
  /** Poll tuning. Production passes nothing; the tests inject a clock so the
   *  dropped-case deadline does not cost them sixty real seconds. */
  pollOpts: Parameters<typeof confirmByPolling>[2] = {},
): T {
  const fetcher = statusFetcher(conn);

  const confirmTransaction = async (
    strategyOrSignature: string | { signature: string },
    _commitment?: string,
  ): Promise<{ context: { slot: number }; value: { err: unknown } }> => {
    const signature =
      typeof strategyOrSignature === "string"
        ? strategyOrSignature
        : strategyOrSignature?.signature;
    if (!signature) {
      throw new TxOutcomeError({
        kind: "dropped",
        signature: null,
        reason: "no signature to confirm",
      });
    }
    const outcome = await confirmByPolling(fetcher, signature, pollOpts);
    if (outcome.kind === "landed") {
      return { context: { slot: outcome.slot }, value: { err: null } };
    }
    if (outcome.kind === "failed") {
      // Hand the rejection back in the shape callers expect. Anchor turns this
      // into a ConfirmError and re-fetches logs, exactly as before.
      return { context: { slot: 0 }, value: { err: outcome.err } };
    }
    // Dropped. Thrown as a TxOutcomeError so it passes through
    // withResolvedOutcome untouched and reaches the user as a fact — and,
    // importantly, is NOT named TimeoutError, which Anchor would treat as a
    // cue to resend the transaction underneath us.
    throw new TxOutcomeError(outcome);
  };

  return new Proxy(conn, {
    get(target, prop, receiver) {
      if (prop === "confirmTransaction") return confirmTransaction;
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as T;
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
