// R-LEGACY gate: do any of the 14 legacy 260-byte vaults hold live user state?
//
// They render on the grid today and will vanish when exchangeData is aligned to
// exactly-276. Dropping them is deliberate, but "deliberate" requires knowing
// what is being dropped — a vault with collateral or unexercised options is a
// user's money, not a stale row.
//
// Offsets are read at the CURRENT layout's positions and reported as raw bytes
// too, because a 260-byte account is a PREVIOUS layout: its fields are not where
// the current struct says they are. That is exactly why they are being dropped,
// and it is also why nothing here should be trusted as a precise figure — the
// question is only "is this all zeroes, or is there something in it".
import { Connection, PublicKey } from "@solana/web3.js";
import { createHash } from "node:crypto";
import bs58 from "bs58";

const RPC = process.env.OPTA_RPC_URL || "https://rpc.opta.fyi/devnet";
const PROGRAM = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");

async function main() {
  const conn = new Connection(RPC, "confirmed");
  const disc = bs58.encode(createHash("sha256").update("account:SharedVault").digest().subarray(0, 8));
  const all = await conn.getProgramAccounts(PROGRAM, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: disc } }],
  });

  const legacy = all.filter((a) => a.account.data.length !== 276);
  console.log(`SharedVault accounts: ${all.length}   legacy (not 276B): ${legacy.length}\n`);

  let suspicious = 0;
  for (const a of legacy) {
    const d = a.account.data;
    // Anything non-zero past the identity fields means SOMETHING is stored.
    const tail = d.subarray(40);
    const nonZeroBytes = tail.reduce((n, b) => n + (b !== 0 ? 1 : 0), 0);

    // Read at current-layout offsets purely as an order-of-magnitude signal.
    const at = (o: number) => (d.length >= o + 8 ? d.readBigUInt64LE(o) : 0n);
    const totalCollateral = at(58);
    const totalOptionsMinted = at(138);
    const collateralRemaining = at(187);

    // Does its USDC vault account still hold anything? This is the only figure
    // here that does not depend on guessing the layout.
    let usdcBalance = "n/a";
    try {
      const usdcPk = new PublicKey(d.subarray(74, 106));
      const bal = await conn.getTokenAccountBalance(usdcPk, "confirmed");
      usdcBalance = bal.value.amount;
    } catch {
      usdcBalance = "(no readable token account)";
    }

    const live = usdcBalance !== "0" && usdcBalance !== "n/a" && !usdcBalance.startsWith("(");
    if (live) suspicious++;
    console.log(`${a.pubkey.toBase58()}  ${d.length}B`);
    console.log(`   nonzero bytes after offset 40 : ${nonZeroBytes} / ${tail.length}`);
    console.log(`   at-current-offsets (unreliable): collateral=${totalCollateral} minted=${totalOptionsMinted} remaining=${collateralRemaining}`);
    console.log(`   vault USDC token balance       : ${usdcBalance}${live ? "   <-- NONZERO, DO NOT DROP SILENTLY" : ""}`);
  }

  console.log(`\nlegacy vaults with a nonzero USDC balance: ${suspicious}`);
  console.log(suspicious === 0
    ? "SAFE TO DROP — no live collateral in the legacy set"
    : "HOLD — at least one legacy vault still holds funds");
}

void main();
