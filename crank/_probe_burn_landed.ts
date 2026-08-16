// Step-7 close-out: the landed early exercise on SOL 70C, read off chain.
import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import fs from "fs";
import path from "path";

const RPC = process.env.OPTA_RPC_URL || "https://rpc.opta.fyi/devnet";
const PID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const VAULT = new PublicKey(process.env.VAULT ?? "6tq9Ueck1F7d9y1n3v9c6NbU5mhxTXshHKkR8y6YZ83V");
const MINT = new PublicKey(process.env.MINT ?? "DrcqMdCKMeELEcDCe4ioNLHUjUAwUhe4apfa3qaePefg");
const HOLDER = new PublicKey("Awi8u6PigydVN4XRBQzmiPEdyyVmtnwf1H7Gmrf5ARu5");
const POT = new PublicKey(process.env.POT ?? "FG36GGTuHAerPEpU4FLEt22FjauA668EuYsjy1SJY5nh");
const POT_USDC = new PublicKey(process.env.POT_USDC ?? "9bayCwvCPMjvfh4h26c8vu1wyhBqcGvZqLQqusBnpdWh");

const KNOWN: Record<string, string> = {
  "CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq": "opta.exercise_american",
  "ComputeBudget111111111111111111111111111111": "ComputeBudget",
  "Ed25519SigVerify111111111111111111111111111": "ed25519 price proof",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb": "token-2022",
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA": "spl-token",
};
const usd = (n: any) => `$${(Number(n) / 1e6).toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`;

(async () => {
  const conn = new Connection(RPC, "confirmed");
  const w = new anchor.Wallet(Keypair.generate());
  const p = new anchor.AnchorProvider(conn, w, { commitment: "confirmed" });
  const idl = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../app/src/idl/opta.json"), "utf-8"));
  const prog = new anchor.Program(idl as any, p) as any;

  // Newest holder signature that touched our program = the exercise.
  const sigs = await conn.getSignaturesForAddress(HOLDER, { limit: 6 }, "confirmed");
  let exSig: string | null = null;
  for (const s of sigs) {
    const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
    const keys = tx?.transaction.message.getAccountKeys();
    const hit = tx?.transaction.message.compiledInstructions.some(
      (i) => keys?.get(i.programIdIndex)?.equals(PID));
    if (hit && (tx?.meta?.logMessages ?? []).some((l) => l.includes("ExerciseAmerican"))) { exSig = s.signature; break; }
  }
  if (!exSig) { console.log("no exercise tx found in the holder's recent history"); return; }

  const tx = await conn.getTransaction(exSig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  const keys = tx!.transaction.message.getAccountKeys();
  console.log("=== LANDED EXERCISE ===");
  console.log(`  signature   : ${exSig}`);
  console.log(`  slot        : ${tx!.slot}   blockTime: ${new Date((tx!.blockTime ?? 0) * 1000).toISOString()}`);
  console.log(`  err         : ${JSON.stringify(tx!.meta?.err)}`);
  console.log(`  fee         : ${tx!.meta?.fee} lamports`);

  console.log("\n=== TX SHAPE (did the wallet insert anything?) ===");
  const ixs = tx!.transaction.message.compiledInstructions;
  ixs.forEach((i, n) => {
    const pid = keys.get(i.programIdIndex)!.toBase58();
    console.log(`  ix[${n}] ${KNOWN[pid] ?? pid}  accounts=${i.accountKeyIndexes.length}  data=${i.data.length}B`);
  });
  const edAt = ixs.findIndex((i) => keys.get(i.programIdIndex)!.toBase58() === "Ed25519SigVerify111111111111111111111111111");
  console.log(`  instruction count : ${ixs.length}  (expected 4)`);
  console.log(`  ed25519 index     : ${edAt}  (packed for 2)`);
  console.log(`  WALLET INSERTED NOTHING: ${ixs.length === 4 && edAt === 2}`);

  console.log("\n=== USDC / TOKEN DELTAS (from tx meta) ===");
  const pre = tx!.meta?.preTokenBalances ?? [];
  const post = tx!.meta?.postTokenBalances ?? [];
  const byIdx = new Map<number, { pre?: any; post?: any }>();
  for (const b of pre) byIdx.set(b.accountIndex, { ...(byIdx.get(b.accountIndex) ?? {}), pre: b });
  for (const b of post) byIdx.set(b.accountIndex, { ...(byIdx.get(b.accountIndex) ?? {}), post: b });
  for (const [idx, v] of [...byIdx.entries()].sort((a, b) => a[0] - b[0])) {
    const acct = keys.get(idx)!.toBase58();
    const a = Number(v.pre?.uiTokenAmount?.amount ?? 0);
    const b2 = Number(v.post?.uiTokenAmount?.amount ?? 0);
    if (a === b2) continue;
    const label = acct === POT_USDC.toBase58() ? "pot_usdc" : (v.pre ?? v.post)?.owner === HOLDER.toBase58() ? "holder" : acct.slice(0, 8);
    console.log(`  ${label.padEnd(10)} ${acct.slice(0, 8)}…  ${a} -> ${b2}   delta ${b2 - a > 0 ? "+" : ""}${b2 - a}`);
  }

  console.log("\n=== STATE NOW ===");
  const v: any = await prog.account.sharedVault.fetch(VAULT);
  const pot: any = await prog.account.writerAskPot.fetchNullable(POT);
  const supply = await conn.getTokenSupply(MINT);
  const potBal = await conn.getTokenAccountBalance(POT_USDC).catch(() => null);
  const vaultUsdc = await conn.getTokenAccountBalance(new PublicKey(v.vaultUsdcAccount)).catch(() => null);
  console.log(`  pot.total_collateral  : ${pot ? usd(pot.totalCollateral) : "n/a"}   (was ${process.env.POT0_LABEL ?? "$210"})`);
  console.log(`  pot.total_contracts   : ${pot ? pot.totalContracts : "n/a"}   (was ${process.env.N0 ?? 3})`);
  console.log(`  pot_usdc balance      : ${potBal ? usd(potBal.value.amount) : "n/a"}`);
  console.log(`  series supply         : ${supply.value.amount}   (was ${process.env.N0 ?? 3})`);
  console.log(`  exercised_options     : ${v.exercisedOptions}   (was 0)`);
  console.log(`  early_exercise_payout : ${usd(v.earlyExercisePayout)}   <<< must be $0`);
  console.log(`  vault_usdc            : ${vaultUsdc ? usd(vaultUsdc.value.amount) : "n/a"}   (untouched)`);
  console.log(`  total_collateral      : ${usd(v.totalCollateral)}`);
  console.log(`  is_settled / voided   : ${v.isSettled} / ${v.voided}`);
})().catch((e) => { console.error("ERROR:", e?.message ?? e); process.exit(1); });
