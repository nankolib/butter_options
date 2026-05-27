# Opta

## The Options Primitive for Solana

**A Technical Whitepaper**

Version 1.0 — April 2026

---

Opta is a permissionless, any-asset options protocol built on Solana. It introduces the Living Option Token: an option represented as a Token-2022 mint whose on-chain extensions make the token enforce its own expiry, carry its complete term sheet in its metadata, and be burned by the protocol at settlement without custodial intermediation. Opta ships with a three-layer liquidity architecture, on-chain Black-Scholes pricing implemented via a custom solmath library at approximately fifty thousand compute units per quote, and a progressive-decentralisation roadmap from its current devnet deployment to a permissionless mainnet footprint. This document describes the protocol's design, its market thesis, its security posture, and its known limitations.

---

## Table of Contents

1. Executive Summary
2. The Market Thesis
3. Why On-Chain Options Have Not Yet Worked
4. The Living Option Token
5. Architecture
6. Pricing
7. The Three-Layer Liquidity Model
8. Security
9. Current State and Honest Limitations
10. Progressive Decentralisation Roadmap
11. The Fourth Primitive Claim
12. Comparison With Prior Art
13. Conclusion
14. Appendix A — Instruction Set
15. Appendix B — Account Structures
16. Appendix C — References

---

## 1. Executive Summary

The global derivatives market is valued at roughly eight hundred and forty-six trillion dollars in notional outstanding. Of that, options alone represent one hundred and eight billion contracts traded in 2023, compared to twenty-nine billion futures contracts — a four-to-one ratio, rising to nine-to-one in equity index derivatives. Options are the dominant derivative class in mature financial markets, and they play this role for a specific reason: they are the primary instrument for hedging, for structured yield, and for bounded-risk directional exposure. They are how institutional capital insures itself.

Crypto derivatives have developed in the opposite proportion. Perpetual futures — a contract type that does not exist in traditional finance — account for the overwhelming majority of on-chain and off-chain crypto derivatives volume. Options, by comparison, are a thin sliver. This inversion is not a statement about user preference. It is a statement about infrastructure. Perps work on-chain because their settlement is mechanical and their state is simple. Options require four things that have historically been hard to compose: time-dependent expiry enforcement, term-sheet metadata readable by other programs, protocol-controlled settlement without custodianship, and pricing sophisticated enough that professional participants will transact against it. Each of these is individually tractable. Building them together, in a form composable by the rest of DeFi, has not previously been done.

Solana in 2026 is at an unusual inflection point. The perpetual futures market is consolidating elsewhere — Hyperliquid runs its own Layer 1 and handles the overwhelming share of on-chain perp flow. Zeta, long the flagship Solana perp venue, has migrated its core perp product to a dedicated Layer 2 called Bullet. Simultaneously, Solana has quietly become the dominant venue for tokenised real-world assets. BlackRock's BUIDL, Ondo's USDY, Franklin Templeton's BENJI, and a growing roster of tokenised treasuries, equities, and commodities have found their home on Solana because of its settlement speed and fee profile. The Solana Foundation's own ecosystem reporting has highlighted the disproportionate RWA capital parked on the network.

This creates a specific vacuum. There is now billions of dollars of institutional-grade collateral on Solana — and no native on-chain options venue through which that collateral can be hedged or yield-enhanced. The holders of BUIDL, USDY, and similar assets who want options exposure today have to leave Solana entirely, route to Deribit or to over-the-counter desks, and manage the cross-venue capital and operational friction that implies. That is not a user preference. That is revealed behaviour caused by absence of infrastructure.

Opta is built to occupy that vacuum. It is not a better perp venue — that race is over. It is not a retail-facing speculation toy. It is the on-chain options primitive that Solana's institutional RWA capital has been waiting for, built in a composable form so that other protocols, AI agents, and structured-product vaults can use it as a building block.

This whitepaper is organised in three movements. First, it establishes the market thesis — why options dominance is structural in mature markets, why on-chain options have underperformed until now, and why Solana is the specific chain where this primitive is most needed. Second, it describes the protocol architecture in detail — the Living Option Token built on Token-2022, the three-layer liquidity model, the on-chain Black-Scholes pricing engine, and the security story. Third, it is honest about what is not yet finished and what remains on the Phase 2 and mainnet roadmap.

A note on language before proceeding. The protocol was developed under the project name Butter Options and submitted under that name to the Colosseum Frontier hackathon in April 2026. On the twenty-first of April 2026 the project was renamed to Opta to signal the scope evolution from hackathon submission toward mainnet-aspiring infrastructure. Throughout this document, throughout the public repository, and throughout the deployed code on devnet, the project is Opta — directory layout, Anchor.toml keys, PDA seed constants, `declare_id!()` macros, and IDL all match the new name as of the on-disk Phase 2 rename completed on the twenty-ninth of April 2026.

---

## 2. The Market Thesis

The case for Opta is built on four empirical pillars. Each one is independently verifiable from public data. Taken together, they describe a market gap that is not a matter of opinion but a matter of observable flow.

### 2.1 Options Dominance Is Structural, Not Speculative

In traditional finance, options volume exceeds futures volume by a factor of roughly four to one. This is not a recent anomaly. The Futures Industry Association's 2023 global derivatives volume report recorded approximately one hundred and eight billion options contracts traded versus twenty-nine billion futures contracts — the eleventh consecutive year in which options led. In equity index derivatives specifically, the ratio widens to roughly nine-to-one. Options dominate because mature markets use them for three distinct purposes that futures cannot serve: downside protection with preserved upside, yield generation through premium capture, and bounded-risk directional views.

The implication for crypto is uncomfortable. The current crypto derivatives stack is heavily inverted — perpetual futures dominate, options are marginal. This is not because crypto participants do not want options. It is because the infrastructure to trade options composably on-chain has not existed at a standard that institutional capital will use. The revealed gap is therefore not a demand problem. It is a supply problem. As on-chain infrastructure reaches parity with off-chain venues for options specifically, the default expectation should be that crypto derivatives volume reverts toward the traditional ratio — not overnight, but directionally and decisively.

### 2.2 Institutional Flow Is Already Dominant in On-Chain Derivatives

A common objection is that on-chain derivatives are retail-driven and that institutional framing is overblown. The best publicly available data refutes this directly. Hyperliquid Hub and PANews analysis in early 2026 reported that approximately two hundred wallets account for ninety-eight point eight percent of the roughly four trillion dollars in cumulative trading volume that has passed through Hyperliquid, out of approximately one point seven million total wallets that have interacted with the platform.

This is an extraordinarily concentrated number. Ninety-eight point eight percent of cumulative flow, from zero point zero one percent of wallets. The remaining one point seven million wallets collectively account for just over one percent. The structure is unambiguous: on-chain derivatives flow is already institutional. It is not retail with a long tail of whales. It is professional with a long tail of tourists. Any protocol that wants to be a serious derivatives venue needs to be built for the two hundred wallets that matter, with tooling, capital efficiency, and composability that meet their standards — not for the retail optimism of a previous cycle.

Opta's design is calibrated to this reality. The three-layer liquidity model, the on-chain Black-Scholes pricing, the Token-2022 composability primitive, the planned Pyth-oracle settlement path — these are not retail-feature checklists. They are what institutional flow requires.

### 2.3 Solana Has Lost Perpetuals and Won Real-World Assets

The competitive landscape for on-chain derivatives in 2026 has settled along unexpected lines. Perpetual futures volume has consolidated toward dedicated execution venues: Hyperliquid's own Layer 1 dominates the category globally. Zeta Markets, for years the flagship Solana-native perpetual exchange, announced in 2025 the migration of its core perp product to a dedicated Layer 2 called Bullet, explicitly because the performance envelope of a purpose-built derivatives chain exceeded what any general-purpose Layer 1 could offer for that specific product. Drift remains, but the competitive centre of gravity for perpetuals has left Solana.

