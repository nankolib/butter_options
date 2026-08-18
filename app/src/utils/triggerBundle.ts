// =============================================================================
// utils/triggerBundle.ts — TP/SL placement + cancel instruction assembly
// =============================================================================
//
// Phase 4 / 2C. Pure assembly: builds instructions, never sends. Sending is the
// caller's job and goes through sendWithFreshBlockhash — no bare .rpc() is added
// by this module (86eymw9m1 is about the existing ones; this does not add to the
// pile).
//
// ── WHY A PAIR IS ONE TRANSACTION ──────────────────────────────────────────
// An OCO couple is two TriggerOrders plus a link. Placed as separate
// transactions, an interruption between them leaves the user believing they hold
// OCO when they hold two independent triggers — a double exit wearing user
// clothing, since both legs can then fire.
//
// Measured 2026-08-18 by serialising the real bundle: place x2 + link_oco is
// 888 bytes across 20 unique accounts, against the 1232-byte limit — 344 bytes
// spare, no address-lookup table required. The two legs share 14 of their 16
// accounts (same owner, series, vault, mints, programs); only triggerOrder and
// triggerEscrow differ, and link_oco introduces no new keys at all.
//
// So the pair is atomic by construction and a half-pair cannot exist. There is no
// recovery path here because there is no interruptible gap to recover from.
//
// ── SINGLE LEG IS FIRST-CLASS ──────────────────────────────────────────────
// A protective stop on its own is the oldest order there is. Either leg may be
// omitted; the bundle then contains one placement and NO link. Nothing forces a
// user to take a take-profit in order to get a stop.
// =============================================================================

