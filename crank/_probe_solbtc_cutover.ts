// ============================================================================
// crank/_probe_solbtc_cutover.ts — READ-ONLY SOL/BTC early-cutover recon.
// Signs nothing, sends nothing. Per-vault full state + writers + writer-ask
// backers + option-token HOLDERS, classified shell / founder-drainable /
// third-party, for the SOL (7ke68gTG…) and BTC (G3PT11Zy…) markets. Also a
// program-wide live-Pyth expiry>=Jul-31 exposure roll-up.
//   OPTA_RPC_URL="$(cat ~/.opta-rpc-helius)" \
//     npx ts-node -r tsconfig-paths/register _probe_solbtc_cutover.ts   (from crank/)
// ============================================================================
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import type { Opta } from "@app/idl/opta";
import { safeFetchAll } from "@app/hooks/useFetchAccounts";
import { fetchAllDecoded } from "./triggerCrank";

const MARKET_SEED = "market";
const VAULT_OPTION_MINT_SEED = "vault_option_mint";
const WRITER_ASK_POT_SEED = "writer_ask_pot";
const WRITER_ASK_POT_USDC_SEED = "writer_ask_pot_usdc";
const WRITER_POSITION_VAULT_OFFSET = 8 + 32; // WriterPosition.vault @ 40
const WRITER_ASK_POSITION_VAULT_OFFSET = 8 + 32 + 32; // WriterAskPosition.vault @ 72
const GRACE = 604_800; // 7 days (GRACE_WINDOW)

// Target markets (from HANDOFF): SOL close ~Aug-1, BTC close ~Jul-19.
const TARGET_ASSETS = ["SOL", "BTC"];

// Known founder / protocol-controlled wallets (drainable set).
const KNOWN: Record<string, string> = {
  "5YRMuuoY3P7z5GeRAAQND7BxgNdmPSa6CSPCJLca1zZk": "DEPLOYER/admin",
  "Hw8zoB12SuMbnJbMUQKq4PHHnYU68viSoQuveQ5FFDP3": "NANKO(buyer)",
  "5sHZETYzbbdBQnFLmDCG3gyCikew39pL8kAE5xroGfqa": "CRANK",
  "GkG1UX8ML4UzNSGUtJxBWfRRWCdH7YejdhfuxFWTRFAx": "GkG(treasury)",
};
const label = (pk: string) => KNOWN[pk] ?? "*** THIRD-PARTY ***";

async function usdcBal(conn: Connection, acc: PublicKey): Promise<bigint> {
  const a = await conn.getAccountInfo(acc);
  return a && a.data.length >= 72 ? a.data.readBigUInt64LE(64) : -1n;
}

