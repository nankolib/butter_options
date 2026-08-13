// ============================================================================
// crank/switchboardExerciseAmerican.ts — SB early-exercise off-chain builder
// ============================================================================
//
// The Switchboard analog of app/src/utils/pythPullPost.ts's
// buildPostUpdateAndExerciseAmericanTx: instead of posting a Hermes VAA it
// fetches a fresh signed Switchboard quote (the same buildManagedQuoteUpdateIxs
// + self-pack the settle crank and the SB create-market builder use) and
// assembles:
//   [ ComputeBudget, correctedEd25519Ix(idx 1),
//     exercise_american(quantity, price_update:null,
//                       +sb_queue/sb_slothashes/sb_instructions) ]
// pointed at exercise_american.rs:118-175's ORACLE_SOURCE_SWITCHBOARD arm.
//
// WHY THIS EXISTS (P1, 2026-08-12). Early exercise was broken on every
// SB-sourced market — the whole traded board — because the FE had no
// oracle_source branch and sent the SB feedHash to Hermes, which 404s. The
// program has had both arms since it shipped; only a client-side builder for the
// SB arm was missing, and it could not live in app/ because the FE deliberately
// carries ZERO @switchboard-xyz dependencies (see the module header in
// app/src/utils/exerciseArm.ts).
//
// LOCATION — crank/, for exactly the reason switchboardCreateMarket.ts is here:
// buildManagedQuoteUpdateIxs needs @switchboard-xyz/on-demand, a CRANK dep.
//
// SIGNER SPLIT (the property that makes a server-built tx acceptable): the only
// required signature is the HOLDER's. The ed25519 quote ix is oracle-signed and
// independent of the fee payer, and exercise_american's sole signer is `holder`.
// So this builder produces a tx the crank CANNOT sign and has no reason to —
// the user pays their own ~6.6¢ quote cost. The FE re-derives every account and
// refuses to sign anything that does not match (assertExerciseTxShape).
// ============================================================================

