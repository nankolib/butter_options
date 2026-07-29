// =============================================================================
// state/trigger_order.rs — A single durable trigger (TP/SL sell + stop-entry buy)
// =============================================================================
//
// Phase 4 of the Opta Exchange (trigger-order spec v1). Solana programs are
// passive — a program cannot watch a price and self-fire. A trigger is a
// three-part system: (1) PLACEMENT writes this durable PDA encoding the
// condition + action + resources; (2) an off-chain KEEPER watches live Pyth
// prices and calls execute_trigger when the condition crosses; (3) on-chain
// RE-VALIDATION re-reads a fresh Pyth EMA inside execute_trigger and re-checks
// the condition itself before acting (the keeper's assertion is never trusted).
//
// This PDA doubles as the keeper's index: there is no on-chain holder-position
// account, so the trigger orders themselves are what the keeper enumerates.
//
// Pass 0 (this file): the account + 2 enums + seed consts + place/cancel only.
// execute_trigger + the vault/exercise fire paths are Pass 1.
//
// PDA seeds:
//   TriggerOrder  : ["trigger_order", owner, option_mint, nonce_le_bytes]
//   trigger escrow: ["trigger_escrow", trigger_order]   (BUY only; classic USDC
//                    token account, owner = protocol_state)
//
// The `nonce` is client-supplied; PDA `init` enforces uniqueness, so multiple
// triggers per (owner, mint) are first-class — a collision just means the client
// retries with a fresh nonce. Mirrors the RestingOrder convention.
// =============================================================================

use anchor_lang::prelude::*;

/// What the trigger does when it fires.
///
/// **Variant order is load-bearing** — the Borsh discriminator is a single byte
/// encoding the variant index (StopEntryBuy = 0, TakeProfitSell = 1,
/// StopLossSell = 2). Append new variants only; never reorder.
///
/// Phase B routes fires through the BOOK (per-ask WriterAsk escrows + Bids),
/// where the live liquidity now sits — the pooled-vault peg/exercise paths are
/// structurally dead (≈zero pooled collateral board-wide). StopLossSell is the
/// variant added here (B0): a true stop-loss sells an OTM long, which the vault
/// cannot buy back (exercise reverts OTM), so it can ONLY route to the book bid
/// side. It is appended now (migration-free: 0 live TriggerOrders) and stays
/// DARK until B2 wires the sell path to `bid_fill_core`.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum TriggerKind {
    /// Stop-entry buy: when the underlying crosses the threshold, take-buy the
    /// book ask side (B1) — v1 filled the vault peg. USDC is escrowed at placement.
    StopEntryBuy,
    /// Take-profit sell: when the underlying crosses the threshold, sell the
    /// owner's ITM long. v1 exercised against the vault (capped intrinsic,
    /// delegate-burn); B2 routes it to the book bid side. Nothing is escrowed.
    TakeProfitSell,
    /// Stop-loss sell: when the underlying crosses the threshold, sell the
    /// owner's long into the book bid side (B2) — no vault path exists (an OTM
    /// long can't be exercised). Delegate-transfers at fire; nothing is escrowed.
    /// DARK until B2.
    StopLossSell,
}

impl TriggerKind {
    /// Stable u8 encoding for events (StopEntryBuy = 0, TakeProfitSell = 1,
    /// StopLossSell = 2), matching the Borsh discriminator and the house
    /// convention of emitting enum fields as u8 (see events.rs / OrderKind::as_u8).
    pub fn as_u8(self) -> u8 {
        match self {
            TriggerKind::StopEntryBuy => 0,
            TriggerKind::TakeProfitSell => 1,
            TriggerKind::StopLossSell => 2,
        }
    }
}

/// The comparator the live EMA must satisfy against `threshold_usdc` at fire
/// time. Direction is EXPLICIT and stored — no implicit "stop vs limit"
/// inference (spec R4).
///
/// **Variant order is load-bearing** (LessOrEqual = 0, GreaterOrEqual = 1).
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum Comparator {
    /// Fires when `live_ema <= threshold_usdc`.
    LessOrEqual,
    /// Fires when `live_ema >= threshold_usdc`.
    GreaterOrEqual,
}

