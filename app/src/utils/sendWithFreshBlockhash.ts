// =============================================================================
// sendWithFreshBlockhash.ts — a signature the user gave 90 seconds ago is still
// a signature; the blockhash under it is not
// =============================================================================
//
// THE INCIDENT THIS EXISTS FOR (prod devnet, 2026-08-14):
//
//   A market buy on /trade sat "Submitting…" while Phantom took 30–50 s to put
//   its approval popup on screen. The user approved. The send came back:
//
//     "Simulation failed. Message: Transaction simulation failed:
//      Blockhash not found. Logs: []."
//
//   Nothing was wrong with the order. Anchor's `sendAndConfirm` sets
//   `recentBlockhash` and then calls `wallet.signTransaction` on the very next
//   line, so the blockhash is already fetched as late as it can be — but a
//   blockhash lives ~150 slots (~60–90 s), and BOTH the wallet's stall and the
//   human's reading time are spent on the far side of that fetch. Fetching it
//   later is not available. Signing again is.
//
//   Measured the same day, so the blame lands where it belongs: the three RPC
//   calls this app makes before the prompt (protocolState, optionsMarket,
//   getLatestBlockhash) total ~1 s against prod, ~2.5 s worst case inside the
//   Trade page's mount burst. The 30–50 s is inside the wallet.
//
// THE RULE: when a send is refused because the blockhash died, ask the chain
// whether the transaction landed anyway — and only then, once, ask the user to
// sign the same instructions under a fresh blockhash. A retry that skips the
// question is how one intent becomes two positions.
//
// Injectable end to end (connection, wallet, clock) so the incident above is a
// unit test rather than a thing we find out about in prod again. See
// sendWithFreshBlockhash.test.ts.
// =============================================================================

import { utils } from "@coral-xyz/anchor";
import { Buffer } from "buffer";
import {
  confirmByPolling, outcomeOfSignature, statusFetcher, extractLogs,
  TxOutcomeError, type SigStatus,
} from "./txOutcome";

/** What the ticket is actually waiting on, so the button can stop guessing. */
export type SendPhase = "preparing" | "awaiting" | "resigning" | "submitting" | "confirming";

/**
 * Why a send was refused.
 *
 * Two kinds today. A third — `staleQuote`, for the peg re-price that surfaces as
 * Anchor "custom program error: 0x3" — belongs here when it is implemented, and
 * gets its own branch in `sendWithFreshBlockhash` (re-quote, then re-sign)
 * rather than another regex bolted onto the expiry path. Deliberately NOT
 * implemented now.
 */
export type SendFailureKind = "expired" | "unknown";

/** Shown when the second signature is also too late. Never a raw RPC string. */
export const APPROVAL_TOO_SLOW = "Approval took too long — please retry.";

/** After this much time inside the wallet, check the block height before
 *  spending a round trip on a transaction the network will refuse. */
const SIGN_SLOW_MS = 20_000;

/** Anything we can sign and serialise — a web3.js `Transaction` satisfies it. */
export interface SignableTx {
  feePayer?: unknown;
  recentBlockhash?: string;
  signature?: Uint8Array | null;
  serialize(): Uint8Array;
}

/** The subset of `Connection` this module uses. Structural so the tests can
 *  supply a plain object and prod can pass the polling-wrapped Connection. */
export interface SendableConnection {
  getLatestBlockhash(commitment?: unknown): Promise<{ blockhash: string; lastValidBlockHeight: number }>;
  getBlockHeight(commitment?: unknown): Promise<number>;
  sendRawTransaction(raw: Uint8Array, opts?: unknown): Promise<string>;
  getSignatureStatuses(
    sigs: string[],
    cfg?: { searchTransactionHistory?: boolean },
  ): Promise<{ value: (SigStatus | null)[] }>;
  getTransaction?(sig: string, cfg?: unknown): Promise<{ meta?: { logMessages?: string[] | null } | null } | null>;
}

export interface SendableProvider {
  connection: SendableConnection;
  wallet: { publicKey: unknown; signTransaction(tx: never): Promise<never> };
}

/** Every string an error might be hiding its reason in. */
function errText(err: unknown): string {
  const e = err as { message?: unknown; transactionMessage?: unknown } | null;
  const parts = [e?.message, e?.transactionMessage, String(err ?? "")];
  return parts.filter((p): p is string => typeof p === "string").join(" | ");
}

/**
 * Did the user say no?
 *
 * Checked before every rewrite below. Telling someone who deliberately declined
 * that their "approval took too long" is both wrong and an invitation to retry
 * the thing they just refused.
 */
export function isUserRejection(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === 4001 || code === "4001") return true;
  return /user (rejected|declined)|rejected the request|request rejected/i.test(errText(err));
}

