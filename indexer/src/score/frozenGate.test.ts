// =============================================================================
// frozenGate.test.ts — the freeze must actually catch drift
// =============================================================================
//
// A gate that has never rejected anything is not a gate. These tests force each
// class of drift and assert the gate sees it:
//   - a runtime artifact whose bytes changed
//   - a DEFAULT_RULES value changed in memory, which no file hash can see
//   - a version string that moved
//
// RESOLUTION NOTE. Under ts-node, require.resolve("./rules_v1") lands on
// `src/score/rules_v1.ts`; in production it lands on `dist/src/score/rules_v1.js`.
// The shipped manifest pins the dist bytes — the ones that actually run — so
// these tests build their own manifest from the currently-resolved files and
// prove DETECTION. That the shipped manifest matches the shipped dist is proved
// by `node dist/scripts/freeze.js --check`, which runs in the dist layout.
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";

import {
  FROZEN,
  RUNTIME_SPECIFIERS,
  checkDefaultRules,
  checkRuntimeHashes,
  sha256File,
  type FrozenEntry,
  type FrozenManifest,
} from "./frozenGate";
import { DEFAULT_RULES, RULES_VERSION } from "./rules_v1";
import { QUESTS_VERSION } from "./quests/evaluator";

/** Resolve the way frozenGate.ts does — relative to score/, which is here. */
const resolveHere = (spec: string) => require.resolve(path.resolve(__dirname, spec));

/** A manifest over the files THIS process actually resolves. */
function liveManifest(): FrozenManifest {
  const entries: FrozenEntry[] = RUNTIME_SPECIFIERS.map((r) => ({
    path: r.path,
    layer: "runtime",
    specifier: r.specifier,
    sha256: sha256File(resolveHere(r.specifier)),
  }));
  return {
    frozenAt: "test",
    gitTag: "test",
    rulesVersion: RULES_VERSION,
    questsVersion: QUESTS_VERSION,
    defaultRules: { ...DEFAULT_RULES } as unknown as Record<string, number>,
    entries,
  };
}

/** Walk up to the repo root — __dirname differs between src/ and dist/ layouts. */
function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "indexer", "src", "score", "rules_v1.ts"))) return dir;
    dir = path.resolve(dir, "..");
  }
  throw new Error("repo root not found");
}

// ---------------------------------------------------------------------------

test("require.resolve lands on a real file, with the extension we meant", () => {
  for (const r of RUNTIME_SPECIFIERS) {
    const resolved = resolveHere(r.specifier);
    assert.ok(fs.existsSync(resolved), `${r.specifier} -> ${resolved} does not exist`);
    // The trap the frozen.ts -> frozenGate.ts rename fixed: on a
    // case-insensitive filesystem `./frozen` resolved to FROZEN.json, because
    // .json precedes .ts in Node's extension order. Silent, and it would have
    // behaved differently on the VPS's ext4.
    assert.equal(
      resolved.endsWith(".json"),
      r.specifier.endsWith(".json"),
      `${r.specifier} resolved to the wrong kind of file: ${resolved}`,
    );
  }
});

test("a clean manifest reports no drift", () => {
  assert.deepEqual(checkRuntimeHashes(liveManifest().entries), []);
});

test("a byte change in a pinned artifact is DETECTED", () => {
  const manifest = liveManifest();
  const target = manifest.entries.find((e) => e.specifier?.endsWith(".json"))!;
  const file = resolveHere(target.specifier!);
  const original = fs.readFileSync(file);
  try {
    const tampered = JSON.parse(original.toString("utf8"));
    tampered.chain[0].points = 999_999;
    fs.writeFileSync(file, JSON.stringify(tampered, null, 2));

    const drift = checkRuntimeHashes(manifest.entries);
    assert.equal(drift.length, 1, "exactly the tampered artifact must be reported");
    assert.equal(drift[0].expected, target.sha256);
    assert.equal(drift[0].actual, sha256File(file));
    assert.notEqual(drift[0].actual, target.sha256);
  } finally {
    fs.writeFileSync(file, original);
  }
  assert.deepEqual(checkRuntimeHashes(manifest.entries), [], "restore must return the gate to clean");
});

test("a MISSING artifact is drift, not a crash", () => {
  const drift = checkRuntimeHashes([
    { path: "nope", layer: "runtime", specifier: "./does-not-exist", sha256: "0".repeat(64) },
  ]);
  assert.equal(drift.length, 1);
  assert.match(drift[0].actual, /^unresolvable:/);
});

test("a DEFAULT_RULES value changed IN MEMORY is detected — no file hash can see this", () => {
  const manifest = liveManifest();
  assert.deepEqual(checkDefaultRules(manifest), []);

  const live = DEFAULT_RULES as unknown as Record<string, number>;
  const was = live.dailyCapPoints;
  try {
    live.dailyCapPoints = 5_000;
    const drift = checkDefaultRules(manifest);
    assert.equal(drift.length, 1);
    assert.equal(drift[0].path, "DEFAULT_RULES.dailyCapPoints");
    assert.equal(drift[0].expected, String(was));
    assert.equal(drift[0].actual, "5000");
  } finally {
    live.dailyCapPoints = was;
  }
  assert.deepEqual(checkDefaultRules(manifest), []);
});

test("a moved version string is detected", () => {
  const drift = checkDefaultRules({ ...liveManifest(), rulesVersion: "v2" });
  assert.equal(drift.length, 1);
  assert.equal(drift[0].path, "RULES_VERSION");
  assert.equal(drift[0].actual, RULES_VERSION);
});

// ---- The SHIPPED manifest -------------------------------------------------

test("the shipped manifest pins every runtime artifact, and the two source files", () => {
  if (FROZEN.entries.length === 0) return; // legitimate pre-freeze state
  const runtime = FROZEN.entries.filter((e) => e.layer === "runtime").map((e) => e.specifier).sort();
  assert.deepEqual(runtime, RUNTIME_SPECIFIERS.map((r) => r.specifier).sort());
  const source = FROZEN.entries.filter((e) => e.layer === "source").map((e) => e.path).sort();
  assert.deepEqual(source, [
    "indexer/src/score/quests/quests_v1.json",
    "indexer/src/score/rules_v1.ts",
  ]);
});

test("the shipped manifest matches the live config and the source files on disk", () => {
  if (FROZEN.entries.length === 0) return;
  assert.deepEqual(FROZEN.defaultRules, { ...DEFAULT_RULES });
  assert.equal(FROZEN.rulesVersion, RULES_VERSION);
  assert.equal(FROZEN.questsVersion, QUESTS_VERSION);

  const repo = repoRoot();
  for (const e of FROZEN.entries.filter((x) => x.layer === "source")) {
    const file = path.join(repo, e.path);
    assert.ok(fs.existsSync(file), `${e.path} is pinned but missing`);
    assert.equal(sha256File(file), e.sha256, `${e.path} does not match its frozen hash`);
  }
});