import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey, ComputeBudgetProgram, Ed25519Program, TransactionInstruction,
} from "@solana/web3.js";
import {
  Queue, SPL_SYSVAR_SLOT_HASHES_ID, SPL_SYSVAR_INSTRUCTIONS_ID,
} from "@switchboard-xyz/on-demand";
import { CrossbarClient } from "@switchboard-xyz/common";
import {
  TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";

import { buildManagedQuoteUpdateIxs } from "./switchboardQuotePost";
import { lookupSbFeed, buildOracleFeed, normFeedHash } from "./sbFeedRegistry";

/** Token-2022 burn + SB verify + USDC payout. Same bump as the Pyth arm's
 *  atomic post+exercise tx, which is the closest measured comparable. */
const EXERCISE_CU_LIMIT = 1_400_000;

/**
 * The on-chain freshness budget for an early-exercise quote, in SLOTS.
 *
 * Mirrors `secs_to_slots(PRICE_MAX_AGE_SECS)` in
 * programs/opta/src/utils/price_oracle.rs — PRICE_MAX_AGE_SECS is 60 and
 * SLOTS_PER_SEC is a hardcoded 5/2, so the chain accepts 150 slots and no more.
 *
 * ⚠️ 150 SLOTS IS NOT 60 SECONDS. That conversion assumes 2.5 slots/sec.
 * Measured on devnet 2026-08-13 over a 90-second window: 380 slots elapsed, a
 * rate of 4.22 slots/sec. At that rate the budget is worth ~35 SECONDS of
 * wall-clock, not 60 — and a wallet approval takes 15-60s. The window is
 * therefore genuinely marginal, and the shortfall is invisible from the
 * constant's name.
 *
 * Only a program upgrade can widen the budget. What this endpoint CAN do is
 * stop pretending the deadline is unknowable: it publishes the slot at which
 * the quote dies, so the client can act before wasting a signature. Duplicated
 * here rather than imported because the Rust constant cannot be read from TS;
 * if PRICE_MAX_AGE_SECS changes, this must change with it.
 */
export const QUOTE_MAX_AGE_SLOTS = 150;

export interface SbExerciseAmericanParams {
  /** 32-byte SB feedHash, read from the MARKET account by the caller — never
   *  taken from the request body. */
  feedHashHex: string;
  quantity: number;
  sharedVault: PublicKey;
  market: PublicKey;
  vaultMintRecord: PublicKey;
  optionMint: PublicKey;
  holderOptionAccount: PublicKey;
  vaultUsdcAccount: PublicKey;
  holderUsdcAccount: PublicKey;
}

export interface SbExerciseAmericanBuild {
  /** [ComputeBudget, correctedEd25519Ix(idx 1), exercise_american]. */
  instructions: TransactionInstruction[];
  ed25519Bytes: number;
  /** Slot observed immediately BEFORE the quote was fetched. The quote's own
   *  recent_slot is at or before this, so deadlines derived from it are an
   *  upper bound — deliberately, so the client errs toward rebuilding early. */
  quoteBuiltAtSlot: number;
}

/**
 * Build the SB early-exercise instruction set. Throws if the feedHash isn't in
 * the SB registry or the gateway fetch fails; the caller retries with a fresh
 * quote, same as the create endpoint and the posting/settle crank.
 */
export async function buildSwitchboardExerciseAmericanTx(
  program: anchor.Program<any>,
  holder: PublicKey,
  qObj: Queue,
  crossbar: CrossbarClient,
  params: SbExerciseAmericanParams,
): Promise<SbExerciseAmericanBuild> {
  const feedHashHex = normFeedHash(params.feedHashHex);
  const entry = lookupSbFeed(feedHashHex);
  if (!entry) throw new Error(`feedHash ${feedHashHex.slice(0, 10)} not in SB registry`);

  // Fresh signed quote → corrected (self-packed) ed25519 ix. instructionIdx: 1
  // pins the ix to slot 1 of the tx below; the on-chain find_ed25519_ix_index
  // walks the instructions sysvar, but the self-pack's internal offsets are
  // written for that position, so the assembled order is NOT free to change.
  const feed = buildOracleFeed(entry);
  // Sampled BEFORE the gateway round-trip so the deadline we publish can never
  // be later than the truth.
  const quoteBuiltAtSlot = await program.provider.connection.getSlot("confirmed");
  const { ixs } = await buildManagedQuoteUpdateIxs(
    qObj, crossbar, feed, holder, { numSignatures: 2, instructionIdx: 1 });
  const edPid = Ed25519Program.programId.toBase58();
  const edIx = ixs.find((ix) => ix.programId.toBase58() === edPid);
  if (!edIx) throw new Error("no ed25519 ix in managed-update output");

  const exerciseIx = await (program.methods as any)
    .exerciseAmerican(new anchor.BN(params.quantity))
    .accountsPartial({
      holder,
      sharedVault: params.sharedVault,
      market: params.market,
      // SB arm: no Pyth account. anchor 0.32.1 does NOT auto-null unprovided
      // optional accounts at .instruction() — it throws "Account `priceUpdate`
      // not provided" — so the null is explicit, mirroring how the Pyth arm
      // explicitly nulls the three SB accounts.
      priceUpdate: null,
      vaultMintRecord: params.vaultMintRecord,
      optionMint: params.optionMint,
      holderOptionAccount: params.holderOptionAccount,
      vaultUsdcAccount: params.vaultUsdcAccount,
      holderUsdcAccount: params.holderUsdcAccount,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
      sbQueue: entry.queue,
      sbSlothashes: SPL_SYSVAR_SLOT_HASHES_ID,
      sbInstructions: SPL_SYSVAR_INSTRUCTIONS_ID,
    })
    .instruction();

  return {
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: EXERCISE_CU_LIMIT }),
      edIx,
      exerciseIx,
    ],
    ed25519Bytes: edIx.data.length,
    quoteBuiltAtSlot,
  };
}
