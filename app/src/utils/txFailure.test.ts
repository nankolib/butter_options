// =============================================================================
// txFailure.test.ts — the retry fingerprint, the code extractor, the copy
// =============================================================================
//   run: node app/scripts/run-tx-failure-tests.mjs
//
// Every fixture below is a REAL string measured on 2026-08-12 against devnet,
// not an invented one. The two that matter most:
//
//   custom program error: 0x17ad  — Switchboard stale quote (Opta 6061)
//   custom program error: 0x1     — SPL Token, insufficient funds
//
// The first must retry and must NOT say "insufficient SOL". The second must do
// neither. The old code got both wrong with one substring test.
// =============================================================================

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ANCHOR_ERROR_BASE,
  extractProgramErrorCode,
  extractSimulationLogs,
  GENERIC_FAILURE_COPY,
  isNativeSolShortfall,
  isStaleQuoteFailure,
  SWITCHBOARD_VERIFY_FAILED,
} from "./txFailure";

// Measured fixtures ----------------------------------------------------------

/** Stale Switchboard quote, t+40s in the aging experiment. */
const STALE_QUOTE =
  "Simulation failed. Message: Transaction simulation failed: Error processing " +
  "Instruction 2: custom program error: 0x17ad. Logs: [" +
  "'Program log: AnchorError thrown in programs/opta/src/utils/price_oracle.rs:391. " +
  "Error Code: SwitchboardVerifyFailed. Error Number: 6061.'].";

/** SPL Token insufficient funds — the unfunded writer-ask vault, t+0s. */
const TOKEN_SHORT =
  "Simulation failed. Message: Transaction simulation failed: Error processing " +
  "Instruction 2: custom program error: 0x1. Logs: ['Program log: Error: insufficient funds'].";

/** SPL Token OwnerMismatch — the founder's reported "Program error 3". */
const TOKEN_OWNER_MISMATCH =
  "Simulation failed. Message: Transaction simulation failed: Error processing " +
  "Instruction 2: custom program error: 0x3.";

// ===========================================================================
// 1. CODE EXTRACTION — the substring bug, killed
// ===========================================================================

test("RED: 0x17ad is code 6061, NOT code 1", () => {
  // The bug: `msg.includes("0x1")` matched 0x17ad because "0x1" is a prefix of
  // it. Codes are numbers and must be compared as numbers.
  const code = extractProgramErrorCode(STALE_QUOTE);
  assert.equal(code, 6061);
  assert.notEqual(code, 1);
});

test("0x1 really is code 1", () => {
  assert.equal(extractProgramErrorCode(TOKEN_SHORT), 1);
});

test("0x3 really is code 3", () => {
  assert.equal(extractProgramErrorCode(TOKEN_OWNER_MISMATCH), 3);
});

test("the decimal Anchor rendering decodes to the same number", () => {
  assert.equal(extractProgramErrorCode("... Error Number: 6061. ..."), 6061);
});

test("no code present yields null rather than a wrong number", () => {
  for (const s of ["", "Blockhash not found", "User rejected the request.", null, undefined]) {
    assert.equal(extractProgramErrorCode(s), null, String(s));
  }
});

test("it reads a code off an Error object, not just a string", () => {
  assert.equal(extractProgramErrorCode(new Error(STALE_QUOTE)), 6061);
});

test("hex codes that merely CONTAIN a smaller code are not confused", () => {
  // 0x1770 = 6000, 0x17ad = 6061, 0x13 = 19. None of these is code 1.
  for (const [hex, want] of [["0x1770", 6000], ["0x17ad", 6061], ["0x13", 19], ["0x1", 1]] as const) {
    assert.equal(extractProgramErrorCode(`custom program error: ${hex}`), want, hex);
  }
});

// ===========================================================================
// 2. THE RETRY FINGERPRINT — Gate 3
// ===========================================================================

test("RED: a 0x3-class failure does NOT trigger a rebuild-retry", () => {
  // THE SECOND POPUP THAT COULD NEVER WORK. SPL Token OwnerMismatch is a verdict
  // on the transaction's merits; a fresh quote changes nothing, so asking the
  // user to approve again just spends their attention to fail identically.
  assert.equal(isStaleQuoteFailure(TOKEN_OWNER_MISMATCH), false);
  assert.equal(isStaleQuoteFailure(new Error(TOKEN_OWNER_MISMATCH)), false);
});

test("RED: an insufficient-funds failure does NOT trigger a rebuild-retry", () => {
  assert.equal(isStaleQuoteFailure(TOKEN_SHORT), false);
});

