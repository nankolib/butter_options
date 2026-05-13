// =============================================================================
// tests/realloc-shared-vault.ts -- SharedVault carry_rate_bps schema migration
// =============================================================================
//
// Verifies the production migrate_shared_vault_carry_rate instruction handles
// the Stage A schema evolution correctly across three scenarios:
//
//   Case A: new-vault no-op
//     Vault already at NEW size; migration logs "skipped", data_len unchanged.
//
//   Case B: second-touch idempotency
//     Calls migration twice. Both calls skip cleanly. data_len stable.
//
//   Case C: legacy first-touch
//     Vault shrunk to OLD size via __shrink_shared_vault_for_test (simulating
//     a pre-Stage-A on-chain account). Migration grows by 4 bytes, zero-fills
//     the trailing tail. After deserialization, carry_rate_bps reads as 0.
//
// Uses cu-profile-gated test instructions to stand up bare SharedVault
// accounts and to shrink them. The MIGRATION instruction itself is
// production code (not gated) -- this test exercises the real code path
// that Stage C will run via scripts/migrate-shared-vaults-carry-rate.ts.
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
//     --grep 'Realloc' tests/realloc-shared-vault.ts
//
// Phase 2 Stage A scope:
//   .context/plans/phase2-american-onchain-pricing-scope.md
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Keypair, PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, createMint } from "@solana/spl-token";
import { expect } from "chai";

const SHOULD_RUN = process.env.CU_PROFILE === "1";

(SHOULD_RUN ? describe : describe.skip)(
  "Realloc: SharedVault carry_rate_bps migration",
  function () {
    this.timeout(60000);

    const provider = anchor.AnchorProvider.env();
    anchor.setProvider(provider);
    const program = anchor.workspace.Opta as Program<any>;
    const adminKp = (provider.wallet as any).payer as Keypair;

    let protocolStatePda: PublicKey;

    before(async () => {
      // Initialize the protocol once -- migration instruction needs a valid
      // protocol_state to assert admin == protocol_state.admin.
      // PROTOCOL_SEED = b"protocol_v2"; TREASURY_SEED = b"treasury_v2".
      const [pStatePda] = PublicKey.findProgramAddressSync(
        [Buffer.from("protocol_v2")],
        program.programId
      );
      const [treasuryPda] = PublicKey.findProgramAddressSync(
        [Buffer.from("treasury_v2")],
        program.programId
      );
      protocolStatePda = pStatePda;

      const usdcMint = await createMint(
        provider.connection,
        adminKp,
        adminKp.publicKey,
        null,
        6
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
        .migrateSharedVaultCarryRate()
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

    async function callShrinkForTest(vault: PublicKey): Promise<void> {
      await (program.methods as any)
        .shrinkSharedVaultForTest()
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
        `  Case B: initial=${initial} after1=${after1} after2=${after2}`
      );
      expect(initial).to.equal(after1);
      expect(after1).to.equal(after2);
    });

    it("Case C: legacy first-touch (shrink to OLD, migration grows + zero-fills)", async () => {
      const vault = await createTestSharedVault();
      const sizeNew = await getVaultDataLen(vault);

      // Simulate a pre-Stage-A on-chain account by shrinking back 4 bytes.
      await callShrinkForTest(vault);
      const sizeShrunk = await getVaultDataLen(vault);
      console.log(
        `  Case C: new=${sizeNew} shrunk=${sizeShrunk} (delta=${sizeNew - sizeShrunk})`
      );
      expect(sizeShrunk).to.equal(sizeNew - 4);

      // Run the production migration instruction -- should grow + zero-fill.
      await callMigrate(vault);
      const sizeMigrated = await getVaultDataLen(vault);
      console.log(`  Case C: post-migration=${sizeMigrated}`);
      expect(sizeMigrated).to.equal(sizeNew);

      // Verify carry_rate_bps reads as 0 (zero-filled tail).
      const vaultAcct = await (program.account as any).sharedVault.fetch(vault);
      console.log(
        `  Case C: carry_rate_bps after migration = ${vaultAcct.carryRateBps}`
      );
      expect(vaultAcct.carryRateBps).to.equal(0);
    });
  }
);
