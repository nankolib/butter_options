// ============================================================================
// crank/_birth_sb_market.ts — Wave-1 meme ON-CHAIN births (Phase C)
// ============================================================================
// SCRATCH / UNCOMMITTED session script. Per asset (one at a time):
//   1. SEED vol oracle: [CU, ed25519(fresh quote), initialize_vol_oracle(feedId,
//      source=1, seed_vol) + SB accounts] — explicit MANIFEST seed (not the
//      class default). Idempotent: skips if the oracle already exists.
//   2. CREATE_MARKET: [CU, ed25519(fresh quote), create_market(name, feedId,
//      class=0, source=1) + SB accounts]. Feed sourced from embedded DEFS (NOT
//      the registry — the memes aren't registered yet). Idempotent.
//   3. VERIFY: oracle exists + seed_vol reads back (tradeable-at-birth), market
//      src=1 + feedHash byte-match.
// Mirrors birthSbOracle (sbOracleCrank.ts) + buildSwitchboardCreateMarketTx
// (switchboardCreateMarket.ts). sim-gate + fresh-quote retry, same discipline
// as _cutover_rebirth.ts.
//
// Run (from crank/):
//   OPTA_RPC_URL="$(cat ~/.opta-rpc-helius)" npx ts-node --transpile-only \
//     -r tsconfig-paths/register _birth_sb_market.ts <ASSET>
// ============================================================================

import * as anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction, ComputeBudgetProgram, Ed25519Program,
} from "@solana/web3.js";
import {
  Queue, AnchorUtils, ON_DEMAND_DEVNET_PID, ON_DEMAND_DEVNET_QUEUE,
  SPL_SYSVAR_SLOT_HASHES_ID, SPL_SYSVAR_INSTRUCTIONS_ID,
} from "@switchboard-xyz/on-demand";
import { OracleFeed, OracleJob, CrossbarClient } from "@switchboard-xyz/common";
import BN from "bn.js";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { Opta } from "@app/idl/opta";
import { buildManagedQuoteUpdateIxs } from "./switchboardQuotePost";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const CROSSBAR_URL = process.env.OPTA_CROSSBAR_URL || "https://crossbar.switchboard.xyz";
const IDL_JSON_PATH = path.resolve(__dirname, "../app/src/idl/opta.json");
const CU = 400_000;
const MAX_ATTEMPTS = 10;
const norm = (h: string) => h.replace(/^0x/, "").toLowerCase();
const L = (s: string) => console.log(s);
const die = (c: number, m: string) => { L("\nABORT: " + m); process.exit(c); };
const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const tokenAmount = (data: Buffer | Uint8Array) => Buffer.from(data).readBigUInt64LE(64);

const binance = (s: string) => ({ tasks: [{ httpTask: { url: `https://api.binance.com/api/v3/ticker/price?symbol=${s}USDT` } }, { jsonParseTask: { path: "$.price" } }] });
const coinbase = (s: string) => ({ tasks: [{ httpTask: { url: `https://api.exchange.coinbase.com/products/${s}-USD/ticker` } }, { jsonParseTask: { path: "$.price" } }] });
const gate = (s: string) => ({ tasks: [{ httpTask: { url: `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${s}_USDT` } }, { jsonParseTask: { path: "$[0].last" } }] });
const finnhub = (x: string) => ({ tasks: [{ httpTask: { url: `https://quotes.opta.fyi/finnhub/quote?symbol=${x}` } }, { jsonParseTask: { path: "$.c" } }] });
const yahoo = (x: string) => ({ tasks: [{ httpTask: { url: `https://quotes.opta.fyi/yahoo/chart/${x}` } }, { jsonParseTask: { path: "$.chart.result[0].meta.regularMarketPrice" } }] });

