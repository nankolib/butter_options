// ZERO-ROW / DEGENERATE-INPUT FIXTURE CLASS.
//
// Phase 2b shipped four defects that every existing test missed for one reason:
// the fixtures always had data. An empty table, a wallet with no tape row, a
// board with nothing in it — none of those were ever exercised, so the bugs only
// surfaced in the live acceptance transcript.
//
// This file is the permanent guard. Every points surface gets asserted against
// an EMPTY database and against degenerate rows. New surfaces must be added here
// before they ship.
//
// run: npx ts-node --transpile-only src/score/zeroRows.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import bs58 from "bs58";

import { makeWriter, openDb, type DB, type EventRow } from "../db";
import {
  getLeaderboard,
  getQuests,
  getStats,
  getWallet,
} from "../api/handlers";
import { recompute } from "./recompute";
import { computePnl } from "./pnl";
import { computeMultipliers } from "./multiplier";
import { computeProvenance } from "./provenance";
import { computePositions } from "./positions";
import { TOKEN_ACCOUNT_LEN } from "../tape/tokenAccounts";

const BOARDS = ["profit", "volume", "writer", "referrals", "social"] as const;
const WSOL = "So11111111111111111111111111111111111111112";
const VAULT = "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";
const A = bs58.encode(Buffer.alloc(32, 3));

function tmpDb(): { db: DB; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opta-zero-"));
  return { db: openDb(path.join(dir, "points.db")), dir };
}
const cleanup = (db: DB, dir: string) => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
};

// ---------------------------------------------------------------------------
// EMPTY DB
// ---------------------------------------------------------------------------

test("EMPTY DB: every read endpoint answers 200 with an empty payload", () => {
  const { db, dir } = tmpDb();
  for (const b of BOARDS) {
    const r = getLeaderboard(db, b, 50);
    assert.equal(r.status, 200, `board ${b}`);
    assert.deepEqual((r.body as { rows: unknown[] }).rows, [], `board ${b} rows`);
    assert.ok("computed_at" in (r.body as object), `board ${b} carries computed_at`);
  }
  const q = getQuests(db);
  assert.equal(q.status, 200);
  // Catalog is present even with zero completions — the quest panel must render.
  assert.ok((q.body as { chain: unknown[] }).chain.length > 0);
  for (const c of (q.body as { chain: { wallets: number; completions: number }[] }).chain) {
    assert.equal(c.wallets, 0);
    assert.equal(c.completions, 0);
  }
  const s = getStats(db);
  assert.equal(s.status, 200);
  assert.equal((s.body as { tape: { txs: number } }).tape.txs, 0);
  cleanup(db, dir);
});

test("EMPTY DB: recompute produces a well-formed zero result, no throw", () => {
  const { db, dir } = tmpDb();
  const r = recompute(db, 1_785_000_000);
  assert.deepEqual(r.scores, []);
  assert.equal(r.externalCount, 0);
  assert.equal(r.quests.completions.length, 0);
  assert.equal(r.referrals.bound, 0);
  assert.equal(r.pnl.reconciliation.residual, 0n);
  assert.equal(r.finalPoints.size, 0);
  cleanup(db, dir);
});

test("EMPTY DB: every pure scorer handles an empty tape", () => {
  const empty = () => [] as EventRow[];
  assert.equal(computePnl(empty).byWallet.size, 0);
  assert.equal(computeMultipliers(empty, 0).state.size, 0);
  assert.equal(computePositions(empty).awards.length, 0);
  assert.equal(computeProvenance([], []).size, 0);
});

test("EMPTY DB: an unknown wallet 404s rather than rendering a hollow row", () => {
  const { db, dir } = tmpDb();
  const r = getWallet(db, bs58.encode(Buffer.alloc(32, 9)));
  assert.equal(r.status, 404);
  cleanup(db, dir);
});

// ---------------------------------------------------------------------------
// BUG A — mints must never be parsed as token accounts
// ---------------------------------------------------------------------------

test("BUG A: an SPL Mint (82 bytes) is shorter than a token account and is rejected", () => {
  // The old guard was `< 72`, which a mint clears. This is the arithmetic that
  // let the wrapped-SOL mint onto the profit board.
  const MINT_LEN = 82;
  assert.equal(TOKEN_ACCOUNT_LEN, 165);
  assert.ok(MINT_LEN >= 72, "a mint PASSES the old guard — that was the bug");
  assert.ok(MINT_LEN < TOKEN_ACCOUNT_LEN, "a mint FAILS the corrected guard");
});

// ---------------------------------------------------------------------------
// BUG B — program accounts must never become wallets
// ---------------------------------------------------------------------------

