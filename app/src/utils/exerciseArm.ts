// =============================================================================
// exerciseArm.ts — route an early exercise to the oracle arm its market uses
// =============================================================================
//
// THE BUG THIS CLOSES (P1, reproduced 2026-08-12). exerciseAmericanV2 read
// `market.pyth_feed_id` and handed it to the Hermes poster unconditionally, with
// no oracle_source branch. For a Switchboard market that field holds the SB
// FEEDHASH (the two sources share the field by design), and Hermes has never
// heard of it:
//
//   GET hermes/v2/updates/price/latest?ids[]=0xe01fe3bb…b463  -> 404
//        "Price ids not found: 0xe01fe3bb…"                     (SOL, SB feedHash)
//   GET hermes/v2/updates/price/latest?ids[]=0xef0d8b6f…b56d  -> 200
//                                                               (SOL, Pyth id)
//
// Same endpoint, same encoding; the only variable is which id we send. Early
// exercise was therefore broken on EVERY Switchboard market — which is the whole
// traded board (BTC, SOL, ETH, XRP, the memes) — and worked only on the seven
// Pyth-sourced assets nobody trades. That inversion is why it survived so long.
//
// The PROGRAM was never the problem: exercise_american.rs:118-175 has dispatched
// on `market.oracle_source` since it shipped, and its account struct already
// carries the trailing sb_queue / sb_slothashes / sb_instructions optionals. Only
// the client never learned to pick an arm.
//
// ── WHY THE SB ARM IS NOT BUILT IN THE BROWSER ─────────────────────────────
// Building an SB quote needs @switchboard-xyz/on-demand. app/ has ZERO
// @switchboard-xyz dependencies and that is deliberate and load-bearing — three
// modules document it (newMarketCreate.ts, NewMarketModal.tsx, liveness.ts): the
// SB SDK never enters the FE bundle. So the SB arm mirrors sb-create-market: the
// crank builds an UNSIGNED tx, the FE signs it with the holder's wallet and
// submits. The user pays; the crank key never signs a user's exercise.
//
// ── THE GUARD (assertExerciseTxShape) ───────────────────────────────────────
// We operate that endpoint, which is exactly why the FE must not trust it. A
// wallet that signs whatever bytes a server returns IS a blind-signing oracle,
// and the fact that we run the server today is a fact about today. So before the
// wallet ever sees it, the returned tx is checked against values the FE derived
// LOCALLY: our program, our discriminator, our vault, our quantity, our accounts,
// one signer (the holder), no lookup tables. A compromised or swapped endpoint
// can return a tx — it cannot return one that signs anything else.
//
// This module is dependency-injected (endpoint + fetch) and imports no `./env`,
// so it compiles to CommonJS and is tested against real VersionedTransactions.
// =============================================================================

import { PublicKey, VersionedTransaction } from "@solana/web3.js";

// ---- oracle sources ---------------------------------------------------------

export const ORACLE_SOURCE_PYTH = 0;
export const ORACLE_SOURCE_SWITCHBOARD = 1;

export type ExerciseArm = "pyth" | "switchboard";

/** Raised when a market's oracle_source is absent or not one of {0,1}. */
export class UnknownOracleSourceError extends Error {
  readonly received: unknown;
  constructor(received: unknown) {
    super("This market's price source could not be determined.");
    this.name = "UnknownOracleSourceError";
    this.received = received;
  }
}

/**
 * Pick the arm from a market's `oracle_source`.
 *
 * THROWS rather than defaulting, on purpose. Defaulting to Pyth is precisely the
 * bug above; defaulting to Switchboard would break the seven markets that work.
 * There is no safe guess, so an unreadable source is surfaced as an error and
 * the caller re-fetches the market account before giving up (accounts predating
 * a size bump can be short — see the account size-drift note).
 */
export function chooseExerciseArm(oracleSource: unknown): ExerciseArm {
  if (oracleSource === ORACLE_SOURCE_PYTH) return "pyth";
  if (oracleSource === ORACLE_SOURCE_SWITCHBOARD) return "switchboard";
  throw new UnknownOracleSourceError(oracleSource);
}

