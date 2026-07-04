// ============================================================================
// Prebuild secret-scan gate  (H-04)
// ============================================================================
// Fails the build if app/src re-introduces a bundled signing key. Wired to the
// package.json "prebuild" script, which npm runs automatically before "build"
// (`tsc -b && vite build`). Because Vercel's build command is `npm run build`,
// this gate runs on every Vercel build with no extra config.
//
// Patterns flagged (any occurrence in app/src/**.{ts,tsx,js,jsx,mjs,cjs}):
//   - DEVNET_FAUCET_KEYPAIR       (the old bundled key symbol / any mention)
//   - Keypair.fromSecretKey(...)  (loading a secret into a signer client-side)
//   - Uint8Array.from([ ...32+ numeric bytes... ])  (an inlined key literal)
//
// Secrets belong in server-only env vars (see app/api/faucet.ts), never in the
// client bundle. To prove the gate has teeth: temporarily add one of the above
// to any app/src file and run `npm run build` — it must exit 1.
// ============================================================================

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

const PATTERNS = [
  { name: "DEVNET_FAUCET_KEYPAIR reference", re: /DEVNET_FAUCET_KEYPAIR/ },
  { name: "Keypair.fromSecretKey call", re: /Keypair\.fromSecretKey/ },
  {
    name: "inlined byte-array secret literal (Uint8Array.from with 32+ bytes)",
    re: /Uint8Array\.from\(\s*\[(?:\s*\d{1,3}\s*,){31,}/,
  },
];

const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const offenders = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      walk(p);
      continue;
    }
    if (!CODE_EXT.test(entry)) continue;
    const text = readFileSync(p, "utf8");
    for (const { name, re } of PATTERNS) {
      if (re.test(text)) offenders.push(`${p} — ${name}`);
    }
  }
}

walk(SRC);

if (offenders.length > 0) {
  console.error("\n✖ Bundled-secret gate FAILED (H-04). Signing keys must never ship in the client bundle:\n");
  for (const o of offenders) console.error("  - " + o);
  console.error("\nMove the secret to a server-only env var (see app/api/faucet.ts) and try again.\n");
  process.exit(1);
}

console.log("✔ Bundled-secret gate passed — no signing keys in app/src.");