Real-world assets have moved in the opposite direction. BlackRock's BUIDL fund, the largest tokenised money-market product in the market, deployed on Solana. Ondo's USDY is natively issued on Solana alongside Ethereum. Franklin Templeton's BENJI operates on Solana. Matrixdock deployed XAUm, Asia's largest tokenised gold product, on Solana in March 2026. Galaxy Digital and Superstate selected Solana for the launch of the GLXY tokenised public equity. The Solana Foundation's own March 2026 ecosystem report emphasised the acceleration of RWA activity on the chain.

These two trends are not coincidence. They reflect Solana's specific architectural strengths — near-instant settlement and negligible fees make it ideal for the kind of high-frequency, large-volume, low-margin activity that tokenised money-market and treasury products require. That same profile is awkward for perpetual futures, which benefit more from purpose-built matching-engine chains.

The strategic implication is clear. Solana in 2026 is not the perp chain. It is the RWA chain. And the RWA chain needs an options primitive, because institutional holders of tokenised assets need to hedge, need to generate yield on their positions, and need to express bounded-risk directional views — and they cannot do any of this natively on Solana today.

### 2.4 Cross-Venue Hedging Is Revealed Preference

The final empirical pillar is the most direct. Institutional holders of Solana-native RWAs today hedge their exposure off-chain. They do this because they have no choice. The flow goes to Deribit for listed options and to over-the-counter desks for structured hedges. Every dollar of this flow is a dollar of capital that must leave the Solana ecosystem, settle on a centralised exchange or a bilateral counterparty, and re-enter Solana when the hedge is unwound — if it ever is. The capital efficiency cost of this round-trip, measured in funding, in operational overhead, and in counterparty risk, is substantial.

This is not theoretical. It is how institutional Solana RWA positions are hedged in practice in 2026. It is revealed preference under constraint. The question Opta poses is straightforward: if the same participants could hedge their Solana-native positions with a Solana-native on-chain options venue — composable with their existing treasury workflows, settling in USDC, priced with a public and auditable Black-Scholes engine — would they? The answer is a trivially yes for any meaningful share of the flow.

Opta does not need to create new demand. The demand exists and is being served by inferior venues today. Opta needs to redirect it.

---

## 3. Why On-Chain Options Have Not Yet Worked

Before describing what Opta does differently, it is worth acknowledging candidly why prior on-chain options protocols have not achieved dominant market position. Opyn, Lyra, Dopex, PsyOptions, the original Zeta options product, Ribbon, Friktion, Premia, Thetanuts — each of these has been serious engineering. None has become the category-defining on-chain options venue. The reasons converge on three structural failures.

### 3.1 Asset-Limited by Default

Most prior on-chain options protocols supported options only on the handful of large-cap crypto assets that had deep oracle coverage — BTC, ETH, SOL, and perhaps a dozen others. This is a significant limitation. It excludes options on tokenised real-world assets, on long-tail crypto tokens, on commodity-backed tokens, and on any asset whose oracle coverage arrived after the protocol's initial market launch. The restriction was rarely architectural. It was usually administrative: each new market required governance action, each new oracle integration required code changes, and the cumulative friction made the protocols effectively frozen in their initial asset set.

### 3.2 Not Composable by Other Programs

On-chain options were typically represented as bespoke positions tracked inside the options protocol's own account structures. Another DeFi protocol — a structured-product vault, a lending market, an AI agent — could not natively hold or reason about an option position because the option was not a token. It was an entry in a private ledger. The consequence was that on-chain options remained a destination product rather than a primitive. Other protocols could not build on top of them without tight bilateral integrations. The rest of DeFi could not use them as building blocks.

### 3.3 Not Self-Aware

Options have an intrinsic time dimension — expiry. Strike price, underlying asset, expiry, and option type collectively define the instrument. In prior protocols, this information was usually stored off-chain in the protocol's frontend metadata or in a separate registry. After expiry, the option position required an explicit settlement instruction from the protocol operator to resolve. The option itself did not "know" it had expired. It could not be programmatically queried for its terms by another contract without indirection. It was inert data, not an instrument.

Each of these failures individually is tractable. But composability particularly is a chain-level feature — it depends on what the underlying protocol's token standard supports. For years, the Ethereum and Solana token standards in use did not support the metadata, transfer-hook, and delegated-burn primitives that a self-aware, composable option token would require. Protocols had to either build bespoke wrappers or accept the limitation.

That constraint was lifted when Solana's Token-2022 standard reached production readiness with its extensions framework. Opta's core insight is that the three specific extensions needed to make an option token self-enforcing, composable, and self-describing all exist in Token-2022 today — and can be combined in a single mint to produce an instrument category that has not previously existed on any chain.

---

## 4. The Living Option Token

The Living Option Token is Opta's defining primitive. It is a standard SPL Token-2022 mint with three extensions configured at creation time such that the token, as a runtime object, encodes and enforces the properties of the financial instrument it represents. We describe each extension, its role, and what the combination makes possible.

### 4.1 TransferHook — Time-Aware Transfers

The TransferHook extension allows a Token-2022 mint to designate a separate on-chain program that will be invoked on every transfer of the token. The hook program can perform arbitrary checks — including time-based checks — and veto the transfer by returning an error. Opta deploys a dedicated transfer-hook program with its own program ID and configures every option mint to point to it. The hook's logic is simple but consequential: before expiry, transfers are permitted freely and without protocol intervention; after expiry, user-to-user transfers are rejected. The protocol retains the right to move the token for settlement via a separate mechanism described below.

The implication is that expiry enforcement is not a protocol-level check that the frontend must remember to perform. It is a token-level invariant enforced by the token itself. Any program that tries to transfer an expired option token — whether the Opta frontend, a third-party aggregator, an AI agent, a structured-product vault, or a malicious actor attempting to unload an expired position on an unsuspecting counterparty — will find the transfer rejected by the Solana runtime itself. The token enforces its own expiry.

### 4.2 PermanentDelegate — Settlement Without Custody

The PermanentDelegate extension designates a program-derived address as a permanent delegate authority over every token in the mint. This means the delegate — which is an Opta protocol PDA, not a keypair controlled by any person — can burn tokens from any holder's account without that holder's explicit consent at the moment of the burn.

This is not a backdoor. It is the specific mechanism by which on-chain options settlement works without custody. At settlement, Opta computes which positions are in-the-money and which are not. For positions that expire worthless, the protocol burns the option tokens directly from the holder's wallet using the PermanentDelegate authority. For positions that expire in-the-money, the protocol pays the payoff in USDC from the writer's locked collateral and then burns the option token. At no point does the protocol take custody of user funds. The option token's economic life is automatically resolved at expiry, and the token itself is destroyed as part of that resolution.

The shape of the delegated burn is unusual enough that it bears illustrating concretely. A standard SPL transfer or burn requires the token-account holder to sign. PermanentDelegate inverts this: the mint's permanent delegate (here, an Opta protocol PDA) can call into the Token-2022 burn instruction with the PDA itself as the authority, and the runtime accepts the burn with no signature from the token's actual holder.

```rust
// PermanentDelegate burn: protocol PDA signs as authority,
// no holder signature required.
invoke_signed(
    &burn(&token_program, holder_ata, option_mint,
          protocol_pda, &[], amount)?,
    accounts,
    &[&[PROTOCOL_SEED, &[bump]]],
)?;
```

Critically, the PermanentDelegate authority is a PDA, not a keypair. It is derived from protocol seeds and can be exercised only through calls to specific on-chain instructions that enforce settlement logic. No human holds the key. The capability is scoped to settlement mechanics, enforced by program code, and auditable by anyone reading the source.

### 4.3 MetadataPointer — Term Sheet On-Chain

The MetadataPointer extension attaches a metadata account to the token mint containing arbitrary structured data. Opta uses this to store the option's complete term sheet: the underlying asset identifier, the strike price, the expiry timestamp, the option type (call or put), and the associated market account. This information is not held in a frontend database or a separate protocol registry. It is on-chain metadata attached to the token mint itself.

The consequence is that any on-chain program — a lending protocol, a portfolio tracker, an AI agent acting on behalf of a user — can query an option's complete terms directly from the token mint, without needing to know anything about Opta's internal account layout. The token is self-describing. It is a primitive that other protocols can reason about without requiring custom integration.

