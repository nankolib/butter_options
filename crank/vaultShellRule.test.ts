// ============================================================================
// crank/vaultShellRule.test.ts — the Monday equity-migration hard-blocker gate.
// Run: npx ts-node --transpile-only crank/vaultShellRule.test.ts   (node:test)
// ============================================================================
// The lead test reproduces EWwhESru's real state (a settled/void husk whose $246
// lives in its writer-ask POT + a real on-curve wallet HOLDER, DnExEYnZ). The
// original cutover shell rule classified it as an empty shell — the exact bug
// that must be flagged before any equity close_market. This test MUST fail
// against the old rule and pass against the hardened one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyVaultShell, VaultShellInput } from "./vaultShellRule";

const EMPTY: VaultShellInput = {
  vaultUsdc: 0n, potUsdc: 0n, userHolders: 0, protocolHolders: 0,
  writers: 0, backers: 0, staleTotalCollateral: 0n, staleTotalShares: 0n,
};

// ---- THE BLOCKER: EWwhESru must NOT be a shell -----------------------------
test("EWwhESru repro: pot-USDC + on-curve wallet holder ⇒ NON-shell, user claim", () => {
  const ewwhesru: VaultShellInput = {
    ...EMPTY,
    potUsdc: 246_000_000n, // $246 in writer_ask_pot_usdc — SharedVault fields are all 0
    userHolders: 1,        // DnExEYnZ (on-curve wallet) holds contracts
    backers: 1,            // founder's resting ask backs the pot
  };
  const v = classifyVaultShell(ewwhesru);
  assert.equal(v.isShell, false, "a pot-funded, holder-bearing vault is NOT an orphanable shell");
  assert.equal(v.hasUserClaim, true, "an on-curve wallet holder is a real external claim");
});

// ---- pot-only (no holder) still blocks -------------------------------------
test("pot-USDC only (no holder) ⇒ NON-shell", () => {
  const v = classifyVaultShell({ ...EMPTY, potUsdc: 70_000_000n });
  assert.equal(v.isShell, false);
});

// ---- PDA-vs-wallet: protocol-escrowed holder is non-shell but NOT a user claim
test("protocol-PDA holder (escrow) ⇒ NON-shell but hasUserClaim=false", () => {
  const v = classifyVaultShell({ ...EMPTY, protocolHolders: 1 });
  assert.equal(v.isShell, false, "protocol-escrowed tokens are still real → discharge, don't orphan");
  assert.equal(v.hasUserClaim, false, "an off-curve PDA owner is the protocol, not a user");
});

// ---- writers / backers block ------------------------------------------------
test("pool writer shares>0 ⇒ NON-shell", () => {
  assert.equal(classifyVaultShell({ ...EMPTY, writers: 1 }).isShell, false);
});
test("ask backer committed>0 ⇒ NON-shell", () => {
  assert.equal(classifyVaultShell({ ...EMPTY, backers: 1 }).isShell, false);
});

// ---- vault_usdc still blocks (unchanged from old rule) ----------------------
test("vault_usdc>0 ⇒ NON-shell", () => {
  assert.equal(classifyVaultShell({ ...EMPTY, vaultUsdc: 5n }).isShell, false);
});

// ---- preflight parity: stale total_collateral alone is INERT ---------------
test("stale total_collateral>0 with $0 funds and no positions ⇒ SHELL (parity w/ preflight)", () => {
  const v = classifyVaultShell({ ...EMPTY, staleTotalCollateral: 999_000_000n, staleTotalShares: 999n });
  assert.equal(v.isShell, true, "tc is a stale counter — must not force a false non-shell");
});

// ---- genuinely empty ⇒ SHELL -----------------------------------------------
test("empty on every axis ⇒ SHELL (orphanable)", () => {
  const v = classifyVaultShell(EMPTY);
  assert.equal(v.isShell, true);
  assert.equal(v.hasUserClaim, false);
});
