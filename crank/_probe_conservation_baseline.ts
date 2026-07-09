// READ-ONLY conservation baseline for the 5-vault reclaim sweep. Raw getAccountInfo
// reads; replicates the on-chain reclaim_unsettled + writer_ask_residual_core math
// to compute EXACT expected payouts. Signs/sends nothing.
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";
import type { Opta } from "@app/idl/opta";
import { fetchAllDecoded } from "./triggerCrank";

const SCALE = 1_000_000_000_000n; // 1e12
const WRITER_POSITION_VAULT_OFFSET = 8 + 32;
const WRITER_ASK_POSITION_VAULT_OFFSET = 8 + 32 + 32;
const WRITER_ASK_POT_SEED = "writer_ask_pot";
const WRITER_ASK_POT_USDC_SEED = "writer_ask_pot_usdc";
const VAULT_OPTION_MINT_SEED = "vault_option_mint";
const MARKET_SEED = "market";

const CANDS: Record<string, string> = {
  Ad5_SBXAU: "Ad5zz684isTKpt8QjCUmFxozkL4RLPuGK8aXMe4yy49S",
  BTC:       "BAhgX8uAuM2GDov94PzetS34BHNcATTfNvNBRL39GAxT",
  MSFT:      "GteYo9RbYjHQ4EMBoLDQ86xByDMWmfVR1N7xgxFndYXB",
  TSLA:      "8xW8ewiqbCrE6H9s5opQ3XCXq6JgL19ESDM6g7Ca7ViR",
  MSTR:      "5HUGDsiQtac2LVxRRwSZ728gAUzdoP6m7HnZ8wMfTEnQ",
};
const CRANK = new PublicKey("5sHZETYzbbdBQnFLmDCG3gyCikew39pL8kAE5xroGfqa");

const U = (x: bigint) => (Number(x) / 1e6).toFixed(6);
async function rawTokenBal(conn: Connection, acc: PublicKey): Promise<bigint | null> {
  const a = await conn.getAccountInfo(acc);
  return a && a.data.length >= 72 ? a.data.readBigUInt64LE(64) : null;
}

