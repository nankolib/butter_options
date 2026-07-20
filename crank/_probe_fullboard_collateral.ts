// READ-ONLY: full-board writer collateral at CURRENT SB oracle spots. Replicates
// the writer's EXACT ladder math (writer/src/ladder.ts): 5 strikes ×2 tenors
// ×2 sides = 20 cells/market; qty=clamp(round(targetNotional/strike),1,MAX);
// collateral=strike×qty. Devnet SB feeds are PEGS (SOL≈$75, not real $180) so
// spots must be read live, never assumed. Splits SB-now (fundable tomorrow) from
// Pyth equities (Monday migrate/birth → collateral adds post-birth).
import * as anchor from "@coral-xyz/anchor"; import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";
import type { Opta } from "@app/idl/opta";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const WRITER = new PublicKey("HgafDv195BtNc8X4uvNoRuGcUra5PuUwDJgHeKHvgFiS");
// writer config (VPS .env sets only ENABLED/ASSETS/MAX_CELLS → these are env.ts defaults)
const TN_MAJOR = 2000, TN_MEME = 500, MAX_CELLS_PER_ASSET = 20, GLOBAL_VAULT_CAP = 250, HARD_MAX_QTY = 100_000_000;
const MEME = new Set(["BONK", "WIF", "JUP", "JTO", "FARTCOIN", "POPCAT", "MEW", "PENGU"]);
const MULTS = [1.0, 0.95, 1.05, 0.9, 1.1];
const CLASS = ["crypto", "commodity", "equity", "forex", "etf"];

const roundSig = (x: number, sig = 3) => { if (x <= 0) return x; const m = Math.pow(10, sig - 1 - Math.floor(Math.log10(x))); return Math.round(x * m) / m; };
const clampQty = (strike: number, tn: number) => Math.min(HARD_MAX_QTY, Math.max(1, Math.round(tn / strike)));
const targetNotional = (assetClass: number, name: string) => (assetClass === 0 && MEME.has(name)) ? TN_MEME : TN_MAJOR;

// One market's full 20-cell collateral: 4 (tenor×side) copies per strike.
function marketCollateral(spot: number, assetClass: number, name: string) {
  const tn = targetNotional(assetClass, name);
  let coll = 0; const rows: string[] = [];
  for (const mult of MULTS) {
    const strike = roundSig(spot * mult, 3); if (strike <= 0) continue;
    const qty = clampQty(strike, tn);
    const per = strike * qty; // per single cell
    coll += per * 4;          // ×2 tenors ×2 sides
    rows.push(`    ${mult.toFixed(2)}×spot=$${strike} qty=${qty} → $${per.toFixed(0)}/cell ×4`);
  }
  return { coll, cells: MULTS.length * 4, tn, rows };
}

