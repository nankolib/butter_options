// Tests for TP/SL bundle assembly — 2C.
//
//   run: node crank/node_modules/ts-node/dist/bin.js --transpile-only //        -r tsconfig-paths/register crank/triggerBundle.test.ts
//
// LIVES IN crank/, NOT app/. The module under test is app-side, but app/ is
// "type": "module" with no wired test runner — every existing app/*.test.ts fails
// the same extensionless-ESM resolution. crank/ has a working ts-node +
// tsconfig-paths setup and is the suite that actually runs before a push, so the
// test goes where it will be RUN rather than where it looks tidiest. It imports
// through the @app alias exactly as crank/bot.ts does.
//
// The two properties that matter, and both are about what CANNOT happen:
//
//   1. a pair is ONE transaction, so a half-pair cannot exist. Placed separately,
//      an interruption leaves the user believing they hold OCO while holding two
//      independent triggers — both legs can then fire. That is the double exit in
//      user clothing.
//
//   2. a linked cancel cannot be built without its peer. The keeper hit this exact
//      bug from the other side (assembleExecuteAccounts omitted oco_peer and could
//      not build a fire at all); a blanket null here is the same bug in client
//      clothing — it builds fine and is rejected on chain (6087) for precisely the
//      orders OCO exists to protect.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { BN } from "@coral-xyz/anchor";
import * as anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, Transaction, ComputeBudgetProgram,
} from "@solana/web3.js";

import {
  buildTriggerPlacement, buildTriggerCancel, buildTriggerCancelFor,
  deriveTriggerOrder, peerOf, type TriggerLeg, type TriggerSeriesCtx,
} from "@app/utils/triggerBundle";

const ROOT = path.resolve(__dirname, "..");
const IDL = JSON.parse(fs.readFileSync(path.join(ROOT, "app/src/idl/opta.json"), "utf8"));

const owner = Keypair.generate();
const provider = new anchor.AnchorProvider(
  new Connection("http://127.0.0.1:1", "confirmed"), // never contacted
  new anchor.Wallet(owner), {},
);
const program = new anchor.Program(IDL, provider);

const K = (n: number) => new PublicKey(Buffer.alloc(32, n));
const ctx: TriggerSeriesCtx = {
  program, owner: owner.publicKey,
  market: K(1), sharedVault: K(2), optionMint: K(3), usdcMint: K(4),
};

const leg = (over: Partial<TriggerLeg> = {}): TriggerLeg => ({
  kind: "takeProfitSell",
  comparator: "ge",
  thresholdUsdc: new BN(50_000_000),
  quantity: new BN(2),
  minProceedsUsdc: new BN(10_000),
  nonce: new BN(1001),
  ...over,
});

const TP = leg();
const SL = leg({ kind: "stopLossSell", comparator: "le", nonce: new BN(1002) });

// ---------------------------------------------------------------------------
// Shapes: pair, TP-only, SL-only
// ---------------------------------------------------------------------------

test("PAIR: two placements plus link_oco, in ONE bundle", async () => {
  const b = await buildTriggerPlacement(ctx, { takeProfit: TP, stopLoss: SL });
  assert.equal(b.instructions.length, 3, "place + place + link");
  assert.equal(b.orders.length, 2);
  assert.equal(b.linked, true);
});

test("TP-ONLY: one placement, NO link", async () => {
  const b = await buildTriggerPlacement(ctx, { takeProfit: TP });
  assert.equal(b.instructions.length, 1);
  assert.equal(b.orders.length, 1);
  assert.equal(b.linked, false, "a lone leg must not be linked to anything");
});

test("SL-ONLY: one placement, NO link — a protective stop stands alone", async () => {
  const b = await buildTriggerPlacement(ctx, { stopLoss: SL });
  assert.equal(b.instructions.length, 1);
  assert.equal(b.linked, false);
});

test("neither leg is a caller bug, not an empty transaction", async () => {
  await assert.rejects(
    () => buildTriggerPlacement(ctx, {}),
    /at least one leg/,
  );
});

test("TP and SL must use distinct nonces, or the 'pair' is one order", async () => {
  // Same nonce on one series derives the SAME PDA. Silently building that would
  // produce a bundle whose second init fails — or worse, reads as a pair.
  await assert.rejects(
    () => buildTriggerPlacement(ctx, { takeProfit: TP, stopLoss: leg({ kind: "stopLossSell", nonce: TP.nonce }) }),
    /distinct nonces/,
  );
});

test("the two legs derive DIFFERENT order PDAs", async () => {
  const a = deriveTriggerOrder(program.programId, owner.publicKey, ctx.optionMint, TP.nonce);
  const b = deriveTriggerOrder(program.programId, owner.publicKey, ctx.optionMint, SL.nonce);
  assert.notEqual(a.toBase58(), b.toBase58());
});

// ---------------------------------------------------------------------------
// THE ATOMICITY PROPERTY — measured, not asserted
// ---------------------------------------------------------------------------

