// ============================================================================
// crank/_canary_reclaim.ts — LIVE one-shot reclaim canary (greenlight-gated)
// ============================================================================
// HELD until a real writer-bearing, zero-premium, void-eligible candidate
// exists on devnet. Run ONLY under explicit greenlight — this MOVES MONEY and
// the `voided` flag it sets is TERMINAL (irreversible).
//
// Takes the vault pubkey as a REQUIRED CLI arg so it's reusable for whatever
// candidate appears (NOT hardcoded to any one vault):
//   OPTA_RPC_URL="$(cat ~/.opta-rpc-helius)" \
//     npx ts-node -r tsconfig-paths/register crank/_canary_reclaim.ts <VAULT_PUBKEY>
//
// Signs with OPTA_CRANK_KEYPAIR (default ~/.config/solana/id.json). 2-phases the
// vault via the SAME `reclaimVault` the crank uses: initialize_void → per-writer
// reclaim_unsettled. Reports both tx legs + terminal state (voided flag, writer
// shares zeroed). NOTE: if the vault has 0 WriterPositions this proves ONLY the
// initialize_void leg — reclaim_unsettled never fires without a writer to pay.
// ============================================================================
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { Opta } from "@app/idl/opta";
import {
  reclaimVault,
  listWriterPositionsForVault,
  type ReclaimContext,
} from "./reclaimUnsettled";

async function usdcBal(conn: Connection, acc: PublicKey): Promise<string> {
  const a = await conn.getAccountInfo(acc);
  return a ? a.data.readBigUInt64LE(64).toString() : "(no account)";
}

(async () => {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: _canary_reclaim.ts <VAULT_PUBKEY>");
    process.exit(1);
  }
  const VAULT = new PublicKey(arg);

  const rpc =
    process.env.OPTA_RPC_URL ||
    fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim();
  const conn = new Connection(rpc, { commitment: "confirmed" });
  const keypairPath =
    process.env.OPTA_CRANK_KEYPAIR || path.join(os.homedir(), ".config/solana/id.json");
  const cranker = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf-8"))),
  );
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(cranker), {
    commitment: "confirmed",
  });
  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf-8"),
  ) as Opta;
  const program = new Program<Opta>(idl, provider);

  const log: ReclaimContext["log"] = (level, msg, fields) =>
    console.log(JSON.stringify({ level, msg, ...(fields ?? {}) }));
  const ctx: ReclaimContext = { connection: conn, program, log };

  const pre: any = await program.account.sharedVault.fetch(VAULT);
  const writersPre = await listWriterPositionsForVault(program, VAULT);
  console.log("=== CANARY pre-state:", VAULT.toBase58(), "===");
  console.log("cranker           :", cranker.publicKey.toBase58());
  console.log(
    "voided:", pre.voided, "| is_settled:", pre.isSettled,
    "| tc:", pre.totalCollateral.toString(),
    "| total_shares:", pre.totalShares.toString(),
    "| ppsc:", pre.premiumPerShareCumulative.toString(),
  );
  console.log("vault_usdc:", pre.vaultUsdcAccount.toBase58(), "bal:", await usdcBal(conn, pre.vaultUsdcAccount));
  console.log("writers (shares>0):", writersPre.length);

  console.log("\n=== running reclaimVault (LIVE, dryRun=false) ===");
  const report = await reclaimVault(ctx, VAULT, { dryRun: false, computeUnitLimit: 400_000 });
  console.log("REPORT:", JSON.stringify(report));

  const post: any = await program.account.sharedVault.fetch(VAULT);
  console.log("\n=== post-state ===");
  console.log("voided:", post.voided, post.voided ? "✓" : "✗");
  console.log(
    "collateral_remaining:", post.collateralRemaining.toString(),
    "| total_shares:", post.totalShares.toString(),
  );
  console.log("vault_usdc bal:", await usdcBal(conn, post.vaultUsdcAccount));
  console.log("initialize_void sig  :", report.voidSig ?? (report.alreadyVoided ? "(already voided)" : "(none)"));
  console.log(
    "reclaim_unsettled sigs:",
    report.reclaimSigs.length ? report.reclaimSigs.join(", ") : "(none — 0 writers, reclaim leg not exercised)",
  );
  for (const w of writersPre) {
    const wp: any = await program.account.writerPosition.fetch(w.writerPosition);
    console.log(
      `  writer ${w.writer.toBase58()} shares AFTER=${wp.shares.toString()} ${
        wp.shares.toString() === "0" ? "✓ zeroed" : "✗"
      }`,
    );
  }
})().catch((e) => {
  console.error("FAILED:", e.message ?? e);
  if (e.logs) console.error(e.logs.join("\n"));
  process.exit(1);
});
