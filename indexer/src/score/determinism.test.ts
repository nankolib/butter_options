// Determinism proof: frozen tape -> byte-identical leaderboard, twice.
// This is the acceptance criterion for the TAPE/SCORE split.
// run: npx ts-node --transpile-only src/score/determinism.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { makeWriter, openDb, loadTape, type EventRow, type TxRow } from "../db";
import { recompute } from "./recompute";
import { DEFAULT_RULES, score } from "./rules_v1";

const A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const VAULT = "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";

function fixture(): { txs: TxRow[]; events: EventRow[] } {
  const txs: TxRow[] = [];
  const events: EventRow[] = [];
  for (let i = 0; i < 200; i++) {
    const sig = `SIG${String(i).padStart(4, "0")}`;
    txs.push({ sig, slot: 1000 + i, block_time: 1_783_000_000 + i * 37, ok: 1, truncated: 0 });
    events.push({
      id: `${sig}:0`,
      sig,
      ordinal: 0,
      ix_index: null,
      source: "log",
      name: i % 7 === 0 ? "VaultExercised" : "OrderFilled",
      wallet: i % 2 === 0 ? A : B,
      counterparty: i % 2 === 0 ? B : A,
      vault: VAULT,
      option_mint: null,
      kind: (i % 4) as number,
      amount_usdc: (i + 1) * 1_000_000,
      quantity: (i % 5) + 1,
      fields_json: "{}",
      block_time: 1_783_000_000 + i * 37,
    });
  }
  return { txs, events };
}

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), "opta-idx-")), "points.db");
}

test("pure score() is stable across repeated calls on a frozen tape", () => {
  const { events } = fixture();
  const a = JSON.stringify(score(events, DEFAULT_RULES, 1_783_000_000));
  const b = JSON.stringify(score(events, DEFAULT_RULES, 1_783_000_000));
  assert.equal(a, b);
});

test("input order does not matter — loadTape re-sorts to (block_time, id)", () => {
  const { events } = fixture();
  const sorted = [...events].sort((x, y) => (x.block_time ?? 0) - (y.block_time ?? 0) || (x.id < y.id ? -1 : 1));
  const shuffled = [...events].reverse().sort((x, y) => (x.block_time ?? 0) - (y.block_time ?? 0) || (x.id < y.id ? -1 : 1));
  assert.equal(JSON.stringify(score(sorted, DEFAULT_RULES, 0)), JSON.stringify(score(shuffled, DEFAULT_RULES, 0)));
});

test("full recompute over sqlite is byte-identical twice, and re-index is idempotent", () => {
  const dbPath = tmpDb();
  const db = openDb(dbPath);
  const write = makeWriter(db);
  const { txs, events } = fixture();

  for (let i = 0; i < txs.length; i++) write(txs[i], [events[i]]);
  const afterFirst = loadTape(db).length;

  // Re-index the SAME data — deterministic ids + INSERT OR IGNORE => no dupes.
  for (let i = 0; i < txs.length; i++) write(txs[i], [events[i]]);
  assert.equal(loadTape(db).length, afterFirst, "re-indexing must not duplicate rows");

  const r1 = JSON.stringify(recompute(db, 1_783_000_000).scores);
  const r2 = JSON.stringify(recompute(db, 1_783_000_000).scores);
  assert.equal(r1, r2, "two consecutive recomputes must be byte-identical");

  db.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test("vault PDAs are excluded from the wallets projection, not counted as users", () => {
  const dbPath = tmpDb();
  const db = openDb(dbPath);
  const write = makeWriter(db);

  // A VaultPeg fill: taker is a real wallet, maker is the SharedVault PDA.
  write(
    { sig: "SIGPEG", slot: 1, block_time: 1_783_000_000, ok: 1, truncated: 0 },
    [
      {
        id: "SIGPEG:0",
        sig: "SIGPEG",
        ordinal: 0,
        ix_index: null,
        source: "log",
        name: "OrderFilled",
        wallet: A,
        counterparty: VAULT, // the PDA
        vault: VAULT,
        option_mint: null,
        kind: 3,
        amount_usdc: 1_000_000,
        quantity: 1,
        fields_json: "{}",
        block_time: 1_783_000_000,
      },
    ],
  );

  const r = recompute(db, 0);
  const rows = db.prepare("SELECT pubkey FROM wallets WHERE is_internal = 0").all() as { pubkey: string }[];
  const keys = rows.map((x) => x.pubkey);
  assert.ok(keys.includes(A), "the real taker must be counted");
  assert.equal(keys.includes(VAULT), false, "the SharedVault PDA must NOT be counted as a wallet");
  assert.equal(r.externalCount, 1);
  assert.equal(r.diagnostics.pegMakerCreditsSkipped, 1);

  db.close();
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});

test("schema version mismatch refuses to open rather than reshaping the tape", () => {
  const dbPath = tmpDb();
  const db = openDb(dbPath);
  db.prepare("UPDATE meta SET value = '999' WHERE key = 'schema_version'").run();
  db.close();
  assert.throws(() => openDb(dbPath), /Schema version mismatch/);
  fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
});
