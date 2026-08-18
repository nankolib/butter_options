// Wiring tests for the armed-exits surface — walkthrough FAIL follow-up.
//
//   run (from crank/): node node_modules/ts-node/dist/bin.js --transpile-only \
//                      -r tsconfig-paths/register portfolioWiring.test.ts
//
// WHAT WENT WRONG (founder walkthrough, 2026-08-18)
//
//   A TP/SL pair was armed on chain and confirmed. POSITIONS showed the long
//   rows and NO armed-exit rows, no OCO badge, nothing to cancel. A hard reload
//   did not help, because there was nothing to reload: ArmedTriggersSection is
//   rendered only by PortfolioPageLegacy, and PORTFOLIO_TERMINAL_UI has been
//   true since the terminal rewrite. The component was never wired into the page
//   that actually ships. Its strings are not even in the bundle -- the dead
//   branch is folded away at build time.
//
//   Every unit test in the world would have passed. The component was correct,
//   its hook was correct, the chain data was correct and decodable. The only
//   broken thing was that nothing rendered it. So the test has to assert the
//   WIRING, on the branch the flag actually selects.
//
// WHY SOURCE-LEVEL ASSERTIONS
//   app/ has no React test runner (see numericInput.test.ts). A source assertion
//   is a poor substitute for a render test, but it catches exactly the failure
//   that shipped: a section that exists, works, and is mounted by nobody.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const APP = join(__dirname, "..", "app", "src");
const read = (p: string) => readFileSync(join(APP, p), "utf8");

test("PORTFOLIO_TERMINAL_UI is true, so the TERMINAL page is the one that must be wired", () => {
  // If this ever flips, the assertions below are checking a dead branch and the
  // failure would be invisible again. Fail loudly instead.
  const consts = read("utils/constants.ts");
  assert.match(consts, /export const PORTFOLIO_TERMINAL_UI = true/,
    "if this flag flipped, move the wiring assertions to the branch it now selects");
});

test("RED: the LIVE portfolio page renders ArmedTriggersSection", () => {
  const page = read("pages/portfolio/PortfolioTerminalPage.tsx");
  assert.match(page, /<ArmedTriggersSection/,
    "armed exits are invisible on the shipped portfolio: the section is only in the legacy branch");
  assert.match(page, /import\s*\{[^}]*ArmedTriggersSection/,
    "the section must be imported by the page that ships");
});

test("RED: useTriggers refreshes on the mutation bus", () => {
  // Without this, arming an exit while a trigger list is already mounted leaves
  // the list stale -- the user sees nothing and arms it a second time, which is
  // precisely the doubling risk called out in the walkthrough.
  const hook = read("hooks/useTriggers.ts");
  assert.match(hook, /subscribeMutations/,
    "useTriggers must re-fetch when a mutation lands, or a freshly armed exit stays invisible");
});

test("the armed-exits section still exposes a cancel affordance", () => {
  // The walkthrough needs "cancel SL from the UI" to be reachable at all.
  const section = read("pages/portfolio/ArmedTriggersSection.tsx");
  assert.match(section, /buildTriggerCancelFor/,
    "cancel must go through the real-peer builder, not a hand-rolled account list");
});

test("the empty state is not silent", () => {
  // `if (triggers.length === 0) return null` renders NOTHING -- no header, no
  // "no armed exits". That is indistinguishable from the bug that just shipped,
  // so the section must say something when it has nothing.
  const section = read("pages/portfolio/ArmedTriggersSection.tsx");
  assert.doesNotMatch(section, /if \(triggers\.length === 0\) return null;/,
    "a silent empty state hides this exact class of failure -- say 'no armed exits'");
});

// ---------------------------------------------------------------------------
// STANDING RULE (adopted 2026-08-18, after the SECOND dead-branch mount):
// any new user-facing surface ships with BOTH a wiring test on the
// flag-selected branch AND a live-bundle presence check. "The component
// exists" is not "the component shipped" — the armed-exits section was
// correct, tested, mounted by nobody, and folded out of the bundle entirely.
// ---------------------------------------------------------------------------

test("armed exits are surfaced in the TRADE dock, not only in Portfolio", () => {
  // The founder looked for them here, next to the position they protect, on the
  // page where they were armed. Where someone looks for their own data is data.
  const dock = read("pages/trade/TradeDock.tsx");
  assert.match(dock, /useTriggers/, "the dock must read the armed set");
  assert.match(dock, /Armed exits/, "the dock must label them");
  assert.match(dock, /to="\/portfolio"/, "there must be a route to manage/cancel them");
});

test("an OCO pair is marked as such wherever it is shown", () => {
  // Cancelling one leg of a pair while believing the other still stands is the
  // failure this badge exists to prevent.
  const dock = read("pages/trade/TradeDock.tsx");
  assert.match(dock, /ocoLink && /, "a linked leg must be visibly marked OCO");
});

test("the sell-floor copy does not promise more than the floor delivers", () => {
  // FLOOR ASYMMETRY: execute_trigger enforces max_premium as a minimum only on
  // the BOOK path. The take-profit's vault fallback (american_exercise_core) has
  // no floor check, so an unqualified "minimum proceeds" was a promise one of
  // the two execution paths does not keep.
  const ticket = read("pages/trade/OrderTicket.tsx");
  assert.match(ticket, /book sales only/,
    "the floor label must scope itself to the path that actually enforces it");
  assert.match(ticket, /can still exercise/,
    "the copy must say a take-profit can exercise regardless of the floor");
});
