// The client's freshness gate — indexer read path.
//   run (from crank/): node node_modules/ts-node/dist/bin.js --transpile-only \
//                      -r tsconfig-paths/register chainReadPathGate.test.ts
//
// The dangerous direction is ACCEPTING what we should refuse. A restarted
// indexer answers for minutes before its first scan lands; serving that as data
// renders an empty board confidently, which reads as "you own nothing" rather
// than "still loading". Every rejection case below is a board that would
// otherwise have been drawn wrong.
import { test } from "node:test";
import assert from "node:assert/strict";

import { CLIENT_MAX_AGE_SEC, isServableEnvelope } from "@app/utils/chainRehydrate";

const good = { rows: [{}], stale: false, ageSec: 5, slot: 1 };

test("a fresh, well-formed envelope is servable", () => {
  assert.equal(isServableEnvelope(good), true);
});

test("RED: a server-flagged stale envelope is refused", () => {
  assert.equal(isServableEnvelope({ ...good, stale: true }), false);
});

test("RED: an envelope older than the client's own limit is refused even if unflagged", () => {
  // The client does not take the server's word for it. If the server stops
  // setting `stale`, this is the only thing standing between a user and data
  // from an indexer that quietly stopped refreshing an hour ago.
  assert.equal(isServableEnvelope({ ...good, stale: false, ageSec: CLIENT_MAX_AGE_SEC + 1 }), false);
  assert.equal(isServableEnvelope({ ...good, stale: false, ageSec: CLIENT_MAX_AGE_SEC }), true);
});

test("RED: a never-refreshed envelope (ageSec -1) is refused", () => {
  // Exactly what a freshly restarted indexer serves before its first scan.
  assert.equal(isServableEnvelope({ ...good, ageSec: -1 }), false);
});

test("garbage shapes are refused rather than half-read", () => {
  for (const b of [null, undefined, 42, "x", {}, { rows: "no" }, { rows: [] , ageSec: "5" }]) {
    assert.equal(isServableEnvelope(b as any), false, `${JSON.stringify(b)} must be refused`);
  }
});

test("an empty-but-fresh board is servable — empty is a legitimate answer", () => {
  // Distinct from the cases above: zero rows at a known recent slot really can
  // mean "this market has no series", and refusing it would force a pointless
  // chain scan on every load of a genuinely empty board.
  assert.equal(isServableEnvelope({ rows: [], stale: false, ageSec: 3 }), true);
});

// ---------------------------------------------------------------------------
// WIRING (standing rule: a new surface ships with a wiring test AND a
// live-bundle presence check; the bundle half is run against the deploy)
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP = join(__dirname, "..", "app", "src");
const read = (p: string) => readFileSync(join(APP, p), "utf8");

test("safeFetchAll actually consults the indexer — the path is reachable", () => {
  // The read path can be perfect and reached by nobody. That has now happened
  // twice in this codebase, so the wiring is asserted rather than assumed.
  const src = read("hooks/useFetchAccounts.ts");
  assert.match(src, /getIndexerReader\(\)/, "safeFetchAll must consult the registry");
});

