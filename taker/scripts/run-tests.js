// Run every colocated *.test.ts under src/ with node:test via ts-node.
// Mirrors the writer/ convention (node:test + assert/strict, transpile-only).
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const files = walk(path.resolve(__dirname, "../src")).sort();
if (files.length === 0) {
  console.error("no test files found");
  process.exit(1);
}
console.log(`running ${files.length} test file(s)`);
let failed = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ["--require", "ts-node/register/transpile-only", f], {
      stdio: "inherit",
      cwd: path.resolve(__dirname, ".."),
      env: { ...process.env, TS_NODE_TRANSPILE_ONLY: "true" },
    });
  } catch {
    failed += 1;
  }
}
if (failed > 0) {
  console.error(`${failed} test file(s) FAILED`);
  process.exit(1);
}
console.log("all test files passed");
