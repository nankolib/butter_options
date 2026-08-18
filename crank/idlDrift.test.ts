// IDL drift guard — 2B item 5.
//
//   run: node crank/node_modules/ts-node/dist/bin.js --transpile-only crank/idlDrift.test.ts
//
// WHY THIS EXISTS
//   On 2026-08-18, at the 2A upgrade, the four tracked IDL copies were found to
//   have drifted to THREE DIFFERENT VINTAGES:
//
//       app/src/idl/opta.json      50 instructions, 86 errors
//       crank/idl/opta.json        51 instructions, 86 errors
//       mobile/src/idl/opta.json   51 instructions, 79 errors
//       target/idl/opta.json       51 instructions, 91 errors   <- the real program
//
//   Not formatting differences. Three approximations of one program, each wrong in
//   a different way, and nothing anywhere compared them. Anchor builds an
//   instruction's account list FROM THE IDL and silently drops accounts the IDL
//   does not declare, so a stale copy does not fail loudly — it emits a short
//   transaction and the failure surfaces on chain, after a fee and possibly after
//   a wallet signature.
//
//   This test makes that failure structurally unrepeatable: every tracked copy must
//   be byte-identical to every other, and to the built artifact when one is
//   present. It is cheap, it is offline, and it runs before a push.
//
// WHAT IT DELIBERATELY DOES NOT DO
//   It does not compare app/src/idl/opta.ts to the JSON. That file is Anchor's
//   generated TS type (camelCase) rather than the same document in another form,
//   so a byte comparison is meaningless. It IS compared to target/types/opta.ts,
//   which is the file it is copied from.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";

const ROOT = path.resolve(__dirname, "..");

/** Tracked copies. Every one of these ships and must describe the same program. */
const TRACKED_JSON = [
  "app/src/idl/opta.json",
  "crank/idl/opta.json",
  "mobile/src/idl/opta.json",
];

/** The build output — the only one derived directly from the program source. */
const BUILT_JSON = "target/idl/opta.json";
const BUILT_TS = "target/types/opta.ts";
const TRACKED_TS = "app/src/idl/opta.ts";

const sha = (p: string) =>
  crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, p))).digest("hex");

const here = (p: string) => fs.existsSync(path.join(ROOT, p));

function shape(p: string): string {
  const d = JSON.parse(fs.readFileSync(path.join(ROOT, p), "utf8"));
  return `${d.instructions?.length ?? "?"} ix, ${(d.errors ?? []).length} errors`;
}

test("every tracked IDL copy is byte-identical to the others", () => {
  const present = TRACKED_JSON.filter(here);
  assert.ok(present.length >= 2, `expected multiple tracked IDLs, found ${present.length}`);

  const hashes = present.map((p) => ({ p, h: sha(p), s: shape(p) }));
  const distinct = new Set(hashes.map((x) => x.h));

  if (distinct.size !== 1) {
    const detail = hashes.map((x) => `    ${x.p.padEnd(28)} ${x.h.slice(0, 16)}  (${x.s})`).join("\n");
    assert.fail(
      `IDL DRIFT — ${distinct.size} distinct versions across ${hashes.length} tracked copies:\n${detail}\n` +
        `  Fix: rebuild (anchor build), then copy target/idl/opta.json over EVERY path above.\n` +
        `  A partial sync is what produced the three-vintage drift this test exists to prevent.`,
    );
  }
});

test("tracked IDLs match the built artifact, when one is present", () => {
  if (!here(BUILT_JSON)) {
    // Loud skip, not a silent pass: a fresh clone has no target/, and a green
    // here would otherwise mean "nothing was checked".
    console.log(
      `  NOTE: ${BUILT_JSON} absent (no local build) — the tracked copies were ` +
        `compared to each other but NOT to the program source. Run anchor build ` +
        `for the full check.`,
    );
    return;
  }
  const built = sha(BUILT_JSON);
  for (const p of TRACKED_JSON.filter(here)) {
    assert.equal(
      sha(p),
      built,
      `${p} does not match the built IDL.\n` +
        `    ${p.padEnd(28)} ${sha(p).slice(0, 16)}  (${shape(p)})\n` +
        `    ${BUILT_JSON.padEnd(28)} ${built.slice(0, 16)}  (${shape(BUILT_JSON)})\n` +
        `  The built artifact is the source of truth — it is generated from the program.`,
    );
  }
});

test("the generated TS type matches the one it is copied from", () => {
  if (!here(BUILT_TS) || !here(TRACKED_TS)) {
    console.log("  NOTE: TS type comparison skipped (no local build)");
    return;
  }
  assert.equal(
    sha(TRACKED_TS),
    sha(BUILT_TS),
    `${TRACKED_TS} is stale against ${BUILT_TS}. Copy it across; the JSON and the ` +
      `TS type are synced together or not at all.`,
  );
});

test("the guard can actually detect drift (self-check)", () => {
  // A test that only ever compares identical files proves nothing about its own
  // ability to notice a difference. Hash two known-different byte strings through
  // the same primitive the assertions use.
  const a = crypto.createHash("sha256").update(Buffer.from("idl-a")).digest("hex");
  const b = crypto.createHash("sha256").update(Buffer.from("idl-b")).digest("hex");
  assert.notEqual(a, b, "the hash primitive must distinguish different content");
});
