// Step-7 SIMULATION, pinned to 3k5vHJLh + the burner holder. Read-only:
// sigVerify:false + replaceRecentBlockhash:true, so no signature and no send.
// Executes the REAL program path on REAL state — SB oracle read, pot leg, and
// the 2026-08-15 early_exercise_payout accounting.
//   OPTA_RPC_URL=... npx ts-node --transpile-only -r tsconfig-paths/register \
//     crank/_probe_step7_sim.ts
import * as anchor from "@coral-xyz/anchor";
import {
  Connection, Keypair, PublicKey, TransactionMessage, VersionedTransaction,
} from "@solana/web3.js";
import {
  AnchorUtils, ON_DEMAND_DEVNET_PID, ON_DEMAND_DEVNET_QUEUE, Queue,
} from "@switchboard-xyz/on-demand";
import { CrossbarClient } from "@switchboard-xyz/common";
import { getAssociatedTokenAddressSync, getAssociatedTokenAddress } from "@solana/spl-token";
import { buildSwitchboardExerciseAmericanTx } from "./switchboardExerciseAmerican";
import { resolveSbFeedForMarket } from "./sbExerciseValidate";

const TOKEN_2022 = new PublicKey("TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb");
const VAULT = new PublicKey(process.env.VAULT ?? "3k5vHJLh42syDK9hhbwF3PMRHn3TvMgzWCPkYL5mceAV");
const MINT = new PublicKey(process.env.MINT ?? "EDT2J7TdFYAL6Wwr1DLJjriuwodAmbM1KybVGdr3o2Mw");
const HOLDER = new PublicKey("Awi8u6PigydVN4XRBQzmiPEdyyVmtnwf1H7Gmrf5ARu5");
const QTY = Number(process.env.QTY ?? 1); // the FE sends position.contracts, i.e. 10

