// =============================================================================
// ids.ts — pinned program IDs, PDA seeds, derivations (vendored from writer/)
// =============================================================================
// DEVNET ONLY. Every value mirrors the on-chain Rust constants and
// app/src/utils/constants.ts. Pinned locally rather than cross-imported so this
// package stays a standalone tsc->dist build (house pattern).
//
// LOCKSTEP: a program redeploy to a new address, or any seed change, must update
// writer/src/ids.ts, crank/, app/src/utils/constants.ts AND this file together.
// A wrong seed silently derives the wrong PDA — never a loud error.
// =============================================================================

import { PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";

export const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
export const HOOK_ID = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");

export { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID };

export const SEED = {
  protocol: "protocol_v2",
  volOracle: "vol_oracle",
  restingOrderEscrow: "resting_order_escrow",
  extraAccountMetas: "extra-account-metas",
  hookState: "hook-state",
} as const;

export const pda = (seeds: (Buffer | Uint8Array)[], programId: PublicKey = PROGRAM_ID): PublicKey =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];

export const protocolStatePda = (): PublicKey => pda([Buffer.from(SEED.protocol)]);

export const volOraclePda = (feedId: Uint8Array): PublicKey =>
  pda([Buffer.from(SEED.volOracle), Buffer.from(feedId)]);

export const restingEscrowPda = (order: PublicKey): PublicKey =>
  pda([Buffer.from(SEED.restingOrderEscrow), order.toBuffer()]);

export const extraAccountMetaListPda = (mint: PublicKey): PublicKey =>
  pda([Buffer.from(SEED.extraAccountMetas), mint.toBuffer()], HOOK_ID);

export const hookStatePda = (mint: PublicKey): PublicKey =>
  pda([Buffer.from(SEED.hookState), mint.toBuffer()], HOOK_ID);
