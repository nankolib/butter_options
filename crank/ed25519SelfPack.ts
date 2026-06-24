// =============================================================================
// crank/ed25519SelfPack.ts — correct multi-signature Ed25519 precompile packer
// =============================================================================
//
// WHY THIS EXISTS (workaround):
//   @switchboard-xyz/on-demand@3.10.3 / 3.10.4 mis-pack the multi-signature
//   Ed25519 verification instruction. `Ed25519InstructionUtils.build-
//   Ed25519Instruction` hardcodes DATA_START = 16 (the 1-signature table size,
//   2 + 14*1). For numSignatures >= 2 the offset table and the signature/pubkey
//   blobs reuse that 1-sig geometry, so sig1/pubkey1 overlap and overwrite
//   pubkey0/message — the native precompile then rejects with Custom:2 and the
//   downstream quote program never runs. Both gateway-declared signatures are
//   individually valid; only the SDK's packing is wrong.
//
//   This module re-packs the Ed25519 instruction correctly from the SAME
//   verified triples the SDK fed to its packer (captured upstream — see
//   switchboardQuotePost.ts), with proper N-signature geometry.
//
// RIP-OUT TRIGGER:
//   Delete this file (and switchboardQuotePost.ts's swap) the moment Switchboard
//   ships a fixed `buildEd25519Instruction` upstream. At that point the SDK's
//   returned Ed25519 instruction can be used verbatim.
//
// ROOT-CAUSE WRITE-UP:
//   .opta-build/sb-ed25519-rootcause.md  (offset-table analysis + noble proof)
//
// PORTABILITY: this file depends ONLY on @solana/web3.js — no Switchboard SDK,
// no Anchor. Keep it that way so it is trivially testable and trivially removed.
// =============================================================================

import { TransactionInstruction, Ed25519Program } from "@solana/web3.js";

// Solana Ed25519 precompile constants.
const SIG_LEN = 64; // ed25519 signature
const PK_LEN = 32; // ed25519 public key
const OFF_LEN = 14; // one Ed25519SignatureOffsets struct (7 x u16 LE)
const HDR = 2; // num_signatures (u8) + padding (u8)
const STRIDE = SIG_LEN + PK_LEN; // 96 — per-signature blob (sig followed by pubkey)

/** One verified oracle attestation: a (signature, pubkey, message) triple plus
 *  the oracle's queue index. The message is the bytes the oracle actually
 *  signed (shared across all signatures of a single update). */
export interface Ed25519Triple {
  oracleIdx: number;
  signature: Uint8Array; // 64 bytes
  pubkey: Uint8Array; //    32 bytes
  message: Uint8Array; //   shared across triples
}

/** Decoded Ed25519SignatureOffsets struct (all u16 LE). */
export interface Ed25519OffsetStruct {
  signatureOffset: number;
  signatureInstructionIndex: number;
  publicKeyOffset: number;
  publicKeyInstructionIndex: number;
  messageDataOffset: number;
  messageDataSize: number;
  messageInstructionIndex: number;
}

export interface DecodedSlice {
  index: number;
  struct: Ed25519OffsetStruct;
  signature: Uint8Array;
  pubkey: Uint8Array;
  message: Uint8Array;
  verified: boolean;
}

export interface DecodedEd25519 {
  numSignatures: number;
  padding: number;
  dataLen: number;
  slices: DecodedSlice[];
  allVerified: boolean;
}

/**
 * Pack a correct N-signature Ed25519 precompile instruction.
 *
 * Layout (N signatures, common message length L):
 *   [0]  num_signatures (u8 = N)
 *   [1]  padding (u8 = 0)
 *   2 .. 2+14N        N offset structs (14 bytes each, u16 LE)
 *   DATA_START = 2 + 14N
 *   DATA_START + i*96 : sig_i (64) then pubkey_i (32)   — sig0,pk0,sig1,pk1,...
 *   DATA_START + N*96 : message (L)                     — single shared copy
 *   + oracle_indexes (N x u8) | recent_slot (u64 LE) | version (u8) | "SBOD" (4)
 *
 * Every offset struct's *_instruction_index = `instructionIdx` (the concrete tx
 * position of THIS ed25519 ix), and message_data_offset is shared across structs.
 * The trailing oracle_indexes/slot/version/"SBOD" mirror the SDK's intended
 * format so the on-chain quote program reads them at the expected positions.
 *
 * Triples are sorted by oracleIdx ascending (queue order — required for the
 * on-chain oracle_keys match), matching the SDK's own sort.
 */
