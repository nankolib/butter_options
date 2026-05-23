# 02 — Options 101 for Builders

This is the doc that compensates for not knowing options. Read it once front-to-back, then keep it open as reference. Every term in here will show up in specs. By the end you should be able to read a spec like "show delta and theta for the selected contract, suppress display when the vol oracle is in warmup" and know what every word means.

We'll use a running example throughout: SOL trading at $200. Every concept gets demonstrated against that one number. It builds intuition faster than abstract definitions.

1. What an option actually is

An option is a contract that gives the buyer the right (but not the obligation) to buy or sell an asset at a fixed price, on or before a fixed date, in exchange for a fee paid upfront.

Three things to internalize:

- The buyer pays once, upfront. That fee is called the premium. It's gone whether the buyer uses the option or not.
- The buyer has the right, not the obligation. They can walk away. The seller cannot.
- The seller (called the writer) has the obligation. If the buyer decides to use the option, the writer must honor it. In exchange, the writer pockets the premium.

Why does this exist? Because people want asymmetric exposure. A buyer pays a small known amount (premium) for the chance at a much larger payoff if the market moves their way. A writer collects a small certain amount (premium) in exchange for taking on a tail risk. Each side is happy with the trade for their own reasons.

That asymmetry is the whole point of options. Stocks/tokens are symmetric — you make money if the price goes up, you lose money if it goes down, roughly in proportion. Options break that symmetry.

2. Calls and puts

There are two flavors of option contract. Just two. Every option in the world is one of these.

A call option gives the buyer the right to buy the underlying asset at the strike price.

If you buy a SOL $250 call expiring in 30 days, you're paying for the right to buy SOL at $250 a month from now. You'd only use that right if SOL is trading above $250 when the option expires — say, $280. Then you pay $250 (using the option), the asset is worth $280, you pocket the $30 difference. If SOL is below $250 at expiry, you let the option expire worthless — why would you pay $250 for something worth $200?

So calls are bullish bets. You buy calls when you think the price is going up.

A put option gives the buyer the right to sell the underlying asset at the strike price.

If you buy a SOL $180 put expiring in 30 days, you're paying for the right to sell SOL at $180 a month from now. You'd only use that right if SOL is below $180 — say, $150. Then you sell at $180, even though the market is $150, and pocket the $30 difference. If SOL is above $180 at expiry, you let the put expire worthless.

So puts are bearish bets. You buy puts when you think the price is going down — or when you already own the asset and want insurance against it dropping.

Sellers are on the other side. A call writer is betting the price won't go above the strike. A put writer is betting the price won't go below the strike. They collect the premium and hope the option expires worthless.

That's it. Calls and puts. Every option is one of these two, and every position is either long (you bought it) or short (you wrote it). Four combinations total: long call, short call, long put, short put. Spend a minute making sure each makes sense.

3. The four parties involved

Any options trade has these roles:

- The buyer (also called the holder or long) — pays premium, has the right
- The seller (also called the writer or short) — receives premium, has the obligation
- The underlying asset — the thing the option is on (SOL, BTC, TSLA, gold, EUR/USD, whatever)
- The exchange or protocol — the venue that matches buyers and writers, holds collateral, enforces settlement

On Opta, the protocol is the exchange. We hold the writer's collateral, mint the option token, match it to a buyer (currently via vault), and execute settlement at expiry. Token-2022 makes this self-enforcing — the token itself blocks transfers after expiry and the protocol burns it during settlement.

4. The three numbers that define every contract

Every option contract is defined by three numbers (plus call-or-put):

Strike price. The fixed price at which the buyer can exercise the option. For our SOL $250 call, $250 is the strike. The strike is set when the option is created and never changes.

Expiry (or expiration). The date and time the option dies. After expiry, the option is either exercised (cashed in) or worthless (let expire). Expiries on professional venues are typically standardized — daily, weekly, monthly, quarterly. On Opta, expiries are set per-vault and can be any future timestamp (within reason).

Premium. The price the buyer pays the writer for the contract. This is what trades around on the secondary market and what writers earn for taking the risk.

The premium is the only one of the three that's priced — strike and expiry are chosen, premium is calculated (or quoted on a market). Most of the math in options is about figuring out what the premium should be. That's where Black-Scholes comes in (more later).

A complete option spec reads like: "SOL $250 Call, expiring 2026-06-30, premium $8.50." Now you know how to read that.

