// WAVE-2 STEP 3 VERIFY — independent on-chain read of all 11 equity markets.
// Asserts per ticker: market exists, assetName canonical, oracle_source=1,
// feedHash BYTE-MATCHES the frozen manifest, asset_class=2, registry-resolvable,
// and the vol oracle at the MARKET-DERIVED PDA carries source=1 + manifest seed.
import * as anchor from "@coral-xyz/anchor"; import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs"; import * as path from "path"; import type { Opta } from "@app/idl/opta";
import { lookupSbFeed } from "./sbFeedRegistry";

const PROG = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
// ticker, frozen feedHash, seed(1e12), path
const M: Array<[string, string, string, string]> = [
  ["MSFT", "b13e5f030af9a49150591b6cbce83810184331e5b6a0eae8b303a49153496c56", "300000000000", "migrate*"],
  ["AAPL", "d0ab87e8218247d61f3b60e0d9c7e9dc93f691f30849552e0923aa8acd15fdc8", "320000000000", "migrate"],
  ["GOOGL", "c47268fa603180997ab954702ef058dcf56d97f597085d095278dfffd37c9103", "350000000000", "birth"],
  ["AMZN", "bf3190ce3b040d25d1af35c66461fe8fee2f7dd4c83e72e5c13dcc89929abf3f", "350000000000", "birth"],
  ["META", "56bb4c5863ad44b5c59d75cce27d170f8c05e50b9698c9a27480bc7c47f11570", "400000000000", "migrate"],
  ["NVDA", "5378913080bd823885beb8cc37d55842d438e2198f8ce711b7385b527a542bdf", "550000000000", "migrate+ovr"],
  ["AMD", "28fcb07fb1301a399cbe35b809cd8ffa45a22f5bd4e3a15845b4fca219846668", "550000000000", "birth"],
  ["TSLA", "24f5404db181873fead6fd9ad15c7edc2265e8b7a494b3168055fa3bfbb3ced3", "600000000000", "migrate"],
  ["COIN", "60e0a2d31235e2e3c7414635f3bf0c14c671098ef953b0823d380913d627c868", "750000000000", "birth"],
  ["MSTR", "5dc7af42f5237fb2d39aa65374c91234da9a92ba940ac9a5613b51d59d9a830a", "900000000000", "migrate"],
  ["CRCL", "077acbc9a679e4660b8ace50be067bd08a443f1ea7c0a48b4b6e444c23c17040", "950000000000", "migrate"],
  // ---- Wave-2b (2026-07-21) ----
  ["SPCX", "fd7a0b9ea922e14e18944f8105b151df922487da9b1b2ed5ad52150924ed413f", "1000000000000", "birth"],
  ["HOOD", "9801bc9a0cc3eceb1ec4dfb964186a426883bb89a670c5968879b6e2c31b7c8b", "650000000000", "birth"],
];

(async () => {
  const c = new Connection(process.env.OPTA_RPC_URL!, "confirmed");
  const p = new Program<Opta>(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf-8")) as Opta,
    new anchor.AnchorProvider(c, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" }));
  let bad = 0;
  console.log("ticker | path        | market PDA                                   | src | feedHash | class | volOracle(market-derived) | seed | sc | OK");
  for (const [t, feed, seed, pathLbl] of M) {
    const [mkt] = PublicKey.findProgramAddressSync([Buffer.from("market"), Buffer.from(t)], PROG);
    const m: any = await (p.account as any).optionsMarket.fetch(mkt).catch(() => null);
    if (!m) { console.log(`${t.padEnd(6)} | ${pathLbl.padEnd(11)} | MARKET MISSING`); bad++; continue; }
    const got = Buffer.from(m.pythFeedId as number[]).toString("hex");
    const [vo] = PublicKey.findProgramAddressSync([Buffer.from("vol_oracle"), Buffer.from(got, "hex")], PROG);
    const o: any = await (p.account as any).volOracle.fetch(vo).catch(() => null);
    const ok = m.assetName === t && m.oracleSource === 1 && got === feed && m.assetClass === 2 &&
      !!lookupSbFeed(got) && !!o && o.oracleSource === 1 && o.seedVol?.toString?.() === seed;
    if (!ok) bad++;
    console.log(`${t.padEnd(6)} | ${pathLbl.padEnd(11)} | ${mkt.toBase58()} | ${m.oracleSource}   | ${got === feed ? "MATCH   " : "MISMATCH"} | ${m.assetClass}     | ${vo.toBase58().slice(0, 12)}…            | ${o?.seedVol?.toString?.() === seed ? "ok  " : "BAD "} | ${o ? Number(o.sampleCount) : "-"}  | ${ok ? "OK" : "FAIL"}`);
  }
  console.log(`\n${bad === 0 ? `ALL ${M.length} VERIFIED — board is Switchboard equity-complete` : bad + " FAILURES"}`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => { console.log("ERR", e.stack ?? e.message); process.exit(1); });
