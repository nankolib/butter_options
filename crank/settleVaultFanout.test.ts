// ============================================================================
// crank/settleVaultFanout.test.ts — what leg 2 may and may not touch
// ============================================================================
//   run: cd crank && npx ts-node --transpile-only -r tsconfig-paths/register \
//          settleVaultFanout.test.ts
//
// The two rules that carry the most risk, and therefore the RED tests:
//
//   1. NO ORACLE-SOURCE FILTER. An earlier filter of exactly this kind hid 45
//      settleable tuples, and the absence of one is why 3,039 Switchboard
//      vaults sat unsettled while every Pyth vault settled fine. If a future
//      edit reintroduces it, the first test here fails.
//   2. ALREADY-SETTLED IS A SKIP. Both at planning time and at execution time,
//      because the founder was observed settling by hand through Utilities
//      while this was written — 75 instructions in minutes. The race is real,
//      not theoretical.
// ============================================================================

import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";

import {
  chunkTargets,
  cleanAssetName,
  FANOUT_CHUNK_SIZE,
  isAlreadySettled,
  planSettleFanout,
  VAULT_ALREADY_SETTLED_CODE,
  type FanoutMarket,
  type FanoutRecord,
  type FanoutVault,
} from "./settleVaultFanout";

const NOW = Math.floor(Date.parse("2026-08-14T09:00:00Z") / 1000);
const EXPIRED = NOW - 3600;
const FUTURE = NOW + 3600;

const mkMarket = (asset: string): FanoutMarket => ({
  publicKey: Keypair.generate().publicKey,
  account: { assetName: asset },
});
const mkVault = (
  market: FanoutMarket,
  over: Partial<FanoutVault["account"]> = {},
): FanoutVault => ({
  publicKey: Keypair.generate().publicKey,
  account: {
    market: market.publicKey,
    expiry: EXPIRED,
    isSettled: false,
    voided: false,
    ...over,
  } as FanoutVault["account"],
});
const mkRecord = (asset: string, expiry = EXPIRED): FanoutRecord => ({
  account: { assetName: asset, expiry },
});

// ===========================================================================
// 1. THE RULE THAT CAUSED THE BACKLOG
// ===========================================================================

test("RED: eligibility does NOT depend on the oracle source", () => {
  // The plan function is not even given oracle_source — it cannot filter on
  // what it cannot see. This test pins that: two identical vaults on two
  // markets both settle, and the planner's inputs carry no source field.
  const sb = mkMarket("JTO");
  const pyth = mkMarket("ORE");
  const plan = planSettleFanout({
    vaults: [mkVault(sb), mkVault(pyth)],
    markets: [sb, pyth],
    records: [mkRecord("JTO"), mkRecord("ORE")],
    nowSecs: NOW,
  });
  assert.equal(plan.targets.length, 2, "both arms must be settled by leg 2");
  assert.equal(plan.eligibleTotal, 2);
});

test("the ONLY eligibility question is whether a SettlementRecord exists", () => {
  const m = mkMarket("SOL");
  const withRec = mkVault(m);
  const withoutRec = mkVault(m, { expiry: EXPIRED - 86_400 });
  const plan = planSettleFanout({
    vaults: [withRec, withoutRec],
    markets: [m],
    records: [mkRecord("SOL", EXPIRED)], // only covers the first
    nowSecs: NOW,
  });
  assert.equal(plan.targets.length, 1);
  assert.equal(plan.targets[0].publicKey.toBase58(), withRec.publicKey.toBase58());
  assert.equal(plan.skipped["no-settlement-record"], 1);
});

// ===========================================================================
// 2. SKIPS — never attempts what cannot or need not be done
// ===========================================================================

test("RED: an already-settled vault is SKIPPED, not attempted", () => {
  // settle_vault REVERTS (VaultAlreadySettled) rather than no-opping, so an
  // attempt is a wasted transaction that also kills its batch-mates.
  const m = mkMarket("BTC");
  const plan = planSettleFanout({
    vaults: [mkVault(m, { isSettled: true })],
    markets: [m],
    records: [mkRecord("BTC")],
    nowSecs: NOW,
  });
  assert.equal(plan.targets.length, 0);
  assert.equal(plan.skipped["already-settled"], 1);
});

test("RED: a vault on an UNSETTLED tuple is never attempted", () => {
  const m = mkMarket("MSTR");
  const plan = planSettleFanout({
    vaults: [mkVault(m)],
    markets: [m],
    records: [], // phase 1 never ran — the 'dark' family
    nowSecs: NOW,
  });
  assert.equal(plan.targets.length, 0);
  assert.equal(plan.skipped["no-settlement-record"], 1);
});

test("a voided vault is never settled", () => {
  const m = mkMarket("XAG");
  const plan = planSettleFanout({
    vaults: [mkVault(m, { voided: true })],
    markets: [m], records: [mkRecord("XAG")], nowSecs: NOW,
  });
  assert.equal(plan.targets.length, 0);
  assert.equal(plan.skipped.voided, 1);
});

test("an unexpired vault is never settled", () => {
  const m = mkMarket("ETH");
  const plan = planSettleFanout({
    vaults: [mkVault(m, { expiry: FUTURE })],
    markets: [m], records: [mkRecord("ETH", FUTURE)], nowSecs: NOW,
  });
  assert.equal(plan.targets.length, 0);
  assert.equal(plan.skipped["not-expired"], 1);
});

