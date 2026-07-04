// ============================================================================
// Server-side devnet faucet  (H-04) — USDC + SOL, durable per-wallet cooldown
// ============================================================================
// Signs devnet faucet payouts server-side; the key lives ONLY in the server-only
// env var FAUCET_SECRET_KEY (no VITE_/NEXT_PUBLIC_ prefix — never in the client
// bundle). Body: { wallet, kind?: "usdc" | "sol" } (defaults "usdc"):
//   - usdc: transfers 10,000 mock USDC from the faucet ATA.  24h cooldown.
//   - sol:  transfers 0.05 SOL (gas) from the faucet wallet.  4h cooldown.
//
// Cooldown is DURABLE via Upstash Redis (Vercel "Upstash for Redis" —
// KV_REST_API_URL + KV_REST_API_TOKEN auto-injected). Atomic NX-reserve with a
// TTL, DEL-released if the on-chain transfer fails so a failed tx never burns
// the window. If Redis is unconfigured or throws, we FAIL SAFE to a per-instance
// in-memory cooldown (best-effort) + a logged warning — the faucet stays up.
//
// This file lives under app/api/ and is deployed by Vercel as a Node.js
// Serverless Function (project root = app/). It is NOT part of the Vite/tsc
// client build (outside src/), so it never ships to the browser.
//
// Guards: devnet-genesis hard check + fixed per-kind caps.
// ============================================================================

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAccount,
} from "@solana/spl-token";
import { Redis } from "@upstash/redis";

const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
const DEVNET_USDC_MINT = new PublicKey("AytU5HUQRew9VdUdrzQuZvZ7s14pHLiYjAF5WqdK3oxL");

const USDC_DECIMALS = 6;
// Fixed per-request cap (10,000 USDC unless overridden).
const USDC_AMOUNT = Math.round(Number(process.env.FAUCET_AMOUNT_USDC ?? 10_000) * 10 ** USDC_DECIMALS);
const SOL_LAMPORTS = 50_000_000; // 0.05 SOL
const USDC_COOLDOWN_SECS = 86_400; // 24h
const SOL_COOLDOWN_SECS = 14_400; //  4h

// Durable cooldown store. Null when unconfigured → in-memory fallback.
const redis =
  process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN
    ? new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN })
    : null;

// Per-instance fallback (best-effort; used ONLY when Redis is absent or throws).
const memCooldown = new Map<string, number>(); // key -> expiresAtMs

function loadFaucet(): Keypair | null {
  const raw = process.env.FAUCET_SECRET_KEY?.trim();
  if (!raw) return null;
  try {
    if (!raw.startsWith("[")) return null;
    const bytes = JSON.parse(raw);
    if (!Array.isArray(bytes) || bytes.length !== 64) return null;
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  } catch {
    return null;
  }
}

/** Atomic reserve of the cooldown window. ok=false carries retryAfter (seconds). */
async function reserve(key: string, ttlSecs: number): Promise<{ ok: boolean; retryAfter: number }> {
  if (redis) {
    try {
      const set = await redis.set(key, Date.now(), { nx: true, ex: ttlSecs });
      if (set === null) {
        const ttl = await redis.ttl(key);
        return { ok: false, retryAfter: typeof ttl === "number" && ttl > 0 ? ttl : ttlSecs };
      }
      return { ok: true, retryAfter: 0 };
    } catch (e: any) {
      console.warn("[faucet] Redis reserve failed — failing safe to in-memory:", e?.message ?? e);
    }
  }
  const now = Date.now();
  const exp = memCooldown.get(key);
  if (exp && exp > now) return { ok: false, retryAfter: Math.ceil((exp - now) / 1000) };
  memCooldown.set(key, now + ttlSecs * 1000);
  return { ok: true, retryAfter: 0 };
}

/** Release a reservation after a failed transfer (both stores, best-effort). */
async function release(key: string): Promise<void> {
  if (redis) {
    try {
      await redis.del(key);
    } catch (e: any) {
      console.warn("[faucet] Redis del failed:", e?.message ?? e);
    }
  }
  memCooldown.delete(key);
}

function fmtRemaining(secs: number): string {
  if (secs >= 3600) {
    const h = Math.floor(secs / 3600);
    const m = Math.round((secs % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  if (secs >= 60) return `${Math.ceil(secs / 60)}m`;
  return `${Math.max(1, secs)}s`;
}

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const faucet = loadFaucet();
  if (!faucet) {
    res.status(503).json({ error: "Faucet not configured" });
    return;
  }

  // Parse + validate body.
  let walletStr: unknown;
  let kindStr: unknown;
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    walletStr = body?.wallet;
    kindStr = body?.kind;
  } catch {
    /* handled below */
  }
  const kind: "usdc" | "sol" = kindStr === "sol" ? "sol" : "usdc";

  let user: PublicKey;
  try {
    user = new PublicKey(String(walletStr));
  } catch {
    res.status(400).json({ error: "Invalid wallet address" });
    return;
  }

  // Durable per-wallet, per-kind cooldown.
  const key = `faucet:${kind}:${user.toBase58()}`;
  const ttl = kind === "sol" ? SOL_COOLDOWN_SECS : USDC_COOLDOWN_SECS;
  const reserved = await reserve(key, ttl);
  if (!reserved.ok) {
    res.status(429).json({
      error: `Faucet cooldown — try again in ${fmtRemaining(reserved.retryAfter)}`,
      retryAfter: reserved.retryAfter,
    });
    return;
  }

  const rpcUrl = process.env.FAUCET_RPC_URL?.trim() || "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");

  try {
    // Hard devnet-only guard.
    const genesis = await connection.getGenesisHash();
    if (genesis !== DEVNET_GENESIS) {
      await release(key);
      res.status(403).json({ error: "Faucet is devnet-only" });
      return;
    }

    const tx = new Transaction();
    if (kind === "sol") {
      tx.add(SystemProgram.transfer({ fromPubkey: faucet.publicKey, toPubkey: user, lamports: SOL_LAMPORTS }));
    } else {
      const faucetAta = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, faucet.publicKey, false, TOKEN_PROGRAM_ID);
      const userAta = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, user, false, TOKEN_PROGRAM_ID);
      const userAtaInfo = await connection.getAccountInfo(userAta);
      if (!userAtaInfo) {
        tx.add(createAssociatedTokenAccountInstruction(faucet.publicKey, userAta, user, DEVNET_USDC_MINT, TOKEN_PROGRAM_ID));
      }
      tx.add(createTransferInstruction(faucetAta, userAta, faucet.publicKey, USDC_AMOUNT, [], TOKEN_PROGRAM_ID));
    }

    // Faucet is fee payer + authority — the user signs nothing.
    tx.feePayer = faucet.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(faucet);

    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(sig, "confirmed");

    if (kind === "sol") {
      res.status(200).json({ signature: sig, kind, sol: SOL_LAMPORTS / 1e9 });
      return;
    }
    let balance: number | undefined;
    try {
      const userAta = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, user, false, TOKEN_PROGRAM_ID);
      const acct = await getAccount(connection, userAta);
      balance = Number(acct.amount) / 10 ** USDC_DECIMALS;
    } catch {
      /* balance readback is best-effort */
    }
    res.status(200).json({ signature: sig, kind, balance });
  } catch (err: any) {
    // A failed transfer must NOT burn the user's cooldown window.
    await release(key);
    res.status(500).json({ error: err?.message ?? "Faucet transfer failed" });
  }
}
