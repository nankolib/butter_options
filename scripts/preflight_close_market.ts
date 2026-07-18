// =============================================================================
// scripts/preflight_close_market.ts — safety gate for the admin-trusted
// close_market instruction (Pyth→Switchboard crypto migration cutover)
// =============================================================================
// close_market has NO on-chain child-check (SharedVaults are independent PDAs
// keyed by market.key() with no market-side counter — enumerating them needs
// unbounded remaining_accounts; see close_market.rs). This script IS the check:
// it scans on-chain for LIVE child vaults referencing the market and REFUSES to
// build the close tx if any exist. Run it before every close_market at cutover.
//
//   RPC_URL=$(cat ~/.opta-rpc-helius) npx ts-node scripts/preflight_close_market.ts <ASSET_NAME> [--execute]
//
// Default = dry scan + verdict (read-only). --execute additionally sends the
// close tx with the admin key — INERT until close_market ships in the cutover
// deploy (the manually-assembled ix is IDL-independent so this script works
// before the app IDL is synced).
//
// A vault is LIVE (blocks close) if it references the market AND (!is_settled OR
// its vault_usdc balance > 0). VolOracles are NOT children (keyed by feed_id) —
// they survive by design. SettlementRecords (keyed by asset_name) also survive;
// listed as an informational note for the cutover re-create.
// =============================================================================
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import {
  Connection, PublicKey, Keypair, SystemProgram, TransactionInstruction,
  TransactionMessage, VersionedTransaction, ComputeBudgetProgram,
} from "@solana/web3.js";
import { createHash } from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { Opta } from "../target/types/opta";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const CLASS = ["crypto", "commodity", "equity", "forex", "etf"];
const redact = (s: string) => s.replace(/([?&]api-key=)[^&]*/i, "$1<redacted>");
const pda = (s: (Buffer | Uint8Array)[]) => PublicKey.findProgramAddressSync(s, PROGRAM_ID)[0];
const disc = (name: string) => createHash("sha256").update(`global:${name}`).digest().subarray(0, 8);
const tokenAmount = (data: Buffer | Uint8Array) => Buffer.from(data).readBigUInt64LE(64); // SPL/T22 amount @ 64..72

