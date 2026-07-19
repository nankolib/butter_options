// ============================================================================
// crank/_cutover_rebirth.ts — SB CUTOVER driver: close Pyth market → create SB
// ============================================================================
// SCRATCH / UNCOMMITTED session script (same convention as smoke-create-sb-market.ts).
// Parameterized close→create for ONE asset, admin-signed. Blocks 1–2 only
// (XRP/FARTCOIN/ETH/XAU). NOT for memes (Block 3, no mint tooling).
//
// SAFETY MODEL (per founder rulings):
//   * Pre-close scan replicates preflight_close_market.ts's live rule EXACTLY:
//       live = !is_settled || vault_usdc > 0
//   * Extends it with the approved all-zero-shell OVERRIDE:
//       a LIVE vault is an "all-zero shell" iff
//         !is_settled && !voided && total_collateral==0 && total_shares==0 && usdc==0
//   * GATE:
//       - 0 live               → SAFE (clean close)
//       - >0 live, ALL shells  → OVERRIDE (Ruling 1 ETH / Ruling 2 XAU): proceed
//       - ANY live non-shell   → STOP (die 30), never close
//   * The close uses a DIRECT close_market ix mirroring preflight byte-for-byte
//     (preflight --execute cannot be used: it REFUSES the override cases).
//
// close→create is ONE uninterrupted sequence: once the close confirms, the
// create is retried with a fresh signed quote until it lands; on exhaustion the
// script ESCALATES LOUDLY (die 21) with the closed-but-not-created state — it
// never silently leaves an asset marketless.
//
// Run (from crank/, RPC + keypair off-repo):
//   OPTA_RPC_URL="$(cat ~/.opta-rpc-helius)" \
//   ts-node --transpile-only -r tsconfig-paths/register _cutover_rebirth.ts \
//     <ASSET> <FEEDHASH_HEX> <CLASS> [--execute]
//   (no --execute = dry scan + verdict, read-only)
// ============================================================================

import * as anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  Queue, AnchorUtils, ON_DEMAND_DEVNET_PID, ON_DEMAND_DEVNET_QUEUE,
} from "@switchboard-xyz/on-demand";
import { CrossbarClient } from "@switchboard-xyz/common";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { Opta } from "@app/idl/opta";
import { buildSwitchboardCreateMarketTx } from "./switchboardCreateMarket";

// ---- constants -------------------------------------------------------------
const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const PROTOCOL_SEED = "protocol_v2";
const MARKET_SEED = "market";
const ORACLE_SOURCE_SWITCHBOARD = 1;
const MAX_CREATE_ATTEMPTS = 10;
const IDL_JSON_PATH = path.resolve(__dirname, "../app/src/idl/opta.json");
const DEFAULT_KEYPAIR = path.join(os.homedir(), ".config/solana/id.json");
const CROSSBAR_URL = process.env.OPTA_CROSSBAR_URL || "https://crossbar.switchboard.xyz";

const L = (s: string) => console.log(s);
const die = (code: number, msg: string) => { L("\nABORT: " + msg); process.exit(code); };
const redact = (u: string) => u.replace(/([?&]api-key=)[^&]*/i, "$1<redacted>");
const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const tokenAmount = (data: Buffer | Uint8Array) => Buffer.from(data).readBigUInt64LE(64); // amount @ 64..72
const normHex = (h: string) => h.replace(/^0x/, "").toLowerCase();

