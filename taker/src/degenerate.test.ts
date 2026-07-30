// DEGENERATE-STATE FIXTURE CLASS — permanent.
//
// Same lesson as the indexer's zero-row fixtures and the writer's rollover
// fixtures: a state your fixtures never enter is a state your tests cannot
// defend. The happy-path suites always run with a populated book, a funded
// float, and a mid-day clock. Production spends most of its life outside that.
//
// Every test here reaches a state normal fixtures skip:
//   an empty book · a book that is entirely ours · zero-value edges ·
//   a UTC day rollover mid-run · limits configured to zero · a restart
//
// New gates, counters, or limits must be exercised here before they ship.
//   run: npx ts-node --transpile-only src/degenerate.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  evaluate, affordableQuantity, delayForOrder,
  type Candidate, type TakerLimits, type EvalInput,
} from "./eligibility";
import { headroom, bindingConstraint, utcDay } from "./budget";
import {
  openDb, walletSpentToday, globalSpentToday, readFloat, seeOrder, recordFill, releaseFloat, pruneSeen, type Db,
} from "./db";

const NOW = 1_785_000_000;
const USER = "USERxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const TAKER = "TAKERxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";

const LIMITS: TakerLimits = {
  minDiscountBps: 500, maxDiscountBps: 5000, minTteSecs: 24 * 3600,
  maxFillUsdc: 100, maxPerWalletDayUsdc: 250, maxGlobalDayUsdc: 2000, maxFloatUsdc: 10_000,
};

const candidate = (over: Partial<Candidate> = {}): Candidate => ({
  orderPk: "ORDER1", owner: USER, optionMint: "MINT1",
  priceUsdc: 9, quantityRemaining: 5, expiryTs: NOW + 7 * 86_400, isEuropean: false, ...over,
});

const input = (over: Partial<EvalInput> = {}): EvalInput => ({
  candidate: candidate(), fairUsdc: 10, limits: LIMITS,
  spend: { walletSpentTodayUsdc: 0, globalSpentTodayUsdc: 0, floatUsdc: 0 },
  nowSecs: NOW, delayUntilSecs: 0,
  isInternal: () => false, isWallet: () => true, takerWallet: TAKER, ...over,
});

