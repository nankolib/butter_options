// Anti-exploit gate tests.
//
// Each test below names a way the treasury could be drained and asserts that the
// specific gate refuses it. If a test here is ever "fixed" by loosening a gate,
// the exploit it names is live again — read the comment before touching one.
//
//   run: npx ts-node --transpile-only src/eligibility.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluate, preScreen, identityGate, withinBand, discountBps, affordableQuantity, delayForOrder, oiCreatedUsd,
  type Candidate, type TakerLimits, type EvalInput, type Spend,
} from "./eligibility";

const TAKER = "TAKERxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const USER = "USERxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const BOT = "BOTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
const NOW = 1_785_000_000; // fixed clock — never Date.now() in a fixture

const LIMITS: TakerLimits = {
  minDiscountBps: 500,
  maxDiscountBps: 5000,
  minTteSecs: 24 * 3600,
  maxFillUsdc: 100,
  maxPerWalletDayUsdc: 250,
  maxGlobalDayUsdc: 2000,
  maxFloatUsdc: 10_000,
  maxOiUsd: 2500,
};

const ZERO_SPEND: Spend = { walletSpentTodayUsdc: 0, globalSpentTodayUsdc: 0, floatUsdc: 0, oiUsd: 0 };

function candidate(over: Partial<Candidate> = {}): Candidate {
  return {
    orderPk: "ORDER1",
    owner: USER,
    optionMint: "MINT1",
    kind: "resaleAsk",
    priceUsdc: 9,               // 10% under a fair value of 10 => inside the band
    strikeUsd: 100,
    quantityRemaining: 5,
    expiryTs: NOW + 7 * 86_400,
    isEuropean: false,
    ...over,
  };
}

function input(over: Partial<EvalInput> = {}): EvalInput {
  return {
    candidate: candidate(),
    fairUsdc: 10,
    limits: LIMITS,
    spend: ZERO_SPEND,
    nowSecs: NOW,
    delayUntilSecs: 0,
    isInternal: (pk) => pk === BOT,
    isWallet: () => true,
    takerWallet: TAKER,
    ...over,
  };
}

const reasonOf = (d: ReturnType<typeof evaluate>) => (d.fill ? "FILL" : d.reason);

// ---------------------------------------------------------------------------
// The happy path — if this breaks, every "refused" test below is meaningless
// ---------------------------------------------------------------------------

test("baseline: a genuine user ask inside the band fills", () => {
  const d = evaluate(input());
  assert.equal(d.fill, true);
  if (!d.fill) return;
  assert.equal(d.quantity, 5);        // 5 × $9 = $45, under every cap
  assert.equal(d.costUsdc, 45);
  assert.equal(d.bandBps, 1000);      // 10% under fair
});

// ---------------------------------------------------------------------------
// Identity — wash trading and bot-on-bot volume
// ---------------------------------------------------------------------------

test("self-owned: the taker never fills its own order", () => {
  assert.equal(reasonOf(evaluate(input({ candidate: candidate({ owner: TAKER }) }))), "self_owned");
});

test("internal owner: filling the writer bot would be bot-on-bot wash volume", () => {
  // The board is ~232/233 our own orders, so this gate is the one that fires
  // most. Getting it wrong means the campaign tape records the treasury trading
  // with itself as organic volume.
  assert.equal(reasonOf(evaluate(input({ candidate: candidate({ owner: BOT }) }))), "internal_owner");
});

test("not-a-wallet: a PDA/mint owner is refused (fails CLOSED)", () => {
  // Chain-verified. An owner that could not be classified must be refused, not
  // assumed human — an unclassified pubkey is exactly what an attacker controls.
  assert.equal(reasonOf(evaluate(input({ isWallet: () => false }))), "not_a_wallet");
});

// ---------------------------------------------------------------------------
// The band — adverse selection in both directions
// ---------------------------------------------------------------------------

