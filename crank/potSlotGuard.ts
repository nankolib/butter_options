// Slot-content guard for pot-bearing instruction builders. Ticket 86eyn5kxa /
// TP-SL arc Stage 0.
//
// WHY A SLOT GUARD AND NOT A COUNT GUARD
//   Anchor builds an instruction's account list FROM THE IDL. A stale IDL that
//   omits the writer-ask pot arm produces a short instruction and says nothing —
//   measured 2026-08-17: with pot accounts stripped, `accountsStrict` did not
//   throw, it silently emitted an 8-account settle_vault instead of 10.
//   `accountsStrict` only enforces that the CALLER supplies what the IDL declares;
//   keys the IDL does not know about are discarded without a word.
//
//   The first guard written against this (switchboardExerciseAmerican.ts, the
//   ACCOUNTS_VAULT_ONLY = 14 check) compared COUNTS. That catches the full legacy
//   shape and nothing else. Measured on the same day: the pot arm on
//   exercise_american is THREE accounts (writer_ask_pot, writer_ask_pot_usdc,
//   protocol_state), 14 -> 17. Strip only the two pot-named accounts and you get
//   15, which is above the `<= 14` threshold, so a partial IDL regression walks
//   straight through a count guard.
//
//   A slot guard cannot be fooled that way: it asserts that a SPECIFIC pubkey sits
//   at a SPECIFIC index. Wrong length, wrong order, or wrong key all fire.
//
// WHAT THIS IS NOT
//   It is not the last line of defense. All three programs reject a downgraded
//   build on chain — settle_vault via require_keys_eq against the mint-derived PDA
//   (and NotEnoughAccountKeys before that), exercise_american and execute_trigger
//   via EarlyExercisePotRequired (6084). Verified 2026-08-17 by reading the
//   handlers. This guard exists to fail BEFORE a wallet signature and before fees,
//   with a message that names the cause, instead of after.
import type { PublicKey, TransactionInstruction } from "@solana/web3.js";

export interface PotSlotExpectation {
  /** Zero-based index into ix.keys where this account must appear. */
  slot: number;
  /** The pubkey that must be at that index. */
  expected: PublicKey;
  /** IDL account name, for the error message. */
  name: string;
}

export class PotSlotGuardError extends Error {
  constructor(
    message: string,
    readonly instruction: string,
    readonly slot: number,
    readonly accountName: string,
  ) {
    super(message);
    this.name = "PotSlotGuardError";
  }
}

/**
 * Assert that every expected pot account sits at its exact slot in the built
 * instruction. Throws PotSlotGuardError on the first mismatch.
 *
 * Call this AFTER building the instruction and BEFORE signing or sending. It is
 * pure and offline — no RPC, no keypair.
 */
export function assertPotSlots(
  ix: TransactionInstruction,
  expectations: readonly PotSlotExpectation[],
  ctx: { instruction: string; optionMint?: PublicKey },
): void {
  const stale =
    `The IDL in use predates (or partially predates) the writer-ask pot arm — ` +
    `Anchor drops undeclared accounts silently. Sync app/src/idl/opta.json from ` +
    `target/idl and restart.`;

  for (const { slot, expected, name } of expectations) {
    // Too short: the account is not merely misplaced, it is absent.
    if (ix.keys.length <= slot) {
      throw new PotSlotGuardError(
        `${ctx.instruction}: expected ${name} at account slot [${slot}], but the ` +
          `built instruction carries only ${ix.keys.length} accounts` +
          (ctx.optionMint ? ` (mint ${ctx.optionMint.toBase58()})` : "") +
          `. ${stale}`,
        ctx.instruction,
        slot,
        name,
      );
    }
    const actual = ix.keys[slot].pubkey;
    if (!actual.equals(expected)) {
      throw new PotSlotGuardError(
        `${ctx.instruction}: account slot [${slot}] should be ${name} ` +
          `(${expected.toBase58()}) but holds ${actual.toBase58()}` +
          (ctx.optionMint ? ` (mint ${ctx.optionMint.toBase58()})` : "") +
          `. A shifted slot means the account list no longer matches the program's ` +
          `positional layout. ${stale}`,
        ctx.instruction,
        slot,
        name,
      );
    }
  }
}

/**
 * Canonical slot positions, read off the current IDL 2026-08-17 and pinned here so
 * a reorder on either side breaks a test rather than a settlement.
 */
export const POT_SLOTS = {
  settle_vault: { pot: 6, potUsdc: 7 },
  exercise_american: { pot: 14, potUsdc: 15 },
  execute_trigger: { pot: 25, potUsdc: 26 },
} as const;
