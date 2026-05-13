// =============================================================================
// tests/cu-profile-american.ts -- BS-2002 American pricing CU profile
// =============================================================================
//
// Gated by env var: CU_PROFILE=1 enables the test, otherwise it's skipped
// (because the cu_profile_american instruction only exists in cu-profile-
// feature builds; running without the feature would just throw "method
// not found"). Project's normal `anchor test` glob picks up this file but
// skips it absent CU_PROFILE.
//
// Run via:
//   anchor build -- --features cu-profile
//   CU_PROFILE=1 anchor test --skip-build -- --grep 'CU Profile'
//
// Phase 2 Stage A scope:
//   .context/plans/phase2-american-onchain-pricing-scope.md
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { ComputeBudgetProgram } from "@solana/web3.js";

const SHOULD_RUN = process.env.CU_PROFILE === "1";

(SHOULD_RUN ? describe : describe.skip)("CU Profile: american_pricing", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  // Cast through `any` because the cu_profile_american instruction only
  // exists in the IDL when built with the cu-profile feature.
  const program = anchor.workspace.Opta as Program<any>;

  it("measures CU per scenario + per-phi", async () => {
    // Bump CU limit to the per-tx max (1.4M). Default 200K can't fit even
    // one BS-2002 main path.
    const sig = await (program.methods as any)
      .cuProfileAmerican()
      .accounts({ signer: provider.wallet.publicKey })
      .preInstructions([
        ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }),
      ])
      .rpc({ commitment: "confirmed" });

    const tx = await provider.connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });

    if (!tx || !tx.meta || !tx.meta.logMessages) {
      throw new Error("no logs available on the profile tx");
    }

    console.log("\n========== CU PROFILE LOGS ==========");
    for (const line of tx.meta.logMessages) {
      // Print only the lines we care about (CU markers + scenario headers
      // + result lines + per-phi markers).
      if (
        line.includes("compute units") ||
        line.includes("consumption:") ||
        line.includes("===") ||
        line.includes("=BS2002=") ||
        line.includes("result:")
      ) {
        console.log(line);
      }
    }
    console.log("=====================================\n");
  });
});