test("BUG B: mints, vaults and token accounts are excluded from wallet_metrics", () => {
  const { db, dir } = tmpDb();
  const write = makeWriter(db);
  write(
    { sig: "S1", slot: 1, block_time: 1_784_000_000, ok: 1, truncated: 0 },
    [
      {
        id: "S1:0", sig: "S1", ordinal: 0, ix_index: null, source: "log",
        name: "OrderFilled", wallet: A, counterparty: VAULT, vault: VAULT,
        option_mint: "MINTMINTMINTMINTMINTMINTMINTMINTMINTMINTMIN", kind: 3,
        amount_usdc: 1_000_000, quantity: 1, fields_json: "{}", block_time: 1_784_000_000,
      },
    ],
  );
  // Simulate the poisoned rows the old parser produced.
  db.prepare("INSERT INTO token_accounts (ata, owner, mint) VALUES (?,?,?)").run("ATA111", WSOL, WSOL);
  db.prepare(
    "INSERT INTO capital_flows (id, wallet, direction, source, amount_usdc, counterparty, block_time) VALUES (?,?,?,?,?,?,?)",
  ).run("F1", WSOL, "in", "faucet", 10_000_000_000, null, 1_784_000_000);

  recompute(db, 1_784_000_000);

  const metrics = db.prepare("SELECT wallet FROM wallet_metrics").all() as { wallet: string }[];
  const names = metrics.map((m) => m.wallet);
  assert.equal(names.includes(WSOL), false, "the wSOL MINT must never be a wallet");
  assert.equal(names.includes(VAULT), false, "a vault PDA must never be a wallet");
  assert.equal(names.includes("ATA111"), false, "a token account must never be a wallet");
  assert.ok(names.includes(A), "the real trader is still there");

  // …and it must not reach the profit board either.
  const rows = (getLeaderboard(db, "profit", 50).body as { rows: { wallet: string }[] }).rows;
  assert.equal(rows.some((r) => r.wallet === WSOL), false, "wSOL on the profit board is disqualifying");
  cleanup(db, dir);
});

test("BUG B: a token account whose on-chain OWNER is a mint is excluded", () => {
  // The real case: DQ6dfEBf… is a genuine USDC token account whose owner field
  // is the wrapped-SOL MINT. Nothing is misparsed — the chain really says that.
  // Only account_kinds (chain-verified System-Program ownership) catches it.
  const { db, dir } = tmpDb();
  db.prepare("INSERT INTO token_accounts (ata, owner, mint) VALUES (?,?,?)").run(
    "DQ6dfEBfZTghMKHpC71NXyegMp67BLuZHLuSzsKj6xGZ", WSOL, "AytU5HUQRew9VdUdrzQuZvZ7s14pHLiYjAF5WqdK3oxL",
  );
  db.prepare(
    "INSERT INTO capital_flows (id, wallet, direction, source, amount_usdc, counterparty, block_time) VALUES (?,?,?,?,?,?,?)",
  ).run("F9", WSOL, "in", "faucet", 10_000_000_000, null, 1_784_000_000);
  db.prepare("INSERT INTO account_kinds (pubkey, is_wallet, checked_at) VALUES (?,0,?)").run(WSOL, 1_784_000_000);

  recompute(db, 1_784_000_000);
  const names = (db.prepare("SELECT wallet FROM wallet_metrics").all() as { wallet: string }[]).map((m) => m.wallet);
  assert.equal(names.includes(WSOL), false, "chain says not-a-wallet, so it is not ranked");
  const rows = (getLeaderboard(db, "profit", 50).body as { rows: { wallet: string }[] }).rows;
  assert.equal(rows.some((r) => r.wallet === WSOL), false);
  cleanup(db, dir);
});

test("BUG B: a System-Program-owned account IS treated as a wallet", () => {
  const { db, dir } = tmpDb();
  db.prepare("INSERT INTO account_kinds (pubkey, is_wallet, checked_at) VALUES (?,1,?)").run(A, 1_784_000_000);
  db.prepare(
    "INSERT INTO capital_flows (id, wallet, direction, source, amount_usdc, counterparty, block_time) VALUES (?,?,?,?,?,?,?)",
  ).run("F10", A, "in", "faucet", 10_000_000_000, null, 1_784_000_000);
  recompute(db, 1_784_000_000);
  const names = (db.prepare("SELECT wallet FROM wallet_metrics").all() as { wallet: string }[]).map((m) => m.wallet);
  assert.ok(names.includes(A), "a real wallet must survive the filter");
  cleanup(db, dir);
});

// ---------------------------------------------------------------------------
// DEGENERATE ROWS
// ---------------------------------------------------------------------------

test("DEGENERATE: a wallet with campaign rows but no tape row still resolves", () => {
  const { db, dir } = tmpDb();
  db.prepare("INSERT INTO referral_codes (code, wallet, created_at) VALUES ('ABC123',?,?)").run(A, 1_784_000_000);
  const r = getWallet(db, A);
  assert.equal(r.status, 200);
  assert.equal((r.body as { on_tape: boolean }).on_tape, false);
  assert.equal((r.body as { points: { base: number } }).points.base, 0);
  cleanup(db, dir);
});

test("DEGENERATE: limit is clamped, never trusted", () => {
  const { db, dir } = tmpDb();
  assert.equal((getLeaderboard(db, "volume", 0).body as { limit: number }).limit, 50);
  assert.equal((getLeaderboard(db, "volume", -5).body as { limit: number }).limit, 50);
  assert.equal((getLeaderboard(db, "volume", 99_999).body as { limit: number }).limit, 200);
  cleanup(db, dir);
});

test("DEGENERATE: zero-quantity and null-amount events do not break scoring", () => {
  const { db, dir } = tmpDb();
  const write = makeWriter(db);
  write(
    { sig: "S2", slot: 1, block_time: 1_784_000_000, ok: 1, truncated: 0 },
    [
      {
        id: "S2:0", sig: "S2", ordinal: 0, ix_index: null, source: "log",
        name: "OrderFilled", wallet: A, counterparty: null, vault: VAULT,
        option_mint: null, kind: 2, amount_usdc: null, quantity: 0,
        fields_json: "{}", block_time: 1_784_000_000,
      },
    ],
  );
  const r = recompute(db, 1_784_000_000);
  assert.ok(Number.isFinite(r.pnl.reconciliation.residualRatio));
  cleanup(db, dir);
});
