// ============================================================================
// crank/sbExerciseValidate.test.ts — what the exercise endpoint refuses
// ============================================================================
//   run: cd crank && npx ts-node --transpile-only -r tsconfig-paths/register \
//          sbExerciseValidate.test.ts
//
// The endpoint hands a transaction to a user's wallet, so the interesting tests
// are all refusals. The load-bearing one is the LAST section: the feedHash comes
// from the market account, so a body that names a different feed cannot change
// what gets priced.
// ============================================================================

import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";

import {
  MAX_EXERCISE_QUANTITY,
  ORACLE_SOURCE_PYTH,
  ORACLE_SOURCE_SWITCHBOARD,
  resolveSbFeedForMarket,
  validateExerciseBody,
  type MarketOracleView,
} from "./sbExerciseValidate";

const pk = () => Keypair.generate().publicKey.toBase58();

function goodBody(over: Record<string, unknown> = {}) {
  return {
    holder: pk(),
    sharedVault: pk(),
    market: pk(),
    vaultMintRecord: pk(),
    optionMint: pk(),
    holderOptionAccount: pk(),
    vaultUsdcAccount: pk(),
    holderUsdcAccount: pk(),
    quantity: 1,
    ...over,
  };
}

// ---- body shape -------------------------------------------------------------

test("a well-formed body validates", () => {
  const r = validateExerciseBody(goodBody());
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value.quantity, 1);
});

test("every pubkey field is required and must be a real pubkey", () => {
  for (const f of [
    "holder", "sharedVault", "market", "vaultMintRecord", "optionMint",
    "holderOptionAccount", "vaultUsdcAccount", "holderUsdcAccount",
  ]) {
    const missing = validateExerciseBody(goodBody({ [f]: undefined }));
    assert.equal(missing.ok, false, `${f} missing should fail`);
    const garbage = validateExerciseBody(goodBody({ [f]: "not-a-pubkey" }));
    assert.equal(garbage.ok, false, `${f} garbage should fail`);
  }
});

test("quantity must be a positive bounded integer", () => {
  for (const q of [0, -1, 1.5, NaN, "3", null, undefined, MAX_EXERCISE_QUANTITY + 1]) {
    assert.equal(validateExerciseBody(goodBody({ quantity: q })).ok, false, String(q));
  }
  assert.equal(validateExerciseBody(goodBody({ quantity: MAX_EXERCISE_QUANTITY })).ok, true);
});

test("a non-object body is refused rather than crashing the handler", () => {
  for (const b of [null, undefined, "x", 5, []]) {
    const r = validateExerciseBody(b);
    // An array has no string fields, so it fails on the first one — the point is
    // that nothing throws.
    assert.equal(r.ok, false, String(b));
  }
});

// ---- the feed comes from the chain, not the caller ---------------------------

// A real registry feedHash (SOL/USD) — the endpoint only quotes curated feeds.
const SOL_SB_FEEDHASH =
  "e01fe3bb1d659e5957296b2637658defd1f8b42fc87dd9f16e8fff16fcaeb463";
const hexToBytes = (h: string) =>
  Array.from({ length: h.length / 2 }, (_, i) => parseInt(h.slice(i * 2, i * 2 + 2), 16));

const marketPk = Keypair.generate().publicKey;
const loaderFor = (v: MarketOracleView | null) => async () => v;

test("an SB market resolves to the feedHash stored ON THE MARKET", async () => {
  const r = await resolveSbFeedForMarket(
    loaderFor({
      oracleSource: ORACLE_SOURCE_SWITCHBOARD,
      pythFeedId: hexToBytes(SOL_SB_FEEDHASH),
    }),
    marketPk,
  );
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.value, SOL_SB_FEEDHASH);
});

test("RED: the request body cannot choose which feed is priced", async () => {
  // The whole point of reading the chain. Even if a caller sent a feedHash, the
  // resolver's ONLY input beyond the market pubkey is the loader — there is no
  // body parameter to override it. This test pins that signature.
  assert.equal(
    resolveSbFeedForMarket.length,
    2,
    "resolveSbFeedForMarket must take (loader, market) and nothing caller-supplied",
  );
});

test("REFUSES: a Pyth market — it exercises in the browser and must not come here", async () => {
  const r = await resolveSbFeedForMarket(
    loaderFor({ oracleSource: ORACLE_SOURCE_PYTH, pythFeedId: hexToBytes(SOL_SB_FEEDHASH) }),
    marketPk,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /different price source/);
});

test("REFUSES: an oracle_source that is neither 0 nor 1", async () => {
  for (const src of [2, 255, -1]) {
    const r = await resolveSbFeedForMarket(
      loaderFor({ oracleSource: src, pythFeedId: hexToBytes(SOL_SB_FEEDHASH) }),
      marketPk,
    );
    assert.equal(r.ok, false, `source ${src}`);
  }
});

test("REFUSES: a market that does not exist", async () => {
  const r = await resolveSbFeedForMarket(loaderFor(null), marketPk);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /not found/);
});

test("REFUSES: an undecodable market account without throwing", async () => {
  // 14 devnet vaults are known-corrupt and a market could be too; a decode throw
  // inside the loader must become a refusal, not a 500.
  const throwing = async () => { throw new Error("Invalid account discriminator"); };
  const r = await resolveSbFeedForMarket(throwing, marketPk);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /not found/);
});

test("REFUSES: an all-zero or short feed field", async () => {
  for (const bytes of [new Array(32).fill(0).map(() => 0), [1, 2, 3], []]) {
    const r = await resolveSbFeedForMarket(
      loaderFor({ oracleSource: ORACLE_SOURCE_SWITCHBOARD, pythFeedId: bytes }),
      marketPk,
    );
    // All-zero IS 64 valid hex chars, so it is caught by the registry check;
    // short ones by the hex check. Either way: refused.
    assert.equal(r.ok, false, JSON.stringify(bytes).slice(0, 20));
  }
});

test("REFUSES: a well-formed feedHash that is not in the curated registry", async () => {
  const r = await resolveSbFeedForMarket(
    loaderFor({ oracleSource: ORACLE_SOURCE_SWITCHBOARD, pythFeedId: new Array(32).fill(0xab) }),
    marketPk,
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /unsupported price feed/);
});

// ---- copy discipline --------------------------------------------------------

test("no refusal string names a price vendor", async () => {
  const errors: string[] = [];
  const push = (r: any) => { if (!r.ok) errors.push(r.error); };

  push(validateExerciseBody(goodBody({ holder: "nope" })));
  push(validateExerciseBody(goodBody({ quantity: 0 })));
  push(await resolveSbFeedForMarket(loaderFor(null), marketPk));
  push(await resolveSbFeedForMarket(
    loaderFor({ oracleSource: ORACLE_SOURCE_PYTH, pythFeedId: hexToBytes(SOL_SB_FEEDHASH) }),
    marketPk));
  push(await resolveSbFeedForMarket(
    loaderFor({ oracleSource: ORACLE_SOURCE_SWITCHBOARD, pythFeedId: [1, 2] }), marketPk));
  push(await resolveSbFeedForMarket(
    loaderFor({ oracleSource: ORACLE_SOURCE_SWITCHBOARD, pythFeedId: new Array(32).fill(0xab) }),
    marketPk));

  assert.ok(errors.length >= 6, "expected every refusal path to produce a string");
  for (const e of errors) {
    assert.doesNotMatch(e, /pyth|switchboard|hermes|crossbar/i, e);
  }
});
