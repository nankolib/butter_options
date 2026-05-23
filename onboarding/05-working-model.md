# 05 — Working Model

This doc is the working agreement between the three of us — Nanko, me (the planning Claude), and you. It's how we operate day-to-day. By the end you should know what to expect from us, what we expect from you, and how to handle the cases where something goes sideways.

This is not a list of rules imposed on you. It's how we're going to work together, written down so we don't have to re-explain it every time. If anything in here doesn't make sense for how you actually work best, push back. The working agreement gets better when both sides shape it.

1. The three-party model

You met this in doc 01, but here's the deeper version.

Nanko holds the product. He decides what Opta is, what features matter, what tradeoffs are acceptable, and what's out of scope. He reviews everything that gets shipped. He cannot write code himself, but he can read it well enough to spot when something doesn't match what he asked for.

Me (the planning Claude) holds the specs. I work with Nanko to turn product decisions into detailed, unambiguous specifications that you can build from. I maintain the docs you're reading right now. I do not commit to the repo. I do not deploy. I do not modify production code. My job ends when a spec is approved and in the queue.

You hold the implementation. You take an approved spec, decide how to build it (architecture, data structures, libraries, code organization, performance tradeoffs), ship the implementation, and submit it for review. You are the only human writing production code on the exchange build. Claude Code (the other Claude, running in a terminal) handles the existing protocol layer and Phase 2 work; you handle everything else.

The cleanest mental model: Nanko decides what, I write down what in detail, you decide how and build it, Nanko reviews the result.

There's one important asymmetry. Because you don't have the options domain background, you do not make domain decisions on your own. If a spec says "show delta to two decimals" and you find yourself wondering whether it should be three decimals for deep-OTM contracts — that's a domain question. Flag it; don't decide it. Conversely, if a spec says "render the Greeks panel as a fixed-position sidebar" and you have a strong opinion that it should be a collapsible drawer for mobile — that's an implementation question. You decide.

If you're ever unsure which kind of question you're facing, ask. The cost of asking is low; the cost of guessing wrong on a domain question is rework plus a credibility hit with traders.

2. What a spec looks like

Every spec follows the same template. The template exists so you can read a new spec quickly — you know where to look for the calculation, where to look for the edge cases, where to look for the visual hierarchy. Standardized shape, faster reading.

The template has nine fields:

- What — one or two sentences describing the thing being built
- Why — the user need or product reason this exists
- Where — where it lives in the UI / codebase, with references
- Data — what data inputs it needs, where they come from
- Calc — any math, transformations, or logic, with exact formulas
- Cadence — when it updates / how often / what triggers it
- Edges — edge cases and how to handle them
- Hierarchy — visual priority, sizing, layout decisions
- Out-of-scope — what's deliberately not in this spec

Not every field will have substantive content on every spec — a backend instruction spec might have an empty "Hierarchy" field, a pure UI spec might have a minimal "Calc" field. That's fine. The fields exist so nothing important gets forgotten.

Here's a fully-worked example. This is what a real spec will look like.

EXAMPLE SPEC: Greeks Panel (Trade Page, Demo Day refresh)

What. A live panel on the trade page showing delta, gamma, vega, and theta for the currently selected option contract. Updates whenever the underlying price changes or the user selects a different contract.

Why. Professional options traders read Greeks before they read price. A trade page without a Greeks panel looks like a retail-grade DeFi tool, not an options exchange. This is one of the most important visual cues that signals "this is a real options venue." Required for the Demo Day visual refresh.

Where. Right side of the trade page, below the order entry box, above the position summary. Reference: see screenshot of Deribit's BTC options page in docs/onboarding/references/deribit-trade-page.png for the visual model we're matching. Component should live at app/src/components/trade/GreeksPanel.tsx. Hook into existing trade page selection state.

Data. The panel needs the following inputs:

- Spot price of the underlying — already available via usePythPrices hook
- Strike of the selected contract — already available via the selected VaultMint account
- Time to expiry (in years) — derived as (expiry_unix - now_unix) / (365 * 86400), where expiry_unix is on the OptionsMarket account
- Option type (call or put) — on the OptionsMarket account
- Implied volatility — for the Demo Day version, use a hardcoded 80% (0.80). The vol oracle is in warmup until 2026-05-26 and we don't want the panel to show "—" during the demo. After Demo Day, this gets replaced with the on-chain realized vol oracle value for American options and BS-implied vol from market prices for European options. That replacement is a separate spec.
- Risk-free rate — hardcoded constant 0.05 (5%). Matches the on-chain RISK_FREE_RATE_SCALED constant in the program.