5. Moneyness — in/at/out of the money

Constantly used jargon. Three terms:

In-the-money (ITM). The option would be profitable to exercise right now.

- A call is ITM when spot > strike (e.g., SOL at $260 with a $250 call)
- A put is ITM when spot < strike (e.g., SOL at $170 with a $180 put)

At-the-money (ATM). Spot is roughly equal to strike. (E.g., SOL at $200 with a $200 call or put.) ATM options are the most actively traded because they have the most uncertainty about what happens next.

Out-of-the-money (OTM). The option would not be profitable to exercise right now.

- A call is OTM when spot < strike (e.g., SOL at $190 with a $250 call)
- A put is OTM when spot > strike (e.g., SOL at $210 with a $180 put)

An OTM option still has some value (the premium isn't zero) because there's time for the market to move ITM before expiry. That value is called time value. ITM options have intrinsic value (the difference between spot and strike) plus time value. OTM options have only time value. ATM options have only time value, but a lot of it.

This terminology shows up everywhere — in specs ("display the ITM badge on rows where..."), in charts ("OTM strikes are stacked below ATM"), in trader conversation ("buy the 250 call, it's barely OTM").

6. European vs American — the exercise style

This is critical for Opta because we are about to support both.

A European option can only be exercised at expiry. Not before. The holder waits until the expiration moment, and then either settlement happens (if ITM) or the option expires worthless (if OTM). Simple, predictable, mathematically clean.

An American option can be exercised any time up to and including expiry. The holder can decide on day 1, day 15, or day 30 to use the option. This optionality (literally) makes American options more valuable than European options on the same strike and expiry — the holder has more flexibility.

Why does this matter?

- Pricing. European options have a closed-form formula (Black-Scholes, 1973). American options don't — they need an approximation (we use BS-2002, the Bjerksund-Stensland 2002 formula) or a numerical method. American pricing is harder, more compute-intensive, and slightly less precise.
- Settlement. European options only settle once, at expiry. American options can settle whenever the holder chooses, plus auto-settle leftover positions at expiry.
- Secondary market dynamics. With an American option, a holder always has three choices: hold, exercise, or sell. If there's a liquid secondary market with a price floor at intrinsic value (because arbitrage forces it), the holder usually sells rather than exercises. This means American options on Opta should mostly not trigger early exercise — they should trade like European options most of the time, with the early-exercise right acting as a price floor. Nice property; it makes writer economics healthier.

What Opta does: European is shipped on devnet today. American is the Phase 2 build — the math kernel (BS-2002), the realized-vol oracle, and the first production handler are all on devnet now. The remaining Phase 2 stages add American vault instructions, a dedicated American exercise instruction, and an American settlement branch. Both styles will be supported in parallel; the writer chooses when creating a vault.

When you see "exercise style" in a spec, that's what it's referring to: European or American.

7. Settlement — what happens at expiry

Settlement is the moment the option contract resolves. Two things can happen:

Cash settlement. If the option is ITM, the writer pays the holder the difference between spot and strike (in USDC, on Opta). The underlying asset never changes hands; only money moves. This is what Opta does.

Physical settlement. The actual underlying asset changes hands. (Traditional equity options on regulated venues sometimes work this way.) Opta does not do physical settlement.

On Opta specifically:

- At expiry, a crank (any anyone-can-run bot) calls settle_expiry for each option, which reads the Pyth EMA price at expiry-time (with a 60-second window) and writes it to a SettlementRecord account.
- Then auto_finalize_holders runs for each option mint. It burns every holder's tokens via the PermanentDelegate extension, and if the option was ITM, transfers their proportional share of the payoff in USDC.
- Then auto_finalize_writers returns the writers' remaining collateral plus their earned premium.
- The holder never has to do anything. The writer never has to do anything. They wake up the next morning with the right USDC balance.

That "no clicks at expiry" is the living-token mechanic in action.

There's a 24-hour holders-first lockup after settlement: writers can't withdraw their collateral for 24 hours after the settlement record is written. This window exists to ensure all holder payouts complete cleanly before writer-side cleanup runs.

8. The Greeks — what they are and why traders read them

The "Greeks" are sensitivities. They tell you how the option's price (premium) changes when something about the world changes. Every serious options trader reads Greeks before they read price. Greeks are non-negotiable on a professional trade page.

There are five. You will see all of them in specs.

Delta (Δ). How much the option's premium changes for a $1 change in the underlying price.

- Calls have positive delta (0 to +1). A call with 0.5 delta gains $0.50 when the underlying gains $1.
- Puts have negative delta (0 to −1). A put with −0.5 delta gains $0.50 when the underlying drops $1.
- ATM options have delta ≈ ±0.5. Deep-ITM options approach ±1 (they move 1-for-1 with the underlying). Deep-OTM options approach 0 (they barely move).
- Delta is also informally interpreted as "probability the option finishes ITM," which is a useful trader heuristic even though it's not exactly true.

Gamma (Γ). How much delta changes for a $1 change in the underlying. Gamma is highest for ATM options near expiry — it's a measure of how rapidly delta is shifting. High gamma means the position's directional exposure changes fast as the market moves. This is what makes near-expiry ATM options exciting (or terrifying).

Vega. How much the premium changes for a 1% change in implied volatility. Higher vol = higher premium, always. Vega is highest for long-dated ATM options. Sellers of options are short vega (they lose when vol goes up); buyers are long vega (they gain). Vega is the entire reason vol is a tradable thing.

Theta (Θ). How much the premium decays per day, assuming nothing else changes. Theta is always negative for the long side (you lose money as time passes if nothing moves) and positive for the short side (writers earn theta — that's where their profit comes from). Theta accelerates as expiry approaches; near-expiry options bleed value fast. Traders call this "theta decay" or just "theta."

Rho (ρ). How much the premium changes for a 1% change in the risk-free rate. Mostly small and often ignored in crypto where the risk-free rate is roughly constant. On Opta the risk-free rate is currently a constant (5%) and rho is more of a completeness checkbox than a trading signal.

In specs, you'll see Greeks displayed in panels. Standard layout (Deribit-style): a small box showing delta, gamma, vega, theta, sometimes rho, for the currently selected contract. Bold-weighted by importance (delta and theta most-read).

Greeks are computed client-side from the spot price, strike, time-to-expiry, vol, and rate. You don't need an on-chain instruction to display them. We have Black-Scholes formulas in TypeScript already (app/src/utils/blackScholes.ts); Greeks are simple derivatives of those formulas.

9. Implied vol vs realized vol

Volatility is the most important variable in options pricing after the spot price. It deserves its own section.

Realized volatility (RV) is what actually happened. It's calculated from historical price data: take log returns over some window, compute the standard deviation, annualize it. "30-day realized vol" means "the standard deviation of daily returns over the last 30 days, expressed as an annualized percentage." It's a backward-looking, factual number.

Implied volatility (IV) is what the market is pricing in. It's the volatility number that, when plugged into Black-Scholes, makes the formula spit out the current market price of the option. Forward-looking, derived from prices.

IV is what trades. When a trader says "vol is up today," they mean IV. When you hear "the vol surface" or "vol skew" or "vol smile," it's all IV.

RV is the reference. IV is the bet.

On Opta:

- Realized vol is what the on-chain vol oracle computes. There's a per-asset oracle that samples spot prices hourly, stores them in a ring buffer, and computes a 30-day annualized realized vol on demand. This number is what the on-chain BS-2002 pricer uses for American options.
- Implied vol is not directly stored on-chain. It can be derived client-side from observed market prices (premium → BS-implied vol). This is useful for charts, vol surface displays, and trader analytics.

The interesting future state is an implied vol oracle — a permissionless on-chain source of IV by aggregating market prices across venues. That's not built; it's roadmap (Phase 4+). For now, RV oracle is what's live.

10. Liquidity models — order books vs vaults

This is the section that explains the architectural conversation we're about to have.

Order book. The classic structure. Buyers post bids ("I'll buy at $8.50"), sellers post asks ("I'll sell at $9.00"), the venue matches them when prices cross. Every strike, every expiry, every side has its own book. Liquidity is fragmented but price discovery is sharp. Market makers stand on both sides and earn the spread. This is how Deribit works. This is how every major options exchange works.

Pooled / vault liquidity. A newer DeFi structure. Writers deposit collateral into a shared pool, the pool mints option tokens at multiple strikes against the shared collateral, buyers purchase from the pool at a price computed from a pricing model. No order book, no per-strike fragmentation, but also no real price discovery — the protocol quotes a price, it doesn't discover one. This is how Ribbon, Friktion, and other "DeFi options vaults" work, and it's how Opta currently works.

Which is better? Both have strengths. Order books are familiar to professional traders, provide tight price discovery when there's enough flow, and let market makers run sophisticated strategies. Vaults are simpler, work without market makers, work even at low volume, and provide passive yield to depositors.

Opta today is vault-only. Phase 2 keeps it that way; vaults work for both European (live) and American (Phase 2 build).

Opta tomorrow is both. The post-Phase-2 exchange build adds an order book layer on top of the existing vault primitive. Vaults remain as passive writer liquidity; market makers come in via the order book and provide active two-sided liquidity. Both feed the same Token-2022 option mints. Whether the two surfaces are converged (vaults expose their inventory as resting offers on the book) or coexisting (separate venues for the same underlying mints) is one of the architectural decisions you and Nanko will make together. Doc 06 has more.

Why we have vaults at all: they were the right starting point. Vaults work from day one with zero market makers. Order books need market-maker commitments before they're usable — chicken-and-egg. The vault-first sequencing got Opta to a working devnet product faster. Now that there's a real product, the order book layer can be built on top with the existing vault liquidity as a backstop.

11. Common strategies you'll hear about

You don't need to be able to construct these. You need to recognize the names when traders mention them, and know what UI requirements they imply (mostly multi-leg trading flows).

- Covered call. Own the asset, sell a call against it. Generates yield in flat or slowly-rising markets. Capped upside, full downside. Very common writer strategy.
- Protective put. Own the asset, buy a put against it. Insurance against a drop. Costs premium but caps your downside. Common holder strategy.
- Vertical spread. Buy one option, sell another at a different strike, same expiry. Limits both upside and downside. Cheaper than a naked call/put. Bull call spread, bear put spread, etc.
- Calendar spread. Buy one option, sell another at the same strike, different expiry. Bets on changes in the term structure of vol.
- Straddle. Buy a call and a put at the same strike, same expiry. Bets that the underlying will move a lot (in either direction). Long vol.
- Strangle. Like a straddle but with different strikes (usually OTM on both sides). Cheaper, needs a bigger move to pay off.
- Iron condor. A combination of a bull put spread and a bear call spread. Bets that the underlying will not move much. Short vol.
- Collar. Own the asset, buy a put (downside protection), sell a call (finance the put). Caps both upside and downside. Used by treasuries to lock in a range.

The exchange build will eventually need a multi-leg strategy builder in the UI — a panel where a trader can construct any of the above, see the combined payoff diagram, and submit the legs atomically. This is in scope for the exchange but not for Demo Day.

12. Cheat sheet — every term defined

Quick lookup table for every term that appeared in this doc.

- At-the-money (ATM) — spot ≈ strike
- Call — right to buy at strike
- Cash settlement — payoff in money, not the underlying asset
- Delta (Δ) — sensitivity of premium to spot price
- European / American — exercisable only at expiry / any time
- Exercise — using the option's right (buying via a call, selling via a put)
- Expiry — the date/time the option dies
- Gamma (Γ) — sensitivity of delta to spot price
- Greek — any of delta, gamma, vega, theta, rho
- Holder — buyer (long side)
- Implied vol (IV) — vol the market is pricing in
- In-the-money (ITM) — option would be profitable to exercise
- Intrinsic value — for ITM options, the difference between spot and strike
- Leg — one component of a multi-option position
- Long / short — bought / sold
- Moneyness — ITM / ATM / OTM classification
- Option — contract conveying the right to buy or sell at a fixed price
- Out-of-the-money (OTM) — option would not be profitable to exercise
- Payoff — what the option pays at expiry as a function of spot
- Premium — price paid by buyer to writer for the contract
- Put — right to sell at strike
- Realized vol (RV) — historical vol from price data
- Rho (ρ) — sensitivity of premium to the risk-free rate
- Settlement — the process of resolving an option at expiry
- Spot — the current market price of the underlying
- Strike — the fixed price at which the option can be exercised
- Theta (Θ) — sensitivity of premium to time decay
- Time value — premium minus intrinsic value
- Underlying — the asset the option is on
- Vega — sensitivity of premium to implied vol
- Vol surface / vol smile / vol skew — the shape of IV across strikes and expiries
- Writer — seller (short side)

If anything in this doc is unclear, ask. If anything is wrong, push back. If anything is missing that you need for a specific spec, we'll add a section.

You don't need to memorize all of this on the first read. You need to read it once carefully, then keep it open as reference. After 2-3 weeks of working on specs, all of it will be second nature.
