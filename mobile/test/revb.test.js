// vC3 Rev B red-first suite — fixes A, B, C.
//
// These encode the REAL measured timings from the 2026-08-25 device capture:
//   scan responses landed 19:04:35, spot stage started 19:07:20 (165s later),
//   full load 120-180s, AUTO_REFRESH_MS = 60s.
// So every load lost the race to the next refresh and was silently discarded.
//
// Run:  node --test test/revb.test.js
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { createHarness, installReact, installReactNative } = require("./harness");

const OUT = process.env.OPTA_TEST_OUT || path.join(__dirname, "out");

/** A promise whose resolution this test controls — stands in for a 120s load. */
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const snapshotWith = (offerings) => ({
  markets: [{ account: { assetName: "WIF" } }],
  vaults: [], vaultMints: [], listings: [],
  spotByAsset: {}, spotStatusByAsset: {}, spotResolved: false,
  offerings, assets: ["WIF"], expiriesByAsset: { WIF: [1787904000] },
  fetchedAt: 1
});

/** Install a fake ../solana/marketData so the load duration is ours to dictate. */
function installMarketData(impl) {
  const target = path.join(OUT, "solana", "marketData.js");
  require.cache[target] = { id: target, filename: target, loaded: true, exports: impl };
  return target;
}

function setup(impl) {
  const h = createHarness();
  installReact(h.react);
  installReactNative();
  installMarketData(impl);
  const modPath = path.join(OUT, "state", "useMarketState.js");
  delete require.cache[modPath];
  const { useMarketState } = require(modPath);
  return { h, useMarketState };
}

// ------------------------------------------------------------------ FIX A
test("RevB-A: a superseded first result STILL commits when nothing is on screen", () => {
  // Faithful to the field: load #1 takes 120-180s; a NEW load starts and
  // supersedes it; load #1 lands first while #2 is still running (another 120s).
  // Each call gets its OWN deferred, and #2 is deliberately never resolved --
  // otherwise #2 rescues the commit and the test proves nothing.
  const loads = [];
  const { h, useMarketState } = setup({
    loadMarketSnapshot: () => { const d = deferred(); loads.push(d); return d.promise; },
    loadSpotPrices: () => Promise.resolve({ spotByAsset: {}, spotStatusByAsset: {} }),
    loadWalletPortfolio: () => Promise.resolve({ holdings: [], written: [] }),
    refetchPositionMetadata: () => Promise.resolve(null)
  });

  const conn1 = { rpcEndpoint: "a" };
  let r = h.render(() => useMarketState(conn1, null));
  assert.strictEqual(r.phase, "loading", "starts on skeletons");
  assert.strictEqual(loads.length, 1);

  // A foreground re-load supersedes it (fix B guards background refresh only,
  // so this path stays reachable by design).
  const conn2 = { rpcEndpoint: "b" };
  h.render(() => useMarketState(conn2, null));
  assert.strictEqual(loads.length, 2, "second load must have started to supersede #1");

  // #1 lands. #2 is still in flight and will be for another two minutes.
  loads[0].resolve(snapshotWith([{ id: "o1", asset: "WIF", expiry: 1787904000, side: "put" }]));

  return loads[0].promise.then(() => new Promise((res) => setImmediate(res))).then(() => {
    const after = h.render(() => useMarketState(conn2, null));
    // PRE-FIX: discarded -> phase never leaves "loading" -> skeletons forever.
    assert.notStrictEqual(after.phase, "loading",
      "superseded first result was discarded -> skeletons forever");
    assert.ok(after.snapshot, "snapshot must commit even though superseded");
    assert.strictEqual(after.snapshot.offerings.length, 1);
  });
});

// ------------------------------------------------------------------ FIX B
test("RevB-B: a background refresh does NOT pre-empt a load already in flight", () => {
  const load = deferred();
  let calls = 0;
  const { h, useMarketState } = setup({
    loadMarketSnapshot: () => { calls += 1; return load.promise; },
    loadSpotPrices: () => Promise.resolve({ spotByAsset: {}, spotStatusByAsset: {} }),
    loadWalletPortfolio: () => Promise.resolve({ holdings: [], written: [] }),
    refetchPositionMetadata: () => Promise.resolve(null)
  });

  const conn = { rpcEndpoint: "x" };
  const r = h.render(() => useMarketState(conn, null));
  assert.strictEqual(calls, 1, "mount starts exactly one load");

  // AUTO_REFRESH_MS fires at 60s; the load needs 120-180s.
  r.refresh();
  r.refresh();
  r.refresh();

  // PRE-FIX: backgroundRefreshInFlight was only set by BACKGROUND calls, so a
  // refresh during the FOREGROUND mount load sailed through and superseded it.
  assert.strictEqual(calls, 1,
    "refresh pre-empted the in-flight load (" + calls + " loads started, expected 1)");

  load.resolve(snapshotWith([]));
  return load.promise;
});

