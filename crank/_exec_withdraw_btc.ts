// BTC GkG withdraw_post_settlement ×2 (staged 2026-07-18, GATE-2 gated).
// No-holder pool vaults → fast path (no 24h window). Runs only post-settlement
// (reverts VaultNotSettled before). DRY-RUN (sim, reports payout) by default;
// --execute signs with gkg.json and sends both. Verifies GkG USDC delta +
// vault_usdc -> $0 per vault.
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, createAssociatedTokenAccountIdempotentInstruction, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";
import type { Opta } from "@app/idl/opta";
import { safeFetchAll } from "@app/hooks/useFetchAccounts";

const WRITER_POSITION_SEED = "writer_position", PROTOCOL_SEED = "protocol_v2";
const GKG_EXPECTED = "GkG1UX8ML4UzNSGUtJxBWfRRWCdH7YejdhfuxFWTRFAx";
const VAULTS = ["EaV3yxWbredBKL2XNaBzE4Vm8MLxSo8iJo7KpSb4GnW7", "GtoM6B7foehhLisAVYANEPWuLT2fjTfBokorFA39eUKW"];
const bal = async (c: Connection, a: PublicKey) => { const ai = await c.getAccountInfo(a); return ai && ai.data.length >= 72 ? ai.data.readBigUInt64LE(64) : -1n; };

(async () => {
  const execute = process.argv.includes("--execute");
  const rpc = process.env.OPTA_RPC_URL || fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim();
  const conn = new Connection(rpc, { commitment: "confirmed" });
  const gkg = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(
    fs.readFileSync(process.env.GKG_KEYPAIR ?? path.join(os.homedir(), ".config/solana/gkg.json"), "utf-8"))));
  if (gkg.publicKey.toBase58() !== GKG_EXPECTED) { console.error(`ABORT: keypair ${gkg.publicKey.toBase58()} != GkG`); process.exit(1); }
  const program = new Program<Opta>(
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf-8")) as Opta,
    new anchor.AnchorProvider(conn, new anchor.Wallet(gkg), { commitment: "confirmed" }));
  const [ps] = PublicKey.findProgramAddressSync([Buffer.from(PROTOCOL_SEED)], program.programId);

  const vaults = await safeFetchAll<any>(program, "sharedVault");
  console.log(`=== BTC withdraw_post_settlement ${execute ? "[EXECUTE]" : "[DRY-RUN]"} ===`);
  let totalOut = 0n;
  for (const vpk of VAULTS) {
    const rec = vaults.find((v) => v.publicKey.toBase58() === vpk)!;
    const v = rec.account;
    const collMint = new PublicKey(v.collateralMint);
    const gkgUsdc = getAssociatedTokenAddressSync(collMint, gkg.publicKey, true, TOKEN_PROGRAM_ID);
    const [wpos] = PublicKey.findProgramAddressSync([Buffer.from(WRITER_POSITION_SEED), rec.publicKey.toBuffer(), gkg.publicKey.toBuffer()], program.programId);
    const vBefore = await bal(conn, v.vaultUsdcAccount as PublicKey);
    const gBefore = await bal(conn, gkgUsdc);
    console.log(`\n${vpk.slice(0, 8)}  is_settled=${v.isSettled}  vault_usdc=$${(Number(vBefore) / 1e6).toFixed(2)}  total_options_sold=${v.totalOptionsSold} swept=${v.writerAskCollateralSwept} (fast-path if both 0)`);
    if (!v.isSettled) { console.log(`  ⏳ NOT settled yet — withdraw reverts VaultNotSettled. Re-run after crank settles.`); continue; }

    const ixs: any[] = [ComputeBudgetProgram.setComputeUnitLimit({ units: 120_000 })];
    if (gBefore < 0n) ixs.push(createAssociatedTokenAccountIdempotentInstruction(gkg.publicKey, gkgUsdc, gkg.publicKey, collMint, TOKEN_PROGRAM_ID));
    ixs.push(await program.methods.withdrawPostSettlement()
      .accountsPartial({ writer: gkg.publicKey, sharedVault: rec.publicKey, writerPosition: wpos,
        vaultUsdcAccount: v.vaultUsdcAccount, writerUsdcAccount: gkgUsdc, protocolState: ps, tokenProgram: TOKEN_PROGRAM_ID }).instruction());
    const bh = await conn.getLatestBlockhash();
    const tx = new VersionedTransaction(new TransactionMessage({ payerKey: gkg.publicKey, recentBlockhash: bh.blockhash, instructions: ixs }).compileToV0Message());
    const sim = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    if (sim.value.err) { console.error(`  SIM ERR ${JSON.stringify(sim.value.err)}\n  ${(sim.value.logs ?? []).slice(-5).join("\n  ")}`); continue; }
    console.log(`  SIM OK — would withdraw ~$${(Number(vBefore) / 1e6).toFixed(2)}`);
    if (!execute) continue;
    tx.sign([gkg]);
    const sig = await conn.sendTransaction(tx, { skipPreflight: false });
    await conn.confirmTransaction({ signature: sig, blockhash: bh.blockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, "confirmed");
    const vAfter = await bal(conn, v.vaultUsdcAccount as PublicKey);
    const gAfter = await bal(conn, gkgUsdc);
    const delta = gAfter - (gBefore < 0n ? 0n : gBefore);
    totalOut += delta;
    console.log(`  ✅ SENT ${sig}\n  vault_usdc=$${(Number(vAfter) / 1e6).toFixed(2)} ${vAfter === 0n ? "ZERO" : "‼"}  GkG +$${(Number(delta) / 1e6).toFixed(2)}`);
  }
  if (execute) console.log(`\nTOTAL withdrawn to GkG: $${(Number(totalOut) / 1e6).toFixed(2)}`);
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.stack ?? e.message ?? e); process.exit(1); });
