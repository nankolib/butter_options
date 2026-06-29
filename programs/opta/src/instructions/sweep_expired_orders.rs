// =============================================================================
// instructions/sweep_expired_orders.rs — Permissionless post-expiry order sweep
// =============================================================================
//
// Phase 1 of the Opta Exchange (exchange-spec §6.3, Step 5). Generalizes
// auto_cancel_listings into the two-sided book: at series expiry, return every
// resting order's escrowed collateral to its owner and close the PDAs. Wired
// into the crank BEFORE auto_finalize_holders (sweep-before-finalize), so an
// ask's freshly-returned tokens become holder-finalize candidates.
//
// Per-(vault, mint) batch — the crank groups orders by option_mint and passes
// one mint per call. `remaining_accounts` are 4-tuples of
//   (order, escrow, owner_asset_account, owner_wallet)
// per order in the batch; all four writable. Mixed kinds in one batch are fine
// (kind is read off each order): owner_asset_account is the owner's option ATA
// for asks, their USDC account for bids; the hook trio sits in the fixed
// accounts and is unused by bid tuples.
//
// Batch is atomic (revert on any mismatch) — the crank passes typed orders it
// just enumerated, so a mismatch is a bug, not benign drift. EXCEPTION: the
// zero-balance escrow grace path. If auto_finalize_holders already burned an
// ask escrow's tokens via PermanentDelegate, the escrow balance reads 0 — we
// skip the transfer and still close gracefully (§6.5). No aggregate ledger
// exists to desync; each order owns its own escrow.
// =============================================================================

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke_signed, system_program};
use anchor_spl::token::{self, spl_token, Token, Transfer};
use anchor_spl::token_2022::Token2022;

use crate::errors::OptaError;
use crate::events::OrderSwept;
use crate::state::*;

