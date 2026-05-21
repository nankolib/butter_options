// =============================================================================
// tests/realloc-shared-vault-exercise-style.ts -- Stage C Pass 1 migration
// =============================================================================
//
// Verifies migrate_shared_vault_exercise_style handles the Pass 1 schema
// evolution across three scenarios (mirrors Stage A's realloc-shared-vault.ts):
//
//   Case A: new-vault no-op
//     Vault already at NEW size (241); migration logs "skipped", data_len unchanged.
//
//   Case B: second-touch idempotency
//     Calls migration twice. Both calls skip cleanly. data_len stable.
//
//   Case C: pre-Pass-1 first-touch
//     Vault shrunk to OLD size (240) via
//     shrink_shared_vault_to_pre_exercise_style_for_test (simulating a
//     pre-Pass-1 on-chain account). Migration grows by 1 byte, zero-fills
//     the trailing byte. After deserialization, exercise_style reads as
//     European (Borsh variant 0).
//
// Uses cu-profile-gated test instructions to stand up bare SharedVault
// accounts and to shrink them. The MIGRATION instruction itself is
// production code (not gated) -- this test exercises the real code path
// that scripts/migrate-shared-vaults-exercise-style.ts will run.
//
// Gated by env var: CU_PROFILE=1 enables the test, otherwise it's skipped
// (because the test scaffold instructions only exist in cu-profile builds).
//
// Run via:
//   anchor build -- --features cu-profile
//   <start solana-test-validator with .so preloaded>
//   CU_PROFILE=1 ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 \
//     ANCHOR_WALLET=$HOME/.config/solana/id.json \
//     npx ts-mocha -p ./tsconfig.json -t 60000 \
//     --grep 'Realloc' tests/realloc-shared-vault-exercise-style.ts
//
// Phase 2 Stage C Pass 1 scope:
//   .context/plans/phase2-american-onchain-pricing-scope.md
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint } from "@solana/spl-token";
import { expect } from "chai";

const SHOULD_RUN = process.env.CU_PROFILE === "1";

(SHOULD_RUN ? describe : describe.skip)(
  "Realloc: SharedVault exercise_style migration",
  function () {
    this.timeout(60000);

    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.Opta as Program<any>;
    const adminKp = (provider.wallet as any).payer as Keypair;

    let protocolStatePda: PublicKey;

    before(async () => {
      // Initialize the protocol once if not already present. Migration
      // instruction needs a valid protocol_state to assert admin ==
      // protocol_state.admin.
      const [pStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("protocol_v2")],
        program.programId,
      );
      const [treasuryPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("treasury_v2")],
        program.programId,
      );
      protocolStatePda = pStatePda;

      const existing = await provider.connection.getAccountInfo(protocolStatePda);
      if (!existing) {
        const usdcMint = await createMint(
          provider.connection,
          adminKp,
          adminKp.publicKey,
          null,
          6,
        );
        await (program.methods as any)
          .initializeProtocol()
          .accounts({
            admin: adminKp.publicKey,
            protocolState: protocolStatePda,
            treasury: treasuryPda,
            usdcMint,
            systemProgram: SystemProgram.programId,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .rpc();
      }
    });

    /** Create a fresh test SharedVault at NEW size via the cu-profile-gated test instruction. */
    async function createTestSharedVault(): Promise<PublicKey> {
      const vaultKp = Keypair.generate();
      await (program.methods as any)
        .createTestSharedVault()
        .accounts({
          creator: adminKp.publicKey,
          sharedVault: vaultKp.publicKey,
          systemProgram: SystemProgram.programId,
        })
        .signers([vaultKp])
        .rpc();
      return vaultKp.publicKey;
    }

    async function getVaultDataLen(vault: PublicKey): Promise<number> {
      const acct = await provider.connection.getAccountInfo(vault);
      if (!acct) throw new Error(`vault account ${vault.toBase58()} not found`);
      return acct.data.length;
    }

    /** Call the production migration instruction with a single vault in remaining_accounts. */
    async function callMigrate(vault: PublicKey): Promise<void> {
      await (program.methods as any)
        .migrateSharedVaultExerciseStyle()
        .accounts({
          admin: adminKp.publicKey,
          protocolState: protocolStatePda,
          systemProgram: SystemProgram.programId,
        })
        .remainingAccounts([
          { pubkey: vault, isSigner: false, isWritable: true },
        ])
        .rpc();
    }

    /** Call the cu-profile-gated test-only shrinker (truncates by 1 byte). */
    async function callShrinkForTest(vault: PublicKey): Promise<void> {
      await (program.methods as any)
        .shrinkSharedVaultToPreExerciseStyleForTest()
        .accounts({
          sharedVault: vault,
        })
        .rpc();
    }

    it("Case A: new-vault no-op (migration sees correct size, skips)", async () => {
      const vault = await createTestSharedVault();
      const sizeBefore = await getVaultDataLen(vault);
      await callMigrate(vault);
      const sizeAfter = await getVaultDataLen(vault);
      console.log(`  Case A: data_len before=${sizeBefore} after=${sizeAfter}`);
      expect(sizeBefore).to.equal(sizeAfter);
    });

    it("Case B: second-touch no-op (idempotency)", async () => {
      const vault = await createTestSharedVault();
      const initial = await getVaultDataLen(vault);
      await callMigrate(vault);
      const after1 = await getVaultDataLen(vault);
      await callMigrate(vault);
      const after2 = await getVaultDataLen(vault);
      console.log(
        `  Case B: initial=${initial} after1=${after1} after2=${after2}`,
      );
      expect(initial).to.equal(after1);
      expect(after1).to.equal(after2);
    });

    it("Case C: pre-Pass-1 first-touch (shrink to OLD, migration grows + zero-fills)", async () => {
      const vault = await createTestSharedVault();
      const sizeNew = await getVaultDataLen(vault);

      // Simulate a pre-Pass-1 on-chain account by shrinking back 1 byte.
      await callShrinkForTest(vault);
      const sizeShrunk = await getVaultDataLen(vault);
      console.log(
        `  Case C: new=${sizeNew} shrunk=${sizeShrunk} (delta=${sizeNew - sizeShrunk})`,
      );
      expect(sizeShrunk).to.equal(sizeNew - 1);

      // Run the production migration instruction -- should grow + zero-fill.
      await callMigrate(vault);
      const sizeMigrated = await getVaultDataLen(vault);
      console.log(`  Case C: post-migration=${sizeMigrated}`);
      expect(sizeMigrated).to.equal(sizeNew);

      // Verify exercise_style reads as European (zero-filled byte = variant 0).
      const vaultAcct = await (program.account as any).sharedVault.fetch(vault);
      console.log(
        `  Case C: exercise_style after migration = ${JSON.stringify(vaultAcct.exerciseStyle)}`,
      );
      expect(vaultAcct.exerciseStyle.european).to.exist;
    });
  },
);
