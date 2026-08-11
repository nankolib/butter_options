// =============================================================================
// newMarketCreate.ts — shared create-market submit machinery (both surfaces).
// =============================================================================
//
// Extracted verbatim from NewMarketModal so the legacy paper modal AND the new
// terminal modal call the EXACT same submit path — the create arms are provably
// byte-identical (one copy of the SB retry/error logic, no drift).
//
// The FE does NO Switchboard SDK work — it POSTs to the VPS builder endpoint,
// receives an UNSIGNED VersionedTransaction (base64), signs it with the user's
// wallet, and submits. The endpoint is stateless + freshness-bound (the tx
// blockhash expires before the embedded oracle quote does), so on a genuine
// stale failure we RE-POST for a fresh tx and re-sign the FRESH one — never
// re-submit or re-sign the stale tx. DELIBERATELY imports NO @switchboard-xyz/*
// or crank code; all SB SDK work lives server-side.
//
// Provenance rule: no user-facing string here names an oracle/data provider.
// =============================================================================

import { PublicKey, VersionedTransaction, type Connection } from "@solana/web3.js";
import { withResolvedOutcome } from "../../utils/txOutcome";
import { decodeError } from "../../utils/errorDecoder";

export type SbCreateResponse = {
  transactionBase64: string;
  marketPda: string;
  lastValidBlockHeight: number;
};

/** A non-2xx response from the create endpoint, carrying the HTTP status so the
 *  caller can map it to a clean toast. Fails fast — never retried. */
export class SbEndpointError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "SbEndpointError";
  }
}
/** The endpoint was unreachable (fetch threw). Fails fast — never retried. */
export class SbNetworkError extends Error {
  constructor() {
    super("Could not reach create service.");
    this.name = "SbNetworkError";
  }
}
/** The user declined the wallet signature. Fails fast — never retried; surfaced
 *  as a neutral (info) toast, not an error. */
export class SbUserRejectedError extends Error {
  constructor() {
    super("Signature cancelled");
    this.name = "SbUserRejectedError";
  }
}

export type WalletSigner = {
  publicKey: PublicKey;
  signTransaction: (tx: VersionedTransaction) => Promise<VersionedTransaction>;
};

/** True ONLY for a wallet user-rejection — must NOT be treated as stale (no
 *  retry) and surfaces as a neutral toast. */
export function isUserRejection(e: any): boolean {
  if (e?.code === 4001) return true;
  const msg = String(e?.message ?? e ?? "").toLowerCase();
  return (
    msg.includes("user rejected") ||
    msg.includes("user denied") ||
    msg.includes("rejected the request") ||
    msg.includes("request rejected")
  );
}

/** Stale-submit detection for the SB create arm ONLY (referenced only in
 *  submitSbCreateMarket + mapSbError — the Pyth path never calls it, so this
 *  cannot loosen Pyth stale handling). Triggers the single refetch-retry. A user
 *  rejection, a 4xx/5xx, a network error, or a genuine Opta create error returns
 *  false and fails fast.
 *
 *  GOLD5 broadening: when the user is slow to approve, the quote/blockhash
 *  expires and the on-chain verify rejects the tx, surfacing NOT as a clean
 *  stale string but as an opaque `custom program error: 0x3` (an InstructionError
 *  on the ed25519/verify path) or Phantom's generic "failed to simulate". These
 *  are the stale-EXECUTION fingerprint — and they are NEVER genuine Opta create
 *  errors: the Opta enum is 6000+ (`0x1770`+), so a real on-chain failure decodes
 *  to a message, never `0x3`. Matching them therefore cannot retry a real failure. */
