// =============================================================================
// crank/settleGuardJul31.ts — Pyth-deadline settle-at-expiry GUARD.
// =============================================================================
// PURPOSE: at a target expiry instant (default Jul-31 08:00Z — the last epoch
// before the Pyth/Hermes paywall), guarantee a SettlementRecord lands for EVERY
// live-Pyth (asset, expiry) tuple, so no funded vault falls into the 7-day
// grace → void → holder-forfeit path just because free Hermes died.
//
// The sweep is DYNAMIC: it enumerates every live-Pyth vault on-chain and derives
// the distinct (asset, expiry==TARGET) tuples itself. NO hardcoded vault/asset
// list — a tuple minted after this file was written is still swept.
//
// Settlement is PER-(asset,expiry) via the SettlementRecord PDA, so the guard
// settles TUPLES, not vaults: one settle_expiry per tuple makes every vault at
// that (asset,expiry) settleable. Permissionless — the caller only pays rent.
//
//   READ-ONLY (default): enumerate + report state, no tx sent.
//     OPTA_RPC_URL=$(cat ~/.opta-rpc-helius) \
//       npx ts-node -r tsconfig-paths/register settleGuardJul31.ts
//   EXECUTE (Jul-31, after 08:00Z, with the crank/admin key):
//     OPTA_RPC_URL=... OPTA_KEYPAIR=/opt/opta-crank/secrets/crank.json \
//       npx ts-node -r tsconfig-paths/register settleGuardJul31.ts --execute
//   Optional: --expiry=<unix|ISO> to target a different epoch.
// =============================================================================
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";

import type { Opta } from "@app/idl/opta";
import { safeFetchAll } from "@app/hooks/useFetchAccounts";
import { buildPostUpdateAndSettleTx, type SignerWallet } from "@app/utils/pythPullPost";

const SETTLEMENT_SEED = "settlement";
const DEFAULT_TARGET = Math.floor(Date.parse("2026-07-31T08:00:00Z") / 1000);
const HERMES = process.env.OPTA_HERMES_BASE || "https://hermes.pyth.network";
const redact = (s: string) => s.replace(/([?&]api-key=)[^&]*/i, "$1<redacted>");

function parseTarget(): number {
  const arg = process.argv.find((a) => a.startsWith("--expiry="));
  if (!arg) return DEFAULT_TARGET;
  const raw = arg.split("=")[1];
  return /^\d+$/.test(raw) ? Number(raw) : Math.floor(Date.parse(raw) / 1000);
}

