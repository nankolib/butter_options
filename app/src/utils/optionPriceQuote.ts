// =============================================================================
// optionPriceQuote.ts — client wrapper for the on-chain get_option_price view.
// =============================================================================
//
// Single source of truth for consuming Opta's first typed-return instruction,
// `get_option_price` — an AMERICAN-only BS-2002 pricing view called via
// Anchor `.view()`. Built in Phase 3 (Write LiveQuoteCard AMER preview) and
// reused verbatim by Phase 4 (Trade AMER chain previews + on-chain vol).
//
// IMPLEMENTATION: manual `connection.simulateTransaction` of a v0 tx carrying
// [setComputeUnitLimit(400K), get_option_price] with sigVerify:false, then
// decode the program return data. We do NOT use Anchor's `.methods(...).view()`
// because it simulates at the hard 200K CU default, which CU-exhausts the
// heavier American PUT branch (~278K) — see QUOTE_CU_LIMIT below. This is the
// locked decision-4 ".simulate()+decode" fallback.
//
// PROVIDER NOTE: sigVerify:false + a throwaway fee payer means no signature,
// funds, or connected wallet are required — the quote resolves even from the
// read-only provider. No wallet prompt.
//
// European reverts ViewNotSupportedForEuropean (6051) by design — callers
// must only invoke this for American vaults and use blackScholes.ts for EUR.
// =============================================================================

import type { Program } from "@coral-xyz/anchor";
import {
  PublicKey,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import BN from "bn.js";
import type { Opta } from "../idl/opta";
import { VOL_ORACLE_SEED, SIMULATION_FEE_PAYER } from "./constants";
import { toUsdcBN } from "./format";

/** solmath fixed-point scale (1e12) used by vol_used_scaled / spot_used_scaled. */
const SCALE_1E12 = 1_000_000_000_000;

/** Decoded, human-scaled OptionPriceQuote. */
export type OptionPriceQuote = {
  /** Premium per contract in USDC (human, 6-dec un-scaled). */
  premiumPerContract: number;
  /** Realized vol used, annualized fraction (e.g. 0.65 = 65%). */
  volAnnualized: number;
  /** Spot used in the computation, USD (human). From VolOracle.last_spot_price. */
  spotUsed: number;
  /** On-chain Clock unix seconds at computation time. */
  computedAtTs: number;
};

/** Coarse classification of a get_option_price revert, for UI fallback copy. */
export type OptionPriceQuoteErrorKind =
  | "european-not-supported" // 6051 — caller bug: don't quote EUR on-chain
  | "oracle-warmup" //         6044 — < 168 samples; needs ~7d of pushes
  | "oracle-stale" //          6045 — last sample > 6h old (crank gap)
  | "oracle-not-initialized" // 6043 — no oracle for this feed yet
  | "no-time-value" //         6012 — deep OTM / zero time value; premium rounds to 0
  | "pricing-failed" //        6050/6048 — BS-2002 / invalid-spot
  | "unknown";

/** Thrown by fetchOptionPriceQuote on any revert. Carries the raw code. */
export class OptionPriceQuoteFailure extends Error {
  readonly kind: OptionPriceQuoteErrorKind;
  readonly code: number | null;
  constructor(kind: OptionPriceQuoteErrorKind, code: number | null) {
    super(`get_option_price reverted (kind=${kind}, code=${code ?? "?"})`);
    this.name = "OptionPriceQuoteFailure";
    this.kind = kind;
    this.code = code;
  }
}

/**
 * Extract an Anchor custom-error code from whatever shape a `.view()` revert
 * throws. Anchor 0.32 wraps a simulation revert in SimulateError, whose
 * `.simulationResponse.err.InstructionError[1].Custom` holds the code; older /
 * other shapes expose `.error.errorCode.number` or stringified logs. Mirrors
 * the Gate-B probe's proven extractor.
 */
export function codeFromViewError(err: any): number | null {
  const direct = err?.error?.errorCode?.number;
  if (typeof direct === "number") return direct;
  const ie = err?.simulationResponse?.err?.InstructionError;
  if (Array.isArray(ie) && ie[1] && typeof ie[1].Custom === "number") {
    return ie[1].Custom;
  }
  const blob = `${JSON.stringify(err?.simulationResponse ?? "")} ${JSON.stringify(
    err?.logs ?? [],
  )} ${err?.message ?? ""} ${String(err)}`;
  const hex = blob.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (hex) return parseInt(hex[1], 16);
  const dec = blob.match(/Error Number:\s*(\d+)/);
  if (dec) return parseInt(dec[1], 10);
  return null;
}

/**
 * Shared status-line copy for an on-chain quote's {loading, error, quote}
 * state — used by both the Write LiveQuoteCard and the Trade OfferingsPanel so
 * the warmup/stale/timestamp wording lives in one place. Returns null when
 * there's nothing to say (no quote attempted yet).
 */
export function describeOptionPriceQuoteStatus(
  loading: boolean,
  error: OptionPriceQuoteFailure | null,
  quote: OptionPriceQuote | null,
): string | null {
  if (loading) return "Pricing on-chain…";
  if (error) {
    switch (error.kind) {
      case "oracle-warmup":
        return "Vol oracle warming up — quote unavailable yet";
      case "oracle-stale":
        return "Vol oracle stale — awaiting a fresh price push";
      case "oracle-not-initialized":
        return "Vol oracle not initialized for this asset";
      case "no-time-value":
        return "No time value at this expiry — the option is too far out-of-the-money to carry a premium";
      case "pricing-failed":
        return "On-chain pricing unavailable for these terms";
      default:
        return "On-chain quote unavailable";
    }
  }
  if (quote) {
    const t = new Date(quote.computedAtTs * 1000).toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone: "UTC",
    });
    const s = quote.spotUsed.toLocaleString(undefined, { maximumFractionDigits: 2 });
    return `Protocol quote · priced ${t} UTC · oracle spot $${s}`;
  }
  return null;
}

