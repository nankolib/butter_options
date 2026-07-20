// (c) MSFT PARITY CHECK — MSFT was recovered via _birth_sb_market.ts after the
// marketless incident, NOT via the cutover tool. Prove the on-chain result is
// byte-equivalent to what the (patched) cutover tool produces, so the board has
// no silently-divergent migration: assetName, oracle_source, feedHash byte-match,
// asset_class, and vol-oracle PAIRING (PDA derived from market.pyth_feed_id must
// be the seeded oracle). Then run the get_option_price plausibility check.
import * as anchor from "@coral-xyz/anchor"; import { Program, BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, ComputeBudgetProgram, TransactionMessage, VersionedTransaction } from "@solana/web3.js";
import * as fs from "fs"; import * as path from "path"; import type { Opta } from "@app/idl/opta";
import { lookupSbFeed } from "./sbFeedRegistry";

const PROG = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const PAYER = new PublicKey("5YRMuuoY3P7z5GeRAAQND7BxgNdmPSa6CSPCJLca1zZk");
const SYM = "MSFT";
const FEED = "b13e5f030af9a49150591b6cbce83810184331e5b6a0eae8b303a49153496c56";
const SEED = "300000000000";      // 0.30 × 1e12
const SEED_F = 0.30;
const PROXY_SPOT = 397.7;         // live finnhub/yahoo at mint time
const CLASS = 2;

(async () => {
  const c = new Connection(process.env.OPTA_RPC_URL!, "confirmed");
  const p = new Program<Opta>(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf-8")) as Opta,
    new anchor.AnchorProvider(c, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" }));
  const [mkt] = PublicKey.findProgramAddressSync([Buffer.from("market"), Buffer.from(SYM)], PROG);
  const m: any = await (p.account as any).optionsMarket.fetch(mkt);
  const gotFeed = Buffer.from(m.pythFeedId as number[]).toString("hex");

  // --- parity assertions (what the cutover tool's VERIFY block asserts) ---
  const checks: Array<[string, boolean, string]> = [
    ["assetName === 'MSFT' (canonical, no suffix)", m.assetName === SYM, `got '${m.assetName}'`],
    ["oracle_source === 1 (Switchboard)", m.oracleSource === 1, `got ${m.oracleSource}`],
    ["feedHash BYTE-MATCHES frozen manifest", gotFeed === FEED, `got ${gotFeed.slice(0, 16)}…`],
    ["asset_class === 2 (equity)", m.assetClass === CLASS, `got ${m.assetClass}`],
    ["feedHash resolves in SB registry", !!lookupSbFeed(gotFeed), `lookupSbFeed=${!!lookupSbFeed(gotFeed)}`],
  ];
  // --- vol oracle PAIRING: PDA derived FROM THE MARKET must be the seeded one ---
  const [voFromMarket] = PublicKey.findProgramAddressSync([Buffer.from("vol_oracle"), Buffer.from(gotFeed, "hex")], PROG);
  const vo: any = await (p.account as any).volOracle.fetch(voFromMarket).catch(() => null);
  checks.push(["vol oracle exists at market-derived PDA", !!vo, voFromMarket.toBase58()]);
  if (vo) {
    checks.push(["vol oracle source === 1", vo.oracleSource === 1, `got ${vo.oracleSource}`]);
    checks.push(["seed_vol === manifest (0.30)", vo.seedVol?.toString?.() === SEED, `got ${vo.seedVol?.toString?.()}`]);
  }
  console.log(`=== MSFT PARITY (market ${mkt.toBase58()}) ===`);
  let bad = 0;
  for (const [n, ok, d] of checks) { if (!ok) bad++; console.log(`  ${ok ? "OK " : "FAIL"}  ${n.padEnd(46)} ${d}`); }
  console.log(bad === 0 ? "  => BYTE-EQUIVALENT to cutover-tool output (no divergent migration)\n" : `  => ${bad} PARITY FAILURE(S)\n`);

  // --- get_option_price plausibility (now that market feed === oracle feed) ---
  const expiry = Math.floor(Date.now() / 1000) + 30 * 86400;
  const years = 30 / 365;
  const strike = Math.round(PROXY_SPOT);
  const ix = await p.methods.getOptionPrice(new BN(strike * 1e6), new BN(expiry), { call: {} } as any, { american: {} } as any, 0)
    .accountsStrict({ market: mkt, volOracle: voFromMarket }).instruction();
  const { blockhash } = await c.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: PAYER, recentBlockhash: blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 400000 }), ix] }).compileToV0Message());
  const sim = await c.simulateTransaction(tx, { sigVerify: false });
  console.log(`=== MSFT get_option_price ($${strike} ATM CALL, ~30d) ===`);
  if (sim.value.err) {
    console.log(`  BLOCKED err=${JSON.stringify(sim.value.err)}`);
    (sim.value.logs ?? []).filter((l) => /Error/i.test(l)).slice(-2).forEach((l) => console.log("   " + l));
    process.exit(1);
  }
  const b = Buffer.from(sim.value.returnData!.data[0], "base64");
  const u = (o: number) => Number(new BN(b.subarray(o, o + 8), "le").toString());
  const premium = u(0) / 1e6, vol = u(8) / 1e12, spot = u(16) / 1e12;
  const approx = 0.4 * spot * vol * Math.sqrt(years);
  const volOk = Math.abs(vol - SEED_F) < 1e-6;
  const spotOk = Math.abs(spot - PROXY_SPOT) / PROXY_SPOT < 0.03;
  const premOk = premium > approx * 0.5 && premium < approx * 2.0;
  console.log(`  premium   = $${premium.toFixed(4)}  (ATM approx $${approx.toFixed(2)}; band $${(approx*0.5).toFixed(2)}–$${(approx*2).toFixed(2)})  ${premOk ? "PLAUSIBLE" : "OUT-OF-BAND"}`);
  console.log(`  vol_used  = ${(vol*100).toFixed(2)}%  vs seed ${(SEED_F*100).toFixed(0)}%  ${volOk ? "MATCHES SEED" : "MISMATCH"}`);
  console.log(`  spot_used = $${spot.toFixed(2)}  vs proxy ~$${PROXY_SPOT}  ${spotOk ? "AGREES(<3%)" : "DIVERGES"}`);
  console.log(`  VERDICT: ${volOk && spotOk && premOk ? "SANE" : "REVIEW"}`);
  process.exit(bad === 0 && volOk && spotOk && premOk ? 0 : 1);
})().catch((e) => { console.log("ERR", e.stack ?? e.message); process.exit(1); });
