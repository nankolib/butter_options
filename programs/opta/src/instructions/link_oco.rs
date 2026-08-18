// =============================================================================
// instructions/link_oco.rs — mutually pair two triggers into an OCO couple (B3)
// =============================================================================
//
// WHY THIS EXISTS. `place_trigger` writes `oco_link = None` and nothing else in
// the program could ever set it, so `execute_trigger`'s B3 decrement was
// unreachable code: the enforcement existed, the pairing did not. The behavioural
// suite is what surfaced that — there was no way to construct the state the
// enforcement guards.
//
// WHY A SEPARATE INSTRUCTION rather than an argument on `place_trigger`. The link
// must be MUTUAL, and a placement can only ever see one side: the first leg
// cannot name a peer that does not exist yet. Linking after both exist makes
// mutuality a single atomic write instead of a two-step the owner could leave
// half-finished — and a half-linked pair is precisely the double-exit hazard OCO
// is meant to remove.
//
// CONSTRAINTS, and the reason for each:
//   - both legs owned by the SIGNER   — otherwise a stranger could staple their
//                                       trigger to yours and ride your fire
//   - same option_mint                — a TP/SL couple is two exits on ONE
//                                       position; linking across series would let
//                                       a fire on A cancel an unrelated B
//   - neither already linked          — re-pointing a live pair would orphan the
//                                       old peer, leaving it linked to something
//                                       that no longer links back, i.e. unfireable
//   - a != b                          — self-linking would decrement the firing
//                                       leg a second time
// =============================================================================

use anchor_lang::prelude::*;

use crate::errors::OptaError;
use crate::state::*;

pub fn handle_link_oco(ctx: Context<LinkOco>) -> Result<()> {
    let a_key = ctx.accounts.trigger_a.key();
    let b_key = ctx.accounts.trigger_b.key();

    require_keys_neq!(a_key, b_key, OptaError::OcoPeerMismatch);
    require_keys_eq!(
        ctx.accounts.trigger_a.owner,
        ctx.accounts.owner.key(),
        OptaError::OcoPeerMismatch
    );
    require_keys_eq!(
        ctx.accounts.trigger_b.owner,
        ctx.accounts.owner.key(),
        OptaError::OcoPeerMismatch
    );
    require_keys_eq!(
        ctx.accounts.trigger_a.option_mint,
        ctx.accounts.trigger_b.option_mint,
        OptaError::OcoSeriesMismatch
    );
    require!(
        ctx.accounts.trigger_a.oco_link.is_none(),
        OptaError::OcoAlreadyLinked
    );
    require!(
        ctx.accounts.trigger_b.oco_link.is_none(),
        OptaError::OcoAlreadyLinked
    );

    ctx.accounts.trigger_a.oco_link = Some(b_key);
    ctx.accounts.trigger_b.oco_link = Some(a_key);

    Ok(())
}

#[derive(Accounts)]
pub struct LinkOco<'info> {
    /// Must own BOTH legs. Pairing is a position-level decision, so it is the
    /// owner's to make and nobody else's.
    pub owner: Signer<'info>,

    #[account(mut)]
    pub trigger_a: Box<Account<'info, TriggerOrder>>,

    #[account(mut)]
    pub trigger_b: Box<Account<'info, TriggerOrder>>,
}
