// Read-only recon for D1 (ticket 86eyn66b4, dated verification 86eyn5kx8).
//
// Resolves the three vault prefixes named in the Aug-28 verification constraint
// to full addresses and dumps the state fields that decide whether a vault is
// still PAYABLE. The D1 gate must keep every payable vault in scope, so these
// three are the fixture the red-first test asserts against.
//
// Uses the public proxy (no key) and dataSlice on the enumeration pass so this
// probe is cheap: one gPA-class call plus three account reads.
import { Connection, PublicKey } from "@solana/web3.js";
import { BorshAccountsCoder, utils } from "@coral-xyz/anchor";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const idl = require("../app/src/idl/opta.json");

const RPC = process.env.OPTA_RPC_URL || "https://rpc.opta.fyi/devnet";
const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const PREFIXES = ["6tq9Ueck", "9CzbiMii", "3k5vHJLh"];

const coder = new BorshAccountsCoder(idl);
const disc = coder.accountDiscriminator("SharedVault");
const conn = new Connection(RPC, "confirmed");

const raw = await conn.getProgramAccounts(PROGRAM_ID, {
  commitment: "confirmed",
  dataSlice: { offset: 0, length: 0 },
  filters: [{ memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(disc) } }],
});
console.log(`SharedVault accounts discovered: ${raw.length}`);

const hits = [];
for (const pfx of PREFIXES) {
  const m = raw.filter((r) => r.pubkey.toBase58().startsWith(pfx));
  if (m.length === 0) console.log(`  !! ${pfx} -> NO MATCH`);
  else if (m.length > 1) console.log(`  !! ${pfx} -> AMBIGUOUS (${m.length})`);
  else {
    hits.push({ pfx, pubkey: m[0].pubkey });
    console.log(`  ${pfx} -> ${m[0].pubkey.toBase58()}`);
  }
}
if (hits.length === 0) process.exit(1);

const fetched = await conn.getMultipleAccountsInfo(hits.map((h) => h.pubkey));
const nowSec = Math.floor(Date.now() / 1000);

console.log("\n=== PROTECTED VAULT STATE ===");
for (let i = 0; i < hits.length; i++) {
  const acc = fetched[i];
  if (!acc) {
    console.log(`${hits[i].pfx}: MISSING ACCOUNT`);
    continue;
  }
  const v = coder.decode("SharedVault", acc.data);
  // The JSON IDL is snake_case, so decoded keys are snake_case too. Read via a
  // tolerant accessor rather than assuming a casing convention.
  const g = (...names) => {
    for (const n of names) if (v[n] !== undefined) return v[n];
    return undefined;
  };
  const s = (x) => (x === undefined || x === null ? null : x.toString());
  const expiry = Number(g("expiry"));
  const remaining = s(g("collateral_remaining", "collateralRemaining"));
  console.log(
    JSON.stringify(
      {
        prefix: hits[i].pfx,
        pubkey: hits[i].pubkey.toBase58(),
        dataLen: acc.data.length,
        is_settled: g("is_settled", "isSettled"),
        voided: g("voided"),
        expiry,
        daysSinceExpiry:
          expiry > 0 ? +((nowSec - expiry) / 86400).toFixed(2) : null,
        total_collateral: s(g("total_collateral", "totalCollateral")),
        collateral_remaining: remaining,
        total_options_minted: s(g("total_options_minted", "totalOptionsMinted")),
        total_options_sold: s(g("total_options_sold", "totalOptionsSold")),
        exercised_options: s(g("exercised_options", "exercisedOptions")),
        total_shares: s(g("total_shares", "totalShares")),
        PAYABLE_collateral_remaining_gt_0: remaining !== null && BigInt(remaining) > 0n,
        inScopeToday_isSettled: g("is_settled", "isSettled") === true,
      },
      null,
      2,
    ),
  );
}
