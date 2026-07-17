// =============================================================================
// ids.ts — pinned program IDs, PDA seeds, and derivation helpers.
// =============================================================================
// DEVNET ONLY. Every value here mirrors the on-chain Rust constants and the
// frontend's app/src/utils/constants.ts. These are stable Rust constants; the
// house pattern (crank/ladderGenerator.ts) pins them locally rather than
// cross-importing so this package stays a standalone tsc->dist build.
//
// If the program is redeployed to a new address or a seed changes, update BOTH
// here and app/src/utils/constants.ts in lockstep (see the Lockstep Constants
// discipline). A wrong seed silently derives the wrong PDA — never a loud error.
// =============================================================================

import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

export const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
export const HOOK_ID = new PublicKey("83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG");

export { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID };

// PDA seeds — must match programs/opta/src + app/src/utils/constants.ts.
export const SEED = {
  protocol: "protocol_v2",
  market: "market",
  volOracle: "vol_oracle",
  epochConfig: "epoch_config",
  // Canonical series mint (create_series): [vault_option_mint, market, strike_le8,
  // expiry_le8, [optionType], [exerciseStyle]] — the spec-only layout (NO writer,
  // NO created_at). The series RECORD stays [vault_mint_record, option_mint].
  optionMint: "vault_option_mint",
  mintRecord: "vault_mint_record",
  // American shared vault: [shared_vault_american, market, strike_le8, expiry_le8, [optionType]].
  vaultAmerican: "shared_vault_american",
  vaultUsdc: "vault_usdc",
  // Resting book: [resting_order, option_mint, owner, nonce_le8] -> order;
  //               [resting_order_escrow, order]                  -> per-order escrow.
  restingOrder: "resting_order",
  restingOrderEscrow: "resting_order_escrow",
  // transfer-hook program PDAs
  extraAccountMetas: "extra-account-metas",
  hookState: "hook-state",
} as const;

// ExerciseStyle / OptionType discriminants (u8), as encoded in the series-mint seed.
export const ES_AMERICAN = 1;
export const OPT_CALL = 0;
export const OPT_PUT = 1;

export const pda = (seeds: (Buffer | Uint8Array)[], programId: PublicKey = PROGRAM_ID): PublicKey =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];

export const le8 = (n: number | bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigInt64LE(BigInt(n));
  return b;
};

/** Micro-USDC (6dp) little-endian, used for strike bytes in the mint/vault seeds. */
export const strikeLe8 = (strikeMicro: bigint): Buffer => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(strikeMicro);
  return b;
};

// ---- Common PDA derivations -------------------------------------------------

export const protocolStatePda = (): PublicKey => pda([Buffer.from(SEED.protocol)]);
export const epochConfigPda = (): PublicKey => pda([Buffer.from(SEED.epochConfig)]);

export const marketPda = (assetName: string): PublicKey =>
  pda([Buffer.from(SEED.market), Buffer.from(assetName)]);

export const volOraclePda = (feedId: Uint8Array): PublicKey =>
  pda([Buffer.from(SEED.volOracle), Buffer.from(feedId)]);

/** Canonical series mint PDA for (market, strike, expiry, optionType, American). */
export const seriesMintPda = (
  market: PublicKey,
  strikeMicro: bigint,
  expiryTs: number,
  optIdx: number,
): PublicKey =>
  pda([
    Buffer.from(SEED.optionMint),
    market.toBuffer(),
    strikeLe8(strikeMicro),
    le8(expiryTs),
    Buffer.from([optIdx]),
    Buffer.from([ES_AMERICAN]),
  ]);

export const mintRecordPda = (optionMint: PublicKey): PublicKey =>
  pda([Buffer.from(SEED.mintRecord), optionMint.toBuffer()]);

/** American shared vault PDA (note: NO exercise-style byte, unlike the mint). */
export const vaultAmericanPda = (
  market: PublicKey,
  strikeMicro: bigint,
  expiryTs: number,
  optIdx: number,
): PublicKey =>
  pda([
    Buffer.from(SEED.vaultAmerican),
    market.toBuffer(),
    strikeLe8(strikeMicro),
    le8(expiryTs),
    Buffer.from([optIdx]),
  ]);

export const vaultUsdcPda = (vault: PublicKey): PublicKey =>
  pda([Buffer.from(SEED.vaultUsdc), vault.toBuffer()]);

export const restingOrderPda = (optionMint: PublicKey, owner: PublicKey, nonce: bigint): PublicKey => {
  const nb = Buffer.alloc(8);
  nb.writeBigUInt64LE(nonce);
  return pda([Buffer.from(SEED.restingOrder), optionMint.toBuffer(), owner.toBuffer(), nb]);
};

export const restingEscrowPda = (order: PublicKey): PublicKey =>
  pda([Buffer.from(SEED.restingOrderEscrow), order.toBuffer()]);

export const extraAccountMetaListPda = (mint: PublicKey): PublicKey =>
  pda([Buffer.from(SEED.extraAccountMetas), mint.toBuffer()], HOOK_ID);

export const hookStatePda = (mint: PublicKey): PublicKey =>
  pda([Buffer.from(SEED.hookState), mint.toBuffer()], HOOK_ID);
