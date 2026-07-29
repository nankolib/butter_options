// ROLLOVER-BOUNDARY FIXTURE CLASS — permanent.
//
// Why this file exists. `buildLadder` guards each tenor with
// `if (t.ts <= nowSec) …` — dead-defensive code under production inputs, because
// weeklyEquity/monthlyEquity/weeklyEpoch/monthlyEpoch all roll FORWARD until
// `ts > nowSec + minLeadSecs`, and minLeadSecs is always positive in prod
// (EQUITY_MIN_LEAD_SECS = 24h; the epoch lead comes from EpochConfig). So the
// guard never fires on a live board.
//
// That is exactly why a bug hid there. When the equity branch was converted from
// `for…of` to `grid.forEach(…)`, the guard's `continue` became a `return` — which
// exits the CALLBACK, dropping every remaining tenor for that strike rather than
// just the expired one. The author's verification was rigorous (86/0 unit tests
// plus a 455-vs-455 structural ask-plan diff against a bids-off control) and
// still could not see it, because no run ever entered the state.
//
// Same lesson as the indexer's zero-row fixtures: a state your fixtures never
// enter is a state your tests cannot defend. These tests reach the guard
// deliberately (negative lead window) and pin BRANCH PARITY so equity and
// non-equity can never diverge on it again.
//
// New tenor/rollover logic must be added here before it ships.
//   run: npx ts-node --transpile-only src/ladder.rollover.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { PublicKey } from "@solana/web3.js";

import { buildLadder, type LadderInput, type TierPolicy } from "./ladder";
import type { MarketInfo } from "./discovery";
import type { AssetClass } from "./marketHours";

const TIER: TierPolicy = { spreadBps: 500, targetNotional: 100 };

function market(assetClass: AssetClass, assetName: string): MarketInfo {
  return {
    publicKey: PublicKey.default,
    assetName,
    assetClass,
    pythFeedId: new Uint8Array(32),
    oracleSource: 0,
  };
}

/**
 * 2026-07-24 23:00:00Z — a FRIDAY, after both expiry times (equity 19:45Z,
 * crypto 08:00Z), and deliberately NOT the last Friday of the month.
 *
 * Both details are load-bearing, and two earlier drafts of this file got them
 * wrong in ways that made it pass against the BUGGY code:
 *   1. A mid-week clock never reaches the guard at all — the helpers start from
 *      the COMING Friday and only roll FORWARD, so no lead window makes them
 *      return a past timestamp. The clock must sit after a Friday expiry.
 *   2. On the month's LAST Friday, weekly and monthly resolve to the SAME
 *      expired timestamp, so both are skipped and an empty board is the correct
 *      outcome for  and  alike — indistinguishable.
 * On 24 Jul the weekly (24th, expired) differs from the monthly (31st, future),
 * which is exactly the first-expired / second-future shape the bug destroys.
 */
const NOW_MS = Date.UTC(2026, 6, 24, 23, 0, 0);

function ladder(assetClass: AssetClass, over: Partial<LadderInput> = {}) {
  return buildLadder({
    market: market(assetClass, assetClass === 2 ? "AAPL" : "BTC"),
    spot: assetClass === 2 ? 220 : 60_000,
    tier: TIER,
    nowMs: NOW_MS,
    epochMinLeadSecs: 24 * 3600,
    equityMinLeadSecs: 24 * 3600,
    ...over,
  });
}

const tenorsOf = (cells: { tenorLabel: string }[]) => new Set(cells.map((c) => c.tenorLabel));

/**
 * A NEGATIVE lead window is what reaches the guard: the tenor helpers roll
 * forward only until `ts > nowSec + minLeadSecs`, so pushing the threshold into
 * the past lets them return a timestamp that is still <= nowSec.
 */
const EXPIRED_LEAD = -14 * 24 * 3600;

// ---------------------------------------------------------------------------
// Baseline — production inputs, both tenors present on both branches
// ---------------------------------------------------------------------------

test("baseline: both branches emit weekly AND monthly under prod lead windows", () => {
  for (const cls of [2, 0] as AssetClass[]) {
    const cells = ladder(cls);
    assert.ok(cells.length > 0, `class ${cls} emits cells`);
    assert.deepEqual([...tenorsOf(cells)].sort(), ["monthly", "weekly"], `class ${cls} tenors`);
  }
});