test("above band: an ask at or near fair is refused", () => {
  // The seller picks the moment, so paying fair value is a losing trade in
  // expectation. 2% under fair is inside minDiscountBps=500 (5%).
  assert.equal(reasonOf(evaluate(input({ candidate: candidate({ priceUsdc: 9.8 }) }))), "above_band");
  assert.equal(reasonOf(evaluate(input({ candidate: candidate({ priceUsdc: 10 }) }))), "above_band");
  assert.equal(reasonOf(evaluate(input({ candidate: candidate({ priceUsdc: 12 }) }))), "above_band");
});

test("below band: an implausibly cheap ask is refused, not seized", () => {
  // THE COUNTER-INTUITIVE GATE. 90% under model is not free money — it is a
  // stale oracle, a model bug, or a crafted order. Removing this gate is what
  // turns one bad vol print into a drained float.
  assert.equal(reasonOf(evaluate(input({ candidate: candidate({ priceUsdc: 1 }) }))), "below_band");
});

test("band edges are inclusive on both sides", () => {
  // Exactly 5% under => the minimum acceptable discount => allowed.
  assert.equal(reasonOf(evaluate(input({ candidate: candidate({ priceUsdc: 9.5 }) }))), "FILL");
  // Exactly 50% under => the maximum acceptable discount => still allowed.
  assert.equal(reasonOf(evaluate(input({ candidate: candidate({ priceUsdc: 5 }) }))), "FILL");
  assert.equal(withinBand(9.5, 10, LIMITS), "ok");
  assert.equal(withinBand(5, 10, LIMITS), "ok");
  assert.equal(withinBand(9.51, 10, LIMITS), "above_band");
  assert.equal(withinBand(4.99, 10, LIMITS), "below_band");
});

test("no fair value: an unpriceable series is never bought", () => {
  // Every QuoteFailure kind lands here. "The model could not price it" is never
  // a reason to buy.
  assert.equal(reasonOf(evaluate(input({ fairUsdc: null }))), "no_fair_value");
  assert.equal(reasonOf(evaluate(input({ fairUsdc: 0 }))), "no_fair_value");
});

test("discountBps: a zero or negative fair value never yields a finite discount", () => {
  assert.ok(Number.isNaN(discountBps(5, 0)));
  assert.ok(Number.isNaN(discountBps(5, -1)));
  // …and the band treats NaN as out-of-band rather than letting it through.
  assert.equal(withinBand(5, 0, LIMITS), "above_band");
});

// ---------------------------------------------------------------------------
// Structure and time
// ---------------------------------------------------------------------------

test("European series are skipped (get_option_price is American-only)", () => {
  assert.equal(reasonOf(evaluate(input({ candidate: candidate({ isEuropean: true }) }))), "european");
});

test("near expiry: inside the TTE floor is refused", () => {
  // Gamma is largest and the model least trustworthy exactly when a seller most
  // wants out — the worst combination for the uninformed side.
  assert.equal(reasonOf(evaluate(input({ candidate: candidate({ expiryTs: NOW + 3600 }) }))), "too_near_expiry");
  assert.equal(reasonOf(evaluate(input({ candidate: candidate({ expiryTs: NOW - 1 }) }))), "too_near_expiry");
  // Exactly at the floor is acceptable; one second under is not.
  assert.equal(reasonOf(evaluate(input({ candidate: candidate({ expiryTs: NOW + 24 * 3600 }) }))), "FILL");
  assert.equal(reasonOf(evaluate(input({ candidate: candidate({ expiryTs: NOW + 24 * 3600 - 1 }) }))), "too_near_expiry");
});

test("zero quantity / zero price are refused", () => {
  assert.equal(reasonOf(evaluate(input({ candidate: candidate({ quantityRemaining: 0 }) }))), "zero_quantity");
  assert.equal(reasonOf(evaluate(input({ candidate: candidate({ priceUsdc: 0 }) }))), "zero_quantity");
});

// ---------------------------------------------------------------------------
// The delay — removing fill certainty
// ---------------------------------------------------------------------------

test("delay: an order inside its wait window is refused", () => {
  const d = evaluate(input({ delayUntilSecs: NOW + 60 }));
  assert.equal(reasonOf(d), "delay_pending");
  assert.equal(d.fill === false && d.detail, "60s");
});

