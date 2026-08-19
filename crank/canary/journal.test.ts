// Journal tests — the kill-safety foundation for the contract-tape canary.
//   run (from crank/): node node_modules/ts-node/dist/bin.js --transpile-only \
//                      -r tsconfig-paths/register canary/journal.test.ts
//
// In-process cleanup cannot survive SIGKILL, so the ONLY thing standing between
// a killed run and an orphaned resting bid is what was written to disk BEFORE
// the send. These assert that the record exists at the moment it matters, and
// that the sweep's view of "still my problem" is conservative in the safe
// direction.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  initJournal, journalPath, needsSweep, openJournals, readJournal,
  recordPending, updateAction, writeJournal,
} from "./journal";

const ROLES = { owner: "admin", payer: "crank", counterparty: "writer" };
const SERIES = { optionMint: "M", vault: "V", market: "K", asset: "XRP" };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "canary-j-"));

test("intent is on disk BEFORE the send, not after", () => {
  // The whole point: a process killed between recordPending and the send must
  // still leave evidence that something may exist on chain.
  const dir = tmp(); const f = journalPath(dir, "r1");
  const j = initJournal(f, "r1", ROLES, SERIES);
  recordPending(f, j, "bid-post", "box", { optionMint: "M", price: 1234, qty: 1 });

  const onDisk = readJournal(f)!;
  assert.equal(onDisk.actions.length, 1);
  assert.equal(onDisk.actions[0].status, "PENDING");
  assert.equal(onDisk.actions[0].expect.price, 1234, "the record must carry enough to FIND the state");
});

test("RED: a PENDING action still needs sweeping — we do not know if it landed", () => {
  // Assuming an unconfirmed send did not land is exactly how an orphan survives.
  const dir = tmp(); const f = journalPath(dir, "r2");
  const j = initJournal(f, "r2", ROLES, SERIES);
  recordPending(f, j, "bid-post", "box", { optionMint: "M" });
  assert.equal(needsSweep(readJournal(f)!, "box").length, 1);
});

test("SENT and CONFIRMED both still need sweeping", () => {
  const dir = tmp(); const f = journalPath(dir, "r3");
  const j = initJournal(f, "r3", ROLES, SERIES);
  const s1 = recordPending(f, j, "bid-post", "box", {});
  updateAction(f, j, s1, { status: "SENT", sig: "sig1" });
  assert.equal(needsSweep(readJournal(f)!, "box").length, 1, "SENT is unresolved");
  updateAction(f, j, s1, { status: "CONFIRMED" });
  assert.equal(needsSweep(readJournal(f)!, "box").length, 1, "CONFIRMED state exists and must be cleaned");
});

test("CLEARED drops out of the sweep — cancelled OR filled", () => {
  // A filled bid is a SUCCESS, not an orphan. Both outcomes end the obligation,
  // and the sweep must not keep chasing a bid that no longer exists.
  const dir = tmp(); const f = journalPath(dir, "r4");
  const j = initJournal(f, "r4", ROLES, SERIES);
  const s1 = recordPending(f, j, "bid-post", "box", {});
  updateAction(f, j, s1, { status: "CLEARED", note: "filled by the trigger fire" });
  assert.equal(needsSweep(readJournal(f)!, "box").length, 0);
});

test("a sweep only sees state its OWN key can undo", () => {
  // The writer key is VPS-only and the admin key is local-only, so neither host
  // can clean up the other's. A sweep that tried would fail, and a sweep that
  // silently skipped would hide an orphan.
  const dir = tmp(); const f = journalPath(dir, "r5");
  const j = initJournal(f, "r5", ROLES, SERIES);
  recordPending(f, j, "bid-post", "box", {});
  recordPending(f, j, "trigger-place", "local", {});
  const on = readJournal(f)!;
  assert.deepEqual(needsSweep(on, "box").map((a) => a.kind), ["bid-post"]);
  assert.deepEqual(needsSweep(on, "local").map((a) => a.kind), ["trigger-place"]);
});

test("cancel actions never themselves need sweeping", () => {
  const dir = tmp(); const f = journalPath(dir, "r6");
  const j = initJournal(f, "r6", ROLES, SERIES);
  recordPending(f, j, "bid-cancel", "box", {});
  assert.equal(needsSweep(readJournal(f)!, "box").length, 0, "a cancel creates no state");
});

test("openJournals finds unresolved runs and ignores finished ones", () => {
  const dir = tmp();
  const a = journalPath(dir, "open"); const ja = initJournal(a, "open", ROLES, SERIES);
  recordPending(a, ja, "bid-post", "box", {});
  const b = journalPath(dir, "done"); const jb = initJournal(b, "done", ROLES, SERIES);
  const s = recordPending(b, jb, "bid-post", "box", {});
  updateAction(b, jb, s, { status: "CLEARED" });

  const found = openJournals(dir, "box");
  assert.equal(found.length, 1);
  assert.match(found[0], /canary-open\.json$/);
});

test("a corrupt journal reads as null rather than throwing", () => {
  // A sweep that crashes on a damaged journal cleans nothing.
  const dir = tmp(); const f = journalPath(dir, "bad");
  fs.writeFileSync(f, "{not json");
  assert.equal(readJournal(f), null);
  assert.deepEqual(openJournals(dir, "box"), []);
});

test("the write is atomic — a reader never sees a half-written journal", () => {
  const dir = tmp(); const f = journalPath(dir, "atom");
  const j = initJournal(f, "atom", ROLES, SERIES);
  for (let i = 0; i < 25; i++) recordPending(f, j, "bid-post", "box", { i });
  assert.equal(readJournal(f)!.actions.length, 25);
  assert.ok(!fs.existsSync(`${f}.tmp`), "no temp file left behind");
});
