// =============================================================================
// utils/triggerGuards.ts — is this exit trigger already true?
// =============================================================================
//
// WHAT WENT WRONG (founder walkthrough, 2026-08-18)
//
//   On a JTO contract with the underlying at $0.5588, a take-profit of 0.02 was
//   entered — a PREMIUM-scale number typed into an UNDERLYING-scale field. The
//   fields never showed spot, so nothing on screen contradicted it.
//
//   A take-profit fires when the underlying is at or ABOVE the trigger. Spot was
//   already 27x above 0.02, so the condition was true the moment it was armed:
//   the keeper would fire on its very next tick and market-exit a position the
//   user believed they had merely protected. Nothing rejects it, because an
//   already-true trigger is perfectly valid on chain — it is only wrong as an
//   INTENTION.
//
//   Stop-loss has the mirror failure: it fires at or BELOW, so any stop entered
//   ABOVE spot is already met.
//
// WHY THIS IS A SEPARATE PURE MODULE
//
//   The comparison is two lines and both directions are easy to get backwards —
//   which is exactly why it is tested directly, one case per direction, instead
//   of being an inline expression nobody can exercise without a wallet, a
//   position and a live keeper.
// =============================================================================

export type TriggerLegKind = "tp" | "sl";

/**
 * Would this leg's condition ALREADY be satisfied at the current underlying?
 *
 * Inclusive on both sides, matching the on-chain comparators (`ge` for
 * take-profit, `le` for stop-loss): a trigger exactly at spot is met, not near.
 *
 * Returns false when the leg is not being placed (price <= 0) or when spot is
 * unknown — an unknown spot means we cannot make the claim, and blocking submit
 * on a guess would be worse than not blocking. Absence of evidence is not
 * evidence that the trigger is sane.
 */
export function triggerAlreadyMet(
  kind: TriggerLegKind,
  price: number,
  spot: number | null | undefined,
): boolean {
  if (!Number.isFinite(price) || price <= 0) return false;
  if (spot == null || !Number.isFinite(spot) || spot <= 0) return false;
  return kind === "tp" ? spot >= price : spot <= price;
}

/** Every leg that would fire immediately. Empty array = nothing to warn about. */
export function alreadyMetLegs(args: {
  tpPrice: number;
  slPrice: number;
  spot: number | null | undefined;
}): TriggerLegKind[] {
  const out: TriggerLegKind[] = [];
  if (triggerAlreadyMet("tp", args.tpPrice, args.spot)) out.push("tp");
  if (triggerAlreadyMet("sl", args.slPrice, args.spot)) out.push("sl");
  return out;
}

/** Human sentence for the block. Names the direction, because the whole failure
 *  is that the user had the direction the wrong way round. */
export function alreadyMetMessage(legs: TriggerLegKind[], spot: number | null | undefined): string {
  if (legs.length === 0) return "";
  const s = spot != null && Number.isFinite(spot) ? `$${spot.toFixed(4)}` : "the current price";
  if (legs.length === 2) {
    return `Both triggers would fire immediately — the underlying is already ${s}.`;
  }
  return legs[0] === "tp"
    ? `This take-profit would fire immediately — the underlying is already at or above it (${s}).`
    : `This stop-loss would fire immediately — the underlying is already at or below it (${s}).`;
}

/**
 * An estimate small enough that showing it as a bare number reads like a bug.
 *
 * "Est. value if hit today ≈ $0.0000" was rendered with no explanation, so a
 * correct answer (the contract really is worth nothing if the underlying only
 * reaches that price) looked like a broken calculation. One cent is the
 * threshold: below it the number carries no information except "worthless".
 */
export const WORTHLESS_EST_USD = 0.01;

export function isEffectivelyWorthless(est: number | null | undefined): boolean {
  return est != null && Number.isFinite(est) && est < WORTHLESS_EST_USD;
}

/**
 * Placeholder anchored to SPOT, so the field's own example contradicts a
 * premium-scale entry before the user commits to one. A take-profit sits above
 * spot and a stop sits below; the offsets are illustrative, not advice.
 */
export function spotAnchoredPlaceholder(
  kind: TriggerLegKind,
  spot: number | null | undefined,
): string {
  if (spot == null || !Number.isFinite(spot) || spot <= 0) return "leave empty to skip";
  const v = kind === "tp" ? spot * 1.1 : spot * 0.9;
  // Match the precision of the asset's own scale: sub-dollar underlyings need
  // four decimals to be meaningful, larger ones read better with two.
  return `e.g. ${v.toFixed(spot < 10 ? 4 : 2)}`;
}

/**
 * Spot for display, at the asset's own scale. A sub-dollar underlying needs four
 * decimals to say anything (JTO at $0.5588); a stock does not, and "$200.0000"
 * is exactly the kind of noise this whole change is trying to remove.
 */
export function formatSpotForLabel(spot: number): string {
  return `$${spot.toFixed(spot < 10 ? 4 : 2)}`;
}
