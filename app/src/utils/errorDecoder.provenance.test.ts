// =============================================================================
// errorDecoder.provenance.test.ts — no on-chain error may name a price vendor
// =============================================================================
//   run: node app/scripts/run-tx-failure-tests.mjs
//
// WHY THIS IS A TEST AND NOT A CODE REVIEW.
//
// The decoder's copy comes from the IDL, which comes from errors.rs, which is
// written for engineers reading a stack trace. 20 of 84 variants named a price
// vendor or an internal oracle mechanism, and every one of them could reach a
// toast. FRIENDLY_OVERRIDES covers them today — but the leak arrives via an IDL
// REFRESH, which is a routine, unreviewed-for-copy operation. A new
// `#[msg("Switchboard ...")]` in Rust would silently reintroduce it.
//
// So the invariant is asserted over the WHOLE error table, not the 20 known
// variants: every code the IDL defines must render vendor-free.
// =============================================================================

import assert from "node:assert/strict";
import { test } from "node:test";

import idl from "../idl/opta.json";
import { decodeError } from "./errorDecoder";

const VENDOR = /pyth|switchboard|hermes|crossbar|ed25519|vol\s*oracle|voloracle|slothash/i;

test("NO on-chain error renders copy that names a price vendor", () => {
  const errors = (idl as any).errors as Array<{ code: number; name: string; msg: string }>;
  assert.ok(errors.length > 50, "IDL should carry the full error table");

  const leaks: string[] = [];
  for (const e of errors) {
    const rendered = decodeError(new Error(`custom program error: 0x${e.code.toString(16)}`));
    if (VENDOR.test(rendered)) leaks.push(`${e.code} ${e.name} -> ${rendered}`);
  }
  assert.deepEqual(leaks, [], `vendor names reached user copy:\n  ${leaks.join("\n  ")}`);
});

test("the IDL itself still contains vendor names — the overrides are load-bearing", () => {
  // If this ever fails, errors.rs was cleaned up and the overrides may be
  // removable. Until then, deleting them re-opens the leak.
  const errors = (idl as any).errors as Array<{ msg: string }>;
  const named = errors.filter((e) => VENDOR.test(e.msg ?? ""));
  assert.ok(
    named.length > 0,
    "expected raw IDL messages to still name vendors; if not, revisit FRIENDLY_OVERRIDES",
  );
});

test("the specific error the exercise path produces is neutral", () => {
  // 6061 SwitchboardVerifyFailed — a stale price quote, the single most likely
  // failure a real user hits on early exercise.
  assert.equal(
    decodeError(new Error("custom program error: 0x17ad")),
    "Price unavailable — try again.",
  );
});