// Manifest-of-record (confirmed Phase C greenlight). seed i64 @1e12.
const DEFS: Record<string, { symbol: string; feedHash: string; seed: string; assetClass: number; jobs: Array<Record<string, unknown>> }> = {
  JUP:  { symbol: "JUP/USD",  feedHash: "5f42a2a7b0b52a26774d3554b4d58cb5b997079379b5b94649d34451be0239f2", seed: "1100000000000", assetClass: 0, jobs: [binance("JUP"), gate("JUP")] },
  JTO:  { symbol: "JTO/USD",  feedHash: "bc8e0c273c458ee54aadd7d18875c2d3164a4acb424680c0a2d5f6a121317ec4", seed: "1100000000000", assetClass: 0, jobs: [binance("JTO"), gate("JTO")] },
  WIF:  { symbol: "WIF/USD",  feedHash: "c186e1064610e8f14330734e4492e65dd6d141da371f1f94419c96296801294a", seed: "1400000000000", assetClass: 0, jobs: [binance("WIF"), gate("WIF")] },
  BONK: { symbol: "BONK/USD", feedHash: "c062a25a824803dd5b88661f0b6dec5b6bc2bfc2ec385f2e053b83e58660e32f", seed: "1400000000000", assetClass: 0, jobs: [binance("BONK"), coinbase("BONK")] },
  // ---- Wave-2 equities (assetClass=2). Job builders byte-identical to
  // _equity_feed_hashes.ts / _mint_sb_feed.ts — the feed here only rebuilds the
  // ed25519 fresh quote; the feedHash below is the FROZEN manifest value and is
  // asserted by the seed read-back + market feedHash byte-match. Seeds @1e12.
  ...eqDefs(),
};

function eqDefs(): Record<string, { symbol: string; feedHash: string; seed: string; assetClass: number; jobs: Array<Record<string, unknown>> }> {
  const rows: Array<[string, string, string]> = [
    ["MSFT",  "b13e5f030af9a49150591b6cbce83810184331e5b6a0eae8b303a49153496c56", "300000000000"],
    ["AAPL",  "d0ab87e8218247d61f3b60e0d9c7e9dc93f691f30849552e0923aa8acd15fdc8", "320000000000"],
    ["GOOGL", "c47268fa603180997ab954702ef058dcf56d97f597085d095278dfffd37c9103", "350000000000"],
    ["AMZN",  "bf3190ce3b040d25d1af35c66461fe8fee2f7dd4c83e72e5c13dcc89929abf3f", "350000000000"],
    ["META",  "56bb4c5863ad44b5c59d75cce27d170f8c05e50b9698c9a27480bc7c47f11570", "400000000000"],
    ["NVDA",  "5378913080bd823885beb8cc37d55842d438e2198f8ce711b7385b527a542bdf", "550000000000"],
    ["AMD",   "28fcb07fb1301a399cbe35b809cd8ffa45a22f5bd4e3a15845b4fca219846668", "550000000000"],
    ["TSLA",  "24f5404db181873fead6fd9ad15c7edc2265e8b7a494b3168055fa3bfbb3ced3", "600000000000"],
    ["COIN",  "60e0a2d31235e2e3c7414635f3bf0c14c671098ef953b0823d380913d627c868", "750000000000"],
    ["MSTR",  "5dc7af42f5237fb2d39aa65374c91234da9a92ba940ac9a5613b51d59d9a830a", "900000000000"],
    ["CRCL",  "077acbc9a679e4660b8ace50be067bd08a443f1ea7c0a48b4b6e444c23c17040", "950000000000"],
    // ---- Wave-2b (locked manifest, 2026-07-21). SPCX seeded HOT (1.00): fresh
    // Nasdaq IPO Jun-12, thin history. HOOD 0.65: full history since 2021. ----
    ["SPCX",  "fd7a0b9ea922e14e18944f8105b151df922487da9b1b2ed5ad52150924ed413f", "1000000000000"],
    ["HOOD",  "9801bc9a0cc3eceb1ec4dfb964186a426883bb89a670c5968879b6e2c31b7c8b", "650000000000"],
  ];
  const out: any = {};
  for (const [t, feedHash, seed] of rows) {
    out[t] = { symbol: `${t}/USD`, feedHash, seed, assetClass: 2, jobs: [finnhub(t), yahoo(t)] };
  }
  return out;
}

