// READ-ONLY diagnostic: which fee payer lets get_option_price simulate for a
// DISCONNECTED viewer? Reproduces optionPriceQuote.ts's sim against the reborn SB
// SOL market with several payer candidates. Whichever returns decoded data (not
// InvalidAccountForFee / InsufficientFunds) is the fix.
import * as anchor from "@coral-xyz/anchor"; import { Program, BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, ComputeBudgetProgram, TransactionMessage, VersionedTransaction, SystemProgram } from "@solana/web3.js";
import * as fs from "fs"; import * as os from "os"; import * as path from "path"; import type { Opta } from "@app/idl/opta";

(async () => {
  const rpc = process.env.OPTA_RPC_URL!;
  const c = new Connection(rpc, { commitment: "confirmed" });
  const p = new Program<Opta>(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf-8")) as Opta,
    new anchor.AnchorProvider(c, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" }));
  const [mkt] = PublicKey.findProgramAddressSync([Buffer.from("market"), Buffer.from("SOL")], p.programId);
  const m: any = await (p.account as any).optionsMarket.fetch(mkt);
  const [vo] = PublicKey.findProgramAddressSync([Buffer.from("vol_oracle"), Buffer.from(m.pythFeedId)], p.programId);
  const exp = Math.floor(Date.parse("2026-07-31T08:00:00Z") / 1000);
  const ix = await p.methods.getOptionPrice(new BN(80e6), new BN(exp), { call: {} } as any, { american: {} } as any, 0)
    .accountsStrict({ market: mkt, volOracle: vo }).instruction();

  const candidates: Array<{ name: string; payer: PublicKey; replaceBh?: boolean }> = [
    { name: "PublicKey.default (CURRENT disconnected fallback)", payer: PublicKey.default },
    { name: "random Keypair pubkey", payer: Keypair.generate().publicKey },
    { name: "random Keypair + replaceRecentBlockhash", payer: Keypair.generate().publicKey, replaceBh: true },
    { name: "SystemProgram.programId", payer: SystemProgram.programId },
    { name: "market PDA (off-curve)", payer: mkt },
    { name: "DEPLOYER 5YRMuuoY (funded, exists)", payer: new PublicKey("5YRMuuoY3P7z5GeRAAQND7BxgNdmPSa6CSPCJLca1zZk") },
    { name: "GkG treasury (funded, exists)", payer: new PublicKey("GkG1UX8ML4UzNSGUtJxBWfRRWCdH7YejdhfuxFWTRFAx") },
  ];
  for (const cand of candidates) {
    const { blockhash } = await c.getLatestBlockhash("confirmed");
    const vtx = new VersionedTransaction(new TransactionMessage({
      payerKey: cand.payer, recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), ix],
    }).compileToV0Message());
    const sim = await c.simulateTransaction(vtx, { sigVerify: false, commitment: "confirmed", ...(cand.replaceBh ? { replaceRecentBlockhash: true } : {}) } as any).catch((e) => ({ value: { err: String(e.message), logs: [] } } as any));
    const ok = !sim.value.err && sim.value.returnData?.data?.[0];
    const premium = ok ? Number(new BN(Buffer.from(sim.value.returnData.data[0], "base64").subarray(0, 8), "le").toString()) / 1e6 : null;
    console.log(`${ok ? "✅" : "❌"} ${cand.name.padEnd(46)} ${ok ? `premium=$${premium}` : "err=" + JSON.stringify(sim.value.err)}`);
  }
})().catch((e) => console.log("ERR", e.stack ?? e.message));
