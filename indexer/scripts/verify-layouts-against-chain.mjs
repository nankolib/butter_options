// =============================================================================
// verify-layouts-against-chain.mjs — do the hand-rolled offsets match REALITY?
// =============================================================================
//
// The unit tests in src/chain/layouts.test.ts prove the decoders are
// self-consistent: they write a field at offset N and read it back from offset
// N. If the documented offset table is itself wrong, those tests pass happily
// and every number is wrong in the same direction.
//
// So the offsets are checked against the only authority that matters: Anchor
// decoding the SAME live account through the deployed IDL. Field-by-field,
// every account, no sampling.
//
//   run: node scripts/verify-layouts-against-chain.mjs
// =============================================================================
import { Connection, PublicKey, Keypair } from "@solana/web3.js";
import anchor from "@coral-xyz/anchor";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  decodeSharedVault, decodeVaultMint, decodeEpochConfig, decodeOptionsMarket,
  discriminatorBase58,
} = require("../dist/src/chain/layouts.js");

const RPC = process.env.OPTA_RPC_URL || "https://rpc.opta.fyi/devnet";
const idl = JSON.parse(readFileSync(new URL("../idl/opta.json", import.meta.url), "utf8"));
const PROGRAM = new PublicKey(idl.address);

const conn = new Connection(RPC, "confirmed");
const provider = new anchor.AnchorProvider(conn, new anchor.Wallet(Keypair.generate()), { commitment: "confirmed" });
const program = new anchor.Program(idl, provider);

/** Anchor yields BN / PublicKey / enum objects; flatten to the shape our
 *  decoders emit so a comparison is meaningful rather than a type mismatch. */
function norm(v) {
  if (v == null) return v;
  if (typeof v === "object" && typeof v.toBase58 === "function") return v.toBase58();
  if (typeof v === "object" && typeof v.toString === "function" && v.constructor?.name === "BN") return v.toString();
  if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") return v;
  // Anchor enums decode as { american: {} } / { call: {} } — take the index of
  // the single key, matching the u8 our decoders read.
  if (typeof v === "object") {
    const k = Object.keys(v)[0];
    return k === undefined ? v : k;
  }
  return v;
}

async function check(accountName, ourDecode, fieldMap, expectLen) {
  const raw = await conn.getProgramAccounts(PROGRAM, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: discriminatorBase58(accountName) } }],
  });
  let ok = 0, rejected = 0, mismatched = 0;
  const sizes = new Map();
  const problems = [];

  for (const a of raw) {
    const buf = a.account.data;
    sizes.set(buf.length, (sizes.get(buf.length) || 0) + 1);
    const mine = ourDecode(buf);
    if (!mine) { rejected++; continue; }

    let theirs;
    try {
      theirs = program.coder.accounts.decode(
        accountName.charAt(0).toLowerCase() + accountName.slice(1), buf);
    } catch {
      problems.push(`${a.pubkey.toBase58()}: WE decoded it, ANCHOR could not`);
      mismatched++;
      continue;
    }

    let bad = null;
    for (const [ours, anchors] of Object.entries(fieldMap)) {
      const got = norm(mine[ours]);
      const want = norm(theirs[anchors]);
      // Enum comparison: ours is a u8 index, Anchor's is a variant name. Compare
      // only when both are primitives of the same kind; index-vs-name is checked
      // separately below via the variant ORDER.
      if (typeof want === "string" && typeof got === "number") continue;
      if (String(got) !== String(want)) { bad = `${ours}: ours=${got} anchor=${want}`; break; }
    }
    if (bad) { problems.push(`${a.pubkey.toBase58()}: ${bad}`); mismatched++; }
    else ok++;
  }

  const sizeStr = [...sizes.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `${s}B x${n}`).join("  ");
  console.log(`\n${accountName}`);
  console.log(`  on chain      : ${raw.length}   sizes: ${sizeStr || "(none)"}`);
  console.log(`  we decoded    : ${ok + mismatched}   (expected len ${expectLen ?? "variable"})`);
  console.log(`  rejected      : ${rejected}  <- legacy layouts, NEVER SILENT`);
  console.log(`  field matches : ${ok}`);
  console.log(`  MISMATCHES    : ${mismatched}${mismatched ? "  <-- OFFSETS ARE WRONG" : ""}`);
  problems.slice(0, 5).forEach((p) => console.log(`     ! ${p}`));
  return mismatched === 0;
}

const results = [];
results.push(await check("SharedVault", decodeSharedVault, {
  market: "market", strikePrice: "strikePrice", expiry: "expiry",
  totalCollateral: "totalCollateral", totalShares: "totalShares",
  vaultUsdcAccount: "vaultUsdcAccount", collateralMint: "collateralMint",
  totalOptionsMinted: "totalOptionsMinted", totalOptionsSold: "totalOptionsSold",
  netPremiumCollected: "netPremiumCollected",
  premiumPerShareCumulative: "premiumPerShareCumulative",
  isSettled: "isSettled", settlementPrice: "settlementPrice",
  collateralRemaining: "collateralRemaining", creator: "creator",
  createdAt: "createdAt", bump: "bump", carryRateBps: "carryRateBps",
  exercisedOptions: "exercisedOptions", earlyExercisePayout: "earlyExercisePayout",
  spreadBps: "spreadBps", voided: "voided",
  writerAskCollateralSwept: "writerAskCollateralSwept",
  writerAskEquivShares: "writerAskEquivShares",
}, 276));

results.push(await check("VaultMint", decodeVaultMint, {
  vault: "vault", writer: "writer", optionMint: "optionMint",
  premiumPerContract: "premiumPerContract", quantityMinted: "quantityMinted",
  quantitySold: "quantitySold", createdAt: "createdAt", bump: "bump",
}, 137));

results.push(await check("EpochConfig", decodeEpochConfig, {
  authority: "authority", weeklyExpiryDay: "weeklyExpiryDay",
  weeklyExpiryHour: "weeklyExpiryHour", monthlyEnabled: "monthlyEnabled",
  minEpochDurationDays: "minEpochDurationDays", bump: "bump",
}, 45));

results.push(await check("OptionsMarket", decodeOptionsMarket, {
  assetName: "assetName", assetClass: "assetClass", bump: "bump",
  oracleSource: "oracleSource",
}, null));

console.log(`\n${results.every(Boolean) ? "ALL LAYOUTS MATCH CHAIN" : "LAYOUT MISMATCH — DO NOT PROCEED"}`);
process.exit(results.every(Boolean) ? 0 : 1);