(async () => {
  const execute = process.argv.includes("--execute");
  const target = parseTarget();
  const rpc = process.env.OPTA_RPC_URL || fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim();
  const conn = new Connection(rpc, { commitment: "confirmed" });

  const signer = execute
    ? Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(
        process.env.OPTA_KEYPAIR ?? path.join(os.homedir(), ".config/solana/id.json"), "utf-8"))))
    : Keypair.generate();
  const wallet = new anchor.Wallet(signer);
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  const program = new Program<Opta>(
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf-8")) as Opta,
    provider);

  const now = (await conn.getBlockTime(await conn.getSlot()))!;
  console.log(`=== settleGuardJul31 ${execute ? "[EXECUTE]" : "[DRY-RUN read-only]"} ===`);
  console.log(`RPC: ${redact(rpc)}`);
  console.log(`cluster now: ${new Date(now * 1000).toISOString()}`);
  console.log(`target expiry: ${new Date(target * 1000).toISOString()} (unix=${target})`);
  console.log(`caller: ${execute ? signer.publicKey.toBase58() : "<throwaway, dry-run>"}\n`);

  // ---- Dynamic sweep set: distinct live-Pyth (asset,expiry==target) tuples ----
  const [vaults, markets] = await Promise.all([
    safeFetchAll<any>(program, "sharedVault"), safeFetchAll<any>(program, "optionsMarket")]);
  const mById = new Map<string, any>(); for (const m of markets) mById.set(m.publicKey.toBase58(), m.account);
  const tuples = new Map<string, { asset: string; expiry: number; feedHex: string; live: number; funded: number }>();
  for (const v of vaults) {
    const a = v.account; const mkt = mById.get((a.market as PublicKey).toBase58());
    if (!mkt || mkt.oracleSource !== 0) continue;          // Pyth-source only
    if (a.isSettled || a.voided) continue;                 // live only
    const exp = typeof a.expiry === "number" ? a.expiry : a.expiry.toNumber();
    if (exp !== target) continue;
    const key = `${mkt.assetName}|${exp}`;
    const t = tuples.get(key) ?? { asset: mkt.assetName, expiry: exp, feedHex: Buffer.from(mkt.pythFeedId).toString("hex"), live: 0, funded: 0 };
    t.live++; if (BigInt(a.totalCollateral.toString()) > 0n) t.funded++;
    tuples.set(key, t);
  }
  if (tuples.size === 0) { console.log("no live-Pyth tuples at target expiry — nothing to sweep."); process.exit(0); }
  console.log(`sweep set: ${tuples.size} distinct tuple(s)\n`);

  let settled = 0, pending = 0, wouldSettle = 0, alerts = 0;
  for (const t of tuples.values()) {
    const expiryBN = new anchor.BN(t.expiry);
    const [srec] = PublicKey.findProgramAddressSync(
      [Buffer.from(SETTLEMENT_SEED), Buffer.from(t.asset), expiryBN.toArrayLike(Buffer, "le", 8)], program.programId);
    const has = await conn.getAccountInfo(srec);
    const tag = `${t.asset} @ ${new Date(t.expiry * 1000).toISOString()} (live=${t.live} funded=${t.funded})`;

    if (has) { console.log(`  ✅ SETTLED   ${tag}  record=${srec.toBase58()}`); settled++; continue; }
    if (now < t.expiry) {
      console.log(`  ⏳ PENDING   ${tag}  — not expired yet (${((t.expiry - now) / 3600).toFixed(1)}h to go); guard will settle at expiry`);
      pending++; continue;
    }
    // Expired, no record → the settle window is OPEN. This is the guard's job.
    console.log(`  ⚠ NEEDS-SETTLE ${tag}  — expired ${((now - t.expiry) / 3600).toFixed(1)}h ago, NO record`);
    try {
      const txs = await buildPostUpdateAndSettleTx(program, wallet as SignerWallet, t.asset, t.expiry, t.feedHex, HERMES);
      if (!execute) {
        // read-only: simulate the first tx to prove the at-expiry Pyth print + settle land.
        const sim = await conn.simulateTransaction(txs[0].tx, { sigVerify: false, replaceRecentBlockhash: true });
        if (sim.value.err) { console.log(`     SIM ERR ${JSON.stringify(sim.value.err)} — ${(sim.value.logs ?? []).slice(-3).join(" | ")}`); alerts++; }
        else { console.log(`     WOULD SETTLE (sim OK) — re-run with --execute to send`); wouldSettle++; }
      } else {
        for (const b of txs) {
          b.tx.sign([signer, ...b.signers as Keypair[]]);
          const sig = await conn.sendTransaction(b.tx, { skipPreflight: false });
          await conn.confirmTransaction(sig, "confirmed");
          console.log(`     ✅ SETTLED — sig=${sig}`);
        }
        settled++;
      }
    } catch (e: any) {
      console.log(`     ‼ ALERT: settle build/send FAILED — ${e?.message ?? e}`);
      console.log(`       → Hermes may be paywalled/rate-limited. Escalate to manual settle NOW.`);
      alerts++;
    }
  }

  console.log(`\nsummary: settled=${settled} pending=${pending} would-settle=${wouldSettle} ALERTS=${alerts}`);
  if (alerts > 0) { console.error(`\n‼‼ ${alerts} tuple(s) could not be settled — MANUAL INTERVENTION REQUIRED before the paywall.`); process.exit(3); }
  process.exit(0);
})().catch((e) => { console.error("FATAL:", e.stack ?? e.message ?? e); process.exit(1); });