(async () => {
  const rpc =
    process.env.OPTA_RPC_URL ||
    fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim();
  const conn = new Connection(rpc, { commitment: "confirmed" });
  const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(Keypair.generate()), {
    commitment: "confirmed",
  });
  const idl = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf-8"),
  ) as Opta;
  const program = new Program<Opta>(idl, provider);

  const slot = await conn.getSlot();
  const clusterNow = (await conn.getBlockTime(slot))!;
  console.log(`=== SOL/BTC EARLY-CUTOVER RECON (READ-ONLY) ===`);
  console.log(`CLUSTER TIME: ${new Date(clusterNow * 1000).toISOString()} (unix=${clusterNow})\n`);

  const [vaults, markets] = await Promise.all([
    safeFetchAll<any>(program, "sharedVault"),
    safeFetchAll<any>(program, "optionsMarket"),
  ]);
  const mByPda = new Map<string, any>();
  for (const m of markets) mByPda.set(m.publicKey.toBase58(), m.account);
  console.log(`fetched: ${vaults.length} vaults, ${markets.length} markets\n`);

  // Resolve the two target market PDAs from asset_name, print oracle_source.
  const targetMarketPdas = new Map<string, { asset: string; src: number }>();
  for (const asset of TARGET_ASSETS) {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from(MARKET_SEED), Buffer.from(asset)],
      program.programId,
    );
    const m = mByPda.get(pda.toBase58());
    targetMarketPdas.set(pda.toBase58(), { asset, src: m?.oracleSource ?? -1 });
    console.log(
      `MARKET ${asset}: ${pda.toBase58()}  oracle_source=${m?.oracleSource ?? "(market not found)"} ${
        m ? (m.oracleSource === 0 ? "(PYTH)" : "(SWITCHBOARD)") : ""
      }  feed=0x${m ? Buffer.from(m.pythFeedId).toString("hex").slice(0, 16) : "?"}…`,
    );
  }
  console.log("");

  const summary: any[] = [];

  for (const [mpda, info] of targetMarketPdas) {
    const mvaults = vaults.filter((v) => (v.account.market as PublicKey).toBase58() === mpda);
    // LIVE = not settled, not voided. Only these matter for the cutover/drain
    // decision. Settled/voided vaults may still hold residual USDC (post-settle
    // claims) — flag those too so nothing with a balance is missed.
    const live: any[] = [];
    const settledWithBal: any[] = [];
    let settledEmpty = 0,
      voided = 0;
    for (const rec of mvaults) {
      const v = rec.account;
      if (v.voided) { voided++; continue; }
      if (v.isSettled) {
        const bal = await usdcBal(conn, v.vaultUsdcAccount as PublicKey);
        if (bal > 0n) settledWithBal.push({ rec, bal });
        else settledEmpty++;
        continue;
      }
      live.push(rec);
    }
    console.log(
      `\n########## ${info.asset} MARKET — ${mvaults.length} vault(s): ${live.length} LIVE, ${settledWithBal.length} settled-w/-residual-USDC, ${settledEmpty} settled-empty, ${voided} voided ##########`,
    );
    if (settledWithBal.length) {
      console.log(`  -- settled vaults still holding USDC (post-settlement claim residue): --`);
      for (const { rec, bal } of settledWithBal)
        console.log(`     ${rec.publicKey.toBase58()}  vault_usdc=$${(Number(bal) / 1e6).toFixed(2)}`);
    }

    for (const rec of live) {
      const v = rec.account;
      const pk = rec.publicKey.toBase58();
      const ai = await conn.getAccountInfo(rec.publicKey);
      const expiry = typeof v.expiry === "number" ? v.expiry : v.expiry.toNumber();
      const graceEnd = expiry + GRACE;
      const ot = "call" in v.optionType ? 0 : 1;
      const es = "european" in v.exerciseStyle ? 0 : 1;
      const tc = BigInt(v.totalCollateral.toString());
      const ts = BigInt(v.totalShares.toString());
      const eep = BigInt(v.earlyExercisePayout.toString());
      const vbal = await usdcBal(conn, v.vaultUsdcAccount as PublicKey);

      // Derive option mint + writer-ask pot.
      const [optionMint] = PublicKey.findProgramAddressSync(
        [
          Buffer.from(VAULT_OPTION_MINT_SEED),
          new PublicKey(mpda).toBuffer(),
          v.strikePrice.toArrayLike(Buffer, "le", 8),
          v.expiry.toArrayLike(Buffer, "le", 8),
          Buffer.from([ot]),
          Buffer.from([es]),
        ],
        program.programId,
      );
      const [potUsdcPda] = PublicKey.findProgramAddressSync(
        [Buffer.from(WRITER_ASK_POT_USDC_SEED), optionMint.toBuffer()],
        program.programId,
      );
      const potUsdcBal = await usdcBal(conn, potUsdcPda);

      console.log(`\n==== VAULT ${pk} ====`);
      console.log(
        `  ${ot ? "PUT" : "CALL"} ${es ? "AMERICAN" : "EUROPEAN"}  strike=$${(
          Number(v.strikePrice.toString()) / 1e6
        ).toFixed(2)}  data_len=${ai?.data.length}`,
      );
      console.log(
        `  expiry=${new Date(expiry * 1000).toISOString()}  is_settled=${v.isSettled}  voided=${v.voided}`,
      );
      const graceState = v.isSettled
        ? "settled"
        : v.voided
        ? "voided"
        : expiry > clusterNow
        ? `LIVE (expires in ${((expiry - clusterNow) / 3600).toFixed(1)}h)`
        : graceEnd < clusterNow
        ? `EXPIRED — grace elapsed ${((clusterNow - graceEnd) / 86400).toFixed(1)}d ago → VOID-ELIGIBLE`
        : `EXPIRED — in grace, ${((graceEnd - clusterNow) / 86400).toFixed(1)}d until void-eligible`;
      console.log(`  STATE: ${graceState}`);
      console.log(
        `  total_collateral=$${(Number(tc) / 1e6).toFixed(2)}  total_shares=${ts}  early_exercise_payout=$${(
          Number(eep) / 1e6
        ).toFixed(2)}  ppsc=${v.premiumPerShareCumulative.toString()}`,
      );
      console.log(
        `  vault_usdc BAL=$${vbal >= 0n ? (Number(vbal) / 1e6).toFixed(2) : "no-acct"}   writer_ask_pot_usdc BAL=$${
          potUsdcBal >= 0n ? (Number(potUsdcBal) / 1e6).toFixed(2) : "no-acct"
        }`,
      );
      console.log(`  option_mint=${optionMint.toBase58()}`);

      // ---- Writers (pool) ----
      const wp = await fetchAllDecoded(program, "writerPosition", [
        { memcmp: { offset: WRITER_POSITION_VAULT_OFFSET, bytes: pk } },
      ]);
      const liveW = wp.filter((d: any) => (d.account.shares as anchor.BN).gtn(0));
      console.log(`  POOL WRITERS (shares>0): ${liveW.length}`);
      const writerOwners: string[] = [];
      for (const d of liveW) {
        const owner = (d.account.owner as PublicKey).toBase58();
        writerOwners.push(owner);
        console.log(
          `     writer=${owner} [${label(owner)}]  shares=${d.account.shares.toString()}  premium_claimed=${d.account.premiumClaimed?.toString?.() ?? "?"}  premium_debt=${d.account.premiumDebt?.toString?.() ?? "?"}`,
        );
      }

      // ---- Writer-ask backers ----
      const wa = await fetchAllDecoded(program, "writerAskPosition", [
        { memcmp: { offset: WRITER_ASK_POSITION_VAULT_OFFSET, bytes: pk } },
      ]);
      console.log(`  WRITER-ASK BACKERS: ${wa.length}`);
      const backerOwners: string[] = [];
      for (const d of wa) {
        const backer = (d.account.backer as PublicKey).toBase58();
        backerOwners.push(backer);
        console.log(
          `     backer=${backer} [${label(backer)}]  collateral_committed=${d.account.collateralCommitted.toString()}  contracts_written=${d.account.contractsWritten.toString()}`,
        );
      }

      // ---- Option-token HOLDERS (Token-2022 largest accounts) ----
      const holderOwners: string[] = [];
      try {
        const largest = await conn.getTokenLargestAccounts(optionMint);
        const nonZero = largest.value.filter((a) => a.uiAmount && a.uiAmount > 0);
        console.log(`  OPTION HOLDERS (token accounts w/ balance>0): ${nonZero.length}`);
        for (const acc of nonZero) {
          const tai = await conn.getAccountInfo(acc.address);
          const owner = tai && tai.data.length >= 64 ? new PublicKey(tai.data.subarray(32, 64)).toBase58() : "?";
          holderOwners.push(owner);
          console.log(
            `     ata=${acc.address.toBase58()}  amount=${acc.amount}  owner=${owner} [${label(owner)}]`,
          );
        }
      } catch (e: any) {
        console.log(`  OPTION HOLDERS: (mint has no token accounts / not created) — ${e?.message ?? ""}`);
      }

      // ---- Classification ----
      const allParties = [...writerOwners, ...backerOwners, ...holderOwners];
      const thirdParties = [...new Set(allParties.filter((o) => !KNOWN[o] && o !== "?"))];
      let klass: string;
      if (tc === 0n && ts === 0n && holderOwners.length === 0) klass = "ALL-ZERO SHELL";
      else if (thirdParties.length === 0) klass = "FOUNDER-DRAINABLE (all positions ours)";
      else klass = `THIRD-PARTY-HELD (${thirdParties.length} external: ${thirdParties.map((t) => t.slice(0, 8)).join(", ")})`;
      console.log(`  >>> CLASSIFICATION: ${klass}`);

      summary.push({
        asset: info.asset,
        pk,
        kind: `${ot ? "PUT" : "CALL"} $${(Number(v.strikePrice.toString()) / 1e6).toFixed(0)}`,
        expiry: new Date(expiry * 1000).toISOString().slice(0, 16),
        state: graceState.split(" ")[0],
        tc: `$${(Number(tc) / 1e6).toFixed(0)}`,
        vbal: `$${vbal >= 0n ? (Number(vbal) / 1e6).toFixed(0) : "?"}`,
        holders: holderOwners.length,
        thirdParties: thirdParties.length,
        klass: klass.split(" ")[0],
      });
    }
  }

  console.log(`\n\n================ SUMMARY TABLE ================`);
  console.table(summary);
  console.log("\n=== DONE (read-only) ===");
  process.exit(0);
})().catch((e) => {
  console.error("FAILED:", e.stack ?? e.message ?? e);
  process.exit(1);
});