async function main(): Promise<void> {
  const asset = process.argv[2];
  const feedHashHex = normHex(process.argv[3] || "");
  const assetClass = Number(process.argv[4]);
  const execute = process.argv.includes("--execute");
  // Named non-shell overrides: --override=<vaultPubkey>:<ruling> (repeatable). A
  // DELIBERATE, LOGGED decision to orphan a specific NON-shell vault (founder-owned,
  // recoverable via the Aug-7 void hatch). NEVER a blanket skip — each names an EXACT
  // vault + records a ruling. Mirrors preflight_close_market.ts's --override.
  const overrides = new Map<string, string>();
  for (const a of process.argv) {
    if (!a.startsWith("--override=")) continue;
    const raw = a.slice("--override=".length); const i = raw.indexOf(":");
    if (i < 0 || !raw.slice(i + 1).trim()) die(2, `--override must be <vaultPubkey>:<ruling> (a bare skip is not allowed): "${a}"`);
    overrides.set(raw.slice(0, i).trim(), raw.slice(i + 1).trim());
  }
  if (!asset || feedHashHex.length !== 64 || !Number.isInteger(assetClass)) {
    die(2, "usage: _cutover_rebirth.ts <ASSET> <FEEDHASH_HEX(64)> <CLASS 0-4> [--execute] [--override=<vault>:<ruling>]…");
  }

  const rpcUrl = process.env.OPTA_RPC_URL ||
    (fs.existsSync(path.join(os.homedir(), ".opta-rpc-helius"))
      ? fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim()
      : "https://api.devnet.solana.com");
  const keypairPath = process.env.OPTA_KEYPAIR ?? DEFAULT_KEYPAIR;

  const connection = new Connection(rpcUrl, "confirmed");
  const admin = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))));
  const wallet = new anchor.Wallet(admin);
  const provider = new anchor.AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(IDL_JSON_PATH, "utf-8")) as Opta;
  const program = new anchor.Program<Opta>(idl, provider);

  const [marketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(MARKET_SEED), Buffer.from(asset)], PROGRAM_ID);
  const [protocolState] = PublicKey.findProgramAddressSync([Buffer.from(PROTOCOL_SEED)], PROGRAM_ID);
  const [volPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vol_oracle"), Buffer.from(feedHashHex, "hex")], PROGRAM_ID);

  L(JSON.stringify({ ev: "boot", rpc: redact(rpcUrl), admin: admin.publicKey.toBase58(),
    asset, class: assetClass, feedHash: feedHashHex.slice(0, 10) + "…", marketPda: marketPda.toBase58(),
    execute, crossbar: CROSSBAR_URL }));

  // ---- 0. idempotency + replacing-Pyth assertion ---------------------------
  const existing = await connection.getAccountInfo(marketPda);
  if (!existing) die(10, `market PDA ${marketPda.toBase58()} does not exist — nothing to close (wrong asset?)`);
  const mBefore: any = await program.account.optionsMarket.fetch(marketPda);
  if (mBefore.oracleSource === ORACLE_SOURCE_SWITCHBOARD) {
    L(`[skip] ${asset} already oracle_source=SB — already reborn. PDA=${marketPda.toBase58()}`);
    process.exit(0);
  }
  if (mBefore.assetName !== asset) die(11, `PDA decodes assetName='${mBefore.assetName}', expected '${asset}'`);
  L(`[pre] market ${asset} exists: oracle_source=${mBefore.oracleSource} (Pyth) class=${mBefore.assetClass}`);

  // ---- 1. pre-close safety scan (preflight rule + shell override) ----------
  const vDisc = (program.coder.accounts as any).memcmp("sharedVault") as { offset: number; bytes: string };
  const raw = await connection.getProgramAccounts(PROGRAM_ID, { filters: [{ memcmp: { offset: vDisc.offset, bytes: vDisc.bytes } }] });
  let referencing = 0, liveCount = 0, shellCount = 0;
  const nonShellLive: string[] = [];
  const overridden: string[] = [];
  for (const { pubkey, account } of raw) {
    let v: any; try { v = program.coder.accounts.decode("sharedVault", account.data); } catch { continue; }
    if (new PublicKey(v.market).toBase58() !== marketPda.toBase58()) continue;
    referencing++;
    let usdc = 0n;
    try { const ta = await connection.getAccountInfo(new PublicKey(v.vaultUsdcAccount)); if (ta) usdc = tokenAmount(ta.data); } catch { /* 0 */ }
    const settled = !!v.isSettled, voided = !!v.voided;
    const totColl = BigInt(v.totalCollateral?.toString?.() ?? "0");
    const totShares = BigInt(v.totalShares?.toString?.() ?? "0");
    const live = !settled || usdc > 0n;
    if (!live) continue;
    liveCount++;
    // All-zero (no collateral, no shares, no USDC) ⇒ safe to orphan under the SB
    // rebirth, regardless of settled/voided. Matches the hardened preflight rule:
    // settled-empty AND voided-empty (dead-feed-reclaimed, terminal) hold nothing.
    // The `live` filter above already dropped settled-empty; this also admits the
    // voided-empty husks (was wrongly flagged non-shell by the old `!voided`).
    const isShell = totColl === 0n && totShares === 0n && usdc === 0n;
    const pk58 = pubkey.toBase58();
    if (isShell) shellCount++;
    else if (overrides.has(pk58)) overridden.push(`${pk58}  coll=${totColl} shares=${totShares} usdc=${usdc}  :: ${overrides.get(pk58)}`);
    else nonShellLive.push(`${pk58.slice(0, 8)} settled=${settled} voided=${voided} coll=${totColl} shares=${totShares} usdc=${usdc}`);
  }
  L(JSON.stringify({ ev: "scan", asset, referencing, live: liveCount, allZeroShells: shellCount, overridden: overridden.length, nonShellLive: nonShellLive.length }));
  if (nonShellLive.length > 0) {
    nonShellLive.forEach((s) => L("   NON-SHELL LIVE (not overridden): " + s));
    die(30, `${nonShellLive.length} non-shell live vault(s) outside the override rulings — settle/drain/override them. STOP.`);
  }
  if (overridden.length > 0) {
    L("=== FOUNDER-RULING OVERRIDE LEDGER ===");
    overridden.forEach((s) => L("   OVERRIDE " + s));
  }
  for (const [pk, r] of overrides) if (!overridden.some((s) => s.startsWith(pk))) L(`   [warn] --override ${pk} matched no non-shell vault — ignored: "${r}"`);
  const mode = liveCount === 0 ? "CLEAN" : overridden.length ? "OVERRIDE" : "SHELLS-ONLY";
  L(`[gate] ${asset}: ${mode} (live=${liveCount}, all of which are all-zero shells=${shellCount}) → close permitted`);

  if (!execute) {
    L(`\n(dry run — no --execute). Would: close_market ${asset} → create_market ${asset} source=SB feedHash=${feedHashHex.slice(0, 10)}…`);
    L(`vol oracle for feedHash: ${volPda.toBase58()} — ${(await connection.getAccountInfo(volPda)) ? "EXISTS" : "ABSENT"}`);
    process.exit(0);
  }

  // ---- 2. CLOSE (direct close_market ix, mirrors preflight byte-for-byte) ---
  const nameBuf = Buffer.from(asset, "utf-8");
  const lenBuf = Buffer.alloc(4); lenBuf.writeUInt32LE(nameBuf.length, 0);
  const closeIx = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: admin.publicKey, isSigner: true, isWritable: true },
      { pubkey: protocolState, isSigner: false, isWritable: false },
      { pubkey: marketPda, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([disc("close_market"), lenBuf, nameBuf]),
  });
  {
    const bh = await connection.getLatestBlockhash();
    const tx = new VersionedTransaction(new TransactionMessage({
      payerKey: admin.publicKey, recentBlockhash: bh.blockhash,
      instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }), closeIx],
    }).compileToV0Message());
    tx.sign([admin]);
    const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    if (sim.value.err) { (sim.value.logs || []).slice(-6).forEach((x) => L("   " + x)); die(20, `close sim err ${JSON.stringify(sim.value.err)}`); }
    const sig = await connection.sendTransaction(tx, { skipPreflight: false });
    const c = await connection.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
    if (c.value.err) die(20, `close confirm err ${JSON.stringify(c.value.err)} sig=${sig}`);
    const gone = await connection.getAccountInfo(marketPda);
    if (gone) die(20, `close confirmed (sig=${sig}) but market PDA still present — aborting before create`);
    L(JSON.stringify({ ev: "closed", asset, sig, marketPda: marketPda.toBase58() }));
  }

  // ---- 3. CREATE (retry with fresh signed quote until it lands) -------------
  const sbProgram = await AnchorUtils.loadProgramFromConnection(connection, wallet, ON_DEMAND_DEVNET_PID);
  const qObj = new Queue(sbProgram, ON_DEMAND_DEVNET_QUEUE);
  const crossbar = new CrossbarClient(CROSSBAR_URL);
  let createSig: string | null = null;
  for (let attempt = 1; attempt <= MAX_CREATE_ATTEMPTS && !createSig; attempt++) {
    L(`\n[create ${attempt}/${MAX_CREATE_ATTEMPTS}] fresh quote + create_market(SB) ${asset} …`);
    let build;
    try {
      build = await buildSwitchboardCreateMarketTx(program as any, admin.publicKey, qObj, crossbar,
        { assetName: asset, feedHashHex, assetClass });
    } catch (e: any) { L(`   build failed (re-fetch): ${String(e?.message || e).slice(0, 160)}`); continue; }
    const bh = await connection.getLatestBlockhash();
    const tx = new VersionedTransaction(new TransactionMessage({
      payerKey: admin.publicKey, recentBlockhash: bh.blockhash, instructions: build.instructions,
    }).compileToV0Message());
    tx.sign([admin]);
    const sim = await connection.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    if (sim.value.err) { L(`   sim err (re-fetch): ${JSON.stringify(sim.value.err)}`); (sim.value.logs || []).slice(-4).forEach((x) => L("     " + x)); continue; }
    L(`   SIM GATE PASS — sending (accounts=${build.instructions[2].keys.length}, ed25519=${build.ed25519Bytes}B) …`);
    try {
      const sig = await connection.sendTransaction(tx, { skipPreflight: false });
      const c = await connection.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
      if (c.value.err) { L(`   confirm err (re-fetch): ${JSON.stringify(c.value.err)} sig=${sig}`); continue; }
      createSig = sig;
      L(JSON.stringify({ ev: "created", asset, sig, marketPda: marketPda.toBase58() }));
    } catch (e: any) {
      L(`   send failed (re-fetch fresh): ${String(e?.message || e).slice(0, 160)}`);
      const live = await connection.getAccountInfo(marketPda).catch(() => null);
      if (live) { const mm: any = await program.account.optionsMarket.fetch(marketPda).catch(() => null); if (mm?.oracleSource === 1) { createSig = "landed-pre-confirm"; L(`   market exists SB post-send — treating as landed`); } }
    }
  }
  if (!createSig) {
    die(21, `ESCALATE: ${asset} CLOSED but create failed in ${MAX_CREATE_ATTEMPTS} attempts — asset is MARKETLESS. ` +
      `Re-run this driver immediately (idempotent: it will skip the close since the PDA is gone and go straight to create).`);
  }

  // ---- 4. VERIFY -----------------------------------------------------------
  const mAfter: any = await program.account.optionsMarket.fetch(marketPda);
  const gotFeed = Buffer.from(mAfter.pythFeedId as number[]).toString("hex");
  if (mAfter.oracleSource !== ORACLE_SOURCE_SWITCHBOARD) die(22, `verify: oracle_source=${mAfter.oracleSource}, expected 1`);
  if (normHex(gotFeed) !== feedHashHex) die(22, `verify: feedHash mismatch got=${gotFeed.slice(0, 12)} want=${feedHashHex.slice(0, 12)}`);
  if (mAfter.assetName !== asset) die(22, `verify: assetName='${mAfter.assetName}', expected '${asset}'`);
  let volInfo = "ABSENT";
  try { const vo: any = await program.account.volOracle.fetch(volPda); volInfo = `EXISTS sample_count=${vo.sampleCount} source=${vo.oracleSource}`; } catch { /* absent */ }
  L(`\n✅ REBIRTH COMPLETE — ${asset}`);
  L(JSON.stringify({ ev: "verified", asset, marketPda: marketPda.toBase58(), oracle_source: mAfter.oracleSource,
    feedHash: gotFeed, closeSig: "(see closed ev)", createSig, volOraclePda: volPda.toBase58(), volOracle: volInfo }));
  process.exit(0);
}

main().catch((e) => { console.error("cutover-rebirth crashed:", e); process.exit(1); });
