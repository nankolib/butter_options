// ============================================================================
// Server-side devnet USDC faucet  (H-04 remediation)
// ============================================================================
// Replaces the old browser-bundled DEVNET_FAUCET_KEYPAIR. The faucet signing
// key now lives ONLY in the server-only env var FAUCET_SECRET_KEY (no VITE_ /
// NEXT_PUBLIC_ prefix — it is never inlined into the client bundle). The
// browser POSTs { wallet } here; this route signs and sends the USDC transfer
// entirely server-side, so no private key ever reaches the client.
//
// This file lives under app/api/ and is deployed by Vercel as a Node.js
// Serverless Function (project root = app/). It is NOT part of the Vite/tsc
// client build (outside src/), so it is never bundled into the SPA.
//
// Env vars (set in Vercel — Nanko adds the secret value himself):
//   FAUCET_SECRET_KEY  (required)  JSON array of 64 bytes, e.g. the exact
//                                  contents of a `solana-keygen new` file.
//   FAUCET_RPC_URL     (optional)  devnet RPC; defaults to public devnet.
//
// Guards:
//   - devnet-only: refuses unless the RPC's genesis hash is the devnet genesis
//   - fixed per-request cap (FAUCET_AMOUNT_USDC)
//   - best-effort per-wallet cooldown (module-scope Map; resets on cold start —
//     durable throttling would need Vercel KV, deliberately out of scope here)
// ============================================================================

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAccount,
} from "@solana/spl-token";

// Devnet genesis hash — the hard cluster guard. A mainnet/testnet RPC will not
// match, so the faucet physically cannot sign against the wrong cluster.
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";

// Mock devnet USDC mint (mirror of DEVNET_USDC_MINT in app/src/utils/constants.ts).
const DEVNET_USDC_MINT = new PublicKey("AytU5HUQRew9VdUdrzQuZvZ7s14pHLiYjAF5WqdK3oxL");

const USDC_DECIMALS = 6;
const FAUCET_AMOUNT_USDC = Number(process.env.FAUCET_AMOUNT_USDC ?? 10_000);
const AMOUNT = Math.round(FAUCET_AMOUNT_USDC * 10 ** USDC_DECIMALS); // fixed cap per request
const COOLDOWN_MS = 60_000;

// Best-effort per-wallet cooldown. Survives only within a warm function
// instance; a cold start resets it. Acceptable for a devnet demo faucet.
const lastServed = new Map<string, number>();

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

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  const faucet = loadFaucet();
  if (!faucet) {
    // Env var missing/malformed — the client renders a graceful
    // "Faucet not configured" toast on 503.
    res.status(503).json({ error: "Faucet not configured" });
    return;
  }

  // Parse and validate the requesting wallet.
  let walletStr: unknown;
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    walletStr = body?.wallet;
  } catch {
    /* handled below */
  }
  let user: PublicKey;
  try {
    user = new PublicKey(String(walletStr));
  } catch {
    res.status(400).json({ error: "Invalid wallet address" });
    return;
  }

  // Best-effort per-wallet cooldown.
  const key = user.toBase58();
  const now = Date.now();
  const prev = lastServed.get(key);
  if (prev && now - prev < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (now - prev)) / 1000);
    res.status(429).json({ error: `Cooldown — try again in ${wait}s` });
    return;
  }

  const rpcUrl = process.env.FAUCET_RPC_URL?.trim() || "https://api.devnet.solana.com";
  const connection = new Connection(rpcUrl, "confirmed");

  try {
    // Hard devnet-only guard.
    const genesis = await connection.getGenesisHash();
    if (genesis !== DEVNET_GENESIS) {
      res.status(403).json({ error: "Faucet is devnet-only" });
      return;
    }

    const faucetAta = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, faucet.publicKey, false, TOKEN_PROGRAM_ID);
    const userAta = getAssociatedTokenAddressSync(DEVNET_USDC_MINT, user, false, TOKEN_PROGRAM_ID);

    const tx = new Transaction();
    // Faucet pays rent for the user's ATA if it doesn't exist yet.
    const userAtaInfo = await connection.getAccountInfo(userAta);
    if (!userAtaInfo) {
      tx.add(createAssociatedTokenAccountInstruction(faucet.publicKey, userAta, user, DEVNET_USDC_MINT, TOKEN_PROGRAM_ID));
    }
    tx.add(createTransferInstruction(faucetAta, userAta, faucet.publicKey, AMOUNT, [], TOKEN_PROGRAM_ID));

    // Faucet is both fee payer and transfer authority — the user signs nothing.
    tx.feePayer = faucet.publicKey;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    tx.sign(faucet);

    const sig = await connection.sendRawTransaction(tx.serialize());
    await connection.confirmTransaction(sig, "confirmed");
    lastServed.set(key, now);

    let balance: number | undefined;
    try {
      const acct = await getAccount(connection, userAta);
      balance = Number(acct.amount) / 10 ** USDC_DECIMALS;
    } catch {
      /* balance readback is best-effort */
    }

    res.status(200).json({ signature: sig, balance });
  } catch (err: any) {
    res.status(500).json({ error: err?.message ?? "Faucet transfer failed" });
  }
}
