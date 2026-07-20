// READ-ONLY: STEP-2 sanity spot-check. Calls get_option_price for AAPL + TSLA
// against the NEWLY SEEDED SB vol oracles and checks the returned quote is
// PLAUSIBLE, not merely non-error:
//   vol_used === seed (0.32 / 0.60), spot_used ~= live proxy quote,
//   premium within a believable ATM band (BS ATM approx ~0.4*S*vol*sqrt(T)).
// NOTE: the market account is still PYTH pre-STEP-3, so we pass the SB vol
// oracle explicitly to see whether the program's seeds constraint permits it.
import * as anchor from "@coral-xyz/anchor"; import { Program, BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import * as fs from "fs"; import * as os from "os"; import * as path from "path"; import type { Opta } from "@app/idl/opta";

const PROG = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const PAYER = new PublicKey("5YRMuuoY3P7z5GeRAAQND7BxgNdmPSa6CSPCJLca1zZk");
const T: Record<string, { feedHash: string; seed: number; spot: number }> = {
  AAPL: { feedHash: "d0ab87e8218247d61f3b60e0d9c7e9dc93f691f30849552e0923aa8acd15fdc8", seed: 0.32, spot: 324.6 },
  TSLA: { feedHash: "24f5404db181873fead6fd9ad15c7edc2265e8b7a494b3168055fa3bfbb3ced3", seed: 0.60, spot: 374.0 },
};

(async () => {
  const rpc = process.env.OPTA_RPC_URL!;
  const c = new Connection(rpc, "confirmed");
  const p = new Program<Opta>(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf-8")) as Opta,
    new anchor.AnchorProvider(c, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" }));
  const expiry = Math.floor(Date.now() / 1000) + 30 * 86400; // ~30d
  const years = 30 / 365;

  for (const [sym, d] of Object.entries(T)) {
    const [mkt] = PublicKey.findProgramAddressSync([Buffer.from("market"), Buffer.from(sym)], PROG);
    const [vo] = PublicKey.findProgramAddressSync([Buffer.from("vol_oracle"), Buffer.from(d.feedHash, "hex")], PROG);
    const m: any = await (p.account as any).optionsMarket.fetch(mkt).catch(() => null);
    const strike = Math.round(d.spot); // ATM
    const ix = await p.methods.getOptionPrice(new BN(strike * 1e6), new BN(expiry), { call: {} } as any, { american: {} } as any, 0)
      .accountsStrict({ market: mkt, volOracle: vo }).instruction();
    const { blockhash } = await c.getLatestBlockhash();
    const tx = new VersionedTransaction(new TransactionMessage({
      payerKey: PAYER, recentBlockhash: blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), ix],
    }).compileToV0Message());
    const sim = await c.simulateTransaction(tx, { sigVerify: false });
    console.log(`\n=== ${sym} (market oracle_source=${m?.oracleSource ?? "?"}, strike=$${strike} ATM, ~30d) ===`);
    if (sim.value.err) {
      const logs = (sim.value.logs ?? []).filter((l) => /Error|constraint|seeds/i.test(l)).slice(-3);
      console.log(`  BLOCKED err=${JSON.stringify(sim.value.err)}`);
      logs.forEach((l) => console.log("   " + l));
      continue;
    }
    const b = Buffer.from(sim.value.returnData!.data[0], "base64");
    const u = (o: number) => Number(new BN(b.subarray(o, o + 8), "le").toString());
    const premium = u(0) / 1e6, vol = u(8) / 1e12, spot = u(16) / 1e12;
    const approx = 0.4 * spot * vol * Math.sqrt(years);
    const volOk = Math.abs(vol - d.seed) < 1e-6;
    const spotOk = Math.abs(spot - d.spot) / d.spot < 0.02;
    const premOk = premium > approx * 0.5 && premium < approx * 2.0;
    console.log(`  premium = $${premium.toFixed(4)}   (ATM approx $${approx.toFixed(2)}; band $${(approx*0.5).toFixed(2)}-$${(approx*2).toFixed(2)})  ${premOk ? "PLAUSIBLE" : "OUT-OF-BAND"}`);
    console.log(`  vol_used  = ${(vol*100).toFixed(2)}%  vs seed ${(d.seed*100).toFixed(0)}%  ${volOk ? "MATCHES SEED" : "MISMATCH"}`);
    console.log(`  spot_used = $${spot.toFixed(2)}  vs proxy ~$${d.spot}  ${spotOk ? "AGREES(<2%)" : "DIVERGES"}`);
    console.log(`  VERDICT: ${volOk && spotOk && premOk ? "SANE" : "REVIEW"}`);
  }
})().catch((e) => console.log("ERR", e.stack ?? e.message));