function buildFeed(def: typeof DEFS[string]): OracleFeed {
  return OracleFeed.fromObject({
    name: def.symbol, jobs: def.jobs.map((o) => OracleJob.fromObject(o)),
    minOracleSamples: 2, minJobResponses: def.jobs.length, maxJobRangePct: 5000000000,
  });
}

async function freshEdIx(qObj: Queue, crossbar: CrossbarClient, feed: OracleFeed, payer: PublicKey): Promise<TransactionInstruction> {
  const { ixs } = await buildManagedQuoteUpdateIxs(qObj, crossbar, feed, payer, { numSignatures: 2, instructionIdx: 1 });
  const ed = ixs.find((ix) => ix.programId.toBase58() === Ed25519Program.programId.toBase58());
  if (!ed) throw new Error("no ed25519 ix in managed-update output");
  return ed;
}

async function sendWithRetry(
  label: string, conn: Connection, admin: Keypair,
  buildIxs: () => Promise<TransactionInstruction[]>,
): Promise<string> {
  for (let a = 1; a <= MAX_ATTEMPTS; a++) {
    L(`  [${label} ${a}/${MAX_ATTEMPTS}] fresh quote + build …`);
    let instructions: TransactionInstruction[];
    try { instructions = await buildIxs(); } catch (e: any) { L(`    build failed (re-fetch): ${String(e?.message || e).slice(0, 150)}`); continue; }
    const bh = await conn.getLatestBlockhash();
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: admin.publicKey, recentBlockhash: bh.blockhash, instructions }).compileToV0Message());
    tx.sign([admin]);
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    if (sim.value.err) { L(`    sim err (re-fetch): ${JSON.stringify(sim.value.err)}`); (sim.value.logs || []).slice(-4).forEach((x) => L("      " + x)); continue; }
    L(`    SIM GATE PASS — sending …`);
    try {
      const sig = await conn.sendTransaction(tx, { skipPreflight: false });
      const c = await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
      if (c.value.err) { L(`    confirm err (re-fetch): ${JSON.stringify(c.value.err)} sig=${sig}`); continue; }
      return sig;
    } catch (e: any) { L(`    send failed (re-fetch): ${String(e?.message || e).slice(0, 150)}`); continue; }
  }
  die(21, `${label}: no clean land in ${MAX_ATTEMPTS} attempts`); return "";
}

