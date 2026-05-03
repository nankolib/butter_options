// =============================================================================
// writerRows.ts — Writer-side row builder. Pure functions, no React.
// =============================================================================
//
// Mirrors positions.ts structurally but produces writer rows instead of
// buyer rows. Each WriterPosition account in `myPositions` becomes one
// WriterRow output (or is filtered out if its parent vault isn't in
// `vaults`, or if shares == 0).
//
// Why a separate file instead of extending positions.ts:
//   - Different inputs: filter is `WriterPosition.owner === wallet`, not
//     a token-account balance lookup.
//   - Different math: claimable premium uses the reward-per-share
//     accumulator (delegated to useVaults().getUnclaimedPremium), not
//     Black-Scholes.
//   - Different action set: claim-premium / withdraw-collateral / settling.
//   - Different state machine: live / expired-pending / settled-itm /
//     settled-otm — no buyer "active" notion driven by B-S valuation.
//
// Premium model is Model B: buyers pay premium to the vault at trade
// time (not at expiry). As a writer's vault sells contracts to buyers,
// their share of `premium_per_share_cumulative` ticks up and becomes
// claimable via claim_premium. The "Premium Realized" cell on the
// WriterSummaryBand reflects what's already been claimed
// (premium_claimed); the "Claimable Premium" cell reflects the
// not-yet-claimed delta. After an action D5b refetches both.
//
// Cross-references:
//   - WriterPosition Rust state: programs/opta/src/state/writer_position.rs
//   - SharedVault Rust state: programs/opta/src/state/shared_vault.rs
//   - claim_premium handler: programs/opta/src/instructions/claim_premium.rs
//   - withdraw_post_settlement (auto-claims premium internally per
//     April 12 audit HIGH-01 fix):
//     programs/opta/src/instructions/withdraw_post_settlement.rs
//   - getUnclaimedPremium implementation: app/src/hooks/useVaults.ts:135
// =============================================================================

import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { usdcToNumber } from "../../utils/format";

// ----------------------------------------------------------------------------
// Public types
// ----------------------------------------------------------------------------

export type WriterRowState =
  | "live"
  | "expired-pending"
  | "settled-itm"
  | "settled-otm";

export type WriterRowPrimaryAction =
  | "claim-premium"
  | "withdraw-collateral"
  | "settling";

/**
 * Wider action discriminator emitted by WriterPositionsTable on click —
 * burn-unsold is a secondary affordance gated on row.showBurnUnsold,
 * so it isn't part of the row's "primary" action set but the table
 * still needs to emit it. Lives in this module (mirroring how
 * positions.ts owns PositionAction for the buyer side) so PortfolioPage
 * imports its dispatcher type from the data module, not from a UI
 * component.
 */
export type WriterRowAction = WriterRowPrimaryAction | "burn-unsold";

export type WriterRow = {
  /** Stable id — WriterPosition PDA base58. Unique per (writer, vault). */
  id: string;
  /** Vault PDA. Used for Solscan link target and action-handler account-meta. */
  vaultPda: PublicKey;
  /** Asset ticker, e.g. "SOL". "?" if marketMap lookup fails. */
  asset: string;
  side: "call" | "put";
  strike: number;
  /** Unix seconds. */
  expiry: number;
  state: WriterRowState;
  /**
   * USDC, from writerPosition.deposited_collateral. The Rust comment notes
   * shares is the authoritative value; deposited_collateral is the
   * dollar-amount snapshot the writer originally posted, kept for display.
   */
  collateralDeposited: number;
  optionsMinted: number;
  optionsSold: number;
  /**
   * BN of micro-USDC. Live computation via useVaults().getUnclaimedPremium.
   * Kept as BN (not pre-converted to number) so the WriterSummaryBand can
   * sum across rows without intermediate rounding. Display layer divides
   * by 1e6 at render time.
   */
  claimableUsdc: BN;
  /** USDC, from writerPosition.premium_claimed. Drives the "Premium Realized" cell. */
  premiumClaimed: number;
  /** Settlement price (USDC) if vault is settled, else null. */
  settlementPrice: number | null;
  /** Per-contract intrinsic at settlement. 0 for live/pending and OTM. */
  payoutPerContract: number;
  primaryAction: WriterRowPrimaryAction;
  /** True iff D6 burn-unsold gate is met (past expiry + unsold count > 0 + VaultMint exists). */
  showBurnUnsold: boolean;
  /** options_minted - options_sold. Only meaningful when showBurnUnsold is true. */
  unsoldCount: number;
};

