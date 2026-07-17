// =============================================================================
// chain.ts — connection, Anchor program, protocol context, balances, tx send.
// =============================================================================

import * as fs from "fs";
import * as anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, LAMPORTS_PER_SOL,
  TransactionMessage, VersionedTransaction, type TransactionInstruction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { protocolStatePda, epochConfigPda, TOKEN_PROGRAM_ID } from "./ids";
import { log } from "./log";
import type { WriterConfig } from "./env";

export interface Chain {
  connection: Connection;
  program: anchor.Program<any>;
  wallet: Keypair;
  protocolState: PublicKey;
  epochConfig: PublicKey;
  usdcMint: PublicKey;
  treasury: PublicKey;
  ownerUsdcAta: PublicKey;
  epochMinLeadSecs: number;
}

const bnNum = (v: any, dflt = 0): number => {
  if (v == null) return dflt;
  if (typeof v === "number") return v;
  if (typeof v.toNumber === "function") { try { return v.toNumber(); } catch { return dflt; } }
  const n = Number(v.toString?.() ?? v);
  return Number.isFinite(n) ? n : dflt;
};

export async function initChain(cfg: WriterConfig): Promise<Chain> {
  const connection = new Connection(cfg.rpcUrl, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(cfg.wallet), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(cfg.idlPath, "utf-8"));
  const program = new anchor.Program<any>(idl, provider);

  const protocolState = protocolStatePda();
  const ps: any = await (program.account as any).protocolState.fetch(protocolState);
  const usdcMint = new PublicKey(ps.usdcMint);
  const treasury = new PublicKey(ps.treasury ?? ps.treasuryV2 ?? protocolState);

  const epochConfig = epochConfigPda();
  let epochMinLeadSecs = 0;
  try {
    const ec: any = await (program.account as any).epochConfig.fetch(epochConfig);
    const days = bnNum(ec.minEpochDurationDays ?? ec.min_epoch_duration_days, 0);
    epochMinLeadSecs = Math.max(0, days) * 86400;
  } catch {
    epochMinLeadSecs = 86400; // conservative default if config unreadable
  }

  const ownerUsdcAta = getAssociatedTokenAddressSync(usdcMint, cfg.wallet.publicKey, false, TOKEN_PROGRAM_ID);

  return { connection, program, wallet: cfg.wallet, protocolState, epochConfig, usdcMint, treasury, ownerUsdcAta, epochMinLeadSecs };
}

export async function getBalanceSol(chain: Chain): Promise<number> {
  return (await chain.connection.getBalance(chain.wallet.publicKey)) / LAMPORTS_PER_SOL;
}

/** Free (unlocked) USDC in the bot's ATA. Locked collateral already sits in
 *  per-order escrows, so the ATA balance IS the deployable balance. */
export async function getFreeUsdc(chain: Chain): Promise<number> {
  try {
    const r = await chain.connection.getTokenAccountBalance(chain.ownerUsdcAta);
    return Number(r.value.amount) / 1e6;
  } catch {
    return 0; // no ATA yet → zero free USDC
  }
}

/**
 * Send + confirm a legacy tx of `ixs`, signed by the bot wallet. Throws on a
 * confirmed error or timeout; the engine handles idempotent re-check + retry.
 */
export async function sendTx(chain: Chain, ixs: TransactionInstruction[]): Promise<string> {
  const bh = await chain.connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: chain.wallet.publicKey,
      recentBlockhash: bh.blockhash,
      instructions: ixs,
    }).compileToLegacyMessage(),
  );
  tx.sign([chain.wallet]);
  const sig = await chain.connection.sendTransaction(tx, { skipPreflight: false, maxRetries: 3 });
  const conf = await chain.connection.confirmTransaction(
    { signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight },
    "confirmed",
  );
  if (conf.value.err) throw new Error(`tx ${sig} failed: ${JSON.stringify(conf.value.err)}`);
  return sig;
}

/** True if the account exists (used for idempotent skip / retry re-check). */
export async function accountExists(chain: Chain, pk: PublicKey): Promise<boolean> {
  const info = await chain.connection.getAccountInfo(pk, "confirmed").catch(() => null);
  return info != null;
}

export { bnNum };