test("a vault whose market we cannot resolve is skipped, not crashed on", () => {
  const known = mkMarket("XRP");
  const orphan = mkVault({ publicKey: Keypair.generate().publicKey, account: { assetName: "GONE" } });
  const plan = planSettleFanout({
    vaults: [orphan], markets: [known], records: [mkRecord("GONE")], nowSecs: NOW,
  });
  assert.equal(plan.targets.length, 0);
  assert.equal(plan.skipped["unknown-market"], 1);
});

// ===========================================================================
// 3. ORDER + THROTTLE
// ===========================================================================

test("oldest expiry first — the tail must not starve", () => {
  // Current-first ordering is how the July backlog formed: new expiries kept
  // arriving and the old ones were never reached.
  const m = mkMarket("WIF");
  const old1 = mkVault(m, { expiry: EXPIRED - 30 * 86_400 });
  const mid = mkVault(m, { expiry: EXPIRED - 7 * 86_400 });
  const newest = mkVault(m, { expiry: EXPIRED });
  const plan = planSettleFanout({
    vaults: [newest, old1, mid],
    markets: [m],
    records: [
      mkRecord("WIF", EXPIRED - 30 * 86_400),
      mkRecord("WIF", EXPIRED - 7 * 86_400),
      mkRecord("WIF", EXPIRED),
    ],
    nowSecs: NOW,
  });
  assert.deepEqual(
    plan.targets.map((t) => t.publicKey.toBase58()),
    [old1, mid, newest].map((t) => t.publicKey.toBase58()),
  );
});

test("the per-tick ceiling caps work but still reports the true backlog", () => {
  const m = mkMarket("BONK");
  const vaults = Array.from({ length: 40 }, () => mkVault(m));
  const plan = planSettleFanout({
    vaults, markets: [m], records: [mkRecord("BONK")], nowSecs: NOW, maxPerTick: 10,
  });
  assert.equal(plan.targets.length, 10, "capped");
  assert.equal(plan.eligibleTotal, 40, "but the real depth is still reported");
});

test("same-tuple vaults are adjacent so a batch shares their accounts", () => {
  // A mixed batch of 5 measured 1241 bytes and was rejected. Grouping restores
  // account sharing; without it the fan-out cannot fit a transaction.
  const a = mkMarket("AAA"), b = mkMarket("BBB");
  const vaults = [mkVault(a), mkVault(b), mkVault(a), mkVault(b)];
  const plan = planSettleFanout({
    vaults, markets: [a, b], records: [mkRecord("AAA"), mkRecord("BBB")], nowSecs: NOW,
  });
  const mk = plan.targets.map((t) => t.account.market.toBase58());
  assert.equal(mk[0], mk[1], "first two share a market");
  assert.equal(mk[2], mk[3], "last two share a market");
  assert.notEqual(mk[0], mk[2], "and the two groups are distinct");
});

test("chunking matches the transaction batch size", () => {
  const items = Array.from({ length: 12 }, (_, i) => i);
  const chunks = chunkTargets(items, FANOUT_CHUNK_SIZE);
  assert.equal(chunks.length, 3);
  assert.deepEqual(chunks[0], [0, 1, 2, 3]);
  assert.deepEqual(chunks[2], [8, 9, 10, 11]);
  assert.deepEqual(chunkTargets([], 5), []);
  assert.throws(() => chunkTargets([1], 0));
});

// ===========================================================================
// 4. THE RACE — already-settled at EXECUTION time
// ===========================================================================

test("RED: a concurrent settle is recognised as a SKIP, not a failure", () => {
  // Observed live: the founder settling by hand through Utilities while the
  // crank scans. Pre-filtering narrows this window; it cannot close it.
  assert.equal(isAlreadySettled("custom program error: 0x1783"), true);
  assert.equal(isAlreadySettled(new Error("... Error Number: 6019 ...")), true);
  assert.equal(isAlreadySettled("AnchorError ... VaultAlreadySettled ..."), true);
  assert.equal(VAULT_ALREADY_SETTLED_CODE, 6019);
});

test("other failures are NOT mistaken for a benign skip", () => {
  for (const other of [
    "custom program error: 0x1784",            // 6020, a different error
    "custom program error: 0x1",               // token program
    "Error Number: 6056",                      // VaultVoided
    "blockhash not found",
    "",
  ]) {
    assert.equal(isAlreadySettled(other), false, other);
  }
});

test("asset names compare equal across on-chain padding", () => {
  assert.equal(cleanAssetName("JTO\0\0\0\0"), "JTO");
  assert.equal(cleanAssetName("JTO   "), "JTO");
  assert.equal(cleanAssetName(Buffer.from("SOL\0\0")), "SOL");
});

test("a padded record still matches its market", () => {
  const m: FanoutMarket = {
    publicKey: Keypair.generate().publicKey,
    account: { assetName: "JTO\0\0\0" },
  };
  const plan = planSettleFanout({
    vaults: [mkVault(m)],
    markets: [m],
    records: [{ account: { assetName: "JTO   ", expiry: EXPIRED } }],
    nowSecs: NOW,
  });
  assert.equal(plan.targets.length, 1, "padding must not break the tuple match");
});
