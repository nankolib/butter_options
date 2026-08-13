// =============================================================================
// txFailure.ts — reading a failed transaction honestly
// =============================================================================
//
// Three jobs, all of which went wrong at once on 2026-08-12 and cost a founder
// two wallet popups and a meaningless toast:
//
//  1. EXTRACT the on-chain error code precisely.
//  2. DECIDE whether a rebuild could possibly fix it (the retry fingerprint).
//  3. KEEP the simulation logs, which are the only evidence of what happened.
//
// ── WHY THIS IS NOT IN errorDecoder.ts ─────────────────────────────────────
// errorDecoder maps codes to user copy. This module answers a different
// question — "can we retry, and what actually failed" — and both the create
// path and the portfolio need it without pulling the IDL. Keeping them apart
// is what lets this one be tested against fixtures with no JSON import.
//
// ── THE SUBSTRING BUG THIS RETIRES ─────────────────────────────────────────
// errorDecoder previously branched on `msg.includes("0x1")`. That is a
// SUBSTRING test, and `custom program error: 0x17ad` — the Switchboard
// stale-quote failure, Opta error 6061 — contains it. So every stale quote
// rendered as "Insufficient SOL for transaction fees.", sending users to buy
// SOL they already had. Codes are numbers; compare them as numbers.
// =============================================================================

/** `custom program error: 0x…` — the canonical form in a SendTransactionError. */
const CUSTOM_CODE_RE = /custom program error:\s*0x([0-9a-f]+)/i;
/** Anchor's decimal rendering, used when the SDK has already decoded it. */
const ANCHOR_CODE_RE = /error number:\s*(\d+)/i;

/** Anchor user-error space. Anything below this came from some OTHER program in
 *  the transaction (SPL Token, a precompile), not from Opta. */
export const ANCHOR_ERROR_BASE = 6000;

/**
 * The on-chain error code, as a NUMBER, or null. Handles both the hex
 * `custom program error: 0x17ad` and decimal `Error Number: 6061` renderings,
 * which are the same failure written two ways.
 */
export function extractProgramErrorCode(input: unknown): number | null {
  const msg = String((input as any)?.message ?? input ?? "");
  const hex = msg.match(CUSTOM_CODE_RE);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return Number.isFinite(n) ? n : null;
  }
  const dec = msg.match(ANCHOR_CODE_RE);
  if (dec) {
    const n = parseInt(dec[1], 10);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Simulation logs off a web3.js SendTransactionError (or anything carrying a
 * `logs` array). These are discarded today, which is precisely why the
 * 2026-08-12 failure could not be diagnosed after the fact: the transaction
 * never landed, so the chain has no record, and the only witness was thrown
 * away. Retained for console/structured diagnosis — NEVER rendered to a user.
 */
export function extractSimulationLogs(err: unknown): string[] | null {
  const logs = (err as any)?.logs;
  if (Array.isArray(logs) && logs.length > 0) {
    return logs.filter((l) => typeof l === "string");
  }
  return null;
}

/** The Opta error a stale Switchboard quote produces (0x17ad). */
export const SWITCHBOARD_VERIFY_FAILED = 6061;

/**
 * Can a REBUILD fix this? The retry fingerprint, narrowed.
 *
 * ── WHAT WENT WRONG ────────────────────────────────────────────────────────
 * The create path's `isStaleSubmitError` matches `custom program error: 0x3`,
 * on the stated reasoning that "the Opta enum is 6000+, so a real on-chain
 * failure decodes to a message, never 0x3". That reasoning is sound for a
 * CREATE transaction, whose only programs are ComputeBudget, the ed25519
 * precompile and Opta.
 *
 * It does NOT hold for an EXERCISE transaction, which additionally invokes
 * SPL Token and Token-2022 — and SPL Token's error 3 is `OwnerMismatch`, a
 * permanent, non-retryable failure. Measured 2026-08-12: the same transaction
 * shape returns SPL Token `Custom:1` when the paying account is short. So on
 * the exercise path a low code is evidence of a token-program failure, and
 * retrying it just spends a second wallet approval to fail identically.
 *
 * Hence: this predicate is TRUE only for things a fresh build genuinely fixes —
 * an expired blockhash, a dropped transaction, an aged oracle quote — and
 * explicitly FALSE for low-numbered codes from other programs.
 */
export function isStaleQuoteFailure(e: any): boolean {
  const name = String(e?.name ?? "");

  // Structured outcome first — data beats prose. Only a genuinely-absent
  // transaction may be rebuilt; `landed` and `failed` must never retry.
  if (name === "TxOutcomeError") {
    return e?.outcome?.kind === "dropped" && e?.retryAllowed === true;
  }
  if (
    name === "TransactionExpiredBlockheightExceededError" ||
    name === "TransactionExpiredTimeoutError"
  ) {
    return true;
  }

  const code = extractProgramErrorCode(e);
  if (code !== null) {
    // A real program error. Retry ONLY the aged-quote one; everything else is a
    // verdict on the transaction's merits and will repeat.
    return code === SWITCHBOARD_VERIFY_FAILED;
  }

  const msg = String(e?.message ?? e ?? "").toLowerCase();
  return (
    msg.includes("block height exceeded") ||
    msg.includes("blockhash not found") ||
    msg.includes("transactionexpired") ||
    msg.includes("switchboardverifyfailed")
  );
}

// ---- honest copy ------------------------------------------------------------

/** Native-SOL shortfalls, which are NOT token-balance shortfalls. The runtime
 *  words them distinctly; the token programs say "insufficient funds" about a
 *  TOKEN account, which is a completely different remedy for the user. */
export function isNativeSolShortfall(input: unknown): boolean {
  const msg = String((input as any)?.message ?? input ?? "").toLowerCase();
  return (
    msg.includes("insufficient lamports") ||
    msg.includes("insufficient funds for fee") ||
    msg.includes("insufficient funds for rent") ||
    msg.includes("debit an account but found no record of a prior credit")
  );
}

/**
 * What to tell a user about a code we have no mapping for.
 *
 * The old fallback returned `Program error ${code}`, which is not English, not
 * actionable, and leaks an implementation detail into a toast. A user cannot do
 * anything with "3". They can act on "try again".
 *
 * DELIBERATELY SILENT ON COST. An earlier draft of this string said "nothing was
 * charged". That is true when the failure came from PREFLIGHT (no transaction is
 * transmitted, so no fee) — which is what happened on 2026-08-12 — but false
 * when a transaction lands and then fails, where the fee is burned. Copy that is
 * right most of the time is still copy that lies sometimes, so this says nothing
 * about cost at all. If we later distinguish the two cases, they get two strings.
 */
export const GENERIC_FAILURE_COPY =
  "That transaction didn't go through. Please try again.";
