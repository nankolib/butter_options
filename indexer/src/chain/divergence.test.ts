// Divergence harness tests — the acceptance gate for the chain read path.
//   run: npx ts-node --transpile-only src/chain/divergence.test.ts
//
// A divergence harness that cannot detect a divergence is worse than none: it
// signs off the cutover. So the central test INJECTS corruption and requires the
// harness to catch it, and an equally important test proves it does NOT fire on
// a legitimate state change — a gate that cries wolf on ordinary trading gets
// muted, and a muted gate is not a gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { openDb, type DB } from "../db";
import { refreshChain } from "./refresh";
import { checkDivergence, divergenceClean } from "./divergence";
import { SHARED_VAULT_LEN, SHARED_VAULT_OFFSETS, discriminatorBase58 } from "./layouts";

const PROGRAM = "CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq";

function tmpDb(): { db: DB; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opta-div-"));
  return { db: openDb(path.join(dir, "t.db")), dir };
}

/** A well-formed SharedVault account with recognisable values. */
function vaultBytes(seed: number, collateral: bigint): Buffer {
  const b = Buffer.alloc(SHARED_VAULT_LEN);
  const o = SHARED_VAULT_OFFSETS;
  Buffer.alloc(32, seed).copy(b, o.market);
  b.writeBigUInt64LE(collateral, o.totalCollateral);
  b.writeBigUInt64LE(500_000n, o.strikePrice);
  b.writeBigInt64LE(1_800_000_000n, o.expiry);
  Buffer.alloc(32, seed + 1).copy(b, o.vaultUsdcAccount);
  Buffer.alloc(32, seed + 2).copy(b, o.collateralMint);
  Buffer.alloc(32, seed + 3).copy(b, o.creator);
  return b;
}

const key = (n: number) => `Vau1t${String(n).padStart(38, "1")}`;

/** Fake RPC returning a fixed account set for SharedVault, empty for the rest. */
function fakeRpc(vaults: { pubkey: string; buf: Buffer }[], slot = 1000) {
  const svDisc = discriminatorBase58("SharedVault");
  return {
    async call(_method: string, params: any[]) {
      const disc = params?.[1]?.filters?.[0]?.memcmp?.bytes;
      const value = disc === svDisc
        ? vaults.map((v) => ({ pubkey: v.pubkey, account: { data: [v.buf.toString("base64"), "base64"] } }))
        : [];
      return { context: { slot }, value };
    },
  } as any;
}

async function seeded(vaults: { pubkey: string; buf: Buffer }[]) {
  const { db, dir } = tmpDb();
  await refreshChain(db, fakeRpc(vaults), PROGRAM);
  return { db, dir };
}

// ---------------------------------------------------------------------------
// Baseline
// ---------------------------------------------------------------------------

test("a faithful reflection reports clean", async () => {
  const vaults = [{ pubkey: key(1), buf: vaultBytes(1, 1_000n) }, { pubkey: key(2), buf: vaultBytes(2, 2_000n) }];
  const { db } = await seeded(vaults);
  const reports = await checkDivergence(db, fakeRpc(vaults), PROGRAM);
  assert.ok(divergenceClean(reports), "a correct reflection must not report divergence");
  const sv = reports.find((r) => r.kind === "sharedVault")!;
  assert.equal(sv.checked, 2);
  assert.equal(sv.comparable, 2, "identical bytes must be comparable, not 'changed'");
  assert.equal(sv.divergent, 0);
});

// ---------------------------------------------------------------------------
// RED: it must actually catch corruption
// ---------------------------------------------------------------------------

test("RED: a corrupted stored COLUMN is caught (self-consistency)", async () => {
  const vaults = [{ pubkey: key(1), buf: vaultBytes(1, 1_000n) }];
  const { db } = await seeded(vaults);

  // Exactly the failure mode that matters: the raw bytes are fine, the decoded
  // column is wrong. Nothing throws, and the number looks perfectly plausible.
  db.prepare("UPDATE chain_shared_vaults SET total_collateral = '999999' WHERE pubkey = ?").run(key(1));

  const reports = await checkDivergence(db, fakeRpc(vaults), PROGRAM);
  assert.ok(!divergenceClean(reports), "a corrupted column MUST be reported");
  const sv = reports.find((r) => r.kind === "sharedVault")!;
  assert.ok(sv.divergent > 0, "divergent count must be non-zero");
  assert.match(sv.examples.join(" "), /total_collateral/, "the report must name the field");
});

test("RED: a row present on chain but missing from the reflection is caught", async () => {
  const vaults = [{ pubkey: key(1), buf: vaultBytes(1, 1_000n) }, { pubkey: key(2), buf: vaultBytes(2, 2_000n) }];
  const { db } = await seeded(vaults);
  db.prepare("DELETE FROM chain_shared_vaults WHERE pubkey = ?").run(key(2));
  const reports = await checkDivergence(db, fakeRpc(vaults), PROGRAM);
  const sv = reports.find((r) => r.kind === "sharedVault")!;
  assert.equal(sv.missing, 1, "a dropped row is a hole in the board and must be reported");
  assert.ok(!divergenceClean(reports));
});

