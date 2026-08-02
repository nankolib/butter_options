// =============================================================================
// finalPoints.test.ts — the number the user SEES is the number the engine COMPUTES
// =============================================================================
//
// Before this suite existed, `recompute()` built `finalPoints` —
//   (base x multiplier) + quests + social + bounty + referral bond + commission
// — handed it to persistProjections(), and persistProjections() never read it.
// Nothing persisted it, no endpoint served it, and the UI reassembled its own
// total client-side as `base + quests + social`. Three point sources (the
// multiplier on base, bounty, and the entire referral economy) computed on every
// tick and evaporated.
//
// These tests pin the contract in ONE direction: whatever the API serves as the
// wallet's total MUST equal the engine's `finalPoints` for that wallet, to the
// last decimal. A client that re-adds components is a second scoring
// implementation, and two implementations drift.
// =============================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { makeWriter, openDb, type DB, type EventRow, type TxRow } from "../db";
import { getWallet } from "../api/handlers";
import { recompute } from "./recompute";

const NOW = 1_784_000_000;
const DAY = 86_400;
const VAULT = "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";
const MINT = "MMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMMM";
// Deterministic, valid-length base58 pubkeys. Not real keys — nothing is signed.
const ALICE = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const BOB = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

function tmpDb(): { db: DB; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opta-final-"));
  return { db: openDb(path.join(dir, "points.db")), dir };
}

let evtN = 0;
const evt = (over: Partial<EventRow>): EventRow => ({
  id: `F${++evtN}:0`,
  sig: `F${evtN}`,
  ordinal: 0,
  ix_index: null,
  source: "log",
  name: "OrderFilled",
  wallet: null,
  counterparty: null,
  vault: VAULT,
  option_mint: MINT,
  kind: 2,
  amount_usdc: 1_000_000,
  quantity: 1,
  fields_json: "{}",
  block_time: NOW - DAY,
  ...over,
});

function seed(db: DB, rows: EventRow[]): void {
  const write = makeWriter(db);
  for (const r of rows) {
    write({ sig: r.sig, slot: 1, block_time: r.block_time, ok: 1, truncated: 0 } as TxRow, [r]);
  }
}

/** The total a client is shown, read straight off the API response. */
function servedTotal(db: DB, wallet: string): number {
  const res = getWallet(db, wallet);
  assert.equal(res.status, 200, `getWallet(${wallet}) -> ${res.status}`);
  const points = (res.body as { points: Record<string, unknown> }).points;
  assert.ok(
    typeof points.total === "number",
    "GET /wallet must serve points.total — the engine's finalPoints, not a client-side sum",
  );
  return points.total as number;
}

// ---------------------------------------------------------------------------