pub fn handle_sweep_expired_orders<'info>(
    ctx: Context<'_, '_, 'info, 'info, SweepExpiredOrders<'info>>,
) -> Result<()> {
    if ctx.remaining_accounts.is_empty() {
        return Ok(());
    }
    require!(
        ctx.remaining_accounts.len() % 4 == 0,
        OptaError::InvalidBatchAccounts
    );

    let clock = Clock::get()?;
    // Only sweep a series whose expiry has passed — sweeping live orders would
    // strand makers. All orders in the batch share this vault (verified below).
    require!(
        clock.unix_timestamp >= ctx.accounts.shared_vault.expiry,
        OptaError::MarketNotExpired
    );

    // ---- Snapshot batch-level state used inside the loop -------------------
    let vault_key = ctx.accounts.shared_vault.key();
    let option_mint_key = ctx.accounts.option_mint.key();
    let token_2022_key = ctx.accounts.token_2022_program.key();
    let token_classic_key = ctx.accounts.token_program.key();
    let protocol_key = ctx.accounts.protocol_state.key();
    let protocol_bump = ctx.accounts.protocol_state.bump;
    let program_id = ctx.program_id;

    let protocol_seeds: &[&[u8]] = &[PROTOCOL_SEED, &[protocol_bump]];
    let protocol_signer: &[&[&[u8]]] = &[protocol_seeds];

    for tuple in ctx.remaining_accounts.chunks_exact(4) {
        let order_info = &tuple[0];
        let escrow_info = &tuple[1];
        let owner_asset_info = &tuple[2];
        let owner_wallet_info = &tuple[3];

        // 1. Deserialize order — borrow drops at end of inner scope so the later
        //    manual lamport drain on order_info has unrestricted access.
        let (order_owner, order_option_mint, order_vault, order_kind, order_nonce) = {
            let order = Account::<RestingOrder>::try_from(order_info)?;
            (order.owner, order.option_mint, order.vault, order.kind, order.nonce)
        };

        // 2. Cross-check order fields against batch state.
        require!(order_option_mint == option_mint_key, OptaError::ListingMismatch);
        require!(order_vault == vault_key, OptaError::ListingMismatch);

        // 3. Verify owner_wallet matches order.owner — rent goes to this wallet.
        require_keys_eq!(
            owner_wallet_info.key(),
            order_owner,
            OptaError::NotResaleSeller
        );

        // 4. Re-derive expected order + escrow PDAs and verify.
        let (expected_order_pda, _) = Pubkey::find_program_address(
            &[
                RESTING_ORDER_SEED,
                option_mint_key.as_ref(),
                order_owner.as_ref(),
                &order_nonce.to_le_bytes(),
            ],
            program_id,
        );
        require_keys_eq!(order_info.key(), expected_order_pda, OptaError::ListingMismatch);
        let (expected_escrow_pda, _) = Pubkey::find_program_address(
            &[RESTING_ORDER_ESCROW_SEED, order_info.key().as_ref()],
            program_id,
        );
        require_keys_eq!(
            escrow_info.key(),
            expected_escrow_pda,
            OptaError::InvalidListingEscrow
        );

        // 5. Read escrow balance — amount at bytes 64..72 (both layouts).
        let escrow_balance = {
            let data = escrow_info.try_borrow_data()?;
            require!(data.len() >= 72, OptaError::MathOverflow);
            let bytes: [u8; 8] = data[64..72]
                .try_into()
                .map_err(|_| OptaError::MathOverflow)?;
            u64::from_le_bytes(bytes)
        };

        // 5b. SECURITY (sweep is permissionless): owner_asset is the COLLATERAL
        //     refund destination and is caller-supplied. Pin its token-account
        //     owner to order.owner BEFORE any refund so a sweeper cannot redirect
        //     the refund to themselves. order_owner derives from the validated
        //     order PDA (step 1 deser + step 4 re-derivation), NOT a tuple field.
        //     Fails closed on a malformed/short account (data.len() >= 72). This
        //     runs before every kind arm's transfer. (owner_wallet, the rent dest,
        //     is already pinned at step 3.)
        {
            let data = owner_asset_info.try_borrow_data()?;
            require!(data.len() >= 72, OptaError::MathOverflow);
            let asset_owner = Pubkey::try_from(&data[32..64])
                .map_err(|_| OptaError::MathOverflow)?;
            require_keys_eq!(asset_owner, order_owner, OptaError::NotResaleSeller);
        }

        // 6. Return escrow contents (grace-skip on zero) + close the escrow.
        match order_kind {
            OrderKind::ResaleAsk => {
                if escrow_balance > 0 {
                    spl_token_2022::onchain::invoke_transfer_checked(
                        &token_2022_key,
                        escrow_info.clone(),
                        ctx.accounts.option_mint.to_account_info(),
                        owner_asset_info.clone(),
                        ctx.accounts.protocol_state.to_account_info(),
                        &[
                            ctx.accounts.extra_account_meta_list.to_account_info(),
                            ctx.accounts.transfer_hook_program.to_account_info(),
                            ctx.accounts.hook_state.to_account_info(),
                        ],
                        escrow_balance,
                        0,
                        protocol_signer,
                    )?;
                }
                invoke_signed(
                    &spl_token_2022::instruction::close_account(
                        &token_2022_key,
                        escrow_info.key,
                        owner_wallet_info.key,
                        &protocol_key,
                        &[],
                    )?,
                    &[
                        escrow_info.clone(),
                        owner_wallet_info.clone(),
                        ctx.accounts.protocol_state.to_account_info(),
                    ],
                    protocol_signer,
                )?;
            }
            OrderKind::Bid => {
                if escrow_balance > 0 {
                    token::transfer(
                        CpiContext::new_with_signer(
                            ctx.accounts.token_program.to_account_info(),
                            Transfer {
                                from: escrow_info.clone(),
                                to: owner_asset_info.clone(),
                                authority: ctx.accounts.protocol_state.to_account_info(),
                            },
                            protocol_signer,
                        ),
                        escrow_balance,
                    )?;
                }
                invoke_signed(
                    &spl_token::instruction::close_account(
                        &token_classic_key,
                        escrow_info.key,
                        owner_wallet_info.key,
                        &protocol_key,
                        &[],
                    )?,
                    &[
                        escrow_info.clone(),
                        owner_wallet_info.clone(),
                        ctx.accounts.protocol_state.to_account_info(),
                    ],
                    protocol_signer,
                )?;
            }
            // Phase 3 Slice C — WriterAsk refund = the Bid mechanic (USDC escrow
            // → owner_asset, protocol-signed; full balance = cpt × quantity_remaining
            // + any dust). owner_asset is owner-pinned at step 5b. Pot/position
            // untouched — only the unfilled remainder is refunded.
            OrderKind::WriterAsk => {
                if escrow_balance > 0 {
                    token::transfer(
                        CpiContext::new_with_signer(
                            ctx.accounts.token_program.to_account_info(),
                            Transfer {
                                from: escrow_info.clone(),
                                to: owner_asset_info.clone(),
                                authority: ctx.accounts.protocol_state.to_account_info(),
                            },
                            protocol_signer,
                        ),
                        escrow_balance,
                    )?;
                }
                invoke_signed(
                    &spl_token::instruction::close_account(
                        &token_classic_key,
                        escrow_info.key,
                        owner_wallet_info.key,
                        &protocol_key,
                        &[],
                    )?,
                    &[
                        escrow_info.clone(),
                        owner_wallet_info.clone(),
                        ctx.accounts.protocol_state.to_account_info(),
                    ],
                    protocol_signer,
                )?;
            }
            // VaultPeg is virtual (fill_vault_peg) and never a resting order —
            // structurally unreachable for the same reason.
            OrderKind::VaultPeg => unreachable!("VaultPeg is never a resting order"),
        }

        // 7. Manual close of the order PDA; rent → owner_wallet. Same idiom as
        //    auto_cancel_listings.rs:170-177.
        let rent_lamports = order_info.lamports();
        **owner_wallet_info.try_borrow_mut_lamports()? = owner_wallet_info
            .lamports()
            .checked_add(rent_lamports)
            .ok_or(OptaError::MathOverflow)?;
        **order_info.try_borrow_mut_lamports()? = 0;
        order_info.assign(&system_program::ID);
        order_info.resize(0)?;

        // 8. Emit per-tuple tape.
        emit!(OrderSwept {
            order: order_info.key(),
            owner: order_owner,
            option_mint: option_mint_key,
            kind: order_kind.as_u8(),
            amount_returned: escrow_balance,
            ts: clock.unix_timestamp,
        });
    }

    Ok(())
}

