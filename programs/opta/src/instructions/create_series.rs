// =============================================================================
// instructions/create_series.rs — Canonical per-spec series mint (Phase 2 Pass A)
// =============================================================================
//
// Spec: .context/plans/opta-exchange-spec.md §7.3.1 (D5).
//
// Creates ONE canonical Token-2022 mint per (market, strike, expiry, type,
// style), addressed by the SPEC ALONE — no writer, no timestamp in the seeds —
// so all future fills `mint_to` the same address → true fungibility, one book,
// one tape, a computable CA. Permissionless; PDA-init on the series record
// enforces once-per-spec idempotency (a second call reverts "already in use").
//
// What it creates (order matters — mirrors mint_from_vault.rs:126-306 exactly,
// SELF-CONTAINED DUPLICATION by design: the per-event mint path is end-of-life
// and zero-touch beats DRY here):
//   1. Token-2022 mint, authority = protocol_state, decimals 0, with the 3
//      extensions (TransferHook + PermanentDelegate + MetadataPointer).
//   2. TokenMetadata term sheet — 100% spec-derived (exercise_style pair via
//      ExerciseStyle::metadata_str, the Stage E single source of truth).
//   3. Transfer-hook state via CPI — the per-mint hook PDAs become per-series
//      automatically (zero hook-program changes).
//   4. The series record at [VAULT_MINT_RECORD_SEED, option_mint] reusing the
//      VaultMint shape with per-writer fields SENTINELED (writer = default,
//      premium_per_contract = 0, created_at = 0) — so the Phase 1 book's
//      mint↔vault proof works with ZERO changes (D5).
//
// What it does NOT do: NO purchase escrow (series is mint-on-fill — Pass B),
// NO AMERICAN_ENABLED gate, NO oracle-warmup gate (creation is inert; nothing
// mints against the series until Pass B, which carries both gates). The vault
// account itself need not exist yet — `record.vault` stores the DERIVED
// American vault PDA address.
//
// American-only (D12): European reverts SeriesMustBeAmerican (6055).
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, program::invoke_signed, system_instruction};
use anchor_spl::token_2022::Token2022;
use spl_token_2022::extension::ExtensionType;

use crate::errors::OptaError;
use crate::events::SeriesCreated;
use crate::state::*;
use crate::utils::collateral::required_collateral_per_contract;
use crate::utils::time::timestamp_to_month_day;

// Month abbreviations — same as mint_from_vault.rs for identical metadata.
const MONTHS: [&str; 12] = [
    "JAN", "FEB", "MAR", "APR", "MAY", "JUN",
    "JUL", "AUG", "SEP", "OCT", "NOV", "DEC",
];

