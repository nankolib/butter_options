// ============================================================================
// crank/sbExerciseValidate.ts — request validation for /sb-exercise-american
// ============================================================================
//
// Split out of the endpoint so it can be tested without an HTTP server, an RPC
// connection, or the Switchboard SDK: `resolveSbFeedForMarket` takes an injected
// market loader, so every refusal path is exercised against fakes.
//
// THE RULE THIS FILE ENFORCES, and the reason it is not just shape-checking:
// the feedHash is read from the MARKET ACCOUNT ON CHAIN, never from the request
// body. A caller cannot name the feed it wants priced. If the body could carry a
// feedHash, anyone could ask for an exercise against a market at some OTHER
// asset's price — cheap options, expensive settlement. The body says which
// market; the chain says what that market's price source is.
//
// The same read is what rejects Pyth markets here: oracle_source is on the
// market account, it is immutable after create_market, and only source 1 has an
// SB feed to quote.
//
// COPY DISCIPLINE: every `error` string below can reach a user-facing toast, so
// none of them names a price vendor.
// ============================================================================

import { PublicKey } from "@solana/web3.js";
import { isSupportedSbFeed } from "./sbFeedRegistry";

export const ORACLE_SOURCE_PYTH = 0;
export const ORACLE_SOURCE_SWITCHBOARD = 1;

/** Upper bound on a single exercise. Far above any real position; exists so a
 *  garbage or hostile body cannot push an absurd u64 into the builder. */
export const MAX_EXERCISE_QUANTITY = 1_000_000_000;

const HEX64_RE = /^[0-9a-f]{64}$/;

export interface ExerciseValidated {
  holder: PublicKey;
  sharedVault: PublicKey;
  market: PublicKey;
  vaultMintRecord: PublicKey;
  optionMint: PublicKey;
  holderOptionAccount: PublicKey;
  vaultUsdcAccount: PublicKey;
  holderUsdcAccount: PublicKey;
  quantity: number;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: string };

const PUBKEY_FIELDS = [
  "holder",
  "sharedVault",
  "market",
  "vaultMintRecord",
  "optionMint",
  "holderOptionAccount",
  "vaultUsdcAccount",
  "holderUsdcAccount",
] as const;

/** Shape/type validation only — no chain reads. */
export function validateExerciseBody(body: any): Result<ExerciseValidated> {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const out: Record<string, PublicKey> = {};
  for (const f of PUBKEY_FIELDS) {
    const v = body[f];
    if (typeof v !== "string") return { ok: false, error: `${f} must be a string` };
    try {
      out[f] = new PublicKey(v);
    } catch {
      return { ok: false, error: `${f} is not a valid pubkey` };
    }
  }
  const q = body.quantity;
  if (typeof q !== "number" || !Number.isInteger(q)) {
    return { ok: false, error: "quantity must be an integer" };
  }
  if (q < 1 || q > MAX_EXERCISE_QUANTITY) {
    return { ok: false, error: `quantity must be between 1 and ${MAX_EXERCISE_QUANTITY}` };
  }
  return { ok: true, value: { ...(out as any), quantity: q } };
}

/** The subset of the market account this endpoint reads. */
export interface MarketOracleView {
  oracleSource: number;
  /** The double-duty feed field: a Pyth feed id when oracleSource=0, an SB
   *  feedHash when oracleSource=1. */
  pythFeedId: number[] | Uint8Array;
}

export type MarketLoader = (market: PublicKey) => Promise<MarketOracleView | null>;

function toHex(bytes: number[] | Uint8Array): string {
  return Array.from(bytes)
    .map((b) => (b & 0xff).toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Read the market on chain and return the SB feedHash to quote, or a refusal.
 *
 * Refusals are deliberately specific to us and vague to a caller: they say what
 * the server will not do, never which vendor is involved.
 */
export async function resolveSbFeedForMarket(
  loadMarket: MarketLoader,
  market: PublicKey,
): Promise<Result<string>> {
  let m: MarketOracleView | null;
  try {
    m = await loadMarket(market);
  } catch {
    // An undecodable account is indistinguishable from a missing one from here,
    // and both mean the same thing to the caller: we cannot price this.
    return { ok: false, error: "market not found" };
  }
  if (!m) return { ok: false, error: "market not found" };

  if (m.oracleSource !== ORACLE_SOURCE_SWITCHBOARD) {
    // Pyth markets exercise entirely in the browser and must never come here.
    return { ok: false, error: "market uses a different price source" };
  }

  const hex = toHex(m.pythFeedId ?? []).toLowerCase();
  if (!HEX64_RE.test(hex)) {
    return { ok: false, error: "market has no usable price feed" };
  }
  if (!isSupportedSbFeed(hex)) {
    return { ok: false, error: "unsupported price feed" };
  }
  return { ok: true, value: hex };
}
