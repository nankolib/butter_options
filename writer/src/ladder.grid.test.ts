// Absolute strike grid (equity, asset_class 2) — pure-function proof.
//
// The grid replaces spot-relative recentring so that a sub-gridStep overnight
// move re-derives the IDENTICAL strike set → the (market, strike, expiry, side)
// PDAs already exist → the repost reuses instead of minting. These tests pin the
// tier table, the snap rounding, ladder selection, and — the reuse guarantee —
// ATM snap-stability across small drift. Cross-day PDA reuse itself is proven in
// engine.crossday.test.ts.
//   run: npx ts-node --transpile-only src/ladder.grid.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { gridStep, snapToGrid, equityGridStrikes, EQUITY_LADDER_N } from "./ladder";

// ---- tier table: exact boundaries (< is the boundary; equal rolls up) -------
test("gridStep tier boundaries", () => {
  assert.equal(gridStep(49.99), 1);
  assert.equal(gridStep(50), 2.5);
  assert.equal(gridStep(99.99), 2.5);
  assert.equal(gridStep(100), 5);
  assert.equal(gridStep(249.99), 5);
  assert.equal(gridStep(250), 10);
  assert.equal(gridStep(499.99), 10);
  assert.equal(gridStep(500), 25);
  assert.equal(gridStep(999.99), 25);
  assert.equal(gridStep(1000), 50);
  assert.equal(gridStep(5000), 50);
});

// ---- snapToGrid: nearest point, half-up on the midpoint ---------------------
test("snapToGrid rounds to the nearest grid point", () => {
  assert.equal(snapToGrid(325, 5), 325);
  assert.equal(snapToGrid(327.4, 5), 325);
  assert.equal(snapToGrid(327.6, 5), 330);
  assert.equal(snapToGrid(327.5, 5), 330); // documented half-up
  assert.equal(snapToGrid(42.4, 2.5), 42.5);
  assert.equal(snapToGrid(41.2, 2.5), 40);
  assert.equal(snapToGrid(123, 1), 123);
});

// ---- ladder selection: N distinct points centred on snapped ATM -------------
test("equityGridStrikes returns N sorted, distinct, centred grid points", () => {
  // AAPL ~325, step 10 (< $500): ATM snaps to 330 → 310,320,330,340,350
  const aapl = equityGridStrikes(325);
  assert.deepEqual(aapl, [310, 320, 330, 340, 350]);
  assert.equal(aapl.length, EQUITY_LADDER_N);

  // MSTR ~392, step 10: ATM snaps to 390 → 370,380,390,400,410
  assert.deepEqual(equityGridStrikes(392), [370, 380, 390, 400, 410]);

  // low-priced, step 1: 30 → 28,29,30,31,32
  assert.deepEqual(equityGridStrikes(30), [28, 29, 30, 31, 32]);

  // $2.5 tier (spot 75): ATM 75 → 70,72.5,75,77.5,80
  assert.deepEqual(equityGridStrikes(75), [70, 72.5, 75, 77.5, 80]);

  // properties hold for a sweep
  for (const spot of [12.3, 63.7, 148.2, 331.9, 640, 1240]) {
    const ss = equityGridStrikes(spot);
    assert.equal(ss.length, EQUITY_LADDER_N, `count @ ${spot}`);
    assert.equal(new Set(ss).size, ss.length, `distinct @ ${spot}`);
    for (let i = 1; i < ss.length; i++) assert.ok(ss[i] > ss[i - 1], `sorted @ ${spot}`);
    assert.ok(ss.every((s) => s > 0), `positive @ ${spot}`);
  }
});

test("equityGridStrikes drops non-positive wings near zero", () => {
  // spot 3, step 1: ATM 3 → 1,2,3,4,5 (no drop); spot 1.4, step 1: ATM 1 →
  // -1,0,1,2,3 → drops the two non-positive, keeps 1,2,3.
  assert.deepEqual(equityGridStrikes(3), [1, 2, 3, 4, 5]);
  assert.deepEqual(equityGridStrikes(1.4), [1, 2, 3]);
  assert.deepEqual(equityGridStrikes(0), []);
});

// ---- THE REUSE GUARANTEE: small drift → identical strike set ----------------
test("ATM snap-stability: |drift| < ½ gridStep re-derives the IDENTICAL ladder", () => {
  // MSTR ~390, step 10 → half-step window is (385, 395). Every spot inside snaps
  // to ATM 390 → same five strikes → same PDAs → 0 mints on repost.
  const base = equityGridStrikes(390);
  for (const spot of [385.1, 387, 389.9, 390, 391, 394.9]) {
    assert.deepEqual(equityGridStrikes(spot), base, `ladder moved at spot ${spot}`);
  }
});

test("crossing one grid boundary slides the window by exactly one strike", () => {
  // step 10, ATM 390 → [370..410]. At 395.1 the ATM snaps to 400 → [380..420]:
  // exactly one new strike (420) enters, exactly one (370) drops; 4 reused.
  const before = equityGridStrikes(390);
  const after = equityGridStrikes(395.1);
  assert.deepEqual(after, [380, 390, 400, 410, 420]);
  const entered = after.filter((s) => !before.includes(s));
  const dropped = before.filter((s) => !after.includes(s));
  assert.deepEqual(entered, [420]);
  assert.deepEqual(dropped, [370]);
});

// ---- tier migration: crossing a tier boundary respaces (rare, acceptable) ---
test("tier migration respaces the ladder (accepted remint)", () => {
  // 499 (step 10) → [480,490,500,510,520]; 501 (step 25) → snap 500 → [450..550].
  const below = equityGridStrikes(499);
  const above = equityGridStrikes(501);
  assert.equal(gridStep(499), 10);
  assert.equal(gridStep(501), 25);
  assert.deepEqual(below, [480, 490, 500, 510, 520]);
  assert.deepEqual(above, [450, 475, 500, 525, 550]);
  // only the shared 500 survives — the respacing legitimately remints the rest.
  const reused = above.filter((s) => below.includes(s));
  assert.deepEqual(reused, [500]);
});
