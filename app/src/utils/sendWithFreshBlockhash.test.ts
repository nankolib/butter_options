// ============================================================================
// sendWithFreshBlockhash.test.ts — the expiry retry, and the double-fill it
// must never cause
// ============================================================================
// Vanilla TS + node:assert (no framework), same shape as marketSweep.test.ts.
// Everything the helper touches is injected, so these cases run in milliseconds
// and cover the one outcome that costs real money: asking for a SECOND wallet
// signature for a transaction that already landed.
//
// Run (ESM/TS): npx --yes tsx app/src/utils/sendWithFreshBlockhash.test.ts
// ============================================================================

import assert from "node:assert/strict";
import { utils } from "@coral-xyz/anchor";
import {
  sendWithFreshBlockhash,
  classifySendFailure,
  isUserRejection,
  APPROVAL_TOO_SLOW,
  type SendPhase,
} from "./sendWithFreshBlockhash";

// ---- Tiny async runner -----------------------------------------------------
type Test = { name: string; fn: () => Promise<void> | void };
const tests: Test[] = [];
const test = (name: string, fn: () => Promise<void> | void): void => { tests.push({ name, fn }); };

// ---- Fakes -----------------------------------------------------------------
const sigBytes = (n: number): Uint8Array => Uint8Array.from(Array.from({ length: 64 }, (_, i) => (i === 0 ? n : i)));
const sigOf = (n: number): string => utils.bytes.bs58.encode(Buffer.from(sigBytes(n)));

/** Preflight rejection, verbatim shape of what prod threw on 2026-08-14. */
const blockhashNotFound = (): Error =>
  new Error("Simulation failed. \nMessage: Transaction simulation failed: Blockhash not found. \nLogs: []. ");

interface Harness {
  provider: any;
  makeTx: () => any;
  phases: SendPhase[];
  signCount: () => number;
  sendCount: () => number;
}

function harness(opts: {
  /** One entry per send attempt: "ok" | Error to throw. */
  sends: (("ok" | Error))[];
  /** Signature statuses by signature string (absent = not on chain). */
  onChain?: Record<string, { slot: number; err?: unknown }>;
  /** Throw from signTransaction on attempt N (1-based). */
  signThrows?: Record<number, Error>;
  /** Simulated wall-clock added by each signTransaction call, ms. */
  signTakesMs?: number[];
  blockHeight?: number;
  lastValidBlockHeight?: number;
}): Harness {
  let signs = 0;
  let sends = 0;
  let clock = 1_000_000;
  const phases: SendPhase[] = [];
  const onChain = opts.onChain ?? {};

  const connection = {
    async getLatestBlockhash() {
      return { blockhash: `bh${signs}`, lastValidBlockHeight: opts.lastValidBlockHeight ?? 1_000 };
    },
    async getBlockHeight() {
      return opts.blockHeight ?? 500;
    },
    async sendRawTransaction() {
      const outcome = opts.sends[sends] ?? "ok";
      sends += 1;
      if (outcome !== "ok") throw outcome;
      return sigOf(sends);
    },
    async getSignatureStatuses(sigs: string[]) {
      return {
        value: sigs.map((s) => {
          const hit = onChain[s];
          return hit ? { slot: hit.slot, confirmations: 1, err: hit.err ?? null, confirmationStatus: "confirmed" as const } : null;
        }),
      };
    },
    async getTransaction() {
      return { meta: { logMessages: ["Program log: Error Code: SelfTrade. Error Number: 6014."] } };
    },
  };

  const wallet = {
    publicKey: { toBase58: () => "PAYER" } as any,
    async signTransaction(tx: any) {
      signs += 1;
      const boom = opts.signThrows?.[signs];
      if (boom) throw boom;
      clock += opts.signTakesMs?.[signs - 1] ?? 50;
      tx.signature = sigBytes(signs);
      return tx;
    },
  };

  return {
    provider: { connection, wallet, now: () => clock },
    makeTx: () => ({ feePayer: null, recentBlockhash: undefined, signature: null, serialize: () => new Uint8Array([1, 2, 3]) }),
    phases,
    signCount: () => signs,
    sendCount: () => sends,
  };
}

const run = (h: Harness) =>
  sendWithFreshBlockhash(h.provider, h.makeTx, {
    onPhase: (p) => h.phases.push(p),
    now: h.provider.now,
  });

// ---- Classifier ------------------------------------------------------------
test("classifySendFailure: the prod preflight rejection is `expired`", () => {
  assert.equal(classifySendFailure(blockhashNotFound()), "expired");
});

test("classifySendFailure: block height exceeded is `expired`", () => {
  const e = new Error("Signature abc has expired: block height exceeded.");
  e.name = "TransactionExpiredBlockheightExceededError";
  assert.equal(classifySendFailure(e), "expired");
});

test("classifySendFailure: a program revert is NOT expired", () => {
  assert.equal(
    classifySendFailure(new Error("failed to send transaction: custom program error: 0x1772")),
    "unknown",
  );
});