test("delay: fills once the window has elapsed", () => {
  assert.equal(reasonOf(evaluate(input({ delayUntilSecs: NOW }))), "FILL");
});

test("delayForOrder is DETERMINISTIC — a restart cannot re-roll a shorter wait", () => {
  // If the delay were sampled, a seller could restart-farm the bot for a faster
  // exit. Same order pubkey must always produce the same wait.
  for (const pk of ["A", "OrDeR-1", "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin"]) {
    const a = delayForOrder(pk, 30, 180);
    assert.equal(a, delayForOrder(pk, 30, 180), `${pk} is stable`);
    assert.ok(a >= 30 && a <= 180, `${pk} in range (got ${a})`);
  }
  // Different orders must not all collapse onto one value.
  const spread = new Set(Array.from({ length: 50 }, (_, i) => delayForOrder(`order-${i}`, 30, 180)));
  assert.ok(spread.size > 10, `delays are spread across the range (got ${spread.size} distinct)`);
});

test("delayForOrder: a degenerate window returns the floor rather than NaN", () => {
  assert.equal(delayForOrder("X", 60, 60), 60);
  assert.equal(delayForOrder("X", 90, 30), 90);
});

// ---------------------------------------------------------------------------
// Budgets — the farming limits
// ---------------------------------------------------------------------------

test("per-wallet daily cap: one seller cannot farm the treasury", () => {
  const spend = { ...ZERO_SPEND, walletSpentTodayUsdc: 250 };
  assert.equal(reasonOf(evaluate(input({ spend }))), "wallet_budget");
});

test("global daily cap: a coordinated group is capped even when each wallet is clean", () => {
  const spend = { ...ZERO_SPEND, globalSpentTodayUsdc: 2000 };
  assert.equal(reasonOf(evaluate(input({ spend }))), "global_budget");
});

test("float cap: total capital at risk binds regardless of daily spend", () => {
  const spend = { ...ZERO_SPEND, floatUsdc: 10_000 };
  assert.equal(reasonOf(evaluate(input({ spend }))), "float_cap");
});

test("the binding constraint is named, not just 'no budget'", () => {
  // All three exhausted at once: float is reported first because it is the most
  // serious (it does not reset at midnight).
  const spend = { walletSpentTodayUsdc: 250, globalSpentTodayUsdc: 2000, floatUsdc: 10_000, oiUsd: 0 };
  assert.equal(reasonOf(evaluate(input({ spend }))), "float_cap");
  // On the minting side OI is reported instead, because that is the knob to turn.
  assert.equal(
    reasonOf(evaluate(input({ candidate: candidate({ kind: "writerAsk" }), spend: { ...spend, oiUsd: 2500 } }))),
    "oi_cap",
  );
});

test("partial headroom fills PARTIALLY rather than refusing", () => {
  // $27 of wallet headroom at $9/contract => 3 contracts, not zero and not 5.
  const spend = { ...ZERO_SPEND, walletSpentTodayUsdc: 250 - 27 };
  const d = evaluate(input({ spend }));
  assert.equal(d.fill, true);
  if (!d.fill) return;
  assert.equal(d.quantity, 3);
  assert.equal(d.costUsdc, 27);
});

test("per-fill cap truncates a large order", () => {
  // 40 contracts available at $9 = $360, but maxFillUsdc is $100 => 11 contracts.
  const d = evaluate(input({ candidate: candidate({ quantityRemaining: 40 }) }));
  assert.equal(d.fill, true);
  if (!d.fill) return;
  assert.equal(d.quantity, 11);
  assert.ok(d.costUsdc <= LIMITS.maxFillUsdc);
});

test("a single contract priced above the per-fill cap is refused, not rounded up", () => {
  const d = evaluate(input({ candidate: candidate({ priceUsdc: 900, quantityRemaining: 1 }), fairUsdc: 1000 }));
  assert.equal(d.fill, false);
  if (d.fill) return;
  assert.equal(d.reason, "wallet_budget");
  assert.equal(d.detail, "price exceeds per-fill cap");
});

