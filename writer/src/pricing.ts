// =============================================================================
// pricing.ts — on-chain get_option_price quote + spread policy.
// =============================================================================
// The quote path is vendored from app/src/utils/optionPriceQuote.ts: build the
// get_option_price ix, prepend a 400K CU limit (the ~278K American PUT branch
// exhausts the 200K .view() default), simulateTransaction(sigVerify:false), and
// decode the 32-byte Borsh return. AMERICAN-ONLY — European reverts 6051.
//
// The ask price is the model quote marked up by a tier spread (spec §d). Because
// the bot is the sole writer with no competition, spreads are intentionally wide
// display markups, not a competitive book.
// =============================================================================

import type { Program } from "@coral-xyz/anchor";
import BN from "bn.js";
import {
  PublicKey, ComputeBudgetProgram, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import { volOraclePda } from "./ids";

const SCALE_1E12 = 1_000_000_000_000;
const QUOTE_CU_LIMIT = 400_000;

/** Human USDC -> micro (6dp) BN. Round to avoid float dust. */
export const toUsdcBN = (dollars: number): BN => new BN(Math.round(dollars * 1_000_000));

export interface QuoteResult {
  premiumPerContract: number; // human USDC
  volAnnualized: number;
  spotUsed: number;           // human USD
  computedAtTs: number;
}

export type QuoteErrorKind =
  | "european-not-supported" | "oracle-warmup" | "oracle-stale"
  | "oracle-not-initialized" | "no-time-value" | "pricing-failed" | "unknown";

export class QuoteFailure extends Error {
  readonly kind: QuoteErrorKind;
  readonly code: number | null;
  constructor(kind: QuoteErrorKind, code: number | null) {
    super(`get_option_price reverted (kind=${kind}, code=${code ?? "?"})`);
    this.name = "QuoteFailure";
    this.kind = kind;
    this.code = code;
  }
}

function codeFromSim(err: any): number | null {
  const ie = err?.simulationResponse?.err?.InstructionError;
  if (Array.isArray(ie) && ie[1] && typeof ie[1].Custom === "number") return ie[1].Custom;
  const blob = `${JSON.stringify(err?.simulationResponse ?? "")} ${JSON.stringify(err?.logs ?? [])} ${String(err)}`;
  const hex = blob.match(/custom program error: 0x([0-9a-fA-F]+)/);
  if (hex) return parseInt(hex[1], 16);
  const dec = blob.match(/Error Number:\s*(\d+)/);
  if (dec) return parseInt(dec[1], 10);
  return null;
}

function kindForCode(code: number | null): QuoteErrorKind {
  switch (code) {
    case 6051: return "european-not-supported";
    case 6044: return "oracle-warmup";
    case 6045: return "oracle-stale";
    case 6043: case 3007: case 3012: return "oracle-not-initialized";
    case 6012: return "no-time-value";
    case 6050: case 6048: return "pricing-failed";
    default: return "unknown";
  }
}

export interface MarketLike {
  publicKey: PublicKey;
  pythFeedId: Uint8Array;
}

/**
 * Quote a hypothetical American option against the live VolOracle. Throws
 * QuoteFailure on any revert (warmup / stale / European / no-time-value /
 * pricing) — the engine branches on `.kind` (skip the cell, pull a stale ask).
 */
export async function fetchQuote(
  program: Program<any>,
  market: MarketLike,
  params: { strike: number; expiryTs: number; side: "call" | "put"; carryRateBps: number },
  simPayer?: PublicKey | null,
): Promise<QuoteResult> {
  const volOracle = volOraclePda(market.pythFeedId);
  const optionType = params.side === "call" ? { call: {} } : { put: {} };

  const ix = await program.methods
    .getOptionPrice(
      toUsdcBN(params.strike),
      new BN(params.expiryTs),
      optionType as any,
      { american: {} } as any,
      params.carryRateBps,
    )
    .accountsStrict({ market: market.publicKey, volOracle })
    .instruction();

  const connection = program.provider.connection;
  const payer: PublicKey =
    simPayer ?? (program.provider as any).wallet?.publicKey ?? (program.provider as any).publicKey ?? PublicKey.default;
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: QUOTE_CU_LIMIT }), ix],
  }).compileToV0Message();

  const sim = await connection.simulateTransaction(new VersionedTransaction(message), {
    sigVerify: false,
    commitment: "confirmed",
  });

  if (sim.value.err) {
    const code = codeFromSim({ simulationResponse: { err: sim.value.err, logs: sim.value.logs ?? [] } });
    throw new QuoteFailure(kindForCode(code), code);
  }
  const retB64 = sim.value.returnData?.data?.[0];
  if (!retB64) throw new QuoteFailure("unknown", null);
  const buf = Buffer.from(retB64, "base64");
  if (buf.length < 32) throw new QuoteFailure("unknown", null);
  const u64le = (off: number) => Number(new BN(buf.subarray(off, off + 8), "le").toString());
  return {
    premiumPerContract: u64le(0) / 1_000_000,
    volAnnualized: u64le(8) / SCALE_1E12,
    spotUsed: u64le(16) / SCALE_1E12,
    computedAtTs: u64le(24),
  };
}

/** Ask premium = model quote marked up by the tier spread (bps). */
export function applySpread(quotePremium: number, spreadBps: number): number {
  return quotePremium * (1 + spreadBps / 10_000);
}