impl Comparator {
    /// Stable u8 encoding for events (LessOrEqual = 0, GreaterOrEqual = 1).
    pub fn as_u8(self) -> u8 {
        match self {
            Comparator::LessOrEqual => 0,
            Comparator::GreaterOrEqual => 1,
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct TriggerOrder {
    /// Wallet that placed the trigger. Receives proceeds/refund + rent on close.
    pub owner: Pubkey,

    /// The OptionsMarket the option series belongs to. Stored so the Pass-1
    /// execute path can read `market.pyth_feed_id` for the fresh-EMA re-check.
    pub market: Pubkey,

    /// The series option mint: the peg-buy target (BUY) or the sell-burn target
    /// (SELL). Part of the PDA seed.
    pub option_mint: Pubkey,

    /// The SharedVault: peg-fill source (BUY) / exercise-payout source (SELL).
    pub vault: Pubkey,

    /// StopEntryBuy / TakeProfitSell. See `TriggerKind`.
    pub kind: TriggerKind,

    /// The comparator the live EMA must satisfy at fire time. See `Comparator`.
    pub comparator: Comparator,

    /// Condition price, USDC 6-dec. The trigger fires when the live EMA
    /// satisfies `comparator` against this value (re-checked on-chain in P1).
    pub threshold_usdc: u64,

    /// Contracts to buy (BUY) or sell (SELL).
    pub quantity: u64,

    /// BUY: PER-CONTRACT escrow ceiling (USDC 6-dec). The escrowed figure is
    /// `max_premium * quantity`. ⚠️ UNITS: this is PER-CONTRACT; fill_vault_peg's
    /// own `max_premium` arg (P1) is a fee-inclusive TOTAL — do not conflate.
    /// SELL (B2): the mirrored constraint — the PER-CONTRACT MINIMUM-PROCEEDS
    /// FLOOR a book bid must beat before `execute_trigger` will sell into it.
    /// Same field, same units, opposite direction (buy = ceiling on what the
    /// owner pays; sell = floor on what the owner accepts). A sell still escrows
    /// nothing. 0 is legal and means BOOK INELIGIBLE — the book arm refuses it
    /// with `SellFloorRequired` (6082), so every pre-B2 sell (all stored 0) keeps
    /// exactly its old behaviour: TakeProfitSell falls back to the vault exercise
    /// path, StopLossSell stays unfireable. This field is the owner's ONLY
    /// defence on the sell side, because `execute_trigger` is permissionless and
    /// the fire-time caller therefore cannot be trusted to supply a price bound.
    pub max_premium: u64,

    /// SELL: the exact ATA to delegate-burn from at fire (P1).
    /// BUY: the owner's destination option ATA (pre-created at placement) the
    /// peg mints into at fire.
    pub holder_option_ata: Pubkey,

    /// BUY: true once USDC has been escrowed. SELL: always false.
    pub escrow_funded: bool,

    /// Unix timestamp when the trigger was placed.
    pub created_at: i64,

    /// Client-supplied uniqueness nonce. Part of the PDA seed.
    pub nonce: u64,

    /// PDA bump seed.
    pub bump: u8,

    /// OCO (one-cancels-other) link → the paired trigger's PDA, or None for a
    /// standalone trigger. Appended in B0 while the layout is migration-free
    /// (0 live TriggerOrders); wired in B3. `Option<Pubkey>` adds 1 + 32 = 33
    /// bytes to INIT_SPACE (204 → 237).
    ///
    /// B3 SEMANTICS (noted now, implemented in B3): when a trigger fires,
    /// execute_trigger MUST also decrement the linked leg's `quantity` by the
    /// fired amount in the SAME tx and close it at 0 — so a single atomic fire
    /// can never gap through both legs. A partial fire decrements both; only a
    /// fill that zeros a leg closes it (and its paired leg).
    pub oco_link: Option<Pubkey>,
}

/// Seed prefix for TriggerOrder PDAs: ["trigger_order", owner, option_mint, nonce_le].
pub const TRIGGER_ORDER_SEED: &[u8] = b"trigger_order";

/// Seed prefix for the per-trigger USDC escrow PDA (BUY only), owned by
/// protocol_state: ["trigger_escrow", trigger_order].
pub const TRIGGER_ESCROW_SEED: &[u8] = b"trigger_escrow";

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::AnchorSerialize;

    // Variant order is load-bearing — the keeper + P1 execute path decode these
    // discriminators. A reorder would silently retag every placed trigger.
    #[test]
    fn trigger_kind_discriminators_are_stable() {
        // Existing kinds' stored bytes are UNCHANGED by the StopLossSell append.
        for (kind, idx) in [
            (TriggerKind::StopEntryBuy, 0u8),
            (TriggerKind::TakeProfitSell, 1u8),
            (TriggerKind::StopLossSell, 2u8),
        ] {
            assert_eq!(kind.as_u8(), idx, "{:?} as_u8 must be {}", kind, idx);
            let mut buf = vec![];
            kind.serialize(&mut buf).unwrap();
            assert_eq!(buf, vec![idx], "{:?} must Borsh-encode to [{}]", kind, idx);
        }
    }

    #[test]
    fn comparator_discriminators_are_stable() {
        for (cmp, idx) in [(Comparator::LessOrEqual, 0u8), (Comparator::GreaterOrEqual, 1u8)] {
            assert_eq!(cmp.as_u8(), idx, "{:?} as_u8 must be {}", cmp, idx);
            let mut buf = vec![];
            cmp.serialize(&mut buf).unwrap();
            assert_eq!(buf, vec![idx], "{:?} must Borsh-encode to [{}]", cmp, idx);
        }
    }

    // Pins the InitSpace-computed size so an accidental field add/reorder is a
    // loud test failure. B0 added `oco_link: Option<Pubkey>` = 1 + 32 = 33 bytes:
    // 204 → 237 (8-disc-excluded body; full account = 8 + 237 = 245).
    #[test]
    fn trigger_order_init_space_is_237() {
        assert_eq!(TriggerOrder::INIT_SPACE, 237);
    }
}
