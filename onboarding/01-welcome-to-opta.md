# 01 — Welcome to Opta

Hey Butter — welcome. This document is the first thing to read. It's the "what is this project and why does it matter" doc. By the end, you should be able to hold a conversation about Opta without faking it, know roughly where we are in the build, and understand how you fit into the team. Specifics on the codebase, the options domain, the working model, and the roadmap all live in their own docs (02 through 07). Start here.

What Opta is

Opta is an on-chain options protocol. Right now it lives on Solana, but the long-term framing is broader than that — we want to be the on-chain options protocol, full stop, not "the Solana one." More on that when we get to the roadmap.

In one sentence: anyone can write or buy call/put options on any asset that has a Pyth price feed, and the option itself is a token that enforces its own lifecycle.

Three things make that sentence non-trivial:

1. Any asset Pyth has a feed for. Most options protocols, on-chain or off, support BTC, ETH, and maybe a handful of large caps. We support whatever Pyth has — crypto, equities (TSLA, NVDA, IBIT), commodities, FX, ETFs. Every new feed Pyth ships becomes a potential Opta market. There is no hardcoded asset registry; the program ID for a Pyth feed is the only thing you need to spin up a market on Opta, and anyone can do it permissionlessly.

2. The "living option token." Every option contract on Opta is a Token-2022 mint with three SPL extensions doing real work. TransferHook blocks transfers after expiry. PermanentDelegate gives the protocol authority to burn the token at settlement without the holder signing anything. MetadataPointer makes the term sheet (asset, strike, expiry, type) readable on-chain by any other program. The practical consequence: at expiry, no user has to claim, exercise, withdraw, or click anything. The protocol burns the token, distributes USDC, closes the position. Holders wake up with money in their wallet. Writers get their collateral back plus earned premium. This works even for tokens held in secondary-market wallets — whoever holds the token at expiry gets paid, automatically. That "no clicks" property is unusual in derivatives and it's a real part of what we sell.

3. Shared-vault liquidity. Traditional options books fragment liquidity per strike, per expiry, per side. We have writers deposit into pooled vaults that mint multiple strikes and expiries against one collateral pool. This is the current liquidity model. It's not the only one we'll ever have — adding an order book on top is on the roadmap and is part of why you're here — but it's what's live today.

Why Opta exists

The pitch starts with a gap in DeFi.

In traditional finance, derivatives volume dwarfs spot volume. Options specifically are a multi-trillion-dollar market. In crypto, that's also true on centralized exchanges — Deribit alone did over $1 trillion in options volume in 2024 and holds roughly 85% of the crypto options market.

On-chain, derivatives are a rounding error. The biggest on-chain options protocol (Derive, formerly Lyra) has done maybe $1.5B cumulative since 2021. That's a thousand times smaller than what Deribit does in a year. The infrastructure isn't there, the liquidity isn't there, and the product experience isn't there.

Solana specifically is essentially absent from on-chain derivatives. Hyperliquid is winning EVM-side momentum on perps and futures. Solana has nothing comparable for options. There's a category-shaped hole and nobody is convincingly filling it.

Opta is positioning to be the answer. The wedge has three parts:

- The asset surface — every Pyth feed, not just the top 5 tokens. The long tail is structurally unserved by Deribit. Solana ecosystem tokens, equities for crypto-native treasuries, exotic FX pairs — none of these have a real options venue today.
- The token mechanic — once a trader uses the "wake up with USDC, no clicks" flow, going back to a clunky exercise UI feels broken. This is a retention mechanism more than an acquisition one, but it's structurally durable.
- Composability — because the contracts are real tokens and the math/data is on-chain, other Solana programs can integrate with Opta. A vault protocol can hold Opta puts as portfolio insurance. A treasury can use Opta to hedge programmatically. This isn't possible with Deribit because Deribit is a closed book on a centralized server.

We're not trying to take Deribit's institutional flow. That flow lives in a regulated, centralized world and isn't coming on-chain anytime soon. We're trying to be the venue for everything Deribit doesn't and can't serve.