// ---------------------------------------------------------------------------
// THE REGRESSION — an expired FIRST tenor must not suppress later tenors
// ---------------------------------------------------------------------------

test("EQUITY: an expired first tenor does not drop the remaining tenors", () => {
  const cells = ladder(2, { equityMinLeadSecs: EXPIRED_LEAD });
  const nowSec = Math.floor(NOW_MS / 1000);

  // The guard still works — nothing expired is ever emitted.
  for (const c of cells) assert.ok(c.expiryTs > nowSec, "no expired cell is emitted");

  // …and strike coverage survives. With `return` the callback exited on the
  // first expired tenor and the ENTIRE equity board came out empty.
  assert.ok(cells.length > 0, "equity board is NOT empty when a tenor is expired");
  const strikes = new Set(cells.map((c) => c.strikeDollars));
  assert.ok(strikes.size > 1, `every strike still emits (got ${strikes.size})`);
});

test("NON-EQUITY: an expired first tenor does not drop the remaining tenors", () => {
  const cells = ladder(0, { epochMinLeadSecs: EXPIRED_LEAD });
  const nowSec = Math.floor(NOW_MS / 1000);
  for (const c of cells) assert.ok(c.expiryTs > nowSec, "no expired cell is emitted");
  assert.ok(cells.length > 0, "crypto board is NOT empty when a tenor is expired");
  assert.ok(new Set(cells.map((c) => c.strikeDollars)).size > 1, "every strike still emits");
});

// ---------------------------------------------------------------------------
// BRANCH PARITY — the two branches must agree on tenor-guard semantics
// ---------------------------------------------------------------------------

test("BRANCH PARITY: equity and non-equity treat the tenor guard identically", () => {
  const nowSec = Math.floor(NOW_MS / 1000);

  const eqBase = ladder(2);
  const cxBase = ladder(0);
  const eqExp = ladder(2, { equityMinLeadSecs: EXPIRED_LEAD });
  const cxExp = ladder(0, { epochMinLeadSecs: EXPIRED_LEAD });

  // Property 1 — the assertion that would have FAILED before the fix: equity
  // emptied under an expired tenor while crypto did not.
  assert.equal(
    eqExp.length > 0,
    cxExp.length > 0,
    "both branches must survive an expired tenor, or neither",
  );

  // Property 2 — neither branch ever emits an expired cell.
  for (const c of [...eqExp, ...cxExp]) assert.ok(c.expiryTs > nowSec);

  // Property 3 — an expired tenor may REDUCE the tenor set but must never empty
  // the board, and must never ADD cells, on either branch.
  for (const [name, base, exp] of [
    ["equity", eqBase, eqExp],
    ["crypto", cxBase, cxExp],
  ] as const) {
    assert.ok(exp.length > 0, `${name} board non-empty`);
    assert.ok(tenorsOf(exp).size >= 1, `${name} retains at least one tenor`);
    assert.ok(exp.length <= base.length, `${name} never GAINS cells from an expired tenor`);
  }
});

// ---------------------------------------------------------------------------
// Structural guard — the keyword itself
// ---------------------------------------------------------------------------

test("the equity tenor guard uses continue, not return (source assertion)", () => {
  // The semantic tests above are the real defence. This one names the exact
  // mistake, so a refactor cannot reintroduce it silently while happening to keep
  // the board non-empty for the particular fixtures used here.
  const src = fs.readFileSync(path.join(__dirname, "ladder.ts"), "utf8");
  const start = src.indexOf("if (market.assetClass === 2)");
  const equityBranch = src.slice(start, src.indexOf("} else {", start));
  assert.ok(start > 0, "equity branch located");
  assert.ok(
    /if \(t\.ts <= nowSec\) continue;/.test(equityBranch),
    "equity tenor guard must be `continue` — `return` exits the forEach callback",
  );
  assert.equal(
    /if \(t\.ts <= nowSec\) return;/.test(equityBranch),
    false,
    "`return` inside the forEach callback drops all remaining tenors",
  );
});
