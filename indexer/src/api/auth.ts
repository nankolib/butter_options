// =============================================================================
// auth.ts — wallet-signature authentication for write endpoints
// =============================================================================
//
// CANONICAL MESSAGE
//
//   opta-epoch0|{action}|{wallet}|{paramsHash}|{nonce}|{expiry_unix}
//
// Every field is load-bearing:
//   action      a fixed enum. A signature for `referral.bind` cannot be
//               replayed against `social.submit`.
//   wallet      the signer, stated explicitly. ed25519 already binds the key,
//               but naming it makes a swapped-pubkey attempt fail on the
//               message rather than only on the verify.
//   paramsHash  base58(sha256(canonicalJson(params))) — THIS is what stops a
//               captured signature being reused with different arguments
//               (e.g. binding a different referral code).
//   nonce       16 random bytes; single-use, enforced by the `nonces` table.
//   expiry      must satisfy now < expiry <= now + MAX_TTL. A signature is
//               useless five minutes after it was produced.
//
// Failures return a coarse reason code and NOTHING else — never the expected
// message, never key material, never how far the check got.
// =============================================================================

import { createHash } from "node:crypto";

import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";

import type { DB } from "../db";

export const MAX_TTL_SECS = 300;

export type Action = "referral.code" | "referral.bind" | "social.submit" | "bounty.submit";

export const ACTIONS: readonly Action[] = [
  "referral.code",
  "referral.bind",
  "social.submit",
  "bounty.submit",
];

export interface SignedEnvelope {
  wallet: string;
  action: string;
  nonce: string;
  expiry: number;
  signature: string;
  params?: Record<string, unknown>;
}

export type AuthFailure =
  | "bad_request"
  | "bad_action"
  | "bad_signature"
  | "expired"
  | "replayed"
  | "cooldown";

export type AuthResult = { ok: true; wallet: string; action: Action } | { ok: false; reason: AuthFailure };

/** Deterministic JSON: keys sorted at every level, no whitespace. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

export function paramsHash(params: unknown): string {
  return bs58.encode(createHash("sha256").update(canonicalJson(params ?? {})).digest());
}

export function canonicalMessage(
  action: string,
  wallet: string,
  params: unknown,
  nonce: string,
  expiry: number,
): string {
  return `opta-epoch0|${action}|${wallet}|${paramsHash(params)}|${nonce}|${expiry}`;
}

function isAction(a: string): a is Action {
  return (ACTIONS as readonly string[]).includes(a);
}

/**
 * Verify an envelope. `now` is injected so the check is testable without
 * touching the clock.
 */
export function verifySigned(db: DB, env: SignedEnvelope, now: number): AuthResult {
  if (
    !env ||
    typeof env.wallet !== "string" ||
    typeof env.action !== "string" ||
    typeof env.nonce !== "string" ||
    typeof env.signature !== "string" ||
    typeof env.expiry !== "number" ||
    !Number.isFinite(env.expiry)
  ) {
    return { ok: false, reason: "bad_request" };
  }
  if (!isAction(env.action)) return { ok: false, reason: "bad_action" };

  // Window check BEFORE any crypto: cheap, and it bounds how long a leaked
  // signature is worth anything.
  if (!(env.expiry > now && env.expiry <= now + MAX_TTL_SECS)) return { ok: false, reason: "expired" };

  let pubkey: Uint8Array;
  let sig: Uint8Array;
  try {
    pubkey = bs58.decode(env.wallet);
    sig = bs58.decode(env.signature);
  } catch {
    return { ok: false, reason: "bad_signature" };
  }
  if (pubkey.length !== 32 || sig.length !== 64) return { ok: false, reason: "bad_signature" };

  const msg = Buffer.from(canonicalMessage(env.action, env.wallet, env.params ?? {}, env.nonce, env.expiry), "utf8");
  let valid = false;
  try {
    valid = ed25519.verify(sig, msg, pubkey);
  } catch {
    valid = false;
  }
  if (!valid) return { ok: false, reason: "bad_signature" };

  // Single-use nonce. INSERT is the check: a duplicate PK means replay.
  try {
    db.prepare("INSERT INTO nonces (nonce, wallet, action, expires_at) VALUES (?, ?, ?, ?)").run(
      env.nonce,
      env.wallet,
      env.action,
      env.expiry,
    );
  } catch {
    return { ok: false, reason: "replayed" };
  }

  return { ok: true, wallet: env.wallet, action: env.action };
}

/** Drop nonces that can no longer be replayed anyway. */
export function sweepNonces(db: DB, now: number): number {
  return db.prepare("DELETE FROM nonces WHERE expires_at < ?").run(now).changes;
}

/** Per-wallet, per-action cooldown on top of nginx limit_req. */
export function checkCooldown(db: DB, wallet: string, action: string, now: number, cooldownSecs: number): boolean {
  const row = db.prepare("SELECT last_at FROM write_cooldowns WHERE wallet = ? AND action = ?").get(wallet, action) as
    | { last_at: number }
    | undefined;
  if (row && now - row.last_at < cooldownSecs) return false;
  db.prepare(
    `INSERT INTO write_cooldowns (wallet, action, last_at) VALUES (?, ?, ?)
     ON CONFLICT(wallet, action) DO UPDATE SET last_at = excluded.last_at`,
  ).run(wallet, action, now);
  return true;
}
