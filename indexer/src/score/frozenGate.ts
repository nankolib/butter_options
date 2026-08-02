// =============================================================================
// frozen.ts — the weight freeze, enforced at boot
// =============================================================================
//
// WHY A HASH AND NOT A GIT TAG.
//   `indexer/dist/` is gitignored, and the VPS deploy is a path-overlay into a
//   checkout whose HEAD is some other commit entirely. The bytes that actually
//   score the campaign are therefore not in git and are pinned to no commit. A
//   tag on `src/` would certify a file the runtime never opens. So the freeze is
//   content-addressed over the artifacts that are genuinely loaded.
//
// WHY require.resolve AND NOT A PATH LITERAL.
//   Hashing `path.join(__dirname, "rules_v1.js")` asserts something about a file
//   on disk. Hashing `require.resolve("./rules_v1")` asserts something about the
//   file Node ACTUALLY LOADED — the same resolution the scoring code itself went
//   through. Only the second one can catch a shadowed module, a stale
//   node_modules copy, or a dist/ that drifted from src/.
//
// WHY IT REFUSES TO START.
//   A rules change re-scores retroactively. An indexer that boots with drifted
//   weights does not fail — it quietly republishes everyone's history at new
//   values, and the first sign is a user asking why their points moved. An
//   outage is louder and cheaper than that.
//
// The DEFAULT_RULES deep-equal is a second, independent check: a file hash
// cannot see a monkey-patch or an env-driven mutation of the config object.
// =============================================================================

import { createHash } from "node:crypto";
import * as fs from "node:fs";

import { log } from "../log";
import { DEFAULT_RULES, RULES_VERSION } from "./rules_v1";
import { QUESTS_VERSION } from "./quests/evaluator";

import frozenManifest from "./FROZEN.json";

export interface FrozenEntry {
  /** Repo-relative path, for humans and for the git-side check. */
  path: string;
  /** "runtime" entries are re-hashed at boot; "source" entries are provenance. */
  layer: "runtime" | "source";
  /** Module specifier passed to require.resolve — runtime entries only. */
  specifier?: string;
  sha256: string;
}

export interface FrozenManifest {
  frozenAt: string;
  gitTag: string;
  rulesVersion: string;
  questsVersion: string;
  /** DEFAULT_RULES as frozen — deep-equal asserted at boot. */
  defaultRules: Record<string, number>;
  entries: FrozenEntry[];
}

export const FROZEN: FrozenManifest = frozenManifest as FrozenManifest;

export function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/**
 * The seven artifacts whose bytes define the scoring semantics.
 *
 * `referrals.js` is here because pinning the referral PARAMETERS is not the same
 * as pinning the referral RULES. The rate, the bond and the 25% cap live in
 * quests_v1.json and are covered by that file's hash — but the code that decides
 * the cap is non-circular, that commission accrues only after activation, and
 * that a referrer's cap is measured against self-earned points lives here, and
 * a change to any of it re-scores the referral economy without touching a single
 * config value.
 */
export const RUNTIME_SPECIFIERS: { path: string; specifier: string }[] = [
  { path: "indexer/dist/src/score/quests/quests_v1.json", specifier: "./quests/quests_v1.json" },
  { path: "indexer/dist/src/score/rules_v1.js", specifier: "./rules_v1" },
  { path: "indexer/dist/src/score/quests/evaluator.js", specifier: "./quests/evaluator" },
  { path: "indexer/dist/src/score/multiplier.js", specifier: "./multiplier" },
  { path: "indexer/dist/src/score/recompute.js", specifier: "./recompute" },
  { path: "indexer/dist/src/score/positions.js", specifier: "./positions" },
  { path: "indexer/dist/src/score/referrals.js", specifier: "./referrals" },
];

/** The two files a human edits, hashed for the git-side record. */
export const SOURCE_PATHS = [
  "indexer/src/score/quests/quests_v1.json",
  "indexer/src/score/rules_v1.ts",
];

export interface DriftRow {
  path: string;
  expected: string;
  actual: string;
}

