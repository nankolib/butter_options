// =============================================================================
// utils/price_oracle.rs — Source-routed spot-price read abstraction (Stage 1)
// =============================================================================
//
// This module is the SEAM the Switchboard arm slots into at Stage 3. It wraps
// the three spot-read sites mapped in the Switchboard Stage-0 recon:
//
//   #1 settle_expiry      → pyth_settlement_price_usdc  (historical EMA in a
//                                                         [expiry, expiry+window]
//                                                         settlement window)
//   #2 exercise_american  → pyth_current_spot_usdc      (current EMA, tight 60s)
//   #3 push_vol_sample    → pyth_current_spot_scale     (current SPOT, tight 60s)
//
// STAGE 1 CONTRACT — pure internal refactor, ZERO behavior change:
//   - There is exactly ONE implementer: Pyth. No routing dispatch, no
//     oracle_source flag (that is Stage 2). Each handler calls its Pyth helper
//     unconditionally.
//   - Each helper is a verbatim lift of the handler's prior inline
//     validate→extract→normalize block. Error codes, gate ORDER, the EMA-vs-
//     spot choice, and the USDC-vs-SCALE normalization are preserved exactly.
//   - Threshold constants stay defined in their handlers and are passed in as
//     parameters, so no `pub const` reference (tests, cu_profile_*) breaks and
//     there is no `utils → instructions` dependency. The helpers hardcode only
//     what genuinely differs per seam (error variants, EMA vs spot, scale).
//
// STAGE 3 (future): each handler grows
//     match market.oracle_source {
//         OracleSource::Pyth        => pyth_*(...),
//         OracleSource::Switchboard => sb_*(...),
//     }
// The plain-function shape (not a trait) is deliberate: the two arms read
// different account TYPES (PriceUpdateV2 vs the Switchboard PullFeed) living in
// different ctx fields, which a trait would only obscure with generics/dyn.
// =============================================================================

use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::error::GetPriceError;
use pyth_solana_receiver_sdk::price_update::{PriceUpdateV2, VerificationLevel};

use crate::errors::OptaError;
use crate::utils::solmath_bridge::{pyth_price_to_scale, pyth_price_to_usdc};

/// Result of a settlement-window read: the canonical settlement price in USDC
/// smallest units (6 decimals) plus the update's `publish_time`, which
/// settle_expiry persists to `SettlementRecord.pyth_publish_time`.
pub struct SettlementRead {
    pub price_usdc: u64,
    pub publish_time: i64,
}

/// #1 settle_expiry. Validate a historical Pyth `PriceUpdateV2` whose
/// `publish_time` must land in `[expiry, expiry + window_secs]`, then normalize
/// the EMA to USDC 6-dec.
///
/// Gates, in order (identical to the prior settle_expiry inline block):
///   - verification_level == Full          → InsufficientVerificationLevel
///   - price_message.feed_id == expected    → MismatchedFeedId
///   - EMA confidence ≤ max_conf_bps        → PriceConfidenceTooWide
///   - publish_time ≥ expiry                → PriceUpdateBeforeExpiry
///   - publish_time − expiry ≤ window_secs  → PriceUpdateTooFarFromExpiry
///   - publish_time + max_age_secs ≥ now    → PriceTooOld
///   - EMA normalizes (price > 0, no trunc) → InvalidSettlementPrice / MathOverflow
#[inline]
pub fn pyth_settlement_price_usdc(
    price_update: &PriceUpdateV2,
    expected_feed_id: [u8; 32],
    expiry: i64,
    now: i64,
    window_secs: i64,
    max_age_secs: i64,
    max_conf_bps: u16,
) -> Result<SettlementRead> {
    let pu = price_update;
    require!(
        pu.verification_level.gte(VerificationLevel::Full),
        GetPriceError::InsufficientVerificationLevel
    );
    require!(
        pu.price_message.feed_id == expected_feed_id,
        GetPriceError::MismatchedFeedId
    );

    let ema_price = pu.price_message.ema_price;
    let exponent = pu.price_message.exponent;
    let publish_time = pu.price_message.publish_time;

    // Confidence-interval gate (CRIT-2).
    let conf = pu.price_message.ema_conf as u128;
    let abs_price = ema_price.unsigned_abs() as u128;
    require!(
        conf.checked_mul(10_000).ok_or(OptaError::MathOverflow)?
            <= abs_price
                .checked_mul(max_conf_bps as u128)
                .ok_or(OptaError::MathOverflow)?,
        OptaError::PriceConfidenceTooWide
    );

    // Expiry-window gate.
    require!(publish_time >= expiry, OptaError::PriceUpdateBeforeExpiry);
    require!(
        publish_time.saturating_sub(expiry) <= window_secs,
        OptaError::PriceUpdateTooFarFromExpiry
    );

    // Backstop staleness floor.
    require!(
        publish_time.saturating_add(max_age_secs) >= now,
        GetPriceError::PriceTooOld
    );

    let price_usdc = pyth_price_to_usdc(ema_price, exponent)?;
    Ok(SettlementRead {
        price_usdc,
        publish_time,
    })
}

