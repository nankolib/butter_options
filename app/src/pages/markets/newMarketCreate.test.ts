// =============================================================================
// newMarketCreate.test.ts — SLICE 2A: the create-market retry contract
// =============================================================================
//
//   run: node app/scripts/run-create-retry-tests.mjs
//
// THE REGRESSION THIS PINS. `62f228e` (2026-06-28) taught the SB arm to auto-
// refetch a fresh tx when a slow wallet approve let the quote/blockhash expire,
// replacing an opaque "Program error 3" with one silent retry. It worked.
//
// Then D2/G1 (2026-08-06/09) wrapped every connection in `withPollingConfirm`,
// which — correctly, for its own purpose — stopped throwing web3.js's
// `TransactionExpiredBlockheightExceededError` and started throwing a
// `TxOutcomeError` instead, precisely so Anchor would not resend underneath it.
// `isStaleSubmitError` matches on error NAME and MESSAGE TEXT, and the new error
// carries neither fingerprint: its name is "TxOutcomeError" and its message is
// "Not on chain — not found on chain. Safe to send again."
//
// So the retry silently stopped firing on the confirm leg — the exact
// slow-approve case it was built for. Nothing failed loudly; the user just got a
// dead end again. These tests fail against the pre-fix predicate.
//
// The fix reads the STRUCTURED outcome (kind === "dropped" && retryAllowed)
// rather than adding a third magic string, because the string is prose and the
// outcome is data.
// =============================================================================

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  isStaleSubmitError,
  isUserRejection,
  submitPythCreateWithRetry,
} from "./newMarketCreate";

// ---- Fixtures ---------------------------------------------------------------

/** The shape withPollingConfirm throws. Duck-typed exactly as production emits
 *  it — name + outcome + retryAllowed — so this test would catch a rename. */
function txOutcomeError(
  kind: "dropped" | "landed" | "failed",
  message: string,
): Error & { outcome: { kind: string }; retryAllowed: boolean } {
  const e = new Error(message) as any;
  e.name = "TxOutcomeError";
  e.outcome = { kind, signature: kind === "dropped" ? null : "sig123" };
  e.retryAllowed = kind === "dropped";
  return e;
}

// ============================================================================
// THE REGRESSION — a dropped TxOutcomeError must count as stale.
// ============================================================================

test("RED: a dropped TxOutcomeError is stale (this is the regression)", () => {
  const e = txOutcomeError("dropped", "Not on chain — not found on chain. Safe to send again.");
  assert.equal(
    isStaleSubmitError(e),
    true,
    "the slow-approve case now arrives as TxOutcomeError; not matching it silently kills the retry",
  );
});

test("a LANDED TxOutcomeError is NOT stale — retrying would double-create", () => {
  const e = txOutcomeError("landed", "Confirmed on chain (slot 42). It just took longer than the wait — do not resend.");
  assert.equal(isStaleSubmitError(e), false, "the market already exists; a retry is a second create");
});

test("a FAILED TxOutcomeError is NOT stale — the program rejected it", () => {
  const e = txOutcomeError("failed", "Rejected on chain: Error Code: AssetMismatch.");
  assert.equal(isStaleSubmitError(e), false);
});

test("retryAllowed is honoured even if kind is somehow dropped", () => {
  const e = txOutcomeError("dropped", "x");
  (e as any).retryAllowed = false;
  assert.equal(isStaleSubmitError(e), false, "both signals must agree before we resend");
});

// ============================================================================
// The pre-existing fingerprints must all still work — the fix ADDS, never
// narrows. A regression here would re-open the original "Program error 3".
// ============================================================================

for (const [label, err] of [
  ["blockheight class", Object.assign(new Error("x"), { name: "TransactionExpiredBlockheightExceededError" })],
  ["timeout class", Object.assign(new Error("x"), { name: "TransactionExpiredTimeoutError" })],
  ["block height text", new Error("Transaction was not confirmed: block height exceeded")],
  ["blockhash not found", new Error("failed to send: Blockhash not found")],
  ["GOLD5 0x3", new Error("Simulation failed. Message: ... custom program error: 0x3.")],
  ["phantom sim refusal", new Error("Failed to simulate transaction")],
  ["sb verify", new Error("SwitchboardVerifyFailed")],
] as const) {
  test(`still stale: ${label}`, () => {
    assert.equal(isStaleSubmitError(err), true);
  });
}