// ---- endpoint client --------------------------------------------------------

export class SbExerciseNetworkError extends Error {
  constructor() {
    super("Could not reach the pricing service. Check your connection and try again.");
    this.name = "SbExerciseNetworkError";
  }
}

/** Names that must never reach a user-facing string. The endpoint is ours and
 *  already writes neutral copy, but "the server promised to be careful" is not
 *  a mechanism — this is the mechanism. */
const VENDOR_RE = /pyth|switchboard|hermes|crossbar|ed25519/i;

export class SbExerciseEndpointError extends Error {
  readonly status: number;
  /** The endpoint's raw detail, kept for logs. NEVER rendered. */
  readonly detail: string;
  constructor(status: number, detail?: string) {
    const raw = detail ?? "";
    // Echo the endpoint's wording only when it is already neutral; otherwise
    // fall back. A pass-through would have shipped "Switchboard" into a toast,
    // which is the same class of bug as the "Hermes" one this session removes.
    const safe = raw.length > 0 && !VENDOR_RE.test(raw) ? raw : "Price unavailable — try again.";
    super(safe);
    this.name = "SbExerciseEndpointError";
    this.status = status;
    this.detail = raw;
  }
}

export interface SbExerciseResponse {
  transactionBase64: string;
  lastValidBlockHeight: number;
  /**
   * Slot after which the embedded price quote is too old for the chain to
   * accept. Absent on older endpoint builds, in which case the caller falls
   * back to blockhash validity alone (the pre-2026-08-13 behaviour).
   *
   * This exists because the two deadlines INVERTED: the quote budget is 150
   * slots, worth ~35 s at the measured devnet rate of 4.22 slots/s, while a
   * blockhash survives 60-90 s. The quote now dies first, so blockhash validity
   * no longer implies quote validity and the tighter bound must be checked.
   */
  quoteExpiresAtSlot?: number;
}

export interface SbExerciseRequest {
  holder: string;
  sharedVault: string;
  market: string;
  vaultMintRecord: string;
  optionMint: string;
  holderOptionAccount: string;
  vaultUsdcAccount: string;
  holderUsdcAccount: string;
  quantity: number;
}

type FetchLike = (input: string, init?: any) => Promise<any>;

/** POST for a fresh unsigned exercise tx. Stateless: every call builds anew. */
export async function postSbExercise(
  endpoint: string,
  body: SbExerciseRequest,
  fetchImpl?: FetchLike,
): Promise<SbExerciseResponse> {
  const f: FetchLike = fetchImpl ?? ((globalThis as any).fetch as FetchLike);
  let resp: any;
  try {
    resp = await f(`${endpoint}/sb-exercise-american`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new SbExerciseNetworkError();
  }
  if (!resp.ok) {
    let msg = "";
    try {
      const j = await resp.json();
      if (j && typeof j.error === "string") msg = j.error;
    } catch {
      /* non-JSON body — fall back to the neutral default */
    }
    throw new SbExerciseEndpointError(resp.status, msg);
  }
  let json: any;
  try {
    json = await resp.json();
  } catch {
    throw new SbExerciseEndpointError(resp.status, "Price unavailable — try again.");
  }
  if (
    typeof json?.transactionBase64 !== "string" ||
    typeof json?.lastValidBlockHeight !== "number"
  ) {
    throw new SbExerciseEndpointError(resp.status, "Price unavailable — try again.");
  }
  return {
    transactionBase64: json.transactionBase64,
    lastValidBlockHeight: json.lastValidBlockHeight,
    quoteExpiresAtSlot:
      typeof json.quoteExpiresAtSlot === "number" ? json.quoteExpiresAtSlot : undefined,
  };
}

// ---- the pre-signature guard ------------------------------------------------

/** exercise_american, from app/src/idl/opta.json. */
export const EXERCISE_AMERICAN_DISCRIMINATOR = Object.freeze([
  241, 75, 206, 124, 107, 254, 131, 81,
]);

/** The only non-Opta programs an SB exercise tx may invoke: the CU bump and the
 *  oracle's own signature-verify ix. Anything else is not this transaction. */
export const COMPUTE_BUDGET_PROGRAM_ID = "ComputeBudget111111111111111111111111111111";
export const ED25519_PROGRAM_ID = "Ed25519SigVerify111111111111111111111111111";

/**
 * Account order of exercise_american (IDL order — the on-chain struct's order).
 * Index 3 (price_update) and 11-13 (sb_*) are Anchor optionals.
 */
export const EXERCISE_ACCOUNT_INDEX = Object.freeze({
  holder: 0,
  sharedVault: 1,
  market: 2,
  priceUpdate: 3,
  vaultMintRecord: 4,
  optionMint: 5,
  holderOptionAccount: 6,
  vaultUsdcAccount: 7,
  holderUsdcAccount: 8,
  token2022Program: 9,
  tokenProgram: 10,
  sbQueue: 11,
  sbSlothashes: 12,
  sbInstructions: 13,
});

export interface ExpectedExercise extends SbExerciseRequest {
  /** Our Opta program id — not the endpoint's claim about it. */
  programId: string;
}

/** Raised when a server-built tx is not the transaction we asked for. */
export class ExerciseTxShapeError extends Error {
  constructor(detail: string) {
    super(`Refused to sign: ${detail}`);
    this.name = "ExerciseTxShapeError";
  }
}

function u64le(bytes: Uint8Array, offset: number): bigint {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[offset + i]);
  return v;
}

