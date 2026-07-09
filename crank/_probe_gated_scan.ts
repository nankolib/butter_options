// READ-ONLY. (A) Gate-D readiness: are the 5 crypto SB vol oracles birthed?
// (B) Pyth exposure scan: live Pyth vaults with expiry > Jul 31 2026.
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";
import type { Opta } from "@app/idl/opta";
import { safeFetchAll } from "@app/hooks/useFetchAccounts";
import { VOL_ORACLE_SEED } from "@app/utils/constants";

const CRYPTO = {
  BTC: "baf182b54386b4a1c0354b7d64fb33d679301087a8b509d6a397d7b4f5162ee2",
  ETH: "1d8f55a03da760d0f322bc1d066427e95573f651d506e0e31a5499659349caa3",
  SOL: "e01fe3bb1d659e5957296b2637658defd1f8b42fc87dd9f16e8fff16fcaeb463",
  XRP: "a1c4ce28a9a4abd471fb2eb11236c299a3b02cad72f3f93437aa01578405f736",
  FARTCOIN: "9612492ea0fdac76ef82ee98f21eee60c98ebb5cc8a2810fc415e56a7357a5f2",
};
const JUL31 = Math.floor(Date.parse("2026-08-01T00:00:00Z") / 1000); // > Jul 31

(async () => {
  const rpc = process.env.OPTA_RPC_URL || fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim();
  const conn = new Connection(rpc, { commitment: "confirmed" });
  const program = new Program<Opta>(
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf-8")) as Opta,
    new anchor.AnchorProvider(conn, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" }));
  const cnow = (await conn.getBlockTime(await conn.getSlot()))!;
  console.log(`cluster now ${new Date(cnow * 1000).toISOString()}\n`);

  console.log("===== (A) GATE-D READINESS: 5 crypto SB vol oracles =====");
  for (const [sym, hex] of Object.entries(CRYPTO)) {
    const [pda] = PublicKey.findProgramAddressSync([Buffer.from(VOL_ORACLE_SEED), Buffer.from(hex, "hex")], program.programId);
    let s = `  ${sym.padEnd(9)} feed=0x${hex.slice(0, 10)} pda=${pda.toBase58()} `;
    try {
      const o: any = await program.account.volOracle.fetch(pda);
      const lastTs = Number(o.lastSampleTs?.toString?.() ?? o.lastSampleTs ?? 0);
      s += `BIRTHED source=${o.oracleSource} sample_count=${o.sampleCount} last_sample_ts=${lastTs ? new Date(lastTs * 1000).toISOString() : 0} seed_vol=${o.seedVol?.toString?.() ?? "?"} last_spot=${o.lastSpotPrice?.toString?.() ?? "?"}`;
    } catch { s += "!! NOT BIRTHED (fetch failed) — FORCE_FEED would try to birth, but no class → SKIP"; }
    console.log(s);
  }

  console.log("\n===== (B) PYTH EXPOSURE SCAN: live Pyth vaults, expiry > Jul 31 2026 =====");
  const [vaults, markets] = await Promise.all([safeFetchAll<any>(program, "sharedVault"), safeFetchAll<any>(program, "optionsMarket")]);
  const mById = new Map<string, any>();
  for (const m of markets) mById.set(m.publicKey.toBase58(), m.account);
  let pythLive = 0, maxExpiry = 0; const beyond: any[] = [];
  for (const v of vaults) {
    const a = v.account;
    const mkt = mById.get((a.market as PublicKey).toBase58());
    if (!mkt) continue;
    if (mkt.oracleSource !== 0) continue;          // Pyth only
    if (a.isSettled || a.voided) continue;         // live only
    pythLive++;
    const ex = typeof a.expiry === "number" ? a.expiry : a.expiry.toNumber();
    if (ex > maxExpiry) maxExpiry = ex;
    if (ex >= JUL31) beyond.push({ pk: v.publicKey.toBase58(), asset: mkt.assetName, ex, strike: a.strikePrice.toString(), tc: a.totalCollateral.toString() });
  }
  console.log(`live Pyth vaults total: ${pythLive}`);
  console.log(`max expiry among live Pyth vaults: ${maxExpiry ? new Date(maxExpiry * 1000).toISOString() : "n/a"}`);
  console.log(`live Pyth vaults with expiry > Jul 31 2026: ${beyond.length}`);
  for (const b of beyond) console.log(`   ${b.asset.padEnd(6)} ${b.pk} expiry=${new Date(b.ex * 1000).toISOString()} strike=${b.strike} tc=${b.tc}`);
  console.log(`\nNOTE: create_shared_vault/create_series enforce NO upper expiry bound (only expiry>now + min buffer).`);
  console.log(`      => max mintable expiry currently allowed = UNBOUNDED for any Pyth market.`);
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