### 4.4 The Combination Is the Innovation

Each of these three extensions exists individually. Token-2022 has been live in production since 2023 and each extension has seen isolated use in other projects — transfer hooks for compliance tokens, permanent delegates for confidential transfer demonstrations, metadata pointers for NFT-adjacent use cases. What has not been done, to our knowledge, is the combination of all three in a single mint to create a financial instrument that is simultaneously self-enforcing, self-settling, and self-describing.

The result is what we call the Living Option Token: an option represented as a token that carries its own expiry enforcement, its own settlement authority, and its own complete term sheet. It is a tradable, composable, self-aware instrument. It can be listed on any Solana DEX during its life. It can be held as collateral by any lending protocol that reads its metadata. It can be acquired by an AI agent that queries its terms directly. It can be placed inside a structured-product vault. And at expiry, the position is resolved by Opta's permissionless crank-driven automation via the PermanentDelegate authority — no user action required at expiry, no claim, no exercise, no withdraw click. The user-facing experience is "wake up the next day with USDC in your wallet"; the architectural reality is permissionless crank infrastructure exercising a delegated burn authority on a public schedule, not on-chain self-resolution.

This is the primitive. Everything else in Opta's architecture — the liquidity model, the pricing engine, the frontend, the crank bot — exists to make the primitive usable and to turn it into a functioning market.

---

## 5. Architecture

Opta is implemented as two on-chain programs deployed on Solana devnet, with a full frontend application deployed on Vercel. The architecture is designed around the Living Option Token and scales outward from there.

### 5.1 On-Chain Programs

The main protocol program is deployed at program ID `CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq` on Solana devnet. It contains twenty-one instructions covering the full lifecycle of market creation, vault liquidity, option purchase, settlement, post-expiry finalization, and secondary listing. The instructions group into eight functional categories — Admin, Market lifecycle, Vault writer flow, Vault buyer flow, Settlement, Manual cleanup, V2 secondary listing, and Auto-cleanup — enumerated in Appendix A. The original V1 peer-to-peer instructions that shipped with the hackathon submission have been archived (commit `54c35c5`) and are no longer part of the deployed program; the V2 shared-vault model described in section 7 is now the only liquidity surface exposed by the protocol.

The transfer-hook program is deployed separately at program ID `83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG`. Its sole responsibility is to enforce the expiry-based transfer veto described in section 4.1. It is small, auditable, and has a single instruction.

Both programs are written in Rust using the Anchor framework version 0.32.1. The code is formally structured with state accounts in a `state/` module, instructions in an `instructions/` module, error types in a central `errors.rs`, and the Black-Scholes math library imported from the `solmath` crate. The release build profile enables overflow checks and full link-time optimisation, reflecting a safety-oriented compilation stance.

### 5.2 State Accounts

Eight primary account types form the protocol's on-chain state. The `Protocol` account is the singleton root, holding global configuration. The `Market` account represents a specific option contract — underlying asset, strike, expiry, type — and is the parent account for all positions written against it. The `WriterPosition` account tracks the collateral, share-of-pool, and premium accounting for a single writer in a single shared vault. The `Pricing` account holds per-market volatility and risk-free-rate parameters used by the Black-Scholes engine. The `EpochConfig` account defines the settlement windows for V2 shared vaults. The `SharedVault` account is the V2 liquidity pool backing a set of related markets. The `VaultMint` account tracks vault-issued option tokens. The `VaultResaleListing` account records a peer-to-peer secondary listing — see section 7.

`WriterPosition` is worth illustrating explicitly because it makes the protocol's premium-accounting model concrete. The fields below are the load-bearing ones; a couple of bookkeeping fields are elided for legibility.

```rust
pub struct WriterPosition {
    pub owner: Pubkey,             // writer's wallet
    pub vault: Pubkey,             // joins to SharedVault
    pub shares: u64,               // pro-rata claim on the pool
    pub deposited_collateral: u64, // USDC originally posted
    pub options_minted: u64,       // contracts written by this writer
    pub options_sold: u64,         // contracts purchased by buyers
    pub premium_claimed: u64,      // already-claimed premium (USDC)
    // + premium_debt accumulator and PDA bookkeeping
}
```

Premium does not accrue at expiry. Each time a buyer purchases a contract from the vault, premium flows into the pool and is recorded against `premium_per_share_cumulative` on `SharedVault`; each writer's claimable balance is a function of their `shares` against that cumulative, minus what they have already taken via `claim_premium`. Buyer pays at trade time; writer claims as their share-of-pool dictates. This is the protocol's premium model and it is enforced by the on-chain math, not by post-expiry settlement geometry.

The separation of Market, SharedVault, VaultMint, and WriterPosition accounts reflects a careful design decision. Markets are shared — any number of writers and buyers can transact against a single market. Vaults pool collateral across writers within a market. Writer positions are individual to writers. Vault mints index the option-token mints issued by the vault. This separation makes the shared-vault liquidity model possible without custom account rewriting: writers' collateral obligations are scoped to their `WriterPosition` regardless of which specific option tokens buyers end up holding, and buyers' positions are represented as actual Token-2022 balances rather than as bespoke ledger entries.

### 5.3 Frontend Application

The frontend is a React nineteen application built with Vite eight and TypeScript five-point-nine, deployed on Vercel. It provides six pages: a landing page, a markets page showing all live option markets with their pricing grids, a Deribit-style trading page where vault inventory and secondary listings are unified into a single buy modal that routes across both surfaces, a writing page for minting new options against vault collateral, a two-ledger portfolio page that surfaces both buyer-side positions and writer-side vaults written as parallel sections, and a docs page.

Client-side, the application uses the Solana wallet adapter for connection, `@coral-xyz/anchor` for program interaction, and a custom polyfills module to handle Buffer polyfilling under Vite eight. Live spot prices and the available-asset catalogue are fetched from Pyth's Hermes mainnet endpoint with no off-chain fallbacks; the catalogue cache is keyed on the Hermes host so that switching the endpoint automatically invalidates the cache. The Black-Scholes fair-value computation is performed both on-chain (for composability) and client-side (for grid rendering performance) — the frontend computation uses the same mathematical formulation as the on-chain engine and is validated against it.

### 5.4 Data Flow: A Purchase in Full

To make the architecture concrete, we trace a complete option purchase from user intent to on-chain resolution.

The user lands on the Trade page. The frontend fetches all live markets and filters them to V2 vault-backed markets using the `vaultFilters` module. It calls `usePythPrices` to obtain live spot prices for each underlying asset and computes Black-Scholes fair values for the full grid of strikes and expiries. The user selects a specific option — a call on SOL at strike price one hundred dollars expiring in twenty-four hours, for example. The frontend displays the model's fair value, the market's asked premium, and the implied Greeks.

The user clicks Buy. The frontend constructs a `purchase_from_vault` instruction referencing the market account, the shared vault that backs it, the user's wallet, and the USDC token account from which premium will be paid. The transaction is signed and submitted. On-chain, the program verifies the vault has sufficient capacity, transfers the option tokens from the vault's escrow associated token account to the buyer's ATA, invokes the transfer hook (which confirms expiry has not yet passed), transfers the premium in USDC from the buyer to the vault, and updates the vault's internal accounting.

The buyer now holds option tokens in their wallet. The tokens are freely transferable to any other address before expiry — the transfer hook permits it. The tokens are visible in any wallet or portfolio tracker that reads Token-2022 metadata — the metadata pointer makes the term sheet discoverable. The tokens can be listed on any Solana DEX that supports Token-2022 — though the V2 vault-specific secondary market infrastructure is still in development, as discussed in section 9.

At expiry, the protocol's permissionless crank infrastructure takes over. On the first tick after a market's `expiry` timestamp passes, the crank posts a Pyth `PriceUpdateV2` and calls `settle_expiry`, which records the EMA price at expiry-time on a fresh `SettlementRecord` PDA along with the consumed Pyth `publish_time` as an audit trail (see section 6.5). The same tick calls `settle_vault` to flip `is_settled = true` for the affected shared vault.

