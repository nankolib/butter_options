// ============================================================================
// crank/ed25519SelfPack.test.ts -- offline geometry validation for the self-packer
// ============================================================================
//
// Vanilla TS + node:assert, no framework, no network (mirrors
// crank/volOracleCrank.test.ts). Run via:
//   ts-node --transpile-only -r tsconfig-paths/register ed25519SelfPack.test.ts
//
// Fixture: the two known-good gateway triples (oracle_idx 8 & 2) from the FAIL
// run captured in .opta-build/sb-ed25519-diag.json (gitignored scratch). Both
// were independently verified upstream; here we prove our CORRECT 2-sig packing
// resolves and verifies where the SDK's 1-sig geometry collides.
//
// Signature verification uses tweetnacl (already resolved transitively via
// @solana/web3.js -> no new dependency, no @noble/ed25519 added to the lockfile).
//
// What's covered:
//   - packEd25519Ix produces the exact N=2 / L=81 byte layout (offsets + total)
//   - decode-by-following-our-own-offsets resolves both (sig, pubkey, message)
//   - tweetnacl verifies BOTH signatures (the gate)
//   - oracle indexes are packed in sorted (queue) order
//
// The live/devnet leg (real fetchManagedUpdateIxs + simulate) stays a manual
// smoke -- see .opta-build/sb-ed25519-selfpack.mjs -- not a committed test.
// ============================================================================

import assert from "node:assert/strict";

import { Ed25519Program } from "@solana/web3.js";
import { packEd25519Ix, decodeAndVerifyEd25519, Ed25519Triple } from "./ed25519SelfPack";

// tweetnacl ships no bundled types; require + typed cast keeps `npm run
// typecheck` clean without pulling a @types package or a new dependency.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nacl = require("tweetnacl") as {
  sign: { detached: { verify(message: Uint8Array, signature: Uint8Array, publicKey: Uint8Array): boolean } };
};
const verify = (m: Uint8Array, s: Uint8Array, p: Uint8Array): boolean => nacl.sign.detached.verify(m, s, p);

// ---- Fixture: FAIL-run gateway triples (oracle_idx 8 & 2), shared 81-byte msg.
const FIXTURE_SLOT = 471620622;
const FIXTURE_TRIPLES: Ed25519Triple[] = [
  {
    oracleIdx: 8,
    pubkey: Buffer.from("80f74c529604a9648d45568ffe404c328893b2eddbc32ca13b7796872a395402", "hex"),
    signature: Buffer.from(
      "/3jRAM9h0v2+qrzgxq2ReGX39b7xXg3R8uzqhoKmG6ZhgdyW33142ZecqWuFCZewIIR+ZPqr3FjSeIXCyHvaAg==",
      "base64",
    ),
    message: Buffer.from(
      "LCbuJAvnC4C7xv3ZUPegafIO3Pcyso5S7Opd9TN9IXhsPFzHINH/2BCKyiK/eDTWWWErfhpOX2I7doRtEWc1XgAADmyE+ynD2wAAAAAAAAAC",
      "base64",
    ),
  },
  {
    oracleIdx: 2,
    pubkey: Buffer.from("4f47553c429224df7cae33b94e2021b8a33c3b590be09d3862941c7416b435b3", "hex"),
    signature: Buffer.from(
      "Tmf5OFUI6HM9u6MdTWIkeRHwPogqmbB5UPGMe8KeKMV1umUFpwlLy95zCZdZr0UcEpDyi4F/904bJF4G6jeuDQ==",
      "base64",
    ),
    message: Buffer.from(
      "LCbuJAvnC4C7xv3ZUPegafIO3Pcyso5S7Opd9TN9IXhsPFzHINH/2BCKyiK/eDTWWWErfhpOX2I7doRtEWc1XgAADmyE+ynD2wAAAAAAAAAC",
      "base64",
    ),
  },
];

let passed = 0;
const test = (name: string, fn: () => void): void => {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
};

console.log("ed25519SelfPack offline geometry validation");

const INSTRUCTION_IDX = 1;
const ix = packEd25519Ix(FIXTURE_TRIPLES, INSTRUCTION_IDX, FIXTURE_SLOT, 0);
const data = Buffer.from(ix.data);

test("emits an Ed25519Program instruction", () => {
  assert.equal(ix.programId.toBase58(), Ed25519Program.programId.toBase58());
  assert.equal(ix.keys.length, 0);
});

test("byte layout matches the N=2 / L=81 table (total 318, header N=2)", () => {
  assert.equal(data.length, 318, "total length");
  assert.equal(data[0], 2, "num_signatures");
  assert.equal(data[1], 0, "padding");
});

test("offset structs follow correct 2-sig geometry (sig0@30/pk0@94, sig1@126/pk1@190, msg@222)", () => {
  const off = (i: number) => {
    const b = 2 + i * 14;
    return {
      signatureOffset: data.readUInt16LE(b + 0),
      signatureInstructionIndex: data.readUInt16LE(b + 2),
      publicKeyOffset: data.readUInt16LE(b + 4),
      publicKeyInstructionIndex: data.readUInt16LE(b + 6),
      messageDataOffset: data.readUInt16LE(b + 8),
      messageDataSize: data.readUInt16LE(b + 10),
      messageInstructionIndex: data.readUInt16LE(b + 12),
    };
  };
  const o0 = off(0);
  const o1 = off(1);
  // sorted by oracleIdx asc -> oracle_idx 2 first, then 8
  assert.deepEqual(o0, { signatureOffset: 30, signatureInstructionIndex: 1, publicKeyOffset: 94, publicKeyInstructionIndex: 1, messageDataOffset: 222, messageDataSize: 81, messageInstructionIndex: 1 });
  assert.deepEqual(o1, { signatureOffset: 126, signatureInstructionIndex: 1, publicKeyOffset: 190, publicKeyInstructionIndex: 1, messageDataOffset: 222, messageDataSize: 81, messageInstructionIndex: 1 });
});

test("trailing metadata: oracle_indexes sorted [2,8], version 0, SBOD", () => {
  assert.equal(data[303], 2, "oracle_idx[0] (sorted)");
  assert.equal(data[304], 8, "oracle_idx[1] (sorted)");
  assert.equal(Number(data.readBigUInt64LE(305)), FIXTURE_SLOT, "recent_slot");
  assert.equal(data[313], 0, "version");
  assert.equal(data.subarray(314, 318).toString("utf8"), "SBOD", "discriminator");
});

test("decode-by-following-offsets verifies BOTH signatures (tweetnacl)", () => {
  const decoded = decodeAndVerifyEd25519(data, verify);
  assert.equal(decoded.numSignatures, 2);
  assert.equal(decoded.slices.length, 2);
  for (const s of decoded.slices) {
    assert.equal(s.message.length, 81, `sig[${s.index}] message length`);
    assert.equal(s.verified, true, `sig[${s.index}] noble/tweetnacl verify`);
  }
  assert.equal(decoded.allVerified, true, "all signatures verify");
});

test("rejects mismatched messages across triples", () => {
  const bad: Ed25519Triple[] = [
    FIXTURE_TRIPLES[0],
    { ...FIXTURE_TRIPLES[1], message: Buffer.concat([Buffer.from(FIXTURE_TRIPLES[1].message), Buffer.from([0])]) },
  ];
  assert.throws(() => packEd25519Ix(bad, 1, FIXTURE_SLOT, 0), /identical message/);
});

console.log(`\n${passed} passed`);