(async () => {
  const rpc = process.env.OPTA_RPC_URL || fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim();
  const conn = new Connection(rpc, "confirmed");
  const program = new Program<Opta>(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf-8")) as Opta,
    new anchor.AnchorProvider(conn, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" }));
  const nowSec = Math.floor(Date.now() / 1000);

  const vDisc = (program.coder.accounts as any).memcmp("optionsMarket") as { offset: number; bytes: string };
  const raw = await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ memcmp: { offset: vDisc.offset, bytes: vDisc.bytes } }] });
  type Row = { name: string; cls: number; src: number; spot: number; coll: number; cells: number; ready: boolean; reason: string; rows: string[] };
  const sb: Row[] = [], pyth: Row[] = [];
  for (const { account } of raw) {
    let m: any; try { m = program.coder.accounts.decode("optionsMarket", account.data); } catch { continue; }
    if (typeof m.assetName !== "string" || !m.assetName || m.assetClass < 0 || m.assetClass > 4) continue;
    const feed = Buffer.from(m.pythFeedId as number[]);
    const [vo] = PublicKey.findProgramAddressSync([Buffer.from("vol_oracle"), feed], PROGRAM_ID);
    let spot = 0, samples = 0, lastTs = 0, seedVol = 0;
    try { const o: any = await program.account.volOracle.fetch(vo);
      spot = Number((o.lastSpotPrice ?? o.lastSpot ?? 0).toString()) / 1e12;
      samples = Number((o.sampleCount ?? 0).toString()); seedVol = Number((o.seedVol ?? 0).toString());
      lastTs = Number((o.lastSampleTs ?? o.lastTs ?? 0).toString());
    } catch { /* no oracle */ }
    const fresh = lastTs > 0 && (nowSec - lastTs) < 6 * 3600;
    const ready = fresh && (samples >= 168 || seedVol !== 0) && spot > 0;
    const reason = spot <= 0 ? "no-oracle/spot" : !fresh ? "stale" : (samples < 168 && seedVol === 0) ? "warmup" : "ok";
    const mc = spot > 0 ? marketCollateral(spot, m.assetClass, m.assetName) : { coll: 0, cells: 0, rows: [] as string[] };
    const row: Row = { name: m.assetName, cls: m.assetClass, src: m.oracleSource ?? 0, spot, coll: mc.coll, cells: mc.cells, ready, reason, rows: mc.rows };
    (row.src === 1 ? sb : pyth).push(row);
  }
  const fmt = (n: number) => "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });
  const sortColl = (a: Row, b: Row) => b.coll - a.coll;

  console.log("=== SB markets (oracle_source=1) — writer POSTS here (scale-up board) ===");
  sb.sort(sortColl);
  for (const r of sb) console.log(`  ${r.name.padEnd(9)} class=${CLASS[r.cls]} spot=$${r.spot.toFixed(r.spot < 10 ? 6 : 2).padStart(10)} tn=$${targetNotional(r.cls, r.name)} 20-cell coll=${fmt(r.coll).padStart(12)}  oracle=${r.reason}`);
  const sbTotal = sb.reduce((s, r) => s + r.coll, 0);
  const sbReadyTotal = sb.filter((r) => r.ready).reduce((s, r) => s + r.coll, 0);
  const sbCells = sb.reduce((s, r) => s + r.cells, 0);

  console.log("\n=== Pyth markets (oracle_source=0) — FROZEN (no writer posts). Equities migrate/birth Monday. ===");
  pyth.sort(sortColl);
  for (const r of pyth) console.log(`  ${r.name.padEnd(9)} class=${CLASS[r.cls]} spot=$${r.spot > 0 ? r.spot.toFixed(2) : "—"} 20-cell coll(if birthed)=${fmt(r.coll).padStart(12)}  oracle=${r.reason}`);
  const equityColl = pyth.filter((r) => r.cls === 2 || r.cls === 4).reduce((s, r) => s + r.coll, 0);

  // BTC dominance detail
  const btc = sb.find((r) => r.name === "BTC");
  if (btc) { console.log(`\n--- BTC ladder detail (dominates: qty clamps to 1 when tn=$${TN_MAJOR} < strike) ---`); btc.rows.forEach((x) => console.log(x)); }

  console.log("\n=== TOTALS ===");
  console.log(`  SB board full collateral (all ${sb.length} SB markets, 20 cells each = ${sbCells} asks): ${fmt(sbTotal)}`);
  console.log(`  SB board READY-oracle only:                                                 ${fmt(sbReadyTotal)}`);
  console.log(`  globalVaultCap=${GLOBAL_VAULT_CAP} asks → caps total asks; board has ${sbCells} SB cells ${sbCells > GLOBAL_VAULT_CAP ? "(EXCEEDS cap — raise cap or board truncates ATM-first)" : "(under cap ✓)"}`);
  console.log(`  Monday equity ADD (Pyth equities/ETF, if birthed at current spot): +${fmt(equityColl)}`);

  // writer balances
  const sol = (await conn.getBalance(WRITER)) / 1e9;
  let usdc = 0;
  try {
    const { getAssociatedTokenAddressSync } = await import("@solana/spl-token");
    const usdcMint = new PublicKey("AytU5HUQRew9VdUdrzQuZvZ7s14pHLiYjAF5WqdK3oxL");
    const ata = getAssociatedTokenAddressSync(usdcMint, WRITER, true);
    const ai = await conn.getAccountInfo(ata); if (ai) usdc = Number(Buffer.from(ai.data).readBigUInt64LE(64)) / 1e6;
  } catch {}
  console.log(`\n=== WRITER WALLET ${WRITER.toBase58()} ===`);
  console.log(`  SOL=${sol.toFixed(4)}   USDC=${fmt(usdc)}`);
  console.log(`  Delta to fund SB board full: ${fmt(Math.max(0, sbTotal - usdc))} USDC` + (sol < 2 ? `  + SOL top-up (below 2)` : `  (SOL ok)`));
})().catch((e) => console.log("ERR", e.stack ?? e.message));
