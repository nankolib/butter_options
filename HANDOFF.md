# Opta — Engineer Handoff

> Updated 2026-05-04 after the Run-7 audit-fix arc completed. Two same-day Rust security arcs ran on 2026-05-04: the morning arc (`ceef4af` → `8e638b9`) closed Run-6 findings CRIT-2/CRIT-3/HIGH-1 at slot `459869998`; the evening arc closed Run-6 CRIT-1 at slot `460039090` (`280c1c6`) and then bundled four more findings into a single redeploy at slot **`460088947`** — Run-6 PART 1 HIGH-2/HIGH-3/HIGH-4 + zero-feed subset of HIGH-5 (Rust) plus Run-7 PART 2 HIGH-1/HIGH-2/HIGH-3/MED-1 (frontend). Six fix commits + one chore-deploy commit tonight. Renamed from Butter Options to Opta on 2026-04-21. This document is the project seed context — drop it into a fresh Claude chat to bring any instance up to speed without re-explanation. For current HEAD, run `git log -1 --oneline`; this doc does not try to self-reference its own commit.

> NOTE ON THE RENAME: As of 2026-04-29, **Phase 2 of the rename is complete on disk** (despite older sessions saying it was parked until post-Colosseum). Directory layout is now `programs/opta/` and `programs/opta-transfer-hook/`. `Anchor.toml` keys are `opta` and `opta_transfer_hook`. PDA seed constants, `declare_id!()` macros, and IDL have been regenerated. The old `butter_options` / `butter-options` identifiers are gone from the codebase. If the in-memory mental model from older sessions still says Phase 2 is parked, the disk supersedes it.

---

## How to use this document

This document is the **seed context** for Opta. If you're a fresh Claude session starting work on this project:

1. **Read this doc end-to-end before answering.** Skimming misses the gotchas and norms.
2. **Verify before citing.** Line numbers and file paths drift. Before acting on a reference in this doc, confirm it still matches the current tree.
3. **The user is real-time. The doc is a snapshot.** If the user's live intent conflicts with this doc, follow the user.

---

## Working with the user

