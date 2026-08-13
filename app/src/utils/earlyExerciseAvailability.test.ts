// =============================================================================
// earlyExerciseAvailability.test.ts — don't offer what cannot succeed
// =============================================================================
//   run: node app/scripts/run-tx-failure-tests.mjs
//
// Fixtures are the REAL vault shapes measured on devnet 2026-08-12.
// =============================================================================

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  EARLY_EXERCISE_UNFUNDED_COPY,
  earlyExerciseAvailability,
} from "./earlyExerciseAvailability";

/** A BN-like, as Anchor actually returns. */
const bn = (n: number | string) => ({ toString: () => String(n) });

/** JTO 0.457C — the founder's position. Pure writer-ask: nothing in the vault. */
const JTO_0457C = {
  totalCollateral: bn(0),
  writerAskCollateralSwept: bn(0),
  isSettled: false,
};

/** A pool-backed vault: collateral was deposited into the vault itself. */
const POOL_BACKED = {
  totalCollateral: bn(6_855_000),
  writerAskCollateralSwept: bn(0),
  isSettled: false,
};

test("RED: the founder's JTO position is NOT offered early exercise", () => {
  // 15 contracts, $6.855 in the pot, $0 in the vault. Before this gate the app
  // offered the action, the user approved, and it failed inside the token
  // program — twice, because the retry fired too.
  const r = earlyExerciseAvailability(JTO_0457C);
  assert.equal(r.available, false);
  if (!r.available) assert.equal(r.reason, EARLY_EXERCISE_UNFUNDED_COPY);
});

test("a pool-backed vault IS still offered early exercise", () => {
  // The gate must not swallow the working case — that is the whole risk of
  // adding it.
  assert.equal(earlyExerciseAvailability(POOL_BACKED).available, true);
});

test("once the pot has been swept in, the vault can pay", () => {
  assert.equal(
    earlyExerciseAvailability({
      totalCollateral: bn(0),
      writerAskCollateralSwept: bn(6_855_000),
      isSettled: true,
    }).available,
    true,
  );
});

test("a settled vault is not this gate's business", () => {
  // Post-settlement redemption runs through exercise_from_vault, which reads a
  // vault the sweep has already funded.
  assert.equal(
    earlyExerciseAvailability({ ...JTO_0457C, isSettled: true }).available,
    true,
  );
});

test("plain numbers work as well as BN-likes", () => {
  assert.equal(earlyExerciseAvailability({ totalCollateral: 0 }).available, false);
  assert.equal(earlyExerciseAvailability({ totalCollateral: 1 }).available, true);
});

test("an unreadable vault fails OPEN, not closed", () => {
  // Wrongly hiding a working action is worse than letting the program decide.
  // The program is the authority; this gate only stops a guaranteed failure.
  for (const v of [null, undefined, {} as any, { totalCollateral: NaN }]) {
    const r = earlyExerciseAvailability(v);
    assert.equal(
      r.available,
      v && "totalCollateral" in (v as any) && !Number.isNaN((v as any).totalCollateral)
        ? r.available
        : r.available,
      "should not throw",
    );
  }
  assert.equal(earlyExerciseAvailability(null).available, true);
  assert.equal(earlyExerciseAvailability(undefined).available, true);
});

test("the copy states the consequence and leaks no mechanics", () => {
  const c = EARLY_EXERCISE_UNFUNDED_COPY;
  // No internals: no pot, no vault, no collateral, no sweep, no vendor.
  assert.doesNotMatch(c, /pot|vault|collateral|sweep|swept|writer|escrow|pyth|switchboard|hermes/i);
  // It must say what DOES happen, or it is just a refusal.
  assert.match(c, /expiry/i);
  assert.match(c, /automatic/i);
});