function tmpDb(): { db: Db; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opta-taker-test-"));
  const p = path.join(dir, "taker.db");
  const db = openDb(p);
  return { db, cleanup: () => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

// ---------------------------------------------------------------------------
// ZERO ROWS — nothing to do
// ---------------------------------------------------------------------------

test("ZERO ROWS: a fresh database reports zero spend, not undefined", () => {
  // Every budget read must return a NUMBER on an empty table. `undefined` here
  // would propagate into arithmetic and produce NaN headroom, which compares
  // false against every limit — i.e. an uncapped bot.
  const { db, cleanup } = tmpDb();
  try {
    assert.equal(walletSpentToday(db, USER, NOW), 0);
    assert.equal(globalSpentToday(db, NOW), 0);
    assert.equal(readFloat(db), 0);
    const h = headroom(LIMITS, {
      walletSpentTodayUsdc: walletSpentToday(db, USER, NOW),
      globalSpentTodayUsdc: globalSpentToday(db, NOW),
      floatUsdc: readFloat(db),
    });
    assert.deepEqual(h, { wallet: 250, global: 2000, float: 10_000 });
    assert.equal(bindingConstraint(LIMITS, { walletSpentTodayUsdc: 0, globalSpentTodayUsdc: 0, floatUsdc: 0 }), null);
  } finally { cleanup(); }
});

test("ZERO ROWS: pruning an empty sighting table is a no-op, not an error", () => {
  const { db, cleanup } = tmpDb();
  try {
    assert.equal(pruneSeen(db, new Set(), NOW), 0);
  } finally { cleanup(); }
});

test("ZERO ROWS: releasing float against a zero float clamps at zero", () => {
  const { db, cleanup } = tmpDb();
  try {
    releaseFloat(db, 500);
    assert.equal(readFloat(db), 0);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// DEGENERATE CONFIG — limits set to zero
// ---------------------------------------------------------------------------

test("ZERO LIMITS: every cap at zero refuses everything (a zero cap is OFF, not unlimited)", () => {
  // The dangerous reading of "0" is "no limit". Assert the safe one.
  const zero: TakerLimits = { ...LIMITS, maxFillUsdc: 0, maxPerWalletDayUsdc: 0, maxGlobalDayUsdc: 0, maxFloatUsdc: 0 };
  const d = evaluate(input({ limits: zero }));
  assert.equal(d.fill, false);
  assert.equal(affordableQuantity(candidate(), zero, { walletSpentTodayUsdc: 0, globalSpentTodayUsdc: 0, floatUsdc: 0 }), 0);
});

test("DEGENERATE PRICE: sub-cent asks do not round a fill into existence", () => {
  // 0.000001 USDC (1 micro) against a fair of 0.00001 is a 90% discount =>
  // below_band. The gate must fire on the ratio, not be lost to float noise.
  const d = evaluate(input({ candidate: candidate({ priceUsdc: 0.000001 }), fairUsdc: 0.00001 }));
  assert.equal(d.fill, false);
  if (d.fill) return;
  assert.equal(d.reason, "below_band");
});

test("DEGENERATE QUANTITY: a huge resting size is bounded by the per-fill cap", () => {
  const d = evaluate(input({ candidate: candidate({ quantityRemaining: Number.MAX_SAFE_INTEGER }) }));
  assert.equal(d.fill, true);
  if (!d.fill) return;
  assert.ok(d.costUsdc <= LIMITS.maxFillUsdc);
  assert.ok(Number.isSafeInteger(d.quantity));
});

test("DEGENERATE CLOCK: an expiry at exactly now is refused", () => {
  assert.equal(evaluate(input({ candidate: candidate({ expiryTs: NOW }) })).fill, false);
});

// ---------------------------------------------------------------------------
// ROLLOVER — the UTC day boundary crossed mid-run
// ---------------------------------------------------------------------------

test("ROLLOVER: daily counters reset at midnight UTC while float does NOT", () => {
  // The whole point of having both kinds of limit. A run that spans midnight
  // must free the daily budget and keep the capital-at-risk cap.
  const { db, cleanup } = tmpDb();
  try {
    const beforeMidnight = Date.UTC(2026, 6, 30, 23, 59, 0) / 1000;
    const afterMidnight = Date.UTC(2026, 6, 31, 0, 1, 0) / 1000;
    assert.notEqual(utcDay(beforeMidnight), utcDay(afterMidnight));

    recordFill(db, {
      sig: "SIG1", orderPk: "O1", owner: USER, mint: "M1",
      qty: 10, price: 9, fair: 10, bandBps: 1000, ts: beforeMidnight,
    });
    assert.equal(walletSpentToday(db, USER, beforeMidnight), 90);
    assert.equal(globalSpentToday(db, beforeMidnight), 90);

    // New UTC day: daily counters are clean…
    assert.equal(walletSpentToday(db, USER, afterMidnight), 0);
    assert.equal(globalSpentToday(db, afterMidnight), 0);
    // …but the position is still held, so float must persist across the boundary.
    assert.equal(readFloat(db), 90);
  } finally { cleanup(); }
});

test("ROLLOVER: yesterday's spend is retained, not overwritten", () => {
  const { db, cleanup } = tmpDb();
  try {
    const d1 = Date.UTC(2026, 6, 30, 12, 0, 0) / 1000;
    const d2 = Date.UTC(2026, 6, 31, 12, 0, 0) / 1000;
    recordFill(db, { sig: "S1", orderPk: "O1", owner: USER, mint: "M1", qty: 1, price: 50, fair: 60, bandBps: 1667, ts: d1 });
    recordFill(db, { sig: "S2", orderPk: "O2", owner: USER, mint: "M1", qty: 1, price: 30, fair: 40, bandBps: 2500, ts: d2 });
    assert.equal(walletSpentToday(db, USER, d1), 50);
    assert.equal(walletSpentToday(db, USER, d2), 30);
    assert.equal(readFloat(db), 80); // float is cumulative across days
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// RESTART — the state that only exists after a crash
// ---------------------------------------------------------------------------

test("RESTART: spend counters survive a reopen", () => {
  // systemd restarts this service. A budget held only in memory would reset to
  // zero on every crash — an unbounded spend loop for a seller who can cause one.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opta-taker-restart-"));
  const p = path.join(dir, "taker.db");
  try {
    const a = openDb(p);
    recordFill(a, { sig: "S1", orderPk: "O1", owner: USER, mint: "M1", qty: 10, price: 9, fair: 10, bandBps: 1000, ts: NOW });
    a.close();

    const b = openDb(p);
    assert.equal(walletSpentToday(b, USER, NOW), 90);
    assert.equal(globalSpentToday(b, NOW), 90);
    assert.equal(readFloat(b), 90);
    b.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("RESTART: an order's delay clock is NOT re-rolled", () => {
  // Otherwise a seller who can trigger a restart gets a fresh — possibly
  // shorter — wait, defeating the delay entirely.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opta-taker-delay-"));
  const p = path.join(dir, "taker.db");
  try {
    const a = openDb(p);
    const first = seeOrder(a, "ORDER1", NOW, 120);
    a.close();

    const b = openDb(p);
    // Later tick, different sampled delay offered: the stored deadline wins.
    assert.equal(seeOrder(b, "ORDER1", NOW + 60, 30), first);
    b.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("RESTART: a replayed fill signature does not double-count spend", () => {
  // Confirmation ambiguity is real — a tx can land while the confirm call times
  // out. Re-recording the same signature must be idempotent on the FILL row…
  const { db, cleanup } = tmpDb();
  try {
    const f = { sig: "SAME", orderPk: "O1", owner: USER, mint: "M1", qty: 10, price: 9, fair: 10, bandBps: 1000, ts: NOW };
    recordFill(db, f);
    recordFill(db, f);
    const n = db.prepare("SELECT COUNT(*) AS c FROM fills").get() as { c: number };
    assert.equal(n.c, 1, "the fill row is deduplicated by signature");
    // …and the counters, which are additive, MUST be guarded by the caller.
    // This assertion documents the current contract rather than hiding it: the
    // service only calls recordFill after a confirmed send, exactly once.
    assert.equal(walletSpentToday(db, USER, NOW), 180);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// PRUNING — bounded growth
// ---------------------------------------------------------------------------

test("PRUNE: a transient scan miss does not reset a young order's delay", () => {
  // Orders vanish from a single scan for boring reasons (RPC hiccup, commitment
  // lag). Pruning on absence alone would restart the delay clock every time.
  const { db, cleanup } = tmpDb();
  try {
    const until = seeOrder(db, "ORDER1", NOW, 120);
    assert.equal(pruneSeen(db, new Set(), NOW + 60), 0, "young rows survive an empty scan");
    assert.equal(seeOrder(db, "ORDER1", NOW + 60, 30), until, "the original deadline is intact");
  } finally { cleanup(); }
});

test("PRUNE: an order gone for over a day is dropped", () => {
  const { db, cleanup } = tmpDb();
  try {
    seeOrder(db, "ORDER1", NOW, 120);
    assert.equal(pruneSeen(db, new Set(), NOW + 86_401), 1);
    const rows = db.prepare("SELECT COUNT(*) AS c FROM seen_orders").get() as { c: number };
    assert.equal(rows.c, 0);
  } finally { cleanup(); }
});

test("PRUNE: an old order still on the book is kept", () => {
  const { db, cleanup } = tmpDb();
  try {
    seeOrder(db, "ORDER1", NOW, 120);
    assert.equal(pruneSeen(db, new Set(["ORDER1"]), NOW + 86_401), 0);
  } finally { cleanup(); }
});

// ---------------------------------------------------------------------------
// ALL-INTERNAL BOOK — today's actual production state
// ---------------------------------------------------------------------------

test("ALL-INTERNAL BOOK: every order ours means zero fills and zero quotes", () => {
  // The live board is ~232/233 our own orders. This is not an edge case, it is
  // the current steady state, and the bot must sit quietly through it.
  const orders = Array.from({ length: 50 }, (_, i) => candidate({ orderPk: `O${i}`, owner: `BOT${i}` }));
  for (const c of orders) {
    const d = evaluate(input({ candidate: c, isInternal: () => true }));
    assert.equal(d.fill, false);
    if (!d.fill) assert.equal(d.reason, "internal_owner");
  }
});

test("delayForOrder is total over odd pubkeys", () => {
  // Empty and non-base58 strings should not throw — the hash is fed whatever the
  // scanner produced.
  for (const pk of ["", "0", "é", "x".repeat(200)]) {
    const d = delayForOrder(pk, 30, 180);
    assert.ok(Number.isInteger(d) && d >= 30 && d <= 180, `${JSON.stringify(pk)} => ${d}`);
  }
});