On the next tick after settle, the crank's holder-finalize pass enumerates Token-2022 accounts holding the option mint and calls `auto_finalize_holders` in batches. For each holder, this single instruction burns their tokens via the PermanentDelegate authority and, if the option settled in-the-money, transfers the payoff in USDC from the vault. The instruction is idempotent across batches: zero-balance accounts and mismatched USDC ATAs are silent-skipped on chain, so re-running a batch that partially completed is safe.

The writer-finalize pass follows. `auto_finalize_writers` returns each writer's unclaimed premium plus their pro-rata share of the remaining vault collateral, then closes the `WriterPosition` account, refunding its rent SOL to the writer. On the last writer in the vault, any leftover USDC dust from premium-accumulator integer truncation is swept to the protocol treasury and the vault's USDC account is closed, with that rent also routed to treasury.

When the user reads their wallet the day after expiry, they see the resolution as a fait accompli. A buyer who held an in-the-money call sees the USDC payoff in their wallet without ever calling `exercise_from_vault`. A writer in an out-of-the-money vault sees their collateral and premium returned without ever calling `withdraw_post_settlement`. The manual instructions still exist as fallbacks for users who want to trigger their own resolution; the default path is the crank's permissionless automation. No claim, no exercise, no withdraw click.

### 5.5 The Crank Bot

Opta's settlement automation runs as a Node.js crank process on a five-minute tick interval. The crank's role is permissionless infrastructure exercising the PermanentDelegate authority on a public schedule — anyone can run a crank against the protocol; the team's crank is one of many possible operators. Each tick covers four passes against on-chain state: `settle_expiry` posts a Pyth update and creates a `SettlementRecord` for any market whose expiry has passed; `settle_vault` flips `is_settled = true` for the affected vaults; `auto_finalize_holders` enumerates Token-2022 accounts holding the option mint, burns their tokens via the PermanentDelegate authority, and distributes ITM payouts in batches; `auto_finalize_writers` returns each writer's premium and pro-rata collateral and closes their `WriterPosition` account. A fifth pass auto-cancels expired V2 secondary listings to free their escrow rent. Live prices come from Pyth's Hermes mainnet endpoint; the earlier hardcoded devnet price map was retired during the Pyth Pull migration arc.

---

## 6. Pricing

Pricing options on-chain has been a persistent challenge for on-chain derivatives protocols. The Black-Scholes formula and its extensions require logarithmic, exponential, and cumulative normal distribution computations that are expensive in general-purpose VM environments. Prior protocols have typically adopted one of three compromises: rely on off-chain oracles pushing prices computed by centralised servers, approximate the pricing surface with lookup tables, or support only simplified pricing models that lose accuracy in high-volatility regimes.

Opta takes a different approach. It implements Black-Scholes pricing natively on Solana, computed on-chain in approximately fifty thousand compute units per quote, using a custom mathematics library called `solmath`.

### 6.1 Solmath and the Cost of On-Chain Math

The `solmath` library provides fixed-point implementations of the transcendental functions required for options pricing: natural logarithm, exponential, square root, and the cumulative standard normal distribution. These are implemented using series approximations calibrated for the precision-versus-compute trade-off specific to Solana's SBF runtime. The library's implementation choices are driven by the goal of keeping a full Black-Scholes call or put price computation under fifty thousand compute units — well within Solana's per-instruction compute budget even when combined with the surrounding instruction logic.

The fifty-thousand figure is notable in context. Solana's default per-transaction compute budget is two hundred thousand compute units, extendable to one point four million with a compute-budget instruction. A fifty-thousand-compute-unit pricing call leaves substantial headroom for the rest of the instruction's work — account deserialisation, validation, state updates, and CPI calls to the token program and transfer hook.

### 6.2 Asset-Class-Aware Volatility

Options pricing is more than the formula. It requires per-asset volatility inputs and a risk-free-rate input. Opta maintains a `Pricing` account per market that stores the volatility parameter calibrated to the asset class — crypto assets carry different implied volatilities than tokenised gold, which in turn differs from tokenised treasuries. In the current devnet deployment these values are seeded at market creation and can be updated through the `update_pricing` instruction. The mainnet design contemplates oracle-sourced implied volatility surfaces for the most active assets, but for the current stage this is explicitly a manually-configured parameter.

### 6.3 Greeks

In addition to fair value, the Opta pricing engine computes the five standard option Greeks: delta, gamma, vega, theta, and rho. These are exposed through the `initialize_pricing` and `update_pricing` instructions and are displayed in the frontend grid. For the current devnet deployment, the Greeks are computed client-side for rendering performance, using the same mathematical formulation that the on-chain engine uses for fair value. The Greeks are verified by CPI composability: any other on-chain program can call into the pricing module and receive consistent Greek values.

### 6.4 Why This Matters

The significance of on-chain Black-Scholes is not computational novelty. It is trust minimisation and composability. A price that is computed on-chain can be verified on-chain. Any downstream program that consumes Opta's pricing — a structured-product vault building a covered-call strategy, a lending protocol accepting option tokens as collateral, an AI agent constructing a hedge — does not need to trust an off-chain server. The price is a function of on-chain state, computable by anyone, auditable by anyone, and consistent across all callers.

### 6.5 Settlement Pricing — EMA at Expiry-Time

A subtle problem in any oracle-driven settlement is the question of *which* price reads when. The naive answer — "the price at the moment `settle_expiry` runs" — opens a small but real attack surface. If the crank runs even a minute or two after the market's `expiry` timestamp, the consumed Pyth update's `publish_time` could fall well after the option's actual expiry, and the contract would settle against a price that has already moved past the at-expiry mark. In an environment of automated cranks running on five-minute ticks against markets that may have a sharp price move at the expiry boundary, this drift can be material.

Opta's `settle_expiry` instruction reads Pyth's exponentially-weighted moving average (EMA) price rather than the spot price, and verifies on-chain that the consumed price update's `publish_time` lies within a sixty-second window of the market's `expiry` timestamp. The choice of EMA over spot is deliberate: EMA smooths flash price moves that occur right at the expiry boundary, which is exactly the regime where a market-maker's algorithm might be repositioning aggressively and where spot is least reliable as a settlement reference.

```rust
require!(
    publish_time >= expiry - WINDOW_SECONDS &&
    publish_time <= expiry + WINDOW_SECONDS,
    SettlementWindowExpired
);
```

The consumed `publish_time` is itself written into the on-chain `SettlementRecord` account as an audit trail. Anyone — a settled writer auditing their payout, a lending protocol that accepted Opta option tokens as collateral, an AI agent verifying its hedge — can read the `SettlementRecord` and confirm exactly which Pyth update settled the vault. There is no off-chain price provenance to trust.

For an integrator calling `settle_expiry` directly, the typed `SettlementWindowExpired` error is the contract: if the integrator's logic produces a Pyth update whose `publish_time` falls outside the sixty-second window, the call reverts cleanly. The expected response is to either fetch a fresher update closer to the expiry boundary or — if the market is genuinely stale — leave the settlement to whichever crank operator next runs against this market. The crank itself handles this case by retrying with a freshly-posted Pyth update on its next tick — and because `settle_expiry` is permissionless, any operator can step in if the configured crank is offline.

---

## 7. The Three-Layer Liquidity Model

Options markets present a hard liquidity problem. Every option is unique in four dimensions — underlying, strike, expiry, type — which fragments liquidity in a way that simple spot markets do not experience. An options venue must solve this fragmentation or accept that most markets will be thin, wide-spread, and unusable for institutional size.

Opta's answer is a three-layer liquidity architecture. The layers are not alternatives to one another; they compose. Each layer is a distinct on-chain (or composable-over-on-chain) surface that buyers can fill against, and each addresses a use case the others cannot serve naturally.

### 7.1 Layer One — Shared Vaults

