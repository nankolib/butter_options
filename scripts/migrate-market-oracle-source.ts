// =============================================================================
// scripts/migrate-market-oracle-source.ts
// =============================================================================
//
// One-time migration runner (Switchboard Stage 2): enumerates all OptionsMarket
// accounts on-chain, batches the current-schema ones into the
// migrate_market_oracle_source instruction, and calls it once per batch. Admin
// pays the (negligible, 1-byte) rent delta. The instruction zero-fills the new
// trailing oracle_source byte -> 0 (Pyth), the no-op default.
//
// SCOPE: only the current per-asset markets (62 bytes -> 63). The pre-Stage-2
// per-variation orphan accounts share the OptionsMarket discriminator but are
// LARGER (87/88/68 bytes); they are reported as "other" and intentionally
// skipped -- they are unreachable on-chain (every typed-load site resolves a
// market by asset_name -> one of the current PDAs) and already un-deserializable
// as the current schema. This mirrors the SharedVault carry_rate precedent.
//
// Idempotent: re-running no-ops on already-migrated (63-byte) markets.
//
// Run via:
//   ANCHOR_PROVIDER_URL=<rpc> ANCHOR_WALLET=<admin-keypair-path> \
//     npx ts-node scripts/migrate-market-oracle-source.ts [--dry-run]
//
// Switchboard arc Stage 2 (oracle_source schema):
//     .context/plans/switchboard-integration-scoping.md
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { createHash } from "crypto";

// OptionsMarket byte sizes on disk: 8 (Anchor discriminator) + INIT_SPACE.
//   asset_name(4+16) + pyth_feed_id(32) + asset_class(1) + bump(1) = 54
//   + oracle_source(1)  [the Stage 2 trailing append] = 55
// -> NEW account data size = 8 + 55 = 63 bytes; OLD = 62 bytes.
const NEW_INIT_DATA_SIZE = 63;
const OLD_INIT_DATA_SIZE = NEW_INIT_DATA_SIZE - 1;

// OptionsMarket Anchor discriminator: first 8 bytes of
// sha256("account:OptionsMarket"). Computed at runtime to avoid drift.
function optionsMarketDiscriminator(): Buffer {
  return createHash("sha256")
    .update("account:OptionsMarket")
    .digest()
    .subarray(0, 8);
}

// BATCH_SIZE 20 is the working default for remaining_accounts migrations
// (30+ trips Solana's 1232-byte tx serialization limit). The full current
// set of 16 markets fits a single batch.
const BATCH_SIZE = 20;

// CU budget per migration tx. Each market step is cheap (owner + discriminator
// + 1-byte realloc + zero-fill), but the default 200K wouldn't fit a full batch.
const TX_CU_BUDGET = 400_000;

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Opta as anchor.Program<any>;
  const conn = provider.connection;

  console.log(`migrate-market-oracle-source ${DRY_RUN ? "[DRY RUN]" : ""}`);
  console.log(`  RPC:        ${conn.rpcEndpoint}`);
  console.log(`  Program:    ${program.programId.toBase58()}`);
  console.log(`  Admin:      ${provider.wallet.publicKey.toBase58()}`);
  console.log(`  Batch size: ${BATCH_SIZE} per tx`);
  console.log("");

  // 1. Enumerate all OptionsMarket accounts via raw getProgramAccounts. Avoids
  //    Anchor's typed `.all()` because legacy/orphan accounts would fail the
  //    typed Borsh deser before we ever see them.
  const discBuf = optionsMarketDiscriminator();
  const all = await conn.getProgramAccounts(program.programId, {
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: anchor.utils.bytes.bs58.encode(discBuf),
        },
      },
    ],
  });

  const newSize = all.filter((a) => a.account.data.length === NEW_INIT_DATA_SIZE);
  const legacy = all.filter((a) => a.account.data.length === OLD_INIT_DATA_SIZE);
  const orphans = all.filter(
    (a) =>
      a.account.data.length !== NEW_INIT_DATA_SIZE &&
      a.account.data.length !== OLD_INIT_DATA_SIZE
  );

  console.log(`Found ${all.length} OptionsMarket accounts:`);
  console.log(`  ${newSize.length} at NEW size (${NEW_INIT_DATA_SIZE} bytes) -- already migrated`);
  console.log(`  ${legacy.length} at OLD size (${OLD_INIT_DATA_SIZE} bytes) -- need migration`);
  console.log(`  ${orphans.length} pre-Stage-2 orphans (other sizes) -- intentionally skipped`);

  if (legacy.length === 0) {
    console.log("\nNothing to migrate. Done.");
    return;
  }

  if (DRY_RUN) {
    console.log("\nDRY RUN -- would migrate the following markets:");
    for (const a of legacy) console.log(`  ${a.pubkey.toBase58()}`);
    return;
  }

  // 2. Resolve protocol_state PDA (PROTOCOL_SEED = b"protocol_v2").
  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_v2")],
    program.programId
  );

  // 3. Batch + migrate.
  let totalMigrated = 0;
  for (let i = 0; i < legacy.length; i += BATCH_SIZE) {
    const batch = legacy.slice(i, i + BATCH_SIZE);
    const remainingAccounts = batch.map((a) => ({
      pubkey: a.pubkey,
      isSigner: false,
      isWritable: true,
    }));
    const sig = await (program.methods as any)
      .migrateMarketOracleSource()
      .accounts({
        admin: provider.wallet.publicKey,
        protocolState: protocolStatePda,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(remainingAccounts)
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: TX_CU_BUDGET }),
      ])
      .rpc();
    totalMigrated += batch.length;
    console.log(
      `  Batch ${Math.floor(i / BATCH_SIZE) + 1}: migrated ${batch.length} market(s) (sig: ${sig})`
    );
  }

  console.log(`\nMigration complete: ${totalMigrated} market(s) migrated.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
