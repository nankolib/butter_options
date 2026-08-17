// Safety tests for the persistent finalize cache (D1, ticket 86eyn66b4).
//
//   run: npx ts-node --transpile-only crank/finalizeCache.test.ts
//
// WHY THIS FILE EXISTS
//   The finalize sweep re-scanned 6,215 vaults on 2026-08-15 and sent zero
//   transactions, because `fullyFinalized` was an in-memory Set that every crank
//   restart threw away. Making it durable is the credit fix — but durability
//   removes the accidental safety net that a restart provided. Before this
//   change, a wrongly-cached vault self-healed on the next restart. After it, a
//   wrong entry is forever.
//
//   So the ONLY thing that matters here is the inverse property: a persisted
//   entry must never be able to suppress a scan of a vault that could still owe
//   somebody money. These tests are written to fail loudly if it can.
//
// THE PROTECTED FIXTURE
//   Vaults 6tq9Ueck / 9CzbiMii / 3k5vHJLh are named in dated verification
//   86eyn5kx8 (2026-08-28). Their on-chain state was measured 2026-08-17:
//       is_settled=false, collateral_remaining=0, expiry=1787904000 (2026-08-28)
//   Note they are UNSETTLED and expire on the verification date, so they are not
//   even reached by today's sweep (bot.ts gates on isSettled first). The
//   assertion below is therefore deliberately STRONGER than "in scope": the gate
//   must refuse to suppress them in every state they can legally reach —
//   unsettled now, and settled-and-payable after 2026-08-28.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  entryMaySuppressScan,
  DEFAULT_MAX_ENTRY_AGE_SEC,
  type DoneEntry,
  type VaultGateState,
} from "./finalizeCache";

const NOW = 1_787_000_000;
const fresh = (): DoneEntry => ({ markedAtSec: NOW - 60 });

// Measured state of the three vaults under dated verification 86eyn5kx8.
const PROTECTED: ReadonlyArray<{ key: string; state: VaultGateState }> = [
  {
    key: "6tq9Ueck1F7d9y1n3v9c6NbU5mhxTXshHKkR8y6YZ83V",
    state: { isSettled: false, collateralRemaining: 0n },
  },
  {
    key: "9CzbiMiiuvXd6UpBabbifnQLJiQ3jJGkBasCGX5YyCgt",
    state: { isSettled: false, collateralRemaining: 0n },
  },
  {
    key: "3k5vHJLh42syDK9hhbwF3PMRHn3TvMgzWCPkYL5mceAV",
    state: { isSettled: false, collateralRemaining: 0n },
  },
];

// ---------------------------------------------------------------------------
// The property that gates the ship: payable vaults are never suppressed.
// ---------------------------------------------------------------------------

test("a vault with collateral remaining is NEVER suppressed, even if cached", () => {
  const payable: VaultGateState = { isSettled: true, collateralRemaining: 1n };
  assert.equal(
    entryMaySuppressScan(fresh(), payable, NOW, DEFAULT_MAX_ENTRY_AGE_SEC),
    false,
    "a cached entry must not suppress a vault that still holds collateral",
  );
});

test("an UNSETTLED vault is NEVER suppressed, even if cached", () => {
  const unsettled: VaultGateState = { isSettled: false, collateralRemaining: 0n };
  assert.equal(
    entryMaySuppressScan(fresh(), unsettled, NOW, DEFAULT_MAX_ENTRY_AGE_SEC),
    false,
    "an unsettled vault can still gain collateral before expiry; never suppress it",
  );
});

test("the three vaults under dated verification 86eyn5kx8 are never suppressed", () => {
  for (const { key, state } of PROTECTED) {
    // Even with a deliberately pre-seeded cache entry — the exact accident this
    // guard exists to survive.
    assert.equal(
      entryMaySuppressScan(fresh(), state, NOW, DEFAULT_MAX_ENTRY_AGE_SEC),
      false,
      `${key} must remain in scope (measured: unsettled, collateral_remaining=0)`,
    );
  }
});

test("the protected vaults stay in scope once settled WITH collateral (post 2026-08-28)", () => {
  // After expiry they settle. If a writer deposited in the meantime they become
  // payable, which is precisely the scenario the dated verification guards.
  for (const { key } of PROTECTED) {
    const settledPayable: VaultGateState = {
      isSettled: true,
      collateralRemaining: 250_000n,
    };
    assert.equal(
      entryMaySuppressScan(fresh(), settledPayable, NOW, DEFAULT_MAX_ENTRY_AGE_SEC),
      false,
      `${key} must remain in scope once settled and payable`,
    );
  }
});

// ---------------------------------------------------------------------------
// The saving itself has to work, or the change is pointless.
// ---------------------------------------------------------------------------

test("a settled, fully-drained vault IS suppressed (this is the credit saving)", () => {
  const drained: VaultGateState = { isSettled: true, collateralRemaining: 0n };
  assert.equal(
    entryMaySuppressScan(fresh(), drained, NOW, DEFAULT_MAX_ENTRY_AGE_SEC),
    true,
    "settled with zero collateral remaining is terminal; skipping it is the point",
  );
});

test("no cache entry means always scan", () => {
  const drained: VaultGateState = { isSettled: true, collateralRemaining: 0n };
  assert.equal(
    entryMaySuppressScan(undefined, drained, NOW, DEFAULT_MAX_ENTRY_AGE_SEC),
    false,
    "absence of an entry must never be read as permission to skip",
  );
});

// ---------------------------------------------------------------------------
// Periodic revalidation — restores the self-healing that restarts used to give.
// ---------------------------------------------------------------------------

test("a stale entry is not trusted, so the gate self-heals over time", () => {
  const drained: VaultGateState = { isSettled: true, collateralRemaining: 0n };
  const old: DoneEntry = { markedAtSec: NOW - DEFAULT_MAX_ENTRY_AGE_SEC - 1 };
  assert.equal(
    entryMaySuppressScan(old, drained, NOW, DEFAULT_MAX_ENTRY_AGE_SEC),
    false,
    "entries must expire so a wrong one cannot suppress a vault forever",
  );
});

test("an entry exactly at the age limit is still trusted (boundary)", () => {
  const drained: VaultGateState = { isSettled: true, collateralRemaining: 0n };
  const edge: DoneEntry = { markedAtSec: NOW - DEFAULT_MAX_ENTRY_AGE_SEC };
  assert.equal(
    entryMaySuppressScan(edge, drained, NOW, DEFAULT_MAX_ENTRY_AGE_SEC),
    true,
  );
});

test("a future-dated entry is rejected rather than trusted forever", () => {
  // Clock skew or a hand-edited file must not mint an immortal entry.
  const drained: VaultGateState = { isSettled: true, collateralRemaining: 0n };
  const future: DoneEntry = { markedAtSec: NOW + 86_400 };
  assert.equal(
    entryMaySuppressScan(future, drained, NOW, DEFAULT_MAX_ENTRY_AGE_SEC),
    false,
    "a markedAtSec in the future is corrupt input, not a fresh entry",
  );
});

test("a malformed entry is rejected", () => {
  const drained: VaultGateState = { isSettled: true, collateralRemaining: 0n };
  for (const bad of [
    {} as DoneEntry,
    { markedAtSec: NaN } as DoneEntry,
    { markedAtSec: -1 } as DoneEntry,
    { markedAtSec: "x" as unknown as number } as DoneEntry,
  ]) {
    assert.equal(
      entryMaySuppressScan(bad, drained, NOW, DEFAULT_MAX_ENTRY_AGE_SEC),
      false,
      `malformed entry ${JSON.stringify(bad)} must not suppress a scan`,
    );
  }
});
