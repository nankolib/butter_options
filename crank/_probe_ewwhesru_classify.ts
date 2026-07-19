// READ-ONLY: prove the HARDENED shell rule flags the REAL EWwhESru vault (not just
// the mocked unit test). Fetches EWwhESru's live state — vault_usdc, writer_ask_pot
// balance, option-mint holders (wallet vs PDA), writers, backers — and runs the
// exact classifier the cutover tool uses. Expect: isShell=false, hasUserClaim=true.
import * as anchor from "@coral-xyz/anchor"; import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";
import type { Opta } from "@app/idl/opta";
import { classifyVaultShell } from "./vaultShellRule";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const EWWHESRU = new PublicKey("EWwhESruvwda8i1udbby4BrAx9Afxf6Ma2qvFcT3Dw22");
const amt = (d: Buffer | Uint8Array) => Buffer.from(d).readBigUInt64LE(64);
const own = (d: Buffer | Uint8Array) => new PublicKey(Buffer.from(d).subarray(32, 64));

(async () => {
  const rpc = process.env.OPTA_RPC_URL || fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim();
  const conn = new Connection(rpc, "confirmed");
  const program = new Program<Opta>(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf-8")) as Opta,
    new anchor.AnchorProvider(conn, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" }));
  const v: any = await (program.account as any).sharedVault.fetch(EWWHESRU);
  const marketPda = new PublicKey(v.market);

  let vaultUsdc = 0n;
  try { const ta = await conn.getAccountInfo(new PublicKey(v.vaultUsdcAccount)); if (ta) vaultUsdc = amt(ta.data); } catch {}

  const [optionMint] = PublicKey.findProgramAddressSync([
    Buffer.from("vault_option_mint"), marketPda.toBuffer(),
    v.strikePrice.toArrayLike(Buffer, "le", 8), v.expiry.toArrayLike(Buffer, "le", 8),
    Buffer.from([("put" in (v.optionType ?? {})) ? 1 : 0]),
    Buffer.from([("european" in (v.exerciseStyle ?? {})) ? 0 : 1]),
  ], PROGRAM_ID);
  const [potPda] = PublicKey.findProgramAddressSync([Buffer.from("writer_ask_pot_usdc"), optionMint.toBuffer()], PROGRAM_ID);
  let potUsdc = 0n;
  try { const pa = await conn.getAccountInfo(potPda); if (pa) potUsdc = amt(pa.data); } catch {}

  let user = 0, proto = 0;
  try {
    const large = (await conn.getTokenLargestAccounts(optionMint)).value.filter((x) => x.uiAmount && x.uiAmount > 0);
    const infos = large.length ? await conn.getMultipleAccountsInfo(large.map((x) => new PublicKey(x.address))) : [];
    for (const info of infos) { if (!info || info.data.length < 64) continue; PublicKey.isOnCurve(own(info.data).toBuffer()) ? user++ : proto++; }
  } catch {}

  const cnt = async (name: string, off: number, pos: (d: any) => boolean) => {
    const rows = await conn.getProgramAccounts(PROGRAM_ID, { filters: [{ memcmp: { offset: off, bytes: EWWHESRU.toBase58() } }] });
    let n = 0; for (const { account } of rows) { try { if (pos(program.coder.accounts.decode(name, account.data))) n++; } catch {} } return n;
  };
  const writers = await cnt("writerPosition", 8 + 32, (d) => (d.shares?.toString?.() ?? "0") !== "0");
  const backers = await cnt("writerAskPosition", 8 + 32 + 32, (d) => (d.collateralCommitted?.toString?.() ?? "0") !== "0");

  const input = { vaultUsdc, potUsdc, userHolders: user, protocolHolders: proto, writers, backers,
    staleTotalCollateral: BigInt(v.totalCollateral?.toString?.() ?? "0"), staleTotalShares: BigInt(v.totalShares?.toString?.() ?? "0") };
  const verdict = classifyVaultShell(input);
  console.log("EWwhESru LIVE state:", JSON.stringify({ ...input, vaultUsdc: vaultUsdc.toString(), potUsdc: potUsdc.toString(),
    staleTotalCollateral: input.staleTotalCollateral.toString(), staleTotalShares: input.staleTotalShares.toString() }));
  console.log("optionMint", optionMint.toBase58(), "pot", potPda.toBase58());
  console.log("VERDICT:", JSON.stringify(verdict));
  const oldRule = input.staleTotalCollateral === 0n && input.staleTotalShares === 0n && vaultUsdc === 0n;
  console.log(`\nOLD rule isShell=${oldRule}  →  HARDENED isShell=${verdict.isShell}, hasUserClaim=${verdict.hasUserClaim}`);
  console.log(verdict.isShell === false && oldRule === true
    ? "✅ BLOCKER PROVEN: old rule orphaned it silently; hardened rule flags it as a live user claim."
    : "⚠ unexpected — investigate (state may have changed post-close).");
})().catch((e) => console.log("ERR", e.stack ?? e.message));