// ----------------------------------------------------------------------------
// Internal types
// ----------------------------------------------------------------------------

interface AccountWrapper {
  publicKey: PublicKey;
  account: any;
}

type GetUnclaimedPremium = (vaultBody: any, positionBody: any) => BN;

export type BuildWriterRowsArgs = {
  /** Pre-filtered to owner === connected wallet. From useVaults().myPositions. */
  myPositions: AccountWrapper[];
  /** All SharedVaults. From useVaults().vaults. */
  vaults: AccountWrapper[];
  /**
   * All VaultMint records. Used to surface unsold-escrow count for D6 —
   * a writer's unsold inventory lives in a (vault, writer)-keyed VaultMint.
   */
  vaultMints: AccountWrapper[];
  /** Pubkey base58 → OptionsMarket account body (for asset name lookup). */
  marketMap: Map<string, any>;
  /**
   * Premium accrual math. Same instance the rest of the page uses, passed
   * in (rather than imported) so this module stays React-free and
   * trivially testable. Caller supplies useVaults().getUnclaimedPremium.
   */
  getUnclaimedPremium: GetUnclaimedPremium;
  /** Optional clock override for tests. Defaults to floor(Date.now() / 1000). */
  nowSeconds?: number;
};

// ----------------------------------------------------------------------------
// Public builder
// ----------------------------------------------------------------------------