async function main() {
  const asset = (process.argv[2] || "").toUpperCase();
  const def = DEFS[asset];
  if (!def) die(2, `usage: _birth_sb_market.ts <${Object.keys(DEFS).join("|")}> [--seed-only]`);

  const rpc = process.env.OPTA_RPC_URL ||
    (fs.existsSync(path.join(os.homedir(), ".opta-rpc-helius")) ? fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim() : "https://api.devnet.solana.com");
  const conn = new Connection(rpc, "confirmed");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))));
  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(IDL_JSON_PATH, "utf-8")) as Opta;
  const program = new anchor.Program<Opta>(idl, provider);
  const sbProgram = await AnchorUtils.loadProgramFromConnection(conn, wallet, ON_DEMAND_DEVNET_PID);
  const qObj = new Queue(sbProgram, ON_DEMAND_DEVNET_QUEUE);
  const crossbar = new CrossbarClient(CROSSBAR_URL);
  const feed = buildFeed(def);

  const feedIdBytes = Array.from(Buffer.from(norm(def.feedHash), "hex"));
  const [volPda] = PublicKey.findProgramAddressSync([Buffer.from("vol_oracle"), Buffer.from(norm(def.feedHash), "hex")], PROGRAM_ID);
  const [marketPda] = PublicKey.findProgramAddressSync([Buffer.from("market"), Buffer.from(asset)], PROGRAM_ID);
  const [protocolState] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], PROGRAM_ID);

  L(JSON.stringify({ ev: "boot", asset, symbol: def.symbol, seed: def.seed, feedHash: def.feedHash.slice(0, 10) + "…", volPda: volPda.toBase58(), marketPda: marketPda.toBase58() }));

  // ---- 1. SEED vol oracle (idempotent) ----
  const volExisting = await conn.getAccountInfo(volPda);
  if (volExisting) {
    const vo: any = await program.account.volOracle.fetch(volPda);
    L(`[seed] vol oracle already exists: source=${vo.oracleSource} seed_vol=${vo.seedVol?.toString?.()} sample_count=${vo.sampleCount}`);
    if (vo.oracleSource !== 1) die(30, `existing vol oracle source=${vo.oracleSource}, expected 1`);
  } else {
    const sig = await sendWithRetry("SEED", conn, admin, async () => {
      const ed = await freshEdIx(qObj, crossbar, feed, admin.publicKey);
      const ix = await (program.methods as any).initializeVolOracle(feedIdBytes, 1, new BN(def.seed))
        .accounts({ initializer: admin.publicKey, priceUpdate: null, volOracle: volPda, systemProgram: SystemProgram.programId, sbQueue: ON_DEMAND_DEVNET_QUEUE, sbSlothashes: SPL_SYSVAR_SLOT_HASHES_ID, sbInstructions: SPL_SYSVAR_INSTRUCTIONS_ID })
        .instruction();
      return [ComputeBudgetProgram.setComputeUnitLimit({ units: CU }), ed, ix];
    });
    L(JSON.stringify({ ev: "seeded", asset, sig, volPda: volPda.toBase58() }));
  }
  // verify seed reads back
  const vo: any = await program.account.volOracle.fetch(volPda);
  const seedBack = vo.seedVol?.toString?.();
  if (seedBack !== def.seed) die(31, `seed read-back ${seedBack} !== manifest ${def.seed}`);
  L(`[seed] VERIFY: source=${vo.oracleSource} seed_vol=${seedBack} (=== manifest ${def.seed}) sample_count=${vo.sampleCount} → warmup gate satisfied by seed (tradeable at birth)`);
  if (vo.oracleSource !== 1) die(31, `verify: oracle_source=${vo.oracleSource}, expected 1`);

  // --seed-only (Wave-2 STEP 2): create the vol oracle and STOP — markets are a
  // separate gated step (STEP 3: 7 migrations via the hardened rebirth tool + 4
  // births back through this driver, which then skips the existing oracle).
  if (process.argv.includes("--seed-only")) {
    L(JSON.stringify({ ev: "seed-only-done", asset, volPda: volPda.toBase58(), oracle_source: vo.oracleSource, seed_vol: seedBack, sample_count: Number(vo.sampleCount) }));
    process.exit(0);
  }

  // ---- 2. MIGRATE (close old Pyth) if needed, then CREATE_MARKET (idempotent) ----
  const mExisting = await conn.getAccountInfo(marketPda);
  let needCreate = true;
  if (mExisting) {
    const m: any = await program.account.optionsMarket.fetch(marketPda);
    if (m.oracleSource === 1) { L(`[market] already exists as SB (src=1) — skip create`); needCreate = false; }
    else if (m.oracleSource === 0) {
      // MIGRATE: re-scan live vaults immediately before close; STOP on any live state.
      L(`[migrate] ${asset} exists as Pyth (src=0) — re-scanning live vaults before close…`);
      const vDisc = (program.coder.accounts as any).memcmp("sharedVault") as { offset: number; bytes: string };
      const raw = await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ memcmp: { offset: vDisc.offset, bytes: vDisc.bytes } }] });
      let referencing = 0, live = 0;
      for (const { account } of raw) {
        let v: any; try { v = program.coder.accounts.decode("sharedVault", account.data); } catch { continue; }
        if (new PublicKey(v.market).toBase58() !== marketPda.toBase58()) continue;
        referencing++;
        let usdc = 0n; try { const ta = await conn.getAccountInfo(new PublicKey(v.vaultUsdcAccount)); if (ta) usdc = tokenAmount(ta.data); } catch { /* 0 */ }
        if (!v.isSettled || usdc > 0n) live++;
      }
      L(JSON.stringify({ ev: "migrate_scan", asset, referencing, live }));
      if (live > 0) die(34, `${asset}: ${live} live vault(s) appeared since read — STOP (non-zero live state)`);
      // close_market (mirrors preflight/cutover byte-for-byte)
      const nameBuf = Buffer.from(asset, "utf-8"); const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32LE(nameBuf.length, 0);
      const closeIx = new TransactionInstruction({
        programId: PROGRAM_ID,
        keys: [ { pubkey: admin.publicKey, isSigner: true, isWritable: true }, { pubkey: protocolState, isSigner: false, isWritable: false }, { pubkey: marketPda, isSigner: false, isWritable: true } ],
        data: Buffer.concat([disc("close_market"), lenBuf, nameBuf]),
      });
      const bh = await conn.getLatestBlockhash();
      const ctx = new VersionedTransaction(new TransactionMessage({ payerKey: admin.publicKey, recentBlockhash: bh.blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }), closeIx] }).compileToV0Message());
      ctx.sign([admin]);
      const csim = await conn.simulateTransaction(ctx, { sigVerify: false, replaceRecentBlockhash: true });
      if (csim.value.err) { (csim.value.logs || []).slice(-6).forEach((x) => L("   " + x)); die(35, `close sim err ${JSON.stringify(csim.value.err)}`); }
      const csig = await conn.sendTransaction(ctx, { skipPreflight: false });
      const cc = await conn.confirmTransaction({ signature: csig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
      if (cc.value.err) die(35, `close confirm err ${JSON.stringify(cc.value.err)} sig=${csig}`);
      const gone = await conn.getAccountInfo(marketPda);
      if (gone) die(35, `close confirmed (sig=${csig}) but PDA still present — aborting before create`);
      L(JSON.stringify({ ev: "closed_pyth", asset, sig: csig, marketPda: marketPda.toBase58() }));
    } else die(32, `market exists but source=${m.oracleSource} (unexpected)`);
  }
  if (needCreate) {
    const sig = await sendWithRetry("CREATE", conn, admin, async () => {
      const ed = await freshEdIx(qObj, crossbar, feed, admin.publicKey);
      const ix = await (program.methods as any).createMarket(asset, feedIdBytes, def.assetClass, 1)
        .accounts({ creator: admin.publicKey, protocolState, priceUpdate: null, market: marketPda, systemProgram: SystemProgram.programId, sbQueue: ON_DEMAND_DEVNET_QUEUE, sbSlothashes: SPL_SYSVAR_SLOT_HASHES_ID, sbInstructions: SPL_SYSVAR_INSTRUCTIONS_ID })
        .instruction();
      return [ComputeBudgetProgram.setComputeUnitLimit({ units: CU }), ed, ix];
    });
    L(JSON.stringify({ ev: "created", asset, sig, marketPda: marketPda.toBase58() }));
  }

  // ---- 3. VERIFY ----
  const m: any = await program.account.optionsMarket.fetch(marketPda);
  const gotFeed = norm(Buffer.from(m.pythFeedId as number[]).toString("hex"));
  if (m.oracleSource !== 1) die(33, `verify: src=${m.oracleSource} != 1`);
  if (gotFeed !== norm(def.feedHash)) die(33, `verify: feedHash ${gotFeed.slice(0, 12)} != ${norm(def.feedHash).slice(0, 12)}`);
  if (m.assetName !== asset) die(33, `verify: assetName ${m.assetName} != ${asset}`);
  L(`\n✅ BIRTH COMPLETE — ${asset}`);
  L(JSON.stringify({ ev: "verified", asset, marketPda: marketPda.toBase58(), src: m.oracleSource, assetName: m.assetName, feedHash: gotFeed, class: m.assetClass, volPda: volPda.toBase58(), seed_vol: seedBack, tradeable_at_birth: true }));
  process.exit(0);
}

main().catch((e) => { console.error("birth-sb-market crashed:", e?.message || e); process.exit(1); });
