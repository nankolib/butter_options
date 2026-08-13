// =============================================================================
// run-tx-failure-tests.mjs — runner for the SB exercise-arm gates
// =============================================================================
//
// Same mechanism and the same reason as run-first-write-tests.mjs: app/ has no
// test runner and adding one would mean an app/ reinstall on a live production
// frontend. Compile the pure modules + test to CommonJS OUTSIDE app/ (the repo
// root has no "type", so CJS applies) and run the emitted JS under node:test.
//
//   node app/scripts/run-tx-failure-tests.mjs
//
// Both modules under test are dependency-free by design (no web3.js, no IDL
// import, no ./env), which is what lets the retry fingerprint be tested against
// the literal error strings measured on devnet 2026-08-12.
// =============================================================================

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const repoRoot = path.resolve(appDir, "..");
const outDir = path.join(repoRoot, ".tx-failure-test-build");

const SOURCES = [
  "src/utils/txFailure.ts",
  "src/utils/txFailure.test.ts",
  "src/utils/earlyExerciseAvailability.ts",
  "src/utils/earlyExerciseAvailability.test.ts",
  "src/utils/errorDecoder.ts",
  "src/utils/errorDecoder.provenance.test.ts",
];

fs.rmSync(outDir, { recursive: true, force: true });

// Call app/'s typescript binary DIRECTLY, not `npx tsc` — the repo root has the
// unrelated `tsc` npm package installed and `npx tsc` resolves to it.
const tscJs = path.join(appDir, "node_modules", "typescript", "bin", "tsc");
if (!fs.existsSync(tscJs)) {
  console.error("tx-failure tests: typescript not found at", tscJs, "— run `npm i` in app/");
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
  console.error("tx-failure tests: TypeScript compilation FAILED");
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

let failed = false;
for (const name of ["txFailure.test.js", "earlyExerciseAvailability.test.js", "errorDecoder.provenance.test.js"]) {
  const testJs = find(outDir, name);
  if (!testJs) {
    console.error("tx-failure tests: compiled test not found:", name);
    process.exit(1);
  }
  try {
    execFileSync(process.execPath, [testJs], { stdio: "inherit", cwd: repoRoot });
  } catch {
    failed = true;
  }
}

fs.rmSync(outDir, { recursive: true, force: true });
if (failed) {
  console.error("tx-failure tests FAILED");
  process.exit(1);
}
console.log("tx-failure tests passed");