Calc. Standard Black-Scholes Greeks for European options. (Greeks for American options diverge slightly near expiry, but the divergence is small enough that the same formulas are fine for display purposes — we are not using these for risk management, only for display.)

For a call option:

- delta = N(d1)
- gamma = φ(d1) / (S × σ × √T)
- vega = S × φ(d1) × √T × 0.01    (scaled to per-1%-change in vol)
- theta = (−S × φ(d1) × σ / (2 × √T) − r × K × e^(−rT) × N(d2)) / 365    (per-day)

For a put option:

- delta = N(d1) − 1
- gamma = same as call
- vega = same as call
- theta = (−S × φ(d1) × σ / (2 × √T) + r × K × e^(−rT) × N(−d2)) / 365

Where d1 = (ln(S/K) + (r + σ²/2) × T) / (σ × √T), d2 = d1 − σ × √T, N() is the cumulative normal distribution, φ() is the standard normal density.

There's an existing TypeScript Black-Scholes implementation in app/src/utils/blackScholes.ts that computes premiums. The Greeks formulas above can be added as new exports to the same file. Do not duplicate the math elsewhere.

Cadence. Recompute on every spot price tick from the Pyth feed (typically every few seconds). Recompute immediately when the user selects a different contract. Recompute once per minute regardless, to handle the time-to-expiry decay producing a visible theta change.

Edges.

- Time to expiry ≤ 0. Contract has expired. Suppress the panel, display "EXPIRED" badge in its place.
- Time to expiry < 1 hour. Display Greeks but flag visually (faint background tint) — Greeks become unstable very close to expiry.
- Spot price unavailable (Pyth feed down). Suppress all Greeks, display "—" with a tooltip "Waiting for price feed."
- Strike = 0 or expiry in the past on the VaultMint. Should never happen — these are invariants enforced on-chain. If you see this in data, treat it as a bug and log to the console; display "—".
- Sub-cent values. Delta and gamma should display to 3 decimal places (e.g., 0.523). Vega and theta should display to cents ($0.04). Suppress trailing zeros only when they'd cause confusion.

Hierarchy. Delta and theta are the most-read Greeks. Both should be visually prominent (bold weight, slightly larger font). Gamma and vega are secondary (normal weight, regular font). Rho can be omitted entirely from the Demo Day version. Panel width should match the order entry box above it. Use existing Tailwind classes from the design system; do not introduce new color tokens.

Out-of-scope.

- Aggregated portfolio-level Greeks (sum across all open positions). v2 feature.
- Greeks for multi-leg positions (spreads, straddles, etc.). Multi-leg trading isn't in Demo Day scope.
- Historical Greeks chart. Not needed for Demo Day.
- Rho display. Not needed; constant rate means it's always near-zero.

That's a complete spec. You should be able to read this and have everything you need to ship the panel without coming back to ask "what about case X" twelve times. If you read a spec from us that doesn't feel that complete, push back and ask for what's missing. A vague spec is our failure, not yours.

3. The lifecycle of a spec

Every spec goes through these states. ClickUp will track them as task statuses.

- Drafted. Nanko and I have written the spec but haven't reviewed it together. Not in your queue yet.
- Approved. Nanko has signed off. The spec is locked (modulo questions you raise) and ready for you to build.
- In build. You've picked it up and are working on it. You assign yourself in ClickUp and move the status when you start.
- In review. You've opened a PR on GitHub. The PR description should reference the ClickUp task. Nanko reviews; he may pull me in for spec-interpretation questions.
- Shipped. Merged to master and (if applicable) deployed. ClickUp task closed.