- **Non-developer by background.** The user is learning the stack through these sessions — treat them as a smart generalist who's newer to Solana/TypeScript specifics than to high-level software thinking. Explain in plain English with analogies, but don't over-baby; match their demonstrated level in a given conversation. Example: "a PDA is like a permanent mailbox address the program can always find" beats "program-derived address seeded from X."
- **Solo project, Claude-paired.** This project has no other engineers. Every change — code, tests, docs — has flowed through a Claude session. Assume the code you're reading came from a previous Claude instance, not from the user typing.
- **Two-Claude workflow.** This chat session functions as project manager and design reviewer; **Claude Code** (running in WSL on the user's Windows machine) does the actual code execution. The chat reviews proposals, locks decisions, then hands prompts to Claude Code. Claude Code uses propose-then-apply on every change.
- **Windows + WSL.** User is on Windows 10 with WSL2 for Solana tooling. Bash commands run in Windows git-bash by default; anything Solana-related (`anchor`, `solana`, `cargo`) MUST run via `wsl -- bash -lc "..."`. Keypair at `/home/nanko/.config/solana/id.json`. The user doesn't know what WSL is internally — just give the exact command to run.
- **Terminal preference: PowerShell.** When asking the user to run shell commands themselves (not Claude running them), prefer simple PowerShell one-liners. No piping gymnastics.
- **"Contracts" not "tokens" in UI copy.** Option tokens are called "contracts" throughout the frontend. Match that convention in any user-facing string you write.
- **Direct action over circling.** When there's a clear best path, take it and say so. Don't manufacture multi-option proposals just for ceremony — but do propose alternatives when there's genuine ambiguity.
- **Approve-then-apply for risky work.** For deletions, force-pushes, large rewrites, or anything irreversible, propose the plan first and wait for approval. Apply only after green-light; verify after applying.

---

## 1. Project Identity & Thesis

**Opta** is a permissionless options primitive on Solana. Anyone can write (sell) or buy call/put options on **any asset Pyth has a feed for** — crypto, commodities, equities, FX, ETFs. Each option is a Token-2022 mint with three extensions that make the token enforce its own lifecycle on-chain.

### The thesis

DeFi has a derivatives gap. Options are a much bigger TAM than spot in TradFi but barely exist on-chain. Solana specifically is essentially absent from on-chain derivatives — Hyperliquid is winning the EVM-side momentum, especially with institutional flow moving into commodities futures, and Solana doesn't have an equivalent options primitive competing for that flow. Opta is positioning to be that answer.

The differentiation comes from three intertwined design choices, each of which only makes sense because of the other two:

**Asset surface.** Most on-chain options projects support BTC, ETH, SOL, maybe a handful of large caps. Opta supports anything Pyth has a feed for. The pitch is not "options on SOL" — it's "options on whatever asset has a price feed." This compounds: every new feed Pyth adds becomes a potential Opta market.

**Token mechanic — the "living token."** Each option is a Token-2022 mint with three extensions doing real work: TransferHook enforces expiry (post-expiry transfers fail), PermanentDelegate gives the protocol authority to act on the holder's tokens without their signature, MetadataPointer makes the term sheet on-chain so other programs and AI agents can read it. The intent: at expiry, **no user has to claim, exercise, withdraw, or click anything**. The protocol burns the token, distributes the cash, closes the position. Users wake up the next day with USDC in their wallet — payout if ITM, refunded collateral + earned premium if OTM (writer side). Including for tokens held in *secondary-market* wallets — whoever holds the token at expiry gets paid, automatically. **This automated post-expiry resolution is the protocol's core narrative; it's been live on devnet since the auto-finalize arc closed (commit `37c9b4b`, Apr 30 2026), and the May 2–3 arcs added the secondary-market and writer-side surfaces around it.**

**Liquidity model.** TradFi-style options books fragment liquidity per strike, per expiry, per side. Opta's shared-vault V2 model has writers deposit into pooled vaults that mint multiple strikes/expiries against one collateral pool, eliminating per-listing fragmentation.

**On-chain Black-Scholes via solmath** — pricing happens on-chain at ~50K compute units, which means other Solana programs can CPI into Opta and price options as part of their own logic. This is the AI-agent / composability angle.

**European-style settlement** ships now. American comes post-hackathon. Locked decision.

### Stage

**Devnet demo / continued polish.** Built for **Colosseum Frontier Hackathon — April 2026**; submission window closed before May. Protocol is deployed on Solana devnet, frontend is live on Vercel at `opta-solana.vercel.app`. The live deployment uses Pyth's mainnet price feeds via `hermes.pyth.network` (because Solana devnet's Wormhole Core Bridge only verifies Pyth's production guardian set, not Beta). The protocol code itself is still running on Solana devnet — only the price oracle endpoint is mainnet. As of May 3 the protocol is feature-complete on devnet (including secondary listing); subsequent work is correctness-tightening, UX polish, and test-debt reduction rather than new feature surface.

---

## 2. Repository State

- **GitHub remote:** `https://github.com/nankolib/opta.git`
- **Current branch:** `master` (also pushed to `main` for hackathon judges; both branches stay in sync at every commit via explicit `git push origin master:main` refspec)
- **Working tree:** clean (modulo five local-only audit/plan markdowns kept by policy: `WRITER_PF_AUDIT.md`, `WRITER_PF_PLAN.md`, `COLLATERAL_2X_AUDIT.md`, `COLLATERAL_2X_PREMIUM_FOLLOWUP.md`, `SETTLEMENT_PRICING_AUDIT.md`)
- **Latest commits as of 2026-05-04 (evening):**
  - `(this commit)` chore(deploy): Run-7 audit-fix arc bundled redeploy at slot 460088947
  - `129b307` fix(security): HIGH-4 — reject zero settlement price in pyth_price_to_usdc + pyth_price_to_scale
  - `6092e58` fix(security): HIGH-2 + HIGH-3 + zero-feed migrate guard — admin-gate create_market + reject zero pyth_feed_id
  - `6902a61` fix(frontend): MED-1 — settled-locked state for CRIT-1 24h holders-first window
  - `b1356d2` fix(frontend): HIGH-2 + HIGH-3 — IDL-drift field renames in Portfolio + Markets
  - `5a230b1` fix(frontend): HIGH-1 — IDL-driven errorDecoder rewrite
  - `280c1c6` fix(security): CRIT-1 — holders-first gate via 24h post-expiry exercise window
  - `8fe4ee3` fix(write): silent stage-3 skip on wallet-replay race
  - `3722a40` docs(handoff): refresh for May-4 audit-fix arc
  - `8e638b9` chore(idl): refresh frontend IDL after audit-fix arc redeploy
  - `d0f0c2e` fix(security): HIGH-1 — validate protocol_state PDA in opta_transfer_hook init
  - `8005cae` fix(security): CRIT-3 — admin gate on initialize_protocol via hardcoded deployer pubkey
  - `ceef4af` fix(security): CRIT-2 — Pyth EMA confidence-interval gate at settle_expiry
  - `ec53120` docs(whitepaper): refresh for May-3 reality + technical depth
  - `42be174` docs(handoff): refresh for May-3 arcs + V2 secondary state
  - `15a3ac9` fix(portfolio): correct WriterRowAction import path in WrittenPositionsSection
  - `1480b3c` feat(portfolio): writer-side vault dashboard + solscan links
  - `a8b5f14` fix(collateral): symmetric 1x strike collateral for CALL and PUT (remove 2x asymmetry)
  - `4dc6250` feat(settlement): expiry-pinned EMA pricing + audit trail
  - …earlier history (V2 secondary, trade-merge, auto-finalize, P1–P6 migration) accessible via `git log`

Author throughout: **nankolib** (single-developer, Claude-paired).

### What changed in the V2 secondary + Trade × Marketplace arcs (May 1–3 2026)

Two adjacent arcs that landed in early May, immediately before today's polish work:

- **V2 secondary listing frontend** (commits `2570f3f` through `4f2f5e6`, May 1–2): scaffolded the on-chain marketplace UI — `useMarketplaceData`, `useResaleBuyFlow`, the original `/marketplace` page + sections + modal, plus the cluster-aware Solscan URLs and devnet labels that the writer-PF arc later reused. The on-chain V2 secondary instructions (`list_v2_for_resale`, `buy_v2_resale`, `cancel_v2_resale`) had landed earlier and were already deployed.
- **Trade × Marketplace merge** (commits `9e76699` through `c5ce63c`, May 2–3): retired the standalone `/marketplace` page and merged secondary listings into the unified `BuyModal` on `/trade`. The chain-row data layer joins resale listings inline; users see a single buy surface that picks vault inventory or seller listings based on price/depth. Net **−1044 LOC** across the seven slices.

These two arcs together closed what the Apr 30 handoff called the "biggest remaining architectural gap." The on-chain marketplace state, the buyer-side flow, and the chain integration all shipped before May 3 began.

### What changed in the settlement-pricing fix arc (May 3 2026, commit `4dc6250`)

The crank had a late-arrival drift bug: when the settle pass ran more than ~60 seconds after expiry, the Pyth `PriceUpdateV2` it consumed could pin to a publish_time well after the option's expiry, settling the contract against a price that didn't reflect the actual at-expiry mark.

The fix: settlement now reads Pyth's **EMA price at expiry-time** with a 60-second window, and writes the consumed `publish_time` into the on-chain `SettlementRecord` as an audit trail. The crank's settle pass posts a Pyth update at expiry, the on-chain handler verifies the publish_time falls within the window, and any settle attempt with a publish_time outside the window reverts with a typed error. The audit-trail field means anyone can verify post-hoc which price update settled a given vault.

Devnet redeploy slot: **459782078**. Local audit doc: `SETTLEMENT_PRICING_AUDIT.md`.

### What changed in the collateral symmetry arc (May 3 2026, commit `a8b5f14`)

A latent asymmetry: the `required_collateral_per_contract` helper had a 2× multiplier for CALL contracts that wasn't present on PUT. CALL writers were locking 2× the strike-magnitude of collateral against an equal-magnitude PUT write. The 2× was a vestige from an earlier safety margin that had been quietly carried since v1.

The fix: collapsed both branches to **symmetric 1× strike** collateral. `programs/opta/src/utils/collateral.rs` exports a single helper used by both CALL and PUT paths in `mint_from_vault`, `withdraw_from_vault`, and `auto_finalize_writers`. Legacy vaults created under the 2× formula correctly read the excess collateral as "free" and let writers withdraw the previously-locked half (verified on the May 9 SOL CALL vault — $450 of previously-locked collateral became withdrawable post-redeploy).

Premium framing also locked here: the protocol uses **Model B** — buyer pays premium to the vault at trade time, premium accrues to the writer's claimable balance proportional to vault sales. Premium is not contingent on OTM expiry. UI copy across Portfolio (cells, button labels, tooltips) reflects this.

Devnet redeploy slot: **459797314**. Local audit docs: `COLLATERAL_2X_AUDIT.md`, `COLLATERAL_2X_PREMIUM_FOLLOWUP.md`.

### What changed in the writer-PF arc (May 3 2026, commits `1480b3c` + `15a3ac9`)

The `/portfolio` page was buyer-only before this arc. `useVaults()` had been exposing `myPositions`, `getMyPosition`, and `getUnclaimedPremium` for months — all dead-code exports — but no UI consumed them. This arc wired the existing data layer to a new section.

Six new files: `writerRows.ts` (state-machine builder: live / expired-pending / settled-itm / settled-otm), `useWriterActions.ts` (claim / withdraw / burn-unsold handlers mirroring the buyer-side orchestration), `WriterPositionsTable.tsx`, `WrittenPositionsSection.tsx` (§ 02 between buyer Open and Closed), `WriterSummaryBand.tsx` (sibling band per D8 Pattern B), and `solscan.tsx` (`solscanAccountUrl` + `<SolscanLink />` shared by both ledgers). Four in-place edits: `PositionsTable.tsx` (buyer-side Solscan retrofit), `positions.ts` (added `Position.vaultPda`), `ClosedPositionsSection.tsx` (renumber § 02 → § 03), `PortfolioPage.tsx` (two-ledger composition; `refetchAll` now also kicks `useVaults().refetch` for symmetric live updates).

**No Rust changes, no redeploy.** The on-chain handlers (`claim_premium`, `withdraw_post_settlement`, `burn_unsold_from_vault`) were shipped months ago in the auto-finalize arc and earlier; this arc connected them to a UI. Devnet program slot stays at `459797314`.

Two same-day side effects:

1. `solscan.ts` was renamed to `solscan.tsx` mid-arc. The file contained JSX but had a `.ts` extension — Vite tolerated it via its esbuild config; tsc was permissive via the `jsx` compiler option; only when a non-Vite tsx test runner touched the file did the convention violation surface. Now properly `.tsx`. No other files affected.

2. **Build-fix follow-up `15a3ac9`.** Step 7 of the writer-PF arc moved the `WriterRowAction` export from `WriterPositionsTable.tsx` to `writerRows.ts` (the data module — single-source-of-truth refactor). `PortfolioPage.tsx` and `WriterPositionsTable.tsx` itself were updated; `WrittenPositionsSection.tsx` kept the stale import path and was missed in the audit. **Local `tsc --noEmit` returned clean** because Windows incremental cache still had the pre-refactor module shape visible — but Vercel's clean-room build correctly rejected the import. The follow-up commit fixed the one-line import. Lesson preserved in §11.

Local audit chain: `WRITER_PF_AUDIT.md` (investigation: data fetched, UI absent — verdict C, hybrid lopsided toward A) and `WRITER_PF_PLAN.md` (locked design decisions D1–D10 + D5b live-update).

### What changed in the audit-fix arc (May 4 2026, commits `ceef4af` → `8e638b9`)

A four-commit security arc that closed three findings from a Run-6 external audit on the Rust on-chain code. Findings were surgical and isolated; the larger CRIT-1 (settlement-race / writer-drains-before-holders) and CRIT-4 (CALL undercollateralization disclosure) were intentionally out of scope and parked for separate arcs.

- **CRIT-2 — Pyth EMA confidence-interval gate** (commit `ceef4af`). `settle_expiry` validated `verification_level` + `feed_id` + `publish_time` but never read `pu.price_message.ema_conf`. A wide-conf Pyth print published during oracle stress could be accepted as canonical settlement. Added `MAX_CONF_BPS = 200` (2%) constant in `programs/opta/src/instructions/settle_expiry.rs` and a `require!()` that reverts with new error `PriceConfidenceTooWide` (code 6040) when `ema_conf * 10_000 > |ema_price| * MAX_CONF_BPS`. Boundary inclusive on the pass side. Three new tests cover just-under / at-edge / just-over; existing fixtures keep the default 1_000_000 conf via the new optional `emaConf` override on `FixtureSpec`.
- **CRIT-3 — admin gate on `initialize_protocol`** (commit `8005cae`). Original handler was unauthenticated; first caller became admin permanently. Added hardcoded `DEPLOYER_PUBKEY` const (`5YRMuuoY3P7z5GeRAAQND7BxgNdmPSa6CSPCJLca1zZk`, the wallet at `/home/nanko/.config/solana/id.json`) and `require_keys_eq!(admin, DEPLOYER_PUBKEY, Unauthorized)` at the top of the handler. Hardcoded approach over upgrade-authority lookup chosen for surgical simplicity; if the program is ever redeployed with a different deployer key, the constant must update in lockstep. Existing devnet `ProtocolState` predates the gate — the new check only fires on FRESH `initialize_protocol` calls.
- **HIGH-1 — `protocol_state` PDA validation in `opta_transfer_hook`** (commit `d0f0c2e`). The hook's `initialize_extra_account_meta_list` stored the caller-supplied `protocol_state` verbatim with no validation. A frontrunner could pre-init the hook with a malicious `protocol_state`, breaking legitimate `mint_from_vault` CPIs (init-already-in-use) AND fixing the malicious pubkey as the protocol-escrow recognition for that mint (post-expiry transfers from attacker accounts would bypass the expiry check via the protocol-escrow allow path). Added two consts in `programs/opta-transfer-hook/src/lib.rs`: `OPTA_PROGRAM_ID` and `OPTA_PROTOCOL_SEED` (mirroring source-of-truth in `programs/opta/src/lib.rs:26` and `programs/opta/src/state/protocol.rs:48`). Handler now derives the expected `protocol_state` PDA and `require_keys_eq!`'s the caller's arg against it; new error `InvalidProtocolState` on the hook's `TransferHookError`.
- **IDL chore** (commit `8e638b9`). Frontend IDL bundle refreshed (`app/src/idl/opta.json` + `opta.ts`) so error decoders surface `PriceConfidenceTooWide` by name. Hook IDL stays out of `app/src/idl/` — the frontend never invokes the hook directly, only references its program ID + PDA-seed helpers.

**Test footprint:** 5 new tests in `tests/opta.ts` (3 CRIT-2 boundary cases + 1 CRIT-3 negative + 1 HIGH-1 negative); 3 new boundary fixtures in `tests/_pyth_fixtures.ts`; positive case for HIGH-1 covered implicitly by every existing successful `mint_from_vault` test. **Suite went from 73/34 → 78/34** with no regressions on previously-green tests; the 34 baseline reds are dominated by `PriceUpdateBeforeExpiry` cascades from older `Date.now()`-based fixtures (documented in `tests/_pyth_fixtures.ts:184` as deferred to a separate refactor arc).

**Devnet redeploys:** `opta_transfer_hook` upgraded to slot **459869839** (was 459388006); `opta` upgraded to slot **459869998** (was 459797314). Both IDLs auto-upgraded inline by `anchor deploy` (no separate `anchor idl upgrade` needed). Total wallet cost: 0.018 SOL for both program upgrades.

**Smoke verification:** on-chain IDL fetched post-deploy via `anchor idl fetch` confirms both new error variants land on devnet — `PriceConfidenceTooWide` on opta and `InvalidProtocolState` on the hook. Local test suite proves both gates fire with the same `.so` binaries that were deployed.

Audit report at `.context/outputs/6/audit-report-part1.md` (gitignored). Out-of-scope findings (CRIT-1, CRIT-4, HIGH-2/3/4/5, MEDIUM/LOW/INFO) tracked for follow-up arcs; CRIT-1 is the most consequential remaining item — it's a settlement-race bug where writers can drain before ITM holders exercise.

### What changed in the Run-7 audit-fix arc (May 4 2026, evening, commits `280c1c6` → bundled-deploy)

Six fix commits + one chore-deploy commit. Closes 4 more PART 1 findings from Run-6 (CRIT-1, HIGH-2, HIGH-3, HIGH-4 + zero-feed subset of HIGH-5) plus 4 PART 2 findings from a frontend Run-7 audit (HIGH-1, HIGH-2, HIGH-3, MED-1). One bundled `anchor deploy` at the end refreshed both programs.

- **CRIT-1 — holders-first gate** (commit `280c1c6`, Rust + redeploy at slot `460039090`). Pre-fix, the formula `writer_remaining = (shares × collateral_remaining) / total_shares` plus the dual-decrement at `withdraw_post_settlement.rs` and `auto_finalize_writers.rs` had no holders-first gate — a sole writer could drain the vault the same slot `settle_vault` landed, capping ITM holder payouts at 0. The gate has two paths: fast path (skip when `total_options_sold == 0`, no holders to harm) and slow path (require `clock.unix_timestamp >= vault.expiry + EXERCISE_WINDOW`, with `EXERCISE_WINDOW = 86_400` at `state/shared_vault.rs:133`). New error `HolderExerciseWindowOpen` (code 6041). Test footprint: 4 active + 3 skipped (after-window paths blocked on bankrun/litesvm adoption — no clock-warp in localnet today). Suite went 78/34 → 82/34 (4 new green tests).
- **PART 2 HIGH-1 — IDL-driven errorDecoder rewrite** (commit `5a230b1`, frontend). The prior static `CUSTOM_ERRORS` table in `app/src/utils/errorDecoder.ts` was authored against the v1 P2P enum and drifted across the v1→v2 reshuffle plus three subsequent patches — 36 of 42 active codes displayed the message of an entirely different on-chain failure (e.g. `PriceConfidenceTooWide` showed "Insufficient free collateral..."). Rewrite parses `app/src/idl/opta.json`'s `errors[]` array at module load and builds a code→message `Record` from the IDL, layered with a 5-entry `FRIENDLY_OVERRIDES` map keyed by VARIANT NAME (not code, so reorders don't break it) for cases where the IDL msg is broken (e.g. `HolderExerciseWindowOpen`'s literal `\\\n` artifact from the multi-line `#[msg]` macro) or where we have strictly friendlier copy. Wallet-replay sentinel preservation verified byte-identical at `errorDecoder.ts:71` ("Transaction already confirmed.") — 8 consumer sites match `.includes("already confirmed")` to upgrade error→success.
- **PART 2 HIGH-2 + HIGH-3 — IDL-drift field renames in Portfolio + Markets** (commit `b1356d2`, frontend). Same defect class as PART 2 HIGH-1: handler code reading non-existent fields after the v1→v2 IDL reshuffle. `positions.ts:163-164` read `vaultMint.account.totalSupply` and `.premium` (neither exists; canonical fields are `quantityMinted` and `premiumPerContract`); cost basis silently $0 across every Portfolio row, P&L falsely inflated. `useMarketsData.ts:195` read `v.account.totalPremiumReceived` (canonical field is `netPremiumCollected`); "Premia Written" headline always $0. Fix is two field renames + dropping a stale `Position.totalSupply` field that was dead per grep. Stale JSDoc at `useMarketsData.ts:65` corrected too.
- **PART 2 MED-1 — settled-locked writer-row state** (commit `6902a61`, frontend). Closes the UX gap from CRIT-1: pre-fix, writers whose vault settled <24h ago saw the "Withdraw Collateral" button enabled and clicked into a guaranteed `HolderExerciseWindowOpen` revert. Added `settled-locked` to `WriterRowState` union, slotted as the first sub-branch of `isSettled` in `writerRows.ts`. Lock predicate mirrors the on-chain gate verbatim: `isSettled && totalOptionsSold > 0 && now < expiry + EXERCISE_WINDOW_SECONDS`. The `EXERCISE_WINDOW_SECONDS = 86_400` constant is exported from `writerRows.ts` as the single frontend source of truth. Locked rows render "Settled · Locked" with subtitle "Locked until DD MMM, HH:MM UTC" via a new `formatLockUnlock` helper. `primaryAction = "settling"` reuses the existing non-clickable button path. WriterSummaryBand semantic decisions: settled-locked counts in `settledCount` but NOT in `openCount` or `collateralLocked`.
- **PART 1 HIGH-2 + HIGH-3 + zero-feed migrate guard** (commit `6092e58`, Rust). HIGH-2: `create_market` was permissionless; griefer could register `("SOL", random_bytes, 0)` and lock the SOL namespace until manual `migrate_pyth_feed` recovery. Closed with admin-gate at top of handler: `require_keys_eq!(creator, protocol_state.admin, OptaError::Unauthorized)` (matches the canonical pattern in `migrate_pyth_feed.rs:33-37`). Field name `creator` preserved in `CreateMarket` struct to avoid IDL ripple to `NewMarketModal.tsx`; doc-comment updates only. HIGH-3: `create_shared_vault` accepted any market with no inspection of `pyth_feed_id`; combined with HIGH-2 pre-fix this allowed vaults to be created on top of bogus markets that would never settle. Closed with `require!(market.pyth_feed_id != [0u8; 32], InvalidPythFeedId)` at the top of the handler. Same zero-check added to `migrate_pyth_feed` after the existing admin gate — strict subset of HIGH-5 (full feed-vs-asset proof validation deferred to its own arc). New error `InvalidPythFeedId` (code 6042). Frontend gets the new error message automatically via PART 2 HIGH-1's IDL-driven decoder.
- **PART 1 HIGH-4 — reject zero settlement price** (commit `129b307`, Rust). `pyth_price_to_usdc` at `solmath_bridge.rs:82-96` had `require!(price > 0, ...)` on the input but no result-side guard. Integer truncation in the divide path (when `shift = 6 + exponent < 0`) returns `Ok(0)` for sub-microUSDC inputs (e.g. price=1, exponent=-8 → 1/100 = 0). Fed into `settle_expiry.rs:137` and stored as `SettlementRecord.settlement_price = 0`; PUT exercise then computed `max(0, strike - 0) = strike`, paying every PUT contract full strike and exhausting the vault. Closed with `require!(result > 0, OptaError::InvalidSettlementPrice)` after the divide. Sister function `pyth_price_to_scale` had the identical defect (currently test-only, but a latent footgun) and was fixed in the same commit for class-discipline.
- **Bundled deploy and IDL refresh** (chore-deploy commit). `anchor build` + `anchor deploy --provider.cluster devnet` shipped the four PART 1 fixes in one redeploy: opta program at slot `460088947` (was `460039090` from CRIT-1), opta_transfer_hook at slot `460089133` (was `459869839`; redeployed automatically by `anchor deploy` despite no source change). IDL refreshed in `app/src/idl/opta.{json,ts}`. Frontend rebuilt clean (1,204.11 kB main chunk, +0.14 kB delta from the new error variant + doc-comment text). Pre-redeploy market scan via new `scripts/scan-zero-feed-markets.ts` confirmed zero zero-feed markets exist on devnet — required before deploying the HIGH-3 guard. Total wallet cost: 0.005945 SOL.

**Pre-redeploy market scan discovery:** the scan surfaced one v1-era orphan market account (`J6eNd9A5pTACMXycdtDG7LV2TYsQtEhzXgnGNjyCk69Q`) with the OptionsMarket discriminator but a malformed nameLen field — predates the Stage 2 prune. It cannot be deserialized by current code, so it cannot be referenced by `create_shared_vault`'s new HIGH-3 gate; the guard never fires on it. Also explains why `program.account.optionsMarket.all()` throws "offset out of range" (Anchor reads nameLen=3955359748 and tries to seek past the end). The scan script handles it gracefully via a `nameLen > 16` skip-with-warning path. Connected to PART 2 audit's LOW-9 observation about `safeFetchAll`'s strict validator dropping malformed markets in the frontend.

**Audit reports** at `.context/outputs/6/audit-report-part1.md` (PART 1 Rust) and `.context/outputs/7/audit-report-part2.md` (PART 2 frontend); both gitignored. Out-of-scope deferred items tracked in §7.

---

## 3. Tech Stack

### Languages
- **Rust** — Solana on-chain programs (Anchor framework)
- **TypeScript** — frontend app, tests, scripts, crank bot, SDK

### On-chain / Anchor
- Anchor `0.32.1`, Rust toolchain pinned via `rust-toolchain.toml`
- SPL **Token-2022** v8.0.1 (`@solana/spl-token ^0.4.14`)
- Cargo workspace at repo root; `programs/*` are the workspace members
- Release profile uses `overflow-checks = true`, `lto = "fat"`

### Frontend (`app/`)
- Vite 8 + React 19 + TypeScript 5.9
- Tailwind 4 (via `@tailwindcss/vite`)
- Solana wallet adapter (`@solana/wallet-adapter-*`) + `@solana/web3.js ^1.98`
- `@coral-xyz/anchor ^0.32.1`
- `@pythnetwork/pyth-solana-receiver ^0.14.0`
- Manual Buffer polyfill in `app/src/polyfills.ts` (see §11)
- Cluster-aware Solscan helpers in `app/src/utils/solscan.tsx` and cluster inference in `app/src/utils/env.ts` (`inferClusterFromUrl` / `getClusterDisplayLabel` / `getSolscanTxUrl` / `solscanAccountUrl` — devnet/mainnet flips automatically when the connection RPC changes)

### Crank (`crank/`)
- Node.js with `ts-node` runtime; one-file bot at `crank/bot.ts`
- Cross-imports helpers from `app/src/` via the `@app/*` tsconfig path alias
- Same Solana stack pins as `app/` (`@coral-xyz/anchor`, `@solana/web3.js`, `@pythnetwork/pyth-solana-receiver`)
- Dependency override: `rpc-websockets@9.3.7` and `@solana/web3.js ^1.98.4` are forced via the `overrides` block to dedupe across jito-ts's transitive pull of an old web3.js (mirrored from `app/package.json`)

### Tests
- Mocha + Chai + `ts-mocha` at repo root, invoked by `anchor test` (or by `run-tests.sh` for finer-grained control — see §11)

### External services
- **Pyth Network** — on-chain oracle for pricing + settlement via the Pull oracle (PriceUpdateV2). Settlement now reads the EMA price within a 60-second window of expiry-time and records the consumed publish_time on-chain (post-`4dc6250`).
- **Hermes mainnet** (`https://hermes.pyth.network`) — off-chain price update fetching; Beta is supported as an override but not used by default
- **Helius devnet RPC** — operator must set `VITE_RPC_URL` in `app/.env.local` (gitignored) and `OPTA_RPC_URL` for the crank
- **Vercel** — frontend hosting at `opta-solana.vercel.app`. Auto-deploys on push to `main`.
- **solmath** — on-chain Black-Scholes math library

---

## 4. Architecture

### Programs (2)

| Program | Program ID | Purpose |
|---|---|---|
| `opta` | `CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq` | Main protocol |
| `opta_transfer_hook` | `83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG` | Token-2022 transfer hook — blocks transfers after expiry |

### Instruction inventory (21 instructions on the main program)

> Note: the prior handoff cited 17. Counting actual files in `programs/opta/src/instructions/` excluding `mod.rs` returns 21. The four-instruction delta is the V2 secondary trio (`list_v2_for_resale`, `buy_v2_resale`, `cancel_v2_resale`) plus `auto_cancel_listings`, all shipped between Apr 30 and May 3. The writer-PF arc added zero instructions (UI-only).

**Admin (2):** `initialize_protocol`, `initialize_epoch_config`

**Market lifecycle (2):** `create_market` (permissionless, idempotent), `migrate_pyth_feed` (admin)

**Vault writer flow (5):** `create_shared_vault`, `deposit_to_vault`, `mint_from_vault`, `withdraw_from_vault`, `claim_premium`

**Vault buyer flow (1):** `purchase_from_vault`

**Settlement (4):** `settle_expiry` (post Pyth update + create SettlementRecord, permissionless, EMA-at-expiry with publish_time audit trail post-`4dc6250`), `settle_vault` (mark vault settled, permissionless), `auto_finalize_holders` (permissionless, burns holder tokens via PermanentDelegate and distributes ITM payouts in batches), `auto_finalize_writers` (permissionless, returns writer collateral + premium, manually closes writer positions refunding rent to writers, sweeps dust to protocol treasury and closes vault USDC on the last writer in a vault)

**Manual cleanup (3):** `exercise_from_vault` (holder-signed, fallback for power users), `withdraw_post_settlement` (writer-signed, fallback; auto-claims premium internally per HIGH-01 fix), `burn_unsold_from_vault` (writer-signed, burns own unsold escrow inventory)

**V2 secondary listing (3):** `list_v2_for_resale`, `buy_v2_resale`, `cancel_v2_resale` (writer- or buyer-signed; PDA per `(option_mint, seller)` so at most one active listing per seller per mint)

**Auto-cleanup (1):** `auto_cancel_listings` (permissionless, cleans up expired V2 listings)

The original V1 P2P instructions (`write_option`, `purchase_option`, `settle_market`, `exercise_option`, `expire_option`, `cancel_option`, `list_for_resale`, `buy_resale`, `cancel_resale`) were archived in commit `54c35c5` (Stage 1) and are no longer in `programs/opta/`. They live in `archive/` for reference only.

### State accounts — `programs/opta/src/state/`

`protocol.rs`, `market.rs`, `writer_position.rs`, `epoch_config.rs`, `shared_vault.rs`, `vault_mint.rs`, `settlement_record.rs`, `vault_resale_listing.rs`

### Token-2022 extensions on every option mint
- **TransferHook** — blocks user-to-user transfers after expiry (enforced by the hook program)
- **PermanentDelegate** — protocol_state PDA holds delegate authority; used by `auto_finalize_holders` for permissionless multi-holder burns at expiry
- **MetadataPointer + TokenMetadata** — on-chain term sheet (asset, strike, expiry, type)

### Frontend — `app/src/`
- Pages: `Landing`, `Markets`, `Trade` (now also hosts the secondary listings unified into the buy modal), `Write`, `Portfolio` (now two-ledger: buyer side + writer side as parallel sections), `DocsPage`
- Hooks: `useProgram`, `useAccounts`, `useFetchAccounts`, `useVaults`, `useTokenMetadata`, `usePythPrices`
- Utils: `blackScholes.ts`, `constants.ts`, `errorDecoder.ts`, `format.ts`, `tokenMetadata.ts`, `vaultFilters.ts`, `pythPullPost.ts`, `hermesCatalog.ts`, `env.ts`, `solscan.tsx`
- Feature flag: `USE_V2_VAULTS = true` in `app/src/utils/constants.ts` (V1 hidden but archive code referenced via this flag)

### Frontend Hermes flow
- `usePythPrices` is Hermes-only post-P4b — no CoinGecko/Jupiter/static fallbacks
- `hermesCatalog.ts` fetches the live Pyth catalog; cache key derives from URL host (auto-busts on endpoint switch)
- `pythPullPost.ts` exports `settleAllForExpiry` that the UI Settle button (P4d) and the crank both consume; it accepts a `hermesBase` parameter, defaulting to mainnet

### Data flow — user buys an option (V2 vault path, vault-direct or secondary listing)
1. User lands on `/trade`, UI loads live spot prices via `usePythPrices` (Hermes mainnet)
2. UI fetches all markets + shared vaults + active V2 resale listings
3. UI computes B-S fair value client-side in `blackScholes.ts` for the grid; resale listings join the chain-row data inline
4. User clicks Buy → `BuyModal` routes to either `purchase_from_vault` (vault inventory) or `buy_v2_resale` (seller listing) based on price/depth
5. On-chain: vault transfers option tokens from its escrow ATA to buyer (or seller's escrow forwards to buyer); transfer hook checks expiry; premium goes to vault (in vault path) or to seller minus protocol fee (in resale path)
6. **At expiry:** the crank's settle pass calls `settle_expiry` (creates SettlementRecord) + `settle_vault` (flips `is_settled = true`).
7. **On the next tick after settle:** the crank's holder-finalize pass enumerates Token-2022 accounts holding the option mint(s), filters out zero-balance and protocol-owned escrows, and calls `auto_finalize_holders` in batches — burning each holder's tokens and paying ITM holders their `(settlement − strike) × quantity` USDC in the same instruction. Idempotent across batches.
8. **Then the writer-finalize pass:** the crank enumerates `WriterPosition` accounts and calls `auto_finalize_writers` in batches — each writer receives unclaimed premium + pro-rata collateral share, their `WriterPosition` is closed (rent refunded to writer), and on the last writer in a vault any USDC dust is swept to the protocol treasury and the `vault_usdc_account` is closed (rent to treasury).
9. Crank bot at `crank/bot.ts` runs on a 5-minute tick (configurable via `OPTA_CRANK_TICK_MS`) covering all three passes plus auto-cancel of expired V2 listings.

### Supporting code
- `sdk/` — TS router SDK wrapping V2 vault flows
- `crank/bot.ts` — settle + auto-finalize + auto-cancel-listings automation crank (see §5); see `crank/autoFinalize.ts` for the holder/writer enumeration and batching logic
- `crank/migrate-sol-feed.ts` — one-shot admin script that rotated SOL's feed_id from Beta to mainnet on 2026-04-29
- `scripts/` — seed scripts, debug helpers, faucet setup, `pyth-feed-ids.csv`

---

## 5. Deployments

| What | Where |
|---|---|
| Both programs | **Solana devnet**, program IDs above. Last upgraded slots: opta = **`460088947`** (Run-7 audit-fix arc bundled redeploy 2026-05-04 evening; CRIT-1 was at `460039090`; morning audit-fix arc was at `459869998`; collateral symmetry was at `459797314`; settlement-pricing was at `459782078`); opta_transfer_hook = **`460089133`** (Run-7 redeploy bumped automatically by anchor; previously `459869839` from morning audit-fix arc) |
| Frontend | **Vercel** — `https://opta-solana.vercel.app` (root dir `app/`, SPA rewrite via `vercel.json`). Auto-deploys on push to `main`. Live at `15a3ac9` as of 2026-05-03 ~15:24Z; the audit-fix arc IDL chore (`8e638b9`) has not yet been pushed to `main` at the time this section was written — for the live-site head run `git log -1 origin/main --oneline` |
| Crank bot | Run manually via `npm start` from `crank/` (or as a background process under WSL with `nohup`). Reads `OPTA_RPC_URL` and `OPTA_CRANK_KEYPAIR` from env. **NOT** running as a daemon — operator must start it explicitly |
| Devnet USDC mint | `AytU5HUQRew9VdUdrzQuZvZ7s14pHLiYjAF5WqdK3oxL` (in `app/src/utils/constants.ts`) |
| Devnet faucet wallet | Public keypair baked into `app/src/utils/constants.ts` for demo USDC distribution; in-code warnings flag it |
| Domain | `opta.fyi` purchased but not yet attached to Vercel — parked |

**Environment files (all gitignored as `.env*`):**
- `app/.env.local` — operator must set `VITE_RPC_URL` (Helius devnet URL); optionally `VITE_HERMES_BASE` (defaults to mainnet)
- `crank/` — set `OPTA_RPC_URL` at the command line or via shell env. Optional: `OPTA_CRANK_KEYPAIR` (default `~/.config/solana/id.json`), `OPTA_CRANK_TICK_MS` (default 300000), `OPTA_HERMES_BASE` (default mainnet)

The `app/.env.example` and `crank/README.md` document the expected variable names without leaking the Helius API key.

---

## 6. Current State — What Works

- All **21 instructions** deployed and live on devnet; main program at slot `460088947`, transfer hook at slot `460089133` (both bumped in the Run-7 audit-fix arc bundled redeploy 2026-05-04 evening)
- **112 tests in the suite** post the audit-fix arc; **78 passing / 34 failing**. Five new tests landed (3 CRIT-2 boundary cases + 1 CRIT-3 negative + 1 HIGH-1 negative), zero regressions on previously-green tests. The 34 baseline reds are unchanged from the May-3 state — dominated by `PriceUpdateBeforeExpiry` cascades from older `Date.now()`-based fixtures (documented in `tests/_pyth_fixtures.ts:184` as deferred to a separate refactor arc) and the historical `PriceTooOld` cascade from the Pull oracle migration. See §10 Tier-2 for the planned refresh
- **Full frontend** live on Vercel: Trade (Deribit-style chain with secondary listings unified into the buy modal), Write, Portfolio (now two-ledger — buyer side + writer side as parallel sections), Markets (with "+ New Market" promoted to AppNav), Docs
- **On-chain Black-Scholes** pricing + 5 Greeks via solmath (~50K CU)
- **Hermes-driven catalog + spot prices** — fetches live from `hermes.pyth.network`
- **Permissionless settlement via Pyth Pull oracle** with EMA-at-expiry pricing and on-chain publish_time audit trail (post-`4dc6250`)
- **Symmetric 1× strike collateral** for both CALL and PUT; Model B premium framing throughout the UI (post-`a8b5f14`)
- **Migrate-Pyth-feed admin tool** — admin-only Portfolio section that lets the protocol admin rotate any market's feed_id (used live on 2026-04-29 to switch SOL from Beta feed to mainnet)
- **Settle automation crank** — runs settle + holder-finalize + writer-finalize + auto-cancel-listings on every tick
- **Permissionless auto-finalize at expiry** — `auto_finalize_holders` burns holder tokens and pays ITM payouts; `auto_finalize_writers` returns writer collateral + premium, closes positions, sweeps dust to treasury (verified end-to-end via the Step 6 smoke on 2026-04-30, commit `37c9b4b` — three vaults processed, math reconciled to the lamport)
- **V2 secondary listing** — buyer-flavored flow live in the unified Trade `BuyModal`: list, cancel, buy-from-listing (post-merge arc, commits `9e76699` through `c5ce63c`)
- **Writer-side portfolio dashboard** — § 02 Vaults Written section between Open and Closed Positions, with Claim Accrued Premium / Withdraw Collateral primary actions, Burn unsold secondary action (gated), state badges (Live / Expired·Pending / Settled·ITM / Settled·OTM), and a sibling SummaryBand showing Vaults Written / Collateral Locked / Claimable Premium / Premium Realized
- **Solscan icon on every Portfolio row** (both ledgers) — vault PDA is the canonical link target; cluster-aware (devnet/mainnet auto-detected from RPC URL)

### Smoke test verified 2026-05-03 (settlement pricing — `4dc6250`)

Devnet redeploy at slot `459782078`. A vault with near-term expiry was settled by the crank; the on-chain `SettlementRecord.publish_time` field showed a value within the 60-second window of the vault's `expiry`, and the recorded settlement price matched the Pyth EMA at expiry-time (not the spot at crank-tick time). Late-arrival drift no longer possible without the on-chain check rejecting the update.

### Smoke test verified 2026-05-03 (collateral symmetry — `a8b5f14`)

Devnet redeploy at slot `459797314`. The legacy SOL CALL May-9 vault, originally created under the 2× formula, recognized $450 of previously-locked collateral as withdrawable post-redeploy (the 1× formula now requires only the strike-magnitude committed). The writer was able to call `withdraw_from_vault` for the freed half. Both CALL and PUT writers now lock equal-strike-magnitude collateral.

### Smoke test verified 2026-05-03 (writer-PF dashboard — `1480b3c` then `15a3ac9`)

End-to-end on devnet, two wallets:
- Wallet A wrote a SOL CALL $50 vault (1 contract, $50 collateral)
- Wallet B bought 1 contract for $34.16
- Wallet A's `/portfolio` showed **Claimable Premium $33.98** (= $34.16 minus 50bps fee), correctly displayed in both the row's Claimable column and the WriterSummaryBand cell
- Wallet A clicked "Claim Accrued Premium" → single Phantom popup → ~2s later, three cells transitioned together as a coordinated set: Row Claimable $33.98 → $0.00; Band Claimable Premium $33.98 → $0.00; Band Premium Realized $0.00 → $33.98
- Toast: "Premium claimed". Math reconciled to the cent.

This validated the D5b live-update pattern (refetchAll + commitment=confirmed → ~2s coordinated UI update with no manual reload) as a demo-grade interaction.

**Vercel only went green on `15a3ac9`.** The earlier `1480b3c` failed Vercel's clean-room build with a stale-import error in `WrittenPositionsSection.tsx` that local `tsc --noEmit` had silently passed (Windows incremental cache). The one-line follow-up commit fixed it; live site at `opta-solana.vercel.app/portfolio` returns 200 OK serving `15a3ac9`.

### Smoke tests verified earlier (compressed)

- **2026-04-29 (Pyth migration arc):** A SOL CALL $90 vault settled cleanly via the crank after the SOL feed was migrated from Beta to mainnet. SettlementRecord PDA created, vault `is_settled = true`, atomic Pyth Receiver + Wormhole + Opta settle tx confirmed. Validated permissionless settlement.
- **2026-04-30 (auto-finalize Step 6):** Three vaults processed end-to-end through `auto_finalize_holders` + `auto_finalize_writers`. ITM buyer received $100.19 USDC automatically with no buyer interaction; writers received pro-rata collateral + premium; treasury accumulated $0.015 USDC + 6,117,840 lamports of rent across three closed `vault_usdc_account` PDAs. Math reconciled to the lamport. Validated the "wake up with USDC, no clicks" UX.

Both prior smoke runs are detailed in `MIGRATION_LOG.md`.

---

## 7. Current State — In Progress / Known Gaps

### Closed in the Run-7 audit-fix arc (May 4 2026, evening)

- **PART 1 CRIT-1 — settlement race / writer-drains-before-holders** — closed by `280c1c6`. 24h `EXERCISE_WINDOW` gate at `withdraw_post_settlement.rs:40-50` and `auto_finalize_writers.rs:68-80`. Fast path skips on `total_options_sold == 0` (no holders to harm).
- **PART 1 HIGH-2 — `create_market` permissionless griefing** — closed by `6092e58`. Admin-gate at top of handler matching `migrate_pyth_feed`'s pattern.
- **PART 1 HIGH-3 — `create_shared_vault` accepted zero-feed markets** — closed by `6092e58`. Defense-in-depth zero-feed `require!` at top of handler.
- **PART 1 HIGH-4 — `pyth_price_to_usdc` silent zero from integer truncation** — closed by `129b307`. Result-side `require!(result > 0)` after divide; sister function `pyth_price_to_scale` fixed for class-discipline.
- **PART 1 HIGH-5 (zero-feed subset)** — closed by `6092e58`. Same zero-feed `require!` added to `migrate_pyth_feed` after the existing admin gate. Full proof-validation arc remains parked (see open gaps below).
- **PART 2 HIGH-1 — `errorDecoder.ts` wholesale stale** — closed by `5a230b1`. IDL-driven runtime parse + 5-entry FRIENDLY_OVERRIDES; 36-of-42 mislabeled codes now correct.
- **PART 2 HIGH-2 — V2 buyer cost basis silently $0** — closed by `b1356d2`. `vaultMint.account.totalSupply` / `.premium` → canonical `premiumPerContract`; dead `Position.totalSupply` field removed.
- **PART 2 HIGH-3 — Markets "Premia Written" always $0** — closed by `b1356d2`. `v.account.totalPremiumReceived` → canonical `netPremiumCollected`.
- **PART 2 MED-1 — writer-row state machine missing the 24h lockup** — closed by `6902a61`. New `settled-locked` state mirrors the on-chain gate verbatim; UX prevents the click that would bounce off the on-chain revert.

### Closed in the audit-fix arc (May 4 2026)

- **CRIT-2 — Pyth EMA confidence-interval gate** — closed by `ceef4af`. `settle_expiry` now reverts `PriceConfidenceTooWide` (code 6040) when the EMA conf width exceeds `MAX_CONF_BPS = 200` (2%) of `|ema_price|`.
- **CRIT-3 — admin gate on `initialize_protocol`** — closed by `8005cae`. Hardcoded deployer pubkey gate at the top of the handler; first-caller-becomes-admin attack neutralized.
- **HIGH-1 — `protocol_state` PDA validation in opta_transfer_hook** — closed by `d0f0c2e`. Hook now derives the expected canonical PDA from `OPTA_PROGRAM_ID` + `OPTA_PROTOCOL_SEED` and rejects any `protocol_state` arg that doesn't match.

### Closed in the May 3 polish run

- **Settlement late-crank drift bug** — closed by `4dc6250` (EMA at expiry-time + 60s window + on-chain audit trail).
- **2× CALL collateral asymmetry** — closed by `a8b5f14` (symmetric 1× strike for both sides, Model B premium framing locked in UI copy).
- **Writer-side portfolio invisibility** — closed by `1480b3c` + `15a3ac9` (§ 02 Vaults Written section, claim/withdraw flows wired, Solscan retrofit on both ledgers).

### Largest open item

- **Test infrastructure refresh.** Cumulative test debt across three Rust arcs (migration P1–P6, settlement-pricing fix, collateral symmetry); the writer-PF arc was UI-only and did not contribute. 107 tests in the suite, ~34 failing. The failures cluster around `zzz-audit-fixes.ts` fixture staleness (zzz-prefix runs last on alpha ordering; the earlier fixtures have drifted), the historical `PriceTooOld` cascade from the Pull oracle migration, and a few new failures from the settlement / collateral arc test additions that haven't been retuned. Health goal: get back to a green (or known-cleanly-failing) suite. Promoted to Tier-2 explicitly in §10.

### Other open gaps

- **V2 secondary listing — writer-side flavor.** Buyer-flavored secondary path is live in the unified Trade BuyModal (post-merge arc); a writer who mints from their own vault and lists those contracts can use the same flow today, but the UX is framed as a buyer affordance and there's no dedicated "Listings I've made" view on /portfolio. Closest thing to a remaining feature gap; sized as Tier-3 follow-up, not a blocker.
- **Frontend bug — Markets page shows "No markets yet" when an asset is registered but has no vaults.** UX gap, not a chain-side bug.
- **Frontend bug — Indicative Premium panel renders $0.00 for short-dated OTM options.** B-S math is correct; display rounds sub-cent values to $0.00, which looks like a broken state. Needs a "tiny premium" indicator or non-zero floor.
- **Frontend bug — Stale market list on /markets after creating a market via AppNav.** The `+ New Market` modal owns its own state; the Markets page's `useMarketsData` doesn't refetch when the modal closes. User has to refresh.
- **`burn_unsold_from_vault` post-finalize sequencing.** `burn_unsold_from_vault` requires a live `WriterPosition`; auto-finalize closes the position. The cleanup window is BEFORE the writer-finalize pass, not after. Two follow-up paths documented in `MIGRATION_LOG.md`: (1) reorder crank to call `burn_unsold` before writer-finalize, or (2) add a permissionless `auto_burn_unsold_escrow` instruction. Both deferred.
- **Token-2022 / Pyth pull edge cases not exhaustively tested** — the auto-finalize Step 6 smoke validated three vaults end-to-end, but ITM payout, secondary-market holder, and multi-holder scenarios have not all been exercised in tests.
- **Broken BTC PUT vault on devnet (parked, follow-up arc).** User-reported $750k BTC PUT $75,000 / 8 May vault stuck at `total_options_minted = 0` despite full collateral + populated `WriterPosition`. On-chain state is well-formed (vault `3UKiNyDB3qmXG3h2NHG3Tmrzvq7UPPFbLxfs6wcTqtGD`, creator `GkG1UX8ML4UzNSGUtJxBWfRRWCdH7YejdhfuxFWTRFAx`, vault_type Epoch); user has never successfully minted from a PUT or Epoch vault, only from Custom CALLs. `mint_from_vault` validation math passes cleanly for these inputs (verified analytically: u128 share calc 5.6e23 well under overflow, `available == total_collateral_needed`). 5 hypotheses surveyed; can't isolate the failure mode without a browser-console repro (Phantom popup behavior, tx signature, exact error). Diagnosis report sits in chat 2026-05-04. Vault funds recoverable via `withdraw_from_vault` once root cause is identified — `premium_claimed = 0` already, no claim-first gate to navigate.
- **Audit follow-up backlog (post-Run-7):**
  - **PART 1 HIGH-5 (full)** — `migrate_pyth_feed` proof validation (`PriceUpdateV2` account + `pu.price_message.feed_id == new_pyth_feed_id` check). Tonight's bundle closed only the zero-feed subset. Full fix is Rust + frontend `MigrateFeedTools.tsx` (Pyth post flow ~150 LOC + new `@pythnetwork/pyth-solana-receiver` dep) + the two crank migrate scripts. Sized as its own arc.
  - **PART 1 CRIT-4** — CALL undercollateralization disclosure path. Per user, won't-fix as code (the protocol design choice is locked); document in whitepaper + add UI disclaimer on the trade screen.
  - **PART 2 HIGH-4** — `usePythPrices` stale-price UX. Cache-fallback hook serves stale prices indefinitely on Hermes outage with no UI indication. 3-tier fix; minimum is ~20 LOC (stale flag + 4 consumer renders).
  - **Frontend NewMarketModal admin-gate** — hide the "Create Market" CTA for non-admin wallets. ~10 LOC. Today the button is visible to everyone; non-admin clicks fail with a friendly "Unauthorized" toast via the IDL-driven decoder, but UX is still confusing.
  - **Decoder runtime warning for unmapped error codes** — surface a console.warn or similar when an unknown code surfaces from on-chain (so future Rust additions that don't yet have IDL refresh in the frontend become loud). Not in any Run-7 finding directly; surfaced during HIGH-1 review.
  - **Bankrun / litesvm test-infra adoption** — unblocks 3 skipped after-window CRIT-1 tests + future time-gated logic. Today's localnet has no clock-warp.
  - **Manual post-redeploy CRIT-1 smoke** — wait for a real ITM-with-buyers vault to expire on devnet, then ~24h later confirm the gate opens correctly via `withdraw_post_settlement`. Bookkeeping reminder; not a code task.
  - **PART 1 MEDIUMs (7), LOWs (10), INFOs (8)** — full triage in a future arc. None blocking. MED-1 (Token-2022 raw-byte balance reads at offset 64..72 lack length+type validation) is the most concrete; others include MED-3 (dust-sweep destination parity) and MED-4 (snapshot pyth_feed_id onto SharedVault at create time).
  - **PART 2 MEDIUMs (8 minus MED-1 shipped tonight = 7), LOWs (9), INFOs (6)** — full triage in a future arc. Most actionable: MED-7 (faucet keypair signs arbitrary tx — devnet-bounded today, mainnet-fatal), MED-8 (typed return shape from decodeError to harden the wallet-replay sentinel layer).
  - **Test suite refresh** — ~34 failing tests from cumulative migration debt. Refactor `zzz-audit-fixes.ts` and migration-arc fixtures so the suite is either green or cleanly-skipped.
  - **`scripts/seed-demo-fresh.ts` staleness** — caught during the BTC PUT diagnosis arc; uses 4-arg `createSharedVault` (current handler is 5-arg) and 5-element marketPda seed (current is per-asset). Fix on next demo-seed need.
- Audit reports at `.context/outputs/6/audit-report-part1.md` (PART 1 Rust, Run-6) and `.context/outputs/7/audit-report-part2.md` (PART 2 frontend, Run-7) — both gitignored.

### Resolved during the May 1–3 polish run

- ~~"MAINNET · SOLANA" header copy on the live site~~ — fixed by the cluster-aware UI work (commit `4f2f5e6`); header now shows "Devnet · Solana" or "Mainnet · Solana" derived from the RPC URL host.

### Minor housekeeping

- Several orphaned write-buffer accounts on devnet from earlier deploy sessions — all 0 SOL balance, harmless. Cleanup with `solana program close <buffer-pubkey>` is purely cosmetic.
- The Vercel project doesn't yet have `opta.fyi` attached.
- X handle `@opta` (or similar) unclaimed.
- TSLA market exists on-chain with the Beta feed_id; has zero vaults. If TSLA is ever needed for a demo, it'll need its own `migrate_pyth_feed` call.
- Two test vaults (Apr 29 + fresh ITM) have unsold `purchase_escrow` tokens (15 + 2 tokens). Inert — TransferHook blocks transfers post-expiry, no economic value, ~0.004 SOL of rent locked. See "burn_unsold_from_vault post-finalize sequencing" above.

---

## 8. Key Decisions & Design Choices

- **Token-2022 over classic SPL** — needed TransferHook + PermanentDelegate + MetadataPointer for the "living token" lifecycle. Foundational.
- **Options represented as tradable tokens** — anyone holding them at expiry gets paid. Enables DEX listing and a built-in secondary market.
- **European-style settlement, USDC-only** — simpler to audit and price; American-style is post-Colosseum work.
- **V2 shared-vault liquidity model is the only one exposed in the UI.** V1 P2P code archived to `archive/` in Stage 1.
- **On-chain Black-Scholes via solmath** — expensive (~50K CU) but enables CPI composability and AI-agent-readable pricing without trusting an off-chain oracle.
- **Pyth Pull oracle (PriceUpdateV2) over the legacy Push oracle** — Push was deprecated; Pull is the modern path.
- **Mainnet Hermes feeds, even though the protocol runs on Solana devnet** — Solana devnet's Wormhole Core Bridge only verifies Pyth's production guardian set, not Beta's.
- **Permissionless settlement** — `settle_expiry` and `settle_vault` are both signer-permissionless. Anyone can settle.
- **Crank-driven automation, not "token natively self-resolves"** — Solana programs are passive (no native scheduling), so the user-experience claim "tokens resolve themselves at expiry" is achieved by a crank using PermanentDelegate authority.
- **Auto-finalize is permissionless and crank-driven, dust to treasury.** `WriterPosition` rent returns to the writer; `vault_usdc_account` rent + USDC dust go to the protocol treasury.
- **Settlement reads Pyth EMA at expiry-time, with a 60-second window and on-chain `publish_time` audit trail.** Locked 2026-05-03 to fix the late-crank drift bug. The audit-trail field means anyone can verify post-hoc which price update settled a given vault.
- **Symmetric 1× strike collateral for both CALL and PUT.** Locked 2026-05-03; the 2× CALL multiplier had been a vestigial safety margin from v1. Premium framing follows **Model B**: buyer pays premium to the vault at trade time, premium accrues to the writer's claimable balance proportional to vault sales. Premium is not contingent on OTM expiry.
- **Writer dashboard uses live-update via refetchAll + `commitment="confirmed"` (D5b pattern).** No setTimeout, no polling. After every successful writer action, the unified `onSuccess` callback awaits both `refetchAll` and `useVaults().refetch`; cells reflect fresh on-chain state within ~2 seconds. Buyer actions inherit the same chain. Demo-verified on 2026-05-03.
- **Vault PDA is the canonical Solscan target for both ledger sides.** Buyer rows and writer rows link to the SharedVault PDA, not the option mint or the WriterPosition. The vault is the most informative drill-down because it shows pool-level state (collateral, total minted/sold, settlement status). v1 buyer rows fall back to option mint; defensive only — no v1 rows are emitted today.
- **Single repo, two-program Anchor workspace** — programs at `programs/opta/` and `programs/opta-transfer-hook/`.
- **Pyth confidence interval gated at settlement.** `MAX_CONF_BPS = 200` (2% of `|ema_price|`); reverts `PriceConfidenceTooWide` (code 6040). Locked 2026-05-04 to close audit Run-6 finding CRIT-2. Threshold is a global constant in `programs/opta/src/instructions/settle_expiry.rs`; per-asset tuning would require promoting it to a `ProtocolState` field — out of scope for this arc.
- **`initialize_protocol` is gated to a hardcoded deployer pubkey.** `DEPLOYER_PUBKEY = pubkey!("5YRMuuoY3P7z5GeRAAQND7BxgNdmPSa6CSPCJLca1zZk")` in `programs/opta/src/instructions/initialize_protocol.rs`. Reverts `Unauthorized` for any other signer. Locked 2026-05-04 to close audit Run-6 finding CRIT-3. **If the opta program is ever redeployed at a different address with a different deployer key, this constant must update in lockstep.**
- **`opta_transfer_hook::initialize_extra_account_meta_list` validates `protocol_state` against the canonical PDA.** Two consts in the hook program (`OPTA_PROGRAM_ID` and `OPTA_PROTOCOL_SEED`) mirror the source-of-truth declarations in the opta program. The hook derives the expected PDA at handler entry and rejects any caller-supplied `protocol_state` that doesn't match (`InvalidProtocolState`). Locked 2026-05-04 to close audit Run-6 finding HIGH-1. Same lockstep-update caveat as CRIT-3 — both consts must be refreshed if the opta program is ever redeployed at a new address.
- **24-hour holders-first lockup post-settlement.** `EXERCISE_WINDOW = 86_400` at `state/shared_vault.rs:133`; gate at `withdraw_post_settlement.rs:40-50` and `auto_finalize_writers.rs:68-80`. Bypassed when `total_options_sold == 0` (no buyers to harm). Locked 2026-05-04 (evening, commit `280c1c6`) to close audit Run-6 CRIT-1. Frontend mirrors via the `EXERCISE_WINDOW_SECONDS` export from `app/src/pages/portfolio/writerRows.ts` and the `settled-locked` row state.
- **`create_market` is admin-only.** Pattern A handler-level `require_keys_eq!(creator.key, protocol_state.admin, Unauthorized)` matching `migrate_pyth_feed`. Field name `creator` preserved in the struct (only the doc-comment changed) to avoid IDL ripple. Locked 2026-05-04 (commit `6092e58`) to close audit Run-6 HIGH-2. Random-byte griefing of asset namespaces fully closed.
- **Zero-feed grief guard at all three feed-touching write paths.** `create_market`, `create_shared_vault`, and `migrate_pyth_feed` all reject `pyth_feed_id == [0u8; 32]` with new error `InvalidPythFeedId` (code 6042). Defense-in-depth: catches accidental zero-feed registrations even if the admin gate ever regresses or is bypassed. The full feed-vs-asset proof validation (PART 1 HIGH-5) is parked for a separate Rust + frontend arc. Locked 2026-05-04 (commit `6092e58`).
- **Settlement-price result-side guard.** `pyth_price_to_usdc` and `pyth_price_to_scale` both `require!(result > 0, InvalidSettlementPrice)` after the divide path, rejecting silent integer-truncation zeros that would otherwise let PUT exercise pay full strike on every contract. Locked 2026-05-04 (commit `129b307`) to close audit Run-6 HIGH-4.
- **IDL-driven on-chain error decoding on the frontend.** `app/src/utils/errorDecoder.ts` parses `idl.errors[]` at module load and builds the code→message map at runtime, layered with a 5-entry FRIENDLY_OVERRIDES keyed by VARIANT NAME. Retires the entire drift-class bug that prompted PART 2 HIGH-1 (36/42 codes mislabeled pre-fix). New error variants automatically propagate to the UI on next IDL refresh with no app-side change required. The wallet-replay sentinel logic in the same file (`"already been processed"` → `"Transaction already confirmed."`) is preserved byte-identical and explicitly comment-marked as preservation-critical for the BTC PUT race-recovery flow shipped 2026-05-02. Locked 2026-05-04 (commit `5a230b1`).
- **Security:** 5 Rust audit rounds + 2 frontend audits + the May-4 morning audit-fix arc closing 3 of 9 Run-6 findings (CRIT-2, CRIT-3, HIGH-1) + the May-4 evening Run-7 audit-fix arc closing 4 more PART 1 findings (CRIT-1, HIGH-2, HIGH-3, HIGH-4 + zero-feed subset of HIGH-5) and 4 PART 2 findings (HIGH-1, HIGH-2, HIGH-3, MED-1). **0 remaining from rounds 1–5; 7 of 9 PART 1 Run-6 findings closed (CRIT-4 + HIGH-5-full deferred); 4 PART 2 HIGH/MED findings closed (HIGH-4 + 7 MEDs deferred).** Fresh audit recommended before any mainnet talk.

---

## 9. External Dependencies & People

- **Contributors:** only `nankolib` (Nanko). See "Working with the user" at the top.
- **External services:** Pyth Network (Hermes mainnet for off-chain price updates + Pyth Receiver on-chain; Wormhole Core Bridge for VAA verification), Helius (devnet RPC), Vercel (hosting), GitHub (source).
- **Deadlines:** Colosseum Frontier Hackathon submission window has closed (April 2026). No hard deadline pressure as of 2026-05-03; current pace is polish + correctness over velocity.

---

## 10. Immediate Next Steps

In rough priority order:

### Tier 1 — feature blockers

After today's three arcs, the prior Tier-1 (V2 secondary listing) is shipped end-to-end on the buyer side. **No clear new Tier-1 has emerged.** The closest candidates are writer-side resale framing and test-infra refresh, both of which are sized as Tier-2 or smaller.

### Tier 2 — quality polish

1. **Test suite refresh.** 116 tests post Run-7 audit-fix arc, ~34 failing. Refactor `zzz-audit-fixes.ts` and the migration-arc fixtures so the suite is either green or cleanly-skipped; retune the settlement and collateral arc tests against the new on-chain shapes. The 4 new green CRIT-1 tests (`zzz-crit1-holders-first-gate.ts`) added 2026-05-04 plus 3 skipped after-window tests blocked on bankrun adoption. See `MIGRATION_LOG.md` test-harness gotchas for the known failure modes.
2. **Frontend bug bash:** Markets-page-empty-when-asset-has-no-vaults, Indicative Premium $0 display floor, AppNav modal stale-list refetch.
3. **PART 1 HIGH-5 full proof-validation arc.** `migrate_pyth_feed` accepts a `PriceUpdateV2` account and verifies `pu.price_message.feed_id == new_pyth_feed_id`. Rust + frontend `MigrateFeedTools.tsx` (Pyth post flow) + 2 crank migrate scripts. ~250 LOC across 6 files. Tonight's bundle shipped only the zero-feed subset; full closure is its own cohesive arc.
4. **Whitepaper / docs audit.** README, CLAUDE.md, MIGRATION_LOG.md, and on-site copy haven't been retuned for the secondary-market merge, the writer-PF dashboard, or the Run-7 audit-fix work. Honest framing of the crank-driven automation as "no user action required at expiry" rather than overclaiming "no infrastructure."
5. **PART 1 CRIT-4 disclosure path.** Whitepaper + frontend trade-screen disclaimer for the CALL "max payout = strike" cap. Won't-fix as code per user; documentation work.
6. **`opta.fyi` Vercel attachment + DNS setup** when the project is otherwise mainnet-ready.

### Tier 3 — post-launch / mainnet path

7. **Writer-side resale UX framing.** Buyer-flavored secondary flow handles all the on-chain mechanics today; a dedicated "Listings I've made" view on /portfolio with writer-flavored tooltips would close the experience-fidelity gap.
8. **`withdraw_from_vault` mid-life uncommitted-collateral redemption in the writer dashboard.** Per WRITER_PF_PLAN.md D4, the MVP locks one primary action per row; mid-life withdraws would be a secondary affordance. Useful but not blocking.
9. **Frontend NewMarketModal admin-gate** — hide CTA for non-admin wallets (~10 LOC). UX polish; non-admin clicks fail correctly today via decoder toast.
10. **`auto_burn_unsold_escrow` (or crank reorder)** to close the burn_unsold_from_vault post-finalize sequencing edge case.
11. American-style settlement (already deferred per Stage decision).
12. X handle claim + social presence.
13. Fresh security audit covering the post-Run-7 codebase.
14. Mainnet deployment readiness (separate from Pyth's mainnet — refers to Solana mainnet).

---

## 11. Gotchas for a New Claude / Engineer

### Environment
- **All Solana scripts run from WSL**, not Windows. Keypair lives at `/home/nanko/.config/solana/id.json`.
- **Before `anchor deploy`, sync WSL `.so` files** — otherwise you'll overwrite devnet with stale binaries.
- **Devnet clock skew:** add 30–60s buffer when waiting for expiry in test scripts.
- **WSL `/tmp` doesn't persist between invocations.** Each `wsl bash -c` is a fresh session; `/tmp` files don't survive between turns. Chain in one session or use `/mnt/d/` paths.
- **Solana CLI default RPC** is set to devnet. If a future session runs against localhost it will silently fail.

### Build / runtime
- **Buffer polyfill must be imported first** in `main.tsx` via `app/src/polyfills.ts` — separate file, not `vite-plugin-node-polyfills` (broken on Vite 8).
- **800K CU compute-budget bump** needed for anything touching Token-2022 extensions + transfer hook. The crank bumps to 1.4M for atomic settle.
- **Token-2022 ATA creation must be idempotent** in the frontend.
- **`bigint: Failed to load bindings, pure JS will be used`** appears on crank startup. Harmless transitive-dep notice. Documented in `crank/README.md`.
- **JSX in `.ts` files works in Vite but breaks `tsx` (the runner) and any non-Vite TypeScript runner.** Vite's esbuild config tolerates JSX in `.ts` files; `tsc` is permissive via the `jsx` compiler option. But standalone `tsx` (used in `.test-fixtures/`) requires `.tsx` strictly. Rule: any file containing JSX should be `.tsx`. Discovered when the writer-PF arc's test fixture failed to load `solscan.ts` until it was renamed to `solscan.tsx`.
- **`tsc --noEmit` on Windows can return clean while Vercel's clean-room build fails on the same code** — incremental cache hides stale module shapes that a fresh build would catch. Final verification before any push to the live site should be `npm run build` (runs `tsc -b && vite build` — project-references mode forces the same clean rebuild Vercel does). Discovered when `1480b3c` passed local `tsc --noEmit` but Vercel rejected it with a stale-import error in `WrittenPositionsSection.tsx`; follow-up `15a3ac9` fixed the one-line drift.
- **`npm run build` from `app/` may fail in WSL with `Cannot find module '@rolldown/binding-linux-x64-gnu'`.** This is npm's optional-dependencies bug (https://github.com/npm/cli/issues/4828). Rolldown ships per-platform native bindings; if `npm install` was originally run from Windows PowerShell, only `@rolldown/binding-win32-x64-msvc` is present and the WSL build can't find its Linux equivalent. Two workarounds: (1) run `npm run build` from PowerShell instead of WSL — the Windows binding is present and the build completes (this is the cheap fallback); (2) from WSL, run `cd app && rm -rf node_modules package-lock.json && npm install` to reinstall and pick up the Linux binding (heavier but unblocks all WSL-side tooling). Either build is meaningful as a code-level verification of the TS/IDL changes; Vercel runs its own clean install on Linux when it deploys, so the bindings story doesn't affect production. Discovered during the May-4 audit-fix arc Step 5 frontend verification — used the PowerShell fallback.
- **`program.account.<Type>.all()` throws "offset out of range" if any v1-era orphan account exists with the same discriminator but a stale schema layout.** Anchor reads the variable-length-string nameLen at the IDL's expected offset, finds 4 random bytes interpreted as a 4-billion-byte length, and tries to seek past the end of the buffer. This is what blocked the first attempt at the Run-7 pre-redeploy market scan; current opta devnet has one such orphan at `J6eNd9A5pTACMXycdtDG7LV2TYsQtEhzXgnGNjyCk69Q` (predates the Stage 2 prune). Workaround: bypass Anchor for full-collection scans and use raw `getProgramAccounts` + manual byte parsing with a `nameLen > sane_max` skip-with-warning guard. See `scripts/scan-zero-feed-markets.ts` for the canonical pattern.

### Testing
- **Two test runners in play.** `anchor test` runs the Mocha+Chai suite via `ts-mocha`; `run-tests.sh` is a thin wrapper that runs the same suite with finer-grained control over which fixture files load. The early settlement-pricing arc lost ~30 minutes to "tests fail under `anchor test` but pass under `run-tests.sh`" — the difference is in environment fixture preloading. Default to `run-tests.sh` for iteration; reach for `anchor test` only for full clean-slate runs.
- **Tests named `zzz-audit-fixes.ts`** run last on purpose (mocha alpha ordering) because they depend on earlier fixtures. Reorder at your peril.

### Hermes / Pyth specifics
- **Mainnet Hermes is the default**, not Beta. Beta has guardian-set sync issues against Solana devnet's Wormhole Core Bridge.
- **Catalog cache key is host-derived** — switching `HERMES_BASE` automatically gets a fresh cache.
- **Markets created against Beta feed_ids must be migrated to mainnet** via the admin `migrate_pyth_feed` instruction before the crank can settle them.
- **`pythPullPost.ts` accepts a `hermesBase` parameter** in all Hermes-touching helpers, defaulting to mainnet.
- **`pyth-solana-receiver-sdk` does NOT expose `get_ema_price_no_older_than`** despite what cursory SDK doc-skimming suggests. The settlement-pricing arc lost time looking for this method; it doesn't exist. **Read the SDK's source manually** to find the actual EMA-fetching call (it's lower-level and requires manual account decoding). Don't trust autocomplete or method-name pattern-matching.
- **Hermes historical endpoint is `/v1`, not `/v2`.** The current Hermes API for non-historical (latest) updates uses `/v2/updates/price/latest`, but the historical endpoint we use for backfills is `/v1/updates/price/{publish_time}`. Mismatched paths return 404s that look like network errors. Both are documented at `docs.pyth.network` but the version split is easy to miss.

### Anchor IDL
- **`anchor deploy` always re-uploads the IDL** even when the bytes are byte-identical to the on-chain copy. Not a bug, just verbose; the deploy log will show "IDL upgraded" on every invocation regardless.
- **`anchor idl fetch` re-orders JSON keys** vs the `anchor build`-time emit. To compare a deployed IDL against the local one, use `python3 -m json.tool --sort-keys` on both before diffing (jq with `-S` works equally well; `jq` is not installed in the project's WSL by default — use the Python form). Otherwise you'll see spurious diffs that are pure key-order noise.

### Code org
- **PDA seeds are string constants** repeated in both Rust and TS — if you rename one, rename both. `app/src/utils/constants.ts` mirrors the Rust seeds.
- **`USE_V2_VAULTS` feature flag** still gates the UI to V2-only. V1 archived but referenced via this flag.
- **IDL regeneration** — every time an instruction signature changes in Rust, the IDL JSON in `app/src/idl/opta.json` must be refreshed.
- **Cross-package imports from `crank/` to `app/src/`** use the `@app/*` tsconfig path alias. The tsconfig's `moduleTypes` override forces `app/src/**/*.ts` to be loaded as CJS even though `app/package.json` says `type: module`. Don't break this without testing both runtimes.

### Repo hygiene
- `.context/` is gitignored — contains audit outputs and PoCs, never commit.
- `*-keypair.json`, `id.json`, `.env*` are gitignored — never commit secrets.
- `.test-fixtures/` is gitignored and contains one-shot bootstrap helpers and audit-validation scripts (e.g., the writer-PF arc's `writer-pf-arc.test.ts` with 14 assertions). These are reference-only artifacts; future sessions should regenerate them as needed rather than relying on what's in a given working tree.
- Several arc audit / plan markdowns are kept local-only by policy: `WRITER_PF_AUDIT.md`, `WRITER_PF_PLAN.md`, `COLLATERAL_2X_AUDIT.md`, `COLLATERAL_2X_PREMIUM_FOLLOWUP.md`, `SETTLEMENT_PRICING_AUDIT.md`. They're investigation/design docs; the durable record is the commit messages and `MIGRATION_LOG.md`.
- `MIGRATION_LOG.md` is committed and carries the chronological story across the P1–P5 + crank + P6 + auto-finalize + V2 secondary + May-3 polish arcs.
- Always use explicit `git push origin master:main` refspec when mirroring master to main; bypasses any stale local main reference.

---

## TL;DR

- **Opta** is a permissionless options primitive on Solana with Token-2022 "living" option tokens. Permissionless any-asset markets via Pyth. On-chain Black-Scholes. V2 shared-vault liquidity. Built for Colosseum Frontier (April 2026).
- **Live on devnet** with frontend on Vercel (`opta-solana.vercel.app`). Pyth Pull oracle migration shipped April 30. V2 secondary listing merged into the unified Trade `BuyModal` May 2–3. May-3 polish run shipped settlement EMA-at-expiry pricing, symmetric 1× strike collateral, writer-side portfolio dashboard. **May 4 closed 7 of 9 PART 1 Run-6 findings (CRIT-1/2/3, HIGH-1/2/3/4 + zero-feed subset of HIGH-5) plus 4 PART 2 Run-7 findings (HIGH-1/2/3, MED-1)** — 7 commits across the day, 3 redeploys (morning audit-fix `459869998`; CRIT-1 `460039090`; Run-7 bundle `460088947`).
- **The protocol is feature-complete on devnet.** Auto-finalize means "wake up with USDC, no clicks" is real. Secondary marketplace works. Writer ledger has its own UI. Remaining work is correctness, test-infra refresh, and polish — not new feature surface.
- **Programs ID:** `CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq` (opta), `83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG` (transfer hook).
- **Branches:** master + main mirrored at every commit; for current live-site head run `git log -1 origin/main --oneline`. Devnet slots after the Run-7 audit-fix arc: opta **`460088947`**, opta_transfer_hook **`460089133`**.
- **Biggest gotcha:** the protocol-on-devnet runs against Pyth-on-mainnet feeds. Don't confuse "we're on mainnet" with "Solana mainnet" — protocol is still devnet; only the price oracle endpoint is production.
