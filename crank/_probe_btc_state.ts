// READ-ONLY investigation: GtoM6B7f (drained?) + EaV3yxWb (24h window) state.
import * as anchor from "@coral-xyz/anchor"; import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";
import type { Opta } from "@app/idl/opta";
import { safeFetchAll } from "@app/hooks/useFetchAccounts";
import { fetchAllDecoded } from "./triggerCrank";
const WP_OFF = 8 + 32;
(async () => {
  const rpc = process.env.OPTA_RPC_URL || fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim();
  const conn = new Connection(rpc, { commitment: "confirmed" });
  const program = new Program<Opta>(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf-8")) as Opta,
    new anchor.AnchorProvider(conn, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" }));
  const vaults = await safeFetchAll<any>(program, "sharedVault");
  for (const [label, pk] of [["GtoM6B7f", "GtoM6B7foehhLisAVYANEPWuLT2fjTfBokorFA39eUKW"], ["EaV3yxWb", "EaV3yxWbredBKL2XNaBzE4Vm8MLxSo8iJo7KpSb4GnW7"]]) {
    const rec = vaults.find((v) => v.publicKey.toBase58() === pk)!; const v = rec.account;
    const ua = await conn.getAccountInfo(v.vaultUsdcAccount as PublicKey);
    const ubal = ua && ua.data.length >= 72 ? ua.data.readBigUInt64LE(64) : -1n;
    console.log(`\n${label} ${pk}`);
    console.log(`  is_settled=${v.isSettled} voided=${v.voided} total_collateral=$${(Number(v.totalCollateral) / 1e6).toFixed(2)} total_shares=${v.totalShares} total_options_sold=${v.totalOptionsSold} eep=$${(Number(v.earlyExercisePayout) / 1e6).toFixed(2)} collateral_remaining=$${(Number(v.collateralRemaining) / 1e6).toFixed(2)}`);
    console.log(`  vault_usdc acct=${(v.vaultUsdcAccount as PublicKey).toBase58()} exists=${!!ua} bal=$${ubal >= 0n ? (Number(ubal) / 1e6).toFixed(2) : "CLOSED/none"}`);
    const wp = await fetchAllDecoded(program, "writerPosition", [{ memcmp: { offset: WP_OFF, bytes: pk } }]);
    console.log(`  writer positions: ${wp.length}`);
    for (const d of wp) console.log(`     owner=${(d.account.owner as PublicKey).toBase58()} shares=${d.account.shares} options_minted=${d.account.optionsMinted}`);
    const sigs = await conn.getSignaturesForAddress(new PublicKey(pk), { limit: 6 });
    console.log(`  recent txns on vault:`);
    for (const s of sigs) console.log(`     ${s.signature.slice(0, 24)}… slot=${s.slot} ${s.blockTime ? new Date(s.blockTime * 1000).toISOString() : ""} ${s.err ? "ERR" : "ok"}`);
  }
})().catch((e) => console.log("ERR", e.message));
