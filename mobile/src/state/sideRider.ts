/**
 * Side auto-correct.
 *
 * `asset` and `expiry` already self-correct to something that exists (App.tsx
 * mirrors this pattern for both). `side` did not: it is seeded from
 * INITIAL_TRADE as "call" and never moved, so a board whose inventory sits
 * entirely on one side rendered an empty grid on first paint even though the
 * offers were loaded and the chips were drawn.
 *
 * Kept as a pure function so the rule is unit-testable without a renderer.
 */

export type OptionSide = "call" | "put";

type SidedOffering = {
  readonly asset: string;
  readonly expiry: number;
  readonly side: OptionSide;
};

/**
 * Returns the side to switch to, or `null` to leave the current side alone.
 *
 * Returns null when:
 *   - nothing is loaded for this asset/expiry at all (the empty panel owns that
 *     case; moving the toggle would be noise), or
 *   - the current side already has at least one offer.
 *
 * Only ever returns a side that is actually present in `offerings`, so the
 * caller cannot be driven into a second correction — this terminates.
 */
export function pickInventorySide(
  offerings: readonly SidedOffering[],
  asset: string,
  expiry: number,
  currentSide: OptionSide
): OptionSide | null {
  if (!asset) return null;
  const forCell = offerings.filter(
    (offering) => offering.asset === asset && offering.expiry === expiry
  );
  if (forCell.length === 0) return null;
  if (forCell.some((offering) => offering.side === currentSide)) return null;
  return forCell[0].side;
}
