// =============================================================================
// scripts/smoke-stage-d-gate.ts -- Phase 2 Stage D post-deploy gate smoke
// =============================================================================
//
// Runs against devnet after the Stage D (flag-off) program is deployed.
// Proves the AMERICAN_ENABLED gate is REAL in the deployed artifact: an
// American create_shared_vault must revert with AmericanVaultsDisabled (6052),
// NOT VolOracleWarmup. The gate sits at the TOP of the American arm, above the
// warmup check, so 6052 is the binding revert while the flag is off.
//
// SIMULATE-ONLY — does not land a tx (nothing to clean up). Verifies the
// program logs / AnchorError carry code 6052.
//
// Usage:
//   ANCHOR_PROVIDER_URL=https://api.devnet.solana.com \
//   ANCHOR_WALLET=~/.config/solana/id.json \
//   npx ts-node scripts/smoke-stage-d-gate.ts
// =============================================================================

import * as anchor from "@coral-xyz/anchor";
import { PublicKey, SystemProgram } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import BN from "bn.js";

const PROGRAM_ID = new PublicKey("CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq");
const DEVNET_USDC = new PublicKey("AytU5HUQRew9VdUdrzQuZvZ7s14pHLiYjAF5WqdK3oxL");

function usdc(n: number): BN { return new BN(Math.floor(n * 1_000_000)); }
function pda(seeds: (Buffer | Uint8Array)[]): PublicKey {
  return PublicKey.findProgramAddressSync(seeds, PROGRAM_ID)[0];
}

async function main() {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.opta as anchor.Program<any>;
  const signer = provider.wallet.publicKey;

  console.log("=== Stage D gate smoke (simulate-only) ===");
  console.log("RPC:    ", provider.connection.rpcEndpoint);
  console.log("Signer: ", signer.toBase58());

  const protocolStatePda = pda([Buffer.from("protocol_v2")]);
  const marketPda = pda([Buffer.from("market"), Buffer.from("SOL")]);

  // Fresh expiry → fresh American vault PDA, so the `init` constraint passes
  // and we reach the handler gate (rather than tripping "already in use").
  const strikeBN = usdc(400);
  const expiryBN = new BN(Math.floor(Date.now() / 1000) + 7200);
  const vaultPda = pda([
    Buffer.from("shared_vault_american"),
    marketPda.toBuffer(),
    strikeBN.toArrayLike(Buffer, "le", 8),
    expiryBN.toArrayLike(Buffer, "le", 8),
    Buffer.from([0]), // Call
  ]);
  const vaultUsdcPda = pda([Buffer.from("vault_usdc"), vaultPda.toBuffer()]);

  console.log("American vault PDA (hypothetical):", vaultPda.toBase58());

  // Build the instruction and simulate via raw connection.simulateTransaction so
  // we get the program logs verbatim (Anchor's .simulate() wrapper swallows the
  // parsed error code on some paths).
  const tx = await (program.methods as any)
    .createSharedVault(strikeBN, expiryBN, { call: {} }, { custom: {} }, DEVNET_USDC, 0, { american: {} })
    .accountsStrict({
      creator: signer,
      market: marketPda,
      sharedVault: vaultPda,
      vaultUsdcAccount: vaultUsdcPda,
      usdcMint: DEVNET_USDC,
      protocolState: protocolStatePda,
      epochConfig: null,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .transaction();
  tx.feePayer = signer;
  tx.recentBlockhash = (await provider.connection.getLatestBlockhash()).blockhash;

  const res = await provider.connection.simulateTransaction(tx);
  const logs = res.value.logs || [];
  console.log("--- simulation logs ---");
  for (const l of logs) console.log("  " + l);
  console.log("err:", JSON.stringify(res.value.err));

  const joined = logs.join("\n") + " " + JSON.stringify(res.value.err);
  // 6052 = 0x17A4 in the "custom program error" form.
  const is6052 = joined.includes("AmericanVaultsDisabled") || joined.includes("6052") || joined.includes("0x17a4") || joined.includes("0x17A4");
  const isWarmup = joined.includes("VolOracleWarmup");

  if (res.value.err === null) {
    console.error("✗ American create_shared_vault SIMULATED SUCCESS — gate is NOT active. FAIL.");
    process.exit(1);
  }
  if (isWarmup) {
    console.error("✗ reverted with VolOracleWarmup — gate did NOT fire above warmup. FAIL.");
    process.exit(1);
  }
  if (is6052) {
    console.log("✓ gate live: American create reverts with AmericanVaultsDisabled (6052 / 0x17A4).");
    process.exit(0);
  }
  console.error("✗ unexpected revert (not 6052) — see logs above. FAIL.");
  process.exit(1);
}

main().catch((err) => {
  console.error("FATAL:", err.message || err);
  if (err.logs) console.error("Logs:", err.logs.slice(-10).join("\n  "));
  process.exit(1);
});