/** Freshness verdict for an American on-chain quote — the H-05 trade gate. */
export type QuoteFreshness = { isFresh: boolean; statusReason: string | null };

/**
 * Single authority for "is this American on-chain quote fresh enough to TRADE
 * on?" (H-05). fresh = a resolved quote, not loading, with NO error — any
 * oracle-warmup / oracle-stale / oracle-not-initialized / pricing-failed (or
 * any other) revert makes it not fresh. `statusReason` is the human copy for a
 * disabled control: the shared describeOptionPriceQuoteStatus wording, or a
 * "request a quote" prompt when none has been attempted yet.
 *
 * This is the ONE definition of "fresh" reused by the Write (WriterForm) and
 * Trade (OrderTicket / BuyModal) gates so they never diverge.
 *
 * EXTENSION POINT (warming badge, M1): when the FE later decodes VolOracle
 * sample_count / last_sample_ts, thread that progress in here so call sites
 * don't change — this stays the single source of the freshness verdict.
 */
export function quoteFreshness(
  loading: boolean,
  error: OptionPriceQuoteFailure | null,
  quote: OptionPriceQuote | null,
): QuoteFreshness {
  const isFresh = !loading && !error && quote != null;
  const statusReason =
    describeOptionPriceQuoteStatus(loading, error, quote) ??
    (isFresh ? null : "Request an on-chain quote to continue");
  return { isFresh, statusReason };
}

function kindForCode(code: number | null): OptionPriceQuoteErrorKind {
  switch (code) {
    case 6051:
      return "european-not-supported";
    case 6044:
      return "oracle-warmup";
    case 6045:
      return "oracle-stale";
    case 6043:
      return "oracle-not-initialized";
    // Anchor account-constraint failures raised BEFORE the handler runs when
    // the derived vol_oracle PDA isn't a seeded VolOracle account (3012
    // AccountNotInitialized / 3007 AccountOwnedByWrongProgram). Surface as
    // "not initialized" — same user-facing meaning as the program's 6043.
    case 3007:
    case 3012:
      return "oracle-not-initialized";
    // 6012 InvalidPremium — the American pricer computed a premium that rounds
    // to 0 USDC (deep OTM / no time value at this expiry); quote.rs reverts
    // `require!(premium_usdc > 0, InvalidPremium)`. Distinct copy so the user
    // sees WHY, not a generic "unavailable".
    case 6012:
      return "no-time-value";
    case 6050:
    case 6048:
      return "pricing-failed";
    default:
      return "unknown";
  }
}

export type OptionPriceQuoteParams = {
  /** Strike in USDC (human, e.g. 1.15). */
  strike: number;
  /** Expiry as Unix seconds. */
  expiryTs: number;
  side: "call" | "put";
  exerciseStyle: "european" | "american";
  /** Signed bps. 0 for the current no-dividend crypto assets. */
  carryRateBps: number;
};

type MarketLike = {
  publicKey: PublicKey;
  account: { pythFeedId: number[] | Uint8Array };
};

