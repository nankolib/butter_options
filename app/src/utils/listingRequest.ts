// =============================================================================
// listingRequest.ts — SLICE 2C: ask for a token that has no settlement feed
// =============================================================================
//
// 2A split identity from listability, so a token with no price feed now renders
// as "BP · Backpack · ✓ Verified — no settlement feed yet" instead of a bare
// refusal. That is honest, and it is still a dead end: the user learns the
// answer is no and has nowhere to put the fact that they wanted it.
//
// This is where that goes. A signed request, recorded once per (wallet, mint),
// so demand for unlisted tokens becomes data instead of evaporating.
//
// SIGNED, not anonymous. That costs a wallet popup, which is the right trade:
// the entire value of the table is that somebody REAL asked, and the envelope
// makes a request attributable and spam-resistant by construction. A signature
// for one mint can never be replayed for another — params are hashed into the
// signed message.
//
// ── WHAT THIS FILE IS NOT ───────────────────────────────────────────────────
// It does NOT build the envelope. `epoch0Sign.ts` already does that, and is
// already pinned byte-for-byte against indexer/src/api/auth.ts by
// epoch0Format.test.ts. I wrote a second implementation of canonicalJson /
// paramsHash / base58 / nonce here before finding it, and deleted it: two
// copies of a signing format is precisely how the two silently drift and every
// write starts 401ing. This file is a thin CONSUMER — envelope in, outcome out.
//
// No ./env import, so it still compiles to CommonJS and stays testable (TS1343,
// the D1 lesson).
// =============================================================================

import { buildEnvelope, type SignedEnvelope } from "./epoch0Sign";

export interface ListingRequestParams extends Record<string, unknown> {
  mint: string;
  symbol: string;
  /** On-chain asset_class u8: 0 crypto · 1 commodity · 2 equity · 3 fx · 4 etf. */
  assetClass: number;
}

export type ListingOutcome =
  /** Recorded for the first time. */
  | { kind: "recorded" }
  /** Already on file for this (wallet, mint). Idempotent, NOT a failure. */
  | { kind: "already-requested" }
  /** The user declined the signature. A DECISION, not an error — the caller
   *  returns to the idle button and shows nothing red. */
  | { kind: "declined" }
  /** The server said no, with a reason worth showing. */
  | { kind: "rejected"; reason: string }
  /** We could not reach the sink. Retryable. */
  | { kind: "unavailable" };

/** True only for a wallet user-rejection. Same phrasings as
 *  newMarketCreate.isUserRejection — the wallets have not changed. */
export function isUserDecline(e: unknown): boolean {
  const err = e as { code?: unknown; message?: unknown } | null;
  if (err?.code === 4001) return true;
  const m = String(err?.message ?? e ?? "").toLowerCase();
  return (
    m.includes("user rejected") ||
    m.includes("user denied") ||
    m.includes("rejected the request") ||
    m.includes("request rejected")
  );
}

export interface SubmitDeps {
  /** Base URL of the points API (e.g. https://opta.fyi). */
  apiBase: string;
  wallet: string;
  /** The wallet adapter's signMessage. */
  sign: (msg: Uint8Array) => Promise<Uint8Array>;
  nowUnix: number;
  fetchImpl?: typeof fetch;
  /** Test seam: override envelope construction. Production omits it. */
  buildEnvelopeImpl?: typeof buildEnvelope;
}

/**
 * Sign and submit a listing request. NEVER throws.
 *
 * The declined branch is checked FIRST, because a user who says no has not hit
 * an error and must not be shown one.
 */
export async function submitListingRequest(
  params: ListingRequestParams,
  deps: SubmitDeps,
): Promise<ListingOutcome> {
  const doFetch = deps.fetchImpl ?? fetch;
  const build = deps.buildEnvelopeImpl ?? buildEnvelope;

  let envelope: SignedEnvelope;
  try {
    envelope = await build({
      action: "listing.request",
      wallet: deps.wallet,
      params,
      nowUnix: deps.nowUnix,
      sign: deps.sign,
    });
  } catch (e) {
    if (isUserDecline(e)) return { kind: "declined" };
    return { kind: "unavailable" };
  }

  let resp: Response;
  try {
    resp = await doFetch(`${deps.apiBase}/api/points/listing/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(envelope),
    });
  } catch {
    return { kind: "unavailable" };
  }

  let body: { status?: string; error?: string } = {};
  try {
    body = (await resp.json()) as typeof body;
  } catch {
    /* non-JSON body — the status branches below still decide correctly */
  }

  if (resp.ok) {
    return body.status === "already-requested"
      ? { kind: "already-requested" }
      : { kind: "recorded" };
  }
  if (resp.status === 429) {
    return {
      kind: "rejected",
      reason:
        body.error === "daily_cap"
          ? "You've hit today's request limit. Try again tomorrow."
          : "Too many requests — try again shortly.",
    };
  }
  // 5xx is ours and retryable; a 4xx is a decision the server made, and
  // repeating the identical request will not change it.
  if (resp.status >= 500) return { kind: "unavailable" };
  return { kind: "rejected", reason: "That request couldn't be recorded." };
}

/**
 * Has this wallet already asked for this mint? Unauthenticated read — it
 * discloses only a (wallet, mint) pair the caller already supplied.
 *
 * Returns NULL when we could not tell, and the caller then SHOWS the button:
 * offering an action twice is a far smaller failure than hiding one that was
 * never taken.
 */
export async function checkAlreadyRequested(
  apiBase: string,
  wallet: string,
  mint: string,
  fetchImpl?: typeof fetch,
): Promise<boolean | null> {
  const doFetch = fetchImpl ?? fetch;
  try {
    const r = await doFetch(
      `${apiBase}/api/points/listing/requested?wallet=${encodeURIComponent(wallet)}&mint=${encodeURIComponent(mint)}`,
    );
    if (!r.ok) return null;
    const j = (await r.json()) as { requested?: unknown };
    return j?.requested === true;
  } catch {
    return null;
  }
}
