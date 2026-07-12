// ============================================================================
// spotSources.test.ts — unit tests for the PURE source-1 (SB) spot helpers.
// ============================================================================
// Vanilla TS + node:assert (no framework), same shape as marketSweep.test.ts.
// Exercises the simulate parser, the VolOracle field decode, the proxy/on-chain
// fallback selection (with injected impure edges), and the source split — all
// without a browser, React, or a live RPC.
//
// Run (ESM/TS): npx --yes tsx app/src/hooks/spotSources.test.ts
// ============================================================================

import assert from "node:assert/strict";
import { Buffer } from "buffer";
import {
  parseSimulate,
  decodeVolSpot,
  resolveSbSpots,
  splitBySource,
  SAMPLE_TS_OFFSET,
  SAMPLE_SPOT_OFFSET,
  MIN_ACCOUNT_LEN,
  SPOT_SCALE,
  type SbFeed,
} from "./spotSources";

// ---- Tiny runner -----------------------------------------------------------
type Test = { name: string; fn: () => void | Promise<void> };
const tests: Test[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

// Build a synthetic VolOracle sample account: i64 LE ts@5832, i64 LE spot@5840.
function mkSampleBuf(spot: number, asOf: number, len = 5856): Buffer {
  const buf = Buffer.alloc(len);
  buf.writeBigInt64LE(BigInt(asOf), SAMPLE_TS_OFFSET);
  buf.writeBigInt64LE(BigInt(Math.round(spot * SPOT_SCALE)), SAMPLE_SPOT_OFFSET);
  return buf;
}

// ============================================================================
// (a) parseSimulate — [{results:[...]}] → Number(results[0])
// ============================================================================
test("parseSimulate: valid [{results:[n]}] → number", () => {
  assert.equal(parseSimulate([{ results: [123.45] }]), 123.45);
  assert.equal(parseSimulate([{ results: ["678.9", "ignored"] }]), 678.9); // string coerced
});
test("parseSimulate: empty / missing / non-array → null", () => {
  assert.equal(parseSimulate([{ results: [] }]), null);
  assert.equal(parseSimulate([]), null); // json[0] undefined
  assert.equal(parseSimulate([{ foo: 1 }]), null); // no results
  assert.equal(parseSimulate({}), null); // not an array
  assert.equal(parseSimulate(null), null);
});
test("parseSimulate: non-finite result → null", () => {
  assert.equal(parseSimulate([{ results: ["not-a-number"] }]), null);
  assert.equal(parseSimulate([{ results: [Infinity] }]), null);
});

// ============================================================================
// (b) decodeVolSpot — i64 LE ts@5832 / spot@5840, /1e12, from a 5856-byte buffer
// ============================================================================
test("decodeVolSpot: decodes spot + asOf from a synthesized 5856-byte buffer", () => {
  const buf = mkSampleBuf(2500, 1_800_000_000);
  const d = decodeVolSpot(buf);
  assert.ok(d, "decoded");
  assert.equal(d!.spot, 2500);
  assert.equal(d!.asOf, 1_800_000_000);
});
test("decodeVolSpot: fractional spot round-trips within float tolerance", () => {
  const buf = mkSampleBuf(99.5, 1_750_000_123);
  const d = decodeVolSpot(buf)!;
  assert.ok(Math.abs(d.spot - 99.5) < 1e-6);
  assert.equal(d.asOf, 1_750_000_123);
});
test("decodeVolSpot: buffer shorter than the layout → null", () => {
  assert.equal(decodeVolSpot(Buffer.alloc(MIN_ACCOUNT_LEN - 1)), null);
});
test("decodeVolSpot: accepts a plain Uint8Array (not just Buffer)", () => {
  const buf = mkSampleBuf(42, 111);
  const d = decodeVolSpot(new Uint8Array(buf));
  assert.equal(d!.spot, 42);
  assert.equal(d!.asOf, 111);
});

// ============================================================================
// (c) resolveSbSpots — proxy / on-chain fallback selection (injected edges)
// ============================================================================
const F = (ticker: string, feedIdHex: string): SbFeed => ({ ticker, feedIdHex });

test("resolveSbSpots: base set + proxy ok → proxy value, on-chain untouched", async () => {
  let onChainCalls = 0;
  const r = await resolveSbSpots(
    [F("BTC", "aa")],
    "/xbar",
    async () => 65000,
    async () => { onChainCalls += 1; return new Map(); },
  );
  assert.deepEqual(r.prices, { BTC: 65000 });
  assert.deepEqual(r.asOf, {});
  assert.equal(r.error, null);
  assert.equal(onChainCalls, 0, "proxy hit → on-chain not consulted");
});

test("resolveSbSpots: base set + proxy miss (null) → on-chain decode with asOf", async () => {
  let proxyCalls = 0;
  const r = await resolveSbSpots(
    [F("ETH", "bb")],
    "/xbar",
    async () => { proxyCalls += 1; return null; },
    async (hexes) => {
      assert.deepEqual(hexes, ["bb"], "only the missed feed is queried on-chain");
      return new Map([["bb", { spot: 3200, asOf: 1_800_000_000 }]]);
    },
  );
  assert.equal(proxyCalls, 1);
  assert.deepEqual(r.prices, { ETH: 3200 });
  assert.deepEqual(r.asOf, { ETH: 1_800_000_000 });
  assert.equal(r.error, null);
});

test("resolveSbSpots: base UNSET → proxy skipped, straight to on-chain", async () => {
  let proxyCalls = 0;
  const r = await resolveSbSpots(
    [F("SOL", "cc")],
    null,
    async () => { proxyCalls += 1; return 999; },
    async () => new Map([["cc", { spot: 150, asOf: 1_700_000_000 }]]),
  );
  assert.equal(proxyCalls, 0, "no base → proxy never called");
  assert.deepEqual(r.prices, { SOL: 150 });
  assert.deepEqual(r.asOf, { SOL: 1_700_000_000 });
});

test("resolveSbSpots: mixed — one proxy hit, one on-chain miss", async () => {
  const r = await resolveSbSpots(
    [F("BTC", "aa"), F("ETH", "bb")],
    "/xbar",
    async (_b, hex) => (hex === "aa" ? 65000 : null),
    async (hexes) => {
      assert.deepEqual(hexes, ["bb"]);
      return new Map([["bb", { spot: 3200, asOf: 1_800_000_000 }]]);
    },
  );
  assert.deepEqual(r.prices, { BTC: 65000, ETH: 3200 });
  assert.deepEqual(r.asOf, { ETH: 1_800_000_000 }); // proxy-sourced BTC has no asOf
});

test("resolveSbSpots: on-chain decode throws → error set, proxy prices retained", async () => {
  const r = await resolveSbSpots(
    [F("BTC", "aa"), F("ETH", "bb")],
    "/xbar",
    async (_b, hex) => (hex === "aa" ? 65000 : null),
    async () => { throw new Error("rpc down"); },
  );
  assert.deepEqual(r.prices, { BTC: 65000 }, "proxy-resolved price survives the RPC error");
  assert.equal(r.error, "rpc down");
});

test("resolveSbSpots: on-chain spot <= 0 filtered; asOf only when > 0", async () => {
  const r = await resolveSbSpots(
    [F("BAD", "dd"), F("NOTS", "ee")],
    null,
    async () => null,
    async () => new Map([
      ["dd", { spot: 0, asOf: 123 }],        // spot<=0 → dropped entirely
      ["ee", { spot: 10, asOf: 0 }],         // spot ok, asOf<=0 → price kept, no asOf
    ]),
  );
  assert.deepEqual(r.prices, { NOTS: 10 });
  assert.deepEqual(r.asOf, {});
  assert.equal(r.error, null);
});

test("resolveSbSpots: always returns the { prices, asOf, error } shape", async () => {
  const r = await resolveSbSpots([], "/xbar", async () => null, async () => new Map());
  assert.deepEqual(Object.keys(r).sort(), ["asOf", "error", "prices"]);
});

// ============================================================================
// (d) splitBySource — source==0 pass-through, source==1 normalized
// ============================================================================
test("splitBySource: source==0 passes through UNCHANGED; source==1 normalized", () => {
  const { pythFeeds, sbFeeds } = splitBySource([
    { ticker: "AAPL", feedIdHex: "0xABCDEF", oracleSource: 0 }, // untouched
    { ticker: "BTC", feedIdHex: "0xDEADBEEF", oracleSource: 1 }, // normalized
  ]);
  assert.deepEqual(pythFeeds, [{ ticker: "AAPL", feedIdHex: "0xABCDEF" }], "source-0 byte-identical");
  assert.deepEqual(sbFeeds, [{ ticker: "BTC", feedIdHex: "deadbeef" }], "source-1 lowercased, 0x stripped");
});

test("splitBySource: entries missing ticker/feedIdHex are dropped", () => {
  const { pythFeeds, sbFeeds } = splitBySource([
    { ticker: "", feedIdHex: "aa", oracleSource: 0 },
    { ticker: "X", feedIdHex: "", oracleSource: 1 },
    { ticker: "OK", feedIdHex: "bb", oracleSource: 0 },
  ] as any);
  assert.deepEqual(pythFeeds, [{ ticker: "OK", feedIdHex: "bb" }]);
  assert.deepEqual(sbFeeds, []);
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
      failed += 1;
    }
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}
main().catch((err) => { console.error("test runner crashed:", err); process.exit(1); });
