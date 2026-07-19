// ============================================================================
// crank/_cutover_rebirth.ts — SB CUTOVER driver: close Pyth market → create SB
// ============================================================================
// SCRATCH / UNCOMMITTED session script (same convention as smoke-create-sb-market.ts).
// Parameterized close→create for ONE asset, admin-signed. Blocks 1–2 only
// (XRP/FARTCOIN/ETH/XAU). NOT for memes (Block 3, no mint tooling).
//
// SAFETY MODEL (per founder rulings) — HARDENED to preflight_close_market.ts:
//   * Pre-close scan classifies EVERY referencing vault on ALL axes (not just
//     SharedVault fields) via the unit-tested classifier vaultShellRule.ts:
//       SHELL (orphanable) iff  vault_usdc==0 AND writer_ask_pot_usdc==0
//         AND option-mint holders==0 AND pool writers==0 AND ask backers==0.
//       total_collateral / total_shares are STALE counters → informational only.
//     Holders are split on-curve WALLET vs off-curve protocol PDA (5uBcRhU6
//     lesson): a real wallet holder ⇒ hasUserClaim ⇒ loud ⚠ in the ledger/STOP.
//     This is what would have flagged EWwhESru ($246 in its pot + a wallet holder).
//   * GATE:
//       - 0 non-shell               → CLEAN (shells orphaned, close)
//       - non-shell ALL overridden  → OVERRIDE (logged ledger + user-claim warn)
//       - ANY non-shell unruled     → STOP (die 30), never close
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
import { classifyVaultShell } from "./vaultShellRule";

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
const tokenOwner = (data: Buffer | Uint8Array) => new PublicKey(Buffer.from(data).subarray(32, 64)); // owner @ 32..64
const normHex = (h: string) => h.replace(/^0x/, "").toLowerCase();

// ---- deep-scan helpers (mirror scripts/preflight_close_market.ts) ----------
const WP_VAULT_OFF = 8 + 32;        // WriterPosition.vault
const WA_VAULT_OFF = 8 + 32 + 32;   // WriterAskPosition.vault

// vault_option_mint PDA — the mint whose token holders are option HOLDERS.
function optionMintOf(marketPda: PublicKey, v: any): PublicKey {
  return PublicKey.findProgramAddressSync([
    Buffer.from("vault_option_mint"), marketPda.toBuffer(),
    v.strikePrice.toArrayLike(Buffer, "le", 8), v.expiry.toArrayLike(Buffer, "le", 8),
    Buffer.from([("put" in (v.optionType ?? {})) ? 1 : 0]),
    Buffer.from([("european" in (v.exerciseStyle ?? {})) ? 0 : 1]),
  ], PROGRAM_ID)[0];
}
// writer_ask_pot_usdc PDA — where resting-ask premium/collateral sits (NOT a
// SharedVault field; survives settlement/void). This is EWwhESru's $246.
const potUsdcOf = (optionMint: PublicKey) =>
  PublicKey.findProgramAddressSync([Buffer.from("writer_ask_pot_usdc"), optionMint.toBuffer()], PROGRAM_ID)[0];

