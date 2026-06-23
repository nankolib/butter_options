// =============================================================================
// events.rs — On-chain events emitted by Opta
// =============================================================================

use anchor_lang::prelude::*;

#[event]
pub struct OptionWritten {
    pub market: Pubkey,
    pub writer: Pubkey,
    pub position: Pubkey,
    pub option_mint: Pubkey,
    pub premium: u64,
    pub collateral: u64,
    pub contract_size: u64,
}

#[event]
pub struct OptionPurchased {
    pub market: Pubkey,
    pub position: Pubkey,
    pub buyer: Pubkey,
    pub premium: u64,
    pub fee: u64,
}

#[event]
pub struct OptionExercised {
    pub position: Pubkey,
    pub exerciser: Pubkey,
    pub settlement_price: u64,
    pub pnl: u64,
    pub tokens_burned: u64,
    pub profitable: bool,
}

#[event]
pub struct OptionExpired {
    pub position: Pubkey,
}

#[event]
pub struct OptionCancelled {
    pub position: Pubkey,
}

#[event]
pub struct MarketSettled {
    pub market: Pubkey,
    pub settlement_price: u64,
}

#[event]
pub struct OptionListedForResale {
    pub position: Pubkey,
    pub seller: Pubkey,
    pub resale_premium: u64,
}

#[event]
pub struct OptionResold {
    pub position: Pubkey,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub resale_premium: u64,
    pub fee: u64,
}

#[event]
pub struct ResaleCancelled {
    pub position: Pubkey,
    pub seller: Pubkey,
}

// =============================================================================
// Shared Vault events (v2 liquidity system)
// =============================================================================

#[event]
pub struct VaultCreated {
    pub vault: Pubkey,
    pub market: Pubkey,
    pub vault_type: u8,
    pub strike_price: u64,
    pub expiry: i64,
    pub option_type: u8,
    pub creator: Pubkey,
}

#[event]
pub struct VaultDeposited {
    pub vault: Pubkey,
    pub writer: Pubkey,
    pub amount: u64,
    pub shares: u64,
    pub total_collateral: u64,
}

#[event]
pub struct VaultMinted {
    pub vault: Pubkey,
    pub writer: Pubkey,
    pub mint: Pubkey,
    pub quantity: u64,
    pub premium_per_contract: u64,
}

#[event]
pub struct VaultPurchased {
    pub vault: Pubkey,
    pub buyer: Pubkey,
    pub mint: Pubkey,
    pub quantity: u64,
    pub total_premium: u64,
}

#[event]
pub struct VaultBurnUnsold {
    pub vault: Pubkey,
    pub writer: Pubkey,
    pub mint: Pubkey,
    pub burned: u64,
}

#[event]
pub struct VaultWithdrawn {
    pub vault: Pubkey,
    pub writer: Pubkey,
    pub amount: u64,
    pub shares: u64,
}

#[event]
pub struct PremiumClaimed {
    pub vault: Pubkey,
    pub writer: Pubkey,
    pub amount: u64,
}

#[event]
pub struct VaultSettled {
    pub vault: Pubkey,
    pub settlement_price: u64,
    pub total_payout: u64,
    pub collateral_remaining: u64,
}

#[event]
pub struct VaultExercised {
    pub vault: Pubkey,
    pub holder: Pubkey,
    pub quantity: u64,
    pub payout: u64,
}

#[event]
pub struct VaultPostSettlementWithdraw {
    pub vault: Pubkey,
    pub writer: Pubkey,
    pub amount: u64,
}

/// Phase 2 Pass D — emitted once per writer reclaim through the dead-feed hatch
/// (`reclaim_unsettled`). Distinct from VaultPostSettlementWithdraw (which has
/// the same field shape) so off-chain indexers can tell a hatch wind-down apart
/// from an ordinary post-settlement withdrawal: a VaultReclaimed stream means
/// the vault was voided (holders paid nothing), never settled.
#[event]
pub struct VaultReclaimed {
    pub vault: Pubkey,
    pub writer: Pubkey,
    pub amount: u64,
}

#[event]
pub struct HoldersFinalized {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub holders_processed: u32,
    pub total_burned: u64,
    pub total_paid_out: u64,
}

#[event]
pub struct WritersFinalized {
    pub vault: Pubkey,
    pub writers_processed: u32,
    pub total_paid_out: u64,
    /// Non-zero only when this batch contained the last writer; otherwise 0.
    pub dust_swept_to_treasury: u64,
}

// =============================================================================
// V2 secondary listing events
// =============================================================================

#[event]
pub struct VaultListingCreated {
    pub listing: Pubkey,
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub seller: Pubkey,
    pub listed_quantity: u64,
    pub price_per_contract: u64,
    pub created_at: i64,
}

#[event]
pub struct VaultListingFilled {
    pub listing: Pubkey,
    pub mint: Pubkey,
    pub seller: Pubkey,
    pub buyer: Pubkey,
    pub quantity: u64,
    pub total_price: u64,
    pub fee: u64,
    pub listing_remaining: u64,
    pub listing_closed: bool,
}

#[event]
pub struct VaultListingCancelled {
    pub listing: Pubkey,
    pub mint: Pubkey,
    pub seller: Pubkey,
    pub returned_quantity: u64,
}

