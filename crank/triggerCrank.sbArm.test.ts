// Phase A — trigger keeper Switchboard arm.
//
// The on-chain execute_trigger already routes by market.oracle_source; this
// keeper was the half that opted out (Pyth/Hermes read + Pyth-only ctx, every
// oracle_source==1 market skipped). Post-migration that is the ENTIRE tradeable
// board — recon 2026-07-22 found 24 SB markets vs 7 Pyth (all 7 off-board
// FX/commodity) and ZERO TriggerOrders, i.e. the keeper was firing for nobody.
//
// These pin the three seams the arm adds, and — the point of the flag — that
// with TRIGGER_SB_ENABLED off the Pyth arm is bit-for-bit what it was.
//   run: npx ts-node --transpile-only -r tsconfig-paths/register crank/triggerCrank.sbArm.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { SPL_SYSVAR_SLOT_HASHES_ID, SPL_SYSVAR_INSTRUCTIONS_ID } from "@switchboard-xyz/on-demand";
import {
  assembleExecuteAccounts, buildTriggerMarketMaps, splitFeedsByTape,
  readSbPricesBatched, classifyFireError, DEFAULT_FIRE_MAX_ATTEMPTS,
  type TriggerView,
} from "./triggerCrank";

const PROGRAM = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const USDC = new PublicKey("AytU5HUQRew9VdUdrzQuZvZ7s14pHLiYjAF5WqdK3oxL");
const QUEUE = new PublicKey("EYiAmGSdsQTuCw413V5BzaruWuCCSDgTPtBGvLkXHbe7");
const CALLER = new PublicKey("HgafDv195BtNc8X4uvNoRuGcUra5PuUwDJgHeKHvgFiS");
const PRICE_UPDATE = new PublicKey("11111111111111111111111111111112");
const FEED = "5f42a2a7b0b52a26774d3554b4d58cb5b997079379b5b94649d34451be0239f2";

const VIEW: TriggerView = {
  pubkey: "9KKKgiVbh2pk3dySQhbU1acsYfCrZkYdNqExBRRqPHf4",
  owner: CALLER.toBase58(),
  market: "4LmvanBuViCpWxX7uTXBPhML6PS7BhuCsQPboNGWQDEK",
  vault: "4CgaiuKR4yvRsQaLq3gTpoXDicLnA7EguVCYkwwqa1eN",
  optionMint: "KmxweFHhByiXKvTxy4w8eZRyXjVgbjDWTMPiTmSUDvR",
  holderOptionAta: "EazM1PGHvkTT1QRqhvKzKXof2xefk9fU5s1jUpuxbxRr",
  kind: "sell",
  comparator: "ge",
  thresholdUsdc: 65_000_000n,
  quantity: 1n,
  maxPremiumPerContract: 0n,
};
const feedBytes = Buffer.from(FEED, "hex");

// ---- ctx builder: exactly ONE tape populated -------------------------------

test("SB ctx: price_update is null and the three sb_* accounts are set", () => {
  const a = assembleExecuteAccounts(
    VIEW, feedBytes, USDC, CALLER, PRICE_UPDATE, PROGRAM, { queue: QUEUE },
  );
  assert.equal(a.priceUpdate, null, "SB path must NOT pass a PriceUpdateV2");
  assert.ok(a.sbQueue?.equals(QUEUE));
  assert.ok(a.sbSlothashes?.equals(SPL_SYSVAR_SLOT_HASHES_ID));
  assert.ok(a.sbInstructions?.equals(SPL_SYSVAR_INSTRUCTIONS_ID));
});

test("Pyth ctx unchanged (no-regression): price_update set, sb_* all null", () => {
  const a = assembleExecuteAccounts(
    VIEW, feedBytes, USDC, CALLER, PRICE_UPDATE, PROGRAM, null,
  );
  assert.ok((a.priceUpdate as PublicKey).equals(PRICE_UPDATE));
  assert.equal(a.sbQueue, null);
  assert.equal(a.sbSlothashes, null);
  assert.equal(a.sbInstructions, null);
});

test("both ctx variants agree on every non-tape account", () => {
  const pyth = assembleExecuteAccounts(VIEW, feedBytes, USDC, CALLER, PRICE_UPDATE, PROGRAM, null);
  const sb = assembleExecuteAccounts(VIEW, feedBytes, USDC, CALLER, PRICE_UPDATE, PROGRAM, { queue: QUEUE });
  const tape = new Set(["priceUpdate", "sbQueue", "sbSlothashes", "sbInstructions"]);
  for (const k of Object.keys(pyth)) {
    if (tape.has(k)) continue;
    assert.equal(
      (pyth[k] as PublicKey).toBase58(), (sb[k] as PublicKey).toBase58(),
      `account ${k} diverged between tapes`,
    );
  }
});

// ---- market maps: skip (flag off) vs route (flag on) ------------------------

const mkMarket = (pk: string, oracleSource: number, feedHex: string) => ({
  publicKey: new PublicKey(pk),
  account: { oracleSource, pythFeedId: [...Buffer.from(feedHex, "hex")] },
});
const PYTH_MKT = "4LmvanBuViCpWxX7uTXBPhML6PS7BhuCsQPboNGWQDEK";
const SB_MKT = "4CgaiuKR4yvRsQaLq3gTpoXDicLnA7EguVCYkwwqa1eN";
const PYTH_FEED = "baf182b54386b4a1c0354b7d64fb33d679301087a8b509d6a397d7b4f5162ee2";
const markets = [mkMarket(PYTH_MKT, 0, PYTH_FEED), mkMarket(SB_MKT, 1, FEED)];