/**
 * Verify a server-built exercise tx against locally-derived expectations, and
 * throw before the wallet is asked to sign anything that fails.
 *
 * What each check buys, since a guard nobody can reason about is decoration:
 *
 *  - NO LOOKUP TABLES. A v0 tx can hide accounts behind an address table that
 *    the FE cannot resolve without another RPC round-trip. If we can't see every
 *    account synchronously we cannot check them, so we require them all static.
 *  - ONE SIGNER, THE HOLDER, AS PAYER. The holder must be the only required
 *    signature. This alone stops the tx from moving anyone else's assets.
 *  - PROGRAM ALLOWLIST + EXACTLY ONE OPTA IX. No extra Opta calls smuggled in
 *    beside the exercise (a second ix could be a transfer, a listing, anything).
 *  - DISCRIMINATOR. It is exercise_american, not some other Opta instruction
 *    that happens to take the same accounts.
 *  - EVERY ACCOUNT + THE QUANTITY. Compared against values THIS CLIENT derived,
 *    so a swapped vault, a substituted USDC destination, or an inflated
 *    quantity are all rejected. `price_update` must be the omitted-optional
 *    sentinel (Anchor encodes an absent optional as the program id) — an SB
 *    exercise carrying a Pyth account is not the tx we asked for.
 */
