// R-SPLIT: the focus read is AUTHORITATIVE, not best-effort.
//   run (from crank/): node node_modules/ts-node/dist/bin.js --transpile-only \
//                      -r tsconfig-paths/register authoritativeSeries.test.ts
//
// The grid renders from an index; the ticket signs transactions. Index rows
// carry the vault and optionMint that go straight into accountsStrict, so before
// any assembly the series is re-read chain-direct and the row is checked against
// it.
//
// Every test here asserts the SAME property from a different angle: nothing
// unverified may return ok. A false negative costs a retry; a false positive is
// a transaction built against an address nobody checked.
import { test } from "node:test";
import assert from "node:assert/strict";

import { verifyIdentity } from "@app/utils/authoritativeSeries";

const ROW = { vault: "Vau1t111111111111111111111111111111111111111", optionMint: "M1nt1111111111111111111111111111111111111111" };
const CHAIN_OK = { vaultExists: true, optionMint: ROW.optionMint };

test("a row confirmed by chain is accepted, and returns the CHAIN's mint", () => {
  const v = verifyIdentity(ROW, CHAIN_OK);
  assert.equal(v.ok, true);
  assert.equal(v.ok && v.optionMint, ROW.optionMint);
});

// ---------------------------------------------------------------------------
// THE RED TEST: a poisoned index row must block the ticket
// ---------------------------------------------------------------------------

test("RED: a poisoned row (chain backs a DIFFERENT mint) is refused", () => {
  // The attack/corruption case the whole focus read exists for: the board offers
  // one series, the chain backs another. Building here would sign against an
  // address that came from a cache.
  const v = verifyIdentity(ROW, { vaultExists: true, optionMint: "0ther111111111111111111111111111111111111111" });
  assert.equal(v.ok, false, "a mismatched mint MUST block");
  assert.match(v.ok === false ? v.reason : "", /do not match/i);
});

test("RED: a failed or timed-out read is refused, never waved through", () => {
  // null means the read did not happen. The point of reading was that the row
  // might be wrong, so an unread row is exactly as untrusted as a wrong one.
  const v = verifyIdentity(ROW, null);
  assert.equal(v.ok, false, "an unverified row must never build");
  assert.match(v.ok === false ? v.reason : "", /nothing was submitted/i);
});

test("RED: a vault that no longer exists on-chain is refused", () => {
  const v = verifyIdentity(ROW, { vaultExists: false, optionMint: null });
  assert.equal(v.ok, false);
  assert.match(v.ok === false ? v.reason : "", /no longer exists/i);
});

test("RED: a vault with no resolvable series record is refused", () => {
  const v = verifyIdentity(ROW, { vaultExists: true, optionMint: null });
  assert.equal(v.ok, false, "no series means nothing to verify against");
});

test("RED: a row missing its own identity fields is refused", () => {
  for (const bad of [{ vault: "", optionMint: ROW.optionMint },
                     { vault: ROW.vault, optionMint: "" },
                     {} as never, null as never]) {
    assert.equal(verifyIdentity(bad as never, CHAIN_OK).ok, false);
  }
});

test("there is NO input that returns ok without a chain-confirmed match", () => {
  // Belt on the whole contract: enumerate the failure shapes and assert none of
  // them can produce ok:true. If someone later adds a "trust the row when the
  // read fails" convenience, this fails.
  const chains = [null, { vaultExists: false, optionMint: null },
                  { vaultExists: true, optionMint: null },
                  { vaultExists: true, optionMint: "wrong111111111111111111111111111111111111111" }];
  for (const c of chains) {
    assert.equal(verifyIdentity(ROW, c as never).ok, false, `chain=${JSON.stringify(c)} must not build`);
  }
  assert.equal(verifyIdentity(ROW, CHAIN_OK).ok, true, "and the confirmed case still works");
});

test("every refusal carries a reason a user can act on", () => {
  for (const c of [null, { vaultExists: false, optionMint: null }, { vaultExists: true, optionMint: "x" }]) {
    const v = verifyIdentity(ROW, c as never);
    assert.equal(v.ok, false);
    const reason = v.ok === false ? v.reason : "";
    assert.ok(reason.length > 20, "a blocked ticket must say WHY, not just fail");
    assert.ok(!/undefined|null|Error:/.test(reason), "and must not leak internals");
  }
});