/**
 * CU ceiling for the get_option_price simulation. Anchor's `.methods(...).view()`
 * simulates at the hard 200K default, which CU-EXHAUSTS the heavier American
 * branches (PUT BS-2002 ≈ 278K measured; future carry≠0 CALLs trend higher) —
 * the program aborts with ProgramFailedToComplete (no Custom code). We instead
 * build the instruction, prepend an explicit 400K limit, simulate manually, and
 * decode the program return data. This is the locked decision-4
 * ".simulate()+decode" fallback. 400K covers the ~278K worst case with headroom
 * and stays well under the 1.4M the on-chain mint/exercise paths use.
 */
const QUOTE_CU_LIMIT = 400_000;

/**
 * Call get_option_price for a hypothetical option against a live VolOracle and
 * return the decoded, human-scaled quote. Derives the vol_oracle PDA from the
 * market's pyth_feed_id. Throws OptionPriceQuoteFailure on any program revert
 * (warmup / stale / European / pricing) — callers branch on `.kind`.
 *
 * Manual simulate (NOT `.view()`) for the CU headroom above. sigVerify:false +
 * a throwaway fee payer means no signature, funds, OR connected wallet are
 * required — the quote resolves even from the read-only provider. AMER-only:
 * passing exerciseStyle "european" reverts 6051 by design.
 */
export async function fetchOptionPriceQuote(
  program: Program<Opta>,
  market: MarketLike,
  params: OptionPriceQuoteParams,
): Promise<OptionPriceQuote> {
  const feedId = Buffer.from(market.account.pythFeedId as Uint8Array);
  const [volOracle] = PublicKey.findProgramAddressSync(
    [Buffer.from(VOL_ORACLE_SEED), feedId],
    program.programId,
  );
  const optionType = params.side === "call" ? { call: {} } : { put: {} };
  const exerciseStyle =
    params.exerciseStyle === "american" ? { american: {} } : { european: {} };

  const ix = await program.methods
    .getOptionPrice(
      toUsdcBN(params.strike),
      new BN(params.expiryTs),
      optionType as any,
      exerciseStyle as any,
      params.carryRateBps,
    )
    .accountsStrict({ market: market.publicKey, volOracle })
    .instruction();

  const connection = program.provider.connection;
  // Simulation-only fee payer. sigVerify:false skips signature + balance checks,
  // but the RPC still LOADS this account: PublicKey.default (System Program) →
  // InvalidAccountForFee, and a non-existent pubkey → AccountNotFound — either
  // makes a DISCONNECTED viewer see "No live quote" even with a fresh oracle. So
  // when no wallet is connected, fall back to a real funded account, NOT
  // PublicKey.default. (Verified against devnet: default/System/PDA →
  // InvalidAccountForFee, random → AccountNotFound, funded acct → decodes.)
  const payer: PublicKey =
    (program.provider as any).wallet?.publicKey ??
    (program.provider as any).publicKey ??
    SIMULATION_FEE_PAYER;
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: QUOTE_CU_LIMIT }),
      ix,
    ],
  }).compileToV0Message();
  const vtx = new VersionedTransaction(message);

  const sim = await connection.simulateTransaction(vtx, {
    sigVerify: false,
    commitment: "confirmed",
  });

  if (sim.value.err) {
    // Shape the sim result like a `.view()` throw so the proven extractor
    // pulls the Custom code (InstructionError[1].Custom) regardless of the IX
    // index (now 1 — the CU-limit IX sits at 0).
    const code = codeFromViewError({
      simulationResponse: { err: sim.value.err, logs: sim.value.logs ?? [] },
    });
    throw new OptionPriceQuoteFailure(kindForCode(code), code);
  }

  const retB64 = sim.value.returnData?.data?.[0];
  if (!retB64) throw new OptionPriceQuoteFailure("unknown", null);

  // OptionPriceQuote return data (Borsh, no discriminator), 32 bytes:
  //   premium_per_contract u64 | vol_used_scaled i64 | spot_used_scaled i64 |
  //   computed_at_ts i64 — all non-negative on the success path, so little-
  //   endian unsigned reads are exact. Manual decode avoids coder type-name /
  //   field-case ambiguity for the program return value.
  const buf = Buffer.from(retB64, "base64");
  if (buf.length < 32) throw new OptionPriceQuoteFailure("unknown", null);
  const u64le = (off: number) =>
    Number(new BN(buf.subarray(off, off + 8), "le").toString());

  return {
    premiumPerContract: u64le(0) / 1_000_000,
    volAnnualized: u64le(8) / SCALE_1E12,
    spotUsed: u64le(16) / SCALE_1E12,
    computedAtTs: u64le(24),
  };
}