Anything you build should map to an approved spec. If you find yourself building something that doesn't have a spec, stop and surface it. Either the spec is missing (we'll write one), or the work is out of scope (we'll deprioritize it).

4. GitHub flow

You'll have collaborator access to github.com/nankolib/opta.

Branches. Branch off master. Name branches by ClickUp task ID + short description, like OPTA-42-greeks-panel. Don't push to master directly.

PRs. Open a PR when the work is ready for review. The PR description should include:

- A link to the ClickUp task (or task ID)
- A one-paragraph summary of what changed and why
- Anything spec-related the reviewer should pay attention to (e.g., "I implemented option A in the Out-of-scope discussion section because option B turned out to need a protocol change")
- Screenshots or screen recordings for any visible UI change
- Test results: what was tested manually, what's covered by automated tests

Review. Nanko reviews. He may take a few hours to a day depending on what else is happening. If a review is sitting longer than 48 hours and blocking other work, ping him directly.

Merging. Nanko merges. Don't merge your own PRs.

Commit hygiene. Squash-merge to keep master clean. Individual commits inside the branch can be messy; the squashed merge commit message should be tidy. Commit message convention: <type>(<scope>): <description> where type is one of feat, fix, refactor, docs, chore, test. Examples: feat(trade-page): add Greeks panel, fix(write): handle missing vol oracle gracefully. This matches the existing repo convention.

Master/main mirroring. This repo mirrors master to main via git push origin master:main. You don't need to do this yourself — Nanko or Claude Code handles it after each merge.

5. ClickUp flow

ClickUp is the task queue. Specs live there as tasks, organized in a single list with priority ordering.

How to pick work. Look at the top of the queue. Anything in "Approved" status is fair game. If you're unsure which to pick, take the highest-priority one. If two have similar priority, take the one most aligned with what you were just working on (context-switching cost matters).

Status discipline. Move the task to "In Build" when you start. Move it to "In Review" when you open the PR. Don't leave tasks in "In Build" when you've actually stopped working on them — if you parked something for two days, move it back to "Approved" so it doesn't block visibility.

Comments. Any question about the spec goes as a comment on the ClickUp task. This keeps spec questions discoverable in one place. Don't ask spec questions in chat (Slack/Discord/wherever we end up); they get lost.

Sub-tasks. If a spec turns out to be more work than expected and you want to break it into smaller pieces, create sub-tasks. The parent task stays "In Build" until all children ship.

6. The weekly sync

We'll do a 30-60 minute weekly sync. Time/day TBD with Nanko based on time zones.

What it's for:

- Architectural conversations that need real-time back-and-forth (the converged-vs-coexist liquidity model decision is exactly this kind of conversation)
- Reviewing the queue together — what's coming up, what's stuck, what needs reprioritizing
- Surfacing things that are too small for a written spec but worth aligning on (taste calls, naming conventions, library choices)
- Catching misalignment before it becomes rework

What it's not for:

- Status updates ("here's what I did this week") — those happen async, in PRs and ClickUp comments
- Spec questions — those go on ClickUp tasks
- General product discussion — those go to Nanko directly

If the sync ever feels like it could've been an email, we'll fix the format. The point is high-bandwidth conversation that async can't carry.

7. Decision authority

Who decides what.

You decide:

- Implementation architecture (data structures, code organization, library choices, performance tradeoffs)
- Frontend implementation details that don't change the spec (CSS, component breakdown, state management)
- Testing approach
- Build tooling and dev environment choices for your work
- How to factor a spec into commits and PRs

Nanko decides:

- Product direction
- What features ship and when
- Visual/UX decisions when they materially shape the experience
- Whether a spec needs to change in light of an implementation discovery
- All protocol-level design questions (he owns the protocol layer; you build on top of it)

Joint decisions (weekly sync or async conversation):

- Architectural choices that span the protocol/exchange boundary
- New external dependencies (especially Solana-program integrations like Kamino, MarginFi)
- Anything that affects the public API or the on-chain instruction surface
- Changes to the working model itself

When in doubt about which bucket a decision lives in: default to flagging it. The cost of an extra Slack message is zero. The cost of a wrong-authority decision is real rework.

8. Propose-then-apply discipline

This is the working norm Claude Code uses on the existing codebase, and we'd like you to use it for anything that's not a small, obviously-correct change.

Propose-then-apply means: before making a non-trivial change, you say in plain English what you're about to do, what files it will touch, and what the user-visible effect will be. Then you wait for an explicit "go" before applying it.

This sounds bureaucratic. It isn't, in practice. For small clear changes (adding a missing import, fixing a typo, renaming a variable), you just do them. The discipline kicks in for things like:

- Adding a new dependency to package.json
- Creating a new top-level directory or moving files between directories
- Refactoring a piece of code that has multiple callers
- Anything that touches the protocol's IDL or instruction surface
- Anything that changes how data flows between components in a way that affects more than one file

The reason we use this discipline: we've been burned by Claudes (and humans) confidently making changes that turned out to have ripple effects no one anticipated. Propose-then-apply forces a five-second pause that catches most of those before they happen.

You'll develop a sense for when something needs a propose-step. If you over-use it, we'll tell you to relax. If you under-use it, we'll tell you to slow down. Neither end of that is a problem; the calibration is what matters.

9. When and how to escalate

Three things to escalate immediately, not at the end of the day:

The spec is wrong. You're building it and you discover it can't work as written — the math doesn't check out, the data doesn't exist where the spec says it does, an edge case breaks the whole approach. Comment on the ClickUp task, tag Nanko (and me, if it's a domain question). Stop building until we resolve it.

The spec is ambiguous. Two reasonable interpretations exist and they produce visibly different results. Don't pick one and apologize later. Comment on the ClickUp task and ask. We'll clarify and update the spec.

An implementation choice has product implications. You're about to make what looks like a pure implementation decision, but on reflection it's going to shape how users experience the feature. Flag it. We may have an opinion you don't realize we'd have.

Things you don't need to escalate:

- Choosing between two equally-good library choices for a non-public-facing concern
- Refactoring decisions that don't change behavior
- Tests, formatters, lint rules, anything internal to your build
- Any pure code-quality call

How to escalate: ClickUp comment for spec-related issues, Slack/Discord/chat for time-sensitive issues, GitHub PR comment for review-stage issues. Don't email; we won't see it.

10. Communication norms

- Async-first. Default to written communication. ClickUp for spec stuff, GitHub for code stuff, chat for everything else.
- Response time expectations. Nanko is usually responsive within a few hours during his working day (PKT). I (the planning Claude) am near-instant when Nanko is in a session with me; not reachable otherwise. You can expect spec questions to get answered within a working day.
- When to interrupt. If something is blocking you for more than an hour, interrupt. Don't sit stuck. The cost of an unblock-ping is much lower than the cost of a stalled afternoon.
- What "good" communication looks like. Specific, concrete, includes context. "I'm stuck on X. I tried Y and Z. The error is W. I think the issue might be V. What should I do?" — that's a useful message. "Hey, quick question" — that's a worse message.
- Don't apologize for asking questions. A question is cheaper than a wrong assumption. Especially on the options domain, where you don't have prior knowledge to fall back on — assume the dumb question is the right question to ask.

11. What "good" looks like

From your side, after a few weeks of working together, "good" looks like:

- You consistently ship specs that match what was asked, with edge cases handled and visual polish in place
- You raise spec questions early, before you're deep in implementation, when changes are cheap
- You make implementation choices that future you (or future us) will be able to follow without spelunking
- You're learning the options domain at a rate that makes spec questions sharper over time — by month three, you should be catching domain issues in specs that we missed
- You're predictable. Things you say you'll ship by Friday ship by Friday. Things that slip get surfaced before they slip, not after.

From our side, "good" looks like:

- Specs land in your queue at a steady pace, never leaving you idle
- Specs are detailed enough that you almost never have to ask "what about case X"
- When you do ask, you get a clear answer fast
- Reviews come back within a working day
- Decisions get locked rather than re-litigated
- The architectural conversations happen at the right time — early enough that you can plan, late enough that we have enough information to decide

If either side starts feeling like the other is dropping the ball, say something. Working agreements survive when both parties feel they're getting what they need.

12. The first month

Concretely, what you can expect for your first ~4 weeks:

Week 1: Read docs 01-07. Pull the repo. Get it running locally. First specs land — small, frontend-only, Demo Day pieces. You ship one or two to calibrate the spec format and the GitHub flow.

Week 2: Demo Day prep continues. More specs at higher cadence. The trade page visual refresh is the main effort. You should be self-sufficient on the working model by end of week 2.

Week 3: Demo Day (June 2). The week is light on new work — final polish, demo rehearsals, mobile QA. You may be on standby for last-minute fixes during the demo itself.

Week 4: Post-demo retrospective. Architectural conversations for the real exchange build begin. The first exchange-track specs land. This is where the work shifts from "make the existing thing look right" to "build the new thing."

By end of month one, you should be a full peer on the team — taking specs, shipping work, raising the right questions, and shaping the architecture in the conversations where you have something to add.

That's the working model. If anything in it doesn't make sense for how you actually work, tell us. The agreement is mutual.
