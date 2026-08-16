// Does the ed25519 precompile payload actually verify? If offsets are in bounds
// AND every signature verifies, the precompile returns success and cannot be the
// source of the observed error 3 — which redirects suspicion to the program leg.
// Precompile error codes: 0 InvalidPublicKey, 1 InvalidRecoveryId,
// 2 InvalidSignature, 3 InvalidDataOffsets, 4 InvalidInstructionDataSize.
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAssociatedTokenAddressSync } from "@solana/spl-token";
import crypto from "crypto";
import path from "path";

const ENDPOINT = process.env.ENDPOINT ?? "http://localhost:8788";
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const ED = "Ed25519SigVerify111111111111111111111111111";
const VAULT = new PublicKey(process.env.VAULT ?? "6tq9Ueck1F7d9y1n3v9c6NbU5mhxTXshHKkR8y6YZ83V");
const MINT = new PublicKey(process.env.MINT ?? "DrcqMdCKMeELEcDCe4ioNLHUjUAwUhe4apfa3qaePefg");
const HOLDER = new PublicKey("Awi8u6PigydVN4XRBQzmiPEdyyVmtnwf1H7Gmrf5ARu5");
const QTY = Number(process.env.QTY ?? 3);
const SELF = 0xffff;

// Wrap a raw 32-byte ed25519 public key in SPKI so node's verifier accepts it.
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const rawToSpki = (raw: Buffer) =>
  crypto.createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: "der", type: "spki" });

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

  const rounds = Number(process.env.ROUNDS ?? 3);
  for (let round = 0; round < rounds; round++) {
    const r = await fetch(`${ENDPOINT}/sb-exercise-american`, {
      method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:5173" },
      body: JSON.stringify(body),
    });
    const j: any = await r.json();
    if (!r.ok) { console.log(`  round ${round}: endpoint HTTP ${r.status}`); continue; }
    const tx = VersionedTransaction.deserialize(Buffer.from(j.transactionBase64, "base64"));
    const keys = tx.message.getAccountKeys();
    const ixs = tx.message.compiledInstructions;
    const edIdx = ixs.findIndex((i) => keys.get(i.programIdIndex)!.toBase58() === ED);
    const d = Buffer.from(ixs[edIdx].data);
    const n = d.readUInt8(0);

    const results: string[] = [];
    let bad = 0;
    for (let s = 0; s < n; s++) {
      const o = 2 + s * 14;
      const sigOff = d.readUInt16LE(o), sigIx = d.readUInt16LE(o + 2);
      const pkOff = d.readUInt16LE(o + 4), pkIx = d.readUInt16LE(o + 6);
      const msgOff = d.readUInt16LE(o + 8), msgLen = d.readUInt16LE(o + 10), msgIx = d.readUInt16LE(o + 12);
      const buf = (i: number) => (i === SELF ? d : Buffer.from(ixs[i].data));
      const inBounds =
        sigOff + 64 <= buf(sigIx).length && pkOff + 32 <= buf(pkIx).length && msgOff + msgLen <= buf(msgIx).length;
      if (!inBounds) { results.push(`sig${s}=OFFSETS_OOB`); bad++; continue; }
      const sig = buf(sigIx).subarray(sigOff, sigOff + 64);
      const pk = buf(pkIx).subarray(pkOff, pkOff + 32);
      const msg = buf(msgIx).subarray(msgOff, msgOff + msgLen);
      let ok = false;
      try { ok = crypto.verify(null, msg, rawToSpki(pk), sig); } catch (e: any) { results.push(`sig${s}=VERIFY_THREW(${e.message.slice(0, 40)})`); bad++; continue; }
      results.push(`sig${s}=${ok ? "VALID" : "INVALID"}`);
      if (!ok) bad++;
    }
    console.log(`  round ${round}: n=${n} edDataLen=${d.length} ixCount=${ixs.length}  ${results.join(" ")}  -> precompile would ${bad ? "FAIL" : "PASS"}`);
  }
})().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });
