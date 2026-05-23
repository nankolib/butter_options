// =============================================================================
// scripts/verify-vol-oracle-coverage.ts -- Pre-deploy VolOracle coverage check
// =============================================================================
//
// Phase 2 Stage C Pass 2 Step 2 — read-only safety gate before deploying the
// new mint_from_vault context (which requires a VolOracle PDA for every
// market's pyth_feed_id, regardless of vault exercise style).
//
// Usage:
//   npx ts-node scripts/verify-vol-oracle-coverage.ts
//
// Behavior:
//   - Enumerates all OptionsMarket PDAs via program.account.optionsMarket.all().
//   - For each market, derives its VolOracle PDA from pyth_feed_id and checks
//     existence via getAccountInfo (cheaper than .fetch which would deserialize).
//   - Exit 0 if every market has an oracle.
//   - Exit 1 + list of missing oracles if any are absent. Operator must run
//     the crank seed branch (crank/volOracleCrank.ts) before deploying;
//     this script intentionally does NOT post Pyth updates itself because
//     that logic already lives in the crank and duplicating it would drift.
//
// Idempotent: pure reads.
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { createHash } from "crypto";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const VOL_ORACLE_SEED = "vol_oracle";

// Anchor discriminator = first 8 bytes of sha256("account:OptionsMarket").
// Filter at the RPC layer to avoid the .all() orphan-decode trap
// (see memory/feedback_anchor_all_orphan_trap.md).
const OPTIONS_MARKET_DISCRIMINATOR = createHash("sha256")
  .update("account:OptionsMarket")
  .digest()
  .subarray(0, 8);

// OptionsMarket on-disk layout (matches programs/opta/src/state/market.rs):
//   8 disc + 4 + N asset_name (Borsh String, u32 LE len-prefixed)
//   + 32 pyth_feed_id + 1 asset_class + 1 bump
// We only need asset_name + pyth_feed_id.
function decodeOptionsMarketLight(data: Buffer): {
  assetName: string;
  pythFeedId: Buffer;
} | null {
  if (data.length < 8 + 4) return null;
  let offset = 8; // skip disc only — no admin field
  const nameLen = data.readUInt32LE(offset);
  offset += 4;
  // Sanity check: asset_name is bounded #[max_len(16)].
  if (nameLen > 16) return null;
  if (data.length < offset + nameLen + 32) return null;
  const assetName = data.subarray(offset, offset + nameLen).toString("utf8");
  offset += nameLen;
  const pythFeedId = data.subarray(offset, offset + 32);
  return { assetName, pythFeedId };
}

function deriveVolOracle(feedId: Buffer): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(VOL_ORACLE_SEED), feedId],
    PROGRAM_ID,
  );
}

async function main() {
  console.log("=== VolOracle coverage check ===\n");

  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  console.log("RPC:", provider.connection.rpcEndpoint);
  console.log("Program:", PROGRAM_ID.toBase58());

  // Discriminator-filtered raw fetch — avoids the .all() orphan trap.
  const accounts = await provider.connection.getProgramAccounts(PROGRAM_ID, {
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: anchor.utils.bytes.bs58.encode(OPTIONS_MARKET_DISCRIMINATOR),
        },
      },
    ],
  });
  console.log(`\nFound ${accounts.length} OptionsMarket accounts.\n`);

  const rows: Array<{
    asset: string;
    market: string;
    oracle: string;
    status: "seeded" | "MISSING";
  }> = [];

  for (const a of accounts) {
    const decoded = decodeOptionsMarketLight(a.account.data);
    if (!decoded) {
      console.warn(`  skipped ${a.pubkey.toBase58()} (decode failed)`);
      continue;
    }
    const [oraclePda] = deriveVolOracle(decoded.pythFeedId);
    const info = await provider.connection.getAccountInfo(oraclePda);
    rows.push({
      asset: decoded.assetName,
      market: a.pubkey.toBase58(),
      oracle: oraclePda.toBase58(),
      status: info ? "seeded" : "MISSING",
    });
  }

  const missing = rows.filter((r) => r.status === "MISSING");

  console.log("asset           | status   | oracle PDA");
  console.log("----------------|----------|" + "-".repeat(50));
  for (const r of rows) {
    console.log(
      `${r.asset.padEnd(15)} | ${r.status.padEnd(8)} | ${r.oracle}`,
    );
  }

  console.log(`\nSummary: ${rows.length - missing.length}/${rows.length} seeded.`);

  if (missing.length > 0) {
    console.error(
      `\n✗ ${missing.length} markets missing VolOracle. Run the crank's seed branch:`,
    );
    console.error(`    cd crank && npm run start  # boot tick auto-seeds`);
    console.error(`Or call initialize_vol_oracle manually for each missing feed.`);
    console.error(`Deploy is BLOCKED until coverage is 100%.`);
    process.exit(1);
  }

  console.log("\n✓ All markets covered. Safe to deploy.");
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  if (err.logs) console.error("Logs:", err.logs.slice(-5).join("\n  "));
  process.exit(1);
});