test("a genuine Opta program error is NEVER stale", () => {
  // Opta's enum is 6000+ (0x1770+), so a real create failure decodes to a
  // message — it can never look like the 0x3 fingerprint.
  assert.equal(isStaleSubmitError(new Error("custom program error: 0x1776")), false);
  assert.equal(isStaleSubmitError(new Error("Error Code: AssetMismatch. Error Number: 6009.")), false);
});

test("a user rejection is never stale (and is detected first)", () => {
  assert.equal(isUserRejection({ code: 4001 }), true);
  assert.equal(isStaleSubmitError(new Error("User rejected the request")), false);
});

// ============================================================================
// PYTH ARM — its first retry ever. Same single-refetch policy as the SB arm.
// ============================================================================

test("Pyth arm: a successful submit builds ONCE and never retries", async () => {
  let builds = 0;
  let submits = 0;
  const sig = await submitPythCreateWithRetry({
    build: async () => {
      builds += 1;
      return "TXS" as never;
    },
    submit: async () => {
      submits += 1;
      return "sig-ok";
    },
  });
  assert.equal(sig, "sig-ok");
  assert.equal(builds, 1);
  assert.equal(submits, 1);
});

test("RED: Pyth arm REBUILDS on a stale failure — a fresh price update, not a resend", async () => {
  // The whole point: a Pyth create carries a Hermes price update and a blockhash.
  // Resending the SAME signed tx after expiry is guaranteed to fail again, so the
  // retry must go all the way back to `build`.
  let builds = 0;
  let submits = 0;
  const sig = await submitPythCreateWithRetry({
    build: async () => {
      builds += 1;
      return `TXS${builds}` as never;
    },
    submit: async (txs: string) => {
      submits += 1;
      if (submits === 1) throw txOutcomeError("dropped", "Not on chain — not found on chain.");
      assert.equal(txs, "TXS2", "the retry must submit the FRESHLY built txs, never the stale ones");
      return "sig-retry";
    },
  });
  assert.equal(sig, "sig-retry");
  assert.equal(builds, 2, "build must run again — a fresh price update and blockhash");
  assert.equal(submits, 2);
});

test("Pyth arm: retries exactly ONCE, then propagates", async () => {
  let builds = 0;
  await assert.rejects(
    submitPythCreateWithRetry({
      build: async () => {
        builds += 1;
        return "TXS" as never;
      },
      submit: async () => {
        throw txOutcomeError("dropped", "Not on chain.");
      },
    }),
    /Not on chain/,
  );
  assert.equal(builds, 2, "two attempts total, never a loop");
});

test("Pyth arm: a NON-stale failure fails fast with no rebuild", async () => {
  let builds = 0;
  await assert.rejects(
    submitPythCreateWithRetry({
      build: async () => {
        builds += 1;
        return "TXS" as never;
      },
      submit: async () => {
        throw new Error("Error Code: AssetMismatch. Error Number: 6009.");
      },
    }),
    /AssetMismatch/,
  );
  assert.equal(builds, 1, "a real program rejection must not be retried");
});

test("Pyth arm: a user rejection fails fast and is not retried", async () => {
  let builds = 0;
  await assert.rejects(
    submitPythCreateWithRetry({
      build: async () => {
        builds += 1;
        return "TXS" as never;
      },
      submit: async () => {
        throw Object.assign(new Error("User rejected the request"), { code: 4001 });
      },
    }),
    /rejected/i,
  );
  assert.equal(builds, 1);
});

test("Pyth arm: onRefetch fires before the second wallet prompt", async () => {
  // A second wallet popup with no explanation reads as a bug. The caller uses
  // this to say why it is appearing.
  const events: string[] = [];
  let submits = 0;
  await submitPythCreateWithRetry({
    build: async () => {
      events.push("build");
      return "TXS" as never;
    },
    submit: async () => {
      submits += 1;
      events.push("submit");
      if (submits === 1) throw txOutcomeError("dropped", "Not on chain.");
      return "ok";
    },
    onRefetch: () => events.push("onRefetch"),
  });
  assert.deepEqual(events, ["build", "submit", "onRefetch", "build", "submit"]);
});