test("affordableQuantity never exceeds ANY single limit", () => {
  // Property check across a grid — the min() is easy to get subtly wrong, and
  // the OI term divides by a DIFFERENT denominator than the cash terms.
  for (const price of [0.01, 1, 7.5, 99]) {
    for (const walletSpent of [0, 100, 249]) {
      for (const floatNow of [0, 5000, 9950]) {
       for (const kind of ["resaleAsk", "writerAsk"] as const) {
        for (const oiNow of [0, 1200, 2499]) {
        const spend = { walletSpentTodayUsdc: walletSpent, globalSpentTodayUsdc: 0, floatUsdc: floatNow, oiUsd: oiNow };
        const c = candidate({ kind, priceUsdc: price, strikeUsd: 100, quantityRemaining: 1e6 });
        const q = affordableQuantity(c, LIMITS, spend);
        const cost = q * price;
        assert.ok(cost <= LIMITS.maxFillUsdc + 1e-9, `per-fill (${cost})`);
        assert.ok(cost <= LIMITS.maxPerWalletDayUsdc - walletSpent + 1e-9, `wallet (${cost})`);
        assert.ok(cost <= LIMITS.maxFloatUsdc - floatNow + 1e-9, `float (${cost})`);
        // OI bounds the MINTING side only, and in strike units.
        const oi = oiCreatedUsd(c, q);
        assert.ok(oi <= LIMITS.maxOiUsd - oiNow + 1e-9, `oi (${oi}) for ${kind}`);
        if (kind === "resaleAsk") assert.equal(oi, 0, "resale never creates OI");
        }
       }
      }
    }
  }
});

// ---------------------------------------------------------------------------
// Gate ORDER — cheap and absolute gates must run before expensive ones
// ---------------------------------------------------------------------------

test("identity beats everything: an internal owner is refused even with no fair value", () => {
  // If this inverted, the bot would spend a quote round-trip on every one of our
  // own ~230 orders each tick.
  assert.equal(reasonOf(evaluate(input({ candidate: candidate({ owner: BOT }), fairUsdc: null }))), "internal_owner");
});

test("preScreen and evaluate agree on every fair-value-independent gate", () => {
  // preScreen exists purely to avoid paying for quotes. If it ever disagrees
  // with evaluate, the bot skips orders it would have filled — silently.
  const cases: Partial<EvalInput>[] = [
    { candidate: candidate({ owner: TAKER }) },
    { candidate: candidate({ owner: BOT }) },
    { isWallet: () => false },
    { candidate: candidate({ isEuropean: true }) },
    { candidate: candidate({ expiryTs: NOW + 60 }) },
    { candidate: candidate({ quantityRemaining: 0 }) },
    { delayUntilSecs: NOW + 30 },
    {}, // the passing case: preScreen must return null
  ];
  for (const over of cases) {
    const inp = input(over);
    const pre = preScreen(inp);
    const full = evaluate(inp);
    if (pre === null) {
      assert.equal(full.fill, true, "preScreen passed, so evaluate must not refuse on a pre-screen reason");
    } else {
      assert.equal(full.fill, false);
      assert.equal(pre.reason, (full as { reason: string }).reason, "same reason from both");
    }
  }
});

test("identityGate agrees with preScreen and needs only the maker pubkey", () => {
  // The tick calls identityGate BEFORE reading the vault, so a settled order
  // owned by us is attributed to `internal_owner` and not to `settled`. The
  // smoke run against devnet showed the wrong attribution before this split.
  const ctx = { isInternal: (pk: string) => pk === BOT, isWallet: () => true, takerWallet: TAKER };
  assert.equal(identityGate(TAKER, ctx)?.reason, "self_owned");
  assert.equal(identityGate(BOT, ctx)?.reason, "internal_owner");
  assert.equal(identityGate(USER, { ...ctx, isWallet: () => false })?.reason, "not_a_wallet");
  assert.equal(identityGate(USER, ctx), null);

  // And it must never disagree with preScreen, which calls it.
  for (const owner of [TAKER, BOT, USER]) {
    const inp = input({ candidate: candidate({ owner }) });
    const viaGate = identityGate(owner, inp);
    const viaPre = preScreen(inp);
    if (viaGate) assert.equal(viaPre?.reason, viaGate.reason, `${owner} rejected identically`);
    else assert.equal(viaPre, null, `${owner} passes both`);
  }
});

