// =============================================================================
// allowlist.ts — EXPLICIT event allowlist + field mapping. HAND-WRITTEN.
// =============================================================================
//
// DO NOT SCAFFOLD THIS FROM THE IDL.
//
// The IDL declares 38 events. Nine of them are v1-era corpses with ZERO `emit!`
// call sites anywhere in the program — they ship in the IDL and will silently
// never fire. An IDL-driven indexer registers handlers for them and under-counts
// forever. They are listed in DEAD_DO_NOT_HANDLE below so nobody re-adds them.
//
// Verified against programs/opta/src/events.rs + every emit! site, 2026-07-25.
// =============================================================================

/** OrderKind, emitted as u8 (see events.rs "Exchange book events" header). */
export const ORDER_KIND = {
  Bid: 0,
  ResaleAsk: 1,
  WriterAsk: 2,
  VaultPeg: 3,
} as const;

/**
 * Nine IDL events with no emit! site anywhere in programs/opta/src.
 * Declared at events.rs:7-73. Handling any of these is a bug.
 */
export const DEAD_DO_NOT_HANDLE: readonly string[] = [
  "OptionWritten",
  "OptionPurchased",
  "OptionExercised",
  "OptionExpired",
  "OptionCancelled",
  "MarketSettled", // ← the trap: looks like it covers settle_expiry. It does not.
  "OptionListedForResale",
  "OptionResold",
  "ResaleCancelled",
];

/** How one decoded event's fields map onto the tape's normalized columns. */
export interface FieldMap {
  /** Field holding the acting wallet. null → aggregate event, wallet stays NULL. */
  wallet: string | null;
  /** Field holding the counterparty (OrderFilled maker when wallet = taker). */
  counterparty?: string;
  vault?: string;
  optionMint?: string;
  kind?: string;
  /** Single field carrying a micro-USDC amount. */
  amountUsdc?: string;
  /** Or: a product of two fields (price_per_contract x quantity). */
  amountUsdcProduct?: [string, string];
  quantity?: string;
}

export const ALLOWLIST: Record<string, FieldMap> = {
  // ---- Exchange book -------------------------------------------------------
  OrderFilled: {
    wallet: "taker",
    counterparty: "maker", // ⚠ a PDA when kind == VaultPeg — see rules_v1 D3 guard
    vault: "vault",
    optionMint: "option_mint",
    kind: "kind",
    amountUsdcProduct: ["price_per_contract", "fill_quantity"],
    quantity: "fill_quantity",
  },
  OrderPosted: {
    wallet: "owner",
    vault: "vault",
    optionMint: "option_mint",
    kind: "kind",
    amountUsdcProduct: ["price_per_contract", "quantity"],
    quantity: "quantity",
  },
  OrderCancelled: {
    wallet: "owner",
    optionMint: "option_mint",
    kind: "kind",
    amountUsdc: "amount_returned",
  },
  OrderSwept: {
    wallet: "owner",
    optionMint: "option_mint",
    kind: "kind",
    amountUsdc: "amount_returned",
  },

  // ---- Vault lifecycle -----------------------------------------------------
  VaultPurchased: {
    wallet: "buyer",
    vault: "vault",
    optionMint: "mint",
    amountUsdc: "total_premium",
    quantity: "quantity",
  },
  VaultMinted: {
    wallet: "writer",
    vault: "vault",
    optionMint: "mint",
    amountUsdcProduct: ["premium_per_contract", "quantity"],
    quantity: "quantity",
  },
  VaultDeposited: { wallet: "writer", vault: "vault", amountUsdc: "amount", quantity: "shares" },
  VaultWithdrawn: { wallet: "writer", vault: "vault", amountUsdc: "amount", quantity: "shares" },
  VaultExercised: {
    wallet: "holder",
    vault: "vault",
    amountUsdc: "payout",
    quantity: "quantity",
  },
  PremiumClaimed: { wallet: "writer", vault: "vault", amountUsdc: "amount" },
  VaultReclaimed: { wallet: "writer", vault: "vault", amountUsdc: "amount" },
  /// Phase 2a: the MAIN writer settlement payout path. PnL cannot reconcile
  /// without it — its absence in Phase 1 was the reason for the v2 tape rebuild.
  VaultPostSettlementWithdraw: { wallet: "writer", vault: "vault", amountUsdc: "amount" },
  VaultBurnUnsold: { wallet: "writer", vault: "vault", optionMint: "mint", quantity: "burned" },
  WriterAskResidualWithdrawn: {
    wallet: "backer",
    vault: "vault",
    optionMint: "option_mint",
    amountUsdc: "payout",
    quantity: "equiv_shares",
  },

  // ---- Aggregate / vault-scoped (no acting wallet) -------------------------
  VaultSettled: { wallet: null, vault: "vault", amountUsdc: "total_payout" },
  VaultVoidInitialized: { wallet: null, vault: "vault", amountUsdc: "collateral_remaining" },
  HoldersFinalized: {
    wallet: null,
    vault: "vault",
    optionMint: "mint",
    amountUsdc: "total_paid_out",
    quantity: "total_burned",
  },
  WritersFinalized: { wallet: null, vault: "vault", amountUsdc: "total_paid_out" },
  SeriesCreated: { wallet: null, vault: "vault", optionMint: "option_mint" },
  /// Phase 2a: vault -> market edge. Needed to resolve a fill's UNDERLYING for
  /// quest W3 (SeriesCreated only covers American canonical series).
  /// `creator` is a real wallet (the vault opener), so it is scored as the actor.
  VaultCreated: { wallet: "creator", vault: "vault", amountUsdc: "strike_price" },
  /// Phase 2a: treasury dust — a term in the conservation residual.
  SettledWriterAskVaultClosed: { wallet: null, vault: "vault", amountUsdc: "dust_swept" },
  /// Phase 2a: escrowed contracts returned to sellers on auto-cancel.
  VaultListingsAutoCancelled: {
    wallet: null,
    vault: "vault",
    optionMint: "mint",
    quantity: "tokens_returned",
  },

  // ---- V2 secondary listings ----------------------------------------------
  VaultListingCreated: {
    wallet: "seller",
    vault: "vault",
    optionMint: "mint",
    amountUsdc: "price_per_contract",
    quantity: "listed_quantity",
  },
  VaultListingFilled: {
    wallet: "buyer",
    counterparty: "seller",
    optionMint: "mint",
    amountUsdc: "total_price",
    quantity: "quantity",
  },
  VaultListingCancelled: {
    wallet: "seller",
    optionMint: "mint",
    quantity: "returned_quantity",
  },

  // ---- Triggers ------------------------------------------------------------
  TriggerPlaced: {
    wallet: "owner",
    vault: "vault",
    optionMint: "option_mint",
    kind: "kind",
    amountUsdc: "threshold_usdc",
    quantity: "quantity",
  },
  TriggerCancelled: { wallet: "owner" },
  TriggerExecuted: {
    wallet: "owner",
    kind: "kind",
    amountUsdc: "premium_or_payout",
    quantity: "fire_quantity",
  },
  TriggerSkipped: { wallet: "owner" },
};

export const ALLOWED_NAMES: readonly string[] = Object.keys(ALLOWLIST);
