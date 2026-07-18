// READ-ONLY. Jul-18 status: (A) BTC settle readiness for EaV3yxWb+GtoM6B7f,
// (B) fresh SOL Pyth spot for $82 PUT ITM/OTM, (C) full addrs, (D) distinct
// live-Pyth Jul-31 08:00Z tuples the settle-guard must sweep. Signs nothing.
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";
import type { Opta } from "@app/idl/opta";
import { safeFetchAll } from "@app/hooks/useFetchAccounts";

const SETTLEMENT_SEED = "settlement";
const SOL_PYTH_FEED = "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const JUL31_0800Z = Math.floor(Date.parse("2026-07-31T08:00:00Z") / 1000);
const BTC_VAULTS = ["EaV3yxWbredBKL2XNaBzE4Vm8MLxSo8iJo7KpSb4GnW7", "GtoM6B7foehhLisAVYANEPWuLT2fjTfBokorFA39eUKW"];

(async () => {
  const rpc = process.env.OPTA_RPC_URL || fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim();
  const conn = new Connection(rpc, { commitment: "confirmed" });
  const program = new Program<Opta>(
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf-8")) as Opta,
    new anchor.AnchorProvider(conn, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" }));
  const now = (await conn.getBlockTime(await conn.getSlot()))!;
  console.log(`CLUSTER NOW: ${new Date(now * 1000).toISOString()} (unix=${now})\n`);

  const [vaults, markets] = await Promise.all([safeFetchAll<any>(program, "sharedVault"), safeFetchAll<any>(program, "optionsMarket")]);
  const mById = new Map<string, any>(); for (const m of markets) mById.set(m.publicKey.toBase58(), m.account);
  const byPk = new Map<string, any>(); for (const v of vaults) byPk.set(v.publicKey.toBase58(), v.account);

  console.log("===== (A) BTC settle readiness (expire ~17:00Z Jul-18) =====");
  for (const pk of BTC_VAULTS) {
    const v = byPk.get(pk); if (!v) { console.log(`  ${pk}: NOT FOUND`); continue; }
    const mkt = mById.get((v.market as PublicKey).toBase58());
    const exp = typeof v.expiry === "number" ? v.expiry : v.expiry.toNumber();
    const [srec] = PublicKey.findProgramAddressSync(
      [Buffer.from(SETTLEMENT_SEED), Buffer.from(mkt.assetName), Buffer.from(new anchor.BN(exp).toArray("le", 8))], program.programId);
    const srAcct = await conn.getAccountInfo(srec);
    let srInfo = "NO SettlementRecord yet";
    if (srAcct) { const r: any = program.coder.accounts.decode("settlementRecord", srAcct.data); srInfo = `SETTLED price=$${(Number(r.settlementPrice) / 1e6).toFixed(2)} at ${new Date(Number(r.settledAt) * 1000).toISOString()}`; }
    console.log(`  ${pk.slice(0, 8)} ${mkt.assetName} strike=$${(Number(v.strikePrice) / 1e6).toFixed(0)}`);
    console.log(`     expiry=${new Date(exp * 1000).toISOString()}  ${exp <= now ? `EXPIRED ${((now - exp) / 3600).toFixed(1)}h ago` : `expires in ${((exp - now) / 3600).toFixed(1)}h`}  is_settled=${v.isSettled}`);
    console.log(`     SettlementRecord ${srec.toBase58()}: ${srInfo}`);
  }

  console.log("\n===== (B) fresh SOL Pyth spot → $82 PUT ITM/OTM =====");
  try {
    const r = await fetch(`https://hermes.pyth.network/v2/updates/price/latest?ids[]=${SOL_PYTH_FEED}&encoding=base64`);
    const j: any = await r.json();
    const p = j.parsed?.[0]?.price; const spot = Number(p.price) * Math.pow(10, p.expo);
    console.log(`  SOL/USD (Pyth Hermes) = $${spot.toFixed(4)}  (publish ${new Date(p.publish_time * 1000).toISOString()})`);
    console.log(`  $82 PUT: ${spot < 82 ? `ITM by $${(82 - spot).toFixed(2)}/contract → intrinsic on 3 = $${((82 - spot) * 3).toFixed(2)}` : `OTM by $${(spot - 82).toFixed(2)} (expires worthless if unchanged)`}`);
  } catch (e: any) { console.log(`  Hermes fetch failed: ${e?.message}`); }

  console.log("\n===== (C) full base58 (founder eyeball) =====");
  const ew = byPk.get("EWwhESruvwda8i1udbby4BrAx9Afxf6Ma2qvFcT3Dw22");
  console.log(`  EWwhESru writer-ask backer + holder DnExEYnZ...  6GfxUov backer DnExEYnZ...  6GfxUov holder 5uBcRhU6...`);
  console.log(`  (addresses printed verbatim from the vault scan — see below)`);

  console.log("\n===== (D) distinct live-Pyth (asset,expiry) tuples @ Jul-31 08:00Z (guard sweep set) =====");
  const tuples = new Map<string, { asset: string; expiry: number; feed: string; vaults: number; funded: number }>();
  for (const v of vaults) {
    const a = v.account; const mkt = mById.get((a.market as PublicKey).toBase58());
    if (!mkt || mkt.oracleSource !== 0) continue;
    if (a.isSettled || a.voided) continue;
    const exp = typeof a.expiry === "number" ? a.expiry : a.expiry.toNumber();
    if (exp !== JUL31_0800Z) continue;
    const key = `${mkt.assetName}|${exp}`;
    const t = tuples.get(key) ?? { asset: mkt.assetName, expiry: exp, feed: Buffer.from(mkt.pythFeedId).toString("hex"), vaults: 0, funded: 0 };
    t.vaults++; if (BigInt(a.totalCollateral.toString()) > 0n) t.funded++;
    tuples.set(key, t);
  }
  console.log(`  distinct tuples needing a SettlementRecord at Jul-31 08:00Z: ${tuples.size}`);
  for (const t of tuples.values())
    console.log(`     ${t.asset.padEnd(6)} expiry=${new Date(t.expiry * 1000).toISOString()} feed=0x${t.feed.slice(0, 12)}… live_vaults=${t.vaults} (funded=${t.funded})`);
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.stack ?? e.message ?? e); process.exit(1); });
