// =============================================================================
// diag-mstr-3007.ts — read-only triage for 3007 / 3012-class Write incidents
// =============================================================================
//
// PURPOSE
//   Diagnose Anchor framework errors 3007 (AccountOwnedByWrongProgram) and
//   3012 (AccountNotInitialized) reported during Write / Exercise / Settle
//   flows. Both surface when an `Account<T>` / `AccountLoader<T>` constraint
//   fails because a required PDA hasn't been seeded yet — typical when:
//     - A new market is registered via the permissionless `create_market`
//       path but its VolOracle PDA hasn't yet been initialized by the crank.
//     - A `SettlementRecord` is referenced before `settle_expiry` populates it.
//     - Any other admin-migration-pending account is referenced pre-migration.
//   The "3007 = AccountNotMutable" attribution is a well-known misconception;
//   the canonical mapping from anchor-lang 0.32.1/src/error.rs is:
//     3006 = AccountNotMutable
//     3007 = AccountOwnedByWrongProgram   ← what this script triages
//     3012 = AccountNotInitialized
//
// WHEN TO USE
//   Run this whenever a user reports "Program error 3007" or "3012" on Write
//   for a specific asset. The script will:
//     1. Confirm the OptionsMarket PDA exists + extract its pyth_feed_id.
//     2. Probe the expected VolOracle PDA and report seeded state vs the
//        known-good control (BTC).
//     3. Derive + probe the SharedVault PDA at the user's reported params to
//        determine whether stages 1-2 of the Write flow landed before the
//        3007 / 3012 fired.
//     4. Live-simulate `create_shared_vault` (DEPLOYER_PUBKEY fee payer,
//        sigVerify=false, replaceRecentBlockhash=true) and dump program logs.
//        The sim's "AnchorError caused by account: <NAME>" line names the
//        failing account directly.
//
// CONFIGURATION
//   Edit ASSET, STRIKE_USDC, EXPIRY_UNIX, optTypeIdx in the body to match
//   the incident. Default config (MSTR + $175 + 2026-06-27 19:28 UTC + CALL)
//   reproduces the 2026-05-28 MSTR Custom Vault investigation. RPC URL is
//   the public devnet endpoint by default — swap to Helius for production
//   debugging with higher rate limits.
//
// CONSTRAINTS
//   Read-only. No transactions submitted. No state changes. Safe to run
//   against mainnet (with mainnet program-id swap) without authorization.
//
// HISTORY
//   2026-05-28 — created during MSTR Custom Vault 3007 incident. Corrected
//   the "3007 = AccountNotMutable" attribution against anchor-lang 0.32.1
//   source. Companion to the window-walk arc (commit 975cd0a) and the
//   admin-fallback scope doc at .context/plans/admin-fallback-settlement-scope.md.
// =============================================================================

import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import idl from "../src/idl/opta.json";

const RPC = "https://api.devnet.solana.com";
const ASSET = "MSTR";

