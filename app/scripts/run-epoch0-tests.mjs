// =============================================================================
// run-epoch0-tests.mjs — runner for the campaign pure-logic tests
// =============================================================================
//
// WHY THIS EXISTS. `app/` has no test runner, and adding vitest would mean an
// `app/` reinstall on a live production frontend (this repo has previously had
// yarn.lock rewritten and 200+ packages pruned by exactly that). Founder call
// 2026-07-26: keep campaign logic in pure modules, test those, and let the
// screenshot gate cover render.
//
// `app/package.json` declares `"type": "module"`, so node treats every .ts under
// app/ as ESM and ts-node's CJS register refuses to load it — while the root
// ts-node is too old to expose the `/esm` loader. The way through, with no new
// dependency, is to compile the pure modules + tests to CommonJS into a build
// dir OUTSIDE app/ (the repo root has no `type`, so CJS applies) and run the
// emitted JS with node's built-in test runner.
//
//   node app/scripts/run-epoch0-tests.mjs
// =============================================================================

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const repoRoot = path.resolve(appDir, "..");
const outDir = path.join(repoRoot, ".epoch0-test-build");

const SOURCES = ["src/utils/epoch0Format.ts", "src/utils/epoch0Sign.ts", "src/utils/epoch0Format.test.ts"];

fs.rmSync(outDir, { recursive: true, force: true });

try {
  execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    [
      "tsc",
      ...SOURCES.map((s) => path.join(appDir, s)),
      "--outDir", outDir,
      "--module", "commonjs",
      "--target", "ES2020",
      "--lib", "ES2020,DOM",
      "--moduleResolution", "node",
      "--esModuleInterop",
      "--skipLibCheck",
      "--strict",
    ],
    { stdio: "inherit", cwd: repoRoot },
  );
} catch {
  console.error("epoch0 tests: TypeScript compilation FAILED");
  process.exit(1);
}

// tsc mirrors the source tree under outDir; find the emitted test file.
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

const testJs = find(outDir, "epoch0Format.test.js");
if (!testJs) {
  console.error("epoch0 tests: compiled test not found under", outDir);
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
  console.error("epoch0 tests FAILED");
  process.exit(1);
}
console.log("epoch0 tests passed");