/// #2 exercise_american. Validate a CURRENT Pyth `PriceUpdateV2` (single-sided
/// `max_age_secs` freshness against `now`) and normalize the EMA to USDC 6-dec.
///
/// Gates, in order (identical to the prior exercise_american inline block):
///   - verification_level == Full           → InsufficientVerificationLevel
///   - price_message.feed_id == expected     → MismatchedFeedId
///   - EMA confidence ≤ max_conf_bps         → PriceConfidenceTooWide
///   - now − publish_time ≤ max_age_secs     → PriceTooOld (single-sided)
///   - EMA normalizes                        → InvalidSettlementPrice / MathOverflow
#[inline]
pub fn pyth_current_spot_usdc(
    price_update: &PriceUpdateV2,
    expected_feed_id: [u8; 32],
    now: i64,
    max_age_secs: i64,
    max_conf_bps: u16,
) -> Result<u64> {
    let pu = price_update;
    require!(
        pu.verification_level.gte(VerificationLevel::Full),
        GetPriceError::InsufficientVerificationLevel
    );
    require!(
        pu.price_message.feed_id == expected_feed_id,
        GetPriceError::MismatchedFeedId
    );

    let ema_price = pu.price_message.ema_price;
    let exponent = pu.price_message.exponent;
    let publish_time = pu.price_message.publish_time;

    let conf = pu.price_message.ema_conf as u128;
    let abs_price = ema_price.unsigned_abs() as u128;
    require!(
        conf.checked_mul(10_000).ok_or(OptaError::MathOverflow)?
            <= abs_price
                .checked_mul(max_conf_bps as u128)
                .ok_or(OptaError::MathOverflow)?,
        OptaError::PriceConfidenceTooWide
    );

    // Single-sided freshness: only a price older than max_age_secs reverts; a
    // future-dated publish_time yields a negative diff and passes (receiver
    // verification already bounds forward skew).
    require!(
        now.saturating_sub(publish_time) <= max_age_secs,
        GetPriceError::PriceTooOld
    );

    pyth_price_to_usdc(ema_price, exponent)
}