/**
 * Re-hash every runtime artifact through require.resolve and diff against the
 * manifest. Pure — returns the drift instead of throwing, so it is testable.
 *
 * `entries` is injectable for exactly one reason: under ts-node,
 * require.resolve("./rules_v1") lands on `src/score/rules_v1.ts`, while in
 * production it lands on `dist/src/score/rules_v1.js`. The manifest pins the
 * dist bytes — the ones that actually run — so a test cannot compare against it
 * directly. Tests build a manifest from the currently-resolved files and prove
 * the DETECTION works; `freeze --check`, run against dist, proves the real
 * manifest matches.
 */
export function checkRuntimeHashes(entries: readonly FrozenEntry[] = FROZEN.entries): DriftRow[] {
  const drift: DriftRow[] = [];
  for (const entry of entries) {
    if (entry.layer !== "runtime" || !entry.specifier) continue;
    let actual: string;
    try {
      actual = sha256File(require.resolve(entry.specifier));
    } catch (e) {
      actual = `unresolvable: ${(e as Error).message}`;
    }
    if (actual !== entry.sha256) drift.push({ path: entry.path, expected: entry.sha256, actual });
  }
  return drift;
}

/** Config-object drift a file hash cannot see. */
export function checkDefaultRules(manifest: FrozenManifest = FROZEN): DriftRow[] {
  const drift: DriftRow[] = [];
  const frozen = manifest.defaultRules ?? {};
  const live = DEFAULT_RULES as unknown as Record<string, number>;
  for (const key of [...new Set([...Object.keys(frozen), ...Object.keys(live)])].sort()) {
    if (frozen[key] !== live[key]) {
      drift.push({ path: `DEFAULT_RULES.${key}`, expected: String(frozen[key]), actual: String(live[key]) });
    }
  }
  if (manifest.rulesVersion !== RULES_VERSION) {
    drift.push({ path: "RULES_VERSION", expected: manifest.rulesVersion, actual: RULES_VERSION });
  }
  if (manifest.questsVersion !== QUESTS_VERSION) {
    drift.push({ path: "QUESTS_VERSION", expected: manifest.questsVersion, actual: QUESTS_VERSION });
  }
  return drift;
}

/**
 * Boot gate. HARD-FAILS on any drift.
 *
 * An unpopulated manifest is a legitimate pre-freeze development state, not
 * drift — it warns loudly and allows boot. Once `entries` is non-empty the
 * check is absolute.
 */
export function assertFrozenWeights(): void {
  if (!FROZEN.entries || FROZEN.entries.length === 0) {
    log.warn("SCORE_WEIGHTS_NOT_FROZEN — FROZEN.json has no entries; scoring artifacts are UNPINNED", {
      rulesVersion: RULES_VERSION,
      questsVersion: QUESTS_VERSION,
    });
    return;
  }

  const drift = [...checkRuntimeHashes(), ...checkDefaultRules()];
  if (drift.length > 0) {
    for (const d of drift) {
      log.error("SCORE_WEIGHTS_DRIFT", { path: d.path, expected: d.expected, actual: d.actual });
    }
    throw new Error(
      `SCORE_WEIGHTS_DRIFT — ${drift.length} frozen scoring artifact(s) do not match ${FROZEN.gitTag} ` +
        `(frozen ${FROZEN.frozenAt}). Refusing to start: booting would silently re-score every wallet's ` +
        `history at unreviewed weights. Redeploy the frozen build, or re-freeze deliberately.`,
    );
  }

  log.info("score weights verified against freeze", {
    gitTag: FROZEN.gitTag,
    frozenAt: FROZEN.frozenAt,
    artifacts: FROZEN.entries.filter((e) => e.layer === "runtime").length,
  });
}

/** Compact form for GET /stats, so the public rules page can cite a hash. */
export function frozenSummary(): Record<string, unknown> {
  const find = (p: string) => FROZEN.entries.find((e) => e.path.endsWith(p))?.sha256 ?? null;
  return {
    tag: FROZEN.gitTag,
    frozen_at: FROZEN.frozenAt,
    rules_version: FROZEN.rulesVersion,
    quests_version: FROZEN.questsVersion,
    quests_sha256: find("src/score/quests/quests_v1.json"),
    rules_sha256: find("src/score/rules_v1.ts"),
    runtime_sha256: Object.fromEntries(
      FROZEN.entries.filter((e) => e.layer === "runtime").map((e) => [e.path.split("/score/")[1], e.sha256]),
    ),
  };
}
