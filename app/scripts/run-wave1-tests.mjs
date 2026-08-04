// =============================================================================
// run-wave1-tests.mjs — runner for the 2026-08-04 gap-audit regression gates
// =============================================================================
//
// Same mechanism and the same reason as run-epoch0-tests.mjs: app/ has no test
// runner and adding one would mean an app/ reinstall on a live production
// frontend. Compile the pure modules + test to CommonJS OUTSIDE app/ (the repo
// root has no "type", so CJS applies) and run the emitted JS under node:test.
//
//   node app/scripts/run-wave1-tests.mjs
//
// TZ NOTE: the BLK-8 gate asserts a UTC date. It must stay meaningful on a
// machine whose local time is NOT UTC — otherwise it would pass vacuously on CI
// and fail only on the founder's box. The runner therefore forces a non-UTC
// TZ (Asia/Karachi, UTC+5) for the child, which is exactly the offset that
// exposed the bug.
// =============================================================================

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
const repoRoot = path.resolve(appDir, "..");
const outDir = path.join(repoRoot, ".wave1-test-build");

const SOURCES = [
  "src/pages/trade/tvSymbol.ts",
  "src/pages/trade/expiryLabel.ts",
  "src/utils/assetDisplay.ts",
  "src/pages/trade/wave1.test.ts",
];

fs.rmSync(outDir, { recursive: true, force: true });

// Call app/'s typescript binary DIRECTLY, not `npx tsc`. The repo root has the
// unrelated `tsc` npm package installed, so `npx tsc` from repoRoot resolves to
// it and dies with "This is not the tsc command you are looking for".
// (run-epoch0-tests.mjs still uses `npx tsc` and is broken for this reason —
// reported 2026-08-04, not fixed here: not in this session's named files.)
// Run the compiler's JS entrypoint under this node, NOT the .bin shim: since
// Node 20 execFileSync refuses to spawn a .cmd without `shell:true`, and this
// repo lives under a path with a space, so shell quoting is a second trap.
const tscJs = path.join(appDir, "node_modules", "typescript", "bin", "tsc");
if (!fs.existsSync(tscJs)) {
  console.error("wave1 tests: typescript not found at", tscJs, "— run `npm i` in app/");
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
    ],
    { stdio: "inherit", cwd: repoRoot },
  );
} catch {
  console.error("wave1 tests: TypeScript compilation FAILED");
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

const testJs = find(outDir, "wave1.test.js");
if (!testJs) {
  console.error("wave1 tests: compiled test not found under", outDir);
  process.exit(1);
}

let failed = false;
try {
  execFileSync(process.execPath, [testJs], {
    stdio: "inherit",
    cwd: repoRoot,
    env: { ...process.env, TZ: "Asia/Karachi" },
  });
} catch {
  failed = true;
}

fs.rmSync(outDir, { recursive: true, force: true });
if (failed) {
  console.error("wave1 tests FAILED");
  process.exit(1);
}
console.log("wave1 tests passed");