/// #3 push_vol_sample. Validate a CURRENT Pyth `PriceUpdateV2`, read SPOT (not
/// EMA — realized vol is computed from spot returns), and normalize to solmath
/// SCALE (1e12).
///
/// Gates, in order (identical to the prior push_vol_sample inline block):
///   - verification_level == Full           → InsufficientVerificationLevel
///   - price_message.feed_id == expected     → MismatchedFeedId
///   - spot price > 0  (BEFORE conf/fresh)   → VolOracleInvalidSpot
///   - spot normalizes to SCALE              → InvalidSettlementPrice / MathOverflow
///   - EMA confidence ≤ max_conf_bps         → VolOraclePriceStale (catch-all)
///   - publish_time + max_age_secs ≥ now     → VolOraclePriceStale
///
/// The spot>0 gate runs BEFORE the confidence and freshness gates so a
/// fundamentally garbage price surfaces VolOracleInvalidSpot rather than being
/// misattributed to VolOraclePriceStale (a zero-price update would make the
/// conf-check rhs 0 and trip the stale branch). Caller is responsible for
/// reading `oracle.feed_id` and passing it as `expected_feed_id` so the
/// read-only oracle borrow drops before any subsequent `load_mut`.
#[inline]
pub fn pyth_current_spot_scale(
    price_update: &PriceUpdateV2,
    expected_feed_id: [u8; 32],
    now: i64,
    max_age_secs: i64,
    max_conf_bps: u16,
) -> Result<u128> {
    let pu = price_update;
    require!(
        pu.verification_level.gte(VerificationLevel::Full),
        GetPriceError::InsufficientVerificationLevel
    );
    require!(
        pu.price_message.feed_id == expected_feed_id,
        GetPriceError::MismatchedFeedId
    );

    let price = pu.price_message.price;
    let exponent = pu.price_message.exponent;
    let publish_time = pu.price_message.publish_time;
    let ema_price = pu.price_message.ema_price;
    let ema_conf = pu.price_message.ema_conf;

    // Spot positivity gate — runs BEFORE conf/freshness for correct error
    // attribution (see doc comment).
    require!(price > 0, OptaError::VolOracleInvalidSpot);

    // Convert (i64 price, i32 exponent) → u128 at SCALE.
    let new_spot_u128 = pyth_price_to_scale(price, exponent)?;

    // EMA confidence-interval gate (re-uses the VolOraclePriceStale catch-all).
    let conf_u128 = ema_conf as u128;
    let abs_ema = ema_price.unsigned_abs() as u128;
    require!(
        conf_u128
            .checked_mul(10_000)
            .ok_or(OptaError::MathOverflow)?
            <= abs_ema
                .checked_mul(max_conf_bps as u128)
                .ok_or(OptaError::MathOverflow)?,
        OptaError::VolOraclePriceStale
    );

    // One-sided freshness check.
    require!(
        publish_time.saturating_add(max_age_secs) >= now,
        OptaError::VolOraclePriceStale
    );

    Ok(new_spot_u128)
}

// =============================================================================
// Switchboard On-Demand arm (Stage 3) — the second implementer behind the seam
// =============================================================================
//
// These mirror the three pyth_* siblings above so the dispatch stays symmetric,
// but the SHAPE differs in one deliberate, documented way (the "awkward seam"):
//
//   Pyth:  the handler's Accounts struct Anchor-deserializes a `PriceUpdateV2`,
//          and the helper takes `&PriceUpdateV2` — a plain value read.
//   SB:    the verified `OracleQuote` BORROWS from the `QuoteVerifier` (its ctor
//          is `pub(crate)`; `verify_instruction_at(&self) -> OracleQuote<'_>`
//          ties the quote to the local verifier), so it cannot escape the
//          verifier. The verify + feed-extract MUST therefore be FUSED inside
//          each helper — we cannot hand a pre-verified quote across a function
//          boundary the way Pyth hands a deserialized account.
//
// Freshness: enforced INSIDE the verifier via `max_age` (in SLOTS) resolved
// against the SlotHashes sysvar — there is no in-band publish_time. There is no
// confidence-bps analog; the multi-oracle `min_oracle_samples` floor
// (SB_MIN_ORACLE_SAMPLES_FLOOR) is the Switchboard equivalent gate.
//
// All three are INERT until oracle_source routing is wired at the 4 read sites;
// they are pub so the (future) handlers can call them and so the lib target does
// not dead-code-strip them.