Where we are right now

Honest snapshot, as of mid-May 2026:

Live on Solana devnet. The protocol is deployed and working. Frontend is on Vercel at opta-solana.vercel.app. Anyone with a wallet can write options, buy them, list them on the secondary market, and watch them auto-settle at expiry. The full lifecycle works end-to-end on devnet. Mainnet is not yet — it's gated behind Phase 2 completion and a security audit.

Hackathon submitted. Opta was built for the Colosseum Frontier Hackathon in April 2026 and submitted on May 11. That phase is done.

Demo Day coming up. Colosseum Frontier Demo Day is June 2, 2026, in Islamabad. ~10 days from now. We're not changing the protocol for this; we're polishing the existing devnet experience (mobile responsiveness in particular — most of the audience will see the demo on phones) and making the trade page look like a real options exchange instead of a DeFi vault product. This is part of where you come in. More below.

Phase 2 in flight. Phase 2 is the "American options + end-to-end on-chain pricing" arc. Right now, European-style options work and settle on devnet, but the pricing math (Black-Scholes) is computed in the writer's browser in TypeScript and submitted to the chain as an argument. The on-chain math library exists but no production instruction calls it yet. Phase 2 fixes that — for American options first — by wiring an on-chain BS-2002 pricer plus a permissionless realized-volatility oracle into the mint flow. As of this writing, the math kernel (Stage A), the vol oracle (Stage B), and the first production handler to use them (Stage C Pass 2) are all shipped to devnet. The remaining Phase 2 work is roughly 9-11 weeks of solo Claude-Code-paired engineering plus an audit. That work continues in parallel to your work.

Mainly Nanko + Claude up to now. This project has had one human (Nanko) and two Claude instances. One Claude (this one — me, the document author) does planning, design review, decision-locking, and writes specs. The other Claude — "Claude Code," running in a terminal — does the actual code edits, commits, and deploys. Every line of code in the repo has flowed through that pairing. There has been no other engineer until now.

The team and how you fit in

You are the third leg of the stool.

Nanko is the founder. Non-developer by background, but a sharp generalist who has driven every product, protocol, and architectural decision on Opta. He knows the options domain deeply, has thought through the protocol mechanics, and is the source of truth for what Opta should be. He cannot write Rust or TypeScript himself.

This Claude (the one writing this doc) is the planning and spec-authoring partner. I help Nanko make decisions, draft specs that you'll build from, maintain working docs like this one, and review architectural tradeoffs. I do not write production code. I do not commit to the repo. I do not deploy.

Claude Code is the implementation Claude for the protocol layer — Anchor/Rust programs, the existing frontend, scripts, the crank. It runs in a terminal session on Nanko's machine and uses a propose-then-apply discipline (every change proposed before applied, explicit greenlight before next step). It is currently the only thing modifying the existing Opta codebase.

You are the implementation engineer for the exchange build. You have two years of protocol and trading-engine experience. You understand on-chain order books, execution engines, the Solana CLOB landscape (Phoenix, OpenBook, Manifest, Zeta). You do not yet know options — that's fine, we'll teach you what you need. Your job is to take specs from Nanko (drafted with my help), make the implementation decisions that turn those specs into production code, and ship.

The working model is:

- Nanko + me → write detailed specs (what / why / where / data / calc / cadence / edges / hierarchy / out-of-scope)
- You → take the spec, decide how to build it, ship the implementation, raise questions when the spec is wrong or incomplete
- Nanko → reviews your work with domain eyes (does this match what a real options trader would expect?), approves or sends back
- Weekly sync to catch the things that don't fit in async

We are deliberately not asking you to learn options well enough to make domain decisions. We are asking you to learn options well enough to implement specs correctly and flag when a spec doesn't make sense. Doc 02 ("Options 101 for Builders") will get you there.

What's on the roadmap

Two parallel tracks, starting roughly now.

Track 1 — Phase 2 protocol completion. Driven by Nanko + Claude Code. The remaining stages of Phase 2 land American options with full on-chain pricing, then audit, then mainnet. ~9-11 weeks plus audit. You do not work on this; it is the existing protocol's continuation and Claude Code is set up to ship it.