#[event]
pub struct VaultListingsAutoCancelled {
    pub vault: Pubkey,
    pub mint: Pubkey,
    pub listings_cancelled: u32,
    pub tokens_returned: u64,
}

// =============================================================================
// Exchange book events (Phase 1 — RestingOrder limit book)
// =============================================================================
//
// `kind` encodes OrderKind as a u8 (Bid = 0, ResaleAsk = 1, WriterAsk = 2,
// VaultPeg = 3), matching the house convention of emitting enum fields as u8
// (see VaultCreated.vault_type / option_type). `OrderFilled` is the trade tape —
// the future indexer builds candles from it. `amount_returned` on Cancel /
// Swept is in the escrowed asset's units: contracts for asks, micro-USDC for
// bids.
//
// VaultPeg fills (kind = 3, emitted by fill_vault_peg — Phase 2 Pass B) reuse
// this tape with a pegless convention (no RestingOrder exists):
//   - `order`  = the series VaultMint record PDA (the standing ask itself).
//   - `maker`  = the SharedVault PDA. NOTE: a PDA, not a wallet — indexers must
//                not assume `maker` is an owner key on VaultPeg rows.
//   - `quantity_remaining` = post-fill peg DEPTH = floor(free_collateral / cpt),
//                the live capacity in contracts (not a per-order remainder).
//   - `price_per_contract` = the spread-applied model premium charged.

#[event]
pub struct OrderPosted {
    pub order: Pubkey,
    pub owner: Pubkey,
    pub option_mint: Pubkey,
    pub vault: Pubkey,
    pub kind: u8,
    pub price_per_contract: u64,
    pub quantity: u64,
    pub nonce: u64,
    pub ts: i64,
}

#[event]
pub struct OrderFilled {
    pub order: Pubkey,
    pub option_mint: Pubkey,
    pub vault: Pubkey,
    pub kind: u8,
    pub maker: Pubkey,
    pub taker: Pubkey,
    pub price_per_contract: u64,
    pub fill_quantity: u64,
    pub fee: u64,
    pub quantity_remaining: u64,
    pub ts: i64,
}

#[event]
pub struct OrderCancelled {
    pub order: Pubkey,
    pub owner: Pubkey,
    pub option_mint: Pubkey,
    pub kind: u8,
    pub amount_returned: u64,
    pub ts: i64,
}

#[event]
pub struct OrderSwept {
    pub order: Pubkey,
    pub owner: Pubkey,
    pub option_mint: Pubkey,
    pub kind: u8,
    pub amount_returned: u64,
    pub ts: i64,
}

// =============================================================================
// Exchange series events (Phase 2 Pass A — canonical per-spec series mint)
// =============================================================================
//
// `option_type` / `exercise_style` are emitted as u8 (house convention for
// enum fields). `vault` is the DERIVED American vault PDA the series belongs to
// (the vault account need not exist at create_series time).

#[event]
pub struct SeriesCreated {
    pub option_mint: Pubkey,
    pub market: Pubkey,
    pub vault: Pubkey,
    pub strike: u64,
    pub expiry: i64,
    pub option_type: u8,
    pub exercise_style: u8,
    pub ts: i64,
}

// =============================================================================
// Trigger order events (Phase 4 — TP/SL + stop-entry)
// =============================================================================
//
// `kind` / `comparator` are emitted as u8 (house convention for enum fields):
// kind   → StopEntryBuy = 0, TakeProfitSell = 1
// cmp    → LessOrEqual = 0, GreaterOrEqual = 1

#[event]
pub struct TriggerPlaced {
    pub trigger_order: Pubkey,
    pub owner: Pubkey,
    pub option_mint: Pubkey,
    pub vault: Pubkey,
    pub kind: u8,
    pub comparator: u8,
    pub threshold_usdc: u64,
    pub quantity: u64,
}

#[event]
pub struct TriggerCancelled {
    pub trigger_order: Pubkey,
    pub owner: Pubkey,
}

/// Emitted on a successful execute_trigger fire. `kind` is the TriggerKind u8
/// (StopEntryBuy=0, TakeProfitSell=1). `fire_quantity` is the contracts bought
/// (BUY, always == quantity) or burned (SELL, = min(quantity, balance)).
/// `premium_or_payout` is the gross USDC paid in (BUY) / capped intrinsic paid
/// out (SELL). `remaining_quantity` is 0 for a BUY (closed) or the SELL order's
/// leftover after a partial fire (0 ⇒ the order was closed).
#[event]
pub struct TriggerExecuted {
    pub trigger_order: Pubkey,
    pub owner: Pubkey,
    pub kind: u8,
    pub fire_quantity: u64,
    pub ema_used: u64,
    pub premium_or_payout: u64,
    pub remaining_quantity: u64,
    pub ts: i64,
}

/// Emitted when a SELL trigger's condition + EMA passed but the source ATA holds
/// zero (the holder moved everything out). A benign no-op: the order STAYS OPEN,
/// nothing reverts. `reason` 0 = zero source balance.
#[event]
pub struct TriggerSkipped {
    pub trigger_order: Pubkey,
    pub owner: Pubkey,
    pub reason: u8,
    pub ts: i64,
}
