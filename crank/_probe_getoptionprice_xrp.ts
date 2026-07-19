// READ-ONLY: does get_option_price succeed for the XRP $1.09 contracts the
// founder is trying to quote? Replicates app/src/utils/optionPriceQuote.ts
// exactly (400K CU sim + decode). Reports premium OR the revert code.
import * as anchor from "@coral-xyz/anchor"; import { Program, BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";
import type { Opta } from "@app/idl/opta";

const MARKET_SEED = "market", VOL_ORACLE_SEED = "vol_oracle";
const CASES: Array<[string, "call" | "put", number, number]> = [
  ["XRP CALL $1.09 Jul-24 (5Q34Vu target)", "call", 1.09, 1784880000],
  ["XRP PUT  $1.09 Jul-24 (68XzAg)", "put", 1.09, 1784880000],
  ["XRP CALL $1.09 Jul-31 (98XqZr)", "call", 1.09, 1785484800],
];
(async () => {
  const rpc = process.env.OPTA_RPC_URL || fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim();
  const conn = new Connection(rpc, { commitment: "confirmed" });
  const program = new Program<Opta>(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf-8")) as Opta,
    new anchor.AnchorProvider(conn, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" }));
  const [marketPda] = PublicKey.findProgramAddressSync([Buffer.from(MARKET_SEED), Buffer.from("XRP")], program.programId);
  const mkt: any = await (program.account as any).optionsMarket.fetch(marketPda);
  const feedId = Buffer.from(mkt.pythFeedId as Uint8Array);
  const [volOracle] = PublicKey.findProgramAddressSync([Buffer.from(VOL_ORACLE_SEED), feedId], program.programId);
  console.log(`XRP market ${marketPda.toBase58()} oracle_source=${mkt.oracleSource} feed=0x${feedId.toString("hex").slice(0, 16)}…`);
  console.log(`vol_oracle ${volOracle.toBase58()}`);
  const vo: any = await (program.account as any).volOracle.fetch(volOracle).catch((e: any) => { console.log("  volOracle fetch FAIL:", e.message); return null; });
  if (vo) console.log(`  vol: samples=${vo.sampleCount} last_spot=${vo.lastSpotPrice?.toString?.()} last_sample_ts=${vo.lastSampleTs?.toString?.()} oracle_source=${vo.oracleSource}\n`);

  for (const [label, side, strike, expiry] of CASES) {
    try {
      const ix = await program.methods
        .getOptionPrice(new BN(Math.round(strike * 1e6)), new BN(expiry),
          (side === "call" ? { call: {} } : { put: {} }) as any, { american: {} } as any, 0)
        .accountsStrict({ market: marketPda, volOracle }).instruction();
      const { blockhash } = await conn.getLatestBlockhash("confirmed");
      // Replicate the CONNECTED app: payer = wallet.publicKey (founder DnExEYnZ), a valid funded acct.
      const payerKey = new PublicKey("DnExEYnZGuEu7xgpmNupJVXJLbMbkNdf3E7f28Zv6LUQ");
      const msg = new TransactionMessage({ payerKey, recentBlockhash: blockhash,
        instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }), ix] }).compileToV0Message();
      const sim = await conn.simulateTransaction(new VersionedTransaction(msg), { sigVerify: false, commitment: "confirmed" });
      if (sim.value.err) {
        const logs = (sim.value.logs ?? []).filter((l) => /Error|revert|Program log|custom|CU|exceeded|consumed/i.test(l)).slice(-4);
        console.log(`${label}\n  ❌ SIM ERR ${JSON.stringify(sim.value.err)}\n  ${logs.join("\n  ")}`);
      } else {
        const b64 = sim.value.returnData?.data?.[0];
        if (!b64) { console.log(`${label}\n  ⚠ OK but NO returnData (empty) — decode would fail → UI 'unknown' error`); continue; }
        const buf = Buffer.from(b64, "base64");
        const u64 = (o: number) => Number(new BN(buf.subarray(o, o + 8), "le").toString());
        console.log(`${label}\n  ✅ premium=$${(u64(0) / 1e6).toFixed(6)}/contract vol=${(u64(8) / 1e12 * 100).toFixed(1)}% spot=$${(u64(16) / 1e12).toFixed(4)} computed_at=${new Date(u64(24) * 1000).toISOString()} (CU used ${sim.value.unitsConsumed})`);
      }
    } catch (e: any) { console.log(`${label}\n  EXC ${e.message}`); }
  }
})().catch((e) => console.log("FATAL", e.stack ?? e.message));
