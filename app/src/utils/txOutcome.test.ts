// =============================================================================
// txOutcome.test.ts — the 2026-08-08 double-post must not be reproducible
// =============================================================================
//
// THE INCIDENT, replayed by the first test exactly as it happened:
//
//   08:44:18  epoch write on SOL sent. Signature 3euJK36hdMPrDqBSuw…
//   08:44:48  client gives up waiting, shows "It is unknown if it succeeded or
//             failed."
//   08:44:18  ...but it had ALREADY landed. err: null. PostOrder, accepted.
//   08:45:44  founder retries, as the word "unknown" invites. Also lands.
//
//   Two RestingOrders on vault 8maLuYgF…, both 1 contract @ $3.164785, both
//   escrowing $75 collateral. $150 locked against a $75 intent.
//
// The confirmation timing out was cosmetic. The WORD was the defect. Every test
// below is about the second thing.
//
// Run: node app/scripts/run-tx-outcome-tests.mjs
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  describeOutcome,
  isConfirmationTimeout,
  outcomeOfSignature,
  resolveConfirmationError,
  retryAllowed,
  signatureFromError,
  TxOutcomeError,
  withResolvedOutcome,
  type SigStatus,
  type StatusFetcher,
} from "./txOutcome";

/** The real signature. Note the case: the incident was first reported as
 *  "3EUJK36H…", and base58 is case-sensitive, so two prefix searches for it
 *  found nothing. The chain spells it 3euJK36h. */
const SIG = "3euJK36hdMPrDqBSuwGkYPTaBqk6r8LrN9RCkX3vNvvJb1LqTfZmNfPfM4jyVYuNn2mHqYQeMmBLdRuHqzTNvGRj";

/** web3.js's stock timeout error, message text verbatim. */
function timeoutError(sig: string, withProperty = true): Error {
  const e = new Error(
    `Transaction was not confirmed in 30.00 seconds. It is unknown if it succeeded or failed. ` +
      `Check signature ${sig} using the Solana Explorer or CLI tools.`,
  );
  e.name = "TransactionExpiredTimeoutError";
  if (withProperty) (e as unknown as { signature: string }).signature = sig;
  return e;
}

const fetcher = (status: SigStatus | null, logs: string[] = []): StatusFetcher => ({
  getStatuses: async () => [status],
  getLogs: async () => logs,
});

const LANDED: SigStatus = { slot: 412_889_301, confirmations: null, err: null, confirmationStatus: "confirmed" };

// =============================================================================
// THE GUARANTEE
// =============================================================================

test("INCIDENT: confirm times out, the tx landed — report landed and REFUSE a retry", async () => {
  const outcome = await resolveConfirmationError(fetcher(LANDED), timeoutError(SIG));

  assert.equal(outcome.kind, "landed", "the transaction was on chain with err: null");
  assert.equal(
    retryAllowed(outcome),
    false,
    "a retry here is what escrowed $150 against a $75 intent — it must be blocked",
  );

  const msg = describeOutcome(outcome);
  assert.ok(
    !/unknown/i.test(msg),
    `the user-facing text still says "unknown" — that word is the defect: ${msg}`,
  );
  assert.match(msg, /do not resend/i, "it must actively tell the user not to do what they did");
});

test("INCIDENT variant: the adapter re-wrapped the error and lost .signature", async () => {
  // Some wallet adapters rebuild the error, dropping the property but keeping
  // the text. That is the case most likely to degrade back to "unknown", so the
  // message parse has to carry it alone.
  const outcome = await resolveConfirmationError(fetcher(LANDED), timeoutError(SIG, false));
  assert.equal(outcome.kind, "landed");
  assert.equal(retryAllowed(outcome), false);
});

test("a genuinely dropped transaction DOES allow a retry", async () => {
  // The counter-case. If this fails the module has traded a duplicate-send bug
  // for a stuck UI that can never resend anything.
  const outcome = await resolveConfirmationError(fetcher(null), timeoutError(SIG));
  assert.equal(outcome.kind, "dropped");
  assert.equal(retryAllowed(outcome), true);
  assert.match(describeOutcome(outcome), /safe to send again/i);
});

test("an on-chain REJECTION reports the program log, not a retry", async () => {
  const logs = [
    "Program CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq invoke [1]",
    "Program log: AnchorError occurred. Error Code: SelfTrade. Error Number: 6014.",
    "Program CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq failed",
  ];
  const failed: SigStatus = { slot: 1, confirmations: null, err: { InstructionError: [0, { Custom: 6014 }] } };
  const outcome = await resolveConfirmationError(fetcher(failed, logs), timeoutError(SIG));

  assert.equal(outcome.kind, "failed");
  assert.equal(retryAllowed(outcome), false, "a program rejection is not a dropped transaction");
  assert.match(describeOutcome(outcome), /6014|SelfTrade/, "the real program error must reach the user");
});

