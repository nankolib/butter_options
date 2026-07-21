// ============================================================================
// crank/_mint_sb_feed.ts — SB feed MINT driver (Wave-1 memes) + dry-proof
// ============================================================================
// SCRATCH / UNCOMMITTED session script. Rebuilds the SB feed-mint path that had
// no in-repo tooling, and PROVES it against a known hash (FARTCOIN 9612492e…)
// before any real mint.
//
// Job-def structure is the DEPLOYED template (crank/sbFeedRegistry.ts), and
// buildFeed() reproduces buildOracleFeed() byte-for-byte:
//   OracleFeed{ name=<SYM/USD>, jobs, minOracleSamples=2, minJobResponses=jobs.len,
//               maxJobRangePct=5000000000 }
// Every URL is a PROVEN pattern copied from an existing on-chain feed
// (Binance/Coinbase from BTC-XRP; Gate/MEXC from FARTCOIN) — symbol substitution
// ONLY, which kills silent-deviation risk.
//
// Modes:
//   hash  <ASSET|all>   GUARD 1 only — local computeOracleFeedId, NO network.
//   proof FARTCOIN      dry-proof: GUARD1 must === expected → storeOracleFeed →
//                       GUARD2 server===expected → fetchOracleFeed round-trip.
//   mint  <ASSET>       GUARD1 → store → GUARD2 (server===local) → fetch-back →
//                       print {asset, feedHash, cid}.  (Phase B)
//
// Run (from crank/):
//   npx ts-node --transpile-only -r tsconfig-paths/register _mint_sb_feed.ts <mode> <asset>
// ============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import { OracleFeed, OracleJob, FeedHash, CrossbarClient } from "@switchboard-xyz/common";
import { Queue, AnchorUtils, ON_DEMAND_DEVNET_PID, ON_DEMAND_DEVNET_QUEUE } from "@switchboard-xyz/on-demand";
import { buildManagedQuoteUpdateIxs } from "./switchboardQuotePost";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const CROSSBAR_URL = process.env.OPTA_CROSSBAR_URL || "https://crossbar.switchboard.xyz";
const MIN_ORACLE_SAMPLES = 2;
const MAX_JOB_RANGE_PCT = 5000000000; // 5% @ 1e-9 — verbatim from buildOracleFeed
const norm = (h: string) => h.replace(/^0x/, "").toLowerCase();

// ---- PROVEN URL patterns (copied from deployed feeds; substitution only) ----
const binance = (sym: string) => ({ tasks: [{ httpTask: { url: `https://api.binance.com/api/v3/ticker/price?symbol=${sym}USDT` } }, { jsonParseTask: { path: "$.price" } }] });
const coinbase = (sym: string) => ({ tasks: [{ httpTask: { url: `https://api.exchange.coinbase.com/products/${sym}-USD/ticker` } }, { jsonParseTask: { path: "$.price" } }] });
const gate = (sym: string) => ({ tasks: [{ httpTask: { url: `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${sym}_USDT` } }, { jsonParseTask: { path: "$[0].last" } }] });
const mexc = (sym: string) => ({ tasks: [{ httpTask: { url: `https://api.mexc.com/api/v3/ticker/price?symbol=${sym}USDT` } }, { jsonParseTask: { path: "$.price" } }] });
// WAVE-2 EQUITIES — FROZEN quotes.opta.fyi scheme. These two builders are
// byte-identical to crank/_equity_feed_hashes.ts (the generator that produced the
// locked manifest); GUARD1 re-proves 11/11 against expectedHash before any store.
// ZERO edits — any URL/path change re-mints every hash and voids the manifest.
const finnhub = (x: string) => ({ tasks: [{ httpTask: { url: `https://quotes.opta.fyi/finnhub/quote?symbol=${x}` } }, { jsonParseTask: { path: "$.c" } }] });
const yahoo = (x: string) => ({ tasks: [{ httpTask: { url: `https://quotes.opta.fyi/yahoo/chart/${x}` } }, { jsonParseTask: { path: "$.chart.result[0].meta.regularMarketPrice" } }] });
const equity = (x: string, expectedHash: string): Def => ({ symbol: `${x}/USD`, jobs: [finnhub(x), yahoo(x)], expectedHash });

interface Def { symbol: string; jobs: Array<Record<string, unknown>>; expectedHash?: string; }

