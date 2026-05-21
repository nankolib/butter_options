// =============================================================================
// scripts/migrate-shared-vaults-exercise-style.ts
// =============================================================================
//
// One-time migration runner: enumerates all SharedVault accounts on-chain,
// batches them into the migrate_shared_vault_exercise_style instruction, calls
// it once per batch. Admin pays the rent delta (~7-30 lamports per vault for
// the single trailing byte).
//
// Safe to run anytime after the Stage C Pass 1 program deploy lands on chain.
// The instruction is idempotent (vaults already at the new 241-byte schema
// are skipped). Lesson from Stage A: don't gate operational scripts behind
// "DO NOT RUN until..." comments — that caused a 2-day visibility gap on
// 2026-05-17 when the carry_rate migration was held back too literally.
//
// Run via:
//   ANCHOR_PROVIDER_URL=<rpc> ANCHOR_WALLET=<admin-keypair-path> \
//     npx ts-node scripts/migrate-shared-vaults-exercise-style.ts [--dry-run]
//
// Phase 2 Stage C Pass 1 scope:
//     .context/plans/phase2-american-onchain-pricing-scope.md
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import { createHash } from "crypto";

// SharedVault byte sizes on disk:
//   8 (Anchor discriminator) + INIT_SPACE
// NEW (post-Pass-1) = 8 + 233 = 241 bytes.
// OLD (post-Stage-A, pre-Pass-1) = 8 + 232 = 240 bytes; needs migration.
// LEGACY (pre-Stage-A) = 236 bytes; should NOT exist post-2026-05-19 (Stage A
//   migration ran), but logged defensively as a sanity bucket. The instruction
//   handles them fine — it grows to current INIT_SPACE regardless of starting
//   length — but loud logging surfaces unexpected on-chain state.
//
// NEW_INIT_DATA_SIZE = sum of SharedVault field sizes per #[derive(InitSpace)]:
//   market(32) + option_type(1) + strike_price(8) + expiry(8) + vault_type(1)
// + total_collateral(8) + total_shares(8) + vault_usdc_account(32)
// + collateral_mint(32) + total_options_minted(8) + total_options_sold(8)
// + net_premium_collected(8) + premium_per_share_cumulative(16)
// + is_settled(1) + settlement_price(8) + collateral_remaining(8)
// + creator(32) + created_at(8) + bump(1) + carry_rate_bps(4)
// + exercise_style(1)   <-- Pass 1 addition
//   = 233 bytes
//
// Plus 8-byte Anchor discriminator -> account data size = 241 bytes (NEW),
// 240 bytes (OLD), 236 bytes (legacy pre-Stage-A).
const NEW_INIT_DATA_SIZE = 241;
const OLD_INIT_DATA_SIZE = NEW_INIT_DATA_SIZE - 1; // 240
const LEGACY_PRE_STAGE_A_SIZE = 236; // defensive bucket

// SharedVault Anchor discriminator: first 8 bytes of sha256("account:SharedVault").
// Computed at runtime to avoid drift if Anchor's discriminator scheme ever changes.
function sharedVaultDiscriminator(): Buffer {
  return createHash("sha256")
    .update("account:SharedVault")
    .digest()
    .subarray(0, 8);
}

// Conservative batch size: 20 matches Stage A precedent -- 30 trips
// Solana's 1232-byte tx serialization limit due to remaining_accounts
// overhead (~34 bytes per account: 32-byte pubkey + signer/writable
// flags). CU isn't the constraint; tx size is. ~10K CU per vault step
// (1 owner + 1 discriminator + 1 system_transfer + 1 realloc + tiny
// zero-fill loop) leaves CU room for ~140 vaults per tx; tx-size cap
// is what limits the batch.
const BATCH_SIZE = 20;

// CU budget per migration tx. 800K matches the carry_rate script's value.
const TX_CU_BUDGET = 800_000;

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Opta as anchor.Program<any>;
  const conn = provider.connection;

  console.log(`migrate-shared-vaults-exercise-style ${DRY_RUN ? "[DRY RUN]" : ""}`);
  console.log(`  RPC:        ${conn.rpcEndpoint}`);
  console.log(`  Program:    ${program.programId.toBase58()}`);
  console.log(`  Admin:      ${provider.wallet.publicKey.toBase58()}`);
  console.log(`  Batch size: ${BATCH_SIZE} per tx`);
  console.log("");

  // 1. Enumerate all SharedVault accounts via raw getProgramAccounts. Avoids
  //    Anchor's typed `.all()` because legacy vaults at smaller sizes would
  //    fail the typed Borsh deser before we ever see them. Filters by
  //    discriminator memcmp at offset 0.
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
    (a) => a.account.data.length === OLD_INIT_DATA_SIZE
  );
  const preStageA = allVaults.filter(
    (a) => a.account.data.length === LEGACY_PRE_STAGE_A_SIZE
  );
  const other = allVaults.filter(
    (a) =>
      a.account.data.length !== NEW_INIT_DATA_SIZE &&
      a.account.data.length !== OLD_INIT_DATA_SIZE &&
      a.account.data.length !== LEGACY_PRE_STAGE_A_SIZE
  );

  console.log(`Found ${allVaults.length} SharedVault accounts:`);
  console.log(`  ${newSize.length} at NEW size (${NEW_INIT_DATA_SIZE} bytes) -- already migrated`);
  console.log(`  ${needsMigration.length} at OLD size (${OLD_INIT_DATA_SIZE} bytes) -- need migration`);

  // Defensive bucket: pre-Stage-A 236-byte vaults should NOT exist post
  // 2026-05-19 (the Stage A migration ran on devnet that day, 27 vaults
  // grown 236->240). If any 236-byte vaults appear here, log loudly and
  // include them in the migration batch — the on-chain handler grows any
  // short vault to the current target size (241), zero-filling all trailing
  // bytes (which covers BOTH carry_rate_bps AND exercise_style fields).
  if (preStageA.length > 0) {
    console.warn(
      `\n  ⚠️  ${preStageA.length} vaults at ${LEGACY_PRE_STAGE_A_SIZE} bytes (pre-Stage-A).`
    );
    console.warn(
      `  These should NOT exist post-2026-05-19 carry_rate migration. ` +
      `The instruction will grow them ${LEGACY_PRE_STAGE_A_SIZE}->${NEW_INIT_DATA_SIZE} bytes ` +
      `(zero-filling both carry_rate_bps AND exercise_style fields). ` +
      `Investigate the source of these vaults before continuing.`
    );
    for (const a of preStageA) console.warn(`    ${a.pubkey.toBase58()}`);
    // Still migratable -- add to the batch with loud logging above so the
    // operator sees the surprise but the run completes.
    needsMigration.push(...preStageA);
  }

  if (other.length > 0) {
    console.warn(`\n  ⚠️  ${other.length} vaults at UNEXPECTED size:`);
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
      .migrateSharedVaultExerciseStyle()
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