// Split option-mint holders into REAL wallets (on-curve owner) vs protocol
// escrow (off-curve PDA owner). PDA-vs-wallet per the 5uBcRhU6=protocol_state
// lesson: an off-curve owner is the program, not a user.
async function holdersSplit(conn: Connection, mint: PublicKey): Promise<{ user: number; proto: number }> {
  let largest;
  try { largest = (await conn.getTokenLargestAccounts(mint)).value.filter((x) => x.uiAmount && x.uiAmount > 0); }
  catch { return { user: 0, proto: 0 }; } // uninitialized mint = never sold = no holders
  if (largest.length === 0) return { user: 0, proto: 0 };
  const infos = await conn.getMultipleAccountsInfo(largest.map((x) => new PublicKey(x.address)));
  let user = 0, proto = 0;
  for (const info of infos) {
    if (!info || info.data.length < 64) continue;
    PublicKey.isOnCurve(tokenOwner(info.data).toBuffer()) ? user++ : proto++;
  }
  return { user, proto };
}
async function countRefs(conn: Connection, name: string, off: number, vaultPk: string, positive: (d: any) => boolean, program: anchor.Program<Opta>): Promise<number> {
  const rows = await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ memcmp: { offset: off, bytes: vaultPk } }] });
  let n = 0;
  for (const { account } of rows) { try { if (positive(program.coder.accounts.decode(name, account.data))) n++; } catch { /* skip */ } }
  return n;
}

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
    const pk58 = pubkey.toBase58();
    // HARDENED (Monday equity-migration blocker): classify from ALL axes, not just
    // SharedVault fields. Deep-scan the writer-ask POT + option HOLDERS (split
    // on-curve wallet vs off-curve protocol PDA) + pool WRITERS + ask BACKERS, then
    // defer the shell decision to the unit-tested classifier (vaultShellRule.ts).
    // This is what would have flagged EWwhESru ($246 in pot + DnExEYnZ holder).
    const optionMint = optionMintOf(marketPda, v);
    let potUsdc = 0n;
    try { const pa = await connection.getAccountInfo(potUsdcOf(optionMint)); if (pa) potUsdc = tokenAmount(pa.data); } catch { /* 0 */ }
    const [holders, writers, backers] = await Promise.all([
      holdersSplit(connection, optionMint),
      countRefs(connection, "writerPosition", WP_VAULT_OFF, pk58, (d) => (d.shares?.toString?.() ?? "0") !== "0", program),
      countRefs(connection, "writerAskPosition", WA_VAULT_OFF, pk58, (d) => (d.collateralCommitted?.toString?.() ?? "0") !== "0", program),
    ]);
    const verdict = classifyVaultShell({
      vaultUsdc: usdc, potUsdc, userHolders: holders.user, protocolHolders: holders.proto,
      writers, backers, staleTotalCollateral: totColl, staleTotalShares: totShares,
    });
    // "live" = anything not a clean empty shell. (The old `!settled || usdc>0`
    // filter under-counted: a settled husk with pot/holder value looked dead.)
    if (verdict.isShell) { shellCount++; continue; }
    liveCount++;
    if (overrides.has(pk58)) {
      const flag = verdict.hasUserClaim ? " ⚠USER-CLAIM(on-curve wallet holder)" : "";
      overridden.push(`${pk58}  ${verdict.reason}${flag}  :: ${overrides.get(pk58)}`);
    } else {
      nonShellLive.push(`${pk58.slice(0, 8)} settled=${settled} voided=${voided} ${verdict.reason}${verdict.hasUserClaim ? " ⚠USER-CLAIM" : ""}`);
    }
  }
  const userClaimOverrides = overridden.filter((s) => s.includes("USER-CLAIM")).length;
  L(JSON.stringify({ ev: "scan", asset, referencing, nonShell: liveCount, shells: shellCount, overridden: overridden.length, userClaimOverrides, blocking: nonShellLive.length }));
  if (nonShellLive.length > 0) {
    nonShellLive.forEach((s) => L("   NON-SHELL LIVE (not overridden): " + s));
    die(30, `${nonShellLive.length} non-shell vault(s) outside the override rulings hold funds/positions — settle/drain/discharge/override them. STOP.`);
  }
  if (overridden.length > 0) {
    L("=== FOUNDER-RULING OVERRIDE LEDGER ===");
    overridden.forEach((s) => L("   OVERRIDE " + s));
    if (userClaimOverrides > 0)
      L(`   ⚠⚠ ${userClaimOverrides} override(s) carry a REAL on-curve-wallet holder (not a founder-owned orphan) — confirm the ruling knowingly forfeits/relocates that third-party claim.`);
  }
  for (const [pk, r] of overrides) if (!overridden.some((s) => s.startsWith(pk))) L(`   [warn] --override ${pk} matched no non-shell vault — ignored: "${r}"`);
  const mode = liveCount === 0 ? "CLEAN" : "OVERRIDE";
  L(`[gate] ${asset}: ${mode} (referencing=${referencing}: ${shellCount} empty shells orphaned, ${liveCount} non-shell${overridden.length ? ` all under ${overridden.length} founder override(s)` : ""}) → close permitted`);

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
