// READ-ONLY post-sweep conservation verify. Raw getAccountInfo reads.
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";
import type { Opta } from "@app/idl/opta";

const WRITER_ASK_POT_USDC_SEED = "writer_ask_pot_usdc";
const VAULT_OPTION_MINT_SEED = "vault_option_mint";
const MARKET_SEED = "market";
const CANDS: [string, string][] = [
  ["Ad5_SBXAU", "Ad5zz684isTKpt8QjCUmFxozkL4RLPuGK8aXMe4yy49S"],
  ["BTC", "BAhgX8uAuM2GDov94PzetS34BHNcATTfNvNBRL39GAxT"],
  ["MSFT", "GteYo9RbYjHQ4EMBoLDQ86xByDMWmfVR1N7xgxFndYXB"],
  ["TSLA", "8xW8ewiqbCrE6H9s5opQ3XCXq6JgL19ESDM6g7Ca7ViR"],
  ["MSTR", "5HUGDsiQtac2LVxRRwSZ728gAUzdoP6m7HnZ8wMfTEnQ"],
];
const ATAS: [string, string, string][] = [ // owner, label, expected$
  ["DnExEYnZGuEu7xgpmNupJVXJLbMbkNdf3E7f28Zv6LUQ", "DnExEYnZ (MSFT+TSLA)", "5081454.944760"],
  ["GkG1UX8ML4UzNSGUtJxBWfRRWCdH7YejdhfuxFWTRFAx", "GkG1UX8M (MSTR)", "3013110.441916"],
  ["5YRMuuoY3P7z5GeRAAQND7BxgNdmPSa6CSPCJLca1zZk", "5YRMuuoY (Ad5 pool+backer)", "7163137.663081"],
];
const CRANK = new PublicKey("5sHZETYzbbdBQnFLmDCG3gyCikew39pL8kAE5xroGfqa");
const U = (x: bigint) => (Number(x) / 1e6).toFixed(6);
async function bal(c: Connection, a: PublicKey): Promise<bigint | null> {
  const i = await c.getAccountInfo(a); return i && i.data.length >= 72 ? i.data.readBigUInt64LE(64) : null;
}

(async () => {
  const rpc = process.env.OPTA_RPC_URL || fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim();
  const conn = new Connection(rpc, { commitment: "confirmed" });
  const program = new Program<Opta>(
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf-8")) as Opta,
    new anchor.AnchorProvider(conn, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" }));
  let allOk = true;
  let collMint: PublicKey | null = null;

  console.log("=== VAULTS (raw getAccountInfo) ===");
  for (const [name, pk] of CANDS) {
    const pkey = new PublicKey(pk);
    const ai = await conn.getAccountInfo(pkey);
    const v: any = program.coder.accounts.decode("sharedVault", ai!.data);
    collMint = v.collateralMint;
    const vb = (await bal(conn, v.vaultUsdcAccount)) ?? -1n;
    // pot usdc
    const ot = "call" in v.optionType ? 0 : 1, es = "european" in v.exerciseStyle ? 0 : 1;
    const mkt: any = await program.account.optionsMarket.fetch(v.market);
    const [marketPda] = PublicKey.findProgramAddressSync([Buffer.from(MARKET_SEED), Buffer.from(mkt.assetName)], program.programId);
    const [optMint] = PublicKey.findProgramAddressSync([Buffer.from(VAULT_OPTION_MINT_SEED), marketPda.toBuffer(),
      v.strikePrice.toArrayLike(Buffer, "le", 8), v.expiry.toArrayLike(Buffer, "le", 8), Buffer.from([ot]), Buffer.from([es])], program.programId);
    const [potUsdc] = PublicKey.findProgramAddressSync([Buffer.from(WRITER_ASK_POT_USDC_SEED), optMint.toBuffer()], program.programId);
    const potAi = await conn.getAccountInfo(potUsdc);
    const potStr = potAi === null ? "CLOSED" : `$${U(potAi.data.readBigUInt64LE(64))}`;
    const okV = v.voided === true && vb === 0n;
    if (!okV) allOk = false;
    console.log(`  ${name.padEnd(10)} voided=${v.voided} is_settled=${v.isSettled} vault_usdc=$${U(vb < 0n ? 0n : vb)} pot_usdc=${potStr}  ${okV ? "OK" : "!!CHECK"}`);
  }

  console.log("\n=== WRITER ATAs ===");
  for (const [owner, label, exp] of ATAS) {
    const ata = getAssociatedTokenAddressSync(collMint!, new PublicKey(owner), true, TOKEN_PROGRAM_ID);
    const b = (await bal(conn, ata)) ?? -1n;
    const ok = U(b) === exp;
    if (!ok) allOk = false;
    console.log(`  ${label.padEnd(28)} $${U(b)}  expect $${exp}  ${ok ? "OK" : "!!MISMATCH"}`);
  }

  const sol = await conn.getBalance(CRANK);
  console.log(`\n=== CRANK GAS ===\n  5sHZ… SOL=${(sol / 1e9).toFixed(9)}  (gate-1 baseline 38.048771720; delta=${(38.048771720 - sol / 1e9).toFixed(9)})`);
  console.log(`\n${allOk ? ">>> CONSERVATION VERIFY: ALL OK" : ">>> CONSERVATION VERIFY: DISCREPANCY — inspect above"}`);
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