async function main() {
  const asset = process.argv[2];
  const execute = process.argv.includes("--execute");
  if (!asset || asset.startsWith("--")) { console.error("usage: preflight_close_market.ts <ASSET_NAME> [--execute]"); process.exit(2); }

  const rpcUrl = process.env.RPC_URL ?? process.env.OPTA_RPC_URL ?? "https://api.devnet.solana.com";
  const conn = new Connection(rpcUrl, "confirmed");
  const signer = execute
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(process.env.OPTA_KEYPAIR ?? path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))))
    : Keypair.generate();
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(signer), { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "target", "idl", "opta.json"), "utf-8"));
  const program = new Program(idl, provider) as Program<Opta>;
  console.log(`=== preflight close_market: ${asset} ===\nRPC: ${redact(rpcUrl)}  execute: ${execute}\n`);

  // ---- 1. market must exist -------------------------------------------------
  const marketPda = pda([Buffer.from("market"), Buffer.from(asset)]);
  const mAcct = await conn.getAccountInfo(marketPda);
  if (!mAcct) { console.error(`REFUSE: no market PDA for "${asset}" (${marketPda.toBase58()}) — nothing to close`); process.exit(1); }
  const m: any = program.coder.accounts.decode("optionsMarket", mAcct.data);
  const feedHex = Buffer.from(m.pythFeedId as number[]).toString("hex");
  console.log(`market ${marketPda.toBase58()}  asset=${m.assetName}  class=${CLASS[m.assetClass] ?? m.assetClass}  oracle_source=${m.oracleSource}  feed=0x${feedHex.slice(0, 16)}…`);

  // ---- 2. scan SharedVaults referencing this market (HARDENED) --------------
  // A vault BLOCKS close if it holds funds OR any live position: vault_usdc>0,
  // OR total_collateral>0, OR any option HOLDER (amount>0), OR any pool WRITER
  // (shares>0), OR any writer-ask BACKER (committed>0). A vault is INERT
  // (safe to ORPHAN under the SB rebirth — same market PDA, $0 stakes) ONLY if
  // empty on ALL axes. The deeper holder/writer/backer scan runs only on vaults
  // that look empty by the cheap (usdc==0 && tc==0) checks — so a vault carrying
  // an external claim (e.g. a settled-OTM holder who never discharged) can NEVER
  // be misclassified as orphanable. This is the "option (a)" inert-shell rule.
  const WP_VAULT_OFF = 8 + 32;        // WriterPosition.vault
  const WA_VAULT_OFF = 8 + 32 + 32;   // WriterAskPosition.vault
  const optionMintOf = (v: any) => pda([
    Buffer.from("vault_option_mint"), marketPda.toBuffer(),
    v.strikePrice.toArrayLike(Buffer, "le", 8), v.expiry.toArrayLike(Buffer, "le", 8),
    Buffer.from([("put" in (v.optionType ?? {})) ? 1 : 0]),
    Buffer.from([("european" in (v.exerciseStyle ?? {})) ? 0 : 1]),
  ]);
  const liveHolders = async (mint: PublicKey): Promise<number> => {
    try { return (await conn.getTokenLargestAccounts(mint)).value.filter((x) => x.uiAmount && x.uiAmount > 0).length; }
    catch { return 0; } // uninitialized mint = never sold = no holders
  };
  const countRefs = async (name: string, off: number, vaultPk: string, positive: (d: any) => boolean): Promise<number> => {
    const rows = await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ memcmp: { offset: off, bytes: vaultPk } }] });
    let n = 0;
    for (const { account } of rows) { try { if (positive(program.coder.accounts.decode(name, account.data))) n++; } catch { /* skip */ } }
    return n;
  };

  const vDisc = (program.coder.accounts as any).memcmp("sharedVault") as { offset: number; bytes: string };
  const raw = await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ memcmp: { offset: vDisc.offset, bytes: vDisc.bytes } }] });
  const children: Array<{ pk: string; blocker: boolean; reason: string; settled: boolean; strike: number; expiry: number; ot: string }> = [];
  for (const { pubkey, account } of raw) {
    let v: any;
    try { v = program.coder.accounts.decode("sharedVault", account.data); } catch { continue; }
    if (new PublicKey(v.market).toBase58() !== marketPda.toBase58()) continue;
    let usdc = 0n;
    try { const ta = await conn.getAccountInfo(new PublicKey(v.vaultUsdcAccount)); if (ta) usdc = tokenAmount(ta.data); } catch { /* leave 0 */ }
    const tc = BigInt(v.totalCollateral?.toString?.() ?? 0);
    const pk = pubkey.toBase58();
    // Block ONLY on real, actionable state: actual funds (vault_usdc>0) or a live
    // position (holder amount>0, writer shares>0, backer committed>0). NOTE: we do
    // NOT block on total_collateral — the run proved it is a STALE historical
    // counter (old settled vaults carry tc>0 with $0 real funds and no live
    // positions); blocking on it would false-positive ~17 fully-drained vaults.
    // The deep scan runs on EVERY vault so a live position can never be missed.
    const [h, w, b] = await Promise.all([
      liveHolders(optionMintOf(v)),
      countRefs("writerPosition", WP_VAULT_OFF, pk, (d) => (d.shares?.toString?.() ?? "0") !== "0"),
      countRefs("writerAskPosition", WA_VAULT_OFF, pk, (d) => (d.collateralCommitted?.toString?.() ?? "0") !== "0"),
    ]);
    const reasons: string[] = [];
    if (usdc > 0n) reasons.push(`vault_usdc=$${(Number(usdc) / 1e6).toFixed(2)}`);
    if (h || w || b) reasons.push(`positions holders=${h} writers=${w} backers=${b}`);
    const blocker = reasons.length > 0;
    const reason = blocker
      ? reasons.join(" ")
      : tc > 0n
      ? `inert (stale tc=$${(Number(tc) / 1e6).toFixed(2)}, $0 funds, no positions → orphanable)`
      : "inert (empty shell → orphanable)";
    children.push({ pk, blocker, reason, settled: !!v.isSettled, strike: Number(v.strikePrice?.toString?.() ?? 0) / 1e6, expiry: Number(v.expiry?.toString?.() ?? 0), ot: "put" in (v.optionType ?? {}) ? "Put" : "Call" });
  }
  const blockers = children.filter((c) => c.blocker);
  const inert = children.filter((c) => !c.blocker);
  console.log(`\nSharedVaults referencing market: ${children.length}  (BLOCKERS: ${blockers.length}, inert-orphanable: ${inert.length})`);
  for (const c of children) {
    console.log(`  ${c.blocker ? "BLOCK" : "inert"}  ${c.ot} $${c.strike}  exp=${c.expiry}  settled=${c.settled}  ${c.reason}  ${c.pk}`);
  }

  // ---- 3. informational: SettlementRecords + VolOracle survive --------------
  const volPda = pda([Buffer.from("vol_oracle"), Buffer.from(feedHex, "hex")]);
  const volLive = await conn.getAccountInfo(volPda);
  console.log(`\n[note] VolOracle ${volPda.toBase58()} ${volLive ? "EXISTS" : "absent"} — NOT a child (keyed by feed_id); survives close (cutover re-create inherits it).`);
  try {
    const sDisc = (program.coder.accounts as any).memcmp("settlementRecord") as { offset: number; bytes: string };
    const sraw = await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ memcmp: { offset: sDisc.offset, bytes: sDisc.bytes } }] });
    const recs = sraw.map(({ account }) => { try { return program.coder.accounts.decode("settlementRecord", account.data); } catch { return null; } })
      .filter((r: any) => r && r.assetName === m.assetName);
    console.log(`[note] SettlementRecords for ${m.assetName}: ${recs.length} — keyed by asset_name; survive close (informational for re-create).`);
  } catch { /* best-effort */ }

  // ---- 4. verdict -----------------------------------------------------------
  if (blockers.length > 0) {
    console.error(`\nREFUSE: ${blockers.length} vault(s) hold funds or a live position on ${asset} — settle / drain / discharge them before closing. Tx NOT built.`);
    for (const c of blockers) console.error(`   BLOCK ${c.pk}  ${c.reason}`);
    process.exit(1);
  }
  if (inert.length > 0) {
    console.log(`\n[note] ${inert.length} inert vault(s) will be ORPHANED under the SB rebirth (same market PDA) — $0 funds, no holders/writers/backers. Safe.`);
  }
  console.log(`\n✅ SAFE TO CLOSE: no vault holds funds or a live position on ${asset}.`);

  // ---- 5. build the close tx (IDL-independent; INERT until deploy) ----------
  const [protocolState] = PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], PROGRAM_ID);
  const nameBuf = Buffer.from(asset, "utf-8");
  const dataLen = Buffer.alloc(4); dataLen.writeUInt32LE(nameBuf.length, 0);
  const ix = new TransactionInstruction({
    programId: PROGRAM_ID,
    keys: [
      { pubkey: signer.publicKey, isSigner: true, isWritable: true }, // admin
      { pubkey: protocolState, isSigner: false, isWritable: false },
      { pubkey: marketPda, isSigner: false, isWritable: true },
    ],
    data: Buffer.concat([disc("close_market"), dataLen, nameBuf]),
  });
  console.log(`built close_market ix (admin=${execute ? signer.publicKey.toBase58() : "<admin at execute>"}, market=${marketPda.toBase58()})`);

  if (!execute) { console.log("\n(dry run — re-run with --execute after the cutover deploy to send)"); return; }
  const bh = await conn.getLatestBlockhash();
  const tx = new VersionedTransaction(new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: bh.blockhash, instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 50_000 }), ix] }).compileToV0Message());
  tx.sign([signer]);
  const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
  if (sim.value.err) {
    console.error(`sim err ${JSON.stringify(sim.value.err)} — close_market likely NOT yet deployed (INERT until the cutover deploy). Logs:`);
    (sim.value.logs ?? []).slice(-4).forEach((l) => console.error("  " + l));
    process.exit(1);
  }
  const sig = await conn.sendTransaction(tx);
  await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
  console.log(`✅ closed ${asset} — sig=${sig}`);
}
main().catch((e) => { console.error("FATAL:", e?.message ?? e); process.exit(1); });