import { BN, type Program } from "@coral-xyz/anchor";
import {
  PublicKey, SystemProgram, SYSVAR_RENT_PUBKEY, type TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";

import { PROTOCOL_SEED } from "./constants";

export const TRIGGER_ORDER_SEED = "trigger_order";
export const TRIGGER_ESCROW_SEED = "trigger_escrow";
export const VAULT_MINT_RECORD_SEED = "vault_mint_record";

/** Which way the comparator points. Stored explicitly on chain — never inferred. */
export type TriggerComparator = "le" | "ge";

/** v1 exposes the two SELL legs. StopEntryBuy exists on chain but is not in the
 *  TP/SL ticket, which is about exiting a position you already hold. */
export type TriggerLegKind = "takeProfitSell" | "stopLossSell";

export interface TriggerLeg {
  kind: TriggerLegKind;
  comparator: TriggerComparator;
  /** Condition price on the UNDERLYING, USDC 6-dec. v1 is underlying tape only. */
  thresholdUsdc: BN;
  quantity: BN;
  /** SELL: the per-contract MINIMUM-PROCEEDS floor. 0 is legal on chain and means
   *  BOOK INELIGIBLE (6082), so the caller must decide deliberately. */
  minProceedsUsdc: BN;
  nonce: BN;
}

export interface TriggerSeriesCtx {
  program: Program<any>;
  owner: PublicKey;
  market: PublicKey;
  sharedVault: PublicKey;
  optionMint: PublicKey;
  usdcMint: PublicKey;
}

export interface BuiltTriggerBundle {
  instructions: TransactionInstruction[];
  /** PDAs in the same order as the legs that were supplied. */
  orders: PublicKey[];
  /** True when both legs were supplied and link_oco is in the bundle. */
  linked: boolean;
}

const pda = (seeds: (Buffer | Uint8Array)[], programId: PublicKey) =>
  PublicKey.findProgramAddressSync(seeds, programId)[0];

export function deriveTriggerOrder(
  programId: PublicKey, owner: PublicKey, optionMint: PublicKey, nonce: BN,
): PublicKey {
  return pda(
    [Buffer.from(TRIGGER_ORDER_SEED), owner.toBuffer(), optionMint.toBuffer(),
     nonce.toArrayLike(Buffer, "le", 8)],
    programId,
  );
}

export function deriveTriggerEscrow(programId: PublicKey, order: PublicKey): PublicKey {
  return pda([Buffer.from(TRIGGER_ESCROW_SEED), order.toBuffer()], programId);
}

/** Anchor arg enums are camelCase; ACCOUNT DECODES come back PascalCase. Feeding a
 *  decoded enum straight back in as an arg throws "unable to infer src variant",
 *  measured 2026-08-18 — so args are constructed here, never echoed. */
const kindArg = (k: TriggerLegKind) =>
  k === "takeProfitSell" ? { takeProfitSell: {} } : { stopLossSell: {} };
const cmpArg = (c: TriggerComparator) =>
  c === "le" ? { lessOrEqual: {} } : { greaterOrEqual: {} };

/** v1 is UNDERLYING tape only. Contract tape exists on chain (TapeSource::Contract)
 *  but stays unset here until one live contract-tape canary fire is verified. */
const TAPE_UNDERLYING = { underlying: {} };

async function placeLegIx(
  ctx: TriggerSeriesCtx, leg: TriggerLeg,
): Promise<{ ix: TransactionInstruction; order: PublicKey }> {
  const pid = ctx.program.programId;
  const order = deriveTriggerOrder(pid, ctx.owner, ctx.optionMint, leg.nonce);
  const escrow = deriveTriggerEscrow(pid, order);

  const ix = await ctx.program.methods
    .placeTrigger(
      kindArg(leg.kind), cmpArg(leg.comparator),
      leg.thresholdUsdc, leg.quantity, leg.minProceedsUsdc, leg.nonce,
      TAPE_UNDERLYING,
    )
    .accountsStrict({
      owner: ctx.owner,
      market: ctx.market,
      sharedVault: ctx.sharedVault,
      vaultMintRecord: pda([Buffer.from(VAULT_MINT_RECORD_SEED), ctx.optionMint.toBuffer()], pid),
      optionMint: ctx.optionMint,
      triggerOrder: order,
      triggerEscrow: escrow,
      protocolState: pda([Buffer.from(PROTOCOL_SEED)], pid),
      usdcMint: ctx.usdcMint,
      ownerUsdcAccount: getAssociatedTokenAddressSync(ctx.usdcMint, ctx.owner, false, TOKEN_PROGRAM_ID),
      ownerOptionAta: getAssociatedTokenAddressSync(ctx.optionMint, ctx.owner, false, TOKEN_2022_PROGRAM_ID),
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();

  return { ix, order };
}

/**
 * Build the placement bundle.
 *
 * Both legs → two placements + link_oco, atomic.
 * One leg   → one placement, no link.
 * Neither   → throws; an empty ticket is a caller bug, not an empty transaction.
 */
export async function buildTriggerPlacement(
  ctx: TriggerSeriesCtx,
  legs: { takeProfit?: TriggerLeg | null; stopLoss?: TriggerLeg | null },
): Promise<BuiltTriggerBundle> {
  const tp = legs.takeProfit ?? null;
  const sl = legs.stopLoss ?? null;
  if (!tp && !sl) throw new Error("buildTriggerPlacement: at least one leg is required");

  if (tp && sl && tp.nonce.eq(sl.nonce)) {
    // Same nonce on one series = the same PDA for both legs: the second init
    // fails, and a "pair" that is really one order would be the worst outcome
    // here. Caught at build time rather than by the runtime.
    throw new Error("buildTriggerPlacement: TP and SL must use distinct nonces");
  }

  const instructions: TransactionInstruction[] = [];
  const orders: PublicKey[] = [];

  if (tp) { const r = await placeLegIx(ctx, tp); instructions.push(r.ix); orders.push(r.order); }
  if (sl) { const r = await placeLegIx(ctx, sl); instructions.push(r.ix); orders.push(r.order); }

  const linked = Boolean(tp && sl);
  if (linked) {
    instructions.push(
      await ctx.program.methods.linkOco().accountsStrict({
        owner: ctx.owner, triggerA: orders[0], triggerB: orders[1],
      }).instruction(),
    );
  }

  return { instructions, orders, linked };
}

/**
 * Build a cancel.
 *
 * `ocoPeer` MUST be the real paired PDA whenever the order carries an oco_link.
 * Passing null builds fine and is then rejected on chain (6087 OcoPeerRequired) —
 * for exactly the orders OCO exists to protect. The keeper hit this same bug from
 * the other side when assembleExecuteAccounts omitted the account; a blanket null
 * is that bug in client clothing.
 *
 * Cancel is also how a survivor gets unlinked: the program clears the peer's
 * oco_link here, so the remaining leg stays cancellable and fireable on its own.
 */
export async function buildTriggerCancel(
  ctx: Pick<TriggerSeriesCtx, "program" | "owner" | "usdcMint">,
  order: PublicKey,
  ocoPeer: PublicKey | null,
): Promise<TransactionInstruction> {
  const pid = ctx.program.programId;
  return ctx.program.methods.cancelTrigger().accountsStrict({
    owner: ctx.owner,
    triggerOrder: order,
    triggerEscrow: deriveTriggerEscrow(pid, order),
    protocolState: pda([Buffer.from(PROTOCOL_SEED)], pid),
    ownerUsdcAccount: getAssociatedTokenAddressSync(ctx.usdcMint, ctx.owner, false, TOKEN_PROGRAM_ID),
    tokenProgram: TOKEN_PROGRAM_ID,
    ocoPeer,
  }).instruction();
}

/**
 * Resolve the peer for a cancel from the fetched account, so callers cannot forget.
 * Anchor decodes Option<Pubkey> to the value or null.
 */
export function peerOf(fetchedTriggerOrder: any): PublicKey | null {
  const link = fetchedTriggerOrder?.ocoLink ?? fetchedTriggerOrder?.oco_link ?? null;
  return link ? new PublicKey(link) : null;
}

/**
 * The cancel callers should use.
 *
 * Takes the FETCHED TriggerOrder and derives the peer from it, so the null-peer
 * mistake is not available: if the order is linked, the peer is supplied; if it is
 * not, null is correct. The low-level builder above stays exported for tests that
 * need to construct the wrong shape deliberately.
 *
 * Throws when an order is linked but the fetched account was not provided —
 * guessing "probably unlinked" is exactly how the 6087 revert gets shipped.
 */
export async function buildTriggerCancelFor(
  ctx: Pick<TriggerSeriesCtx, "program" | "owner" | "usdcMint">,
  order: PublicKey,
  fetchedTriggerOrder: unknown,
): Promise<TransactionInstruction> {
  if (fetchedTriggerOrder == null) {
    throw new Error(
      "buildTriggerCancelFor: the fetched TriggerOrder is required — a linked order " +
      "cancelled without its peer is rejected on chain (6087 OcoPeerRequired)",
    );
  }
  return buildTriggerCancel(ctx, order, peerOf(fetchedTriggerOrder));
}
