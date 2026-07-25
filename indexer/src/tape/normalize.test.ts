// Tape normalization proof. run: npx ts-node --transpile-only src/tape/normalize.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import bs58 from "bs58";
import { BorshEventCoder, type Idl } from "@coral-xyz/anchor";

import { ALLOWLIST, DEAD_DO_NOT_HANDLE } from "./allowlist";
import { EventDecoder } from "./eventDecode";
import { IX_TARGETS } from "./ixDecode";
import { fullAccountKeys, normalize, type RawTx } from "./normalize";

const PROGRAM = "CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq";
const IDL_PATH = path.resolve(__dirname, "../../../app/src/idl/opta.json");
const idl = JSON.parse(fs.readFileSync(IDL_PATH, "utf8")) as Idl;
const decoder = new EventDecoder(idl);

/** Encode an event the way the runtime does: disc8 || borsh(payload), base64. */
function encodeEvent(name: string, fields: Record<string, unknown>): string {
  const coder = new BorshEventCoder(idl);
  // BorshEventCoder has no encoder; build the payload from the IDL layout via
  // the same path the decoder uses, by round-tripping through anchor's types.
  // Simpler and sufficient here: hand-pack using the known field order.
  const ty = (idl as unknown as { types: { name: string; type: { fields: { name: string; type: unknown }[] } }[] }).types.find(
    (t) => t.name === name,
  );
  assert.ok(ty, `type ${name} missing from IDL`);
  const parts: Buffer[] = [createHash("sha256").update(`event:${name}`).digest().subarray(0, 8)];
  for (const f of ty!.type.fields) {
    const v = fields[f.name];
    if (f.type === "pubkey") parts.push(Buffer.from(bs58.decode(v as string)));
    else if (f.type === "u64" || f.type === "i64") {
      const b = Buffer.alloc(8);
      b.writeBigInt64LE(BigInt(v as number));
      parts.push(b);
    } else if (f.type === "u128") {
      const b = Buffer.alloc(16);
      b.writeBigUInt64LE(BigInt(v as number), 0);
      parts.push(b);
    } else if (f.type === "u8") parts.push(Buffer.from([Number(v)]));
    else if (f.type === "u32") {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(Number(v));
      parts.push(b);
    } else if (f.type === "bool") parts.push(Buffer.from([v ? 1 : 0]));
    else throw new Error(`unhandled IDL type ${JSON.stringify(f.type)} for ${name}.${f.name}`);
  }
  void coder;
  return Buffer.concat(parts).toString("base64");
}

const A = "DnExEYnZGuEu7xgpmNupJVXJLbMbkNdf3E7f28Zv6LUQ";
const B = "8Xh9UpbjXft1o2PKiKSU2Hz2pPtyju3mZ4AaenTL6ngE";
const MINT = "GkG1UX8ML4UzNSGUtJxBWfRRWCdH7YejdhfuxFWTRFAx";
const VAULT = "QpR6CuTbmCVnJVfm5kxGip1C1j5BeX1rq97GesBJToZ";
const ORDER = "H3mMcwjti7dGv2ucDmT5ebXwbs5e1qrq5voemfwV6c8b";

function rawTx(over: Partial<RawTx> = {}, logs: string[] = []): RawTx {
  return {
    slot: 100,
    blockTime: 1_783_000_000,
    transaction: {
      signatures: ["SIG1"],
      message: { accountKeys: [A, PROGRAM], instructions: [] },
    },
    meta: { err: null, logMessages: logs, loadedAddresses: null },
    ...over,
  };
}

test("allowlist and dead-list are disjoint — the 9 corpses can never be handled", () => {
  for (const dead of DEAD_DO_NOT_HANDLE) {
    assert.equal(dead in ALLOWLIST, false, `${dead} must not be allowlisted`);
  }
  assert.equal(DEAD_DO_NOT_HANDLE.length, 9);
});

test("every allowlisted name exists in the IDL", () => {
  const idlNames = new Set((idl.events ?? []).map((e) => e.name));
  for (const name of Object.keys(ALLOWLIST)) {
    assert.ok(idlNames.has(name), `${name} not in IDL`);
  }
});

test("every allowlisted field name exists on its IDL type", () => {
  const types = (idl as unknown as { types: { name: string; type: { fields?: { name: string }[] } }[] }).types;
  for (const [name, map] of Object.entries(ALLOWLIST)) {
    const fields = new Set(types.find((t) => t.name === name)?.type?.fields?.map((f) => f.name) ?? []);
    const refs = [
      map.wallet,
      map.counterparty,
      map.vault,
      map.optionMint,
      map.kind,
      map.amountUsdc,
      ...(map.amountUsdcProduct ?? []),
      map.quantity,
    ].filter((x): x is string => typeof x === "string");
    for (const r of refs) assert.ok(fields.has(r), `${name}.${r} missing from IDL`);
  }
});

