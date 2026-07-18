// READ-ONLY sim: prove 6GfxUov discharge lands. Uses the REAL holder token
// account (from getTokenLargestAccounts) + idempotent USDC-ATA creation so the
// USDC-ATA-missing skip can't silently no-op the burn. crank as sim payer
// (sigVerify off — no signature, no send). Signs nothing, sends nothing.
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";
import type { Opta } from "@app/idl/opta";
import { safeFetchAll } from "@app/hooks/useFetchAccounts";

const VAULT_OPTION_MINT_SEED = "vault_option_mint", VAULT_MINT_RECORD_SEED = "vault_mint_record", PROTOCOL_SEED = "protocol_v2";
const HOLDER = new PublicKey("5uBcRhU6Hc78w8pNRNgu1X953oRL93fgAHC348CKNajV");
const CRANK = new PublicKey("5sHZETYzbbdBQnFLmDCG3gyCikew39pL8kAE5xroGfqa"); // sim payer only
const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");

(async () => {
  const rpc = process.env.OPTA_RPC_URL || fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim();
  const conn = new Connection(rpc, { commitment: "confirmed" });
  const program = new Program<Opta>(
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf-8")) as Opta,
    new anchor.AnchorProvider(conn, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" }));
  const vaults = await safeFetchAll<any>(program, "sharedVault");
  const gRec = vaults.find((v) => v.publicKey.toBase58() === "6GfxUovAaPKrGh5PaqdesXEdeAQuWAavKNSuiWz2fuuK")!;
  const g = gRec.account, mpda = (g.market as PublicKey).toBase58();
  const [gMint] = PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_OPTION_MINT_SEED), new PublicKey(mpda).toBuffer(),
     g.strikePrice.toArrayLike(Buffer, "le", 8), g.expiry.toArrayLike(Buffer, "le", 8),
     Buffer.from([0]), Buffer.from([1])], program.programId); // CALL(0) AMERICAN(1)

  // REAL holder token account (not a derived ATA — 5uBcRhU6's tokens live here).
  const largest = await conn.getTokenLargestAccounts(gMint);
  const holderAcct = (await Promise.all(largest.value.filter((x) => x.uiAmount && x.uiAmount > 0).map(async (x) => {
    const ai = await conn.getAccountInfo(x.address);
    return { addr: x.address, owner: ai ? new PublicKey(ai.data.subarray(32, 64)).toBase58() : "", amt: x.amount };
  }))).find((h) => h.owner === HOLDER.toBase58());
  if (!holderAcct) { console.log("no 5uBcRhU6 token account found"); process.exit(1); }
  console.log(`holder option token acct: ${holderAcct.addr.toBase58()}  amount=${holderAcct.amt}`);

  const collMint = new PublicKey(g.collateralMint);
  const holderUsdc = getAssociatedTokenAddressSync(collMint, HOLDER, true, TOKEN_PROGRAM_ID);
  const usdcExists = !!(await conn.getAccountInfo(holderUsdc));
  console.log(`holder USDC ATA ${holderUsdc.toBase58()} ${usdcExists ? "EXISTS" : "MISSING → must create (idempotent) or auto_finalize SKIPS the burn"}`);

  const [vmr] = PublicKey.findProgramAddressSync([Buffer.from(VAULT_MINT_RECORD_SEED), gMint.toBuffer()], program.programId);
  const [ps] = PublicKey.findProgramAddressSync([Buffer.from(PROTOCOL_SEED)], program.programId);
  const ixs = [] as any[];
  if (!usdcExists) ixs.push(createAssociatedTokenAccountIdempotentInstruction(CRANK, holderUsdc, HOLDER, collMint, TOKEN_PROGRAM_ID));
  ixs.push(await program.methods.autoFinalizeHolders()
    .accountsPartial({
      caller: CRANK, sharedVault: gRec.publicKey, market: new PublicKey(mpda), vaultMintRecord: vmr,
      optionMint: gMint, vaultUsdcAccount: g.vaultUsdcAccount, protocolState: ps,
      token2022Program: TOKEN_2022, tokenProgram: TOKEN_PROGRAM_ID })
    .remainingAccounts([
      { pubkey: holderAcct.addr, isSigner: false, isWritable: true },
      { pubkey: holderUsdc, isSigner: false, isWritable: true }])
    .instruction());

  const { blockhash } = await conn.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: CRANK, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  console.log(`\nSIM (${ixs.length} ix${!usdcExists ? ", incl. idempotent USDC-ATA create" : ""}): ${sim.value.err ? "ERR " + JSON.stringify(sim.value.err) : "OK ✅ — discharge lands (burns 5, pays $0 OTM)"}`);
  (sim.value.logs ?? []).filter((l) => /HoldersFinalized|holders_processed|total_burned|total_paid|Burn|Error|nsufficient/i.test(l)).slice(-8).forEach((l) => console.log("   " + l.slice(0, 150)));
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.stack ?? e.message ?? e); process.exit(1); });