pub fn handle_create_series(
    ctx: Context<CreateSeries>,
    strike: u64,
    expiry: i64,
    option_type: OptionType,
    exercise_style: ExerciseStyle,
) -> Result<()> {
    let clock = Clock::get()?;
    let market = &ctx.accounts.market;

    // ---- 1. Pre-flight checks ---------------------------------------------
    require!(strike > 0, OptaError::InvalidStrikePrice);
    require!(expiry > clock.unix_timestamp, OptaError::ExpiryInPast);
    // D12 — Phase 2 series mints are American-only. EUR series ride the
    // European arc; legacy EUR vaults keep the static-ask flow untouched.
    require!(
        exercise_style == ExerciseStyle::American,
        OptaError::SeriesMustBeAmerican
    );

    // The American vault PDA this series belongs to — DERIVED, not required to
    // exist yet (the peg in Pass B needs both the series AND vault collateral).
    let (vault_pda, _) = Pubkey::find_program_address(
        &[
            vault_namespace_seed(exercise_style),
            market.key().as_ref(),
            &strike.to_le_bytes(),
            &expiry.to_le_bytes(),
            &[option_type as u8],
        ],
        ctx.program_id,
    );

    // ---- 2. Build the human-readable token name (spec-derived) ------------
    let strike_dollars = strike / 1_000_000;
    let type_char = match option_type {
        OptionType::Call => "C",
        OptionType::Put => "P",
    };
    let (month_idx, day) = timestamp_to_month_day(expiry);
    let month_name = MONTHS[month_idx];
    let token_name = format!(
        "OPTA-{}-{}{}-{}{}",
        market.asset_name, strike_dollars, type_char, month_name, day
    );
    let token_name = if token_name.len() > 32 {
        token_name[..32].to_string()
    } else {
        token_name
    };

    let protocol_seeds = &[PROTOCOL_SEED, &[ctx.accounts.protocol_state.bump]];
    let signer_seeds = &[&protocol_seeds[..]];

    // ---- 3. Create the Token-2022 mint + 3 extensions ---------------------
    let mint_info = ctx.accounts.option_mint.to_account_info();
    let token_2022_key = ctx.accounts.token_2022_program.key();

    let base_space = ExtensionType::try_calculate_account_len::<spl_token_2022::state::Mint>(
        &[
            ExtensionType::TransferHook,
            ExtensionType::PermanentDelegate,
            ExtensionType::MetadataPointer,
        ],
    )
    .map_err(|_| OptaError::MathOverflow)?;
    let rent = Rent::get()?;
    // Overfund for metadata realloc (same +854 as mint_from_vault).
    let mint_lamports = rent.minimum_balance(base_space + 854);

    // Series mint PDA seeds: spec-only — ["vault_option_mint", market,
    // strike(8), expiry(8), option_type(1), exercise_style(1)]. No writer,
    // no timestamp (D5).
    let ot_byte = option_type as u8;
    let es_byte = exercise_style as u8;
    let market_key = market.key();
    let mint_seeds: &[&[u8]] = &[
        VAULT_OPTION_MINT_SEED,
        market_key.as_ref(),
        &strike.to_le_bytes(),
        &expiry.to_le_bytes(),
        &[ot_byte],
        &[es_byte],
        &[ctx.bumps.option_mint],
    ];

    invoke_signed(
        &system_instruction::create_account(
            ctx.accounts.caller.key,
            mint_info.key,
            mint_lamports,
            base_space as u64,
            &token_2022_key,
        ),
        &[ctx.accounts.caller.to_account_info(), mint_info.clone()],
        &[mint_seeds],
    )?;

    // Extension 1: TransferHook → our hook program.
    invoke(
        &spl_token_2022::extension::transfer_hook::instruction::initialize(
            &token_2022_key,
            mint_info.key,
            None,
            Some(ctx.accounts.transfer_hook_program.key()),
        )?,
        &[mint_info.clone()],
    )?;
    // Extension 2: PermanentDelegate → protocol PDA.
    invoke(
        &spl_token_2022::instruction::initialize_permanent_delegate(
            &token_2022_key,
            mint_info.key,
            &ctx.accounts.protocol_state.key(),
        )?,
        &[mint_info.clone()],
    )?;
    // Extension 3: MetadataPointer → self.
    invoke(
        &spl_token_2022::extension::metadata_pointer::instruction::initialize(
            &token_2022_key,
            mint_info.key,
            None,
            Some(*mint_info.key),
        )?,
        &[mint_info.clone()],
    )?;
    // Initialize the mint (after all extensions). Authority = protocol PDA, dec 0.
    invoke(
        &spl_token_2022::instruction::initialize_mint2(
            &token_2022_key,
            mint_info.key,
            &ctx.accounts.protocol_state.key(),
            None,
            0,
        )?,
        &[mint_info.clone()],
    )?;

    // ---- 4. On-chain metadata (100% spec-derived) -------------------------
    invoke_signed(
        &spl_token_metadata_interface::instruction::initialize(
            &token_2022_key,
            mint_info.key,
            &ctx.accounts.protocol_state.key(),
            mint_info.key,
            &ctx.accounts.protocol_state.key(),
            token_name.clone(),
            "oOPT".to_string(),
            "".to_string(),
        ),
        &[mint_info.clone(), ctx.accounts.protocol_state.to_account_info()],
        signer_seeds,
    )?;

    let collateral_per_token = required_collateral_per_contract(strike, option_type);
    let additional_fields: Vec<(&str, String)> = vec![
        ("asset_name", market.asset_name.clone()),
        ("asset_class", market.asset_class.to_string()),
        ("strike_price", strike.to_string()),
        ("expiry", expiry.to_string()),
        (
            "option_type",
            match option_type {
                OptionType::Call => "call",
                OptionType::Put => "put",
            }
            .to_string(),
        ),
        ("collateral_per_token", collateral_per_token.to_string()),
        ("market_pda", market.key().to_string()),
        ("vault_pda", vault_pda.to_string()),
        ("exercise_style", exercise_style.metadata_str().to_string()),
    ];
    for (key, value) in additional_fields {
        invoke_signed(
            &spl_token_metadata_interface::instruction::update_field(
                &token_2022_key,
                mint_info.key,
                &ctx.accounts.protocol_state.key(),
                spl_token_metadata_interface::state::Field::Key(key.to_string()),
                value,
            ),
            &[mint_info.clone(), ctx.accounts.protocol_state.to_account_info()],
            signer_seeds,
        )?;
    }

    // ---- 5. Transfer-hook state via CPI (per-mint PDAs → per-series) -------
    let cpi_ctx = CpiContext::new(
        ctx.accounts.transfer_hook_program.to_account_info(),
        opta_transfer_hook::cpi::accounts::InitializeExtraAccountMetaList {
            payer: ctx.accounts.caller.to_account_info(),
            mint: mint_info.clone(),
            extra_account_meta_list: ctx.accounts.extra_account_meta_list.to_account_info(),
            hook_state: ctx.accounts.hook_state.to_account_info(),
            protocol_state: ctx.accounts.protocol_state.to_account_info(),
            system_program: ctx.accounts.system_program.to_account_info(),
        },
    );
    opta_transfer_hook::cpi::initialize_extra_account_meta_list(cpi_ctx, expiry)?;

    // ---- 6. Series record (VaultMint shape, per-writer fields sentineled) --
    let record = &mut ctx.accounts.vault_mint_record;
    record.vault = vault_pda;
    record.writer = Pubkey::default(); // sentinel — RETIRED for series records
    record.option_mint = *mint_info.key;
    record.premium_per_contract = 0; // sentinel — price lives on the book / peg
    record.quantity_minted = 0; // series supply counter (Pass B mint-on-fill)
    record.quantity_sold = 0; // series sold counter
    record.created_at = 0; // sentinel — RETIRED for series records
    record.bump = ctx.bumps.vault_mint_record;

    emit!(SeriesCreated {
        option_mint: *mint_info.key,
        market: market.key(),
        vault: vault_pda,
        strike,
        expiry,
        option_type: option_type as u8,
        exercise_style: exercise_style as u8,
        ts: clock.unix_timestamp,
    });

    Ok(())
}