/** Classify a REFUSED SEND. Not a confirmation outcome — that is txOutcome's job. */
export function classifySendFailure(err: unknown): SendFailureKind {
  const name = (err as { name?: unknown } | null)?.name;
  if (name === "TransactionExpiredBlockheightExceededError") return "expired";
  const msg = errText(err);
  if (/blockhash\s*not\s*found/i.test(msg)) return "expired";
  if (/block\s*height\s*exceeded/i.test(msg)) return "expired";
  return "unknown";
}

const b58 = (sig: Uint8Array): string => utils.bytes.bs58.encode(Buffer.from(sig));

/** One attempt either lands, or dies of old age (and says whether a signature
 *  ever reached the network, so the caller can check before resending). */
type Attempt =
  | { kind: "landed"; signature: string }
  | { kind: "expired"; signature: string | null };

export interface SendOptions {
  onPhase?: (p: SendPhase) => void;
  /** Injectable clock — the slow-approval branch is a test, not a 90 s wait. */
  now?: () => number;
}

/**
 * Sign and send `makeTx()`, surviving a blockhash that expires while the wallet
 * has the prompt open.
 *
 * `makeTx` is a FACTORY, not a transaction: the retry rebuilds the same
 * instruction list under a new blockhash, which is the one byte-level
 * difference between the two attempts. Reusing a signed object instead would
 * carry a signature that no longer matches the message.
 *
 * At most ONE automatic retry, and never before asking the chain whether the
 * first attempt landed.
 */
export async function sendWithFreshBlockhash(
  provider: SendableProvider,
  makeTx: () => SignableTx,
  opts: SendOptions = {},
): Promise<string> {
  const conn = provider.connection;
  const onPhase = opts.onPhase ?? (() => {});
  const now = opts.now ?? (() => Date.now());
  const fetcher = statusFetcher(conn as never);

  const attempt = async (isRetry: boolean): Promise<Attempt> => {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
    const tx = makeTx();
    tx.feePayer = tx.feePayer ?? provider.wallet.publicKey;
    tx.recentBlockhash = blockhash;

    onPhase(isRetry ? "resigning" : "awaiting");
    const startedSigning = now();
    const signed = (await provider.wallet.signTransaction(tx as never)) as unknown as SignableTx;
    const signMs = now() - startedSigning;
    // The signature exists whether or not the network ever sees it — which is
    // what makes the "did it land?" question answerable after a refused send.
    const expected = signed.signature ? b58(signed.signature) : null;

    // A prompt that sat open this long may have outlived its blockhash. Ask,
    // rather than spending a round trip to be told no. Only on the slow path:
    // the fast path must not pay for an extra call it will never need.
    if (signMs > SIGN_SLOW_MS) {
      try {
        if ((await conn.getBlockHeight("confirmed")) > lastValidBlockHeight) {
          return { kind: "expired", signature: null }; // never sent — nothing to check
        }
      } catch {
        // Height unknown is not height exceeded. Fall through and let the send decide.
      }
    }

    onPhase("submitting");
    let signature: string;
    try {
      signature = await conn.sendRawTransaction(signed.serialize(), { preflightCommitment: "confirmed" });
    } catch (err) {
      if (isUserRejection(err)) throw err;
      if (classifySendFailure(err) === "expired") return { kind: "expired", signature: expected };
      throw err; // a real rejection — unchanged, logs and all
    }

    onPhase("confirming");
    const outcome = await confirmByPolling(fetcher, signature);
    if (outcome.kind === "landed") return { kind: "landed", signature };
    throw new TxOutcomeError(outcome);
  };

  const first = await attempt(false);
  if (first.kind === "landed") return first.signature;

  // Anti-blind-retry. A preflight refusal means the network did not accept this
  // transaction — but "means" is not "verified", and the cost of being wrong is
  // a duplicate position. Ask.
  if (first.signature) {
    const o = await outcomeOfSignature(fetcher, first.signature);
    if (o.kind === "landed") return first.signature;
    if (o.kind === "failed") throw new TxOutcomeError(o);
  }

  let second: Attempt;
  try {
    second = await attempt(true);
  } catch (err) {
    if (isUserRejection(err)) throw err;
    if (err instanceof TxOutcomeError) throw err; // already a fact about the chain
    // A revert on the retry (a resting order consumed between attempts, say) is
    // a real answer and the user should get it — summarised, never raw.
    const logs = extractLogs(err);
    if (logs.length) throw new TxOutcomeError({ kind: "failed", signature: "", err, logs });
    throw new Error(APPROVAL_TOO_SLOW);
  }
  if (second.kind === "landed") return second.signature;

  if (second.signature) {
    const o = await outcomeOfSignature(fetcher, second.signature);
    if (o.kind === "landed") return second.signature;
  }
  throw new Error(APPROVAL_TOO_SLOW);
}
