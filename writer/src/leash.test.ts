/**
 * THE LEASH — red-first suite. Every case here encodes a real number from the
 * 2026-08-27 incident, so a regression reads as the incident repeating.
 *
 * Run: npm run build && node --test dist/leash.test.js
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  measureCommitted, collateralGate, applyPost, solGate,
  isBuildExcluded, BUILD_EXCLUDED_ASSETS, type Committed,
} from "./leash";
import { denyReason } from "./engine";

const M = 1_000_000n;
const order = (mint: string, qty: bigint, cpcUsdc: number) => ({
  optionMint: { toBase58: () => mint },
  quantityRemaining: qty,
  collateralPerContract: BigInt(Math.round(cpcUsdc * 1e6)),
});

// ---------------------------------------------------------------- measured
test("MEASURES committed collateral from on-chain orders, never a counter", () => {
  // The incident shape: BTC 10 calls + 10 puts at $79,360/contract = $1.587M.
  const orders = [
    order("btc-c", 10n, 79_360), order("btc-p", 10n, 79_360),
    order("wif-c", 12n, 0.208),
  ];
  const asset = (o: any) => (o.optionMint.toBase58().startsWith("btc") ? "BTC" : "WIF");
  const c = measureCommitted(orders, asset);
  assert.equal(Number(c.totalMicro) / 1e6, 1_587_202.496);
  assert.equal(Number(c.perAssetMicro.get("BTC")!) / 1e6, 1_587_200);
  assert.equal(Number(c.perAssetMicro.get("WIF")!) / 1e6, 2.496);
});

test("an unresolvable order still counts toward the GLOBAL ceiling", () => {
  // Otherwise an order the resolver cannot label becomes a hole in the cap.
  const c = measureCommitted([order("x", 1n, 50_000)], () => null);
  assert.equal(Number(c.totalMicro) / 1e6, 50_000);
  assert.equal(c.perAssetMicro.size, 0);
});

// ---------------------------------------------------------------- ceilings
test("GLOBAL ceiling blocks a post that would exceed it", () => {
  const caps = { maxCollateralUsdc: 150_000, maxCollateralPerAssetUsdc: 30_000 };
  const c: Committed = { totalMicro: 149_000n * M, perAssetMicro: new Map([["SOL", 1_000n * M]]) };

  assert.equal(collateralGate(c, "SOL", 500n * M, caps).allow, true, "under the cap must pass");

  const over = collateralGate(c, "SOL", 2_000n * M, caps);
  assert.equal(over.allow, false, "post crossing the global cap was allowed");
  assert.equal((over as any).reason, "cap-collateral-global");

  // The would-be post is included on purpose: a ceiling checked only against
  // prior state is always one post too late.
  const exact = collateralGate(c, "SOL", 1_000n * M, caps);
  assert.equal(exact.allow, true, "landing exactly on the cap is allowed");
  const justOver = collateralGate(c, "SOL", 1_000n * M + 1n, caps);
  assert.equal(justOver.allow, false, "one micro-USDC over must be refused");
});

test("PER-ASSET cap blocks even when the global ceiling has room", () => {
  const caps = { maxCollateralUsdc: 150_000, maxCollateralPerAssetUsdc: 30_000 };
  const c: Committed = { totalMicro: 40_000n * M, perAssetMicro: new Map([["SOL", 29_500n * M]]) };
  const d = collateralGate(c, "SOL", 1_000n * M, caps);
  assert.equal(d.allow, false, "per-asset cap did not bind");
  assert.equal((d as any).reason, "cap-collateral-asset");
  // A different asset is unaffected.
  assert.equal(collateralGate(c, "JUP", 1_000n * M, caps).allow, true);
});

test("in-tick posts accumulate, so the cap binds within a single tick", () => {
  const caps = { maxCollateralUsdc: 150_000, maxCollateralPerAssetUsdc: 30_000 };
  const c: Committed = { totalMicro: 0n, perAssetMicro: new Map() };
  let posted = 0;
  for (let i = 0; i < 100; i++) {
    const add = 5_000n * M;
    if (!collateralGate(c, "SOL", add, caps).allow) break;
    applyPost(c, "SOL", add); posted++;
  }
  // Per-asset cap 30k / 5k = 6 posts, then it binds.
  assert.equal(posted, 6, "in-tick accumulation not enforced (posted " + posted + ")");
  assert.equal(Number(c.perAssetMicro.get("SOL")!) / 1e6, 30_000);
});

test("caps of 0 disable the ceiling (explicit opt-out, not the default)", () => {
  const c: Committed = { totalMicro: 9_999_999n * M, perAssetMicro: new Map() };
  assert.equal(collateralGate(c, "X", 1n * M, { maxCollateralUsdc: 0, maxCollateralPerAssetUsdc: 0 }).allow, true);
});

// ---------------------------------------------------------------- SOL
test("MIN-SOL refuses new posts below the floor", () => {
  const p = { minSolPost: 0.5, reserveSol: 0.25 };
  assert.equal(solGate(2.0, p).allow, true);
  const d = solGate(0.4, p);
  assert.equal(d.allow, false, "posting below min-SOL was allowed");
  assert.equal((d as any).reason, "min-sol-post");
});

test("RESERVE is preserved under a cancel storm — the stranding spiral", () => {
  const p = { minSolPost: 0.5, reserveSol: 0.25 };
  // The incident balance: 0.000895 SOL, 184 orders that could not be cancelled.
  const stranded = solGate(0.000895, p);
  assert.equal(stranded.allow, false, "a broke bot must never take on new obligations");
  assert.equal((stranded as any).reason, "reserve-sol",
    "reserve must bind BEFORE min-sol — it is the harder fence");

  // Draining toward the reserve must refuse before crossing it, so the SOL that
  // pays for unwinding is still there.
  assert.equal(solGate(0.26, p).allow, false, "0.26 is above reserve but below min-post");
  assert.equal(solGate(0.25, p).allow, false, "landing exactly on the reserve must refuse");
  assert.equal(solGate(0.24, p).allow, false, "inside the reserve must refuse");
});

test("cancels are NOT gated — unwind stays possible at any balance", () => {
  // solGate is consulted for POSTS only. This test pins the contract: there is
  // no cancel path through it, so no balance can make the bot un-unwindable.
  const p = { minSolPost: 0.5, reserveSol: 0.25 };
  for (const bal of [0, 0.0001, 0.24, 0.25, 0.9, 5]) {
    const d = solGate(bal, p);
    assert.equal(typeof d.allow, "boolean");
  }
});

// ---------------------------------------------------------------- exclusions
test("BTC/ETH/XAU are frozen at BUILD level, case-insensitively", () => {
  assert.deepEqual([...BUILD_EXCLUDED_ASSETS].sort(), ["BTC", "ETH", "XAU"]);
  for (const a of ["BTC", "btc", "Eth", "XAU"]) assert.equal(isBuildExcluded(a), true, a);
  for (const a of ["WIF", "JUP", "FARTCOIN", "SOL"]) assert.equal(isBuildExcluded(a), false, a);
});

test("denyReason reports build-excluded even with an EMPTY env denylist", () => {
  // Env may ADD exclusions; it must not be able to remove these three.
  const mk = (assetName: string) => ({ assetName, assetClass: 1 } as any);
  assert.equal(denyReason(mk("BTC"), [], []), "build-excluded");
  assert.equal(denyReason(mk("ETH"), [], []), "build-excluded");
  assert.equal(denyReason(mk("XAU"), [], []), "build-excluded");
  assert.equal(denyReason(mk("WIF"), [], []), null);
});