test("OrderFilled decodes to normalized columns with maker as counterparty", () => {
  const b64 = encodeEvent("OrderFilled", {
    order: ORDER,
    option_mint: MINT,
    vault: VAULT,
    kind: 2,
    maker: B,
    taker: A,
    price_per_contract: 1_500_000,
    fill_quantity: 3,
    fee: 100,
    quantity_remaining: 7,
    ts: 1_783_000_000,
  });
  const { tx, events } = normalize(rawTx({}, [`Program data: ${b64}`]), decoder, PROGRAM);

  assert.equal(tx.ok, 1);
  assert.equal(tx.truncated, 0);
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.id, "SIG1:0");
  assert.equal(e.name, "OrderFilled");
  assert.equal(e.source, "log");
  assert.equal(e.wallet, A);
  assert.equal(e.counterparty, B);
  assert.equal(e.option_mint, MINT);
  assert.equal(e.vault, VAULT);
  assert.equal(e.kind, 2);
  assert.equal(e.quantity, 3);
  assert.equal(e.amount_usdc, 4_500_000); // price x qty
  assert.equal(JSON.parse(e.fields_json).price_per_contract, "1500000"); // u64 as string
});

test("aggregate events keep wallet NULL", () => {
  const b64 = encodeEvent("HoldersFinalized", {
    vault: VAULT,
    mint: MINT,
    holders_processed: 4,
    total_burned: 12,
    total_paid_out: 999,
  });
  const { events } = normalize(rawTx({}, [`Program data: ${b64}`]), decoder, PROGRAM);
  assert.equal(events.length, 1);
  assert.equal(events[0].wallet, null);
  assert.equal(events[0].vault, VAULT);
  assert.equal(events[0].quantity, 12);
});

test("failed transactions are recorded with ok=0 and produce ZERO events", () => {
  const b64 = encodeEvent("VaultExercised", { vault: VAULT, holder: A, quantity: 1, payout: 5 });
  const raw = rawTx({ meta: { err: { InstructionError: [0, "Custom"] }, logMessages: [`Program data: ${b64}`] } }, []);
  const { tx, events } = normalize(raw, decoder, PROGRAM);
  assert.equal(tx.ok, 0);
  assert.equal(events.length, 0);
});

test("log truncation is flagged on the tx row", () => {
  const { tx } = normalize(rawTx({}, ["Log truncated"]), decoder, PROGRAM);
  assert.equal(tx.truncated, 1);
});

test("ix-decode extracts the actor from account index 0 for all three targets", () => {
  for (const target of IX_TARGETS) {
    const disc = createHash("sha256").update(`global:${target.name}`).digest().subarray(0, 8);
    const data = bs58.encode(Buffer.concat([disc, Buffer.alloc(8)]));
    const keys = [A, B, MINT, VAULT, ORDER, PROGRAM];
    const raw = rawTx({
      transaction: {
        signatures: ["SIG2"],
        message: {
          accountKeys: keys,
          instructions: [{ programIdIndex: 5, accounts: [0, 1, 2, 3, 4], data }],
        },
      },
    });
    const { events } = normalize(raw, decoder, PROGRAM);
    assert.equal(events.length, 1, target.name);
    assert.equal(events[0].name, target.eventName);
    assert.equal(events[0].source, "ix");
    assert.equal(events[0].wallet, A, `${target.name} actor`);
    assert.equal(events[0].ix_index, 0);
  }
});

test("instructions from other programs are ignored", () => {
  const disc = createHash("sha256").update("global:settle_expiry").digest().subarray(0, 8);
  const raw = rawTx({
    transaction: {
      signatures: ["SIG3"],
      message: {
        accountKeys: [A, B, "11111111111111111111111111111111"],
        instructions: [{ programIdIndex: 2, accounts: [0, 1], data: bs58.encode(disc) }],
      },
    },
  });
  assert.equal(normalize(raw, decoder, PROGRAM).events.length, 0);
});

test("fullAccountKeys appends ALT-loaded addresses in canonical order", () => {
  const raw = rawTx({
    meta: { err: null, logMessages: [], loadedAddresses: { writable: [MINT], readonly: [VAULT] } },
  });
  assert.deepEqual(fullAccountKeys(raw), [A, PROGRAM, MINT, VAULT]);
});

test("ids are deterministic — re-normalizing yields identical rows", () => {
  const b64 = encodeEvent("VaultExercised", { vault: VAULT, holder: A, quantity: 2, payout: 7 });
  const mk = () => normalize(rawTx({}, [`Program data: ${b64}`]), decoder, PROGRAM);
  assert.deepEqual(mk(), mk());
  assert.equal(mk().events[0].id, "SIG1:0");
});