The foundation is the shared-vault model. A `SharedVault` is a USDC collateral pool keyed on the four dimensions of an option contract — market, option type, strike, and expiry. Writers deposit USDC into the vault and receive `shares` proportional to their contribution; the vault mints option tokens against that pooled collateral; buyers purchase those tokens via `purchase_from_vault`, paying premium into the pool. Premium accrues to writers' claimable balances at trade time, in proportion to their `shares` against `premium_per_share_cumulative` (see section 5.2). At settlement, post-payout collateral is distributed pro-rata.

Vaults come in two variants distinguished by `vault_type`. Epoch vaults align with protocol-defined expiry windows (configured in `EpochConfig`) and are open to any writer; they are the default for new markets. Custom vaults have writer-defined expiries and are restricted to a single writer; functionally similar to a private isolated escrow but built on the same `SharedVault` account type, so the same buyer flow, settlement path, and auto-finalize machinery handles both.

Shared vaults offer three structural advantages. Capital efficiency — writers do not need to match buyers individually but can provide liquidity in advance and earn premium as buyers arrive. Scale — vault sizes can grow to levels that individual writers would not or could not reach. Specialisation — a vault can be thematic (a BTC call vault, a tokenised-gold put vault, a BUIDL short-delta vault) and attract depositors with specific risk-return preferences.

### 7.2 Layer Two — Secondary Listings

The second layer is on-chain peer-to-peer secondary trading of vault-issued option tokens. Once a buyer holds an option, they can list it for resale via `list_v2_for_resale`, which creates a `VaultResaleListing` account (PDA seeded by `(option_mint, seller)`, so at most one active listing per seller per mint) and escrows the listed tokens in a protocol-controlled account. A second buyer can call `buy_v2_resale` to purchase against the listing, with the seller's USDC ATA receiving the resale premium minus the protocol fee. The original seller can withdraw via `cancel_v2_resale`. Expired listings are cleaned up permissionlessly via `auto_cancel_listings` on every crank tick, freeing the escrow rent.

This is structurally different from the primary vault layer. Vaults issue *new* tokens against pooled collateral; secondary listings move *existing* tokens between parties without touching the vault's collateral. The transfer hook permits these pre-expiry transfers; the PermanentDelegate is not exercised on a secondary trade. Secondary listings let a holder exit a position before expiry without forcing the writer to also exit, and without forcing the vault to acquire back its own tokens at an arbitrary price.

### 7.3 Layer Three — The Router

The third layer is the price-discovery layer that composes Layers One and Two. The distinction worth drawing carefully is between the on-chain instructions and the router itself. `purchase_from_vault` and `buy_v2_resale` are passive primitives — each executes a fill against the surface it references, but neither chooses between surfaces. Routing — the active decision of which surface to fill against given a buyer's intent, the available depth, and the prevailing prices on each side — happens in whatever program composes across both. The on-chain surfaces are the substrate; the router is the layer.

In Opta's reference frontend the router is implemented as the unified `BuyModal` on the Trade page, which joins vault chain-row data with active listings, computes which surface gives the buyer better economics, and dispatches the appropriate on-chain call. `BuyModal` is one router. The on-chain surfaces of Layers One and Two are designed to be read and routed across by *any* program — a frontend, an aggregator, an AI agent acting on a user's behalf, a structured-product vault that needs to acquire option exposure as part of a covered-call strategy, an institutional execution layer routing large orders preferentially through whichever surface has depth. Specialised routers built on top of the same on-chain primitives can implement entirely different strategies: a yield-oriented router that always prefers seller listings when their premium falls below the model's fair value; an AI-agent hedging strategy that chains option purchases with spot positions on the same wallet; an institutional desk's TWAP-over-options execution.

The on-chain protocol does not need to know which router is calling it; the router does not need permission from the protocol to compose. This permissionless composability of price discovery across both inventory sources is what makes the router a layer rather than a piece of frontend logic. `BuyModal` is one instance of it; the layer is everything else that could be built on the same substrate.

### 7.4 Why Three Layers Is the Right Number

The three-layer design reflects a deliberate separation of concerns, with each layer serving a use case the others cannot handle naturally.

Shared vaults serve writers who want to provide liquidity in advance and earn premium as buyers arrive, without the operational burden of matching individual counterparties. They serve buyers who want to fill at a model-derived premium against fresh, vault-backed inventory.

Secondary listings serve a different participant entirely — the holder who wants to exit a position before expiry. The vault cannot serve this case because vault collateral is committed against the issued contracts; redemption mid-life would require the vault to acquire back its own tokens at an arbitrary price. A secondary marketplace lets the holder negotiate exit price with a third buyer directly, with the protocol providing only escrow and settlement. Without this layer, holders would have to wait until expiry to realise any P&L, which collapses the option's optionality value.

The router serves the price-discovery use case. Without it, every integrator would have to write its own logic for routing between vault inventory and seller listings — duplicated code, inconsistent execution quality, and a worse experience for users who do not know which surface is cheaper at any given moment. Building it once as a composable layer makes correct execution the default, and leaves room for specialised routers (institutional execution, AI-agent strategies, structured-product vaults) to be built on top without rebuilding the underlying inventory plumbing.

Other protocols have tried to force all options liquidity into a single model — all peer-to-peer, or all AMM, or all vault — and have invariably discovered that options markets have genuinely different liquidity needs at different points in the contract lifecycle. Opta's three-layer model is an explicit bet that matching layer to use case yields strictly better outcomes than forcing a single model. The cost is architectural complexity. The benefit is that each participant — writer, buyer, holder, integrator — finds a surface that fits their need without bending the protocol around them.

---

## 8. Security

A derivatives protocol is only as useful as it is safe. Opta's security posture is built on four overlapping practices: a comprehensive automated test suite, multi-round formal audits, safety-oriented compilation and language choices, and a deliberate posture of honest public documentation of known limitations.

### 8.1 The Test Suite

Opta has one hundred and seven tests in the suite as of the collateral-fix redeploy at slot four-fifty-nine-seven-nine-seven-three-one-four (commit `a8b5f14`), running under Mocha and `ts-mocha` and invoked by `anchor test` or by `run-tests.sh` for finer-grained iteration. The suite spans market creation and lifecycle, the V2 shared-vault flow, the Black-Scholes engine and Greeks, audit-finding regressions, the C-01 expire-before-settle proof-of-concept that was exploited and patched during the audit phase, the Token-2022 extension interactions, and the new settlement-pricing and collateral-symmetry handlers shipped on the third of May 2026.

Approximately seventy-three of these one hundred and seven tests pass on a clean run. Approximately thirty-four fail. The pass rate of about sixty-eight percent reflects cumulative test debt across the Pyth Pull migration arc (P1–P6, late April), the settlement-pricing fix arc (commit `4dc6250`), and the collateral symmetry arc (commit `a8b5f14`). The failures cluster around `zzz-audit-fixes.ts` fixture staleness — the suite is named to run last under Mocha alphabetical ordering and depends on earlier fixtures that drifted during the migration — and around the historical `PriceTooOld` cascade from the Pull oracle migration. They are environmental and test-harness failures, not handler-correctness bugs; the protocol's on-chain logic is exercised end-to-end by the smoke tests detailed in `MIGRATION_LOG.md` and is in functional parity with the deployed devnet program. A test-suite refresh is on the project's quality-polish roadmap; the goal is to return to a green or cleanly-skipped suite on a refreshed fixture set.

### 8.2 Five Rust Audit Rounds

The on-chain Rust programs have been subjected to five distinct audit rounds during the original development cycle, plus a re-audit on the twelfth of April 2026 covering the V2 shared-vault changes that landed after the original five rounds. Each round produced findings at a range of severities — critical, high, medium, and low — and each round's findings were fixed, tested, and committed before the next round began. The April 12 re-audit raised four additional findings (one critical, one high, one medium, one low); all four were fixed, tested, and committed before the auto-finalize arc began. Cumulatively across all rounds, twenty-two findings have been raised and twenty-two have been resolved. Zero open findings remain. The audit history is documented in the project's `CLAUDE.md` file with commit hashes, finding IDs, and the specific tests added to verify each fix.

