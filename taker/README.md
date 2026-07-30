# opta-taker

The treasury's **buyer of last resort**. It buys ResaleAsks from real users at a
discount to model fair value, so a tester holding a contract has somewhere to
exit on a book that is otherwise ~232/233 our own orders.

**Ships DRY_RUN and unarmed.** A fill requires `OPTA_TAKER_DRY_RUN=0` **and**
`OPTA_TAKER_ARMED=1`; both default to the safe side in code, so a missing env
file leaves the bot in shadow mode.

## The threat this service is built around

The treasury is always the **uninformed side** — the user chooses what to sell
and when. Every gate in [`src/eligibility.ts`](src/eligibility.ts) exists because
of a specific way that asymmetry can be turned into a withdrawal:

| Gate | Refuses | Because |
|---|---|---|
| self / internal / not-a-wallet | our own wallets, PDAs, unclassifiable owners | bot-on-bot wash volume would score as organic on the campaign tape |
| band — upper | asks within 5% of fair | the seller picks the moment; a fill at fair loses in expectation |
| band — lower | asks over 50% under fair | "free money" is a stale oracle or a crafted order, not a bargain |
| TTE floor | under 24h to expiry | largest gamma, least trustworthy model — the worst combination |
| European | non-American series | `get_option_price` is American-only (reverts 6051) |
| delay 30–180s | instant fills | certainty of execution makes the treasury a synchronous put |
| per-wallet $250/day | one seller farming | the points-farm vector |
| global $2k/day | a coordinated group | per-wallet caps cannot see coordination |
| float $10k | total capital at risk | independent of how fast it got there |

The delay is **derived from the order pubkey, not sampled** — otherwise a seller
could restart-farm the bot for a faster exit.

## Layout

```
src/eligibility.ts   PURE. Every refusal reason. The whole safety story.
src/budget.ts        PURE. Three limits, UTC days, float accounting.
src/db.ts            SQLite at /opt/opta-taker/taker.db — spend that must survive a restart.
src/scan.ts          ResaleAsk enumeration + chain-verified owner classification.
src/pricing.ts       VENDORED from writer/ — see the header for why it is not imported.
src/fill.ts          The only path that spends money. Mirrors the proven FE builder.
src/main.ts          Loop, boot marker, shadow journal.
```

`registry.ts` is **imported from `indexer/`**, not vendored: there is exactly one
definition of "internal wallet" and a fork would silently diverge.

## Tests

```bash
npm test          # typecheck + node:test across src/**/*.test.ts
```

`src/degenerate.test.ts` is a **permanent fixture class** for states the happy
path never enters — empty book, all-internal book, zero limits, UTC rollover
mid-run, restart, replayed signature. New gates and counters must be exercised
there before they ship.

The gates were verified by mutation: each one was deliberately broken and the
suite confirmed to fail. A test that passes on broken code is decoration.

## Arming

Arming is blocked in code until the taker wallet is in the indexer's
`INTERNAL_WALLETS`. An unregistered taker would appear on the campaign
leaderboard as a top trader and its buys would score as organic volume, so
forgetting that step stops the bot instead of poisoning the tape.

Order of operations:

1. Add the taker pubkey to `indexer/src/registry.ts`, redeploy the indexer, and
   verify the re-derive on a full recompute.
2. Review a shadow window: `shadow-would-fill` lines are fills that *would* have
   happened, each already simulated against chain.
3. `OPTA_TAKER_DRY_RUN=0`, then `OPTA_TAKER_ARMED=1`, restart, assert the boot
   marker reads `mode: "ARMED"` with the expected band and budgets.

Rollback is `OPTA_TAKER_ARMED=0` + restart; nothing else changes.
