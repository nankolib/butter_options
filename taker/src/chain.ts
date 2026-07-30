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
import { protocolStatePda, TOKEN_PROGRAM_ID } from "./ids";
import type { TakerConfig } from "./env";

export interface Chain {
  connection: Connection;
  program: anchor.Program<any>;
  wallet: Keypair;
  protocolState: PublicKey;
  usdcMint: PublicKey;
  treasury: PublicKey;
  ownerUsdcAta: PublicKey;
}

export async function initChain(cfg: TakerConfig): Promise<Chain> {
  const connection = new Connection(cfg.rpcUrl, "confirmed");
  const provider = new anchor.AnchorProvider(connection, new anchor.Wallet(cfg.wallet), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(cfg.idlPath, "utf-8"));
  const program = new anchor.Program<any>(idl, provider);

  const protocolState = protocolStatePda();
  const ps: any = await (program.account as any).protocolState.fetch(protocolState);
  const usdcMint = new PublicKey(ps.usdcMint);
  const treasury = new PublicKey(ps.treasury ?? protocolState);
  const ownerUsdcAta = getAssociatedTokenAddressSync(usdcMint, cfg.wallet.publicKey, false, TOKEN_PROGRAM_ID);

  return { connection, program, wallet: cfg.wallet, protocolState, usdcMint, treasury, ownerUsdcAta };
}

export async function getBalanceSol(chain: Chain): Promise<number> {
  return (await chain.connection.getBalance(chain.wallet.publicKey)) / LAMPORTS_PER_SOL;
}

export async function getFreeUsdc(chain: Chain): Promise<number> {
  try {
    const r = await chain.connection.getTokenAccountBalance(chain.ownerUsdcAta);
    return Number(r.value.amount) / 1e6;
  } catch {
    return 0;
  }
}

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

export const bnNum = (v: any, dflt = 0): number => {
  if (v == null) return dflt;
  if (typeof v === "number") return v;
  if (typeof v.toNumber === "function") { try { return v.toNumber(); } catch { return dflt; } }
  const n = Number(v.toString?.() ?? v);
  return Number.isFinite(n) ? n : dflt;
};
