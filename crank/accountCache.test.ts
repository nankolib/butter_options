// Tests for the cross-tick account cache — 2B item 1.
//
//   run: node crank/node_modules/ts-node/dist/bin.js --transpile-only crank/accountCache.test.ts
//
// The cache exists to cut the trigger tick from 3 getProgramAccounts to 1, on the
// crank that once issued 5,720 gPA/day and exhausted the key. So the tests have to
// prove BOTH halves of the bargain:
//
//   cheap    — a quiet board does not re-read
//   correct  — a NEW market is still evaluated, and not one refresh period late
//
// The second is the one that matters. A cache that only expires on age would hide
// a brand-new market for up to the TTL, which for a keeper means a trigger that
// silently is not being watched.
import { test } from "node:test";
import assert from "node:assert/strict";

import { AccountCache, ACCOUNT_CACHE_TTL_MS } from "./accountCache";

const key = (s: string) => ({ publicKey: { toBase58: () => s }, account: {} });

/** Fetcher with a call counter and a mutable result — one gPA per call. */
function stubFetcher(initial: string[]) {
  const state = { keys: [...initial], calls: 0 };
  const fn = async () => {
    state.calls++;
    return state.keys.map(key);
  };
  return { fn, state };
}

function clockFrom(start: number) {
  const c = { t: start };
  return { now: () => c.t, advance: (ms: number) => (c.t += ms), c };
}

test("cold start fetches exactly once", async () => {
  const { fn, state } = stubFetcher(["A", "B"]);
  const clk = clockFrom(1_000);
  const cache = new AccountCache(fn, ACCOUNT_CACHE_TTL_MS, "t", clk.now);
  const r = await cache.get();
  assert.equal(state.calls, 1);
  assert.equal(r.length, 2);
});

test("STEADY STATE: repeated ticks inside the TTL do not re-read", async () => {
  const { fn, state } = stubFetcher(["A", "B"]);
  const clk = clockFrom(1_000);
  const cache = new AccountCache(fn, ACCOUNT_CACHE_TTL_MS, "t", clk.now);

  await cache.get(["A"]);
  // Twelve ticks at the 300s cadence — a full hour of quiet board.
  for (let i = 0; i < 11; i++) {
    clk.advance(300_000);
    await cache.get(["A", "B"]);
  }
  assert.equal(state.calls, 1, "11 further ticks must cost ZERO extra gPA");
  assert.equal(cache.snapshot().hits, 11);
});

test("the age ceiling still fires, so known accounts cannot rot silently", async () => {
  const { fn, state } = stubFetcher(["A"]);
  const clk = clockFrom(0);
  const cache = new AccountCache(fn, ACCOUNT_CACHE_TTL_MS, "t", clk.now);
  await cache.get(["A"]);
  clk.advance(ACCOUNT_CACHE_TTL_MS - 1);
  await cache.get(["A"]);
  assert.equal(state.calls, 1, "one ms short of the TTL is still a hit");
  clk.advance(1);
  await cache.get(["A"]);
  assert.equal(state.calls, 2, "at the TTL it must refresh");
  assert.equal(cache.snapshot().ageRefreshes, 2); // cold start + expiry
});

// ---------------------------------------------------------------------------
// THE PROOF THE RULING ASKED FOR
// ---------------------------------------------------------------------------

test("a NEW market enters evaluation on the FIRST tick an order references it", async () => {
  const { fn, state } = stubFetcher(["MKT_A"]);
  const clk = clockFrom(0);
  const cache = new AccountCache(fn, ACCOUNT_CACHE_TTL_MS, "markets", clk.now);

  const first = await cache.get(["MKT_A"]);
  assert.equal(state.calls, 1);
  assert.deepEqual(first.map((e) => e.publicKey.toBase58()), ["MKT_A"]);

  // A market is created on chain. Only ONE tick passes — nowhere near the
  // one-hour TTL — and an order now references it.
  state.keys.push("MKT_NEW");
  clk.advance(300_000);
  const second = await cache.get(["MKT_A", "MKT_NEW"]);

  assert.equal(state.calls, 2, "the miss must force a refresh immediately");
  assert.ok(
    second.some((e) => e.publicKey.toBase58() === "MKT_NEW"),
    "the new market must be IN the returned set, not merely fetched",
  );
  assert.equal(cache.snapshot().missRefreshes, 1);
  assert.equal(cache.snapshot().ageRefreshes, 1, "cold start only; age did not fire");
});

test("RED: without the required-keys path the new market would stay invisible for the whole TTL", async () => {
  // Same scenario, but the caller does not declare what it needs — which is what
  // a plain TTL cache amounts to. This documents the failure the miss path exists
  // to prevent, and fails if that path is ever the only one.
  const { fn, state } = stubFetcher(["MKT_A"]);
  const clk = clockFrom(0);
  const cache = new AccountCache(fn, ACCOUNT_CACHE_TTL_MS, "markets", clk.now);

  await cache.get();                       // no required keys declared
  state.keys.push("MKT_NEW");
  clk.advance(300_000);
  const blind = await cache.get();          // still no keys declared

  assert.equal(state.calls, 1, "age has not expired, so nothing refetches");
  assert.ok(
    !blind.some((e) => e.publicKey.toBase58() === "MKT_NEW"),
    "and the new market is INVISIBLE — this is why the tick passes its needed keys",
  );
});

test("one refresh covers every miss on the same tick", async () => {
  const { fn, state } = stubFetcher(["A"]);
  const clk = clockFrom(0);
  const cache = new AccountCache(fn, ACCOUNT_CACHE_TTL_MS, "t", clk.now);
  await cache.get(["A"]);
  state.keys.push("B", "C", "D");
  await cache.get(["A", "B", "C", "D"]);
  assert.equal(state.calls, 2, "three missing keys must cost ONE refresh, not three");
});

test("a key that is missing even after a refresh does not loop", async () => {
  // An order can point at an account that genuinely does not exist (closed, or a
  // bad write). The cache must refresh once and then stop, not re-read forever.
  const { fn, state } = stubFetcher(["A"]);
  const clk = clockFrom(0);
  const cache = new AccountCache(fn, ACCOUNT_CACHE_TTL_MS, "t", clk.now);
  await cache.get(["A"]);
  for (let i = 0; i < 5; i++) await cache.get(["A", "GHOST"]);
  assert.equal(state.calls, 6, "one refresh per get is the bound; no inner retry loop");
  assert.ok(state.calls < 12, "and it must not multiply per missing key");
});

test("cost model: a quiet 24h at a 300s tick costs one refresh per TTL", async () => {
  const { fn, state } = stubFetcher(["A"]);
  const clk = clockFrom(0);
  const cache = new AccountCache(fn, ACCOUNT_CACHE_TTL_MS, "t", clk.now);
  for (let i = 0; i < 288; i++) {          // 288 ticks = 24h
    await cache.get(["A"]);
    clk.advance(300_000);
  }
  // 24h / 1h TTL = 24 age refreshes, and nothing else.
  assert.equal(state.calls, 24, `expected 24 refreshes in 24h, got ${state.calls}`);
  const perDayGpa = 288 /* orders */ + state.calls * 2 /* markets+vaults */;
  assert.ok(perDayGpa <= 340, `daily gPA should stay near the floor, got ${perDayGpa}`);
});
