// =============================================================================
// scripts/migrate-shared-vaults-exercise-tracking.ts
// =============================================================================
//
// One-time migration runner (Stage F): enumerates all SharedVault accounts
// on-chain, batches them into the migrate_shared_vault_exercise_tracking
// instruction, calls it once per batch. Admin pays the rent delta (~110-130
// lamports per vault for the 16 trailing bytes).
//
// Run AFTER the Stage F program deploy lands on chain (the new SharedVault
// schema is 257 bytes; un-migrated 241-byte vaults fail typed deserialization
// until grown). The instruction is idempotent (vaults already at 257 bytes are
// skipped). It grows ANY short vault to the current INIT_SPACE, zero-filling
// all trailing bytes — so it also catches any vault that somehow missed an
// earlier migration (carry_rate / exercise_style).
//
// Run via:
//   ANCHOR_PROVIDER_URL=<rpc> ANCHOR_WALLET=<admin-keypair-path> \
//     npx ts-node scripts/migrate-shared-vaults-exercise-tracking.ts [--dry-run]
//
// Phase 2 Stage F scope:
//     .context/plans/stage-f-exercise-american-scope.md
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { createHash } from "crypto";

// SharedVault on-disk size = 8 (Anchor discriminator) + INIT_SPACE.
// NEW (post-Stage-F)              = 8 + 249 = 257 bytes.
// PRE-STAGE-F (post-exercise-style) = 8 + 233 = 241 bytes — needs migration.
// Older shorter sizes (240 pre-exercise-style, 236 pre-Stage-A) should not
// exist if prior migrations ran, but are handled identically (grow to 257).
//
// INIT_SPACE = ... + carry_rate_bps(4) + exercise_style(1)
//   + exercised_options(8) + early_exercise_payout(8)   <-- Stage F additions
//   = 249 bytes.
const NEW_INIT_DATA_SIZE = 257;

// SharedVault Anchor discriminator: first 8 bytes of sha256("account:SharedVault").
function sharedVaultDiscriminator(): Buffer {
  return createHash("sha256")
    .update("account:SharedVault")
    .digest()
    .subarray(0, 8);
}

// 20 matches the Stage A/C precedent — 30 trips Solana's 1232-byte tx
// serialization limit via remaining_accounts overhead (~34 bytes/account).
const BATCH_SIZE = 20;

// CU budget per migration tx (matches prior migration scripts).
const TX_CU_BUDGET = 800_000;

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Opta as anchor.Program<any>;
  const conn = provider.connection;

  console.log(`migrate-shared-vaults-exercise-tracking ${DRY_RUN ? "[DRY RUN]" : ""}`);
  console.log(`  RPC:        ${conn.rpcEndpoint}`);
  console.log(`  Program:    ${program.programId.toBase58()}`);
  console.log(`  Admin:      ${provider.wallet.publicKey.toBase58()}`);
  console.log(`  Batch size: ${BATCH_SIZE} per tx`);
  console.log("");

  // 1. Enumerate all SharedVault accounts via raw getProgramAccounts (typed
  //    `.all()` would fail on short pre-Stage-F vaults). Filter by discriminator.
  const discBuf = sharedVaultDiscriminator();
  const allVaults = await conn.getProgramAccounts(program.programId, {
    filters: [
      {
        memcmp: {
          offset: 0,
          bytes: anchor.utils.bytes.bs58.encode(discBuf),
        },
      },
    ],
  });

  const newSize = allVaults.filter(
    (a) => a.account.data.length === NEW_INIT_DATA_SIZE
  );
  const needsMigration = allVaults.filter(
    (a) => a.account.data.length < NEW_INIT_DATA_SIZE
  );
  const other = allVaults.filter(
    (a) => a.account.data.length > NEW_INIT_DATA_SIZE
  );

  console.log(`Found ${allVaults.length} SharedVault accounts:`);
  console.log(`  ${newSize.length} at NEW size (${NEW_INIT_DATA_SIZE} bytes) -- already migrated`);
  console.log(`  ${needsMigration.length} shorter than ${NEW_INIT_DATA_SIZE} bytes -- need migration`);
  // Size distribution for the migration set (surfaces unexpected legacy sizes).
  const dist = new Map<number, number>();
  for (const a of needsMigration) {
    dist.set(a.account.data.length, (dist.get(a.account.data.length) ?? 0) + 1);
  }
  for (const [size, count] of [...dist.entries()].sort((x, y) => x[0] - y[0])) {
    console.log(`      ${count} at ${size} bytes`);
  }

  if (other.length > 0) {
    console.warn(`\n  ⚠️  ${other.length} vaults LARGER than ${NEW_INIT_DATA_SIZE} bytes:`);
    for (const a of other) {
      console.warn(`    ${a.pubkey.toBase58()} (${a.account.data.length} bytes)`);
    }
    console.warn(`  These are NOT migrated by this script -- investigate manually.`);
  }

  if (needsMigration.length === 0) {
    console.log("\nNothing to migrate. Done.");
    return;
  }

  if (DRY_RUN) {
    console.log("\nDRY RUN -- would migrate the following vaults:");
    for (const a of needsMigration) {
      console.log(`  ${a.pubkey.toBase58()} (${a.account.data.length} bytes)`);
    }
    return;
  }

  // 2. Resolve protocol_state PDA (PROTOCOL_SEED = b"protocol_v2").
  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_v2")],
    program.programId
  );

  // 3. Batch + migrate.
  let totalMigrated = 0;
  for (let i = 0; i < needsMigration.length; i += BATCH_SIZE) {
    const batch = needsMigration.slice(i, i + BATCH_SIZE);
    const remainingAccounts = batch.map((a) => ({
      pubkey: a.pubkey,
      isSigner: false,
      isWritable: true,
    }));
    const sig = await (program.methods as any)
      .migrateSharedVaultExerciseTracking()
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
      `  Batch ${Math.floor(i / BATCH_SIZE) + 1}: migrated ${batch.length} vaults (sig: ${sig})`
    );
  }

  console.log(`\nMigration complete: ${totalMigrated} vault(s) migrated.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