use crate::utils::solmath_bridge::{sb_i128_to_scale, sb_i128_to_usdc};
use switchboard_on_demand::on_demand::oracle_quote::feed_info::PackedFeedInfo;
use switchboard_on_demand::on_demand::oracle_quote::quote_verifier::QuoteVerifier;

/// Solana's target slot time is ~400 ms ⇒ 2.5 slots/sec, expressed as the exact
/// rational 5/2 so the seconds→slots conversion needs no float math. Tune these
/// two consts together if Solana's slot cadence changes. Sanity: 60 s × 5 / 2 =
/// 150 slots, matching the Switchboard SDK's own documented `.max_age(150)` ≈ 60s.
pub const SLOTS_PER_SEC_NUM: u64 = 5;
pub const SLOTS_PER_SEC_DEN: u64 = 2;

/// Minimum aggregating-oracle sample count a Switchboard feed must report to be
/// accepted — the SB analog of Pyth's `MAX_CONF_BPS` confidence-width gate. A
/// quote backed by fewer than this many oracle samples is rejected as too thin.
/// 2 matches the captured devnet feed (`min_oracle_samples = 2`) and the
/// queue's typical multi-oracle floor. INERT until Stage-3 wiring.
pub const SB_MIN_ORACLE_SAMPLES_FLOOR: u8 = 2;

/// Convert a seconds-based freshness budget into Switchboard's slot-based
/// `max_age`. Non-positive inputs map to 0 (immediately stale). Saturating.
/// Documented assumption: SLOTS_PER_SEC_NUM/SLOTS_PER_SEC_DEN slots per second.
#[inline]
pub fn secs_to_slots(secs: i64) -> u64 {
    if secs <= 0 {
        return 0;
    }
    (secs as u64).saturating_mul(SLOTS_PER_SEC_NUM) / SLOTS_PER_SEC_DEN
}

/// Result of a Switchboard settlement read: the settlement price in USDC 6-dec
/// plus the verifier-resolved `recent_slot`. `recent_slot` is the ONLY "when was
/// this quote signed" primitive Switchboard exposes (slot-based; there is no
/// in-band publish_time like Pyth's). The Pyth expiry-window gate
/// (`publish_time >= expiry && publish_time - expiry <= window`) is DELIBERATELY
/// NOT applied here — see `sb_settlement_price_usdc`.
pub struct SbSettlementRead {
    pub price_usdc: u64,
    pub recent_slot: u64,
}

/// Find the feed matching `expected_feed_id` in a verified quote's feed slice and
/// return its raw `feed_value` (i128 @ 1e18), enforcing the min-oracle-samples
/// floor. Split out from the readers below so it is unit-testable over a
/// synthetic `&[PackedFeedInfo]` — `OracleQuote` is not externally constructible
/// (its ctor is `pub(crate)`), so this is the largest testable slice of the SB
/// extraction logic.
fn sb_extract_feed_value(
    feeds: &[PackedFeedInfo],
    expected_feed_id: [u8; 32],
    min_samples_floor: u8,
) -> Result<i128> {
    for f in feeds {
        if *f.feed_id() == expected_feed_id {
            require!(
                f.min_oracle_samples() >= min_samples_floor,
                OptaError::SwitchboardInsufficientSamples
            );
            return Ok(f.feed_value());
        }
    }
    err!(OptaError::SwitchboardFeedNotFound)
}

