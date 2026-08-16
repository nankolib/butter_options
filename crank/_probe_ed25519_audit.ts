// Decode the ed25519 precompile instruction the endpoint serves and validate its
// offsets against the REAL transaction layout.
//
// Why this is the only probe that can see the bug: simulateTransaction with
// sigVerify:false SKIPS precompile verification, so every sim we ran reported
// err:null while real preflight (and Phantom's sim) ran the precompile and
// rejected. Ed25519 precompile error 3 == InvalidDataOffsets.
//
// Layout (solana ed25519_instruction.rs):
//   u8  num_signatures
//   u8  padding
//   then num_signatures x Ed25519SignatureOffsets (14 bytes, 7 x u16 LE):
//     signature_offset, signature_instruction_index,
//     public_key_offset, public_key_instruction_index,
//     message_data_offset, message_data_size, message_instruction_index
// An instruction_index of u16::MAX (65535) means "this instruction".
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAssociatedTokenAddressSync } from "@solana/spl-token";
import path from "path";

const ENDPOINT = process.env.ENDPOINT ?? "http://localhost:8788";
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ED25519_PID = "Ed25519SigVerify111111111111111111111111111";
const VAULT = new PublicKey(process.env.VAULT ?? "6tq9Ueck1F7d9y1n3v9c6NbU5mhxTXshHKkR8y6YZ83V");
const MINT = new PublicKey(process.env.MINT ?? "DrcqMdCKMeELEcDCe4ioNLHUjUAwUhe4apfa3qaePefg");
const HOLDER = new PublicKey("Awi8u6PigydVN4XRBQzmiPEdyyVmtnwf1H7Gmrf5ARu5");
const QTY = Number(process.env.QTY ?? 3);
const SELF = 0xffff;

(async () => {
  const conn = new Connection(process.env.OPTA_RPC_URL!, "confirmed");
  const wallet = new anchor.Wallet(Keypair.generate());
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  const idl = require(path.resolve(__dirname, "../app/src/idl/opta.json"));
  const program = new anchor.Program(idl as any, provider) as any;
  const PID: PublicKey = program.programId;

  const v: any = await program.account.sharedVault.fetch(VAULT);
  const ps: any = await program.account.protocolState.fetch(
    PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], PID)[0]);
  const body = {
    holder: HOLDER.toBase58(), sharedVault: VAULT.toBase58(),
    market: (v.market as PublicKey).toBase58(),
    vaultMintRecord: PublicKey.findProgramAddressSync(
      [Buffer.from("vault_mint_record"), MINT.toBuffer()], PID)[0].toBase58(),
    optionMint: MINT.toBase58(),
    holderOptionAccount: getAssociatedTokenAddressSync(MINT, HOLDER, false, TOKEN_2022).toBase58(),
    vaultUsdcAccount: (v.vaultUsdcAccount as PublicKey).toBase58(),
    holderUsdcAccount: (await getAssociatedTokenAddress(ps.usdcMint as PublicKey, HOLDER)).toBase58(),
    quantity: QTY,
  };
  const r = await fetch(`${ENDPOINT}/sb-exercise-american`, {
    method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:5173" },
    body: JSON.stringify(body),
  });
  const j: any = await r.json();
  const tx = VersionedTransaction.deserialize(Buffer.from(j.transactionBase64, "base64"));
  const keys = tx.message.getAccountKeys();
  const ixs = tx.message.compiledInstructions;

  const edIdx = ixs.findIndex((i) => keys.get(i.programIdIndex)!.toBase58() === ED25519_PID);
  console.log(`  ed25519 instruction is at tx index : ${edIdx}`);
  console.log(`  instruction data lengths           : ${ixs.map((i, n) => `[${n}]=${i.data.length}`).join("  ")}`);
  if (edIdx < 0) { console.log("  NO ed25519 ix — nothing to audit"); return; }

  const d = Buffer.from(ixs[edIdx].data);
  const n = d.readUInt8(0);
  console.log(`\n  num_signatures : ${n}   padding=${d.readUInt8(1)}   totalDataLen=${d.length}`);
  const need = 2 + n * 14;
  console.log(`  header bytes   : ${need} (2 + ${n} x 14)`);

  let bad = 0;
  for (let s = 0; s < n; s++) {
    const o = 2 + s * 14;
    const f = {
      signature_offset: d.readUInt16LE(o),
      signature_instruction_index: d.readUInt16LE(o + 2),
      public_key_offset: d.readUInt16LE(o + 4),
      public_key_instruction_index: d.readUInt16LE(o + 6),
      message_data_offset: d.readUInt16LE(o + 8),
      message_data_size: d.readUInt16LE(o + 10),
      message_instruction_index: d.readUInt16LE(o + 12),
    };
    console.log(`\n  --- signature ${s} ---`);
    for (const [k, val] of Object.entries(f)) {
      const tag = k.endsWith("instruction_index")
        ? (val === SELF ? "  (SELF / this ix)" : `  -> tx ix[${val}]`)
        : "";
      console.log(`    ${k.padEnd(30)} ${String(val).padStart(6)}${tag}`);
    }
    // Resolve each reference against the real tx and bounds-check it.
    const resolve = (ixIndex: number) =>
      ixIndex === SELF ? d : (ixs[ixIndex] ? Buffer.from(ixs[ixIndex].data) : null);
    const check = (label: string, ixIndex: number, off: number, size: number) => {
      const buf = resolve(ixIndex);
      if (!buf) { console.log(`    ${label}: ix[${ixIndex}] DOES NOT EXIST  <<< InvalidDataOffsets`); bad++; return; }
      const ok = off + size <= buf.length;
      console.log(`    ${label}: ix=${ixIndex === SELF ? "SELF" : ixIndex} off=${off} size=${size} bufLen=${buf.length} -> ${ok ? "in bounds" : "OUT OF BOUNDS  <<< InvalidDataOffsets"}`);
      if (!ok) bad++;
    };
    check("signature ", f.signature_instruction_index, f.signature_offset, 64);
    check("public_key", f.public_key_instruction_index, f.public_key_offset, 32);
    check("message   ", f.message_instruction_index, f.message_data_offset, f.message_data_size);
  }
  console.log(`\n  VERDICT: ${bad === 0 ? "offsets resolve in bounds" : `${bad} BAD REFERENCE(S) — precompile would return error 3 (InvalidDataOffsets)`}`);
})().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });
