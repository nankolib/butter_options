// CROSS-DAY PDA REUSE — the headline gate for the absolute strike grid.
//
// Intraday same-strike reuse is already proven (engine.churn.test.ts). What was
// NOT proven, and is the whole point of the grid, is DAY-OLD-shell reuse: after
// cancel-at-close wipes every equity ask, the next open must re-derive the SAME
// (market, strike, expiry, side) PDAs so the on-chain needSeries/needVault checks
// (engine.ts:353-354, `!accountExists(...)`) return false and the repost REUSES
// instead of minting. This test reproduces that by building two ladders in the
// SAME expiry week at drifted spots and deriving the REAL series+vault PDAs the
// engine would touch — no chain needed: the PDA is a pure function of the strike.
//
//   Day 1  → mint the grid (all PDAs fresh).
//   Day 2, |drift| < gridStep → derive PDAs → ASSERT ZERO are new  ← headline.
//   Day 2, one boundary crossed → ASSERT exactly one new strike (edge only).
//   Weekly roll (new expiry) → ASSERT weekly PDAs are fresh (legitimate residual).
//
//   run: npx ts-node --transpile-only src/engine.crossday.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildLadder, gridStep, type TierPolicy } from "./ladder";
import { marketPda, seriesMintPda, vaultAmericanPda } from "./ids";
import type { MarketInfo } from "./discovery";

const MARKET = marketPda("TESTQ");
const EQUITY: MarketInfo = { publicKey: MARKET, assetName: "TESTQ", assetClass: 2 } as MarketInfo;
const TIER: TierPolicy = { spreadBps: 600, targetNotional: 100_000 };
// A fixed Wednesday EARLY in the month (2026-07-08T13:00Z) so weekly (Jul 10) and
// monthly (Jul 31) never collapse, and NOW+7d's weekly (Jul 17) stays distinct
// from day-1's expiries — the tenor helpers derive future expiries from nowMs.
const NOW = 1_783_515_600_000;
const LEAD = { epochMinLeadSecs: 86_400, equityMinLeadSecs: 300 };

interface Keyed { series: string; vault: string; expiry: number; tenor: string; strike: number }

function ladderPdas(spot: number, nowMs = NOW): Keyed[] {
  const cells = buildLadder({ market: EQUITY, spot, tier: TIER, nowMs, ...LEAD });
  return cells.map((c) => {
    const strikeMicro = BigInt(c.strikeMicro.toString());
    return {
      series: seriesMintPda(MARKET, strikeMicro, c.expiryTs, c.optIdx).toBase58(),
      vault: vaultAmericanPda(MARKET, strikeMicro, c.expiryTs, c.optIdx).toBase58(),
      expiry: c.expiryTs,
      tenor: c.tenorLabel,
      strike: c.strikeDollars,
    };
  });
}

test("day-1 grid mints a full ladder (sanity): 5 strikes × 2 sides × 2 tenors = 20 cells", () => {
  const d1 = ladderPdas(390);
  assert.equal(d1.length, 20);
  assert.equal(new Set(d1.map((k) => k.strike)).size, 5);
  assert.equal(new Set(d1.map((k) => k.vault)).size, 20); // every cell a distinct vault
});

test("HEADLINE: sub-gridStep overnight drift re-posts with ZERO new series/vault PDAs", () => {
  const step = gridStep(390); // 10
  const day1 = ladderPdas(390);
  const existingSeries = new Set(day1.map((k) => k.series));
  const existingVaults = new Set(day1.map((k) => k.vault));

  // Next open, spot drifted less than one gridStep (both directions).
  for (const spot2 of [390 + 0.4 * step, 390 - 0.4 * step, 390 + 0.49 * step]) {
    const day2 = ladderPdas(spot2);
    const newSeries = day2.filter((k) => !existingSeries.has(k.series));
    const newVaults = day2.filter((k) => !existingVaults.has(k.vault));
    assert.equal(newVaults.length, 0, `spot ${spot2}: ${newVaults.length} new vaults (want 0)`);
    assert.equal(newSeries.length, 0, `spot ${spot2}: ${newSeries.length} new series (want 0)`);
    assert.equal(day2.length, 20); // still a full board, all reused
  }
});

test("crossing exactly one grid boundary mints only the edge: 1 new strike (4 cells)", () => {
  const day1 = ladderPdas(390);
  const existingVaults = new Set(day1.map((k) => k.vault));
  // +1 gridStep → ATM steps up one grid point → one strike enters, one drops.
  const day2 = ladderPdas(400);
  const newVaults = day2.filter((k) => !existingVaults.has(k.vault));
  const newStrikes = [...new Set(newVaults.map((k) => k.strike))];
  assert.deepEqual(newStrikes, [420]);          // only the new top rung
  assert.equal(newVaults.length, 4);            // 1 strike × 2 tenors × 2 sides
  assert.equal(day2.length - newVaults.length, 16); // 16 of 20 reused
});

test("weekly-roll: a new weekly expiry legitimately mints (the ~residual), monthly reused", () => {
  const day1 = ladderPdas(390);
  const existingVaults = new Set(day1.map((k) => k.vault));
  // One week later, same spot: monthly expiry unchanged, weekly advances.
  const nextWeek = ladderPdas(390, NOW + 7 * 86_400 * 1000);
  const weeklyCells = nextWeek.filter((k) => k.tenor === "weekly");
  const monthlyCells = nextWeek.filter((k) => k.tenor === "monthly");
  // weekly expiry moved → its PDAs are all fresh (legitimate roll mint)
  assert.ok(weeklyCells.length > 0);
  assert.ok(
    weeklyCells.every((k) => !existingVaults.has(k.vault)),
    "weekly roll should mint fresh PDAs (new expiry)",
  );
  // same-spot monthly (unchanged expiry) is fully reused
  assert.ok(
    monthlyCells.every((k) => existingVaults.has(k.vault)),
    "monthly (unchanged expiry, same spot) must reuse",
  );
});