test("a status lookup that FAILS must not be reported as dropped-and-retryable", async () => {
  // The RPC being unreachable is not evidence the transaction is absent. During
  // the 2026-08-06 Helius outage this exact call would have 503'd, and treating
  // that as "dropped" would have authorized retries across the whole outage.
  const broken: StatusFetcher = {
    getStatuses: async () => {
      throw new Error('503 Service Unavailable: {"code":-32603}');
    },
  };
  const outcome = await resolveConfirmationError(broken, timeoutError(SIG));
  assert.match(
    outcome.kind === "dropped" ? outcome.reason : "",
    /may still have landed/i,
    "an unreachable RPC must be reported as unresolved, not as a safe retry",
  );
});

// =============================================================================
// ERROR CLASSIFICATION
// =============================================================================

test("classifies every shape the confirm path actually throws", () => {
  assert.ok(isConfirmationTimeout(timeoutError(SIG)), "web3.js timeout");

  const bh = new Error("Signature has expired: block height exceeded");
  bh.name = "TransactionExpiredBlockheightExceededError";
  assert.ok(isConfirmationTimeout(bh), "blockhash-strategy expiry");

  // The founder's create-market report used this wording.
  assert.ok(isConfirmationTimeout(new Error("Transaction expired")), "adapter wording");

  // A real rejection must NOT be swallowed as a timeout.
  assert.equal(
    isConfirmationTimeout(new Error("custom program error: 0x1782")),
    false,
    "a program rejection is not a timeout",
  );
});

test("recovers the signature from the message when the property is absent", () => {
  assert.equal(signatureFromError(timeoutError(SIG, false)), SIG);
  assert.equal(signatureFromError(timeoutError(SIG, true)), SIG);
  assert.equal(signatureFromError(new Error("nothing useful here")), null);
});

test("a non-timeout error passes through as failed, carrying its logs", async () => {
  const err = Object.assign(new Error("Transaction simulation failed"), {
    logs: ["Program log: Error Code: InvalidPremium. Error Number: 6012."],
  });
  const outcome = await resolveConfirmationError(fetcher(null), err);
  assert.equal(outcome.kind, "failed");
  assert.equal(retryAllowed(outcome), false);
  assert.match(describeOutcome(outcome), /6012|InvalidPremium/);
});

test("outcomeOfSignature searches history, so a just-landed tx is not read as dropped", async () => {
  // Regression guard for the argument, not the return: a status cache miss on a
  // transaction that landed seconds ago is the same false "dropped" that starts
  // the duplicate-send cycle.
  let sawArgs = false;
  const f: StatusFetcher = {
    getStatuses: async (sigs) => {
      sawArgs = sigs.length === 1 && sigs[0] === SIG;
      return [LANDED];
    },
  };
  const outcome = await outcomeOfSignature(f, SIG);
  assert.ok(sawArgs, "must query the exact signature");
  assert.equal(outcome.kind, "landed");
});

// =============================================================================
// THE WRAPPER — the seam every send path is wired through.
// =============================================================================

test("withResolvedOutcome converts the incident into a landed, non-retryable error", async () => {
  const conn = {
    getSignatureStatuses: async () => ({ value: [LANDED] }),
    getTransaction: async () => null,
  };
  await assert.rejects(
    () => withResolvedOutcome(conn, async () => { throw timeoutError(SIG); }),
    (e: TxOutcomeError) => {
      assert.equal(e.outcome.kind, "landed");
      assert.equal(e.retryAllowed, false, "the retry button must be disabled");
      assert.equal(e.signature, SIG, "the user needs the signature to verify");
      assert.ok(!/unknown/i.test(e.message), `still says unknown: ${e.message}`);
      return true;
    },
  );
});

test("withResolvedOutcome passes a real rejection straight through, untouched", async () => {
  // A program error is already a fact. Wrapping it would hide the AnchorError
  // shape that errorDecoder and every existing catch block rely on.
  const conn = {
    getSignatureStatuses: async () => {
      throw new Error("must not be called for a plain rejection");
    },
  };
  const original = Object.assign(new Error("custom program error: 0x1782"), { code: 6018 });
  await assert.rejects(
    () => withResolvedOutcome(conn, async () => { throw original; }),
    (e: Error) => e === original,
  );
});

test("withResolvedOutcome returns the value untouched on the happy path", async () => {
  const conn = { getSignatureStatuses: async () => ({ value: [null] }) };
  assert.equal(await withResolvedOutcome(conn, async () => "sig123"), "sig123");
});
