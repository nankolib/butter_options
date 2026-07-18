// READ-ONLY. (1) 6GfxUov discharge split (holder 5uBcRhU6 payout vs DnExEYnZ
// backer residual) + auto_finalize_holders SIMULATION. (2) 4CroLejZ enum.
// (3) SWEEP both SOL+BTC markets for ANY external-wallet holder (amount>0) on
// any vault — the 5uBcRhU6 class. Signs nothing, sends nothing.
import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID } from "@solana/spl-token";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";
import type { Opta } from "@app/idl/opta";
import { safeFetchAll } from "@app/hooks/useFetchAccounts";

const MARKET_SEED = "market", VAULT_OPTION_MINT_SEED = "vault_option_mint";
const VAULT_MINT_RECORD_SEED = "vault_mint_record", PROTOCOL_SEED = "protocol_v2";
// USDC (collateral) mint — read from any vault below; ATA derivation needs it.
const FOUNDER = new Set([
  "5YRMuuoY3P7z5GeRAAQND7BxgNdmPSa6CSPCJLca1zZk", "Hw8zoB12SuMbnJbMUQKq4PHHnYU68viSoQuveQ5FFDP3",
  "5sHZETYzbbdBQnFLmDCG3gyCikew39pL8kAE5xroGfqa", "GkG1UX8ML4UzNSGUtJxBWfRRWCdH7YejdhfuxFWTRFAx",
  "DnExEYnZGuEu7xgpmNupJVXJLbMbkNdf3E7f28Zv6LUQ",
]); // 5uBcRhU6… is EXTERNAL (NOT in this set)
const usd = (n: bigint | number) => `$${(Number(n) / 1e6).toFixed(2)}`;
const callPut = (v: any) => ("call" in v.optionType ? "CALL" : "PUT");
const amerEuro = (v: any) => ("american" in v.exerciseStyle ? "AMER" : "EURO");

async function tokenOwner(conn: Connection, ata: PublicKey): Promise<{ owner: string; amt: bigint } | null> {
  const a = await conn.getAccountInfo(ata);
  if (!a || a.data.length < 72) return null;
  return { owner: new PublicKey(a.data.subarray(32, 64)).toBase58(), amt: a.data.readBigUInt64LE(64) };
}

