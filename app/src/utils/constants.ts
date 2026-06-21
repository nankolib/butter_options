// ============================================================================
// ⚠️  DEVNET / LOCALNET ONLY — NOT SAFE FOR MAINNET
// ============================================================================
//
// Every address, program ID, and keypair in this file is a devnet artifact.
// Nothing here has been deployed, audited, or secured for mainnet use.
//
// STRUCTURAL RISK — cluster choice lives in a DIFFERENT file:
//   app/src/contexts/WalletContext.tsx:24   →   clusterApiUrl("devnet")
// Flipping that single line to "mainnet-beta" without also updating this
// file will silently point the app at mainnet while still using devnet
// addresses and a publicly-known signing key. In that state, any wallet
// funded with DEVNET_FAUCET_KEYPAIR is drained within seconds of deploy.
//
// RUNTIME GUARD: WalletContext.tsx asserts that the inferred cluster
// matches `EXPECTED_CLUSTER` below. A mainnet RPC URL with this file
// untouched will throw at boot — visible crash, no silent breakage.
// Update EXPECTED_CLUSTER, PROGRAM_ID, TRANSFER_HOOK_PROGRAM_ID, and
// DEVNET_USDC_MINT in lockstep when promoting clusters.
//
// BEFORE ANY MAINNET BUILD — REQUIRED CHANGES:
//   [ ] Deploy both Anchor programs to mainnet; replace PROGRAM_ID and
//       TRANSFER_HOOK_PROGRAM_ID below with the mainnet addresses.
//   [ ] Set EXPECTED_CLUSTER = "mainnet-beta" below.
//   [ ] Replace DEVNET_USDC_MINT with Circle's real USDC mint
//       (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v).
//   [ ] DELETE DEVNET_FAUCET_KEYPAIR entirely, then delete its only caller
//       in app/src/components/Header.tsx (the "Get devnet USDC" button).
//   [ ] Change app/src/contexts/WalletContext.tsx:24 to mainnet-beta and
//       swap the public RPC for a paid provider (Helius / Triton / QuickNode).
//   [ ] Re-run the full `anchor test` suite against the mainnet deployment.
// ============================================================================

import { PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";

export { TOKEN_2022_PROGRAM_ID };

// Devnet deployment only (per Anchor.toml). No mainnet address exists yet.
// See file header for pre-mainnet checklist.
export const PROGRAM_ID = new PublicKey(
  "CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq",
);

// Devnet deployment only (per Anchor.toml). No mainnet address exists yet.
// See file header for pre-mainnet checklist.
export const TRANSFER_HOOK_PROGRAM_ID = new PublicKey(
  "83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG",
);

// Build-time expected cluster. WalletContext asserts the runtime-inferred
// cluster (from VITE_RPC_URL) matches this value; mismatch throws at boot.
// Lockstep with PROGRAM_ID / TRANSFER_HOOK_PROGRAM_ID / DEVNET_USDC_MINT —
// promote all four together when moving to mainnet. See file header.
export const EXPECTED_CLUSTER: "devnet" | "mainnet-beta" = "devnet";

// PDA seeds (must match the Rust program)
export const PROTOCOL_SEED = "protocol_v2";
export const TREASURY_SEED = "treasury_v2";
export const MARKET_SEED = "market";
export const POSITION_SEED = "position";
export const ESCROW_SEED = "escrow";
export const OPTION_MINT_SEED = "option_mint";
export const PURCHASE_ESCROW_SEED = "purchase_escrow";
export const RESALE_ESCROW_SEED = "resale_escrow";

// === V2 Vault Seeds ===
export const SHARED_VAULT_SEED = "shared_vault";
export const SHARED_VAULT_AMERICAN_SEED = "shared_vault_american";
export const VAULT_USDC_SEED = "vault_usdc";
export const WRITER_POSITION_SEED = "writer_position";
export const VAULT_MINT_RECORD_SEED = "vault_mint_record";
export const VAULT_OPTION_MINT_SEED = "vault_option_mint";
export const VAULT_PURCHASE_ESCROW_SEED = "vault_purchase_escrow";
export const EPOCH_CONFIG_SEED = "epoch_config";

// === V2 Secondary Listing Seeds (Stage Secondary, May 2026) ===
export const VAULT_RESALE_LISTING_SEED = "vault_resale_listing";
export const VAULT_RESALE_ESCROW_SEED = "vault_resale_escrow";

// === Exchange Book Seeds (Phase 1 — RestingOrder limit book) ===
// MUST match RESTING_ORDER_SEED / RESTING_ORDER_ESCROW_SEED in
// programs/opta/src/state/resting_order.rs.
// PDAs: [RESTING_ORDER_SEED, option_mint, owner, nonce_le] -> order;
//       [RESTING_ORDER_ESCROW_SEED, order]                 -> per-order escrow.
export const RESTING_ORDER_SEED = "resting_order";
export const RESTING_ORDER_ESCROW_SEED = "resting_order_escrow";

// === Exchange Series mint PDA layout (Phase 2 Pass A — D5) ===
// The canonical per-spec series mint reuses VAULT_OPTION_MINT_SEED but with a
// SPEC-ONLY seed layout (no writer, no timestamp) — distinct from the legacy
// per-event mint. MUST match `create_series.rs` (CreateSeries.option_mint seeds):
//
//   series mint PDA = [
//     VAULT_OPTION_MINT_SEED,            // "vault_option_mint"
//     market,                            // 32 bytes
//     strike.toBuffer("le", 8),          // u64 LE
//     expiry.toBuffer("le", 8),          // i64 LE
//     [optionType as u8],                // Call=0, Put=1
//     [exerciseStyle as u8],             // European=0, American=1 (Phase 2 = American only)
//   ]
//
// Legacy per-event mint (mint_from_vault) is the SAME prefix but
// [VAULT_OPTION_MINT_SEED, vault, writer, created_at_le] — do not conflate.
// The series record stays at [VAULT_MINT_RECORD_SEED, option_mint] (unchanged).
export const SERIES_OPTION_TYPE_CALL = 0;
export const SERIES_OPTION_TYPE_PUT = 1;
export const SERIES_EXERCISE_STYLE_EUROPEAN = 0;
export const SERIES_EXERCISE_STYLE_AMERICAN = 1;

// === Phase 2 Stage B — VolOracle seed (per-feed ring buffer) ===
// MUST match `VOL_ORACLE_SEED` in programs/opta/src/state/vol_oracle.rs.
// PDA derivation: [VOL_ORACLE_SEED, feed_id] -> oracle PDA.
export const VOL_ORACLE_SEED = "vol_oracle";

// Feature flag: when true, UI uses v2 shared vault flows.
// When false, UI uses v1 isolated escrow flows.
export const USE_V2_VAULTS = true;

// ============================================================================
// Phase 2 — American options UI gate (Stage H / Stage I pair-flip)
// ============================================================================
// Gates every user-facing American affordance in the frontend: the Write
// EUR/AMER toggle's American button (disabled + "coming soon" while false)
// and the Portfolio early-exercise button. Ships FALSE in Stage H — the
// American surface is dark-launched (built + build-verified, unreachable in
// production) so Stage I is a flag-flip + audit only.
//
// ⚠️ STAGE I PAIR-FLIP — flip this AND the Rust `AMERICAN_ENABLED` default
// (programs/opta/src/utils/feature_flags.rs: not(feature) → true, then deploy
// FEATURE-FREE) TOGETHER. Never ship `true` here before Stage I: a true UI
// flag against a false on-chain flag sends American creates that revert 6052
// (AmericanVaultsDisabled). The two flags are a matched set.
export const AMERICAN_ENABLED_UI = true;

// ============================================================================
// Exchange Trade-page arc — v2 GRID/CHART UI gate (Trade-page spec T1)
// ============================================================================
// Gates the whole new exchange Trade page (unified series+legacy chain, order
// ticket, chart). The entire arc (Passes 1–5) develops behind this flag:
// when false, TradePage renders the current production page byte-identically;
// when true, it renders the new TradePageV2. Flip to true at Pass 5, once the
// page is complete — prevents Vercel (auto-deploys main) shipping a half-built
// page mid-arc. Mirrors the AMERICAN_ENABLED_UI dark-launch pattern.
export const TRADE_V2_UI = false;

// ============================================================================
// Phase 2 demo cutoff
// ============================================================================
// Hide vaults created before the Phase 2 redeploy (2026-04-26 ~18:00 UTC).
// Pre-Phase-2 vaults have BUTTER-prefixed Token-2022 metadata names; new vaults
// from this point forward use OPTA-. Filtering at the source in useVaults keeps
// the demo brand-consistent. Old vaults remain on-chain but are invisible to the UI.
export const PHASE2_CUTOFF_TIMESTAMP = 1777226400; // 2026-04-26T18:00:00Z

/** Returns true if a SharedVault account was created at or after the Phase 2 cutoff. */
export function isPostPhase2Vault(vault: { account: any } | { createdAt: any }): boolean {
  const createdAt = (vault as any)?.account?.createdAt ?? (vault as any)?.createdAt;
  if (createdAt == null) return false;
  const ts = typeof createdAt === "number" ? createdAt : createdAt.toNumber();
  return ts >= PHASE2_CUTOFF_TIMESTAMP;
}

// ============================================================================
// ⚠️  CRITICAL — FULL PRIVATE KEY, DO NOT SHIP TO MAINNET
// ============================================================================
// This is a complete 64-byte secret key (32-byte seed + 32-byte public key).
// Anyone who reads the public repo on GitHub or downloads the Vercel bundle
// controls this wallet. On devnet that wallet holds faucet USDC with zero
// monetary value — purely for "Get devnet USDC" demo convenience.
//
// If this constant survives into a mainnet build, any wallet funded with
// this seed with real assets is drained by automated key-scanners within seconds.
//
// Before any mainnet build:
//   [ ] Delete this constant entirely.
//   [ ] Delete its only caller in app/src/components/Header.tsx
//       (the handleUsdcFaucet function and its "Get devnet USDC" button).
// ============================================================================
export const DEVNET_FAUCET_KEYPAIR = Uint8Array.from([
  190, 228, 179, 16, 84, 86, 220, 167, 58, 26, 230, 109, 55, 214, 31, 68,
  44, 125, 100, 199, 2, 66, 159, 161, 128, 189, 95, 122, 246, 177, 174, 144,
  179, 209, 250, 69, 129, 154, 48, 172, 136, 163, 58, 36, 243, 181, 200, 211,
  13, 245, 237, 45, 41, 30, 221, 12, 131, 243, 51, 64, 92, 218, 20, 129,
]);

// Mock USDC mint used for devnet testing — NOT Circle's real USDC.
// Real mainnet USDC is at EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v.
// Mainnet builds must swap this constant before shipping.
export const DEVNET_USDC_MINT = new PublicKey("AytU5HUQRew9VdUdrzQuZvZ7s14pHLiYjAF5WqdK3oxL");

// Transfer hook PDA helpers
export function deriveExtraAccountMetaListPda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("extra-account-metas"), mint.toBuffer()],
    TRANSFER_HOOK_PROGRAM_ID,
  );
}

export function deriveHookStatePda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("hook-state"), mint.toBuffer()],
    TRANSFER_HOOK_PROGRAM_ID,
  );
}