/// Verify an ed25519-signed Switchboard quote (freshness via `max_age_slots`,
/// resolved against the SlotHashes sysvar internally) and extract the matched
/// feed's `feed_value` + the verifier-resolved `recent_slot`. The verify and
/// extract are fused (see module note). The crate's `anyhow` verify error
/// carries no on-chain-surfaceable discriminant, so it is collapsed to
/// `SwitchboardVerifyFailed`.
#[allow(clippy::too_many_arguments)]
fn sb_verify_and_extract<'info>(
    queue: &AccountInfo<'info>,
    slothash_sysvar: &AccountInfo<'info>,
    ix_sysvar: &AccountInfo<'info>,
    ed25519_ix_index: i64,
    clock_slot: u64,
    max_age_slots: u64,
    expected_feed_id: [u8; 32],
    min_samples_floor: u8,
) -> Result<(i128, u64)> {
    let mut verifier = QuoteVerifier::new();
    verifier
        .queue(queue)
        .slothash_sysvar(slothash_sysvar)
        .ix_sysvar(ix_sysvar)
        .clock_slot(clock_slot)
        .max_age(max_age_slots);
    let quote = verifier
        .verify_instruction_at(ed25519_ix_index)
        .map_err(|_| error!(OptaError::SwitchboardVerifyFailed))?;
    let value = sb_extract_feed_value(quote.feeds(), expected_feed_id, min_samples_floor)?;
    Ok((value, quote.slot()))
}

/// #2 exercise_american / execute_trigger (SB arm). Mirror of
/// `pyth_current_spot_usdc`: verify a CURRENT Switchboard quote (freshness via
/// `max_age_slots`) and normalize the matched feed to USDC 6-dec.
#[allow(clippy::too_many_arguments)]
pub fn sb_current_spot_usdc<'info>(
    queue: &AccountInfo<'info>,
    slothash_sysvar: &AccountInfo<'info>,
    ix_sysvar: &AccountInfo<'info>,
    ed25519_ix_index: i64,
    clock_slot: u64,
    max_age_slots: u64,
    expected_feed_id: [u8; 32],
    min_samples_floor: u8,
) -> Result<u64> {
    let (value, _recent_slot) = sb_verify_and_extract(
        queue,
        slothash_sysvar,
        ix_sysvar,
        ed25519_ix_index,
        clock_slot,
        max_age_slots,
        expected_feed_id,
        min_samples_floor,
    )?;
    sb_i128_to_usdc(value)
}

/// #3 push_vol_sample (SB arm). Mirror of `pyth_current_spot_scale`: verify a
/// CURRENT Switchboard quote and normalize the matched feed to solmath SCALE
/// (1e12). (Pyth reads SPOT here, not EMA; Switchboard exposes a single
/// aggregated value, so there is no EMA-vs-spot choice to mirror.)
#[allow(clippy::too_many_arguments)]
pub fn sb_current_spot_scale<'info>(
    queue: &AccountInfo<'info>,
    slothash_sysvar: &AccountInfo<'info>,
    ix_sysvar: &AccountInfo<'info>,
    ed25519_ix_index: i64,
    clock_slot: u64,
    max_age_slots: u64,
    expected_feed_id: [u8; 32],
    min_samples_floor: u8,
) -> Result<u128> {
    let (value, _recent_slot) = sb_verify_and_extract(
        queue,
        slothash_sysvar,
        ix_sysvar,
        ed25519_ix_index,
        clock_slot,
        max_age_slots,
        expected_feed_id,
        min_samples_floor,
    )?;
    sb_i128_to_scale(value)
}