(async () => {
  const conn = new Connection(RPC, "confirmed");
  const wallet = new Wallet(Keypair.generate()); // read-only, no signing
  const provider = new AnchorProvider(conn, wallet, { commitment: "confirmed" });
  // Anchor 0.32 Program(idl, provider) — programId is read from idl.address
  const program = new Program(idl as any, provider);
  const programId = program.programId;

  console.log(`Program ID:      ${programId.toBase58()}`);
  console.log(`RPC:             ${RPC}`);
  console.log();

  // ---- MSTR market PDA ----
  const [marketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), Buffer.from(ASSET)],
    programId,
  );
  console.log(`MSTR market PDA: ${marketPda.toBase58()}`);

  // Use raw getAccountInfo so we can distinguish "doesn't exist" (null) from
  // an RPC error (throw). Anchor's .fetch() conflates them as the same throw.
  const marketAcct = await conn.getAccountInfo(marketPda);
  if (!marketAcct) {
    console.log(`  → MSTR OptionsMarket DOES NOT EXIST on devnet (getAccountInfo returned null)`);
    process.exit(0);
  }
  console.log(`  → MSTR OptionsMarket account exists at PDA (owner=${marketAcct.owner.toBase58()}, size=${marketAcct.data.length})`);
  let market: any;
  try {
    market = await (program.account as any).optionsMarket.fetch(marketPda);
  } catch (e: any) {
    console.log(`  → fetch+decode failed: ${e?.message ?? e}`);
    process.exit(0);
  }
  console.log(`  → decoded as OptionsMarket`);
  const feedIdBytes = Buffer.from(market.pythFeedId as number[] | Buffer);
  console.log(`    pyth_feed_id (hex): 0x${feedIdBytes.toString("hex")}`);
  console.log(`    asset_class:        ${market.assetClass}`);
  console.log(`    asset_name:         "${market.assetName}"`);
  if ("createdAt" in market) {
    console.log(`    created_at:         ${market.createdAt} (${new Date(Number(market.createdAt) * 1000).toISOString()})`);
  }
  console.log();

  // ---- MSTR VolOracle PDA ----
  const [volOraclePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vol_oracle"), feedIdBytes],
    programId,
  );
  console.log(`Expected VolOracle PDA: ${volOraclePda.toBase58()}`);
  const volAcct = await conn.getAccountInfo(volOraclePda);
  if (!volAcct) {
    console.log(`  → VolOracle account DOES NOT EXIST`);
    console.log(`    This is the 3007 (AccountOwnedByWrongProgram) trigger.`);
    console.log(`    Anchor expects program-owned; unseeded PDA = SystemProgram-owned default.`);
  } else {
    console.log(`  → VolOracle account EXISTS`);
    console.log(`    owner:    ${volAcct.owner.toBase58()}`);
    console.log(`    expected: ${programId.toBase58()}`);
    console.log(`    size:     ${volAcct.data.length}`);
    if (!volAcct.owner.equals(programId)) {
      console.log(`    → OWNER MISMATCH — this would be the 3007 source.`);
    }
  }
  console.log();

  // ---- Did stages 1+2 land before stage 3 (mint_from_vault) blew up? ----
  // SharedVault PDA derivation for EUR (Stage C Pass 1 namespace).
  // The user reported: strike $175, expiry 2026-06-27 19:28:00 UTC, side CALL.
  const STRIKE_USDC = BigInt(175_000_000); // 175 * 1e6 micro-USDC
  const EXPIRY_UNIX = BigInt(Math.floor(Date.UTC(2026, 5, 27, 19, 28, 0) / 1000));
  console.log(`User-reported expiry: ${EXPIRY_UNIX} = ${new Date(Number(EXPIRY_UNIX) * 1000).toISOString()}`);
  const optTypeIdx = 0; // CALL
  const strikeLE = Buffer.alloc(8); strikeLE.writeBigUInt64LE(STRIKE_USDC);
  const expiryLE = Buffer.alloc(8); expiryLE.writeBigInt64LE(EXPIRY_UNIX);
  const [sharedVaultPda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("shared_vault"),
      marketPda.toBuffer(),
      strikeLE,
      expiryLE,
      Buffer.from([optTypeIdx]),
    ],
    programId,
  );
  console.log(`Expected SharedVault PDA: ${sharedVaultPda.toBase58()}`);
  const sv = await conn.getAccountInfo(sharedVaultPda);
  if (!sv) {
    console.log(`  → SharedVault DOES NOT EXIST — stage 1 (create_shared_vault) didn't land. No stranded collateral.`);
  } else {
    console.log(`  → SharedVault EXISTS (owner=${sv.owner.toBase58()}, size=${sv.data.length})`);
    console.log(`    → Stage 1 landed. User likely has stranded collateral if stage 2 also landed.`);
    try {
      const svDecoded = await (program.account as any).sharedVault.fetch(sharedVaultPda);
      console.log(`    deposited_collateral: ${svDecoded.totalCollateral?.toString() ?? "?"} (micro-USDC)`);
      console.log(`    total_minted:         ${svDecoded.totalMinted?.toString() ?? "?"} contracts`);
      console.log(`    exercise_style:       ${JSON.stringify(svDecoded.exerciseStyle)}`);
      console.log(`    vault_type:           ${JSON.stringify(svDecoded.vaultType)}`);
    } catch (e: any) {
      console.log(`    decode failed: ${e?.message}`);
    }
  }
  console.log();

  // ---- Simulate the create_shared_vault tx the frontend would build ----
  // Uses a fresh keypair as creator + replaceRecentBlockhash + sigVerify=false
  // so we don't need real funds. The sim logs will name the failing account.
  console.log(`\n######## simulate create_shared_vault for MSTR ########`);
  const sysProgram = new PublicKey("11111111111111111111111111111111");
  const tokenProgramId = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");

  // Fetch protocolState to get the canonical USDC mint
  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_v2")],
    programId,
  );
  const ps = await (program.account as any).protocolState.fetch(protocolStatePda);
  const usdcMint = ps.usdcMint as PublicKey;
  console.log(`protocol_state.usdc_mint: ${usdcMint.toBase58()}`);
  const usdcMintAcct = await conn.getAccountInfo(usdcMint);
  console.log(`  on-chain owner: ${usdcMintAcct?.owner.toBase58() ?? "<null>"}`);
  console.log(`  expected:       ${tokenProgramId.toBase58()} (legacy SPL Token)`);
  if (usdcMintAcct && !usdcMintAcct.owner.equals(tokenProgramId)) {
    console.log(`  → USDC MINT OWNER MISMATCH — would 3007 every create_shared_vault.`);
  }

  // Derive vault_usdc PDA
  const [vaultUsdcPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault_usdc"), sharedVaultPda.toBuffer()],
    programId,
  );

  // Use DEPLOYER_PUBKEY as creator/fee-payer — it exists on-chain so the sim
  // gets past Solana's pre-program AccountNotFound check.
  const CREATOR = new PublicKey("5YRMuuoY3P7z5GeRAAQND7BxgNdmPSa6CSPCJLca1zZk");

  // Re-derive SharedVault PDA pinned to this creator (no creator in seeds, so unchanged):
  // SharedVault seeds are [SHARED_VAULT_SEED, market, strike_le, expiry_le, opt_type].
  // No creator dependency, so the existing sharedVaultPda is valid.

  const ix = await (program.methods as any)
    .createSharedVault(
      new BN(STRIKE_USDC.toString()),
      new BN(EXPIRY_UNIX.toString()),
      { call: {} } as any,
      { custom: {} } as any,
      usdcMint,
      0,
      { european: {} } as any,
    )
    .accountsStrict({
      creator: CREATOR,
      market: marketPda,
      sharedVault: sharedVaultPda,
      vaultUsdcAccount: vaultUsdcPda,
      usdcMint: usdcMint,
      protocolState: protocolStatePda,
      epochConfig: null,
      tokenProgram: tokenProgramId,
      systemProgram: sysProgram,
    })
    .instruction();

  // Use VersionedTransaction + sigVerify=false + replaceRecentBlockhash=true
  // so the unfunded random fee-payer doesn't pre-fail the sim.
  const { TransactionMessage, VersionedTransaction } = await import("@solana/web3.js");
  const { blockhash } = await conn.getLatestBlockhash();
  const msg = new TransactionMessage({
    payerKey: CREATOR,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();
  const vtx = new VersionedTransaction(msg);
  const sim = await conn.simulateTransaction(vtx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
  });
  console.log(`sim err:  ${JSON.stringify(sim.value.err)}`);
  console.log(`sim logs:`);
  for (const l of sim.value.logs ?? []) console.log(`  ${l}`);

  // ---- Sample comparison: a known-seeded asset ----
  const KNOWN = "BTC";
  const [knownMarketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), Buffer.from(KNOWN)],
    programId,
  );
  try {
    const km = await (program.account as any).optionsMarket.fetch(knownMarketPda);
    const knownFeed = Buffer.from(km.pythFeedId as number[] | Buffer);
    const [knownVolPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("vol_oracle"), knownFeed],
      programId,
    );
    const knownAcct = await conn.getAccountInfo(knownVolPda);
    console.log(
      `Control — ${KNOWN} VolOracle ${knownAcct ? "EXISTS" : "MISSING"} ` +
        `at ${knownVolPda.toBase58()} (size=${knownAcct?.data.length ?? "n/a"})`,
    );
  } catch {
    console.log(`Control — ${KNOWN} market fetch failed (unexpected)`);
  }
})();