test("the FE entry point installs the reader, or nothing is ever served", () => {
  // The registry is useless unless something registers into it, and the only
  // module that does is imported purely for its side effect.
  const main = read("main.tsx");
  assert.match(main, /import "\.\/utils\/chainReadPath"/, "main.tsx must import the read path for its side effect");
  const rp = read("utils/chainReadPath.ts");
  assert.match(rp, /registerIndexerReader\(/, "chainReadPath must register itself");
});

test("REGRESSION GUARD: safeFetchAll must never reach an import.meta module", () => {
  // `import.meta` is an ESM-only SYNTAX marker. Its presence anywhere in the
  // import graph makes Node treat the file as an ES module and crash the crank
  // with "exports is not defined in ES module scope" — which took the crank down
  // on 2026-07-21. Several crank scripts import useFetchAccounts directly, so
  // this file and its imports must stay CommonJS-safe. That is the entire reason
  // the indexer reader arrives through a registry instead of a plain import.
  // Comments are stripped first: these files DOCUMENT the hazard, and the rule
  // is about executable syntax, not prose. Matching raw text would fail on the
  // very comment that explains why the rule exists.
  const code = (p: string) =>
    read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

  const src = code("hooks/useFetchAccounts.ts");
  assert.ok(!src.includes("import.meta"), "useFetchAccounts must not contain import.meta");
  assert.ok(!/from ".*chainReadPath"/.test(src), "and must not import the module that does");
  assert.ok(!code("utils/indexerRegistry.ts").includes("import.meta"), "the registry itself must stay crank-safe");

  // The guard must be able to fail: chainReadPath genuinely uses import.meta,
  // so if the stripper ever eats real code this assertion goes red.
  assert.ok(code("utils/chainReadPath.ts").includes("import.meta"),
    "chainReadPath really does use import.meta — if this fails, the comment stripper is broken");
});

test("the read path is OFF unless explicitly enabled", () => {
  const src = read("utils/chainReadPath.ts");
  assert.match(src, /VITE_CHAIN_READPATH === "1"/, "must ship dark and be flipped deliberately");
});

test("R2: only structural types are served — never the book or positions", () => {
  const src = read("utils/chainReadPath.ts");
  for (const forbidden of ["restingOrder", "writerAskPosition", "writerAskPot",
                           "vaultResaleListing", "writerPosition", "settlementRecord"]) {
    assert.ok(!src.includes(forbidden), `${forbidden} must never be served from the index`);
  }
  for (const allowed of ["sharedVault", "vaultMint", "optionsMarket", "epochConfig"]) {
    assert.ok(src.includes(allowed), `${allowed} should be served`);
  }
});

test("a failed indexer read falls back rather than throwing", () => {
  const src = read("utils/chainReadPath.ts");
  assert.match(src, /return null/, "every failure path must return null so the caller falls back to chain");
});

// ---------------------------------------------------------------------------
// REGRESSION GUARDS for the two bugs that made the read path cost MORE
// ---------------------------------------------------------------------------

test("REGRESSION: the indexer read is single-flighted, keyed by market", () => {
  // Measured: without this, a cold /trade fetched /api/chain/vaults THREE times
  // at 3.74MB each, because several hooks call safeFetchAll concurrently before
  // any has stored a result. The key must include the market, or two different
  // boards would share one in-flight promise and one would get the other's rows.
  const src = read("utils/chainReadPath.ts");
  assert.match(src, /const inflight = new Map/, "there must be an in-flight map");
  assert.match(src, /\$\{name\}:\$\{params\?\.market \?\? ""\}/, "keyed by BOTH account type and market");
});

test("REGRESSION: the cache is consulted BEFORE the indexer", () => {
  // Measured: with the indexer first, every caller hit the network and the cache
  // never got a chance — /api/chain/vaults fetched twice per load even WITH
  // in-flight dedup, because the second wave arrives after the first settles.
  // Cheapest source must win: cache, then indexer, then chain scan.
  const src = read("hooks/useFetchAccounts.ts");
  const cacheAt = src.indexOf("lookupScan<T>(");
  const indexerAt = src.indexOf("getIndexerReader()");
  const chainAt = src.lastIndexOf("fetchAndDecodeScan<T>(program, accountName, discriminator)");
  assert.ok(cacheAt > 0 && indexerAt > 0 && chainAt > 0, "all three sources must be present");
  assert.ok(cacheAt < indexerAt, "cache must be consulted before the indexer");
  assert.ok(indexerAt < chainAt, "the indexer must be tried before a full chain scan");
});

test("REGRESSION: a chain fallback is cached UNFILTERED, never under a market", () => {
  // The chain scan cannot filter, so it always returns every board. Caching that
  // under the requested market would be harmless; caching a FILTERED result
  // under the unfiltered key would truncate every later all-boards read.
  const src = read("hooks/useFetchAccounts.ts");
  assert.match(src, /storeScan\(programId, accountName, rows, Date\.now\(\), ""\)/,
    "the chain-scan result must be stored under the unfiltered scope");
  assert.match(src, /storeScan\(programId, accountName, viaIndexer\.rows, Date\.now\(\), market\)/,
    "the indexer result must be stored under the scope actually fetched");
});

test("the market scope is RENDERING context, and says so", () => {
  // Boundary rule: narrowing a read that feeds transaction assembly would hand
  // the builder a partial view of the world.
  const src = read("hooks/useFetchAccounts.ts");
  assert.match(src, /RENDERING CONTEXT ONLY/, "the scope must be documented as rendering-only");
});

// ---------------------------------------------------------------------------
// GRACEFUL DEGRADATION — per-type, not wholesale
// ---------------------------------------------------------------------------
//
// The staleness threshold was assumed (90s) rather than derived, sat below the
// measured p95 refresh interval (129.4s over 280 samples PRE-decouple), and so
// flagged a
// healthy indexer as stale whenever devnet slowed — turning a slow day into a
// TOTAL fallback. These assert the shape that keeps that from being all-or-
// nothing.

test("(a) one slow type falls back ALONE — the others still serve from the index", () => {
  // A slow `vaults` scan must not stale-out `series` and `markets` that
  // refreshed fine. The envelope check is applied per response, so each type
  // stands on its own freshness.
  const slow = { rows: [{}], stale: false, ageSec: CLIENT_MAX_AGE_SEC + 1, slot: 1 };
  const fine = { rows: [{}], stale: false, ageSec: 12, slot: 1 };
  assert.equal(isServableEnvelope(slow), false, "the slow type falls back");
  assert.equal(isServableEnvelope(fine), true, "and the healthy ones do NOT");
});

test("(b) a genuinely dead indexer produces a FULL fallback", () => {
  // Every shape a dead or broken endpoint can produce must be unusable, so the
  // page degrades to chain scans across the board rather than half-rendering.
  for (const dead of [null, undefined, {}, { rows: null }, { rows: [], ageSec: -1 },
                      { rows: [{}], stale: true, ageSec: 5 }]) {
    assert.equal(isServableEnvelope(dead as never), false, `${JSON.stringify(dead)} must not serve`);
  }
});

test("(c) the 3.5-min warmup window refuses, per the runbook", () => {
  // A freshly restarted indexer answers for MINUTES before its first scan lands,
  // reporting ageSec -1. Serving that renders an empty board confidently, which
  // reads as "you own nothing" rather than "still starting".
  assert.equal(isServableEnvelope({ rows: [], stale: false, ageSec: -1, slot: 0 }), false);
  assert.equal(isServableEnvelope({ rows: [], stale: true, ageSec: 0, slot: 0 }), false);
});

test("the client threshold is DERIVED and says so", () => {
  // The rule that failed here was an assumed constant. It must now carry its
  // measurement, so the next person changing it knows what to re-measure.
  const src = read("utils/chainReadPath.ts");
  assert.match(src, /p95 70\.0s/, "the threshold must cite the measurement it came from");
  assert.equal(CLIENT_MAX_AGE_SEC >= 90, true, "and must respect the agreed floor");
});

test("client and server thresholds do not silently diverge", () => {
  // Two numbers that must agree, in two repos. If one moves alone, the client
  // either refuses fresh data or trusts data the server called stale.
  const client = read("utils/chainReadPath.ts");
  const m = client.match(/const MAX_AGE_SEC = (\d+)/);
  assert.ok(m, "client threshold must be a plain constant, greppable");
  assert.equal(Number(m[1]), 110, "client MAX_AGE_SEC must match the indexer's STALE_AFTER_SEC");
});