test("a stale quote DOES trigger a rebuild-retry — that is what a rebuild fixes", () => {
  assert.equal(isStaleQuoteFailure(STALE_QUOTE), true);
  assert.equal(isStaleQuoteFailure({ message: "SwitchboardVerifyFailed" }), true);
});

test("expired blockhashes still retry", () => {
  assert.equal(isStaleQuoteFailure({ name: "TransactionExpiredBlockheightExceededError" }), true);
  assert.equal(isStaleQuoteFailure({ name: "TransactionExpiredTimeoutError" }), true);
  assert.equal(isStaleQuoteFailure("block height exceeded"), true);
  assert.equal(isStaleQuoteFailure("Blockhash not found"), true);
});

test("a DROPPED transaction retries; landed and failed never do", () => {
  const mk = (kind: string, retryAllowed: boolean) =>
    ({ name: "TxOutcomeError", outcome: { kind }, retryAllowed });
  assert.equal(isStaleQuoteFailure(mk("dropped", true)), true);
  assert.equal(isStaleQuoteFailure(mk("dropped", false)), false);
  assert.equal(isStaleQuoteFailure(mk("landed", true)), false, "a landed tx must never be resent");
  assert.equal(isStaleQuoteFailure(mk("failed", true)), false, "a rejected tx must never be resent");
});

test("every Opta error EXCEPT the stale one is treated as final", () => {
  // 6028 OptionNotInTheMoney, 6012 InvalidPremium, 6014 self-trade — all real
  // verdicts. Only 6061 is a freshness problem.
  for (const code of [6000, 6012, 6014, 6028, 6051, 6052]) {
    assert.equal(
      isStaleQuoteFailure(`custom program error: 0x${code.toString(16)}`),
      false,
      `Opta ${code} must not retry`,
    );
  }
  assert.equal(isStaleQuoteFailure(`custom program error: 0x${(6061).toString(16)}`), true);
  assert.equal(SWITCHBOARD_VERIFY_FAILED, 6061);
  assert.ok(SWITCHBOARD_VERIFY_FAILED >= ANCHOR_ERROR_BASE);
});

test("a user rejection is not a stale quote", () => {
  assert.equal(isStaleQuoteFailure({ code: 4001, message: "User rejected the request." }), false);
});

// ===========================================================================
// 3. LOG CAPTURE — the evidence that was being thrown away
// ===========================================================================

test("simulation logs are recovered from a SendTransactionError-shaped object", () => {
  const err: any = new Error("Simulation failed.");
  err.logs = ["Program log: Instruction: ExerciseAmerican", "Program log: Error: insufficient funds"];
  const logs = extractSimulationLogs(err);
  assert.equal(logs?.length, 2);
  assert.match(logs![1], /insufficient funds/);
});

test("absent or empty logs yield null, not an empty array to misread", () => {
  assert.equal(extractSimulationLogs(new Error("x")), null);
  assert.equal(extractSimulationLogs({ logs: [] }), null);
  assert.equal(extractSimulationLogs(null), null);
});

test("non-string log entries are filtered rather than rendered", () => {
  assert.deepEqual(extractSimulationLogs({ logs: ["a", 5, null, "b"] }), ["a", "b"]);
});

// ===========================================================================
// 4. COPY — SOL vs USDC, and no raw codes
// ===========================================================================

test("RED: a stale quote is NOT a native-SOL shortfall", () => {
  // The old branch sent these users to top up SOL they already had.
  assert.equal(isNativeSolShortfall(STALE_QUOTE), false);
});

test("RED: a TOKEN shortfall is not a native-SOL shortfall either", () => {
  // "insufficient funds" from the token program is about a TOKEN account. The
  // remedy is different, so the sentence must be different.
  assert.equal(isNativeSolShortfall(TOKEN_SHORT), false);
});

test("a real SOL shortfall is recognised", () => {
  for (const s of [
    "Attempt to debit an account but found no record of a prior credit.",
    "Transaction results in an account with insufficient funds for rent",
    "insufficient lamports 890880, need 1000000",
  ]) {
    assert.equal(isNativeSolShortfall(s), true, s);
  }
});

test("the generic copy is a sentence, names no code, and promises nothing about cost", () => {
  assert.doesNotMatch(GENERIC_FAILURE_COPY, /\b0x|error \d|program error/i);
  // A landed-and-failed transaction DOES burn its fee, so this string must not
  // claim otherwise. See the constant's own note.
  assert.doesNotMatch(GENERIC_FAILURE_COPY, /charg|free|cost|fee/i);
  assert.doesNotMatch(GENERIC_FAILURE_COPY, /pyth|switchboard|hermes/i);
  assert.ok(GENERIC_FAILURE_COPY.trim().endsWith("."));
});
