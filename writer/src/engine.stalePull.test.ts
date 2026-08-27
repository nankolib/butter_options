// Unit test for the stale-oracle pull selection (writer stale-pull fix, 2026-07-19).
// Pure logic — mocks orders + a vault->market map; induces NO prod staleness.
//   cd writer && npx ts-node --transpile-only -r tsconfig-paths/register src/engine.stalePull.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { PublicKey } from "@solana/web3.js";
import { ordersOnMarket } from "./engine";
import type { MyOrder } from "./discovery";

const uniq = () => PublicKey.unique();
function mkOrder(vault: PublicKey): MyOrder {
  return { pubkey: uniq(), optionMint: uniq(), vault, priceMicro: 0n, quantityRemaining: 1n, nonce: 0n, createdAtMs: 0, collateralPerContract: 0n };
}

test("pulls ONLY the stale market's resting asks", () => {
  const mktStale = uniq(), mktOther = uniq();
  const vS1 = uniq(), vS2 = uniq(), vO1 = uniq();
  const orders = [mkOrder(vS1), mkOrder(vS2), mkOrder(vO1)];
  const vaultToMarket = new Map<string, string>([
    [vS1.toBase58(), mktStale.toBase58()],
    [vS2.toBase58(), mktStale.toBase58()],
    [vO1.toBase58(), mktOther.toBase58()],
  ]);
  const pulled = ordersOnMarket(orders, mktStale.toBase58(), vaultToMarket);
  assert.equal(pulled.length, 2, "both stale-market asks selected");
  assert.ok(pulled.every((o) => [vS1.toBase58(), vS2.toBase58()].includes(o.vault.toBase58())));
  assert.ok(!pulled.some((o) => o.vault.toBase58() === vO1.toBase58()), "other market's ask NOT pulled");
});

test("empty when the stale market has no resting asks", () => {
  const mktStale = uniq(), mktOther = uniq(), vO = uniq();
  const vaultToMarket = new Map([[vO.toBase58(), mktOther.toBase58()]]);
  assert.equal(ordersOnMarket([mkOrder(vO)], mktStale.toBase58(), vaultToMarket).length, 0);
});

test("idempotent: after a pull the orders are gone → next tick selects nothing", () => {
  const mktStale = uniq(), v = uniq();
  const vaultToMarket = new Map([[v.toBase58(), mktStale.toBase58()]]);
  const before = ordersOnMarket([mkOrder(v)], mktStale.toBase58(), vaultToMarket);
  assert.equal(before.length, 1);
  // simulate next tick: the cancelled order is no longer enumerated on-chain
  const after = ordersOnMarket([], mktStale.toBase58(), vaultToMarket);
  assert.equal(after.length, 0, "no re-pull → no per-tick churn");
});

test("unresolved vault (not in cache) is skipped, never mis-pulled", () => {
  const mktStale = uniq(), vUnknown = uniq();
  assert.equal(ordersOnMarket([mkOrder(vUnknown)], mktStale.toBase58(), new Map()).length, 0);
});
