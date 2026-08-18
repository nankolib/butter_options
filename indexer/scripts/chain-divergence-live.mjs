// =============================================================================
// chain-divergence-live.mjs — run the read path against the REAL chain
// =============================================================================
//
// Unit tests prove the harness catches an injected fault. This proves the whole
// pipeline is faithful against live devnet: scan -> decode -> store -> serve,
// then compare every stored row back to chain.
//
//   run: node scripts/chain-divergence-live.mjs
// =============================================================================
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const { openDb } = require("../dist/src/db.js");
const { refreshChain } = require("../dist/src/chain/refresh.js");
const { checkDivergence, divergenceClean } = require("../dist/src/chain/divergence.js");
const { RpcClient } = require("../dist/src/tape/rpc.js");
const {
  getChainVaults, getChainMarkets, getChainSeries, getChainEpochs, getChainMeta,
} = require("../dist/src/chain/handlers.js");

const RPC_URL = process.env.OPTA_RPC_URL || "https://rpc.opta.fyi/devnet";
const PROGRAM = "CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq";

// OPTA_DB_PATH checks an EXISTING database (the live one on the box) instead of
// scanning into a throwaway. Without it this harness only ever validates a scan
// it just performed itself, which is not what is being served to users.
const existing = process.env.OPTA_DB_PATH;
const dir = existing ? null : fs.mkdtempSync(path.join(os.tmpdir(), "opta-chain-live-"));
const db = openDb(existing ?? path.join(dir, "live.db"));
if (existing) console.log("checking LIVE database " + existing);
const rpc = new RpcClient(RPC_URL);

if (!existing) {
console.log(`scanning ${RPC_URL} ...`);
const t0 = Date.now();
const res = await refreshChain(db, rpc, PROGRAM);
console.log(`scan took ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);
for (const r of res) {
  console.log(`  ${r.kind.padEnd(14)} slot ${r.slot}  fetched ${String(r.fetched).padStart(5)}  stored ${String(r.stored).padStart(5)}  rejected ${String(r.rejected).padStart(4)}  ${JSON.stringify(r.rejectedBySize)}`);
}

console.log("\nrunning divergence check against chain ...");
}

const reports = await checkDivergence(db, rpc, PROGRAM);
for (const r of reports) {
  console.log(`  ${r.kind.padEnd(14)} checked ${String(r.checked).padStart(5)}  comparable ${String(r.comparable).padStart(5)}  changed ${String(r.changed).padStart(3)}  missing ${r.missing}  orphaned ${r.orphaned}  DIVERGENT ${r.divergent}`);
  r.examples.slice(0, 3).forEach((e) => console.log(`      ! ${e}`));
}
const clean = divergenceClean(reports);

// Payload sizes — the entire justification for the read path.
console.log("\npayload sizes (what the browser would actually download):");
let total = 0;
for (const [name, fn] of [
  ["vaults", () => getChainVaults(db, new URLSearchParams())],
  ["series", () => getChainSeries(db, new URLSearchParams())],
  ["markets", () => getChainMarkets(db, new URLSearchParams())],
  ["epochs", () => getChainEpochs(db, new URLSearchParams())],
]) {
  const body = JSON.stringify(fn().body);
  const gz = require("node:zlib").gzipSync(Buffer.from(body)).length;
  total += gz;
  console.log(`  ${name.padEnd(8)} raw ${(body.length / 1e6).toFixed(2)} MB   gzip ${(gz / 1e6).toFixed(2)} MB`);
}
console.log(`  ${"TOTAL".padEnd(8)} gzip ${(total / 1e6).toFixed(2)} MB   (chain path today: ~5.4 MB of raw accounts)`);

const meta = getChainMeta(db, { programId: PROGRAM, deploySlot: null });
console.log(`\n/meta healthy=${meta.body.healthy} oldestAgeSec=${meta.body.oldestAgeSec} lineage=${meta.body.lineage.key}`);

console.log(`\n${clean ? "DIVERGENCE CLEAN" : "DIVERGENT — DO NOT CUT OVER"}`);
if (dir) fs.rmSync(dir, { recursive: true, force: true });
process.exit(clean ? 0 : 1);
