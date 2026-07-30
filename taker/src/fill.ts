// =============================================================================
// fill.ts — the ONLY code path in this service that spends money
// =============================================================================
//
// The account block MIRRORS the proven builder in
// app/src/pages/trade/orderFlows.ts (`buildFillOrderIx`), account for account.
// That shape is production-proven on devnet; the taker deliberately copies it
// rather than deriving a fresh one, because an fill_order account list that is
// merely plausible fails at simulate on a good day and mis-routes funds on a bad
// one.
//
// Measured cost: fill_order against a ResaleAsk is ~114K CU. The 400K limit is
// the same headroom the frontend uses.
// =============================================================================

import type { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  PublicKey, SystemProgram, ComputeBudgetProgram, type TransactionInstruction,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import {
  HOOK_ID, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  restingEscrowPda, extraAccountMetaListPda, hookStatePda, mintRecordPda,
  writerAskPotPda, writerAskPotUsdcPda, writerAskPositionPda,
} from "./ids";
import type { Chain } from "./chain";
import { sendTx } from "./chain";
import type { UserAsk } from "./scan";

const FILL_CU_LIMIT = 400_000;

/** Dispatch on kind. The two fills are DIFFERENT instructions, not a flag. */
export async function buildFillIxs(
  chain: Chain, ask: UserAsk, quantity: number,
): Promise<TransactionInstruction[]> {
  return ask.kind === "writerAsk"
    ? buildFillWriterAskIxs(chain, ask, quantity)
    : buildFillOrderIxs(chain, ask, quantity);
}

/**
 * fill_order — buying `quantity` contracts off a ResaleAsk. Contracts TRANSFER
 * from the maker, so the transfer hook fires and its accounts are required.
 */
export async function buildFillOrderIxs(
  chain: Chain, ask: UserAsk, quantity: number,
): Promise<TransactionInstruction[]> {
  const { program } = chain;
  const taker = chain.wallet.publicKey;
  const maker = ask.owner;
  const optionMint = ask.optionMint;

  const takerUsdc = getAssociatedTokenAddressSync(chain.usdcMint, taker, false, TOKEN_PROGRAM_ID);
  const makerUsdc = getAssociatedTokenAddressSync(chain.usdcMint, maker, false, TOKEN_PROGRAM_ID);
  const takerOption = getAssociatedTokenAddressSync(optionMint, taker, false, TOKEN_2022_PROGRAM_ID);
  const makerOption = getAssociatedTokenAddressSync(optionMint, maker, false, TOKEN_2022_PROGRAM_ID);

  // Buying an ask: the TAKER receives the contracts, so the taker's Token-2022
  // ATA is the one that must exist. Idempotent — a no-op after the first series.
  const ataIx = createAssociatedTokenAccountIdempotentInstruction(
    taker, takerOption, taker, optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

  const fill = await program.methods.fillOrder(new BN(quantity)).accountsStrict({
    taker,
    optionMint,
    order: ask.pubkey,
    maker,
    sharedVault: ask.vault,
    escrow: restingEscrowPda(ask.pubkey),
    protocolState: chain.protocolState,
    treasury: chain.treasury,
    takerUsdcAccount: takerUsdc,
    makerUsdcAccount: makerUsdc,
    takerOptionAccount: takerOption,
    makerOptionAccount: makerOption,
    transferHookProgram: HOOK_ID,
    extraAccountMetaList: extraAccountMetaListPda(optionMint),
    hookState: hookStatePda(optionMint),
    tokenProgram: TOKEN_PROGRAM_ID,
    token2022Program: TOKEN_2022_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  }).instruction();

  return [ComputeBudgetProgram.setComputeUnitLimit({ units: FILL_CU_LIMIT }), ataIx, fill];
}

/**
 * fill_writer_ask — buying `quantity` contracts off a WriterAsk.
 *
 * A DIFFERENT instruction from fill_order, not a variant of it. The maker's
 * contracts do not exist yet: they are MINTED on fill against the collateral the
 * maker escrowed at post time. So the account set differs in three ways, each of
 * which is a silent failure if copied from the wrong builder:
 *   + writer-ask pot / pot-USDC / position, and the vault mint record
 *   - no maker option account — the maker never holds the contracts
 *   - no transfer-hook accounts — mint_to does not fire the hook
 *
 * Mirrors `buildFillWriterAskIx` in app/src/pages/trade/orderFlows.ts, whose
 * account ORDER in turn mirrors scripts/_smoke_writer_ask_devnet.ts (live 13/13).
 */
export async function buildFillWriterAskIxs(
  chain: Chain, ask: UserAsk, quantity: number,
): Promise<TransactionInstruction[]> {
  const { program } = chain;
  const taker = chain.wallet.publicKey;
  const maker = ask.owner;
  const optionMint = ask.optionMint;

  const takerUsdc = getAssociatedTokenAddressSync(chain.usdcMint, taker, false, TOKEN_PROGRAM_ID);
  const makerUsdc = getAssociatedTokenAddressSync(chain.usdcMint, maker, false, TOKEN_PROGRAM_ID);
  const takerOption = getAssociatedTokenAddressSync(optionMint, taker, false, TOKEN_2022_PROGRAM_ID);

  // Three idempotent ATA creates. The maker's USDC ATA is created defensively:
  // they normally have one from posting the ask, but a closed account would
  // otherwise fail the fill at the premium transfer.
  const takerOptIx = createAssociatedTokenAccountIdempotentInstruction(
    taker, takerOption, taker, optionMint, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);
  const takerUsdcIx = createAssociatedTokenAccountIdempotentInstruction(
    taker, takerUsdc, taker, chain.usdcMint, TOKEN_PROGRAM_ID);
  const makerUsdcIx = createAssociatedTokenAccountIdempotentInstruction(
    taker, makerUsdc, maker, chain.usdcMint, TOKEN_PROGRAM_ID);

  const fill = await program.methods.fillWriterAsk(new BN(quantity)).accountsStrict({
    taker,
    optionMint,
    order: ask.pubkey,
    maker,
    sharedVault: ask.vault,
    vaultMintRecord: mintRecordPda(optionMint),
    escrow: restingEscrowPda(ask.pubkey),
    protocolState: chain.protocolState,
    treasury: chain.treasury,
    takerUsdcAccount: takerUsdc,
    makerUsdcAccount: makerUsdc,
    takerOptionAccount: takerOption,
    writerAskPot: writerAskPotPda(optionMint),
    writerAskPotUsdc: writerAskPotUsdcPda(optionMint),
    writerAskPosition: writerAskPositionPda(optionMint, maker),
    usdcMint: chain.usdcMint,
    tokenProgram: TOKEN_PROGRAM_ID,
    token2022Program: TOKEN_2022_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  }).instruction();

  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units: FILL_CU_LIMIT }),
    takerOptIx, takerUsdcIx, makerUsdcIx, fill,
  ];
}