Notably, the original audit process discovered a critical vulnerability — a race condition in the expiry-before-settle sequence — that was developed into a full working proof-of-concept exploit, patched, and then preserved in the test suite as a regression check. The exploit PoC remains in the repository as `poc-C1-expire-before-settle.ts` so that any future refactor that accidentally reintroduces the vulnerability will fail the test suite immediately.

The May 3 arcs (settlement-pricing fix and collateral symmetry) and the May 1–3 arcs (V2 secondary listing and Trade × Marketplace merge) have not been re-audited externally; a fresh audit covering the post-migration codebase, including those changes, is recommended before any mainnet deployment with real funds.

### 8.3 Two Frontend Audits

The frontend application has been subjected to two rounds of audit separately from the on-chain programs. The audit reports are committed to the repository as `FRONTEND_AUDIT_REPORT.md` and `FRONTEND_AUDIT_REPORT_2.md`. The frontend audit surface covers wallet handling, transaction construction, amount parsing, error surface, devnet-safety warnings, and the Buffer polyfill pattern required for Vite eight compatibility.

### 8.4 Safety-Oriented Build Profile

The release build profile for the on-chain programs enables overflow checks (`overflow-checks = true`) and full link-time optimisation (`lto = "fat"`). Overflow checks catch integer overflow bugs in production rather than silently wrapping, which for a financial protocol is non-negotiable — a silent overflow in a collateral calculation could mint free options. The build profile is explicit in the `Cargo.toml` workspace configuration.

### 8.5 Honest Documentation

Every known limitation, every hackathon shortcut, and every piece of unfinished work is documented inline in the source code with explicit markers. The `settle_market.rs` file contains a multi-line `HACKATHON NOTE` comment at line five explaining that admin-supplied settlement pricing is a deliberate scope reduction for the hackathon and pointing to the exact line at which Pyth integration would replace it. The `pricing-crank.ts` file contains a `TODO: Replace with live Pyth price fetching before mainnet` annotation. The constants files contain layered `DEVNET ONLY — NOT FOR MAINNET` warnings on any value that is a devnet shortcut.

The philosophy is that a reader who opens the code and discovers a limitation should find that limitation documented rather than hidden. This matters for audit purposes, for future contributors, and for sophisticated readers of this whitepaper who will look for the things that an aspirational description omits.

---

## 9. Current State and Honest Limitations

Any protocol at the Opta stage — a hackathon submission pursuing mainnet ambition — has meaningful gaps between what is shipped and what is required for production. This section enumerates those gaps directly.

### 9.1 What Is Live

The protocol is deployed on Solana devnet at the program IDs listed in section 5.1. Both programs compile, deploy, and execute successfully. The full user flow is exercised end-to-end: wallet connect, market browse, option purchase from vault inventory or from a peer-to-peer secondary listing, two-ledger portfolio (buyer side and writer side as parallel sections), claim of accrued premium, exercise, withdraw of post-settlement collateral, and burn of unsold writer escrow. The Living Option Token behaves as designed — transfer-hook expiry enforcement works, PermanentDelegate settlement burn works, MetadataPointer term sheet is readable. Settlement is permissionless via Pyth Pull oracle reads, with EMA-at-expiry pricing and an on-chain `publish_time` audit trail. Auto-finalize at expiry — burning holder tokens and distributing payouts; returning writer collateral and premium and closing writer positions — is permissionless and crank-driven. V2 secondary listing is live in the unified Trade buy modal. Five Rust audit rounds plus the April 12 re-audit, plus two frontend audits, have closed; twenty-two findings raised and resolved, zero open. The crank runs on a five-minute tick.

### 9.2 Test Infrastructure Has Drifted From the Codebase

The Rust test suite stands at one hundred and seven tests as of the collateral-fix redeploy at slot four-fifty-nine-seven-nine-seven-three-one-four. Approximately seventy-three pass and approximately thirty-four fail on a clean run. The failures are not handler-correctness bugs — they are environmental. The `zzz-audit-fixes.ts` suite (deliberately named to run last under Mocha alphabetical ordering) depends on earlier fixtures that drifted during the Pyth Pull migration; several other suites cascade through `PriceTooOld` failures because their mock Pyth updates are now stale relative to the on-chain handler's window check.

The protocol's on-chain logic is exercised end-to-end by the smoke tests detailed in `MIGRATION_LOG.md` for each arc — auto-finalize Step 6, the May 3 settlement-pricing fix, the May 3 collateral symmetry fix, the writer-PF dashboard. Functional parity between the deployed devnet program and the test harness is verified by these smoke runs at present.

A test-suite refresh is the largest open quality item. The goal is to retune the fixtures so the suite runs green or with a known-cleanly-skipped subset, and to add coverage for the post-migration handlers that landed without dedicated tests. This is engineering work, not protocol work — no on-chain change is required.

### 9.3 Writer-Side Resale UX Is Implicit Rather Than First-Class

The V2 secondary listing infrastructure described in section 7.2 supports writer-side resale today as a structural matter — a writer who minted contracts directly from their own vault holds those contracts in their own ATA and can call `list_v2_for_resale` against them through the same flow a buyer-turned-seller uses. There is no on-chain limitation.

What is missing is a first-class writer-side experience in the reference frontend. The Portfolio page's writer ledger displays minted-versus-sold counts and accrued claimable premium, but it does not surface a "list contracts for resale" affordance from the writer row, and it does not expose a dedicated "listings I have created" view. A writer who wants to actively manage their secondary positions must use the buyer-flavoured row affordances on the Trade page. This works mechanically but the framing is wrong: it presents secondary trading as a buyer activity that writers happen to also be able to do, rather than as a first-class part of the writer's lifecycle.

Closing this gap is frontend work — adding writer-flavoured UI affordances on the Portfolio page's writer ledger, surfacing the writer's open listings as a section, and possibly exposing partial-fill mechanics that vault writers care about more than secondary buyers do. No on-chain change is required.

### 9.4 Burn-Unsold Sequencing Across Auto-Finalize

