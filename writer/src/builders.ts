// =============================================================================
// builders.ts — instruction builders for the WriterAsk market-maker flow.
// =============================================================================
// Self-contained (account shapes mirror app/src/pages/trade/orderFlows.ts, which
// are devnet-proven). Return TransactionInstructions so the engine composes,
// sends, confirms, and retries txs itself.
//
// Per cell the setup is: create_series (canonical mint+record, writer==default)
// + create_shared_vault (0-pool; Epoch for crypto @08:00Z, Custom for equity
// @19:45Z) + post_order(WriterAsk). Only post_order locks collateral (1×strike
// ×qty into a per-order escrow). Reprice/unwind is cancel_order (full escrow ->
// owner). No fill_* here — a write-only bot never takes, so 6014 is unreachable.
// =============================================================================

import type { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  PublicKey, SystemProgram, ComputeBudgetProgram, SYSVAR_RENT_PUBKEY, type TransactionInstruction,
} from "@solana/web3.js";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  HOOK_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID,
  mintRecordPda, vaultUsdcPda, restingOrderPda, restingEscrowPda,
  extraAccountMetaListPda, hookStatePda,
} from "./ids";

export type OptionSide = "call" | "put";
export type VaultKind = "epoch" | "custom";

export interface BuildCtx {
  program: Program<any>;
  owner: PublicKey;         // the bot wallet
  protocolState: PublicKey;
  usdcMint: PublicKey;
  epochConfig: PublicKey;   // required for Epoch vaults; ignored for Custom
}

const optArg = (s: OptionSide) => (s === "call" ? { call: {} } : { put: {} });
export const CU = (u: number) => ComputeBudgetProgram.setComputeUnitLimit({ units: u });

/**
 * create_series — the canonical fungible American mint for
 * (market, strike, expiry, side). Idempotent: reverts if the record already
 * exists, so the caller must skip when present. ~0.0135 SOL rent.
 */
