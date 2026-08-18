// Red-first tests for the pot slot guard. Ticket 86eyn5kxa / TP-SL Stage 0.
//
//   run: node crank/node_modules/ts-node/dist/bin.js --transpile-only crank/potSlotGuard.test.ts
//
// Fixtures are real instructions built by Anchor from real (and deliberately
// regressed) IDLs, not hand-assembled key arrays. A hand-made fixture would encode
// my assumption about what Anchor emits; the bug being guarded IS what Anchor
// emits, so the fixture has to come from Anchor.
//
// The case that matters is the partial strip: removing only the two pot-named
// accounts leaves 15 on exercise_american, which is ABOVE the old count guard
// threshold of <= 14. The count guard passes it. The slot guard must not.
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import { PublicKey, Connection, Keypair, type TransactionInstruction } from "@solana/web3.js";
import * as anchor from "@coral-xyz/anchor";

import { assertPotSlots, PotSlotGuardError, POT_SLOTS } from "./potSlotGuard";

const IDL_PATH = path.resolve(__dirname, "../app/src/idl/opta.json");
const IDL = JSON.parse(fs.readFileSync(IDL_PATH, "utf8"));

// Never contacted: instruction assembly is offline.
const provider = new anchor.AnchorProvider(
  new Connection("http://127.0.0.1:1", "confirmed"),
  new anchor.Wallet(Keypair.generate()),
  {},
);

const K = (n: number) => new PublicKey(Buffer.alloc(32, n));
const POT = K(7);
const POT_USDC = K(8);

const SETTLE_ACCOUNTS: Record<string, PublicKey> = {
  authority: K(1), sharedVault: K(2), market: K(3), settlementRecord: K(4),
  vaultUsdcAccount: K(5), optionMint: K(6), writerAskPot: POT,
  writerAskPotUsdc: POT_USDC, protocolState: K(9), tokenProgram: K(10),
};

const clone = (): any => JSON.parse(JSON.stringify(IDL));

function stripFrom(idl: any, ixName: string, names: string[]) {
  const ins = idl.instructions.find((i: any) => i.name === ixName);
  ins.accounts = ins.accounts.filter((a: any) => !names.includes(a.name));
  return idl;
}

async function buildSettle(idl: any): Promise<TransactionInstruction> {
  const program = new anchor.Program(idl, provider);
  const declared = new Set<string>(
    idl.instructions
      .find((i: any) => i.name === "settle_vault")
      .accounts.map((a: any) => a.name),
  );
  const supplied: Record<string, PublicKey> = {};
  for (const [k, v] of Object.entries(SETTLE_ACCOUNTS)) {
    const snake = k.replace(/[A-Z]/g, (c) => "_" + c.toLowerCase());
    if (declared.has(snake) || declared.has(k)) supplied[k] = v;
  }
  return program.methods.settleVault().accountsStrict(supplied).instruction();
}

const EXPECT_SETTLE = [
  { slot: POT_SLOTS.settle_vault.pot, expected: POT, name: "writer_ask_pot" },
  { slot: POT_SLOTS.settle_vault.potUsdc, expected: POT_USDC, name: "writer_ask_pot_usdc" },
];

const fakeIx = (n: number): TransactionInstruction =>
  ({
    keys: Array.from({ length: n }, (_, i) => ({
      pubkey: K(i + 1),
      isSigner: false,
      isWritable: false,
    })),
  }) as unknown as TransactionInstruction;

// ---------------------------------------------------------------------------
// GREEN
// ---------------------------------------------------------------------------

test("current IDL: settle_vault pot sits at [6]/[7] and the guard passes", async () => {
  const ix = await buildSettle(clone());
  assert.equal(ix.keys.length, 10, "settle_vault should build 10 accounts");
  assert.equal(ix.keys[6].pubkey.toBase58(), POT.toBase58());
  assert.equal(ix.keys[7].pubkey.toBase58(), POT_USDC.toBase58());
  assert.doesNotThrow(() =>
    assertPotSlots(ix, EXPECT_SETTLE, { instruction: "settle_vault" }),
  );
});

// ---------------------------------------------------------------------------
// RED
// ---------------------------------------------------------------------------

test("RED: a stale IDL drops the pot arm silently, and the guard fires", async () => {
  const ix = await buildSettle(
    stripFrom(clone(), "settle_vault", ["writer_ask_pot", "writer_ask_pot_usdc"]),
  );
  // Anchor emits the SHORT instruction without complaint. This is the bug.
  assert.equal(ix.keys.length, 8, "Anchor silently drops the undeclared accounts");
  assert.throws(
    () => assertPotSlots(ix, EXPECT_SETTLE, { instruction: "settle_vault" }),
    PotSlotGuardError,
  );
});