#[derive(Accounts)]
pub struct SweepExpiredOrders<'info> {
    /// Permissionless caller — pays the tx fee.
    pub caller: Signer<'info>,

    /// Vault these orders belong to. Read for the expiry guard.
    pub shared_vault: Box<Account<'info, SharedVault>>,

    /// Market — pinned to the vault.
    #[account(constraint = market.key() == shared_vault.market)]
    pub market: Account<'info, OptionsMarket>,

    /// VaultMint record — pins option_mint to this vault.
    #[account(
        constraint = vault_mint_record.vault == shared_vault.key()
            @ OptaError::InvalidVaultMint,
        constraint = vault_mint_record.option_mint == option_mint.key()
            @ OptaError::InvalidVaultMint,
    )]
    pub vault_mint_record: Account<'info, VaultMint>,

    /// The single Token-2022 mint shared by every order in this batch.
    /// CHECK: validated via vault_mint_record + Token-2022 transfer CPI.
    #[account(mut)]
    pub option_mint: UncheckedAccount<'info>,

    /// Protocol state — signs the escrow-source transfers + closes.
    #[account(
        seeds = [PROTOCOL_SEED],
        bump = protocol_state.bump,
    )]
    pub protocol_state: Account<'info, ProtocolState>,

    /// Transfer hook program — used only by ResaleAsk tuples.
    /// CHECK: ID-constrained.
    #[account(constraint = transfer_hook_program.key() == opta_transfer_hook::ID)]
    pub transfer_hook_program: UncheckedAccount<'info>,

    /// ExtraAccountMetaList for the transfer hook.
    /// CHECK: validated by Token-2022 hook dispatch.
    pub extra_account_meta_list: UncheckedAccount<'info>,

    /// HookState for the transfer hook.
    /// CHECK: validated by Token-2022 hook dispatch.
    pub hook_state: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
    pub token_2022_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
    // remaining_accounts: 4-tuples per order —
    //   (order, escrow, owner_asset_account, owner_wallet)
}
