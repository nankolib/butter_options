// READ-ONLY single-shot: is EaV3yxWb past its holder-window unlock (Sun
// 2026-07-19 17:16:09Z = expiry+24h)? Reports whether it's ready to withdraw OR
// already auto-finalized by a permissionless auto_finalize_writers sweep.
// exit 0 = window elapsed (present gate / verify sweep); 2 = still locked.
import * as anchor from "@coral-xyz/anchor"; import { Program } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import * as fs from "fs"; import * as os from "os"; import * as path from "path";
import type { Opta } from "@app/idl/opta";
import { safeFetchAll } from "@app/hooks/useFetchAccounts";

const VAULT = "EaV3yxWbredBKL2XNaBzE4Vm8MLxSo8iJo7KpSb4GnW7";
const UNLOCK = 1784394969 + 86400; // expiry + EXERCISE_WINDOW = 2026-07-19T17:16:09Z
(async () => {
  const rpc = process.env.OPTA_RPC_URL || fs.readFileSync(path.join(os.homedir(), ".opta-rpc-helius"), "utf-8").trim();
  const conn = new Connection(rpc, { commitment: "confirmed" });
  const program = new Program<Opta>(JSON.parse(fs.readFileSync(path.join(__dirname, "..", "app", "src", "idl", "opta.json"), "utf-8")) as Opta,
    new anchor.AnchorProvider(conn, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" }));
  const now = (await conn.getBlockTime(await conn.getSlot()))!;
  const vaults = await safeFetchAll<any>(program, "sharedVault");
  const rec = vaults.find((v) => v.publicKey.toBase58() === VAULT);
  const ua = rec ? await conn.getAccountInfo(rec.account.vaultUsdcAccount as PublicKey) : null;
  const ubal = ua && ua.data.length >= 72 ? ua.data.readBigUInt64LE(64) : -1n;
  console.log(`cluster now ${new Date(now * 1000).toISOString()} | unlock ${new Date(UNLOCK * 1000).toISOString()}`);
  console.log(`EaV3yxWb vault_usdc=$${ubal >= 0n ? (Number(ubal) / 1e6).toFixed(2) : "CLOSED (already swept)"}`);
  if (ubal < 0n || ubal === 0n) { console.log("RESULT: ALREADY FINALIZED (auto_finalize_writers swept it) — verify GkG received $650K"); process.exit(0); }
  if (now >= UNLOCK) { console.log("RESULT: UNLOCKED ✅ — present withdraw gate (or a cranker may auto_finalize any moment)"); process.exit(0); }
  console.log(`RESULT: still locked (${((UNLOCK - now) / 3600).toFixed(1)}h to unlock)`); process.exit(2);
})().catch((e) => { console.error("FATAL:", e?.message ?? e); process.exit(1); });