/** Send a built fill. Only ever reached with DRY_RUN=0 AND ARMED=1. */
export async function sendFill(chain: Chain, ixs: TransactionInstruction[]): Promise<string> {
  return sendTx(chain, ixs);
}

/**
 * Simulate without signing. Used in DRY_RUN so shadow mode proves the fill would
 * actually land — a shadow decision that says "would fill" while the tx would
 * have reverted is worse than no shadow at all.
 */
export async function simulateFill(
  chain: Chain, ixs: TransactionInstruction[],
): Promise<{ ok: true; unitsConsumed: number | null } | { ok: false; err: string }> {
  const { TransactionMessage, VersionedTransaction } = await import("@solana/web3.js");
  try {
    const { blockhash } = await chain.connection.getLatestBlockhash("confirmed");
    const msg = new TransactionMessage({
      payerKey: chain.wallet.publicKey,
      recentBlockhash: blockhash,
      instructions: ixs,
    }).compileToLegacyMessage();
    const sim = await chain.connection.simulateTransaction(new VersionedTransaction(msg), {
      sigVerify: false,
      commitment: "confirmed",
    });
    if (sim.value.err) {
      const logs = (sim.value.logs ?? []).slice(-3).join(" | ");
      return { ok: false, err: `${JSON.stringify(sim.value.err)} ${logs}`.slice(0, 300) };
    }
    return { ok: true, unitsConsumed: sim.value.unitsConsumed ?? null };
  } catch (e: any) {
    return { ok: false, err: String(e?.message ?? e).slice(0, 300) };
  }
}

/** Re-read the order to confirm it still rests with the expected price and size. */
export async function confirmStillRestingUnchanged(
  chain: Chain, ask: UserAsk, minQuantity: number,
): Promise<boolean> {
  const info = await chain.connection.getAccountInfo(ask.pubkey, "confirmed").catch(() => null);
  if (!info) return false;
  let r: any;
  try {
    r = chain.program.coder.accounts.decode("restingOrder", info.data);
  } catch {
    return false;
  }
  const price = Number(String(r.pricePerContract ?? r.price_per_contract ?? 0)) / 1e6;
  const qty = Number(String(r.quantityRemaining ?? r.quantity_remaining ?? 0));
  // A price that MOVED between evaluation and send re-opens the whole band
  // question, so refuse rather than fill at a number nothing approved. Equality
  // on integers-scaled-to-6dp; the tolerance is a rounding guard, not a slippage
  // allowance.
  if (Math.abs(price - ask.priceUsdc) > 1e-9) return false;
  return qty >= minQuantity;
}
