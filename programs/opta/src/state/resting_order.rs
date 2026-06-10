// =============================================================================
// state/resting_order.rs — A single resting order in the per-series book
// =============================================================================
//
// Phase 1 of the Opta Exchange (exchange-spec §6). Generalizes the V2 resale
// listing (`VaultResaleListing`) into a two-sided book of resting orders that
// are filled by name. One `RestingOrder` PDA = one resting bid or ask on one
// option series (one Token-2022 mint = one strike/expiry/type/style).
//
// Each order owns exactly one escrow PDA holding the order's collateral:
//   - ResaleAsk: a Token-2022 account (TransferHookAccount-sized) holding the
//     escrowed option tokens, owner = protocol_state. Same shape as the V2
//     resale escrow (see list_v2_for_resale.rs:54-100).
//   - Bid: a plain SPL USDC account, owner = protocol_state, mint pinned to
//     protocol_state.usdc_mint.
//
// PDA seeds:
//   RestingOrder : ["resting_order", option_mint, owner, nonce_le_bytes]
//   order escrow : ["resting_order_escrow", resting_order]
//
// The `nonce` is client-supplied; PDA `init` enforces uniqueness, so multiple
// orders per (owner, mint) at different prices are first-class — a collision
// just means the client retries with a fresh nonce.
// =============================================================================

use anchor_lang::prelude::*;

/// Which side of the book this order sits on, and (for asks) what backs it.
///
/// **Variant order is load-bearing.** The Borsh discriminator is a single
/// byte encoding the variant index (Bid = 0, ResaleAsk = 1, WriterAsk = 2);
/// reordering after this ships would silently retag every existing order.
/// Do not reorder — append new variants only.
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace, Debug)]
pub enum OrderKind {
    /// A USDC-escrowed limit bid. Anyone can post; filled by a holder
    /// delivering option tokens.
    Bid,
    /// A secondary-market ask: the owner escrows existing option tokens and
    /// sells them. Replaces the V2 resale listing flow.
    ResaleAsk,
    /// A writer's primary ask backed by personal collateral (mint-on-fill).
    /// Reserved for Phase 3 — rejected with `WriterAsksDisabled` until then.
    WriterAsk,
}

impl OrderKind {
    /// Stable u8 encoding for events (Bid = 0, ResaleAsk = 1, WriterAsk = 2),
    /// matching the Borsh discriminator and the house convention of emitting
    /// enum fields as u8 (see events.rs / VaultCreated.vault_type).
    pub fn as_u8(self) -> u8 {
        match self {
            OrderKind::Bid => 0,
            OrderKind::ResaleAsk => 1,
            OrderKind::WriterAsk => 2,
        }
    }
}

#[account]
#[derive(InitSpace)]
pub struct RestingOrder {
    /// Wallet that posted the order. Receives proceeds + rent on close, and
    /// the returned escrow on cancel/sweep.
    pub owner: Pubkey,

    /// The Token-2022 option mint this order trades. Part of the PDA seed.
    pub option_mint: Pubkey,

    /// The SharedVault the option mint was minted from. Stored for market
    /// context + crank enumeration (mirrors VaultResaleListing.vault).
    pub vault: Pubkey,

    /// Bid / ResaleAsk / WriterAsk. See `OrderKind`.
    pub kind: OrderKind,

    /// USDC per contract (6 decimals), set at post time, immutable.
    pub price_per_contract: u64,

    /// Contracts still resting (0 decimals). Decremented on each partial fill;
    /// the order auto-closes when this hits zero.
    pub quantity_remaining: u64,

    /// Contracts at post time. Never mutated — kept for fill-ratio analytics.
    pub quantity_initial: u64,

    /// Unix timestamp when the order was posted.
    pub created_at: i64,

    /// Client-supplied uniqueness nonce. Part of the PDA seed.
    pub nonce: u64,

    /// PDA bump seed.
    pub bump: u8,
}

/// Seed prefix for RestingOrder PDAs: ["resting_order", option_mint, owner, nonce_le].
pub const RESTING_ORDER_SEED: &[u8] = b"resting_order";

/// Seed prefix for the per-order escrow PDA (owned by protocol_state):
/// ["resting_order_escrow", resting_order].
pub const RESTING_ORDER_ESCROW_SEED: &[u8] = b"resting_order_escrow";