#[derive(Accounts)]
#[instruction(strike: u64, expiry: i64, option_type: OptionType, exercise_style: ExerciseStyle)]
pub struct CreateSeries<'info> {
    /// Permissionless caller — pays the mint + record + hook-state rent.
    #[account(mut)]
    pub caller: Signer<'info>,

    /// The OptionsMarket this series belongs to. Must exist; provides
    /// asset_name / asset_class for spec-derived metadata.
    pub market: Account<'info, OptionsMarket>,

    /// Protocol state — mint authority + permanent delegate for Token-2022.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// The canonical series mint — created via CPI. PDA seeds are SPEC-ONLY
    /// (no writer, no timestamp). Idempotency comes from the series record
    /// `init` below (a second create_series reverts "already in use").
    /// CHECK: created via CPI; PDA seeds validate the address.
    #[account(
        mut,
        seeds = [
            VAULT_OPTION_MINT_SEED,
            market.key().as_ref(),
            &strike.to_le_bytes(),
            &expiry.to_le_bytes(),
            &[option_type as u8],
            &[exercise_style as u8],
        ],
        bump,
    )]
    pub option_mint: UncheckedAccount<'info>,

    /// The series record — `init` enforces once-per-spec. Reuses the VaultMint
    /// shape so the Phase 1 book's mint↔vault proof needs zero changes (D5);
    /// per-writer fields are sentineled (see handler).
    #[account(
        init,
        seeds = [VAULT_MINT_RECORD_SEED, option_mint.key().as_ref()],
        bump,
        payer = caller,
        space = 8 + VaultMint::INIT_SPACE,
    )]
    pub vault_mint_record: Box<Account<'info, VaultMint>>,

    /// Transfer hook program — pinned to the known opta-transfer-hook ID.
    /// CHECK: ID-constrained.
    #[account(constraint = transfer_hook_program.key() == opta_transfer_hook::ID)]
    pub transfer_hook_program: UncheckedAccount<'info>,

    /// ExtraAccountMetaList PDA — created by the hook program during CPI.
    /// CHECK: created + validated by the transfer hook program via CPI.
    #[account(mut)]
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// HookState PDA — created by the hook program during CPI.
    /// CHECK: created + validated by the transfer hook program via CPI.
    #[account(mut)]
    pub hook_state: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
    pub token_2022_program: Program<'info, Token2022>,
    pub rent: Sysvar<'info, Rent>,
}