(async () => {
  const conn = new Connection(process.env.OPTA_RPC_URL!, "confirmed");
  const wallet = new anchor.Wallet(Keypair.generate()); // never signs
  const provider = new anchor.AnchorProvider(conn, wallet, { commitment: "confirmed" });
  const idl = require("../app/src/idl/opta.json");
  const program = new anchor.Program(idl as any, provider) as any;

  const v: any = await program.account.sharedVault.fetch(VAULT);
  const m: any = await program.account.optionsMarket.fetch(v.market);
  const asset = Buffer.from(m.assetName).toString().replace(/\0+|\s+$/g, "");
  const strike = Number(v.strikePrice) / 1e6;

  console.log("=== TARGET ===");
  console.log(`  ${asset} $${strike} ${"call" in v.optionType ? "CALL" : "PUT"} ` +
    `${"american" in v.exerciseStyle ? "AMERICAN" : "EUROPEAN"}  exp ${new Date(Number(v.expiry) * 1000).toISOString()}`);
  console.log(`  oracle_source = ${m.oracleSource} (0=Pyth, 1=Switchboard)  <- the arm that must serve the read`);
  console.log(`  exercised_options=${v.exercisedOptions}  early_exercise_payout=$${Number(v.earlyExercisePayout) / 1e6}`);

  const feed = await resolveSbFeedForMarket(
    async (pk: PublicKey) => {
      const a: any = await program.account.optionsMarket.fetchNullable(pk);
      return a ? { oracleSource: a.oracleSource, pythFeedId: a.pythFeedId } : null;
    },
    v.market as PublicKey,
  );
  if (!(feed as any).ok) { console.log("feed refused:", (feed as any).error); return; }
  console.log(`  SB feedHash: ${(feed as any).value.slice(0, 16)}…`);

  const ps: any = await program.account.protocolState.fetch(
    PublicKey.findProgramAddressSync([Buffer.from("protocol_v2")], program.programId)[0]);
  const holderUsdc = await getAssociatedTokenAddress(ps.usdcMint as PublicKey, HOLDER);
  const vaultMintRecord = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_mint_record"), MINT.toBuffer()], program.programId)[0];

  const sbProgram = await AnchorUtils.loadProgramFromConnection(conn, wallet, ON_DEMAND_DEVNET_PID);
  const qObj = new Queue(sbProgram, ON_DEMAND_DEVNET_QUEUE);
  const crossbar = new CrossbarClient(process.env.OPTA_CROSSBAR_URL ?? "https://crossbar.switchboard.xyz");

  const buildOnce = () => buildSwitchboardExerciseAmericanTx(program, HOLDER, qObj, crossbar, {
    feedHashHex: (feed as any).value,
    quantity: QTY,
    sharedVault: VAULT,
    market: v.market as PublicKey,
    vaultMintRecord,
    optionMint: MINT,
    holderOptionAccount: getAssociatedTokenAddressSync(MINT, HOLDER, false, TOKEN_2022),
    vaultUsdcAccount: v.vaultUsdcAccount as PublicKey,
    holderUsdcAccount: holderUsdc,
  });

  // Same bounded fresh-quote retry the endpoint runs; the SB gateway draws dirty
  // often enough that one failure is not a signal.
  let build: any = null;
  for (let i = 1; i <= 5 && !build; i++) {
    try { build = await buildOnce(); }
    catch (e: any) { console.log(`  build attempt ${i}: ${String(e?.message ?? e).slice(0, 90)}`); }
  }
  if (!build) { console.log("BUILD EXHAUSTED — cannot simulate"); return; }

  const exIx = build.instructions[build.instructions.length - 1];
  console.log(`\n=== BUILT ===`);
  console.log(`  ixs=${build.instructions.length}  ed25519=${build.ed25519Bytes}B  exercise accounts=${exIx.keys.length}`);
  console.log(`  pot arm included: ${exIx.keys.length > 14 ? "YES (pot-aware builder)" : "NO — 14-account legacy shape"}`);

  const { blockhash } = await conn.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: HOLDER, recentBlockhash: blockhash, instructions: build.instructions,
  }).compileToV0Message());
  console.log(`  tx size: ${tx.serialize().length} B (limit 1232)`);

  const POT0 = BigInt(process.env.POT0 ?? "752000000");
  const N0 = Number(process.env.N0 ?? 10);
  const potUsdc = PublicKey.findProgramAddressSync(
    [Buffer.from("writer_ask_pot_usdc"), MINT.toBuffer()], program.programId)[0];
  const potRec = PublicKey.findProgramAddressSync(
    [Buffer.from("writer_ask_pot"), MINT.toBuffer()], program.programId)[0];
  const watch = [VAULT, potRec, potUsdc, holderUsdc, v.vaultUsdcAccount as PublicKey, MINT];

  const sim = await conn.simulateTransaction(tx, {
    sigVerify: false, replaceRecentBlockhash: true,
    accounts: { encoding: "base64", addresses: watch.map((a) => a.toBase58()) },
  });
  console.log(`\n=== SIM RESULT ===`);
  console.log("  err:", JSON.stringify(sim.value.err));
  console.log("  CU :", sim.value.unitsConsumed);
  console.log("  logs:");
  for (const l of sim.value.logs ?? []) console.log("    ", l);

  // ---- authoritative deltas: decode POST-execution account state -------------
  const post = (sim.value as any).accounts as ({ data: [string, string] } | null)[];
  const buf = (i: number) => post?.[i] ? Buffer.from(post[i]!.data[0], "base64") : null;
  const amt = (b: Buffer | null) => (b && b.length >= 72 ? b.readBigUInt64LE(64) : null);
  const usd6 = (x: bigint | null) => (x === null ? "n/a" : `$${(Number(x) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`);

  const vPost: any = buf(0) ? program.coder.accounts.decode("sharedVault", buf(0)!) : null;
  const potPost = buf(1);
  const preHolderUsdc = await conn.getTokenAccountBalance(holderUsdc).catch(() => null);
  const preVault: any = v;

  console.log("\n=== ON-CHAIN DELTAS (post-simulation state) ===");
  if (potPost) {
    console.log(`  pot.total_collateral : ${usd6(POT0)} -> ${usd6(potPost.readBigUInt64LE(104))}`);
    console.log(`  pot.total_contracts  : ${N0} -> ${potPost.readBigUInt64LE(112)}`);
  }
  console.log(`  pot_usdc balance     : ${usd6(POT0)} -> ${usd6(amt(buf(2)))}`);
  console.log(`  holder USDC          : ${preHolderUsdc ? usd6(BigInt(preHolderUsdc.value.amount)) : "n/a"} -> ${usd6(amt(buf(3)))}`);
  console.log(`  vault_usdc           : ${usd6(0n)} -> ${usd6(amt(buf(4)))}   (untouched: it had nothing)`);
  const mp = buf(5);
  if (mp) console.log(`  series supply        : ${N0} -> ${mp.readBigUInt64LE(36)}`);
  if (vPost) {
    console.log(`  exercised_options    : ${preVault.exercisedOptions} -> ${vPost.exercisedOptions}`);
    console.log(`  early_exercise_payout: $${Number(preVault.earlyExercisePayout) / 1e6} -> $${Number(vPost.earlyExercisePayout) / 1e6}   <<< THE FIX (VAULT-funded only)`);
  }
})().catch((e) => { console.error("PROBE ERROR:", e?.message ?? e); process.exit(1); });