// FARTCOIN = dry-proof target (Gate+MEXC, expected 9612492e…). Memes per the
// locked Wave-1 manifest: BONK=Binance+Coinbase; JUP/JTO/WIF=Binance+Gate.
// Predicted hashes = the Phase-A GUARD1 local values (deterministic). mint mode
// asserts server === local === predicted for a defence-in-depth match.
const DEFS: Record<string, Def> = {
  FARTCOIN: { symbol: "FARTCOIN/USD", jobs: [gate("FARTCOIN"), mexc("FARTCOIN")], expectedHash: "9612492ea0fdac76ef82ee98f21eee60c98ebb5cc8a2810fc415e56a7357a5f2" },
  BONK: { symbol: "BONK/USD", jobs: [binance("BONK"), coinbase("BONK")], expectedHash: "c062a25a824803dd5b88661f0b6dec5b6bc2bfc2ec385f2e053b83e58660e32f" },
  JUP:  { symbol: "JUP/USD",  jobs: [binance("JUP"),  gate("JUP")],  expectedHash: "5f42a2a7b0b52a26774d3554b4d58cb5b997079379b5b94649d34451be0239f2" },
  JTO:  { symbol: "JTO/USD",  jobs: [binance("JTO"),  gate("JTO")],  expectedHash: "bc8e0c273c458ee54aadd7d18875c2d3164a4acb424680c0a2d5f6a121317ec4" },
  WIF:  { symbol: "WIF/USD",  jobs: [binance("WIF"),  gate("WIF")],  expectedHash: "c186e1064610e8f14330734e4492e65dd6d141da371f1f94419c96296801294a" },
  // ---- Wave-2 equities (locked manifest, ClickUp 86eyb0xjz) ----
  MSFT:  equity("MSFT",  "b13e5f030af9a49150591b6cbce83810184331e5b6a0eae8b303a49153496c56"),
  AAPL:  equity("AAPL",  "d0ab87e8218247d61f3b60e0d9c7e9dc93f691f30849552e0923aa8acd15fdc8"),
  GOOGL: equity("GOOGL", "c47268fa603180997ab954702ef058dcf56d97f597085d095278dfffd37c9103"),
  AMZN:  equity("AMZN",  "bf3190ce3b040d25d1af35c66461fe8fee2f7dd4c83e72e5c13dcc89929abf3f"),
  META:  equity("META",  "56bb4c5863ad44b5c59d75cce27d170f8c05e50b9698c9a27480bc7c47f11570"),
  NVDA:  equity("NVDA",  "5378913080bd823885beb8cc37d55842d438e2198f8ce711b7385b527a542bdf"),
  AMD:   equity("AMD",   "28fcb07fb1301a399cbe35b809cd8ffa45a22f5bd4e3a15845b4fca219846668"),
  TSLA:  equity("TSLA",  "24f5404db181873fead6fd9ad15c7edc2265e8b7a494b3168055fa3bfbb3ced3"),
  COIN:  equity("COIN",  "60e0a2d31235e2e3c7414635f3bf0c14c671098ef953b0823d380913d627c868"),
  MSTR:  equity("MSTR",  "5dc7af42f5237fb2d39aa65374c91234da9a92ba940ac9a5613b51d59d9a830a"),
  CRCL:  equity("CRCL",  "077acbc9a679e4660b8ace50be067bd08a443f1ea7c0a48b4b6e444c23c17040"),
  // ---- Wave-2b (locked manifest, 2026-07-21) — same frozen scheme ----
  SPCX:  equity("SPCX",  "fd7a0b9ea922e14e18944f8105b151df922487da9b1b2ed5ad52150924ed413f"),
  HOOD:  equity("HOOD",  "9801bc9a0cc3eceb1ec4dfb964186a426883bb89a670c5968879b6e2c31b7c8b"),
};

async function livenessProof(def: Def, feed: OracleFeed): Promise<Record<string, unknown>> {
  const rpc = process.env.OPTA_RPC_URL ||
    (fs.existsSync(path.join(os.homedir(), ".opta-rpc-helius"))
      ? fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim()
      : "https://api.devnet.solana.com");
  const conn = new Connection(rpc, "confirmed");
  const wallet = new anchor.Wallet(Keypair.generate()); // ephemeral — nothing is signed/sent
  const sbProgram = await AnchorUtils.loadProgramFromConnection(conn, wallet, ON_DEMAND_DEVNET_PID);
  const qObj = new Queue(sbProgram, ON_DEMAND_DEVNET_QUEUE);
  const crossbar = new CrossbarClient(CROSSBAR_URL);
  const res = await buildManagedQuoteUpdateIxs(qObj, crossbar, feed, wallet.publicKey, { numSignatures: 2, instructionIdx: 1 });
  const sigs = res.captured?.signatures?.length ?? 0;
  return { gateway_signed: sigs >= MIN_ORACLE_SAMPLES, signatures: sigs, ed25519_present: res.ed25519Index >= 0, recentSlot: res.captured?.recentSlot };
}