export function isStaleSubmitError(e: any): boolean {
  const name = String(e?.name ?? "");

  // ── SLICE 2A: the STRUCTURED fingerprint, checked first ────────────────────
  // D2/G1 wrapped every connection in `withPollingConfirm`, which deliberately
  // stopped throwing web3.js's TransactionExpired* classes and started throwing
  // `TxOutcomeError` instead — specifically so Anchor would not resend beneath
  // it. Correct for its purpose, and it silently disabled the retry below: the
  // new error's name is "TxOutcomeError" and its message is "Not on chain —
  // not found on chain. Safe to send again.", so neither the class check nor
  // any text match fired. The slow-approve case this whole function exists for
  // stopped being handled, loudly enough to break nothing and quietly enough
  // that nobody noticed.
  //
  // We read the OUTCOME rather than adding a third magic string, because the
  // outcome is data and the message is prose. `dropped` means the chain was
  // asked and the transaction is genuinely not there; `retryAllowed` is that
  // module's own verdict on resending. Both must agree — a `landed` outcome
  // must NEVER retry (the market already exists; a resend is a second create),
  // and neither must `failed` (the program rejected it on its merits).
  if (name === "TxOutcomeError") {
    return e?.outcome?.kind === "dropped" && e?.retryAllowed === true;
  }

  if (
    name === "TransactionExpiredBlockheightExceededError" ||
    name === "TransactionExpiredTimeoutError"
  ) {
    return true;
  }
  const msg = String(e?.message ?? e ?? "").toLowerCase();
  return (
    msg.includes("block height exceeded") ||
    msg.includes("blockhash not found") ||
    msg.includes("transactionexpired") ||
    // On-chain quote staleness — rare (blockhash expires first per the endpoint's
    // documented freshness invariant), included defensively.
    msg.includes("switchboardverifyfailed") ||
    // GOLD5 stale-execution fingerprint (opaque, but never an Opta 6000+ error).
    msg.includes("custom program error: 0x3") ||
    msg.includes("failed to simulate")
  );
}

/** POST to the create endpoint for a fresh unsigned tx. Throws SbNetworkError
 *  (unreachable) or SbEndpointError (non-2xx / malformed) — both fail fast. */
export async function postSbCreate(
  endpoint: string,
  body: {
    assetName: string;
    feedHashHex: string;
    assetClass: number;
    userPublicKey: string;
  },
): Promise<SbCreateResponse> {
  let resp: Response;
  try {
    resp = await fetch(`${endpoint}/sb-create-market`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new SbNetworkError();
  }
  if (!resp.ok) {
    let msg = "";
    try {
      const j = await resp.json();
      if (j && typeof j.error === "string") msg = j.error;
    } catch {
      /* non-JSON error body — leave msg empty, mapped by status */
    }
    throw new SbEndpointError(resp.status, msg);
  }
  let json: any;
  try {
    json = await resp.json();
  } catch {
    throw new SbEndpointError(resp.status, "malformed response from create service");
  }
  if (
    typeof json?.transactionBase64 !== "string" ||
    typeof json?.lastValidBlockHeight !== "number"
  ) {
    throw new SbEndpointError(resp.status, "malformed response from create service");
  }
  return {
    transactionBase64: json.transactionBase64,
    marketPda: typeof json.marketPda === "string" ? json.marketPda : "",
    lastValidBlockHeight: json.lastValidBlockHeight,
  };
}

/**
 * Fetch → deserialize → sign → submit → confirm the SB create tx, with a
 * retry-once policy that fires ONLY on a genuine stale signal.
 *
 * Error-class routing (precise by design — a too-broad retry would be a bug):
 *   - postSbCreate throw (network / 4xx / 5xx) → propagates, NO retry.
 *   - signTransaction throw → user-rejection (NO retry) is checked FIRST; a
 *     stale-sim refusal ("failed to simulate") triggers ONE refetch.
 *   - send/confirm throw → ONLY isStaleSubmitError triggers ONE refetch-retry
 *     (re-POST + re-sign the FRESH tx). Anything else propagates immediately.
 * Capped at exactly one refetch (2 attempts total). `onRefetch` (optional) fires
 * just before the retry so the caller can tell a slow-approve user why a second
 * wallet prompt is appearing.
 */
export async function submitSbCreateMarket(args: {
  endpoint: string;
  connection: Connection;
  wallet: WalletSigner;
  assetName: string;
  feedHashHex: string;
  assetClass: number;
  userPublicKey: string;
  onRefetch?: () => void;
}): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    // 1. Fresh tx every attempt (stateless endpoint). Endpoint/network errors
    //    propagate here — NOT candidates for the stale-retry.
    const resp = await postSbCreate(args.endpoint, {
      assetName: args.assetName,
      feedHashHex: args.feedHashHex,
      assetClass: args.assetClass,
      userPublicKey: args.userPublicKey,
    });
    const tx = VersionedTransaction.deserialize(
      Buffer.from(resp.transactionBase64, "base64"),
    );

    // 2. Sign the FRESH tx. A user rejection is NOT stale — fail fast clean. But
    //    a stale-sim refusal on an aged quote IS stale → refetch once. The
    //    user-rejection check runs FIRST, so a genuine cancel still fails fast.
    let signed: VersionedTransaction;
    try {
      signed = await args.wallet.signTransaction(tx);
    } catch (e) {
      if (isUserRejection(e)) throw new SbUserRejectedError();
      if (attempt === 0 && isStaleSubmitError(e)) {
        args.onRefetch?.();
        continue;
      }
      throw e; // genuine sign error — fail fast, no retry
    }

    // 3. Submit + confirm. ONLY a genuine stale signal here triggers the single
    //    refetch-retry; everything else fails fast.
    try {
      return await withResolvedOutcome(args.connection as never, async () => {
        const sig = await args.connection.sendRawTransaction(signed.serialize(), {
          skipPreflight: false,
          maxRetries: 3,
        });
        await args.connection.confirmTransaction(
          {
            signature: sig,
            blockhash: tx.message.recentBlockhash,
            lastValidBlockHeight: resp.lastValidBlockHeight,
          },
          "confirmed",
        );
        return sig;
      });
    } catch (e) {
      if (attempt === 0 && isStaleSubmitError(e)) {
        // Stale → loop re-POSTs a FRESH tx + re-signs it. Never re-submit the
        // stale tx.
        args.onRefetch?.();
        continue;
      }
      throw e; // non-stale, or already retried once — fail fast
    }
  }
  // Unreachable: the loop returns on success or throws. Defensive only.
  throw new Error("SB create: exhausted retries");
}