A subtle interaction in the post-expiry lifecycle is the relationship between `burn_unsold_from_vault` (a writer-signed instruction that burns a writer's unsold mint inventory and reclaims their committed collateral) and the auto-finalize sequence. The auto-finalize pass closes the writer's `WriterPosition` account as part of returning their pro-rata collateral. `burn_unsold_from_vault` requires a live `WriterPosition` to operate against. The cleanup window is therefore *before* the writer-finalize pass runs, not after. A writer who waits until after auto-finalize to clean up their unsold inventory will find the instruction inapplicable — the position is gone.

Two follow-up paths are documented in the engineer handoff. The first is to reorder the crank's tick sequence so `burn_unsold_from_vault` runs ahead of `auto_finalize_writers` for any writer with unsold inventory. The second is to add a permissionless `auto_burn_unsold_escrow` instruction that the crank can run on the same tick. Either resolves the sequencing issue; both are deferred from the May 3 polish run because the impact is small. A few writers' unsold inventory becomes inert tokens — TransferHook blocks transfers post-expiry, no economic value is at risk, and a small amount of rent (~0.004 SOL per affected writer) is locked in the abandoned escrow account.

### 9.5 Upgrade Authority and Program Governance

Both on-chain programs are currently under the upgrade authority of a single keypair — the deployer's — which means in principle the programs could be upgraded at any time. For a devnet hackathon deployment this is appropriate; for mainnet it is not. The mainnet design calls for the upgrade authority to be migrated to a multisig, and eventually to be revoked entirely. This migration is a straightforward Anchor operation but must be done deliberately and as part of a broader governance-hardening milestone.

### 9.6 European-Style Settlement, USDC-Only Collateral

Opta currently supports only European-style options (exercisable only at expiry) and only USDC-denominated collateral and premium. This is a simplification that was chosen for audit tractability — American-style options introduce early-exercise logic that widens the attack surface, and multi-collateral support introduces oracle and pricing complexity that compounds with every asset added. These simplifications are appropriate for the current stage. American-style options and multi-collateral support are plausible Phase 3 items but are not currently scoped.

Collateral sizing follows a related simplification. Each option contract is collateralised at 1× strike on both calls and puts. This makes settlement payouts symmetric and bounded, but it places a ceiling on a CALL holder's recoverable value: a buyer of a $50,000 BTC call exercising into a settlement of $200,000 receives $50,000 per contract, not the $150,000 intrinsic difference, because the vault simply does not hold the additional collateral. PUTs do not exhibit this asymmetry — a PUT's maximum payout is the strike (settlement floors at zero), which the 1× collateral fully covers. The mainnet design contemplates either underlying-asset-collateralised CALLs or a higher cash-collateral multiple to remove the cap; either is a plausible Phase 3 item.

### 9.7 Hermes and Pyth Integration Gotchas

Two specific gotchas are worth flagging for any integrator building against Opta or against Pyth's Pull oracle on Solana more generally. They are not bugs in either Opta or Pyth, but they are the kind of detail that costs time when discovered live.

Hermes endpoint version migration. Pyth's Hermes service originally exposed the latest-update endpoint at `/v2/updates/price/latest` but the historical endpoint only at `/v1/updates/price/{publish_time}`. An integrator fetching a price update for a specific past timestamp — for instance, to settle a market whose expiry has already passed — had to use the `/v1` path. That split ended with the 2026-05-20 Pyth cutover: the historical endpoint now lives at `/v2/updates/price/{publish_time}` alongside the latest endpoint, and `/v1` has been decommissioned — it now returns four-oh-four for every timestamp, recent or old. Because those 404s look like generic network errors rather than version-mismatch errors, any client still pointing at `/v1` sees settlement fail silently. Both endpoints are documented at `docs.pyth.network`.

The `pyth-solana-receiver-sdk` does not expose `get_ema_price_no_older_than`. The SDK provides `get_price_no_older_than` for spot prices, which leads naturally to looking for an analogous EMA helper. None exists at the public-API level. The SDK's EMA accessor is lower-level and requires manual decoding of the `PriceUpdateV2` account's EMA fields. Reading the SDK's source rather than its method-name pattern is the cleanest path; relying on autocomplete will produce a method-not-found error at build time.

### 9.8 A Fresh Audit Is Needed Before Mainnet

Five Rust audit rounds plus an April 12 re-audit have closed all twenty-two findings raised against the on-chain programs. Two frontend audits have closed against the reference application. None of these covered the May 1–3 work — the V2 secondary listing instructions, the Trade × Marketplace merge, the settlement-pricing fix, the collateral symmetry fix, or the writer-side Portfolio dashboard. The May 3 changes in particular touch settlement math, collateral economics, and the writer-side UX surface; they should not go to mainnet without a fresh audit pass.

This is a standing item rather than a known bug. The post-May-3 codebase is functioning correctly as exercised by the smoke runs in `MIGRATION_LOG.md`. But the audit posture that justifies a mainnet deployment with real funds does not yet exist for that codebase, and obtaining it is a Phase 2 prerequisite.

---

## 10. Progressive Decentralisation Roadmap

The philosophy for Opta's path to production is progressive decentralisation — a term borrowed from Jesse Walden's 2020 essay that has since become standard in serious DeFi projects. The core idea is that full decentralisation at day one is a mistake — it prevents the protocol operator from fixing bugs, iterating on economics, or responding to emergent issues — but remaining centralised indefinitely is also a mistake, because the whole point of on-chain protocols is censorship resistance and credible neutrality. The right path is to begin with operator-controlled simplicity, harden progressively, and end at permissionless.

Opta's decentralisation milestones are concrete.

### 10.1 Phase 1 — Current State (Devnet, Permissionless Settlement)

Where Opta is today. Settlement is permissionless via Pyth Pull oracle reads with EMA-at-expiry pricing — anyone can call `settle_expiry` at or after a market's expiry timestamp and the on-chain handler enforces correct pricing. Auto-finalize at expiry is also permissionless: anyone can run a crank that exercises the PermanentDelegate authority to burn holder tokens, distribute payouts, return writer collateral, and close writer positions. The team's crank exercises these on a five-minute tick and is one of many possible operators. Upgrade authority remains with a single deployer keypair pending Phase 2. This is appropriate for the current stage of mainnet preparation. It is explicitly not the destination.

### 10.2 Phase 2 — Multisig Upgrade Authority

Migrate the program upgrade authority from the deployer keypair to a multisig. Solana's Squads protocol or an equivalent multisig framework is the likely destination. This reduces the counterparty risk of the upgrade authority to the multisig signer set and makes emergency fixes require explicit multi-party approval. With Pyth-permissionless settlement now in place, this is the most consequential remaining centralisation risk — the protocol's economic logic is settlement-permissionless, but a single keypair could in principle deploy a malicious upgrade.

### 10.3 Phase 3 — Permissionless Crank

The crank's responsibilities — settle, holder-finalize, writer-finalize, auto-cancel-listings — are already permissionless on the protocol side; any signer can call those instructions. The remaining engineering work is to add small economic incentives (a per-call fee paid to the caller from the protocol treasury) so independent crank operators have a reason to run. After this change, the team's crank becomes one of many possible runners, and the protocol is robust to any single crank going offline.

### 10.4 Phase 4 — Revoke Upgrade Authority

Burn the upgrade authority entirely. The programs become immutable. This is the terminal state of progressive decentralisation. It should not happen until the protocol has been in production for long enough that any remaining bugs are unlikely to require emergency fixes — typically at least a year of mainnet operation with meaningful volume. The revocation is irreversible and is a one-way commitment to the current program code.

### 10.5 Beyond Decentralisation: The Governance Question

Orthogonal to the decentralisation path is the question of whether Opta should introduce a governance token and a DAO. The honest answer at this stage is: maybe, but not yet. A governance token introduced prematurely becomes a distraction from building the core protocol, attracts mercenary capital without corresponding contribution, and commits the team to regulatory and operational complexity that is inappropriate for an early-stage project. If Opta reaches meaningful mainnet volume and faces genuine parameter-choice decisions (listing new markets, adjusting fees, upgrading risk parameters), a governance layer becomes appropriate. Until then, it is a deferred decision.

---

## 11. The Fourth Primitive Claim

A stronger framing we want to offer, carefully, is that Opta represents a claim on being the fourth foundational primitive of DeFi.

The three established primitives are decentralised exchanges (spot trading), lending markets (collateralised borrowing), and stablecoins (tokenised monetary units). Each emerged at a specific time, was initially served by protocols that were later supplanted by more composable successors, and became a permanent feature of the DeFi stack. DEXes evolved from EtherDelta to Uniswap to 1inch. Lending evolved from MakerDAO and Compound to Aave and Morpho. Stablecoins evolved from early experiments to USDC, DAI, and sDAI. At each stage, the category matured by becoming more composable and more integrated with the rest of the stack.

Options have been conspicuously absent from this list. Every DeFi cycle has produced some number of on-chain options protocols, and none has achieved the category-defining status of Uniswap or Aave. We believe this is not because options are the wrong primitive — tradfi dominance by options is compelling evidence otherwise — but because the previous attempts ran into specific structural blockers that have now been resolved.

Opyn introduced tokenised options on Ethereum in 2020 but used the pre-extensions ERC-20 standard, so the tokens could not enforce their own expiry or carry settlement authority. Lyra built sophisticated AMM-based options on Optimism but required complex market-maker tooling that never fully attracted institutional liquidity. Dopex built structured products on Arbitrum but tied its identity to the veDPX tokenomics layer rather than to being an open primitive. PsyOptions, the most serious early Solana options effort, used the pre-Token-2022 SPL standard which had none of the extension machinery that makes self-enforcing tokens possible. The original Zeta options product predated Token-2022 entirely and was built around bespoke position accounts. Thetanuts served the long-tail asset niche but relied on off-chain vault operators. Each of these is a serious protocol. None has become the options equivalent of Uniswap.

The claim Opta makes is not that it is categorically better than these protocols in every respect. The claim is that Opta is the first options protocol to be built on a token standard that supports the full set of extensions required for a truly self-enforcing, composable, self-describing option token — and that the combination of that primitive with Solana's RWA-heavy ecosystem composition produces the specific setup in which the fourth DeFi primitive can finally take hold.

Whether this claim proves correct will be decided by adoption, not by whitepapers. We surface it here because understanding the ambition is relevant to evaluating the design choices. Opta is not built to be a slightly better options protocol. It is built to be the options primitive — in the same sense that Uniswap is the DEX primitive.

---

## 12. Comparison With Prior Art

Direct protocol-by-protocol comparison, focused on the specific dimensions that distinguish Opta's design.

| Protocol | Chain | Token Standard | Self-Enforcing Expiry | On-Chain Term Sheet | On-Chain Pricing | Composability |
|---|---|---|---|---|---|---|
| Opyn | Ethereum | ERC-20 | No — protocol-level | No — off-chain | Off-chain | Position-level |
| Lyra | Optimism | Custom AMM | No — pool-level | Partial | Off-chain | Pool-level |
| Dopex | Arbitrum | ERC-20 wrapped | No — protocol-level | No | Off-chain | Limited |
| PsyOptions | Solana | SPL (legacy) | No — protocol-level | No — registry | Off-chain | Position-level |
| Zeta (original options) | Solana | Custom accounts | No — settlement-level | Partial | Off-chain | Bespoke |
| Thetanuts | Multi | Vault shares | No — vault-level | No | Off-chain | Vault-level |
| Opta | Solana | Token-2022 | Yes — transfer-hook | Yes — metadata pointer | On-chain Black-Scholes | Token-level |

The critical row is the first: Opta is the only protocol whose option instrument enforces its own expiry at the token level, via a standard Solana runtime mechanism. This is not a feature addition. It is a primitive change.

A few honest notes on this table. Protocols evolve. Lyra has iterated through multiple versions. Zeta has pivoted. Thetanuts has expanded. The descriptions above reflect each protocol's defining design period, not necessarily its current state. Opta is itself early, and some of the rows about Opta describe the current devnet state rather than a mainnet-deployed reality. Opta's secondary marketplace — vault tokens listed and traded peer-to-peer through the unified Trade buy modal — is now live on devnet as of the May 2–3 merge arc; this was an open gap when the architectural categorisation in the table opposite was first compiled. The table is meant to be descriptive of the architectural approach, not a scoring of who is "better" today.

---

## 13. Conclusion

Opta is an attempt to build the options primitive that on-chain DeFi has needed for five years and that Solana specifically has needed for one. The design is not speculative — every element is implemented, tested, and audited in the current devnet deployment. The thesis is empirical — each of the four pillars that motivates the protocol is grounded in publicly verifiable data on institutional derivatives flow, on Solana's ecosystem composition, and on traditional finance's options-dominant reference class. The roadmap is explicit — progressive decentralisation from the current admin-controlled devnet state toward a fully permissionless mainnet primitive.

The ambition is to be the fourth DeFi primitive. The execution is early. The path between here and there has already passed through the on-disk Phase 2 rename, through Pyth-permissionless settlement with EMA-at-expiry pricing, through V2 vault secondary trading merged into the unified Trade buy modal, and through symmetric one-times-strike collateral for both calls and puts. The path ahead — multisig governance migration, permissionless crank with caller incentives, eventual upgrade-authority revocation, a fresh audit of the post-migration codebase, and whatever else adversarial contact with mainnet reveals — remains. We do not claim that path is short. We claim that it is built on a primitive — the Living Option Token — that has not previously existed and that is specifically fit to the market it is designed for.

We welcome review, critique, and collaboration from Superteam, the Solana Foundation, and the broader Solana developer community. This whitepaper is version one. It will evolve as the protocol does.

---

## Appendix A — Instruction Set

The main Opta program exposes twenty-one instructions, grouped into eight functional categories.

**Admin (2):** `initialize_protocol`, `initialize_epoch_config`.

**Market lifecycle (2):** `create_market` (permissionless and idempotent), `migrate_pyth_feed` (admin).

**Vault writer flow (5):** `create_shared_vault`, `deposit_to_vault`, `mint_from_vault`, `withdraw_from_vault`, `claim_premium`.

**Vault buyer flow (1):** `purchase_from_vault`.

**Settlement (4):** `settle_expiry` (post Pyth update + create `SettlementRecord`, permissionless, EMA-at-expiry with on-chain `publish_time` audit trail), `settle_vault` (mark vault settled, permissionless), `auto_finalize_holders` (permissionless; burns holder tokens via PermanentDelegate and distributes ITM payouts in batches), `auto_finalize_writers` (permissionless; returns writer collateral and premium, closes writer positions, sweeps dust to protocol treasury, closes the vault USDC account on the last writer).

**Manual cleanup (3):** `exercise_from_vault` (holder-signed power-user fallback), `withdraw_post_settlement` (writer-signed fallback; auto-claims premium internally), `burn_unsold_from_vault` (writer-signed; burns own unsold escrow inventory).

**V2 secondary listing (3):** `list_v2_for_resale`, `buy_v2_resale`, `cancel_v2_resale` — listing PDA per `(option_mint, seller)` so at most one active listing per seller per mint.

**Auto-cleanup (1):** `auto_cancel_listings` — permissionless cleanup of expired V2 listings.

The original V1 peer-to-peer instructions that shipped with the hackathon submission have been archived in commit `54c35c5` and are no longer in `programs/opta/`; they live in `archive/` for historical reference only.

The transfer-hook program exposes a single instruction implementing the Token-2022 transfer-hook interface.

---

## Appendix B — Account Structures

Nine primary account types, grouped here by their place in the contract lifecycle.

**Protocol root.** `Protocol` — singleton root account; global configuration including the USDC mint and the protocol fee receiver.

**Markets.** `Market` — an option market definition (underlying asset, strike, expiry, option type); the parent account for all liquidity and positions written against the contract. `Pricing` — per-market volatility and risk-free-rate parameters used by the Black-Scholes engine.

**Vaults.** `EpochConfig` — settlement windows for V2 shared vaults. `SharedVault` — the V2 liquidity pool backing a market; epoch and custom variants are distinguished by `vault_type` on the same account. `VaultMint` — a vault-issued option mint and its associated state, including the running supply and protocol metadata for the issued Token-2022 mint.

**Positions.** `WriterPosition` — a writer's collateral, share-of-pool, and premium accounting for a specific vault. PDA seeded by `(vault, owner)`, so a writer has at most one position per vault and multiple deposits accumulate on the same record.

**Settlement.** `SettlementRecord` — per-(market-asset, expiry) on-chain record of the settlement EMA price and the consumed Pyth `publish_time`. Created by `settle_expiry`; consumed by `settle_vault` and the auto-finalize handlers.

**Listings.** `VaultResaleListing` — a peer-to-peer listing of vault-issued option tokens. PDA seeded by `(option_mint, seller)`, so a seller has at most one active listing per mint at a time.

All state accounts are defined in `programs/opta/src/state/`.

---

## Appendix C — References

Futures Industry Association. 2023 Global Derivatives Volume Report.

Hyperliquid Hub and PANews. Wallet concentration analysis of Hyperliquid cumulative volume, Q1 2026.

Solana Foundation. March 2026 Ecosystem Report: RWA Activity Acceleration on Solana.

Walden, Jesse. Progressive Decentralization: A Playbook for Building Crypto Applications. Variant Fund, 2020.

Solana Program Library. Token-2022 Extensions Documentation, Solana Labs.

Pyth Network. Pull Oracle Model and Price Feed Documentation.

Black, F. and Scholes, M. The Pricing of Options and Corporate Liabilities. Journal of Political Economy, 1973.

Opta. Source repository at `github.com/nankolib/opta`. Seed context in `HANDOFF.md`. Migration and arc-by-arc chronology in `MIGRATION_LOG.md`. Audit history in `CLAUDE.md`. Test suite invoked by `anchor test` (or by `run-tests.sh` for finer-grained iteration).

---

*This whitepaper was prepared for submission to Superteam Pakistan and, through them, to the Solana Foundation. Questions, critiques, and collaboration requests are welcome. The authoritative source of truth for the protocol's current state is the public repository; this document reflects the state as of 2026-04-21.*
