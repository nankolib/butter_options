// =============================================================================
// epoch0Sign.ts — canonical signed-message builder (PURE)
// =============================================================================
//
// MUST stay byte-identical to indexer/src/api/auth.ts. If these two drift, every
// write silently 401s. The format:
//
//   opta-epoch0|{action}|{wallet}|{paramsHash}|{nonce}|{expiry_unix}
//
// `paramsHash` = base58(sha256(canonicalJson(params))) — this is what stops a
// captured signature being replayed with different arguments.
//
// Hashing uses Web Crypto (subtle.digest), which is async and browser-native.
// base58 is implemented inline rather than importing bs58: the app does not
// otherwise depend on it, bs58 v4 ships no type declarations, and adding a
// module shim to a production app for one flag-gated file is a poor trade.
// =============================================================================

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Canonical base58 (Bitcoin alphabet), leading zero bytes preserved as "1". */
export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";
  const digits: number[] = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i] << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let out = "";
  for (let k = 0; bytes[k] === 0 && k < bytes.length - 1; k++) out += "1";
  for (let i = digits.length - 1; i >= 0; i--) out += B58_ALPHABET[digits[i]];
  return out;
}

export const SIGN_TTL_SECS = 240; // server allows 300; leave headroom for latency

export type Epoch0Action = "referral.code" | "referral.bind" | "social.submit" | "bounty.submit";

/** Deterministic JSON: keys sorted at every level, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const o = value as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export async function paramsHash(params: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalJson(params ?? {}));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return base58Encode(new Uint8Array(digest));
}

export function buildMessage(action: string, wallet: string, hash: string, nonce: string, expiry: number): string {
  return `opta-epoch0|${action}|${wallet}|${hash}|${nonce}|${expiry}`;
}

/** 16 random bytes, base58 — matches the server's single-use nonce expectation. */
export function newNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return base58Encode(b);
}

export interface SignedEnvelope {
  wallet: string;
  action: string;
  nonce: string;
  expiry: number;
  params: Record<string, unknown>;
  signature: string;
}

/**
 * Build the envelope a write endpoint expects.
 *
 * `sign` is the wallet adapter's signMessage. `nowUnix` is injected so this is
 * testable without the clock.
 */
export async function buildEnvelope(args: {
  action: Epoch0Action;
  wallet: string;
  params?: Record<string, unknown>;
  nowUnix: number;
  sign: (msg: Uint8Array) => Promise<Uint8Array>;
}): Promise<SignedEnvelope> {
  const params = args.params ?? {};
  const nonce = newNonce();
  const expiry = args.nowUnix + SIGN_TTL_SECS;
  const hash = await paramsHash(params);
  const message = buildMessage(args.action, args.wallet, hash, nonce, expiry);
  const signature = await args.sign(new TextEncoder().encode(message));
  return { wallet: args.wallet, action: args.action, nonce, expiry, params, signature: base58Encode(signature) };
}

/** Signed-action UI states, brief §6: idle -> confirm -> pending -> done/fail. */
export type SignState = "idle" | "confirm" | "pending" | "success" | "error";

export const SIGN_COPY: Record<SignState, string | null> = {
  idle: null,
  confirm: "Confirm in wallet",
  pending: "Submitting",
  success: null,
  error: null,
};

/** Map a failed write to terse, blame-free copy (brief §8). */
export function writeErrorCopy(error: string | undefined, status?: number): string {
  switch (error) {
    case "unknown_code":
      return "Code not found.";
    case "self_referral":
      return "That is your own code.";
    case "already_bound":
      return "Already referred.";
    case "already_active":
      return "Bind before your first fill.";
    case "internal_referrer":
      return "Code not eligible.";
    case "duplicate_tweet":
      return "Post already submitted.";
    case "handle_mismatch":
      return "Post must come from your linked handle.";
    case "handle_taken":
      return "Handle already linked to another wallet.";
    case "daily_cap":
      return "Daily limit reached — 3 posts.";
    case "too_old":
      return "Post too old — 48h limit.";
    case "no_mention":
      return "Post must mention @optafinance.";
    case "not_found":
      return "Post not found.";
    case "verification_unavailable":
      return "Verification unavailable — try again.";
    case "cooldown":
      return "Too fast — wait a moment.";
    case "expired":
    case "bad_signature":
    case "replayed":
      return "Signature declined.";
    default:
      return status === 0 || status === undefined ? "Points unavailable." : "Could not submit.";
  }
}