test("identity is attributed BEFORE series state, not after", () => {
  // Regression on log-attribution: our own settled orders must count as
  // internal_owner. If the ordering flips, the tally under-reports how much of
  // the board is ours and over-reports dead series.
  const ourSettledOrder = candidate({ owner: BOT, expiryTs: NOW - 86_400 });
  const d = evaluate(input({ candidate: ourSettledOrder }));
  assert.equal(d.fill, false);
  if (d.fill) return;
  assert.equal(d.reason, "internal_owner", "identity wins over expiry/series state");
});

test("preScreen never needs a fair value to reach its verdict", () => {
  // Structural guarantee: PreScreenInput has no fairUsdc field, so a future edit
  // cannot make the cheap path depend on the expensive one without a type error.
  const { fairUsdc, spend, ...rest } = input();
  void fairUsdc; void spend;
  assert.equal(preScreen(rest), null);
});

// ---------------------------------------------------------------------------
// WriterAsk — the MINTING side. Creates open interest instead of moving it.
// ---------------------------------------------------------------------------

const writerAsk = (over: Partial<Candidate> = {}): Candidate =>
  candidate({ kind: "writerAsk", strikeUsd: 100, ...over });

test("writerAsk: a genuine user write fills and reports the OI it creates", () => {
  const d = evaluate(input({ candidate: writerAsk() }));
  assert.equal(d.fill, true);
  if (!d.fill) return;
  assert.equal(d.quantity, 5);
  assert.equal(d.costUsdc, 45);            // premium paid: 5 x $9
  assert.equal(d.oiCreatedUsd, 500);       // OI created: 5 x $100 strike
});

test("resaleAsk creates NO open interest — it transfers, it does not mint", () => {
  // The distinction the whole cap rests on. A resaleAsk fill moves an existing
  // position to us; nothing new comes into being, so OI must not move.
  const d = evaluate(input({ candidate: candidate({ strikeUsd: 100 }) }));
  assert.equal(d.fill, true);
  if (!d.fill) return;
  assert.equal(d.oiCreatedUsd, 0);
});

test("OI cap refuses a writerAsk once exhausted, and names OI as the reason", () => {
  const d = evaluate(input({ candidate: writerAsk(), spend: { ...ZERO_SPEND, oiUsd: 2500 } }));
  assert.equal(d.fill, false);
  if (d.fill) return;
  assert.equal(d.reason, "oi_cap");
});

test("OI cap does NOT constrain resaleAsk, even when fully exhausted", () => {
  // Exiting a holder is exactly what the treasury is for, and it adds no OI.
  // A shared cap would shut the useful side off because of the risky one.
  assert.equal(reasonOf(evaluate(input({ spend: { ...ZERO_SPEND, oiUsd: 2500 } }))), "FILL");
});

test("OI sizes on STRIKE, not premium — the cap binds long before float does", () => {
  // 25 contracts available, $9 premium each ($225 total, trivially affordable),
  // $100 strike. maxOiUsd=2500 allows 25 by OI... but maxFillUsdc=$100 allows
  // only 11 by cash. The tighter of the two must win.
  const d = evaluate(input({ candidate: writerAsk({ quantityRemaining: 25 }) }));
  assert.equal(d.fill, true);
  if (!d.fill) return;
  assert.equal(d.quantity, 11, "cash cap binds here");
  assert.equal(d.oiCreatedUsd, 1100);

  // Raise the cash caps and OI becomes the binding constraint at 25.
  const loose = { ...LIMITS, maxFillUsdc: 100_000, maxPerWalletDayUsdc: 100_000, maxGlobalDayUsdc: 100_000 };
  const d2 = evaluate(input({ candidate: writerAsk({ quantityRemaining: 100 }), limits: loose }));
  assert.equal(d2.fill, true);
  if (!d2.fill) return;
  assert.equal(d2.quantity, 25, "OI cap binds: 2500 / 100 strike");
  assert.equal(d2.oiCreatedUsd, 2500);
});

