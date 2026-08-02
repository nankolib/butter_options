// =============================================================================
// scripts/freeze.ts — write (or verify) the weight freeze manifest
// =============================================================================
//
//   node dist/scripts/freeze.js --tag rules-v1-frozen --at 2026-08-02T16:40:00Z
//   node dist/scripts/freeze.js --check          # exit 1 on any drift
//
// MUST run against a FRESH BUILD. It hashes `dist/`, so a manifest generated
// over a stale build pins bytes nobody is running. `--check` is the same
// comparison the boot gate performs, available to CI and to a human before a
// deploy.
//
// Writes `src/score/FROZEN.json`; the next `npm run build` copies it into dist/.
// =============================================================================

import * as fs from "node:fs";
import * as path from "node:path";

import { DEFAULT_RULES, RULES_VERSION } from "../src/score/rules_v1";
import { QUESTS_VERSION } from "../src/score/quests/evaluator";
import {
  FROZEN,
  RUNTIME_SPECIFIERS,
  SOURCE_PATHS,
  checkDefaultRules,
  checkRuntimeHashes,
  sha256File,
  type FrozenEntry,
} from "../src/score/frozenGate";

/**
 * Walk up to the repo root. __dirname is `indexer/scripts` under ts-node and
 * `indexer/dist/scripts` when built, so a fixed "../.." is right in exactly one
 * of the two — and this script is normally run built.
 */
function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, "indexer", "src", "score", "rules_v1.ts"))) return dir;
    dir = path.resolve(dir, "..");
  }
  throw new Error("repo root not found from " + __dirname);
}

const REPO = repoRoot();
// Always write the SOURCE manifest — the dist copy is a build output, and
// writing there would be silently discarded by the next `npm run build`.
const SRC_MANIFEST = path.join(REPO, "indexer/src/score/FROZEN.json");

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

/** dist path for a runtime specifier, resolved the way the runtime resolves it. */
function resolveRuntime(spec: string): string {
  // Resolve relative to the compiled score/ directory, not to this script.
  return require.resolve(path.resolve(__dirname, "../src/score", spec));
}

function check(): void {
  const drift = [...checkRuntimeHashes(), ...checkDefaultRules()];
  if (drift.length === 0) {
    console.log(`freeze OK — ${FROZEN.entries.length} entries match ${FROZEN.gitTag || "(untagged)"}`);
    return;
  }
  for (const d of drift) console.error(`DRIFT ${d.path}\n  expected ${d.expected}\n  actual   ${d.actual}`);
  console.error(`\n${drift.length} drifted artifact(s).`);
  process.exit(1);
}

function write(): void {
  const tag = arg("--tag");
  const at = arg("--at");
  if (!tag || !at) {
    console.error("usage: freeze --tag <git-tag> --at <ISO8601>   (both required; --at is injected, never Date.now())");
    process.exit(1);
  }

  const entries: FrozenEntry[] = [];
  for (const r of RUNTIME_SPECIFIERS) {
    const file = resolveRuntime(r.specifier);
    if (!fs.existsSync(file)) {
      console.error(`freeze: ${file} is missing — run \`npm run build\` first.`);
      process.exit(1);
    }
    entries.push({ path: r.path, layer: "runtime", specifier: r.specifier, sha256: sha256File(file) });
  }
  for (const p of SOURCE_PATHS) {
    const file = path.join(REPO, p);
    if (!fs.existsSync(file)) {
      console.error(`freeze: source file ${p} not found`);
      process.exit(1);
    }
    entries.push({ path: p, layer: "source", sha256: sha256File(file) });
  }

  const manifest = {
    frozenAt: at,
    gitTag: tag,
    rulesVersion: RULES_VERSION,
    questsVersion: QUESTS_VERSION,
    defaultRules: { ...DEFAULT_RULES } as unknown as Record<string, number>,
    entries,
  };
  fs.writeFileSync(SRC_MANIFEST, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`freeze: wrote ${entries.length} entries to ${SRC_MANIFEST}`);
  for (const e of entries) console.log(`  ${e.layer.padEnd(7)} ${e.sha256}  ${e.path}`);
  console.log("\nNow rebuild so dist/ carries the manifest:  npm run build");
}

if (process.argv.includes("--check")) check();
else write();
