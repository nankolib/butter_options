// =============================================================================
// crank/switchboardQuotePost.ts — Switchboard ED25519 quote-path update builder
// =============================================================================
//
// DORMANT. Nothing in the crank loops (bot.ts and friends) imports this module.
// It is the Switchboard analog of app/src/utils/pythPullPost.ts's
// buildPostUpdateAndXxxTx family: it assembles the V2 (ed25519) managed-update
// instructions that land signed oracle data on the quote program's PDA. It is
// exercised only by tests/probes until Stage 3 wires oracle-source routing
// dispatch (price_oracle.rs) + a crank loop. Building this tx does NOT make
// Switchboard live: settlement/exercise/vol reads still route unconditionally
// to Pyth on-chain (oracle_source is INERT).
//
// WHY THE SELF-PACK (workaround):
//   @switchboard-xyz/on-demand@3.10.3 / 3.10.4 mis-pack the multi-signature
//   ed25519 instruction (1-sig offset geometry reused for N>=2 -> native verify
//   Custom:2). We capture the verified triples the SDK feeds to its packer, then
//   replace ONLY the ed25519 instruction with a correctly-packed one
//   (packEd25519Ix). The quote-program instruction is left untouched.
//
// RIP-OUT TRIGGER:
//   When Switchboard ships a fixed `buildEd25519Instruction` upstream, delete
//   the capture-hook + swap below (and crank/ed25519SelfPack.ts) and use the
//   SDK's returned instructions verbatim.
//
// ROOT-CAUSE WRITE-UP: .opta-build/sb-ed25519-rootcause.md
// =============================================================================

import {
  Connection,
  PublicKey,
  Signer,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
  Ed25519Program,
} from "@solana/web3.js";
import type { Queue } from "@switchboard-xyz/on-demand";
import type { CrossbarClient, OracleFeed } from "@switchboard-xyz/common";

import { packEd25519Ix, Ed25519Triple } from "./ed25519SelfPack";

// Untyped deep require of the SAME CJS module instance the SDK uses internally,
// so patching the static method intercepts the SDK's own call.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const ED_UTILS = require("@switchboard-xyz/on-demand/dist/cjs/instruction-utils/ed25519-instruction-utils.js") as {
  Ed25519InstructionUtils: { buildEd25519Instruction: (...args: unknown[]) => TransactionInstruction };
};

export type BuiltTx = { tx: VersionedTransaction; signers: Signer[] };

/** The arguments the SDK passes to buildEd25519Instruction, captured verbatim.
 *  `signatures` are {oracleIdx, signature, pubkey, message} triples (Buffers),
 *  structurally an Ed25519Triple[]. */
export interface CapturedBuild {
  signatures: Ed25519Triple[];
  instructionIndex: number;
  recentSlot: number;
  version: number;
}

/**
 * Run `fn` with `Ed25519InstructionUtils.buildEd25519Instruction` temporarily
 * patched to record its arguments, then restore the original in a finally.
 * Scoped: the patch is never observable outside this call.
 */
export async function withEd25519CaptureHook<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; captured: CapturedBuild | null }> {
  const Cls = ED_UTILS.Ed25519InstructionUtils;
  const orig = Cls.buildEd25519Instruction;
  let captured: CapturedBuild | null = null;
  Cls.buildEd25519Instruction = function (
    this: unknown,
    ...args: unknown[]
  ): TransactionInstruction {
    captured = {
      signatures: args[0] as Ed25519Triple[],
      instructionIndex: args[1] as number,
      recentSlot: args[2] as number,
      version: args[3] as number,
    };
    return orig.apply(this, args);
  };
  try {
    const result = await fn();
    return { result, captured };
  } finally {
    Cls.buildEd25519Instruction = orig; // restore
  }
}

export interface ManagedQuoteUpdateOptions {
  numSignatures?: number; // default 2
  instructionIdx?: number; // default 1 (ed25519 ix position in [cu, ed25519, quote])
  variableOverrides?: Record<string, string>;
}