(async () => {
  const rpc = process.env.OPTA_RPC_URL || fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim();
  const conn = new Connection(rpc, { commitment: "confirmed" });
  const program = new Program<Opta>(
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf-8")) as Opta,
    new anchor.AnchorProvider(conn, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" }));

  const slot = await conn.getSlot();
  const cnow = (await conn.getBlockTime(slot))!;
  console.log(`CLUSTER: slot=${slot} ${new Date(cnow * 1000).toISOString()} (unix ${cnow}) > 1783552796 ? ${cnow > 1783552796}\n`);

  let collateralMint: PublicKey | null = null;
  const grandPayouts: { who: string; amt: bigint; kind: string }[] = [];

  for (const [name, pkStr] of Object.entries(CANDS)) {
    const pk = new PublicKey(pkStr);
    const ai = await conn.getAccountInfo(pk);                    // RAW read
    const v: any = program.coder.accounts.decode("sharedVault", ai!.data); // decode raw bytes
    collateralMint = v.collateralMint;
    const mkt: any = await program.account.optionsMarket.fetch(v.market);
    const tc = BigInt(v.totalCollateral.toString());
    const ts = BigInt(v.totalShares.toString());
    const e = BigInt(v.earlyExercisePayout.toString());
    const ppsc = BigInt(v.premiumPerShareCumulative.toString());
    const vBal = (await rawTokenBal(conn, v.vaultUsdcAccount))!;

    // pot (for Ad5)
    const ot = "call" in v.optionType ? 0 : 1, es = "european" in v.exerciseStyle ? 0 : 1;
    const [marketPda] = PublicKey.findProgramAddressSync([Buffer.from(MARKET_SEED), Buffer.from(mkt.assetName)], program.programId);
    const [optMint] = PublicKey.findProgramAddressSync([Buffer.from(VAULT_OPTION_MINT_SEED), marketPda.toBuffer(),
      v.strikePrice.toArrayLike(Buffer, "le", 8), v.expiry.toArrayLike(Buffer, "le", 8), Buffer.from([ot]), Buffer.from([es])], program.programId);
    const [potPda] = PublicKey.findProgramAddressSync([Buffer.from(WRITER_ASK_POT_SEED), optMint.toBuffer()], program.programId);
    const [potUsdcPda] = PublicKey.findProgramAddressSync([Buffer.from(WRITER_ASK_POT_USDC_SEED), optMint.toBuffer()], program.programId);
    const potUsdcBal = await rawTokenBal(conn, potUsdcPda);      // RAW read
    let swept = 0n;
    try { const p: any = await program.account.writerAskPot.fetch(potPda); swept = BigInt(p.totalCollateral.toString()); } catch {}

    // post-void merge
    const equivTotal = swept === 0n ? 0n : (tc === 0n ? swept : (swept * ts) / tc);
    const crPost = tc + swept - e;
    const tsPost = ts + equivTotal;

    console.log(`===== ${name}  ${pkStr} =====`);
    console.log(`  vault_usdc=${v.vaultUsdcAccount.toBase58()} BAL=${vBal} ($${U(vBal)})`);
    console.log(`  tc=${tc} ts=${ts} e=${e} ppsc=${ppsc} voided=${v.voided} is_settled=${v.isSettled}`);
    console.log(`  pot_usdc=${potUsdcPda.toBase58()} BAL=${potUsdcBal ?? "(no acct)"} swept(counter)=${swept}`);
    console.log(`  POST-VOID: collateral_remaining=${crPost} ($${U(crPost)})  total_shares=${tsPost}  equiv_total=${equivTotal}`);

    // pool writers
    const wps = (await fetchAllDecoded(program, "writerPosition", [{ memcmp: { offset: WRITER_POSITION_VAULT_OFFSET, bytes: pk.toBase58() } }]))
      .filter((d: any) => (d.account.shares as anchor.BN).gtn(0));
    let crRun = crPost, tsRun = tsPost;
    for (const d of wps) {
      const a: any = d.account;
      const sh = BigInt(a.shares.toString());
      const pd = BigInt(a.premiumDebt.toString());
      const pc = BigInt(a.premiumClaimed.toString());
      let prem = (sh * ppsc) / SCALE; prem = prem > pd ? prem - pd : 0n; prem = prem > pc ? prem - pc : 0n;
      const coll = tsRun === 0n ? 0n : (sh * crRun) / tsRun;
      const payout = prem + coll;
      crRun -= coll; tsRun -= sh;
      console.log(`  POOL WRITER ${a.owner.toBase58()} shares=${sh} premium_debt=${pd} premium_claimed=${pc}`);
      console.log(`     -> collateral=${coll} ($${U(coll)}) + premium=${prem} ($${U(prem)}) = PAYOUT ${payout} ($${U(payout)})`);
      grandPayouts.push({ who: a.owner.toBase58(), amt: payout, kind: `${name}:pool` });
    }

    // writer-ask backers (residual — after pool writers)
    const was = await fetchAllDecoded(program, "writerAskPosition", [{ memcmp: { offset: WRITER_ASK_POSITION_VAULT_OFFSET, bytes: pk.toBase58() } }]);
    for (const d of was) {
      const a: any = d.account;
      const committed = BigInt(a.collateralCommitted.toString());
      if (swept === 0n || committed === 0n) continue;
      const equivShares = (committed * equivTotal) / swept;
      const payout = equivShares === 0n ? 0n : (equivShares * crRun) / tsRun;
      crRun -= payout; tsRun -= equivShares;
      console.log(`  WRITER-ASK BACKER ${a.backer.toBase58()} committed=${committed} equiv_shares=${equivShares}`);
      console.log(`     -> RESIDUAL PAYOUT ${payout} ($${U(payout)})`);
      grandPayouts.push({ who: a.backer.toBase58(), amt: payout, kind: `${name}:residual` });
    }
    console.log("");
  }

  // ATA balances
  console.log(`===== WRITER USDC ATA BASELINES (collateral_mint=${collateralMint!.toBase58()}) =====`);
  for (const owner of ["DnExEYnZGuEu7xgpmNupJVXJLbMbkNdf3E7f28Zv6LUQ", "GkG1UX8ML4UzNSGUtJxBWfRRWCdH7YejdhfuxFWTRFAx", "5YRMuuoY3P7z5GeRAAQND7BxgNdmPSa6CSPCJLca1zZk"]) {
    const ata = getAssociatedTokenAddressSync(collateralMint!, new PublicKey(owner), true, TOKEN_PROGRAM_ID);
    const bal = await rawTokenBal(conn, ata);
    console.log(`  ${owner}  ATA=${ata.toBase58()} BAL=${bal === null ? "(no ATA — created idempotently at reclaim)" : `${bal} ($${U(bal)})`}`);
  }
  const sol = await conn.getBalance(CRANK);
  console.log(`\n  CRANK 5sHZ… SOL=${(sol / 1e9).toFixed(9)}`);

  // totals
  console.log(`\n===== EXPECTED PAYOUTS (gate-2 conservation target) =====`);
  let poolSum = 0n, residSum = 0n;
  for (const g of grandPayouts) {
    console.log(`  ${g.kind.padEnd(16)} ${g.who} -> ${g.amt} ($${U(g.amt)})`);
    if (g.kind.endsWith("pool")) poolSum += g.amt; else residSum += g.amt;
  }
  console.log(`  ------`);
  console.log(`  SUM pool-writer payouts = ${poolSum} ($${U(poolSum)})`);
  console.log(`  SUM writer-ask residual = ${residSum} ($${U(residSum)})`);
  console.log(`  GRAND TOTAL USDC moving = ${poolSum + residSum} ($${U(poolSum + residSum)})`);
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.message ?? e); process.exit(1); });