/**
 * SLICE 2A — the PYTH arm's first retry, ever.
 *
 * The SB arm has had a single refetch since `62f228e`; the Pyth arm never did,
 * and it is the arm that serves EVERY non-curated asset — i.e. almost anything
 * a user can actually create. A slow wallet approve there produced the same
 * dead end, with no recovery at all.
 *
 * Why this rebuilds rather than resubmits: a Pyth create carries a Hermes price
 * update and a blockhash inside the signed transaction. Once either has expired
 * the bytes are worthless, so resending them is guaranteed to fail a second
 * time. The retry has to go all the way back to `build` for a fresh update and
 * a fresh blockhash, and the user re-signs the FRESH transaction — never the
 * stale one.
 *
 * Deliberately generic over the tx type: this file must not import the Pyth
 * builder (it stays free of the receiver SDK), so the caller passes both halves
 * in. Exactly one retry, on exactly the same stale signal as the SB arm.
 */
export async function submitPythCreateWithRetry<T>(args: {
  /** Build the transaction set — fresh price update + fresh blockhash. */
  build: () => Promise<T>;
  /** Sign + send + confirm. Throws on failure. */
  submit: (txs: T) => Promise<string>;
  /** Fires just before the second wallet prompt so the caller can say why a
   *  second approval is being asked for. */
  onRefetch?: () => void;
}): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const txs = await args.build();
    try {
      return await args.submit(txs);
    } catch (e) {
      // A user rejection is a decision, not a failure — never retried.
      if (isUserRejection(e)) throw e;
      if (attempt === 0 && isStaleSubmitError(e)) {
        args.onRefetch?.();
        continue;
      }
      throw e;
    }
  }
  // Unreachable: the loop returns on success or throws. Defensive only.
  throw new Error("Pyth create: exhausted retries");
}

/** Map an SB create failure to a clean inline toast message (title fixed to
 *  match the Pyth arm). User-rejection is handled separately by the caller.
 *  No provider names in any returned string. */
export function mapSbError(e: unknown): { title: string; message: string } {
  const title = "Create market failed";
  if (e instanceof SbNetworkError) {
    return { title, message: "Could not reach create service." };
  }
  if (e instanceof SbEndpointError) {
    switch (e.status) {
      case 400:
        return { title, message: e.message || "Invalid request." };
      case 403:
      case 404:
        return { title, message: "Creation for this class isn't enabled yet." };
      case 413:
      case 429:
        return { title, message: "Too many requests, try shortly." };
      case 502:
        return { title, message: "Verification quote unavailable — retry." };
      default:
        return { title, message: e.message || "Create service error." };
    }
  }
  if (isStaleSubmitError(e)) {
    return { title, message: "Transaction expired — please try again promptly." };
  }
  return { title, message: decodeError(e) };
}