test("OI headroom partially fills rather than refusing", () => {
  const loose = { ...LIMITS, maxFillUsdc: 100_000, maxPerWalletDayUsdc: 100_000, maxGlobalDayUsdc: 100_000 };
  const d = evaluate(input({
    candidate: writerAsk({ quantityRemaining: 100 }),
    limits: loose,
    spend: { ...ZERO_SPEND, oiUsd: 2200 },   // $300 of OI headroom => 3 contracts
  }));
  assert.equal(d.fill, true);
  if (!d.fill) return;
  assert.equal(d.quantity, 3);
  assert.equal(d.oiCreatedUsd, 300);
});

test("writerAsk with an unreadable strike FAILS CLOSED", () => {
  // A zero/missing strike would make OI look free. Treating "unknown" as "zero"
  // is exactly how a cap silently stops capping.
  for (const strikeUsd of [0, -1, Number.NaN]) {
    const d = evaluate(input({ candidate: writerAsk({ strikeUsd }) }));
    assert.equal(d.fill, false, `strike ${strikeUsd} refused`);
    if (d.fill) return;
    assert.equal(d.reason, "oi_cap");
  }
  // …while a resaleAsk is unaffected: it never needs the strike.
  assert.equal(reasonOf(evaluate(input({ candidate: candidate({ strikeUsd: 0 }) }))), "FILL");
});

test("oiCreatedUsd is zero for resaleAsk at every quantity", () => {
  for (const q of [1, 7, 1000]) {
    assert.equal(oiCreatedUsd(candidate({ strikeUsd: 250 }), q), 0);
    assert.equal(oiCreatedUsd(writerAsk({ strikeUsd: 250 }), q), 250 * q);
  }
});

// ---------------------------------------------------------------------------
// IDENTITY ON THE WRITERASK SIDE — the fixture that matters most in production
// ---------------------------------------------------------------------------

test("ALL-WRITERASK INTERNAL BOOK: zero candidates survive identity", () => {
  // This IS the live board: 309 of 323 asks are the writer bot's writerAsks.
  // Before this extension, identityGate protected against an edge case. Now it
  // is the only thing between the treasury and buying its own market-maker's
  // inventory, one mint-on-fill at a time, all day.
  const book = Array.from({ length: 309 }, (_, i) =>
    writerAsk({ orderPk: `WA${i}`, owner: BOT }));

  let eligible = 0;
  for (const c of book) {
    const d = evaluate(input({ candidate: c }));
    if (d.fill) eligible++;
    else assert.equal(d.reason, "internal_owner", `${c.orderPk} refused for identity`);
  }
  assert.equal(eligible, 0, "not one internal writerAsk is fillable");
});

test("ALL-WRITERASK INTERNAL BOOK: identity holds when every other gate would pass", () => {
  // The strongest form: perfectly priced, in band, delay elapsed, budgets empty,
  // OI empty. Only identity stands between us and 309 wash fills.
  const d = evaluate(input({
    candidate: writerAsk({ owner: BOT, priceUsdc: 7 }),   // 30% under fair — squarely in band
    spend: ZERO_SPEND,
    delayUntilSecs: 0,
  }));
  assert.equal(d.fill, false);
  if (d.fill) return;
  assert.equal(d.reason, "internal_owner");
});

test("the ONE external writerAsk in an otherwise-internal book is found", () => {
  // Mirrors the live book exactly: 309 internal + 1 external (2uqTc8xg…).
  // A gate that refuses everything is not safe, it is broken — this is the test
  // that tells the two apart.
  const EXTERNAL = "2uqTc8xg83bb6LXSYoJmY3vxmEoc8QebhCbijrVVVRVv";
  const book = [
    ...Array.from({ length: 309 }, (_, i) => writerAsk({ orderPk: `WA${i}`, owner: BOT })),
    writerAsk({ orderPk: "REAL", owner: EXTERNAL }),
  ];
  const fillable = book.filter((c) => evaluate(input({ candidate: c })).fill);
  assert.equal(fillable.length, 1);
  assert.equal(fillable[0].orderPk, "REAL");
});
