// =============================================================================
// scripts/migrate-shared-vaults-carry-rate.ts
// =============================================================================
//
// One-time migration runner: enumerates all SharedVault accounts on-chain,
// batches them into the migrate_shared_vault_carry_rate instruction, calls
// it once per batch. Admin pays the rent delta (~30-100 lamports per vault).
//
// DO NOT RUN until Stage C deployment.
// This script migrates production devnet SharedVault accounts. Stage A
// (this commit) ships only the instruction and the test scaffold; the
// actual migration is a Stage C deployment-time action, executed once
// after the Stage C `anchor deploy` and before American pricing wires in.
// Running prematurely is harmless (the instruction is idempotent and just
// no-ops on already-migrated vaults), but pollutes the migration log and
// burns admin rent for no reason.
//
// Run via:
//   ANCHOR_PROVIDER_URL=<rpc> ANCHOR_WALLET=<admin-keypair-path> \
//     npx ts-node scripts/migrate-shared-vaults-carry-rate.ts [--dry-run]
//
// Phase 2 Stage A scope:
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
// OLD = NEW - 4 bytes (carry_rate_bps i32, the field added in Stage A).
//
// NEW_INIT_SPACE = sum of SharedVault field sizes per #[derive(InitSpace)]:
//   market(32) + option_type(1) + strike_price(8) + expiry(8) + vault_type(1)
// + total_collateral(8) + total_shares(8) + vault_usdc_account(32)
// + collateral_mint(32) + total_options_minted(8) + total_options_sold(8)
// + net_premium_collected(8) + premium_per_share_cumulative(16)
// + is_settled(1) + settlement_price(8) + collateral_remaining(8)
// + creator(32) + created_at(8) + bump(1) + carry_rate_bps(4)
//   = 232 bytes
//
// Plus 8-byte Anchor discriminator -> account data size = 240 bytes (NEW),
// 236 bytes (OLD). Verified empirically by the cu-profile test scaffold
// (see tests/realloc-shared-vault.ts Case C output: new=240, shrunk=236).
const NEW_INIT_DATA_SIZE = 240;
const OLD_INIT_DATA_SIZE = NEW_INIT_DATA_SIZE - 4;

// SharedVault Anchor discriminator: first 8 bytes of sha256("account:SharedVault").
// Computed at runtime to avoid drift if Anchor's discriminator scheme ever changes.
function sharedVaultDiscriminator(): Buffer {
  return createHash("sha256")
    .update("account:SharedVault")
    .digest()
    .subarray(0, 8);
}

// Conservative batch size: ~15K CU per vault migration step (1 owner + 1
// discriminator + 1 system_transfer + 1 realloc + zero-fill loop). 1.4M CU
// per-tx max gives ~90 vaults; we use 20 for safety + log readability.
const BATCH_SIZE = 20;

// CU budget per migration tx. Default 200K wouldn't fit even one batch.
const TX_CU_BUDGET = 800_000;

const DRY_RUN = process.argv.includes("--dry-run");

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Opta as anchor.Program<any>;
  const conn = provider.connection;

  console.log(`migrate-shared-vaults-carry-rate ${DRY_RUN ? "[DRY RUN]" : ""}`);
  console.log(`  RPC:        ${conn.rpcEndpoint}`);
  console.log(`  Program:    ${program.programId.toBase58()}`);
  console.log(`  Admin:      ${provider.wallet.publicKey.toBase58()}`);
  console.log(`  Batch size: ${BATCH_SIZE} per tx`);
  console.log("");

  // 1. Enumerate all SharedVault accounts via raw getProgramAccounts. Avoids
  //    Anchor's typed `.all()` because legacy vaults at OLD size would fail
  //    the typed Borsh deser before we ever see them. Filters by data size
  //    (OLD or NEW) and discriminator memcmp.
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
  const legacy = allVaults.filter(
    (a) => a.account.data.length === OLD_INIT_DATA_SIZE
  );
  const other = allVaults.filter(
    (a) =>
      a.account.data.length !== NEW_INIT_DATA_SIZE &&
      a.account.data.length !== OLD_INIT_DATA_SIZE
  );

  console.log(`Found ${allVaults.length} SharedVault accounts:`);
  console.log(`  ${newSize.length} at NEW size (${NEW_INIT_DATA_SIZE} bytes) -- already migrated`);
  console.log(`  ${legacy.length} at OLD size (${OLD_INIT_DATA_SIZE} bytes) -- need migration`);
  if (other.length > 0) {
    console.warn(`  ${other.length} at unexpected size:`);
    for (const a of other) {
      console.warn(`    ${a.pubkey.toBase58()} (${a.account.data.length} bytes)`);
    }
  }

  if (legacy.length === 0) {
    console.log("\nNothing to migrate. Done.");
    return;
  }

  if (DRY_RUN) {
    console.log("\nDRY RUN -- would migrate the following vaults:");
    for (const a of legacy) {
      console.log(`  ${a.pubkey.toBase58()}`);
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
  for (let i = 0; i < legacy.length; i += BATCH_SIZE) {
    const batch = legacy.slice(i, i + BATCH_SIZE);
    const remainingAccounts = batch.map((a) => ({
      pubkey: a.pubkey,
      isSigner: false,
      isWritable: true,
    }));
    const sig = await (program.methods as any)
      .migrateSharedVaultCarryRate()
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