test("RED: a row that no longer exists on chain is caught as orphaned", async () => {
  const vaults = [{ pubkey: key(1), buf: vaultBytes(1, 1_000n) }, { pubkey: key(2), buf: vaultBytes(2, 2_000n) }];
  const { db } = await seeded(vaults);
  // Chain now has only one — the other was closed.
  const reports = await checkDivergence(db, fakeRpc([vaults[0]]), PROGRAM);
  const sv = reports.find((r) => r.kind === "sharedVault")!;
  assert.equal(sv.orphaned, 1, "serving a closed account is serving a contract that does not exist");
  assert.ok(!divergenceClean(reports));
});

test("RED: stored bytes that no longer decode are caught", async () => {
  const vaults = [{ pubkey: key(1), buf: vaultBytes(1, 1_000n) }];
  const { db } = await seeded(vaults);
  // Simulates a layout change landing under stored rows.
  db.prepare("UPDATE chain_shared_vaults SET raw_b64 = ? WHERE pubkey = ?")
    .run(Buffer.alloc(260).toString("base64"), key(1));
  const reports = await checkDivergence(db, fakeRpc(vaults), PROGRAM);
  const sv = reports.find((r) => r.kind === "sharedVault")!;
  assert.ok(sv.divergent > 0, "undecodable stored bytes must scream, not be skipped");
});

// ---------------------------------------------------------------------------
// The false-positive guard — why this harness can be trusted
// ---------------------------------------------------------------------------

test("a legitimate state change is CHANGED, never divergent", async () => {
  // The naive harness fails here: it compares a stored row against a later chain
  // state and calls ordinary trading a divergence. Every account someone touched
  // would light up, the alert would be muted, and the gate would be gone.
  const before = [{ pubkey: key(1), buf: vaultBytes(1, 1_000n) }];
  const { db } = await seeded(before);

  const after = [{ pubkey: key(1), buf: vaultBytes(1, 7_777n) }]; // someone wrote
  const reports = await checkDivergence(db, fakeRpc(after, 2000), PROGRAM);
  const sv = reports.find((r) => r.kind === "sharedVault")!;
  assert.equal(sv.changed, 1, "different bytes at a later slot is the chain being alive");
  assert.equal(sv.divergent, 0, "a state change must NOT be reported as a divergence");
  assert.equal(sv.comparable, 0, "changed rows are excluded from the comparison, not compared anyway");
  assert.ok(divergenceClean(reports), "ordinary activity must leave the gate clean");
});

// ---------------------------------------------------------------------------
// Deletions actually applied by the refresh
// ---------------------------------------------------------------------------

test("refresh sweeps rows for accounts closed on chain", async () => {
  const both = [{ pubkey: key(1), buf: vaultBytes(1, 1_000n) }, { pubkey: key(2), buf: vaultBytes(2, 2_000n) }];
  const { db } = await seeded(both);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM chain_shared_vaults").get() as any).n, 2);

  await refreshChain(db, fakeRpc([both[0]]), PROGRAM);
  const rows = db.prepare("SELECT pubkey FROM chain_shared_vaults").all() as any[];
  assert.equal(rows.length, 1, "a closed account must stop being served");
  assert.equal(rows[0].pubkey, key(1));
});

test("a failed scan KEEPS previous rows rather than blanking the board", async () => {
  const vaults = [{ pubkey: key(1), buf: vaultBytes(1, 1_000n) }];
  const { db } = await seeded(vaults);
  const failing = { async call() { throw new Error("rpc down"); } } as any;
  await refreshChain(db, failing, PROGRAM);
  const n = (db.prepare("SELECT COUNT(*) n FROM chain_shared_vaults").get() as any).n;
  assert.equal(n, 1, "degraded must mean older-but-honest data, never an empty board");
  const meta = db.prepare("SELECT last_error FROM chain_refresh_meta WHERE kind='sharedVault'").get() as any;
  assert.match(String(meta.last_error), /rpc down/, "the failure must be recorded, not swallowed");
});

test("legacy-sized accounts are rejected and COUNTED, never stored", async () => {
  const mixed = [
    { pubkey: key(1), buf: vaultBytes(1, 1_000n) },
    { pubkey: key(2), buf: Buffer.alloc(260) }, // previous layout
  ];
  const { db } = await seeded(mixed);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM chain_shared_vaults").get() as any).n, 1);
  const meta = db.prepare("SELECT rejected, rejected_json FROM chain_refresh_meta WHERE kind='sharedVault'").get() as any;
  assert.equal(meta.rejected, 1, "NEVER SILENT: the rejection must be counted");
  assert.match(meta.rejected_json, /"260"/, "and attributed to its size");
});