test("finalPoints: served total equals the engine total for a plain trading wallet", () => {
  const { db, dir } = tmpDb();
  seed(db, [
    evt({ wallet: ALICE, counterparty: BOB, amount_usdc: 40_000_000, block_time: NOW - 3 * DAY }),
    evt({ wallet: ALICE, counterparty: BOB, amount_usdc: 25_000_000, block_time: NOW - 2 * DAY }),
    evt({ name: "VaultMinted", wallet: ALICE, block_time: NOW - 2 * DAY }),
  ]);
  const r = recompute(db, NOW);

  assert.equal(servedTotal(db, ALICE), r.finalPoints.get(ALICE) ?? 0);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("finalPoints: the multiplier on BASE points reaches the served total", () => {
  const { db, dir } = tmpDb();
  // One active day => that day's multiplier is 1.1x (1 + 0.1 * streak-of-1).
  // The old client-side sum used points_capped, which is pre-multiplier, so it
  // under-reported this wallet by exactly the 0.1x.
  seed(db, [evt({ wallet: ALICE, counterparty: BOB, amount_usdc: 100_000_000, block_time: NOW - DAY })]);
  const r = recompute(db, NOW);

  const base = r.scores.find((s) => s.wallet === ALICE)!.pointsCapped;
  const quests = r.quests.totals.get(ALICE) ?? 0;
  const served = servedTotal(db, ALICE);

  assert.equal(served, r.finalPoints.get(ALICE) ?? 0);
  assert.ok(
    served > base + quests,
    `served total ${served} must exceed the pre-multiplier sum ${base + quests} — the multiplier is being dropped`,
  );
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("finalPoints: approved BOUNTY points reach the served total", () => {
  const { db, dir } = tmpDb();
  seed(db, [evt({ wallet: ALICE, counterparty: BOB, amount_usdc: 5_000_000, block_time: NOW - DAY })]);
  db.prepare(
    "INSERT INTO bounty_submissions (id, wallet, kind, proof_url, status, points) VALUES (?,?,?,?,'approved',?)",
  ).run("b1", ALICE, "bug", "https://example.invalid/issues/1", 250);

  const r = recompute(db, NOW);
  const served = servedTotal(db, ALICE);

  assert.equal(served, r.finalPoints.get(ALICE) ?? 0);
  assert.ok(served >= 250, `approved bounty points are missing from the served total (${served})`);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("finalPoints: referral bond + commission reach the served totals of BOTH parties", () => {
  const { db, dir } = tmpDb();
  // BOB refers ALICE. Activation is ALICE completing O3 (maker side of a real
  // fill) — and the chain is strictly sequential, so ALICE must first take a
  // fill (O1), then write (O2), before her maker fill can count as O3.
  seed(db, [
    evt({ wallet: ALICE, counterparty: BOB, amount_usdc: 200_000_000, block_time: NOW - 5 * DAY }),
    evt({ name: "VaultMinted", wallet: ALICE, block_time: NOW - 4 * DAY }),
    evt({ wallet: BOB, counterparty: ALICE, amount_usdc: 200_000_000, block_time: NOW - 3 * DAY }),
    evt({ wallet: BOB, counterparty: ALICE, amount_usdc: 200_000_000, block_time: NOW - 2 * DAY }),
  ]);
  db.prepare("INSERT INTO referral_codes (code, wallet, created_at) VALUES (?,?,?)").run("CODE01", BOB, NOW - 5 * DAY);
  db.prepare("INSERT INTO referrals (referee_wallet, code, referrer_wallet, bound_at) VALUES (?,?,?,?)").run(
    ALICE,
    "CODE01",
    BOB,
    NOW - 4 * DAY,
  );

  const r = recompute(db, NOW);

  assert.ok(r.referrals.bondPoints.get(ALICE)! > 0, "fixture must produce a referee bond");
  assert.ok(r.referrals.commission.get(BOB)! > 0, "fixture must produce referrer commission");
  assert.equal(servedTotal(db, ALICE), r.finalPoints.get(ALICE) ?? 0);
  assert.equal(servedTotal(db, BOB), r.finalPoints.get(BOB) ?? 0);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("finalPoints: the served breakdown sums to the served total", () => {
  const { db, dir } = tmpDb();
  seed(db, [
    evt({ wallet: ALICE, counterparty: BOB, amount_usdc: 60_000_000, block_time: NOW - 2 * DAY }),
    evt({ name: "VaultExercised", wallet: ALICE, block_time: NOW - DAY }),
  ]);
  db.prepare(
    "INSERT INTO bounty_submissions (id, wallet, kind, proof_url, status, points) VALUES (?,?,?,?,'approved',?)",
  ).run("b2", ALICE, "bug", "https://example.invalid/issues/2", 40);
  recompute(db, NOW);

  const body = getWallet(db, ALICE).body as { points: Record<string, number> };
  const p = body.points;
  const parts =
    p.base_multiplied + p.quests + p.social + p.bounty + p.referral_bond + p.referral_commission;
  assert.equal(
    Math.round(parts * 1e4) / 1e4,
    p.total,
    `served components ${parts} must sum to served total ${p.total}`,
  );
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("finalPoints: a wallet with no activity is absent, not zero-scored", () => {
  const { db, dir } = tmpDb();
  seed(db, [evt({ wallet: ALICE, counterparty: BOB, amount_usdc: 3_000_000, block_time: NOW - DAY })]);
  recompute(db, NOW);
  assert.equal(getWallet(db, "CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC").status, 404);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