test("RED: right length, wrong content — a count guard passes, the slot guard fires", async () => {
  const ix = await buildSettle(clone());
  const tampered = {
    ...ix,
    keys: ix.keys.map((k, i) => (i === 6 ? { ...k, pubkey: K(99) } : k)),
  } as TransactionInstruction;

  assert.equal(tampered.keys.length, 10, "count is unchanged, so a count guard passes");
  assert.throws(
    () => assertPotSlots(tampered, EXPECT_SETTLE, { instruction: "settle_vault" }),
    PotSlotGuardError,
  );
});

test("RED: swapped pot / pot_usdc fires even though both keys are present", async () => {
  const ix = await buildSettle(clone());
  const swapped = {
    ...ix,
    keys: ix.keys.map((k, i) =>
      i === 6 ? { ...k, pubkey: POT_USDC } : i === 7 ? { ...k, pubkey: POT } : k,
    ),
  } as TransactionInstruction;
  assert.throws(
    () => assertPotSlots(swapped, EXPECT_SETTLE, { instruction: "settle_vault" }),
    PotSlotGuardError,
    "ordering is load-bearing; both-present is not good enough",
  );
});

// ---------------------------------------------------------------------------
// The exercise_american partial strip — the case that beat the count guard
// ---------------------------------------------------------------------------

test("exercise_american: the pot arm is THREE accounts, so a partial strip leaves 15", () => {
  const full = IDL.instructions.find((i: any) => i.name === "exercise_american");
  assert.equal(full.accounts.length, 17);

  const partial = stripFrom(clone(), "exercise_american", [
    "writer_ask_pot",
    "writer_ask_pot_usdc",
  ]).instructions.find((i: any) => i.name === "exercise_american");
  assert.equal(partial.accounts.length, 15);

  const legacy = stripFrom(clone(), "exercise_american", [
    "writer_ask_pot",
    "writer_ask_pot_usdc",
    "protocol_state",
  ]).instructions.find((i: any) => i.name === "exercise_american");
  assert.equal(legacy.accounts.length, 14);

  // The old guard: potExists && keys.length <= 14.
  const countGuardFires = (n: number) => n <= 14;
  assert.equal(countGuardFires(legacy.accounts.length), true, "count guard catches full legacy");
  assert.equal(
    countGuardFires(partial.accounts.length),
    false,
    "count guard MISSES the partial strip — this is why the slot guard exists",
  );
});

test("slot guard fires on the 15-account partial strip the count guard missed", () => {
  assert.throws(
    () =>
      assertPotSlots(
        fakeIx(15),
        [
          { slot: POT_SLOTS.exercise_american.pot, expected: POT, name: "writer_ask_pot" },
          {
            slot: POT_SLOTS.exercise_american.potUsdc,
            expected: POT_USDC,
            name: "writer_ask_pot_usdc",
          },
        ],
        { instruction: "exercise_american" },
      ),
    PotSlotGuardError,
  );
});

test("execute_trigger slots [25]/[26] are guarded the same way", () => {
  assert.throws(
    () =>
      assertPotSlots(
        fakeIx(32),
        [
          { slot: POT_SLOTS.execute_trigger.pot, expected: POT, name: "writer_ask_pot" },
          {
            slot: POT_SLOTS.execute_trigger.potUsdc,
            expected: POT_USDC,
            name: "writer_ask_pot_usdc",
          },
        ],
        { instruction: "execute_trigger" },
      ),
    PotSlotGuardError,
    "full-length list with the wrong keys at [25]/[26] must fire",
  );
});

test("a too-short instruction reports absence, not a mismatch", () => {
  try {
    assertPotSlots(fakeIx(14), [{ slot: 14, expected: POT, name: "writer_ask_pot" }], {
      instruction: "exercise_american",
    });
    assert.fail("should have thrown");
  } catch (e) {
    assert.ok(e instanceof PotSlotGuardError);
    assert.match((e as Error).message, /carries only 14 accounts/);
  }
});

test("the error names the stale IDL as the cause", () => {
  try {
    assertPotSlots(fakeIx(0), [{ slot: 6, expected: POT, name: "writer_ask_pot" }], {
      instruction: "settle_vault",
    });
    assert.fail("should have thrown");
  } catch (e) {
    assert.match((e as Error).message, /app\/src\/idl\/opta\.json/);
  }
});

test("POT_SLOTS match the IDL actually on disk", () => {
  const at = (ix: string, i: number) =>
    IDL.instructions.find((x: any) => x.name === ix).accounts[i].name;
  assert.equal(at("settle_vault", POT_SLOTS.settle_vault.pot), "writer_ask_pot");
  assert.equal(at("settle_vault", POT_SLOTS.settle_vault.potUsdc), "writer_ask_pot_usdc");
  assert.equal(at("exercise_american", POT_SLOTS.exercise_american.pot), "writer_ask_pot");
  assert.equal(
    at("exercise_american", POT_SLOTS.exercise_american.potUsdc),
    "writer_ask_pot_usdc",
  );
  assert.equal(at("execute_trigger", POT_SLOTS.execute_trigger.pot), "writer_ask_pot");
  assert.equal(at("execute_trigger", POT_SLOTS.execute_trigger.potUsdc), "writer_ask_pot_usdc");
});