export function assertExerciseTxShape(
  tx: VersionedTransaction,
  expected: ExpectedExercise,
): void {
  const msg = tx.message;

  if (msg.addressTableLookups && msg.addressTableLookups.length > 0) {
    throw new ExerciseTxShapeError("transaction uses address lookup tables");
  }

  const keys = msg.staticAccountKeys.map((k: PublicKey) => k.toBase58());

  if (msg.header.numRequiredSignatures !== 1) {
    throw new ExerciseTxShapeError(
      `expected exactly 1 signer, found ${msg.header.numRequiredSignatures}`,
    );
  }
  if (keys[0] !== expected.holder) {
    throw new ExerciseTxShapeError("fee payer is not your wallet");
  }

  const allowed = new Set([
    expected.programId,
    COMPUTE_BUDGET_PROGRAM_ID,
    ED25519_PROGRAM_ID,
  ]);
  const ixs = msg.compiledInstructions;
  for (const ix of ixs) {
    const pid = keys[ix.programIdIndex];
    if (!allowed.has(pid)) {
      throw new ExerciseTxShapeError(`transaction invokes an unexpected program (${pid})`);
    }
  }

  const optaIxs = ixs.filter((ix) => keys[ix.programIdIndex] === expected.programId);
  if (optaIxs.length !== 1) {
    throw new ExerciseTxShapeError(
      `expected exactly 1 Opta instruction, found ${optaIxs.length}`,
    );
  }
  const ix = optaIxs[0];
  const data = ix.data instanceof Uint8Array ? ix.data : new Uint8Array(ix.data as any);

  if (data.length !== 16) {
    throw new ExerciseTxShapeError(`instruction data is ${data.length} bytes, expected 16`);
  }
  for (let i = 0; i < 8; i++) {
    if (data[i] !== EXERCISE_AMERICAN_DISCRIMINATOR[i]) {
      throw new ExerciseTxShapeError("instruction is not exercise_american");
    }
  }
  const qty = u64le(data, 8);
  if (qty !== BigInt(expected.quantity)) {
    throw new ExerciseTxShapeError(
      `quantity is ${qty.toString()}, expected ${expected.quantity}`,
    );
  }

  const acc = ix.accountKeyIndexes;
  if (acc.length !== 14) {
    throw new ExerciseTxShapeError(
      `instruction has ${acc.length} accounts, expected 14`,
    );
  }
  const at = (i: number) => keys[acc[i]];
  const I = EXERCISE_ACCOUNT_INDEX;

  const mustMatch: Array<[number, string, string]> = [
    [I.holder, expected.holder, "holder"],
    [I.sharedVault, expected.sharedVault, "vault"],
    [I.market, expected.market, "market"],
    [I.vaultMintRecord, expected.vaultMintRecord, "mint record"],
    [I.optionMint, expected.optionMint, "option mint"],
    [I.holderOptionAccount, expected.holderOptionAccount, "your option account"],
    [I.vaultUsdcAccount, expected.vaultUsdcAccount, "vault USDC account"],
    [I.holderUsdcAccount, expected.holderUsdcAccount, "your USDC account"],
  ];
  for (const [idx, want, label] of mustMatch) {
    if (at(idx) !== want) {
      throw new ExerciseTxShapeError(`${label} does not match the position you selected`);
    }
  }

  // Anchor encodes an omitted optional account as the program id itself.
  if (at(I.priceUpdate) !== expected.programId) {
    throw new ExerciseTxShapeError("transaction carries an unexpected price account");
  }
  for (const [idx, label] of [
    [I.sbQueue, "queue"],
    [I.sbSlothashes, "slot hashes"],
    [I.sbInstructions, "instructions sysvar"],
  ] as Array<[number, string]>) {
    if (at(idx) === expected.programId) {
      throw new ExerciseTxShapeError(`price proof is missing its ${label} account`);
    }
  }

  // The oracle's signature-verify ix must be present; without it the on-chain
  // proof cannot be read at all.
  if (!ixs.some((i2) => keys[i2.programIdIndex] === ED25519_PROGRAM_ID)) {
    throw new ExerciseTxShapeError("transaction carries no price proof");
  }
}

/**
 * Is the quote already dead (or about to be) at this slot?
 *
 * `margin` covers the send + land gap: a transaction accepted here still has to
 * reach a leader, so checking against the bare deadline would approve quotes
 * that expire in flight. 20 slots is ~5 s at the measured rate.
 *
 * Returns false when the endpoint published no deadline — an older build, where
 * the caller keeps the previous blockhash-only behaviour rather than inventing
 * a bound it cannot know.
 */
export function isQuoteExpired(
  resp: Pick<SbExerciseResponse, "quoteExpiresAtSlot">,
  currentSlot: number,
  margin = 20,
): boolean {
  if (typeof resp.quoteExpiresAtSlot !== "number") return false;
  return currentSlot + margin >= resp.quoteExpiresAtSlot;
}

/** Deserialize a base64 tx from the endpoint. Malformed bytes are a shape
 *  failure, not a crash. */
export function deserializeExerciseTx(transactionBase64: string): VersionedTransaction {
  let raw: Uint8Array;
  try {
    raw = Uint8Array.from(Buffer.from(transactionBase64, "base64"));
  } catch {
    throw new ExerciseTxShapeError("response was not a readable transaction");
  }
  try {
    return VersionedTransaction.deserialize(raw);
  } catch {
    throw new ExerciseTxShapeError("response was not a readable transaction");
  }
}