export function buildWriterRows(args: BuildWriterRowsArgs): WriterRow[] {
  const { myPositions, vaults, vaultMints, marketMap, getUnclaimedPremium } = args;
  const now = args.nowSeconds ?? Math.floor(Date.now() / 1000);

  // Index vaults by base58 PDA for O(1) join from each WriterPosition.vault.
  const vaultByKey = new Map<string, AccountWrapper>();
  for (const v of vaults) vaultByKey.set(v.publicKey.toBase58(), v);

  // Index VaultMint by (vault, writer) base58 pair. mint_from_vault enforces
  // at most one VaultMint per (vault, writer), so this collapses cleanly.
  // If that invariant ever changes the D6 gate would still be correct
  // (we'd just see the first-found mint) but unsoldCount could underreport
  // — flag in tests if mint_from_vault.rs ever loosens.
  const mintByVaultWriter = new Map<string, AccountWrapper>();
  for (const vm of vaultMints) {
    const vaultKey = (vm.account.vault as PublicKey).toBase58();
    const writerKey = (vm.account.writer as PublicKey).toBase58();
    mintByVaultWriter.set(`${vaultKey}|${writerKey}`, vm);
  }

  const result: WriterRow[] = [];

  for (const wp of myPositions) {
    const wpAcct = wp.account;

    // Defensive: a closed WriterPosition shouldn't appear in myPositions
    // (Anchor closes the account on withdraw_post_settlement), but if a
    // stale fetch leaks one through with shares == 0, skip it. Ditto for
    // any writerPosition whose vault was filtered by useVaults' Phase-2
    // cascade — its parent vault won't be in vaultByKey.
    const sharesNum = asNumber(wpAcct.shares);
    if (sharesNum === 0) continue;

    const vaultKey = (wpAcct.vault as PublicKey).toBase58();
    const vault = vaultByKey.get(vaultKey);
    if (!vault) continue;

    const v = vault.account;

    // ---- identity ----
    // OptionType is an Anchor enum; positions.ts uses the same `"call" in
    // v.optionType` shape check, which works whether the decoder gave us
    // { call: {} } or { put: {} }.
    const isCall = "call" in v.optionType;
    const strike = usdcToNumber(v.strikePrice);
    const expiry = asNumber(v.expiry);
    const market = marketMap.get((v.market as PublicKey).toBase58()) ?? null;
    const asset: string = ((market?.assetName as string) || "").trim() || "?";

    // ---- state machine (D3) ----
    //   LIVE              : !is_settled && now < expiry
    //   EXPIRED · PENDING : !is_settled && now >= expiry
    //                       (settle_vault crank hasn't run yet OR the
    //                       Pyth update for this expiry hasn't been posted)
    //   SETTLED · ITM     : is_settled && payoutPerContract > 0
    //   SETTLED · OTM     : is_settled && payoutPerContract == 0
    //
    // Note: payoutPerContract is computed against the on-chain
    // settlement_price snapshot, NOT against the live spot price. Once
    // is_settled flips, settlement_price is frozen and authoritative.
    const isSettled = !!v.isSettled;
    const isPastExpiry = expiry <= now;
    const settlementPrice = isSettled ? usdcToNumber(v.settlementPrice) : null;

    let payoutPerContract = 0;
    if (isSettled && settlementPrice !== null) {
      payoutPerContract = isCall
        ? Math.max(0, settlementPrice - strike)
        : Math.max(0, strike - settlementPrice);
    }

    let state: WriterRowState;
    if (isSettled) {
      state = payoutPerContract > 0 ? "settled-itm" : "settled-otm";
    } else if (isPastExpiry) {
      state = "expired-pending";
    } else {
      state = "live";
    }

    // ---- writer-position numeric fields ----
    const collateralDeposited = usdcToNumber(wpAcct.depositedCollateral);
    const optionsMinted = asNumber(wpAcct.optionsMinted);
    const optionsSold = asNumber(wpAcct.optionsSold);
    const premiumClaimed = usdcToNumber(wpAcct.premiumClaimed);

    // Claimable premium math is delegated to useVaults().getUnclaimedPremium
    // which mirrors claim_premium.rs exactly:
    //   total_earned       = shares * cumulative / SCALE   (SCALE = 1e12)
    //   earned_since_dep   = max(total_earned - debt, 0)
    //   claimable          = max(earned_since_deposit - claimed, 0)
    // BN return preserves micro-USDC precision when summing across rows
    // for the "Claimable Premium" summary cell.
    let claimableUsdc: BN;
    try {
      claimableUsdc = getUnclaimedPremium(v, wpAcct);
    } catch {
      // Defensive: a malformed BN field on a stale account shouldn't crash
      // the page. Default to 0; the row still renders, just with no
      // actionable claim.
      claimableUsdc = new BN(0);
    }

    // ---- D6 burn-unsold gate ----
    // Show a small secondary "Burn unsold" link only when:
    //   1. Vault is past expiry (whether or not crank has settled it yet).
    //      Per memory feedback_burn_unsold_sequence.md, the cleanup window
    //      is BEFORE auto-finalize closes the WriterPosition — surfacing
    //      this for live vaults would be premature (the writer might still
    //      sell more contracts before expiry).
    //   2. options_minted > options_sold (writer has unsold escrow).
    //   3. The (vault, writer) VaultMint record exists. After auto-finalize
    //      the VaultMint may also be cleaned up; if it's gone, hide the
    //      link (the burn IX requires it as input).
    const unsoldCount = Math.max(0, optionsMinted - optionsSold);
    const ownerKey = (wpAcct.owner as PublicKey).toBase58();
    const ownVaultMint = mintByVaultWriter.get(`${vaultKey}|${ownerKey}`);
    const showBurnUnsold = isPastExpiry && unsoldCount > 0 && !!ownVaultMint;

    // ---- primary action per D4 ----
    // Single primary button per row. LIVE state's button is disabled if
    // claimable == 0 — the Section/Table layer reads claimableUsdc to
    // make that determination, not this builder.
    let primaryAction: WriterRowPrimaryAction;
    switch (state) {
      case "live":
        primaryAction = "claim-premium";
        break;
      case "expired-pending":
        primaryAction = "settling";
        break;
      case "settled-itm":
      case "settled-otm":
        primaryAction = "withdraw-collateral";
        break;
    }

    result.push({
      id: wp.publicKey.toBase58(),
      vaultPda: vault.publicKey,
      asset,
      side: isCall ? "call" : "put",
      strike,
      expiry,
      state,
      collateralDeposited,
      optionsMinted,
      optionsSold,
      claimableUsdc,
      premiumClaimed,
      settlementPrice,
      payoutPerContract,
      primaryAction,
      showBurnUnsold,
      unsoldCount,
    });
  }

  return result;
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

/**
 * Anchor decodes u64/i64 fields as BN by default but already-shrunk values
 * sometimes arrive as plain numbers. Mirrors positions.ts:152's pattern
 * (`typeof v.expiry === "number" ? v.expiry : v.expiry.toNumber()`).
 */
function asNumber(v: any): number {
  if (typeof v === "number") return v;
  if (v && typeof v.toNumber === "function") return v.toNumber();
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
