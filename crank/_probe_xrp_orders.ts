// READ-ONLY: resolve the 3 writer-canary orders (5Q34Vu/68XzAg/98XqZr) on-chain,
// confirm live XRP WriterAsks with price/qty/escrow + resolve vault→market→strike.
import * as anchor from "@coral-xyz/anchor"; import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";
import type { Opta } from "@app/idl/opta";
import { safeFetchAll } from "@app/hooks/useFetchAccounts";

const PREFIXES = ["5Q34Vu", "68XzAg", "98XqZr"];
const RESTING_ORDER_ESCROW_SEED = "resting_order_escrow";
const bal = async (c: Connection, a: PublicKey) => { const ai = await c.getAccountInfo(a); return ai && ai.data.length >= 72 ? ai.data.readBigUInt64LE(64) : -1n; };
(async () => {
  const rpc = process.env.OPTA_RPC_URL || fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim();
  const conn = new Connection(rpc, { commitment: "confirmed" });
  const program = new Program<Opta>(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf-8")) as Opta,
    new anchor.AnchorProvider(conn, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" }));
  const now = (await conn.getBlockTime(await conn.getSlot()))!;
  const [markets, vaults] = await Promise.all([safeFetchAll<any>(program, "optionsMarket"), safeFetchAll<any>(program, "sharedVault")]);
  const mkt = new Map<string, any>(); for (const m of markets) mkt.set(m.publicKey.toBase58(), m.account);
  const vlt = new Map<string, any>(); for (const v of vaults) vlt.set(v.publicKey.toBase58(), v.account);

  const disc = (program.coder.accounts as any).memcmp("restingOrder") as { offset: number; bytes: string };
  const raw = await conn.getProgramAccounts(program.programId, { filters: [{ memcmp: { offset: disc.offset, bytes: disc.bytes } }] });
  console.log(`resting orders on-chain: ${raw.length}; cluster now ${new Date(now * 1000).toISOString()}\n`);
  let found = 0;
  for (const { pubkey, account } of raw) {
    const pk = pubkey.toBase58();
    if (!PREFIXES.some((p) => pk.startsWith(p))) continue;
    found++;
    let o: any; try { o = program.coder.accounts.decode("restingOrder", account.data); } catch (e: any) { console.log(`${pk} DECODE FAIL ${e?.message}`); continue; }
    const v = vlt.get((o.vault as PublicKey).toBase58());
    const m = v ? mkt.get((v.market as PublicKey).toBase58()) : null;
    const kind = Object.keys(o.kind ?? {})[0];
    const [escrow] = PublicKey.findProgramAddressSync([Buffer.from(RESTING_ORDER_ESCROW_SEED), pubkey.toBuffer()], program.programId);
    const eb = await bal(conn, escrow);
    const strike = v ? Number(v.strikePrice) / 1e6 : NaN;
    const exp = v ? (typeof v.expiry === "number" ? v.expiry : v.expiry.toNumber()) : 0;
    const otype = v ? ("call" in v.optionType ? "CALL" : "PUT") : "?";
    const estyle = v ? ("european" in v.exerciseStyle ? "EUR" : "AMER") : "?";
    console.log(`ORDER ${pk}`);
    console.log(`  kind=${kind}  owner(maker)=${(o.owner as PublicKey).toBase58()}`);
    console.log(`  asset=${m?.assetName ?? "?"} oracle_source=${m?.oracleSource} (${m?.oracleSource === 1 ? "SB" : "PYTH"})  ${otype} ${estyle} strike=$${strike.toFixed(2)}  expiry=${exp ? new Date(exp * 1000).toISOString() : "?"}`);
    console.log(`  price_per_contract=$${(Number(o.pricePerContract) / 1e6).toFixed(6)}  qty_remaining=${o.quantityRemaining} qty_initial=${o.quantityInitial}  cpt=$${(Number(o.collateralPerContract) / 1e6).toFixed(2)}`);
    console.log(`  option_mint=${(o.optionMint as PublicKey).toBase58()}  vault=${(o.vault as PublicKey).toBase58()}`);
    console.log(`  escrow=${escrow.toBase58()} bal=$${eb >= 0n ? (Number(eb) / 1e6).toFixed(2) : "none"}  nonce=${o.nonce}\n`);
  }
  console.log(`matched ${found}/${PREFIXES.length} canary orders`);
})().catch((e) => console.log("ERR", e.stack ?? e.message));