function buildFeed(def: Def): OracleFeed {
  return OracleFeed.fromObject({
    name: def.symbol,
    jobs: def.jobs.map((o) => OracleJob.fromObject(o)),
    minOracleSamples: MIN_ORACLE_SAMPLES,
    minJobResponses: def.jobs.length,
    maxJobRangePct: MAX_JOB_RANGE_PCT,
  });
}

function localHash(def: Def): string {
  return norm(Buffer.from(FeedHash.computeOracleFeedId(buildFeed(def))).toString("hex"));
}

async function main() {
  const mode = process.argv[2];
  const asset = (process.argv[3] || "").toUpperCase();

  if (mode === "hash") {
    const keys = asset === "ALL" || !asset ? Object.keys(DEFS) : [asset];
    for (const k of keys) {
      const d = DEFS[k]; if (!d) { console.log(`${k}: UNKNOWN`); continue; }
      const h = localHash(d);
      const tag = d.expectedHash ? (h === norm(d.expectedHash) ? "MATCHES-EXPECTED ✓" : `MISMATCH vs ${d.expectedHash.slice(0,10)} ✗`) : "(new)";
      console.log(JSON.stringify({ asset: k, symbol: d.symbol, guard1_local_hash: h, note: tag }));
    }
    return;
  }

  const def = DEFS[asset];
  if (!def) { console.log(`unknown asset ${asset}. known: ${Object.keys(DEFS).join(",")}`); process.exit(2); }
  const crossbar = new CrossbarClient(CROSSBAR_URL);
  const feed = buildFeed(def);

  // GUARD 1 — local hash
  const g1 = localHash(def);
  console.log(JSON.stringify({ step: "GUARD1", asset, symbol: def.symbol, local_hash: g1 }));
  if (mode === "proof") {
    if (!def.expectedHash) { console.log("proof mode needs an expectedHash"); process.exit(2); }
    if (g1 !== norm(def.expectedHash)) { console.log(`GUARD1 FAIL: local ${g1} !== expected ${norm(def.expectedHash)} — STOP`); process.exit(3); }
    console.log(`GUARD1 PASS: local hash === expected ${def.expectedHash.slice(0,12)}… (hash computation proven)`);
  }

  // store (POST /v2/store) — content-addressed, idempotent for identical defs
  const stored = await crossbar.storeOracleFeed(feed as any);
  const serverHash = norm(stored.feedId);
  console.log(JSON.stringify({ step: "STORE", asset, cid: stored.cid, server_feedId: serverHash }));

  // GUARD 2 — server === local === predicted (expectedHash present on all defs)
  if (serverHash !== g1) { console.log(`GUARD2 FAIL: server ${serverHash} !== local ${g1} — STOP`); process.exit(4); }
  if (def.expectedHash && serverHash !== norm(def.expectedHash)) { console.log(`GUARD2 FAIL: server ${serverHash} !== predicted ${norm(def.expectedHash)} — STOP`); process.exit(4); }
  console.log(`GUARD2 PASS: server feedId === local hash${def.expectedHash ? " === predicted " + def.expectedHash.slice(0, 12) + "…" : ""}`);

  // resolution — fetch the feed back by hash
  const fetched: any = await crossbar.fetchOracleFeed(serverHash);
  const jobsBack = fetched?.feed?.jobs?.length ?? fetched?.jobs?.length ?? "?";
  console.log(JSON.stringify({ step: "RESOLVE", asset, fetched_ok: !!fetched, jobs_returned: jobsBack }));

  // signed-quote liveness — gateway must sign a quote for the new feed (nothing sent)
  if (mode === "mint") {
    try {
      const live = await livenessProof(def, feed);
      console.log(JSON.stringify({ step: "LIVENESS", asset, ...live }));
      if (!live.gateway_signed) { console.log(`LIVENESS FAIL: gateway did not sign >= ${MIN_ORACLE_SAMPLES} sigs — STOP`); process.exit(5); }
    } catch (e: any) {
      console.log(`LIVENESS ERROR: ${e?.message || e} — STOP`); process.exit(5);
    }
  }
  console.log(JSON.stringify({ RESULT: { asset, feedHash: serverHash, cid: stored.cid } }));
}

main().catch((e) => { console.error("mint-sb-feed crashed:", e?.message || e); process.exit(1); });
