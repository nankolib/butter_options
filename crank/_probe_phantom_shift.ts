// PROOF: insert one extra ComputeBudget instruction at the front of the
// endpoint-built transaction — exactly what Phantom does when it attaches a
// priority fee — and re-audit the ed25519 offsets.
//
// The self-pack writes instruction_index = 1 into every offset field (it is told
// instructionIdx: 1). Those indices are ABSOLUTE positions in the transaction.
// Insert anything ahead of the ed25519 ix and index 1 stops being the ed25519 ix
// and becomes the other ComputeBudget instruction — a ~5-byte payload that
// cannot contain a 64-byte signature at offset 16. The precompile then returns
// InvalidDataOffsets == custom error 0x3, at whatever index the ed25519 ix now
// occupies (2).
//
// u16::MAX (65535) means "this instruction" and is position-independent. The
// self-pack does not use it. That is the bug.
import * as anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, VersionedTransaction, TransactionMessage,
  ComputeBudgetProgram, TransactionInstruction,
} from "@solana/web3.js";
import { getAssociatedTokenAddress, getAssociatedTokenAddressSync } from "@solana/spl-token";
import path from "path";

const ENDPOINT = process.env.ENDPOINT ?? "http://localhost:8788";
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ED = "Ed25519SigVerify111111111111111111111111111";
const VAULT = new PublicKey(process.env.VAULT ?? "6tq9Ueck1F7d9y1n3v9c6NbU5mhxTXshHKkR8y6YZ83V");
const MINT = new PublicKey(process.env.MINT ?? "DrcqMdCKMeELEcDCe4ioNLHUjUAwUhe4apfa3qaePefg");
const HOLDER = new PublicKey("Awi8u6PigydVN4XRBQzmiPEdyyVmtnwf1H7Gmrf5ARu5");
const QTY = Number(process.env.QTY ?? 3);
const SELF = 0xffff;

function auditEd(ixs: { data: Uint8Array }[], edIdx: number, label: string) {
  const d = Buffer.from(ixs[edIdx].data);
  const n = d.readUInt8(0);
  let bad = 0;
  console.log(`\n  === ${label} ===`);
  console.log(`  ed25519 now at tx index ${edIdx}; num_signatures=${n}`);
  for (let s = 0; s < n; s++) {
    const o = 2 + s * 14;
    const f = {
      sigOff: d.readUInt16LE(o), sigIx: d.readUInt16LE(o + 2),
      pkOff: d.readUInt16LE(o + 4), pkIx: d.readUInt16LE(o + 6),
      msgOff: d.readUInt16LE(o + 8), msgLen: d.readUInt16LE(o + 10), msgIx: d.readUInt16LE(o + 12),
    };
    const buf = (i: number) => (i === SELF ? d : (ixs[i] ? Buffer.from(ixs[i].data) : null));
    const one = (nm: string, ix: number, off: number, size: number) => {
      const b = buf(ix);
      if (!b) { console.log(`    sig${s}.${nm}: ix=${ix} MISSING`); bad++; return; }
      const ok = off + size <= b.length;
      if (!ok) bad++;
      console.log(`    sig${s}.${nm}: instruction_index=${ix} -> that ix has ${b.length} bytes; need offset ${off}+${size}=${off + size}  ${ok ? "OK" : "<<< OUT OF BOUNDS"}`);
    };
    one("signature ", f.sigIx, f.sigOff, 64);
    one("public_key", f.pkIx, f.pkOff, 32);
    one("message   ", f.msgIx, f.msgOff, f.msgLen);
  }
  console.log(`  => precompile verdict: ${bad ? `FAIL (InvalidDataOffsets = custom error 0x3) at instruction ${edIdx}` : "PASS"}`);
  return bad;
}

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

  const r = await fetch(`${ENDPOINT}/sb-exercise-american`, {
    method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:5173" },
    body: JSON.stringify({
      holder: HOLDER.toBase58(), sharedVault: VAULT.toBase58(),
      market: (v.market as PublicKey).toBase58(),
      vaultMintRecord: PublicKey.findProgramAddressSync(
        [Buffer.from("vault_mint_record"), MINT.toBuffer()], PID)[0].toBase58(),
      optionMint: MINT.toBase58(),
      holderOptionAccount: getAssociatedTokenAddressSync(MINT, HOLDER, false, TOKEN_2022).toBase58(),
      vaultUsdcAccount: (v.vaultUsdcAccount as PublicKey).toBase58(),
      holderUsdcAccount: (await getAssociatedTokenAddress(ps.usdcMint as PublicKey, HOLDER)).toBase58(),
      quantity: QTY,
    }),
  });
  const j: any = await r.json();
  const tx = VersionedTransaction.deserialize(Buffer.from(j.transactionBase64, "base64"));
  const keys = tx.message.getAccountKeys();

  // Rebuild as legacy instruction list so we can splice like a wallet does.
  const decompiled = TransactionMessage.decompile(tx.message).instructions;
  const edIdx0 = decompiled.findIndex((i) => i.programId.toBase58() === ED);
  const asData = (l: TransactionInstruction[]) => l.map((i) => ({ data: new Uint8Array(i.data) }));

  console.log("=== AS SERVED BY THE ENDPOINT ===");
  decompiled.forEach((i, n) =>
    console.log(`  ix[${n}] ${i.programId.toBase58() === ED ? "ed25519" : i.programId.toBase58().slice(0, 12)}  dataBytes=${i.data.length}`));
  const badBefore = auditEd(asData(decompiled), edIdx0, "BEFORE — endpoint's 3-instruction transaction");

  // Phantom's priority-fee instruction, prepended.
  const mutated = [ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 }), ...decompiled];
  const edIdx1 = mutated.findIndex((i) => i.programId.toBase58() === ED);
  console.log("\n=== AFTER A WALLET PREPENDS ONE ComputeBudget IX ===");
  mutated.forEach((i, n) =>
    console.log(`  ix[${n}] ${i.programId.toBase58() === ED ? "ed25519" : i.programId.toBase58().slice(0, 12)}  dataBytes=${i.data.length}`));
  const badAfter = auditEd(asData(mutated), edIdx1, "AFTER — 4 instructions, ed25519 shifted 1 -> 2");

  console.log(`\n  RESULT: served=${badBefore ? "FAIL" : "PASS"}   wallet-mutated=${badAfter ? "FAIL" : "PASS"}`);
  console.log(`  Matches observed "Error processing Instruction ${edIdx1}: custom program error: 0x3": ${badAfter > 0 && edIdx1 === 2}`);
  void keys;
})().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });
