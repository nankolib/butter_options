// ============================================================================
// crank/volOracleCrank.test.ts -- Unit tests for the vol oracle crank glue
// ============================================================================
//
// Vanilla TS + node:assert. No test framework needed for the 3 small unit
// tests this file owns. Run via `npm test` from crank/ (added to package.json
// as ts-node invocation).
//
// What's covered here:
//   - dedupeFeedIds: shape + ordering + filter-malformed
//   - PDA derivation matches the on-chain seed shape
//   - msUntilNextHourBoundary: math, bounds, edge cases
//
// What's NOT covered here:
//   - The actual init/push txs (those go through real Pyth + RPC; manual
//     smoke via TICK_ONCE=1 against devnet handles that — see README)
//   - End-to-end tick (same reason)
// ============================================================================

import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";

import { VOL_ORACLE_SEED } from "@app/utils/constants";
import {
  dedupeFeedIds,
  msUntilNextHourBoundary,
  partitionPythMarkets,
} from "./volOracleCrank";

// ---- Tiny runner -----------------------------------------------------------

type Test = { name: string; fn: () => void | Promise<void> };
const tests: Test[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

// ---- Fixtures --------------------------------------------------------------

/** Synthesize a deterministic 32-byte feed_id from a seed. */
function makeFeed(seed: number): number[] {
  const out = new Array<number>(32);
  for (let i = 0; i < 32; i++) out[i] = (seed * 31 + i) & 0xff;
  return out;
}

// ---- dedupeFeedIds ---------------------------------------------------------

test("dedupeFeedIds: 5 markets sharing 3 unique feeds returns 3", () => {
  const A = makeFeed(1);
  const B = makeFeed(2);
  const C = makeFeed(3);
  const input = [A, A, B, C, B];
  const out = dedupeFeedIds(input);
  assert.equal(out.length, 3, "expected 3 unique feeds");
  // First-seen order preserved
  assert.deepEqual(out[0], A, "first slot = first-seen feed");
  assert.deepEqual(out[1], B, "second slot = second-seen feed");
  assert.deepEqual(out[2], C, "third slot = third-seen feed");
});

test("dedupeFeedIds: empty input returns empty array", () => {
  assert.deepEqual(dedupeFeedIds([]), []);
});

test("dedupeFeedIds: filters out malformed entries (not array, wrong length)", () => {
  const A = makeFeed(1);
  const B = makeFeed(2);
  const input: any[] = [A, null, [1, 2, 3], B, undefined, A];
  const out = dedupeFeedIds(input);
  assert.equal(out.length, 2, "two valid uniques, malformed dropped silently");
  assert.deepEqual(out[0], A);
  assert.deepEqual(out[1], B);
});

// ---- Stage 3 guard: partitionPythMarkets -----------------------------------

/** Synthesize a market record carrying an oracle_source byte. */
const mkMarket = (source: number, feedSeed = 1) => ({
  publicKey: new PublicKey(Buffer.from(makeFeed(feedSeed))),
  account: { oracleSource: source, pythFeedId: makeFeed(feedSeed), assetClass: 0 },
});

test("partitionPythMarkets: Switchboard market (oracle_source==1) is dropped", () => {
  const pyth = mkMarket(0, 1);
  const sb = mkMarket(1, 2);
  const { pyth: kept, skippedSb } = partitionPythMarkets([pyth, sb]);
  assert.equal(kept.length, 1, "only the Pyth market survives");
  assert.equal(kept[0], pyth, "the surviving market is the Pyth one");
  assert.equal(skippedSb, 1, "one SB market counted as skipped");
});

test("partitionPythMarkets: pure-Pyth set is unaffected (no SB present)", () => {
  const a = mkMarket(0, 1);
  const b = mkMarket(0, 2);
  // A market with an undefined/absent source byte is treated as Pyth (legacy).
  const legacy: { publicKey: PublicKey; account: { oracleSource?: number; pythFeedId: number[] } } = {
    publicKey: new PublicKey(Buffer.from(makeFeed(3))),
    account: { pythFeedId: makeFeed(3) },
  };
  const { pyth: kept, skippedSb } = partitionPythMarkets([a, b, legacy]);
  assert.equal(kept.length, 3, "all Pyth/legacy markets kept");
  assert.equal(skippedSb, 0, "nothing skipped");
});

test("partitionPythMarkets: mixed set keeps Pyth, drops every SB", () => {
  const markets = [mkMarket(0, 1), mkMarket(1, 2), mkMarket(0, 3), mkMarket(1, 4), mkMarket(1, 5)];
  const { pyth: kept, skippedSb } = partitionPythMarkets(markets);
  assert.equal(kept.length, 2, "two Pyth markets kept");
  assert.equal(skippedSb, 3, "three SB markets dropped");
  assert.ok(kept.every((m) => (m.account.oracleSource as number) !== 1), "no SB market survives");
});

// ---- PDA derivation --------------------------------------------------------

test("PDA derivation matches the on-chain seed shape exactly", () => {
  // Use the real opta program id so the result is verifiable against
  // initialize_vol_oracle.rs:90 (seeds = [VOL_ORACLE_SEED, feed_id]).
  const programId = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
  const feedId = makeFeed(42);

  const [pda, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from(VOL_ORACLE_SEED), Buffer.from(feedId)],
    programId,
  );

  // Determinism check: same inputs -> same PDA across invocations.
  const [pda2, bump2] = PublicKey.findProgramAddressSync(
    [Buffer.from(VOL_ORACLE_SEED), Buffer.from(feedId)],
    programId,
  );
  assert.equal(pda.toBase58(), pda2.toBase58(), "PDA is deterministic");
  assert.equal(bump, bump2, "bump is deterministic");

  // The seed prefix MUST be the literal string "vol_oracle" — anything
  // else changes the PDA and silently desyncs from the on-chain handler.
  assert.equal(VOL_ORACLE_SEED, "vol_oracle", "seed prefix is the canonical string");

  // Different feed -> different PDA
  const [pdaOther] = PublicKey.findProgramAddressSync(
    [Buffer.from(VOL_ORACLE_SEED), Buffer.from(makeFeed(99))],
    programId,
  );
  assert.notEqual(pda.toBase58(), pdaOther.toBase58(),
    "different feed_id must produce different PDA");
});