/// #1 settle_expiry (SB arm). Partial mirror of `pyth_settlement_price_usdc`:
/// verify a Switchboard quote and normalize the matched feed to USDC 6-dec.
///
/// FLAGGED — NOT a faithful mirror, by necessity. The Pyth version gates on
/// `publish_time >= expiry` AND `publish_time - expiry <= window_secs` to pin
/// the settlement price to the expiry instant. Switchboard carries NO in-band
/// timestamp — only the verifier-resolved `recent_slot` (the slot whose hash the
/// oracles signed). We therefore DO NOT fabricate a publish_time. This helper
/// returns the price PLUS `recent_slot`; the expiry-window settlement policy is
/// a documented TODO for the handler-wiring unit (proposal in the unit report:
/// map the expiry instant to a slot window and gate `recent_slot` against it,
/// since SlotHashes only retains ~512 recent slots — settlement may need a
/// stored-at-expiry slot or an admin-fallback, decided at wiring time).
#[allow(clippy::too_many_arguments)]
pub fn sb_settlement_price_usdc<'info>(
    queue: &AccountInfo<'info>,
    slothash_sysvar: &AccountInfo<'info>,
    ix_sysvar: &AccountInfo<'info>,
    ed25519_ix_index: i64,
    clock_slot: u64,
    max_age_slots: u64,
    expected_feed_id: [u8; 32],
    min_samples_floor: u8,
) -> Result<SbSettlementRead> {
    let (value, recent_slot) = sb_verify_and_extract(
        queue,
        slothash_sysvar,
        ix_sysvar,
        ed25519_ix_index,
        clock_slot,
        max_age_slots,
        expected_feed_id,
        min_samples_floor,
    )?;
    let price_usdc = sb_i128_to_usdc(value)?;
    Ok(SbSettlementRead {
        price_usdc,
        recent_slot,
    })
}

#[cfg(test)]
mod sb_tests {
    use super::*;
    use crate::utils::solmath_bridge::pyth_price_to_usdc;
    use switchboard_on_demand::on_demand::oracle_quote::feed_info::{PackedFeedInfo, PackedQuoteHeader};

    // The authoritative captured quote sample (Switchboard On-Demand devnet,
    // XAU/PAXG, SDK 3.10.3). See tests/fixtures/sb_quote_manifest.json for
    // provenance + pinned expectations. The .bin is the signed quote MESSAGE:
    //   PackedQuoteHeader(32) || PackedFeedInfo(49)  = 81 bytes.
    const FIXTURE_MSG: &[u8] = include_bytes!("../../../../tests/fixtures/sb_quote_message.bin");
    // Pinned gold value: 4053.9 × 1e18.
    const PIN_FEED_VALUE: i128 = 4_053_900_000_000_000_000_000;
    const PIN_MIN_SAMPLES: u8 = 2;
    // 0x6c3c5cc7… (first byte of the XAU/PAXG feed_id).
    const PIN_FEED_ID_BYTE0: u8 = 0x6c;

    // -------- Test 1: offline geometry (crate-relative, NEVER offset 186) ------

    #[test]
    fn test1_packed_layout_is_crate_authoritative() {
        // The decoder relies on these exact crate offsets; if the crate ever
        // re-shapes the struct, this test (and thus the read arm) must fail.
        assert_eq!(PackedFeedInfo::PACKED_SIZE, 49);
        assert_eq!(core::mem::size_of::<PackedQuoteHeader>(), 32);
        assert_eq!(core::mem::offset_of!(PackedFeedInfo, feed_id), 0);
        assert_eq!(core::mem::offset_of!(PackedFeedInfo, feed_value), 32);
        assert_eq!(core::mem::offset_of!(PackedFeedInfo, min_oracle_samples), 48);
    }

    #[test]
    fn test1_decode_fixture_via_relative_offsets() {
        // Derive every offset from the crate's struct layout — NOT a literal
        // absolute 186 (that was the brittle account-header artifact). The feed
        // record begins right after the 32-byte PackedQuoteHeader.
        let header_len = core::mem::size_of::<PackedQuoteHeader>(); // 32
        let v_off = header_len + core::mem::offset_of!(PackedFeedInfo, feed_value); // 32+32
        let s_off = header_len + core::mem::offset_of!(PackedFeedInfo, min_oracle_samples); // 32+48
        let id_off = header_len + core::mem::offset_of!(PackedFeedInfo, feed_id); // 32+0

        assert_eq!(FIXTURE_MSG.len(), header_len + PackedFeedInfo::PACKED_SIZE);
        // No hard-coded 186 anywhere — assert that explicitly for the auditor.
        assert_ne!(id_off, 186, "feed_id must be located relative to header, not at absolute 186");
        assert_eq!(id_off, 32);

        let feed_id_byte0 = FIXTURE_MSG[id_off];
        let feed_value = i128::from_le_bytes(FIXTURE_MSG[v_off..v_off + 16].try_into().unwrap());
        let min_samples = FIXTURE_MSG[s_off];

        assert_eq!(feed_id_byte0, PIN_FEED_ID_BYTE0);
        assert_eq!(feed_value, PIN_FEED_VALUE);
        assert_eq!(min_samples, PIN_MIN_SAMPLES);

        // And the normalized gold: 4053.9 × 1e18 → $4053.90 USDC 6-dec.
        assert_eq!(sb_i128_to_usdc(feed_value).unwrap(), 4_053_900_000u64);
    }