export interface ManagedQuoteUpdateResult {
  /** [ correctedEd25519Ix, quoteProgramIx ] — the SDK's quote ix, untouched. */
  ixs: TransactionInstruction[];
  ed25519Index: number;
  sdkEd25519DataLen: number;
  selfPackedEd25519DataLen: number;
  captured: CapturedBuild;
}

/**
 * Build the managed quote-update instructions with the broken SDK ed25519 ix
 * swapped for a correctly-packed one. Leaves the quote-program ix untouched.
 */
export async function buildManagedQuoteUpdateIxs(
  queue: Queue,
  crossbar: CrossbarClient,
  feed: OracleFeed,
  payer: PublicKey,
  opts: ManagedQuoteUpdateOptions = {},
): Promise<ManagedQuoteUpdateResult> {
  const numSignatures = opts.numSignatures ?? 2;
  const instructionIdx = opts.instructionIdx ?? 1;

  const { result: ixs, captured } = await withEd25519CaptureHook(() =>
    queue.fetchManagedUpdateIxs(crossbar, [feed], {
      numSignatures,
      instructionIdx,
      variableOverrides: opts.variableOverrides ?? {},
      payer,
    }) as Promise<TransactionInstruction[]>,
  );

  if (!captured) {
    throw new Error(
      "buildManagedQuoteUpdateIxs: capture hook never fired (SDK did not call buildEd25519Instruction)",
    );
  }

  const edPid = Ed25519Program.programId.toBase58();
  const edPos = ixs.findIndex((ix) => ix.programId.toBase58() === edPid);
  if (edPos < 0) throw new Error("buildManagedQuoteUpdateIxs: no Ed25519 instruction in SDK output");

  const sdkLen = Buffer.from(ixs[edPos].data).length;
  const corrected = packEd25519Ix(
    captured.signatures,
    captured.instructionIndex,
    captured.recentSlot,
    captured.version,
  );
  const swapped = ixs.map((ix, k) => (k === edPos ? corrected : ix));

  return {
    ixs: swapped,
    ed25519Index: edPos,
    sdkEd25519DataLen: sdkLen,
    selfPackedEd25519DataLen: Buffer.from(corrected.data).length,
    captured,
  };
}

export interface SwitchboardQuoteUpdateTxParams {
  connection: Connection;
  queue: Queue;
  crossbar: CrossbarClient;
  feed: OracleFeed;
  payer: Signer; // pays for + signs the tx
  computeUnitLimit?: number; // default 400_000
  numSignatures?: number;
  instructionIdx?: number;
  variableOverrides?: Record<string, string>;
}

/**
 * Assemble a ready-to-submit VersionedTransaction:
 *   [ setComputeUnitLimit, correctedEd25519Ix, quoteProgramIx ]
 * signed by `payer`. Shape mirrors pythPullPost's BuiltTx return.
 *
 * NOTE: dormant — no crank loop calls this. Submission stays a manual smoke
 * until Stage 3 routing + crank wiring exist.
 */
export async function buildSwitchboardQuoteUpdateTx(
  p: SwitchboardQuoteUpdateTxParams,
): Promise<BuiltTx> {
  const cuLimit = p.computeUnitLimit ?? 400_000;
  const { ixs } = await buildManagedQuoteUpdateIxs(p.queue, p.crossbar, p.feed, p.payer.publicKey, {
    numSignatures: p.numSignatures,
    instructionIdx: p.instructionIdx,
    variableOverrides: p.variableOverrides,
  });
  const cu = ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit });
  const allIxs = [cu, ...ixs];
  const { blockhash } = await p.connection.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: p.payer.publicKey,
    recentBlockhash: blockhash,
    instructions: allIxs,
  }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([p.payer]);
  return { tx, signers: [p.payer] };
}
