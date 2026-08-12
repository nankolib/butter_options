// =============================================================================
// run-market-hours-tests.mjs — runner for the K2/D2 transaction-outcome gates
// =============================================================================
//
// Same mechanism and the same reason as run-settle-tuples-tests.mjs: app/ has no
// test runner and adding one would mean an app/ reinstall on a live production
// frontend. Compile the pure modules + test to CommonJS OUTSIDE app/ (the repo
// root has no "type", so CJS applies) and run the emitted JS under node:test.
//
//   node app/scripts/run-market-hours-tests.mjs
//
// txOutcome is dependency-free and takes an injectable StatusFetcher, so the
// incident is replayed against fakes with no RPC and no clock dependence.
// =============================================================================

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const repoRoot = path.resolve(appDir, "..");
const outDir = path.join(repoRoot, ".market-hours-test-build");

const SOURCES = [
  "src/utils/marketHours.ts",
  "src/utils/marketHours.test.ts",
];

fs.rmSync(outDir, { recursive: true, force: true });

// Call app/'s typescript binary DIRECTLY, not `npx tsc` — the repo root has the
// unrelated `tsc` npm package installed and `npx tsc` resolves to it. Run the
// compiler's JS entrypoint under this node, NOT the .bin shim: since Node 20
// execFileSync refuses to spawn a .cmd without `shell:true`, and this repo lives
// under a path with a space, so shell quoting is a second trap.
const tscJs = path.join(appDir, "node_modules", "typescript", "bin", "tsc");
if (!fs.existsSync(tscJs)) {
  console.error("market-hours tests: typescript not found at", tscJs, "— run `npm i` in app/");
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
  console.error("market-hours tests: TypeScript compilation FAILED");
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

const testJs = find(outDir, "marketHours.test.js");
if (!testJs) {
  console.error("market-hours tests: compiled test not found under", outDir);
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
  console.error("market-hours tests FAILED");
  process.exit(1);
}
console.log("market-hours tests passed");