export async function createSeriesIx(
  ctx: BuildCtx, market: PublicKey, seriesMint: PublicKey,
  strikeMicro: BN, expiry: BN, side: OptionSide,
): Promise<TransactionInstruction> {
  return ctx.program.methods
    .createSeries(strikeMicro, expiry, optArg(side) as any, { american: {} } as any)
    .accountsStrict({
      caller: ctx.owner,
      market,
      protocolState: ctx.protocolState,
      optionMint: seriesMint,
      vaultMintRecord: mintRecordPda(seriesMint),
      transferHookProgram: HOOK_ID,
      extraAccountMetaList: extraAccountMetaListPda(seriesMint),
      hookState: hookStatePda(seriesMint),
      systemProgram: SystemProgram.programId,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();
}

/**
 * create_shared_vault — a ZERO-POOL American vault (no deposit). Only needed so
 * post_order(WriterAsk) can read Account<SharedVault>; the ask escrows its own
 * collateral per-order, so the pool stays empty. ~0.0066 SOL rent.
 *   - kind "epoch"  → vault_type Epoch, epoch_config required (crypto, 08:00Z).
 *   - kind "custom" → vault_type Custom, epoch_config null (equity, 19:45Z).
 * Anchor 0.32 optional accounts: pass null when absent.
 */
export async function createSharedVaultIx(
  ctx: BuildCtx, market: PublicKey, vault: PublicKey,
  strikeMicro: BN, expiry: BN, side: OptionSide, kind: VaultKind,
): Promise<TransactionInstruction> {
  const vaultType = kind === "epoch" ? { epoch: {} } : { custom: {} };
  return ctx.program.methods
    .createSharedVault(strikeMicro, expiry, optArg(side) as any, vaultType as any, ctx.usdcMint, 0, { american: {} } as any)
    .accountsStrict({
      creator: ctx.owner,
      market,
      sharedVault: vault,
      vaultUsdcAccount: vaultUsdcPda(vault),
      usdcMint: ctx.usdcMint,
      protocolState: ctx.protocolState,
      epochConfig: kind === "epoch" ? ctx.epochConfig : null,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/**
 * post_order(WriterAsk) — rest a sell-by-writing ask on the canonical series.
 * Collateral (1×strike×qty USDC) is protocol-set and escrowed at post from the
 * owner's USDC ATA; `priceMicro` is the maker's ask PREMIUM per contract (NOT
 * the collateral). The owner must hold strike×qty USDC.
 */
export async function postWriterAskIx(
  ctx: BuildCtx, market: PublicKey, vault: PublicKey, seriesMint: PublicKey,
  priceMicro: BN, quantity: number, nonce: bigint,
): Promise<{ ix: TransactionInstruction; order: PublicKey }> {
  const order = restingOrderPda(seriesMint, ctx.owner, nonce);
  const ownerOption = getAssociatedTokenAddressSync(seriesMint, ctx.owner, false, TOKEN_2022_PROGRAM_ID);
  const ownerUsdc = getAssociatedTokenAddressSync(ctx.usdcMint, ctx.owner, false, TOKEN_PROGRAM_ID);
  const ix = await ctx.program.methods
    .postOrder({ writerAsk: {} } as any, priceMicro, new BN(quantity), new BN(nonce.toString()))
    .accountsStrict({
      owner: ctx.owner,
      sharedVault: vault,
      market,
      vaultMintRecord: mintRecordPda(seriesMint),
      optionMint: seriesMint,
      order,
      escrow: restingEscrowPda(order),
      protocolState: ctx.protocolState,
      ownerOptionAccount: ownerOption,
      ownerUsdcAccount: ownerUsdc,
      usdcMint: ctx.usdcMint,
      transferHookProgram: HOOK_ID,
      extraAccountMetaList: extraAccountMetaListPda(seriesMint),
      hookState: hookStatePda(seriesMint),
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();
  return { ix, order };
}

/**
 * cancel_order — owner-only unwind. Refunds the full remaining escrow
 * (cpt×quantity_remaining USDC for a WriterAsk) to the owner USDC ATA and closes
 * escrow + order (rent -> owner). No args (nonce is read on-chain). All 13
 * accounts are required regardless of kind.
 */
export async function cancelOrderIx(
  ctx: BuildCtx, seriesMint: PublicKey, order: PublicKey,
): Promise<TransactionInstruction> {
  const ownerOption = getAssociatedTokenAddressSync(seriesMint, ctx.owner, false, TOKEN_2022_PROGRAM_ID);
  const ownerUsdc = getAssociatedTokenAddressSync(ctx.usdcMint, ctx.owner, false, TOKEN_PROGRAM_ID);
  return ctx.program.methods
    .cancelOrder()
    .accountsStrict({
      owner: ctx.owner,
      optionMint: seriesMint,
      order,
      escrow: restingEscrowPda(order),
      protocolState: ctx.protocolState,
      ownerOptionAccount: ownerOption,
      ownerUsdcAccount: ownerUsdc,
      transferHookProgram: HOOK_ID,
      extraAccountMetaList: extraAccountMetaListPda(seriesMint),
      hookState: hookStatePda(seriesMint),
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();
}

/**
 * post_order(Bid) — rest a USDC-escrowed limit bid on the canonical series. The
 * account list is IDENTICAL to postWriterAskIx (post_order takes a uniform
 * context and branches on `kind` internally); only the kind arg and the escrow
 * semantics differ. A Bid escrows `priceMicro × quantity` USDC — the premium
 * itself, not strike×qty collateral — which is why a bid locks roughly 1-6% of
 * what the equivalent ask locks.
 *
 * Requires the series + vault to ALREADY exist. That always holds here: a bid is
 * a dependent quote and is only ever derived for a series that already carries
 * one of the bot's resting asks, so it mints nothing and adds no permanent rent.
 */
export async function postBidIx(
  ctx: BuildCtx, market: PublicKey, vault: PublicKey, seriesMint: PublicKey,
  priceMicro: BN, quantity: number, nonce: bigint,
): Promise<{ ix: TransactionInstruction; order: PublicKey }> {
  const order = restingOrderPda(seriesMint, ctx.owner, nonce);
  const ownerOption = getAssociatedTokenAddressSync(seriesMint, ctx.owner, false, TOKEN_2022_PROGRAM_ID);
  const ownerUsdc = getAssociatedTokenAddressSync(ctx.usdcMint, ctx.owner, false, TOKEN_PROGRAM_ID);
  const ix = await ctx.program.methods
    .postOrder({ bid: {} } as any, priceMicro, new BN(quantity), new BN(nonce.toString()))
    .accountsStrict({
      owner: ctx.owner,
      sharedVault: vault,
      market,
      vaultMintRecord: mintRecordPda(seriesMint),
      optionMint: seriesMint,
      order,
      escrow: restingEscrowPda(order),
      protocolState: ctx.protocolState,
      ownerOptionAccount: ownerOption,
      ownerUsdcAccount: ownerUsdc,
      usdcMint: ctx.usdcMint,
      transferHookProgram: HOOK_ID,
      extraAccountMetaList: extraAccountMetaListPda(seriesMint),
      hookState: hookStatePda(seriesMint),
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();
  return { ix, order };
}