export function packEd25519Ix(
  triplesIn: Ed25519Triple[],
  instructionIdx: number,
  recentSlot: number | bigint | string,
  version: number,
): TransactionInstruction {
  if (!Array.isArray(triplesIn) || triplesIn.length === 0) {
    throw new Error("packEd25519Ix: triples must be a non-empty array");
  }
  if (!Number.isFinite(instructionIdx) || instructionIdx < 0) {
    throw new Error("packEd25519Ix: instructionIdx must be a non-negative finite number");
  }

  // Normalize to Buffers, validate, sort by oracleIdx ascending.
  const triples = triplesIn
    .map((t) => {
      if (typeof t.oracleIdx !== "number") throw new Error("packEd25519Ix: triple missing numeric oracleIdx");
      const signature = Buffer.from(t.signature);
      const pubkey = Buffer.from(t.pubkey);
      const message = Buffer.from(t.message);
      if (signature.length !== SIG_LEN) throw new Error(`packEd25519Ix: signature length ${signature.length} != ${SIG_LEN}`);
      if (pubkey.length !== PK_LEN) throw new Error(`packEd25519Ix: pubkey length ${pubkey.length} != ${PK_LEN}`);
      return { oracleIdx: t.oracleIdx, signature, pubkey, message };
    })
    .sort((a, b) => a.oracleIdx - b.oracleIdx);

  const N = triples.length;
  const message = triples[0].message; // shared common message
  const L = message.length;
  for (const t of triples) {
    if (!t.message.equals(message)) throw new Error("packEd25519Ix: all triples must share an identical message");
  }

  const DATA_START = HDR + OFF_LEN * N; // 30 for N=2
  const msgOffset = DATA_START + N * STRIDE; // 222 for N=2, L=81
  const oracleIdxOffset = msgOffset + L;
  const slotOffset = oracleIdxOffset + N;
  const versionOffset = slotOffset + 8;
  const sbodOffset = versionOffset + 1;
  const total = sbodOffset + 4;

  const data = Buffer.alloc(total);
  data[0] = N; // num_signatures
  data[1] = 0; // padding

  // Offset structs.
  for (let i = 0; i < N; i++) {
    const base = HDR + i * OFF_LEN;
    const sigOff = DATA_START + i * STRIDE;
    const pkOff = sigOff + SIG_LEN;
    data.writeUInt16LE(sigOff, base + 0); // signature_offset
    data.writeUInt16LE(instructionIdx, base + 2); // signature_instruction_index
    data.writeUInt16LE(pkOff, base + 4); // public_key_offset
    data.writeUInt16LE(instructionIdx, base + 6); // public_key_instruction_index
    data.writeUInt16LE(msgOffset, base + 8); // message_data_offset (shared)
    data.writeUInt16LE(L, base + 10); // message_data_size
    data.writeUInt16LE(instructionIdx, base + 12); // message_instruction_index
  }

  // Signature/pubkey blobs: sig0,pk0,sig1,pk1,...
  for (let i = 0; i < N; i++) {
    const sigOff = DATA_START + i * STRIDE;
    triples[i].signature.copy(data, sigOff);
    triples[i].pubkey.copy(data, sigOff + SIG_LEN);
  }

  // Single shared message.
  message.copy(data, msgOffset);

  // Trailing metadata (read by the quote program, not part of the signed region).
  for (let i = 0; i < N; i++) data[oracleIdxOffset + i] = triples[i].oracleIdx;
  data.writeBigUInt64LE(typeof recentSlot === "bigint" ? recentSlot : BigInt(recentSlot), slotOffset);
  data[versionOffset] = version;
  Buffer.from("SBOD").copy(data, sbodOffset);

  return new TransactionInstruction({ programId: Ed25519Program.programId, data, keys: [] });
}

/** Verifier injected by the caller — `(message, signature, pubkey) => boolean`.
 *  Kept as a parameter so this module needs no crypto dependency of its own
 *  (the crank test supplies tweetnacl's `sign.detached.verify`). */
export type Ed25519Verifier = (message: Uint8Array, signature: Uint8Array, pubkey: Uint8Array) => boolean;

/**
 * Decode an Ed25519 precompile instruction's data the way the runtime does:
 * parse the N offset structs and resolve each (signature, pubkey, message) by
 * FOLLOWING the declared offsets (self-contained single-instruction data), then
 * verify each with the injected verifier. Used by the offline geometry test.
 */
export function decodeAndVerifyEd25519(data: Uint8Array, verify: Ed25519Verifier): DecodedEd25519 {
  const buf = Buffer.from(data);
  const N = buf[0];
  const padding = buf[1];
  const slices: DecodedSlice[] = [];
  for (let i = 0; i < N; i++) {
    const b = HDR + i * OFF_LEN;
    const struct: Ed25519OffsetStruct = {
      signatureOffset: buf.readUInt16LE(b + 0),
      signatureInstructionIndex: buf.readUInt16LE(b + 2),
      publicKeyOffset: buf.readUInt16LE(b + 4),
      publicKeyInstructionIndex: buf.readUInt16LE(b + 6),
      messageDataOffset: buf.readUInt16LE(b + 8),
      messageDataSize: buf.readUInt16LE(b + 10),
      messageInstructionIndex: buf.readUInt16LE(b + 12),
    };
    const signature = buf.subarray(struct.signatureOffset, struct.signatureOffset + SIG_LEN);
    const pubkey = buf.subarray(struct.publicKeyOffset, struct.publicKeyOffset + PK_LEN);
    const message = buf.subarray(struct.messageDataOffset, struct.messageDataOffset + struct.messageDataSize);
    let verified = false;
    try {
      verified = verify(message, signature, pubkey);
    } catch {
      verified = false;
    }
    slices.push({ index: i, struct, signature, pubkey, message, verified });
  }
  return { numSignatures: N, padding, dataLen: buf.length, slices, allVerified: slices.length > 0 && slices.every((s) => s.verified) };
}
