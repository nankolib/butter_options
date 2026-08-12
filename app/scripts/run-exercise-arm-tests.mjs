// =============================================================================
// run-exercise-arm-tests.mjs — runner for the SB exercise-arm gates
// =============================================================================
//
// Same mechanism and the same reason as run-first-write-tests.mjs: app/ has no
// test runner and adding one would mean an app/ reinstall on a live production
// frontend. Compile the pure modules + test to CommonJS OUTSIDE app/ (the repo
// root has no "type", so CJS applies) and run the emitted JS under node:test.
//
//   node app/scripts/run-exercise-arm-tests.mjs
//
// exerciseArm imports @solana/web3.js — which resolves from the REPO ROOT
// node_modules, where the Anchor test suite already depends on it. That is
// deliberate: the guard is tested against REAL VersionedTransactions built and
// serialized by the same library the wallet will hand them to, not a hand-rolled
// stand-in that could agree with a wrong implementation.
// =============================================================================

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const repoRoot = path.resolve(appDir, "..");
const outDir = path.join(repoRoot, ".exercise-arm-test-build");

const SOURCES = [
  "src/utils/exerciseArm.ts",
  "src/utils/exerciseArm.test.ts",
];

fs.rmSync(outDir, { recursive: true, force: true });

// Call app/'s typescript binary DIRECTLY, not `npx tsc` — the repo root has the
// unrelated `tsc` npm package installed and `npx tsc` resolves to it.
const tscJs = path.join(appDir, "node_modules", "typescript", "bin", "tsc");
if (!fs.existsSync(tscJs)) {
  console.error("exercise-arm tests: typescript not found at", tscJs, "— run `npm i` in app/");
  process.exit(1);
}

try {
  execFileSync(
    process.execPath,
    [
      tscJs,
      ...SOURCES.map((s) => path.join(appDir, s)),
      "--outDir", outDir,
      "--module", "commonjs",
      "--target", "ES2020",
      "--lib", "ES2020,DOM",
      "--moduleResolution", "node",
      "--esModuleInterop",
      "--skipLibCheck",
      "--strict",
      "--resolveJsonModule",
    ],
    { stdio: "inherit", cwd: repoRoot },
  );
} catch {
  console.error("exercise-arm tests: TypeScript compilation FAILED");
  process.exit(1);
}

function find(dir, name) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      const hit = find(p, name);
      if (hit) return hit;
    } else if (e.name === name) return p;
  }
  return null;
}

const testJs = find(outDir, "exerciseArm.test.js");
if (!testJs) {
  console.error("exercise-arm tests: compiled test not found under", outDir);
  process.exit(1);
}

let failed = false;
try {
  execFileSync(process.execPath, [testJs], { stdio: "inherit", cwd: repoRoot });
} catch {
  failed = true;
}

fs.rmSync(outDir, { recursive: true, force: true });
if (failed) {
  console.error("exercise-arm tests FAILED");
  process.exit(1);
}
console.log("exercise-arm tests passed");