// ------------------------------------------------------------------ FIX C
test("RevB-C: offerings commit BEFORE the spot stage resolves", () => {
  const load = deferred();
  const spot = deferred();
  const { h, useMarketState } = setup({
    loadMarketSnapshot: () => load.promise,
    loadSpotPrices: () => spot.promise,
    loadWalletPortfolio: () => Promise.resolve({ holdings: [], written: [] }),
    refetchPositionMetadata: () => Promise.resolve(null)
  });

  const conn = { rpcEndpoint: "x" };
  h.render(() => useMarketState(conn, null));
  load.resolve(snapshotWith([{ id: "o1", asset: "WIF", expiry: 1787904000, side: "put" }]));

  return load.promise.then(() => new Promise((res) => setImmediate(res))).then(() => {
    const mid = h.render(() => useMarketState(conn, null));
    // The 165s spot tail is still outstanding here.
    assert.strictEqual(mid.phase, "loaded", "offerings must render without waiting for spot");
    assert.strictEqual(mid.snapshot.offerings.length, 1);
    assert.strictEqual(mid.snapshot.spotResolved, false, "spot must still be pending");
    assert.strictEqual(mid.pricePhaseFor("WIF"), "pending",
      "price cell must read pending, not a false 'stale'");

    spot.resolve({ spotByAsset: { WIF: 0.198 }, spotStatusByAsset: { WIF: "live" } });
    return spot.promise;
  }).then(() => new Promise((res) => setImmediate(res))).then(() => {
    const after = h.render(() => useMarketState(conn, null));
    assert.strictEqual(after.snapshot.spotResolved, true);
    assert.strictEqual(after.snapshot.spotByAsset.WIF, 0.198);
    assert.strictEqual(after.snapshot.offerings.length, 1, "offerings survived the spot merge");
  });
});

test("RevB-C2: a spot-stage FAILURE must not unrender offerings", () => {
  const load = deferred();
  const { h, useMarketState } = setup({
    loadMarketSnapshot: () => load.promise,
    // loadSpotPrices never throws by contract; it yields empty maps on failure.
    loadSpotPrices: () => Promise.resolve({ spotByAsset: {}, spotStatusByAsset: {} }),
    loadWalletPortfolio: () => Promise.resolve({ holdings: [], written: [] }),
    refetchPositionMetadata: () => Promise.resolve(null)
  });

  const conn = { rpcEndpoint: "x" };
  h.render(() => useMarketState(conn, null));
  load.resolve(snapshotWith([{ id: "o1", asset: "WIF", expiry: 1787904000, side: "put" }]));

  return load.promise.then(() => new Promise((res) => setImmediate(res)))
    .then(() => new Promise((res) => setImmediate(res)))
    .then(() => {
      const after = h.render(() => useMarketState(conn, null));
      assert.strictEqual(after.phase, "loaded", "board must stay rendered");
      assert.strictEqual(after.snapshot.offerings.length, 1, "offerings must survive a dead spot stage");
      assert.strictEqual(after.snapshot.spotByAsset.WIF, undefined, "price simply absent");
    });
});

// ------------------------------------------------- source-level guards
test("RevB-src: loadSpotPrices is exported and the inline spot stage is gone", () => {
  const fs = require("fs");
  const SRC = process.env.OPTA_TEST_SRC || path.join(__dirname, "..", "src");
  const md = fs.readFileSync(path.join(SRC, "solana", "marketData.ts"), "utf8");
  assert.match(md, /export async function loadSpotPrices\(/, "loadSpotPrices not exported");
  assert.match(md, /spotResolved: false/, "snapshot must start with spot unresolved");
  const before = md.indexOf("const offerings: Offering[] = []");
  const inlineAwait = md.indexOf("await Promise.all(Array.from(feeds.entries())");
  assert.ok(inlineAwait === -1 || inlineAwait > before,
    "the spot stage still runs inline BEFORE offerings are built");

  const ums = fs.readFileSync(path.join(SRC, "state", "useMarketState.ts"), "utf8");
  assert.match(ums, /loadInFlight/, "FIX B in-flight guard missing");
  assert.match(ums, /currentRequest !== requestId\.current && snapshotRef\.current/,
    "FIX A first-result guard missing");
});
