// ============================================================================
// crank/_probe_reclaim_dryrun.ts — dry-run proof of the wired Phase-3 pass
// ============================================================================
// Bootstraps the SAME program/connection bot.ts uses, safeFetchAll's vaults +
// markets, and calls the EXACT `runReclaimSweep` the crank tick calls — with
// dryRun:true, so it builds + logs the 2-phase plan and SENDS NOTHING. Signs
// nothing (a throwaway wallet supplies only provider.publicKey as the notional
// cranker for ix-building).
//
//   OPTA_RPC_URL="$(cat ~/.opta-rpc-helius)" \
//     npx ts-node -r tsconfig-paths/register crank/_probe_reclaim_dryrun.ts
// (or from crank/: npx ts-node -r tsconfig-paths/register _probe_reclaim_dryrun.ts)
// ============================================================================
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { Opta } from "@app/idl/opta";
import { safeFetchAll } from "@app/hooks/useFetchAccounts";
import { runReclaimSweep, type ReclaimContext } from "./reclaimUnsettled";

(async () => {
  const rpc =
    process.env.OPTA_RPC_URL ||
    (fs.existsSync(path.join(os.homedir(), ".opta-rpc-helius"))
      ? fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim()
      : "https://api.devnet.solana.com");
  const conn = new Connection(rpc, { commitment: "confirmed" });

  // Dry-run never signs; a throwaway wallet only supplies provider.publicKey as
  // the notional cranker for ix-building.
  const wallet = new anchor.Wallet(Keypair.generate());
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf-8"),
  ) as Opta;
  const program = new Program<Opta>(idl, provider);

  const log: ReclaimContext["log"] = (level, msg, fields) =>
    console.log(JSON.stringify({ level, msg, ...(fields ?? {}) }));

  const [vaults, markets] = await Promise.all([
    safeFetchAll<any>(program, "sharedVault"),
    safeFetchAll<any>(program, "optionsMarket"),
  ]);
  console.log(`fetched: ${vaults.length} vaults, ${markets.length} markets (safeFetchAll)`);

  const ctx: ReclaimContext = { connection: conn, program, log };
  const res = await runReclaimSweep(ctx, vaults as any, markets as any, { dryRun: true });

  console.log("RESULT:", JSON.stringify({ ...res, usdcMoved: res.usdcMoved.toString() }));
  const ok =
    res.candidates === 1 &&
    res.errors === 0 &&
    res.usdcMoved === 0n &&
    res.writersReclaimed === 0 &&
    res.voided === 0;
  console.log(
    ok
      ? ">>> DRY-RUN PROOF PASS — exactly 1 candidate, 2-phase planned, moves nothing"
      : ">>> UNEXPECTED — inspect the sweep log above",
  );
  process.exit(ok ? 0 : 1);
})().catch((e) => {
  console.error("FAILED:", e.message ?? e);
  process.exit(1);
});