Track 2 — The exchange build. Driven by Nanko + me (this Claude, for specs) + you (for implementation). This is the major strategic pivot. After Phase 2 ships American, Opta transitions from "options primitive with vaults" to a full on-chain options exchange — central limit order book, Greeks panel, multi-leg strategy builder, composable margin via integration with Solana lending protocols (Kamino, MarginFi, Drift). The vault model doesn't go away; it becomes one of multiple liquidity primitives feeding the same option mints.

The north star for the exchange is this: the user should not feel they are trading on a blockchain. Wallet connection is the only blockchain-ish touchpoint. Everything else — quotes, fills, positions, Greeks, P&L, charts, margin — should feel like a derivatives terminal. Protocol on-chain. Experience not.

The exchange build runs in two phases:

- Now → Demo Day (June 2): Visual refresh of the trade page so it reads as exchange-shaped on the existing vault rails. No functional rebuild, no order book, no margin. Just the visual grammar — chain grid, Greeks display, position panel — built on top of what already works. This is a frontend-only effort and it's where your first specs will come from.
- Post-Demo (June 3 onward): The real exchange architecture. This is where you build the execution engine, the order book layer, the margin integration, and the multi-leg trading flows. Spec authoring and architectural design happen during the Phase 2 weeks. Implementation runs in parallel where possible, accelerates when Phase 2 engineering bandwidth frees up. v1 mainnet target is the exchange, not the current vault-only product.

That second phase is the real reason you're here. The Demo Day work is the warm-up.

What you need to do this week

Read this doc. Then read doc 02 (Options 101) — that's the one that compensates for not knowing the domain, and you'll come back to it constantly. Then read doc 05 (Working Model) to understand the spec format and the rhythm. The others (codebase map, protocol architecture, roadmap-and-decisions, glossary) you can read in order or pull from as needed.

You'll get GitHub collaborator access to github.com/nankolib/opta and access to the ClickUp project where specs and tasks live. The first specs will be small, scoped, frontend-only Demo Day pieces — exactly the kind of thing where you can ship something visible quickly and we can iterate on the spec format together.

Before you start shipping code, we want you to have:

- Read docs 01, 02, and 05
- Pulled down the repo and gotten it running locally (doc 04 covers this)
- Had a kickoff conversation with Nanko (and possibly me, via him) where you can ask anything that didn't land

If anything in these docs is wrong, unclear, or missing, flag it immediately. The spec quality is the whole point of this working model, and that includes the onboarding docs. We'd rather rewrite them now than have you guess.

How to use the rest of the docs

- 02 — Options 101 for Builders. The domain primer. What calls, puts, strikes, premiums, Greeks, vol, settlement actually mean. Written for an engineer who has zero options background. Reference; come back constantly.
- 03 — Protocol Architecture. What's on-chain today. The two programs, the Token-2022 extensions, the state accounts, the instruction inventory, Pyth integration, the crank. Reference.
- 04 — Codebase Map. Where everything lives in the repo, naming conventions, build/test/deploy commands, gotchas a previous engineer would warn you about. Reference.
- 05 — Working Model. The three-party workflow, the spec template, the GitHub PR flow, the weekly sync, propose-then-apply discipline. Read once, refer back.
- 06 — Roadmap and Decisions. Phase 2 detail, the exchange pivot detail, major architectural decisions with the why, things that have been considered and rejected, open questions. Reference, but read once cover to cover so you don't accidentally re-suggest closed questions.
- 07 — Glossary. Single-page lookup for any term you hit. Options terms and Opta-specific terms.

A HANDOFF.md lives in the repo root. It's the operational state document maintained by Claude Code for itself. Long, dense, mostly not for you — but §1 (project identity), §11 (gotchas), and §11.5 (Phase 2 plan summary) are worth skimming once. The onboarding docs are not derived from HANDOFF; they're written for you specifically.

Welcome aboard. Let's build something real.
