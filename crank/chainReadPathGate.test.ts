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