(async () => {
  const rpc = process.env.OPTA_RPC_URL || fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim();
  const conn = new Connection(rpc, { commitment: "confirmed" });
  const program = new Program<Opta>(
    JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf-8")) as Opta,
    new anchor.AnchorProvider(conn, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" }));
  const [vaults, markets] = await Promise.all([safeFetchAll<any>(program, "sharedVault"), safeFetchAll<any>(program, "optionsMarket")]);
  const mById = new Map<string, any>(); for (const m of markets) mById.set(m.publicKey.toBase58(), m.account);
  const byPk = new Map<string, any>(); for (const v of vaults) byPk.set(v.publicKey.toBase58(), v);
  const SOL = PublicKey.findProgramAddressSync([Buffer.from(MARKET_SEED), Buffer.from("SOL")], program.programId)[0].toBase58();
  const BTC = PublicKey.findProgramAddressSync([Buffer.from(MARKET_SEED), Buffer.from("BTC")], program.programId)[0].toBase58();

  const optionMintOf = (v: any, mpda: string) => PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_OPTION_MINT_SEED), new PublicKey(mpda).toBuffer(),
     v.strikePrice.toArrayLike(Buffer, "le", 8), v.expiry.toArrayLike(Buffer, "le", 8),
     Buffer.from([callPut(v) === "PUT" ? 1 : 0]), Buffer.from([amerEuro(v) === "EURO" ? 0 : 1])], program.programId)[0];

  // ---------- (1) 6GfxUov discharge split + sim ----------
  console.log("===== (1) 6GfxUov discharge split =====");
  const gRec = byPk.get("6GfxUovAaPKrGh5PaqdesXEdeAQuWAavKNSuiWz2fuuK");
  const g = gRec.account, gMpda = (g.market as PublicKey).toBase58();
  const strike = BigInt(g.strikePrice.toString());
  const settle = BigInt((g.settlementPrice ?? 0).toString());
  const collRem = BigInt(g.collateralRemaining.toString());
  const vbal = (await tokenOwner(conn, g.vaultUsdcAccount as PublicKey))?.amt ?? -1n; // vault_usdc is USDC ATA-like
  const vbalAcct = await conn.getAccountInfo(g.vaultUsdcAccount as PublicKey);
  const vaultUsdc = vbalAcct && vbalAcct.data.length >= 72 ? vbalAcct.data.readBigUInt64LE(64) : -1n;
  const gMint = optionMintOf(g, gMpda);
  const holder = await tokenOwner(conn, getAssociatedTokenAddressSync(gMint, new PublicKey("5uBcRhU6Hc78w8pNRNgu1X953oRL93fgAHC348CKNajV"), true, TOKEN_2022_PROGRAM_ID));
  const contracts = holder?.amt ?? 0n;
  // CALL American: per-contract = min(max(0, settle-strike), strike-cap)
  const rawPer = settle > strike ? settle - strike : 0n;
  const perContract = rawPer < strike ? rawPer : strike;
  const rawPayout = contracts * perContract;
  const holderPayout = rawPayout < collRem ? rawPayout : collRem;
  console.log(`  6GfxUov ${callPut(g)} ${amerEuro(g)} strike=${usd(strike)} settlement=${usd(settle)}  is_settled=${g.isSettled} voided=${g.voided}`);
  console.log(`  vault_usdc balance = ${usd(vaultUsdc)}   collateral_remaining = ${usd(collRem)}`);
  console.log(`  external holder 5uBcRhU6 contracts=${contracts}  ${settle > strike ? `ITM by ${usd(settle - strike)}/ct` : `OTM (CALL, settle<=strike) → payout $0`}`);
  console.log(`  >>> HOLDER PAYOUT (to 5uBcRhU6) = ${usd(holderPayout)}`);
  console.log(`  >>> RESIDUAL (writers+DnExEYnZ backer, stays for withdraw) = ${usd(vaultUsdc - holderPayout)}  of vault_usdc ${usd(vaultUsdc)}`);

  // Simulate auto_finalize_holders (read-only): proves discharge lands.
  try {
    const collMint = new PublicKey(g.collateralMint);
    const holderOptAta = getAssociatedTokenAddressSync(gMint, new PublicKey("5uBcRhU6Hc78w8pNRNgu1X953oRL93fgAHC348CKNajV"), true, TOKEN_2022_PROGRAM_ID);
    const holderUsdcAta = getAssociatedTokenAddressSync(collMint, new PublicKey("5uBcRhU6Hc78w8pNRNgu1X953oRL93fgAHC348CKNajV"), true, TOKEN_PROGRAM_ID);
    const [vmr] = PublicKey.findProgramAddressSync([Buffer.from(VAULT_MINT_RECORD_SEED), gMint.toBuffer()], program.programId);
    const [ps] = PublicKey.findProgramAddressSync([Buffer.from(PROTOCOL_SEED)], program.programId);
    const caller = Keypair.generate();
    const ix = await program.methods.autoFinalizeHolders()
      .accountsPartial({
        caller: caller.publicKey, sharedVault: gRec.publicKey, market: new PublicKey(gMpda),
        vaultMintRecord: vmr, optionMint: gMint, vaultUsdcAccount: g.vaultUsdcAccount,
        protocolState: ps, token2022Program: TOKEN_2022_PROGRAM_ID, tokenProgram: TOKEN_PROGRAM_ID,
      })
      .remainingAccounts([
        { pubkey: holderOptAta, isSigner: false, isWritable: true },
        { pubkey: holderUsdcAta, isSigner: false, isWritable: true },
      ]).instruction();
    const { blockhash } = await conn.getLatestBlockhash();
    const msg = new anchor.web3.TransactionMessage({ payerKey: caller.publicKey, recentBlockhash: blockhash, instructions: [ix] }).compileToV0Message();
    const sim = await conn.simulateTransaction(new anchor.web3.VersionedTransaction(msg), { sigVerify: false, replaceRecentBlockhash: true });
    console.log(`  SIM auto_finalize_holders: ${sim.value.err ? "ERR " + JSON.stringify(sim.value.err) : "OK — discharge would land"}`);
    (sim.value.logs ?? []).filter((l) => /HoldersFinalized|total_paid|Program log|Error|nsufficient|holder_usdc/i.test(l)).slice(-6).forEach((l) => console.log("     " + l.slice(0, 140)));
    console.log(`  [note] holder_usdc_ata ${holderUsdcAta.toBase58()} must EXIST for payout; if absent + ITM, create it (idempotent) or the pair silently skips.`);
  } catch (e: any) { console.log(`  SIM build failed: ${e?.message}`); }

  // ---------- (2) 4CroLejZ enum ----------
  console.log("\n===== (2) 4CroLejZ settled residual — holder/backer enum =====");
  const cRec = byPk.get("4CroLejZ56GxamkupEDkbnTLqV9qZTCZQriTnrXKtVb3");
  if (cRec) {
    const c = cRec.account, cMpda = (c.market as PublicKey).toBase58();
    const cAcct = await conn.getAccountInfo(c.vaultUsdcAccount as PublicKey);
    const cUsdc = cAcct && cAcct.data.length >= 72 ? cAcct.data.readBigUInt64LE(64) : -1n;
    console.log(`  4CroLejZ ${callPut(c)} ${amerEuro(c)} strike=${usd(c.strikePrice.toString())} settlement=${usd((c.settlementPrice ?? 0).toString())} is_settled=${c.isSettled} vault_usdc=${usd(cUsdc)}`);
    try {
      const cMint = optionMintOf(c, cMpda);
      const largest = await conn.getTokenLargestAccounts(cMint);
      for (const a of largest.value.filter((x) => x.uiAmount && x.uiAmount > 0)) {
        const o = await tokenOwner(conn, a.address);
        console.log(`     holder owner=${o?.owner} amount=${a.amount} ${o && FOUNDER.has(o.owner) ? "[founder]" : "*** EXTERNAL ***"}`);
      }
    } catch (e: any) { console.log(`     holders: none / mint uninit (${e?.message?.slice(0, 40)})`); }
  } else console.log("  4CroLejZ not in set");

  // ---------- (3) SWEEP both markets for external holders (amount>0) ----------
  console.log("\n===== (3) SWEEP SOL+BTC: external holders on ANY vault =====");
  const flagged: any[] = [];
  for (const v of vaults) {
    const mpda = (v.account.market as PublicKey).toBase58();
    if (mpda !== SOL && mpda !== BTC) continue;
    const mint = optionMintOf(v.account, mpda);
    let largest;
    try { largest = await conn.getTokenLargestAccounts(mint); } catch { continue; } // uninit mint → skip
    for (const a of largest.value.filter((x) => x.uiAmount && x.uiAmount > 0)) {
      const o = await tokenOwner(conn, a.address);
      if (o && !FOUNDER.has(o.owner)) {
        const asset = mById.get(mpda)?.assetName;
        const acct = await conn.getAccountInfo(v.account.vaultUsdcAccount as PublicKey);
        const uu = acct && acct.data.length >= 72 ? acct.data.readBigUInt64LE(64) : -1n;
        flagged.push({ asset, vault: v.publicKey.toBase58(), kind: `${callPut(v.account)} ${amerEuro(v.account)} ${usd(v.account.strikePrice.toString())}`,
          settled: v.account.isSettled, voided: v.account.voided, holder: o.owner, contracts: a.amount, vault_usdc: usd(uu) });
      }
    }
  }
  if (!flagged.length) console.log("  ✅ NO external holders found on SOL/BTC beyond the known 5uBcRhU6/6GfxUov.");
  else { console.log(`  ⚠ ${flagged.length} external-holder position(s):`); console.table(flagged); }
  process.exit(0);
})().catch((e) => { console.error("FAILED:", e.stack ?? e.message ?? e); process.exit(1); });
