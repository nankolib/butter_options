// Copy the Anchor IDL into the writer's own tree so `dist/` is self-contained on
// the VPS (no dependency on app/src/ being present at /opt/opta-writer). Runs as
// the postbuild step (see package.json "build"). OPTA_WRITER_IDL overrides the
// runtime path; this copy is the default fallback resolved in src/env.ts.
const fs = require("fs");
const path = require("path");

const src = path.resolve(__dirname, "../../app/src/idl/opta.json");
const dstDir = path.resolve(__dirname, "../idl");
const dst = path.join(dstDir, "opta.json");

if (!fs.existsSync(src)) {
  console.error(`copy-idl: source IDL not found at ${src} — build cannot self-contain the IDL.`);
  process.exit(1);
}
fs.mkdirSync(dstDir, { recursive: true });
fs.copyFileSync(src, dst);
console.log(`copy-idl: ${src} -> ${dst}`);