test("the PAIR bundle fits in ONE transaction (this is what makes it atomic)", async () => {
  const b = await buildTriggerPlacement(ctx, { takeProfit: TP, stopLoss: SL });
  const tx = new Transaction({
    feePayer: owner.publicKey,
    recentBlockhash: "11111111111111111111111111111111",
  });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }));
  b.instructions.forEach((i) => tx.add(i));
  const bytes = tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;

  assert.ok(bytes <= 1232, `pair bundle must fit 1232 bytes, got ${bytes}`);
  // Recorded so a future account addition that pushes it over fails HERE, at the
  // desk, rather than as a wallet error the user cannot act on.
  assert.ok(bytes > 700, `sanity: expected a substantial tx, got ${bytes}`);
});

test("a single leg is comfortably smaller than the pair", async () => {
  const mk = async (legs: any) => {
    const b = await buildTriggerPlacement(ctx, legs);
    const tx = new Transaction({ feePayer: owner.publicKey, recentBlockhash: "11111111111111111111111111111111" });
    b.instructions.forEach((i) => tx.add(i));
    return tx.serialize({ requireAllSignatures: false, verifySignatures: false }).length;
  };
  const one = await mk({ takeProfit: TP });
  const two = await mk({ takeProfit: TP, stopLoss: SL });
  assert.ok(one < two, `single ${one} must be smaller than pair ${two}`);
  assert.ok(two <= 1232);
});

// ---------------------------------------------------------------------------
// CANCEL — the null-peer bug must be unavailable
// ---------------------------------------------------------------------------

test("cancel of an UNLINKED order passes a null peer, which is correct", async () => {
  const order = deriveTriggerOrder(program.programId, owner.publicKey, ctx.optionMint, TP.nonce);
  const ix = await buildTriggerCancelFor(ctx, order, { ocoLink: null, quantity: new BN(1) });
  // 7 accounts; the optional peer is the program-id sentinel when absent.
  assert.equal(ix.keys.length, 7);
  assert.ok(ix.keys[6].pubkey.equals(program.programId), "[6] oco_peer sentinel on an unlinked order");
});

test("cancel of a LINKED order carries the REAL peer at [6]", async () => {
  const a = deriveTriggerOrder(program.programId, owner.publicKey, ctx.optionMint, TP.nonce);
  const b = deriveTriggerOrder(program.programId, owner.publicKey, ctx.optionMint, SL.nonce);
  const ix = await buildTriggerCancelFor(ctx, a, { ocoLink: b, quantity: new BN(1) });
  assert.equal(ix.keys.length, 7);
  assert.ok(ix.keys[6].pubkey.equals(b), "the peer must be the linked PDA, not a sentinel");
});

test("RED: a linked cancel built with a NULL peer is the 6087 revert, pre-flighted", async () => {
  // The low-level builder still allows the wrong shape, deliberately, so this
  // test can construct it. What must not happen is a CALLER reaching it.
  const a = deriveTriggerOrder(program.programId, owner.publicKey, ctx.optionMint, TP.nonce);
  const b = deriveTriggerOrder(program.programId, owner.publicKey, ctx.optionMint, SL.nonce);

  const wrong = await buildTriggerCancel(ctx, a, null);
  assert.ok(
    wrong.keys[6].pubkey.equals(program.programId),
    "a null peer builds a SENTINEL — it does not fail locally, which is the trap",
  );

  // The checked path is what callers use, and it cannot produce that shape for a
  // linked order.
  const right = await buildTriggerCancelFor(ctx, a, { ocoLink: b });
  assert.ok(right.keys[6].pubkey.equals(b));
  assert.notEqual(
    wrong.keys[6].pubkey.toBase58(), right.keys[6].pubkey.toBase58(),
    "the two shapes must be distinguishable, or this test proves nothing",
  );
});

test("the checked cancel refuses to guess when the account was not fetched", async () => {
  const a = deriveTriggerOrder(program.programId, owner.publicKey, ctx.optionMint, TP.nonce);
  await assert.rejects(
    () => buildTriggerCancelFor(ctx, a, null as unknown as object),
    /fetched TriggerOrder is required/,
  );
});

test("peerOf reads both casings and null", () => {
  const b = K(9);
  assert.equal(peerOf({ ocoLink: b })!.toBase58(), b.toBase58());
  assert.equal(peerOf({ oco_link: b })!.toBase58(), b.toBase58());
  assert.equal(peerOf({ ocoLink: null }), null);
  assert.equal(peerOf({}), null);
});

// ---------------------------------------------------------------------------
// v1 tape lock
// ---------------------------------------------------------------------------

test("v1 places UNDERLYING tape only", async () => {
  // The contract branch is live on chain but must not be reachable from the FE
  // until one contract-tape canary fire is verified. The arg is constructed
  // internally, so there is no caller-supplied path to Contract at all.
  const b = await buildTriggerPlacement(ctx, { takeProfit: TP });
  const data = b.instructions[0].data;
  // tape is the final byte of the arg tail: 0 = Underlying, 1 = Contract.
  assert.equal(data[data.length - 1], 0, "tape byte must encode Underlying (0)");
});
