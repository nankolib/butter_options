// =============================================================================
// canary/chain.ts — PDA derivations and cancel builders for the canary + sweep
// =============================================================================
//
// Every seed and account list here is COPIED from the shipped call sites rather
// than re-derived from memory:
//
//   resting_order / resting_order_escrow  app/src/utils/constants.ts
//   trigger_order / trigger_escrow        app/src/utils/triggerBundle.ts
//   cancel_order account list             app/src/pages/trade/orderFlows.ts
//   cancel_trigger account list           idl/opta.json
//
// A canary that cancels with a hand-guessed account list is a canary that can
// leave the thing it was supposed to clean up. The sweep is the safety net, so
// its instructions must be the ones already proven in production.
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import BN from "bn.js";
import { Buffer } from "buffer";

export const PROTOCOL_SEED = "protocol_v2";
export const RESTING_ORDER_SEED = "resting_order";
export const RESTING_ORDER_ESCROW_SEED = "resting_order_escrow";
export const TRIGGER_ORDER_SEED = "trigger_order";
export const TRIGGER_ESCROW_SEED = "trigger_escrow";

/** Copied from app/src/utils/constants.ts — NEVER retyped from memory. An
 *  invented program id derives invented hook PDAs, and cancel_order then fails
 *  on a constraint that looks like a protocol bug rather than a typo. */
export const TRANSFER_HOOK_PROGRAM_ID = new PublicKey(
  "83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG",
);

const pda = (seeds: (Buffer | Uint8Array)[], pid: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, pid)[0];

export const protocolStatePda = (pid: PublicKey) =>
  pda([Buffer.from(PROTOCOL_SEED)], pid);

export const restingOrderPda = (optionMint: PublicKey, owner: PublicKey, nonce: BN, pid: PublicKey) =>
  pda([Buffer.from(RESTING_ORDER_SEED), optionMint.toBuffer(), owner.toBuffer(),
       nonce.toArrayLike(Buffer, "le", 8)], pid);

export const restingOrderEscrowPda = (order: PublicKey, pid: PublicKey) =>
  pda([Buffer.from(RESTING_ORDER_ESCROW_SEED), order.toBuffer()], pid);

export const triggerOrderPda = (owner: PublicKey, optionMint: PublicKey, nonce: BN, pid: PublicKey) =>
  pda([Buffer.from(TRIGGER_ORDER_SEED), owner.toBuffer(), optionMint.toBuffer(),
       nonce.toArrayLike(Buffer, "le", 8)], pid);

export const triggerEscrowPda = (triggerOrder: PublicKey, pid: PublicKey) =>
  pda([Buffer.from(TRIGGER_ESCROW_SEED), triggerOrder.toBuffer()], pid);

export const extraAccountMetaListPda = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.toBuffer()], TRANSFER_HOOK_PROGRAM_ID)[0];

export const hookStatePda = (mint: PublicKey) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("hook-state"), mint.toBuffer()], TRANSFER_HOOK_PROGRAM_ID)[0];

/** Cancel a resting order. Mirrors orderFlows.cancelOrder exactly. */
export async function buildCancelOrder(
  p: anchor.Program<any>, owner: PublicKey, optionMint: PublicKey,
  order: PublicKey, usdcMint: PublicKey,
): Promise<TransactionInstruction> {
  return p.methods.cancelOrder().accountsStrict({
    owner,
    optionMint,
    order,
    escrow: restingOrderEscrowPda(order, p.programId),
    protocolState: protocolStatePda(p.programId),
    ownerOptionAccount: getAssociatedTokenAddressSync(optionMint, owner, false, TOKEN_2022_PROGRAM_ID),
    ownerUsdcAccount: getAssociatedTokenAddressSync(usdcMint, owner, false, TOKEN_PROGRAM_ID),
    transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
    extraAccountMetaList: extraAccountMetaListPda(optionMint),
    hookState: hookStatePda(optionMint),
    tokenProgram: TOKEN_PROGRAM_ID,
    token2022Program: TOKEN_2022_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  }).instruction();
}

/**
 * Cancel a trigger.
 *
 * `ocoPeer` is OPTIONAL on the instruction but load-bearing when the order is
 * half of a pair: cancelling one leg must unlink the other, or the survivor is
 * left pointing at a closed account and becomes uncancellable (6087). That was a
 * real bricking during the B2 arc, so the peer is passed whenever it is known
 * and explicitly null only when the order is genuinely unpaired.
 */
export async function buildCancelTrigger(
  p: anchor.Program<any>, owner: PublicKey, triggerOrder: PublicKey,
  usdcMint: PublicKey, ocoPeer: PublicKey | null,
): Promise<TransactionInstruction> {
  return p.methods.cancelTrigger().accountsStrict({
    owner,
    triggerOrder,
    triggerEscrow: triggerEscrowPda(triggerOrder, p.programId),
    protocolState: protocolStatePda(p.programId),
    ownerUsdcAccount: getAssociatedTokenAddressSync(usdcMint, owner, false, TOKEN_PROGRAM_ID),
    tokenProgram: TOKEN_PROGRAM_ID,
    ocoPeer,
  }).instruction();
}

export async function accountExists(
  conn: anchor.web3.Connection, key: PublicKey,
): Promise<boolean> {
  const info = await conn.getAccountInfo(key, "confirmed");
  return info !== null;
}