// ---- msUntilNextHourBoundary -----------------------------------------------

test("msUntilNextHourBoundary: minute 0 -> ~1 hour", () => {
  // Pin to a known wall-clock minute-zero (well in the past).
  // 2020-01-01T00:00:00.000Z = ms 1577836800000 (multiple of HOUR_MS).
  const minuteZero = 1577836800000;
  const sleep = msUntilNextHourBoundary(minuteZero);
  assert.equal(sleep, 60 * 60 * 1000, "exactly at boundary -> full hour");
});

test("msUntilNextHourBoundary: 23 min 17 sec past hour -> remaining of that hour", () => {
  const minuteZero = 1577836800000;
  const offsetMs = 23 * 60 * 1000 + 17 * 1000 + 250; // 23:17.250 into the hour
  const sleep = msUntilNextHourBoundary(minuteZero + offsetMs);
  const expected = 60 * 60 * 1000 - offsetMs;
  assert.equal(sleep, expected, "sleep = remaining-of-hour, exact ms math");
});

test("msUntilNextHourBoundary: output always in (0, HOUR_MS] for any input", () => {
  const HOUR = 60 * 60 * 1000;
  // Sample 100 quasi-random nowMs values across a wide range.
  for (let i = 0; i < 100; i++) {
    const nowMs = 1577836800000 + i * 12_345_678;
    const sleep = msUntilNextHourBoundary(nowMs);
    assert.ok(sleep > 0, `sleep must be > 0 (got ${sleep} at nowMs=${nowMs})`);
    assert.ok(sleep <= HOUR, `sleep must be <= HOUR_MS (got ${sleep} at nowMs=${nowMs})`);
  }
});

// ---- Runner ----------------------------------------------------------------

async function main(): Promise<void> {
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`✓ ${t.name}`);
      passed += 1;
    } catch (err) {
      console.error(`✗ ${t.name}`);
      console.error(`  ${err}`);
      if ((err as any)?.stack) console.error((err as any).stack);
      failed += 1;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("test runner crashed:", err);
  process.exit(1);
});
