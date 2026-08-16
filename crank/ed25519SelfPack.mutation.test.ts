// =============================================================================
// crank/ed25519SelfPack.mutation.test.ts — position-dependence, pinned
// =============================================================================
// Encodes the 2026-08-16 incident AND the failed remedy, so neither is
// rediscovered the hard way.
//
// INCIDENT: a browser-signed early exercise died with `custom program error:
// 0x3` at instruction 2, deterministically, while every CLI-built and simulated
// transaction passed. Phantom attaches its own priority-fee ComputeBudget
// instruction when it signs, shifting the ed25519 ix by one; the packed offsets
// name an ABSOLUTE index, so they then dereferenced a 5-byte ComputeBudget ix
// and the precompile returned InvalidDataOffsets.
//
// FAILED REMEDY: packing u16::MAX ("this instruction") is accepted by Solana's
// ed25519 precompile and REJECTED on chain by the Switchboard crate the program
// calls, which re-reads the ix through the instructions sysvar and panics —
// "Signature instruction index 65535 does not match current instruction index 1"
// (src/sysvar/ix_sysvar.rs:100). The payload CANNOT be made position-independent.
//
// So this file pins three things:
//   1. the packer emits the concrete index it was given, never u16::MAX;
//   2. the payload resolves when the ix sits at that index;
//   3. it FAILS when anything shifts it — the residual risk the live mitigation
//      (endpoint supplies both compute-budget ixs, removing the wallet's reason
//      to insert) reduces but cannot eliminate. Structural fix: 86eymw9m1.
//
// Offline. No RPC, no wallet, no chain.
//   ts-node --transpile-only -r tsconfig-paths/register ed25519SelfPack.mutation.test.ts
// =============================================================================
import { ComputeBudgetProgram, TransactionInstruction } from "@solana/web3.js";
import { packEd25519Ix, SELF_INSTRUCTION_INDEX, type Ed25519Triple } from "./ed25519SelfPack";

const HDR = 2, OFF_LEN = 14, SIG_LEN = 64, PK_LEN = 32;
let failures = 0;
const check = (name: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
  if (!ok) failures++;
};

function triples(n: number, msgLen = 81): Ed25519Triple[] {
  const message = Buffer.alloc(msgLen, 0xab);
  return Array.from({ length: n }, (_, i) => ({
    oracleIdx: i,
    signature: Buffer.alloc(SIG_LEN, i + 1),
    pubkey: Buffer.alloc(PK_LEN, i + 100),
    message,
  }));
}

/** Exactly what the precompile does: resolve each reference and bounds-check it. */
function precompileWouldPass(ixs: { data: Buffer | Uint8Array }[], edIdx: number): boolean {
  const d = Buffer.from(ixs[edIdx].data);
  const n = d.readUInt8(0);
  for (let i = 0; i < n; i++) {
    const base = HDR + i * OFF_LEN;
    const refs: Array<[number, number, number]> = [
      [d.readUInt16LE(base + 2), d.readUInt16LE(base + 0), SIG_LEN],
      [d.readUInt16LE(base + 6), d.readUInt16LE(base + 4), PK_LEN],
      [d.readUInt16LE(base + 12), d.readUInt16LE(base + 8), d.readUInt16LE(base + 10)],
    ];
    for (const [ixIndex, off, size] of refs) {
      const buf = ixIndex === SELF_INSTRUCTION_INDEX ? d : (ixs[ixIndex] ? Buffer.from(ixs[ixIndex].data) : null);
      if (!buf || off + size > buf.length) return false;
    }
  }
  return true;
}

const CU_LIMIT = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });
const CU_PRICE = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 });
const QUOTE_IX = new TransactionInstruction({ keys: [], programId: CU_LIMIT.programId, data: Buffer.alloc(16, 7) });

console.log("ed25519 self-pack — position-dependence + wallet-mutation residual risk");

// The live layout: [cuLimit, cuPrice, ed25519, exercise] — ed25519 at index 2.
const LIVE_ED_INDEX = 2;

for (const n of [1, 2]) {
  const ed = packEd25519Ix(triples(n), LIVE_ED_INDEX, 123_456, 1);
  const d = Buffer.from(ed.data);

  let anySelf = false, allConcrete = true;
  for (let i = 0; i < n; i++) {
    const base = HDR + i * OFF_LEN;
    for (const off of [2, 6, 12]) {
      const v = d.readUInt16LE(base + off);
      if (v === SELF_INSTRUCTION_INDEX) anySelf = true;
      if (v !== LIVE_ED_INDEX) allConcrete = false;
    }
  }
  // The on-chain crate rejects u16::MAX. This assertion is what stops it being
  // reintroduced as a "position-independence fix" — it looks correct offline.
  check(`n=${n}: packer never emits u16::MAX (rejected on chain)`, !anySelf);
  check(`n=${n}: packer emits the concrete index it was given (${LIVE_ED_INDEX})`, allConcrete);

  const asBuilt = [CU_LIMIT, CU_PRICE, ed, QUOTE_IX];
  check(`n=${n}: resolves in the as-built layout (ed25519 at ${LIVE_ED_INDEX})`,
    precompileWouldPass(asBuilt, LIVE_ED_INDEX));

  // RESIDUAL RISK, asserted rather than hoped away: supplying our own priority
  // fee removes the wallet's REASON to insert, not its ABILITY. If one still
  // does, this is the failure — same 0x3, one index further along.
  for (const [label, extra] of [["1 more", 1], ["2 more", 2]] as const) {
    const shifted = [...Array(extra).fill(CU_PRICE), ...asBuilt];
    check(`n=${n}: STILL FAILS if a wallet prepends ${label} ix (known residual risk)`,
      !precompileWouldPass(shifted, LIVE_ED_INDEX + extra),
      "mitigation reduces likelihood, not possibility — structural fix 86eymw9m1");
  }
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
