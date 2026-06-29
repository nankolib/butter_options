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
//   - WriterAsk (Phase 3 Slice A): the SAME plain SPL USDC escrow as Bid, but
//     holding the writer's PERSONAL collateral = cpt × quantity (cpt = 1× strike
//     via required_collateral_per_contract), escrowed at post (lock-at-post).
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
/// byte encoding the variant index (Bid = 0, ResaleAsk = 1, WriterAsk = 2,
/// VaultPeg = 3); reordering after this ships would silently retag every
/// existing order. Do not reorder — append new variants only.
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
    /// The standing model-priced vault peg (Phase 2 Pass B). NOT a resting
    /// order — `post_order` refuses it and no `RestingOrder` is ever created
    /// with this kind. It exists ONLY as the `OrderFilled.kind` tape value so
    /// `fill_vault_peg` emits to the same trade tape as book fills (spec §7.2).
    /// Every book handler that matches on a stored `order.kind` rejects it.
    VaultPeg,
}

impl OrderKind {
    /// Stable u8 encoding for events (Bid = 0, ResaleAsk = 1, WriterAsk = 2,
    /// VaultPeg = 3), matching the Borsh discriminator and the house convention
    /// of emitting enum fields as u8 (see events.rs / VaultCreated.vault_type).
    pub fn as_u8(self) -> u8 {
        match self {
            OrderKind::Bid => 0,
            OrderKind::ResaleAsk => 1,
            OrderKind::WriterAsk => 2,
            OrderKind::VaultPeg => 3,
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

    /// Phase 3 Slice A — protocol-set collateral requirement per contract
    /// (USDC, 6dp), snapshotted at post time from
    /// `required_collateral_per_contract(vault.strike_price, vault.option_type)`.
    /// Set ONLY on `WriterAsk` orders (the personal-collateral lock-at-post);
    /// `0` (sentinel = N/A) on `Bid` / `ResaleAsk`. Slice B reads it to move the
    /// filled slice into the series pot; Slice C refunds the unfilled remainder
    /// at cancel/expiry.
    ///
    /// MUST be the last field — pre-Slice-A `RestingOrder` accounts were 8 bytes
    /// shorter (146 on-disk vs the new 154). Live devnet orders are cleared by
    /// `cancel_order` before deploy (clean cutover), so no realloc-migration path
    /// is required — unlike the SharedVault append+migrate discipline, there are
    /// no long-lived RestingOrder accounts to grow.
    pub collateral_per_contract: u64,
}

/// Seed prefix for RestingOrder PDAs: ["resting_order", option_mint, owner, nonce_le].
pub const RESTING_ORDER_SEED: &[u8] = b"resting_order";

/// Seed prefix for the per-order escrow PDA (owned by protocol_state):
/// ["resting_order_escrow", resting_order].
pub const RESTING_ORDER_ESCROW_SEED: &[u8] = b"resting_order_escrow";

#[cfg(test)]
mod tests {
    use super::*;
    use anchor_lang::AnchorSerialize;

    // CRITICAL: variant order is load-bearing. The Phase 2 Pass B VaultPeg
    // append MUST leave Bid/ResaleAsk/WriterAsk on their original
    // discriminators — any reorder silently retags every resting order on
    // devnet. This is the EUR-byte-identical proof for the enum append.
    #[test]
    fn order_kind_discriminators_are_stable() {
        let cases = [
            (OrderKind::Bid, 0u8),
            (OrderKind::ResaleAsk, 1u8),
            (OrderKind::WriterAsk, 2u8),
            (OrderKind::VaultPeg, 3u8),
        ];
        for (kind, idx) in cases {
            // as_u8() matches the index...
            assert_eq!(kind.as_u8(), idx, "{:?} as_u8 must be {}", kind, idx);
            // ...and the Borsh discriminator is the same single byte.
            let mut buf = vec![];
            kind.serialize(&mut buf).unwrap();
            assert_eq!(buf, vec![idx], "{:?} must Borsh-encode to [{}]", kind, idx);
        }
    }

    #[test]
    fn vault_peg_is_the_appended_variant() {
        // Pass B appended VaultPeg = 3; if a future edit inserts a variant
        // before it, this fires.
        assert_eq!(OrderKind::VaultPeg as u8, 3);
    }
}