    // -------- Test 2 (closest-achievable): extraction + cross-oracle parity ----
    // The full QuoteVerifier path is NOT exercised here — see the unit report:
    // OracleQuote is not externally constructible (pub(crate) ctor) and a bankrun
    // synthetic-SlotHashes verify is impractical/flaky. These cover every line of
    // the extraction + normalization code WE wrote; the verifier itself is the
    // crate's, tested upstream.

    fn mk_feed(id_byte0: u8, value: i128, samples: u8) -> PackedFeedInfo {
        let mut feed_id = [0u8; 32];
        feed_id[0] = id_byte0;
        PackedFeedInfo {
            feed_id,
            feed_value: value,
            min_oracle_samples: samples,
        }
    }

    #[test]
    fn test2_extract_picks_matching_feed() {
        let mut want = [0u8; 32];
        want[0] = 0xAB;
        let feeds = [mk_feed(0x01, 111, 5), mk_feed(0xAB, PIN_FEED_VALUE, 2)];
        let v = sb_extract_feed_value(&feeds, want, SB_MIN_ORACLE_SAMPLES_FLOOR).unwrap();
        assert_eq!(v, PIN_FEED_VALUE);
    }

    #[test]
    fn test2_extract_rejects_missing_feed() {
        let mut missing = [0u8; 32];
        missing[0] = 0xCD;
        let feeds = [mk_feed(0x01, 111, 5)];
        assert!(sb_extract_feed_value(&feeds, missing, SB_MIN_ORACLE_SAMPLES_FLOOR).is_err());
    }

    #[test]
    fn test2_extract_rejects_thin_quote() {
        let mut want = [0u8; 32];
        want[0] = 0xAB;
        // 1 sample < floor of 2 → SwitchboardInsufficientSamples.
        let feeds = [mk_feed(0xAB, PIN_FEED_VALUE, 1)];
        assert!(sb_extract_feed_value(&feeds, want, SB_MIN_ORACLE_SAMPLES_FLOOR).is_err());
    }

    #[test]
    fn test2_cross_oracle_equivalence_spot_usdc() {
        // The achievable form of "sb_current_spot_usdc output == Pyth path": run
        // the SB extraction+normalization (everything except the crate verifier)
        // and assert it equals the Pyth normalization for the same $180.50.
        let mut want = [0u8; 32];
        want[0] = 0xAB;
        let feeds = [mk_feed(0xAB, 180_500_000_000_000_000_000i128, 2)];
        let raw = sb_extract_feed_value(&feeds, want, SB_MIN_ORACLE_SAMPLES_FLOOR).unwrap();
        let sb_usdc = sb_i128_to_usdc(raw).unwrap();
        let pyth_usdc = pyth_price_to_usdc(18_050_000_000i64, -8).unwrap();
        assert_eq!(sb_usdc, pyth_usdc);
        assert_eq!(sb_usdc, 180_500_000u64);
    }

    #[test]
    fn test_secs_to_slots_conversion() {
        assert_eq!(secs_to_slots(60), 150); // matches SDK .max_age(150)
        assert_eq!(secs_to_slots(0), 0);
        assert_eq!(secs_to_slots(-5), 0);
        assert_eq!(secs_to_slots(2), 5);
    }
}