test("flag OFF: SB market is tagged and EXCLUDED from the feed set (prior behaviour)", () => {
  const { marketFeed, sbMarkets } = buildTriggerMarketMaps(markets, false);
  assert.ok(sbMarkets.has(SB_MKT));
  assert.equal(marketFeed.has(SB_MKT), false, "SB feed must never reach Hermes");
  assert.equal(marketFeed.get(PYTH_MKT), PYTH_FEED);
});

test("flag ON: SB market enters the feed set, still tagged for routing", () => {
  const { marketFeed, sbMarkets } = buildTriggerMarketMaps(markets, true);
  assert.ok(sbMarkets.has(SB_MKT), "tag is the ROUTING key, not a denylist");
  assert.equal(marketFeed.get(SB_MKT), FEED);
  assert.equal(marketFeed.get(PYTH_MKT), PYTH_FEED);
});

test("splitFeedsByTape sends each feed to its own source", () => {
  const { marketFeed, sbMarkets } = buildTriggerMarketMaps(markets, true);
  const orders = [{ market: PYTH_MKT }, { market: SB_MKT }, { market: SB_MKT }];
  const { pythFeeds, sbFeeds } = splitFeedsByTape(orders, marketFeed, sbMarkets);
  assert.deepEqual(pythFeeds, [PYTH_FEED]);
  assert.deepEqual(sbFeeds, [FEED], "deduped");
});

test("splitFeedsByTape with the flag off yields an empty SB set", () => {
  const { marketFeed, sbMarkets } = buildTriggerMarketMaps(markets, false);
  const { pythFeeds, sbFeeds } = splitFeedsByTape(
    [{ market: PYTH_MKT }, { market: SB_MKT }], marketFeed, sbMarkets,
  );
  assert.deepEqual(pythFeeds, [PYTH_FEED]);
  assert.deepEqual(sbFeeds, []);
});

// ---- crossbar watch tape ----------------------------------------------------

test("readSbPricesBatched takes the median job value and stamps now", async () => {
  // Shape verified against the live crossbar 2026-07-22: key is `feedId` (hex,
  // no 0x) and `results` are STRINGS.
  const crossbar = {
    simulateFeeds: async () => [
      { feedId: FEED, feedName: "JUP/USD", results: ["0.19", "0.1921", "0.1919"], receipts: null },
    ],
  };
  const out = await readSbPricesBatched([FEED], crossbar, 1_784_748_386);
  const e = out.get(FEED);
  assert.ok(e, "feed present");
  assert.equal(e!.priceFloat, 0.1919, "median of the three job results");
  assert.equal(e!.publishTime, 1_784_748_386);
});

test("readSbPricesBatched: empty input short-circuits; junk results are dropped", async () => {
  const never = { simulateFeeds: async () => { throw new Error("must not be called"); } };
  assert.equal((await readSbPricesBatched([], never, 0)).size, 0);

  const junk = { simulateFeeds: async () => [{ feedId: FEED, results: ["0", "-1", "abc"] }] };
  assert.equal((await readSbPricesBatched([FEED], junk, 0)).size, 0, "no positive finite value ⇒ no entry");
});

// ---- Within-tick fire retry: classification + bound (Phase A T1-FIX) --------
// The SB gateway is ~3/15 clean (sbOracleCrank.ts); single-shot-per-tick catches
// that window far too slowly for a stop. fireProductionSb now retries with a
// FRESH quote — but must distinguish "never landed" (retry) from "chain rejected
// the revalidation" (terminal: re-sending a tx the program already refused is
// wrong and wastes the gateway window).

test("classifyFireError: gateway / quote-fetch / network failures are RETRYABLE", () => {
  assert.equal(classifyFireError(new Error("Failed to fetch gateway from crossbar: No gateways available for network: devnet")), "retryable");
  assert.equal(classifyFireError(new Error("no ed25519 ix in managed-update output")), "retryable");
  assert.equal(classifyFireError(new Error("fetch failed")), "retryable");
  assert.equal(classifyFireError("blockhash not found"), "retryable");
  assert.equal(classifyFireError(undefined), "retryable");
});

test("classifyFireError: an on-chain Custom program error is TERMINAL", () => {
  // 6059 TriggerConditionNotMet is 0x17ab; the value is what simulate returns.
  assert.equal(classifyFireError({ InstructionError: [2, { Custom: 6059 }] }), "terminal", "comparator revalidation failed");
  assert.equal(classifyFireError({ InstructionError: [2, { Custom: 6048 }] }), "terminal", "vol-oracle freshness");
  assert.equal(classifyFireError({ InstructionError: [1, { Custom: 1 }] }), "terminal", "insufficient funds etc.");
  assert.equal(classifyFireError({ Custom: 6059 }), "terminal", "bare Custom shape");
  // wrapped under `.err` (the shape a caught SendTransactionError can carry)
  assert.equal(classifyFireError({ err: { InstructionError: [2, { Custom: 6059 }] } }), "terminal");
});

test("classifyFireError: a NON-Custom InstructionError is retryable (not a program verdict)", () => {
  // e.g. ProgramFailedToComplete / compute exhaustion — worth a fresh attempt.
  assert.equal(classifyFireError({ InstructionError: [2, "ProgramFailedToComplete"] }), "retryable");
  assert.equal(classifyFireError({ InstructionError: [0, "InvalidAccountData"] }), "retryable");
});

test("fire retry bound is small and > 1 (bounded, but actually retries)", () => {
  assert.ok(DEFAULT_FIRE_MAX_ATTEMPTS >= 2 && DEFAULT_FIRE_MAX_ATTEMPTS <= 5,
    `expected a small bound, got ${DEFAULT_FIRE_MAX_ATTEMPTS}`);
});