test("isUserRejection: Phantom's decline", () => {
  const e: any = new Error("User rejected the request.");
  e.code = 4001;
  assert.equal(isUserRejection(e), true);
  assert.equal(isUserRejection(blockhashNotFound()), false);
});

// ---- Happy path ------------------------------------------------------------
test("fast approval: one prompt, one send, phases in order", async () => {
  const h = harness({ sends: ["ok"], onChain: { [sigOf(1)]: { slot: 7 } } });
  const sig = await run(h);
  assert.equal(sig, sigOf(1));
  assert.equal(h.signCount(), 1);
  assert.equal(h.sendCount(), 1);
  assert.deepEqual(h.phases, ["awaiting", "submitting", "confirming"]);
});

// ---- The retry -------------------------------------------------------------
test("expired preflight + tx never landed: re-prompts ONCE and lands", async () => {
  const h = harness({
    sends: [blockhashNotFound(), "ok"],
    onChain: { [sigOf(2)]: { slot: 9 } }, // only the SECOND signature is on chain
  });
  const sig = await run(h);
  assert.equal(sig, sigOf(2));
  assert.equal(h.signCount(), 2, "exactly one re-prompt");
  assert.ok(h.phases.includes("resigning"), "user is told a second prompt is coming");
});

test("ANTI-DOUBLE-FILL: expired preflight but the tx DID land — no second prompt", async () => {
  const h = harness({
    sends: [blockhashNotFound()],
    onChain: { [sigOf(1)]: { slot: 11 } }, // the first attempt is on chain after all
  });
  const sig = await run(h);
  assert.equal(sig, sigOf(1), "reports the signature that landed");
  assert.equal(h.signCount(), 1, "MUST NOT ask the wallet to sign again");
  assert.equal(h.sendCount(), 1, "MUST NOT resend");
});

test("slow approval past lastValidBlockHeight: skips the doomed send entirely", async () => {
  const h = harness({
    sends: ["ok"],                       // the only send is the RETRY's
    signTakesMs: [90_000, 50],           // 90 s in Phantom, then a fast re-sign
    blockHeight: 2_000,
    lastValidBlockHeight: 1_000,         // blockhash is dead before we ever send
    onChain: { [sigOf(1)]: { slot: 13 } },
  });
  const sig = await run(h);
  assert.equal(h.signCount(), 2, "re-prompted");
  assert.equal(h.sendCount(), 1, "never sent a transaction the network would refuse");
  assert.equal(sig, sigOf(1));
});

// ---- Failure surfaces ------------------------------------------------------
test("second attempt also expires: clean message, never the raw error", async () => {
  const h = harness({ sends: [blockhashNotFound(), blockhashNotFound()] });
  await assert.rejects(run(h), (e: Error) => {
    assert.equal(e.message, APPROVAL_TOO_SLOW);
    assert.ok(!/Blockhash not found/i.test(e.message), "raw SendTransactionError text must not leak");
    return true;
  });
  assert.equal(h.signCount(), 2, "at most one auto-retry");
});

test("user declines the first prompt: the rejection passes through untouched", async () => {
  const boom: any = new Error("User rejected the request.");
  boom.code = 4001;
  const h = harness({ sends: ["ok"], signThrows: { 1: boom } });
  await assert.rejects(run(h), /User rejected/);
  assert.equal(h.signCount(), 1);
});

test("user declines the RE-prompt: still the rejection, not 'took too long'", async () => {
  const boom: any = new Error("User rejected the request.");
  boom.code = 4001;
  const h = harness({ sends: [blockhashNotFound()], signThrows: { 2: boom } });
  await assert.rejects(run(h), /User rejected/);
});

test("a non-expiry send failure is not retried and is not rewritten", async () => {
  const h = harness({ sends: [new Error("failed to send transaction: custom program error: 0x1772")] });
  await assert.rejects(run(h), /0x1772/);
  assert.equal(h.signCount(), 1, "no retry on a real rejection");
});

test("a program revert on the RETRY is summarised, not swallowed as 'took too long'", async () => {
  const revert: any = new Error("Simulation failed.");
  // Runtime shape: the trailing line carries the FULL program id, which is what
  // txOutcome's RUNTIME_TAIL filter keys off. A truncated id here would let a
  // broken summariser pass.
  revert.logs = [
    "Program log: Error Code: SelfTrade. Error Number: 6014. Error Message: SelfTrade.",
    "Program CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq failed: custom program error: 0x177e",
  ];
  const h = harness({ sends: [blockhashNotFound(), revert] });
  await assert.rejects(run(h), (e: Error) => {
    assert.match(e.message, /SelfTrade/);
    return true;
  });
});

// ---- Go --------------------------------------------------------------------
(async () => {
  let pass = 0;
  const fail: string[] = [];
  for (const t of tests) {
    try {
      await t.fn();
      pass += 1;
      console.log(`  ok  ${t.name}`);
    } catch (e: any) {
      fail.push(t.name);
      console.log(`  FAIL ${t.name}\n       ${e?.message ?? e}`);
    }
  }
  console.log(`\n${pass}/${tests.length} passed`);
  if (fail.length) process.exit(1);
})();
