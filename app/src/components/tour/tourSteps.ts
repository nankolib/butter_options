// =============================================================================
// tourSteps — the shaded-tutorial state machine. PURE (no React, no DOM, no I/O).
// =============================================================================
//
// Extracted so the hard part — WHICH step a given wallet should see — is unit
// testable without a browser. See app/scripts/run-tour-tests.mjs.
//
// ── THE RULE THAT SHAPES EVERYTHING ─────────────────────────────────────────
// This is NOT a linear index. A user who wandered off and wrote a vault before
// their first fill must not be walked back through the fill step. State derives
// from what the wallet has ACTUALLY completed (the quest set from
// /api/points/wallet/<pubkey>), so the tour always lands on their FIRST
// INCOMPLETE step, whatever order they got there in.
//
// ── AND THE ONE THAT KEEPS IT HONEST ────────────────────────────────────────
// No step may ask a user to wait. O4 (exercise), O6 (hold to settlement) and O7
// (settle or create) are long-horizon: O6 in particular cannot be completed in a
// session at all. Spotlighting them would be a tutorial that stalls for days.
// They are HANDED OFF in a final card that points at where the work lives, and
// the tour then ends. Do not promote them to steps.
// =============================================================================

/** Steps, in the order a fresh wallet meets them. */
export type TourStepId =
  | "welcome"
  | "connect"
  | "faucet"
  | "trade"
  | "portfolio"
  | "write"
  | "market"
  | "handoff";

export interface TourStep {
  id: TourStepId;
  /** Route the step lives on. `null` = valid anywhere (welcome/connect/handoff). */
  route: string | null;
  /** `data-tour` value of the element to spotlight. `null` = centred card. */
  anchor: string | null;
  title: string;
  /** Terminal register: lowercase, plain, no hype. */
  body: string;
  /** Quest id whose completion retires this step. `null` = not quest-gated. */
  completedBy: string | null;
}

/**
 * The step list. `completedBy` is the ONLY progression signal for the middle of
 * the tour — never a counter, never "next was clicked".
 */
export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "welcome",
    route: null,
    anchor: null,
    title: "welcome to opta",
    body: "options on solana, on devnet. this walkthrough follows the quest chain — one step at a time, and it tracks what you have actually done rather than where you clicked. you can dismiss it whenever you like.",
    completedBy: null,
  },
  {
    id: "connect",
    route: null,
    anchor: "connect-wallet",
    title: "connect a wallet",
    body: "everything here is devnet. nothing costs real money and nothing you do is on mainnet.",
    completedBy: null,
  },
  {
    id: "faucet",
    route: null,
    anchor: "faucet-usdc",
    title: "claim devnet funds",
    body: "two claims: SOL for transaction fees, USDC to trade with. the SOL one has a four-hour cooldown, the USDC one twenty-four. claiming also completes a daily quest.",
    completedBy: "D3",
  },
  {
    id: "trade",
    route: "/trade",
    anchor: "trade-grid",
    title: "buy your first contract",
    body: "pick a strike in the grid, then buy it in the ticket on the right. that is the first link in the chain.",
    completedBy: "O1",
  },
  {
    id: "portfolio",
    route: "/portfolio",
    anchor: "quest-panel",
    title: "your position and your points",
    body: "the position you just bought is listed here. the quest panel tracks the chain, your streak and your multiplier.",
    completedBy: null,
  },
  {
    id: "write",
    route: "/write",
    anchor: "write-submit",
    title: "write a vault",
    body: "the other side of the trade. you post collateral, sell the option, and keep the premium if it expires worthless.",
    completedBy: "O2",
  },
  {
    id: "market",
    route: "/markets",
    anchor: "new-market-open",
    title: "list a new asset",
    // SLICE 2B (item 10). This step used to read "if the strike or expiry you
    // want does not exist, create it" while anchoring the New-market button —
    // which creates an ASSET, not a strike. A user following the sentence to
    // get a $250 SOL call was asked to name a new ticker instead. The sentence
    // described /write; the button does something else. Now the step describes
    // what the button actually does, and points strikes at the surface that
    // makes them.
    body: "this button lists an ASSET that opta does not carry yet — a whole new ticker. strikes and expiries are different: those are made on write, and any of them you want you can simply write. both are permissionless.",
    completedBy: "O3",
  },
  {
    id: "handoff",
    route: null,
    anchor: null,
    title: "the rest runs on its own",
    body: "the chain continues without a walkthrough: exercise a position that is in the money, hold one to settlement, and settle an expiry or create a market. settling is in the utilities band on your portfolio — it shows a count when expiries are waiting. dailies, weeklies and your streak live in the quest panel; referrals and the five leaderboards are on the leaderboard page.",
    completedBy: null,
  },
];

const byId = new Map(TOUR_STEPS.map((s) => [s.id, s]));
export const stepById = (id: TourStepId): TourStep | undefined => byId.get(id);

export interface TourState {
  /** Wallet connected? */
  connected: boolean;
  /** Quest ids the wallet has completed. Empty for a fresh/absent wallet. */
  completed: ReadonlySet<string>;
  /** Explicitly dismissed by the user (localStorage). */
  dismissed: boolean;
  /** Whether the wallet endpoint has answered yet. */
  loaded: boolean;
}

/**
 * The step to show, or `null` for "show nothing".
 *
 * Order of refusal matters: an explicit dismiss beats everything, and we never
 * guess a step before the wallet's quest state has loaded — showing "buy your
 * first contract" to someone who bought one yesterday is worse than showing
 * nothing for a beat.
 */
export function resolveStep(s: TourState): TourStep | null {
  if (s.dismissed) return null;
  if (!s.connected) return stepById("welcome") ?? null;
  if (!s.loaded) return null;

  // First step whose completing quest is not done. Steps with completedBy=null
  // are informational and are only reached via explicit navigation (see
  // `advanceFrom`), so they never trap progression here.
  for (const step of TOUR_STEPS) {
    if (step.id === "welcome" || step.id === "connect") continue;
    if (step.completedBy && !s.completed.has(step.completedBy)) return step;
  }
  return stepById("handoff") ?? null;
}

/**
 * Should the tour open by itself?
 *
 * Only for a connected wallet with a completely clean sheet. Anyone with any
 * completion has used the app and does not need to be interrupted — and an
 * explicit dismiss is permanent, which is the whole contract of a dismiss.
 */
export function shouldAutoOpen(s: TourState): boolean {
  if (s.dismissed || !s.connected || !s.loaded) return false;
  return s.completed.size === 0;
}

/**
 * The next step when the user clicks through manually, skipping the
 * informational ones' quest gate. Returns `null` at the end.
 */
export function advanceFrom(id: TourStepId, s: TourState): TourStep | null {
  const i = TOUR_STEPS.findIndex((x) => x.id === id);
  if (i < 0 || i >= TOUR_STEPS.length - 1) return null;
  for (let j = i + 1; j < TOUR_STEPS.length; j++) {
    const step = TOUR_STEPS[j];
    // Skip steps the wallet has already finished — clicking "next" must not
    // walk someone back through work they have done.
    if (step.completedBy && s.completed.has(step.completedBy)) continue;
    return step;
  }
  return stepById("handoff") ?? null;
}

/** Progress for the "n of m" readout. Informational steps are not counted. */
export function progressOf(step: TourStep): { index: number; total: number } {
  const gated = TOUR_STEPS.filter((s) => s.id !== "welcome");
  const idx = gated.findIndex((s) => s.id === step.id);
  return { index: idx < 0 ? 0 : idx + 1, total: gated.length };
}
