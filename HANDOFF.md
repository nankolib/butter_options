# Opta — Engineer Handoff

> Updated 2026-05-17 after **Phase 2 Stage B shipped to devnet** (Stage A follow-on FE fix `12e3d8d` + Stage B commit — see `git log master` — on master + main; opta deploy slot `463002816`, hook re-uploaded by Anchor at same source). Stage B is the realized-volatility oracle: per-asset on-chain ring buffer of 720 hourly samples, O(1) accumulator, sample-variance annualized vol with warmup + staleness gates, two new permissionless instructions (`initialize_vol_oracle` + `push_vol_sample`), a pure read function (`realized_vol_annualized`) at 3,802 CU that Stage C will CPI into, and a new hourly side-loop in `crank/bot.ts` that auto-discovers assets + initializes oracles + pushes samples. **11 oracles initialized on devnet at Step 8 smoke; 4 already seeded, 7 will be seeded by the first organic crank tick** (Hermes returned stale-window updates for 7 in the smoke — locked-decision behavior; next tick retries since seed branch skips rate-limit). Same arc landed Stage A's deferred `carry_rate_bps` frontend fix in `useWriteSubmit.ts` (commit `12e3d8d`), which clears the Vercel red the prior Stage A note flagged. **Stage B is still not wired into any production handler** — `realized_vol_annualized` exists but no instruction calls it yet; Stage C is when American vault creation invokes it. The 7-day warmup (168 hourly samples) starts now per asset. **Stage C's code can ship anytime** (write + audit + deploy gates run independently), but `realized_vol_annualized` returns `Warmup` until the per-asset sample count crosses 168 — so the 4 already-seeded assets reach live-readable state **2026-05-24**, the other 7 reach it ~1 hour later (whenever the next organic crank tick first seeds them).

> Note on Stage A framing correction (kept from prior version): the older HANDOFF text "On-chain Black-Scholes via solmath — pricing happens on-chain at ~50K CU" overstated reality. The math LIBRARY is on-chain (linked into the program binary) but no production instruction CURRENTLY calls it — premium pricing today is computed in the writer's browser via `app/src/utils/blackScholes.ts` (TypeScript) and submitted as an instruction argument. Phase 2 fixes this for American options first; European migration follows as a separate later arc. See §1 thesis and §11.5 Phase 2 plan for the honest framing.

> NOTE ON THE RENAME: Project renamed Butter Options → Opta on 2026-04-21. Phase 2 of the rename is complete on disk. Directory layout is `programs/opta/` and `programs/opta-transfer-hook/`. `Anchor.toml` keys are `opta` and `opta_transfer_hook`. PDA seed constants, `declare_id!()` macros, and IDL have been regenerated. The old `butter_options` / `butter-options` identifiers are gone from the codebase.

---

## How to use this document

This document is the **seed context** for Opta. If you're a fresh Claude session starting work on this project:

1. **Read this doc end-to-end before answering.** Skimming misses the gotchas and norms.
2. **Verify before citing.** Line numbers and file paths drift. Before acting on a reference in this doc, confirm it still matches the current tree.
3. **The user is real-time. The doc is a snapshot.** If the user's live intent conflicts with this doc, follow the user.
4. **The Phase 2 scope doc at `.context/plans/phase2-american-onchain-pricing-scope.md` is canonical** for the American options + on-chain pricing arc. If anything in this HANDOFF contradicts that scope doc on Phase 2 specifics, the scope doc wins.

---

## Working with the user

- **Non-developer by background.** The user is learning the stack through these sessions — treat them as a smart generalist who's newer to Solana/TypeScript specifics than to high-level software thinking. Explain in plain English with analogies, but don't over-baby; match their demonstrated level in a given conversation.
- **Solo project, Claude-paired.** This project has no other engineers. Every change — code, tests, docs — has flowed through a Claude session. Assume the code you're reading came from a previous Claude instance, not from the user typing.
- **Two-Claude workflow.** This chat session functions as project manager and design reviewer; **Claude Code** (running in WSL on the user's Windows machine) does the actual code execution. The chat reviews proposals, locks decisions, then hands prompts to Claude Code. Claude Code uses propose-then-apply on every change.
- **Windows + WSL.** User is on Windows 10 with WSL2 for Solana tooling. Bash commands run in Windows git-bash by default; anything Solana-related (`anchor`, `solana`, `cargo`) MUST run via `wsl -- bash -lc "..."`. Keypair at `/home/nanko/.config/solana/id.json`.
- **Terminal preference: PowerShell.** When asking the user to run shell commands themselves, prefer simple PowerShell one-liners. No piping gymnastics.
- **"Contracts" not "tokens" in UI copy.** Option tokens are called "contracts" throughout the frontend. Match that convention in any user-facing string.
- **Direct action over circling.** When there's a clear best path, take it and say so. Don't manufacture multi-option proposals just for ceremony — but do propose alternatives when there's genuine ambiguity.
- **Approve-then-apply for risky work.** For deletions, force-pushes, large rewrites, or anything irreversible, propose the plan first and wait for approval.
- **Verify-before-assert when claims touch code.** During Stage A planning, Claude Code uncovered that the long-standing "on-chain Black-Scholes" framing didn't match production code — `solmath::bs_full_hp` was only called from a test. The lesson: inherited framing should be re-verified against the codebase, not taken on faith across sessions.

---

## 1. Project Identity & Thesis

**Opta** is a permissionless options primitive on Solana. Anyone can write (sell) or buy call/put options on **any asset Pyth has a feed for** — crypto, commodities, equities, FX, ETFs. Each option is a Token-2022 mint with three extensions that make the token enforce its own lifecycle on-chain.

### The thesis

DeFi has a derivatives gap. Options are a much bigger TAM than spot in TradFi but barely exist on-chain. Solana specifically is essentially absent from on-chain derivatives — Hyperliquid is winning the EVM-side momentum, especially with institutional flow moving into commodities futures, and Solana doesn't have an equivalent options primitive competing for that flow. Opta is positioning to be that answer.

The differentiation comes from three intertwined design choices:

**Asset surface.** Most on-chain options projects support BTC, ETH, SOL, maybe a handful of large caps. Opta supports anything Pyth has a feed for. The pitch is not "options on SOL" — it's "options on whatever asset has a price feed." Every new feed Pyth adds becomes a potential Opta market.

**Token mechanic — the "living token."** Each option is a Token-2022 mint with three extensions doing real work: TransferHook enforces expiry, PermanentDelegate gives the protocol authority to act on the holder's tokens without their signature, MetadataPointer makes the term sheet on-chain so other programs and AI agents can read it. At expiry, **no user has to claim, exercise, withdraw, or click anything**. The protocol burns the token, distributes the cash, closes the position. Users wake up the next day with USDC in their wallet — payout if ITM, refunded collateral + earned premium if OTM (writer side). Including for tokens held in *secondary-market* wallets — whoever holds the token at expiry gets paid, automatically.

**Liquidity model.** TradFi-style options books fragment liquidity per strike, per expiry, per side. Opta's shared-vault V2 model has writers deposit into pooled vaults that mint multiple strikes/expiries against one collateral pool.

### On-chain pricing — honest framing

The earlier handoff text claimed "on-chain Black-Scholes via solmath at ~50K CU" as a settled architectural fact. **That overstated reality and was corrected during Phase 2 Stage A planning.** What's actually true:

- The `solmath` Black-Scholes implementation IS compiled into the on-chain program binary (`solmath::bs_full_hp`, `black_scholes_price`).
- However, **no production instruction currently invokes it.** Production pricing today happens in the writer's browser via `app/src/utils/blackScholes.ts` (TypeScript) and is submitted to the chain as a `premium_per_contract: u64` argument on `create_shared_vault`. The on-chain handler stores the number verbatim.
- The archived `update_pricing` instruction was the prior on-chain BS call site; it was deprecated in the V1→V2 migration and not replaced.

**Phase 2 is fixing this for American options first.** Stage A (shipped May 14, 2026) landed the BS-2002 American math kernel as a pure module. Stage B is the on-chain realized vol oracle. Stage C wires both into `create_shared_vault` for American vaults and adds a CPI-callable `get_option_price` instruction. European migration to on-chain pricing follows in a separate later arc once the American path is proven.

For pitch / investor framing: the durable claim is *"Opta's math kernel is on-chain; the American pricing path is being built fresh for end-to-end on-chain pricing including a permissionless realized vol oracle; European migration follows."* That's accurate and stronger than the prior overclaim.

**European-style settlement** is live on devnet. American comes via the Phase 2 arc described above.

### Stage

**Devnet demo / Phase 2 in flight.** Built for **Colosseum Frontier Hackathon — April 2026**; submission window closed before May. Hackathons submitted (Local + Frontier) as of May 11, 2026. Protocol is deployed on Solana devnet, frontend is live on Vercel at `opta-solana.vercel.app`. The live deployment uses Pyth's mainnet price feeds via `hermes.pyth.network` (Solana devnet's Wormhole Core Bridge only verifies Pyth's production guardian set). The protocol code itself is still running on Solana devnet — only the price oracle endpoint is mainnet. Phase 2 American + on-chain pricing is the active build.

---

## 2. Repository State

- **GitHub remote:** `https://github.com/nankolib/opta.git`
- **Current branch:** `master` (also mirrored to `main` via explicit `git push origin master:main` refspec)
- **Working tree:** clean (modulo local-only audit/plan markdowns kept by policy: `WRITER_PF_AUDIT.md`, `WRITER_PF_PLAN.md`, `COLLATERAL_2X_AUDIT.md`, `COLLATERAL_2X_PREMIUM_FOLLOWUP.md`, `SETTLEMENT_PRICING_AUDIT.md`, `WHITEPAPER_REWRITE_PLAN.md`)
- **Latest commits as of 2026-05-14 (Stage A shipped):**
  - `7e98a46` feat(vault): plumb carry_rate_bps on SharedVault for American pricing
  - `91b1738` chore(gitignore): exclude Python __pycache__/
  - `3d33abc` feat(math): add Bjerksund-Stensland 2002 American option pricing module
  - `04f2676` feat(security): HIGH-5 — permissionless create_market via Pyth proof-of-existence
  - `2bf1979` docs(handoff): refresh for May-5 audit-polish session
  - `f9f368c` refactor(frontend): MED-4 + MED-5 + MED-6 batch
  - `81504aa` refactor(frontend): delete dead V1 paths (PART 2 LOW-2)
  - `c345a23` chore(security): whitelist vercel.live for preview feedback widget
  - `5cb62e8` chore(security): vercel.json CSP + security headers (PART 2 LOW-1)
  - `06a4be8` feat(frontend): ErrorBoundary at app root
  - `c6866f8` refactor(frontend): MED-8 — typed wallet-replay sentinel
  - `3748ccb` fix(frontend): MED-2 + MED-3 + MED-7 — cluster guard + faucet defense + cache janitor
  - `107c5b7` docs(disclosure): CRIT-4 — CALL payout cap in whitepaper §9.6 and BuyModal
  - `79619ff` fix(frontend): NewMarketModal admin-gate + decoder unmapped-code warning
  - `336be61` fix(frontend): HIGH-4 — stale-price indicator on Hermes outage fallback
  - …earlier history (Run-6/Run-7 audit-fix arc, V2 secondary, trade-merge, auto-finalize, P1–P6 migration) accessible via `git log`

Author throughout: **nankolib** (single-developer, Claude-paired).

### What Stage A landed (May 13-14 2026, commits `3d33abc` → `7e98a46`)

The foundational arc for on-chain American option pricing. **Pure additive — no production handler calls the new code yet.** Stage A is verifying the math + plumbing the schema; Stages B-I wire it into production.

**COMMIT 1 — `3d33abc`** — BS-2002 math kernel:
- New module `programs/opta/src/utils/american_pricing/` with `mod.rs` (~370 LOC), `test_vectors.rs` (auto-generated 150-row reference array, 300 expected values), `tests.rs` (14 tests covering reference + edge cases + parity bounds).
- Bjerksund-Stensland 2002 closed-form American pricing, 5-phi flat-boundary formula. McDonald-Schroder transformation for puts (single math kernel reused for both call and put).
- Composes existing `solmath` primitives only (`norm_cdf_poly`, `exp_fixed_i`, `ln_fixed_i`, `pow_fixed`, `fp_sqrt`, etc.) — no new solmath dependencies, no upstream PR.
- **Algebraic reformulation** to avoid fixed-point precision underflow: instead of computing `α = (B*-K)/B*^β` (which underflows to 0 at SCALE=1e12 when β~11), compute `α·S^β = (B*-K)·(S/B*)^β` directly. Same math, no underflow.
- New Python reference generator at `scripts/gen_bs2002_refs.py` implementing BS-2002 from scratch as the primary reference. QuantLib 1.32's `BjerksundStenslandApproximationEngine` (which actually ships BS-1993, not BS-2002, despite the class name) is kept as a secondary sanity oracle. Cross-validation between the two: max divergence 0.582%, mean 0.003%, only 1 row exceeds 0.3%.
- Edge case ladder: near-expiry (<1h) → intrinsic; sigma <1bp → discounted intrinsic; deep-OTM → 0; deep-ITM B* overflow → European fallback; q<0 → InvalidCarry error (Stage A only supports q≥0).
- `PARITY_SLACK = $0.25` in tests covers the known BS-2002 flat-boundary approximation artifact in deep-ITM short-tenor low-vol regime (algorithm limit, not a code bug).
- **CU profile (empirically measured via `cu-profile` feature-gated instruction):** ~30K CU for q=0 fast path (returns European exactly), ~231K CU for q>0 main path (full BS-2002), ~261K CU for PUT via McDonald-Schroder (extra recursion). User explicitly chose to keep BS-2002 over BS-1993 (60-80K cheaper) for accuracy reasons; the CU envelope is accepted.
- `cu-profile` Cargo feature gates the profiling instruction so it compiles out of production builds. Reusable scaffolding for Stage B and Stage F profiling.

**chore commit `91b1738`** — added `__pycache__/` to `.gitignore`.

**COMMIT 2 — `7e98a46`** — `carry_rate_bps` plumbing + migration infrastructure:
- New field `SharedVault.carry_rate_bps: i32` (basis points, signed for future negative-carry assets). Appended at END of struct for Borsh-safe schema migration of legacy on-chain vaults.
- `create_shared_vault` accepts `carry_rate_bps` as the 6th arg; 15 in-scope TS test caller sites updated mechanically with `, 0` (crypto = no carry).
- **New production instruction `migrate_shared_vault_carry_rate`** — admin-only, batched via `remaining_accounts`, mirrors the `migrate_pyth_feed` pattern. Idempotent: vaults already at new size are skipped. Admin pays the rent delta (~30-100 lamports per vault).
- **Architectural decision documented in the instruction header:** Anchor's `realloc` constraint runs AFTER typed `Account<T>` deserialization, so lazy migration via realloc on `claim_premium` is impossible (deser fails on too-short data before realloc can grow). Explicit migration instruction is the correct path.
- New cu-profile-gated test scaffolding: `shrink_shared_vault_for_test.rs` + `create_test_shared_vault.rs`. Used by `tests/realloc-shared-vault.ts` to verify migration works on shrunk-to-legacy-size vaults.
- 3 realloc test cases passing on local validator: A (new-vault no-op), B (second-touch idempotency), C (legacy first-touch grow + zero-fill, verifies `carry_rate_bps == 0` after deser).
- New migration runner script `scripts/migrate-shared-vaults-carry-rate.ts` (~80 LOC) — enumerates legacy vaults via raw `getProgramAccounts` (Anchor's typed `.all()` would fail on shrunk legacy data — same gotcha noted in §11), batches 20 per tx, admin runs once at Stage C deployment time. **Not yet run against devnet** — script bundled in COMMIT 2 ready for Stage C.
- `claim_premium.rs` UNCHANGED. The revised migration design keeps `claim_premium` clean.
- IDL refreshed; cu-profile-only test instructions correctly excluded from production IDL via `#[cfg(feature = "cu-profile")]` gating.
- 28/28 Rust unit tests pass (math + solmath_bridge + epoch + lib). 3/3 TS realloc tests pass on local validator.

### What Stage B landed (2026-05-17, FE follow-on `12e3d8d` + Stage B see `git log master`)

The on-chain realized-volatility oracle for Phase 2's pricing path. **Pure additive — no production handler invokes the new read function yet.** Stage B builds the data + math; Stage C wires it into `create_shared_vault` for American vaults.

**Devnet redeploy at slot `463002816`** (was `460518532` from HIGH-5 on May 5). Hook re-uploaded by Anchor at same source (size delta = 0).

**COMMIT 1 — `12e3d8d`** — Stage A follow-on, frontend `createSharedVault` 6th-arg fix:

- `app/src/pages/write/useWriteSubmit.ts:210` now passes `carry_rate_bps = 0` (correct default for current crypto-only assets per `SharedVault::carry_rate_bps` doc).
- Surfaced by Stage B Step 8 Gate 6 (frontend `npm run build`); latent since Stage A landed (May 14) because frontend was correct against deployed pre-Stage-A program until the Stage B deploy bundled Stage A's pending IDL change.
- 1-line code change. Clears the Vercel red the prior Stage A note flagged.

**COMMIT 2 — Stage B (see `git log master`)** — Phase 2 Stage B:

- **New zero_copy state account `VolOracle`** at `programs/opta/src/state/vol_oracle.rs`. 5856 bytes data + 8 disc = 5864 bytes; layout pinned by compile-time `const _: () = assert!(size_of::<VolOracle>() == 5856)`. i128s at front (16-alignment from offset 0 for bytemuck::Pod). Ring buffer 720 i64 samples + O(1) accumulators + last_spot_price + last_sample_ts.
- **Two new permissionless instructions** (both proof-of-feed-existence gated via Pyth Pull):
  - `initialize_vol_oracle(feed_id)` — bootstraps oracle PDA `[VOL_ORACLE_SEED, feed_id]`
  - `push_vol_sample()` — validates Pyth update, computes log return from prior spot, updates ring + accumulators. Seed-or-normal branch on `last_spot_price == 0`. Rate-limited 55min in production (1s under `test-fast-vol`). CU: 9,867 (full path).
- **New pure read function** `realized_vol_annualized(&VolOracle, now_ts) -> Result<i64>` — sample variance (ddof=1) annualized by `sqrt(8760)`. Three gates: warmup (sample_count < 168), stale (now - last_sample_ts > 6h), math. CU: 3,802 (well under the 8K target). Will be called by Stage C; not yet wired.
- **New cargo feature `test-fast-vol`** — shrinks rate-limit constant from 55min → 1sec for multi-push tests. Mirrored on opta-transfer-hook as no-op. **NEVER deployed** — verified by Gate 2 IDL grep (`grep -cE '"name": *"(cu_profile_|shrink_shared_vault_for_test|create_test_shared_vault)' target/idl/opta.json` returns 0) + the deployed binary uses 3300s.
- **CU profile instruments** (gated by `cu-profile`, never deployed): `cu_profile_push_vol_sample`, `cu_profile_realized_vol`.
- **7 new `OptaError` variants**: `VolOracleNotInitialized`, `VolOracleWarmup`, `VolOracleStale`, `VolOraclePushTooSoon`, `VolOraclePriceStale`, `VolOracleInvalidSpot`, `VolOracleMathError`.
- **New `bytemuck = { version = "1", features = ["min_const_generics"] }`** dependency — required by Anchor 0.32.1's `#[account(zero_copy)]` macro for the 720-element samples array.
- **Python reference generator** at `scripts/gen_vol_test_vectors.py` (stdlib-only; no numpy/pip needed). 3 vectors with known sigmas; cross-validates the on-chain integer math within 0.1% relative.
- **14 Rust unit tests** in `state::vol_oracle::tests` (5 accumulator algebra + 4 gate boundaries + 3 Python-reference correctness + layout assertion + sqrt-constant pin). Runs via `cargo test`, no validator.
- **11 TS integration tests** in `tests/zzz-vol-oracle.ts` (4 init + 7 push semantics + 1 CU measurement). All passing. 1 long ring-wrap test permanently `.skip` with cross-reference to the equivalent Rust unit test (validator clock-granularity flake).
- **Vol oracle crank side-loop** at `crank/volOracleCrank.ts`. Spawned by `crank/bot.ts::main()` via fail-loud `Promise.all`; shares bot's `shutdownRequested` flag for clean shutdown. Hourly cadence aligned to wall-clock boundary (not `setTimeout`-from-now — restart-safe). Auto-discovers assets via `safeFetchAll<"optionsMarket">`. `TICK_ONCE=1` env-gated single-tick smoke mode for ops debugging. 7 unit tests in `crank/volOracleCrank.test.ts`.
- **2 new pythPullPost helpers**: `buildPostUpdateAndInitializeVolOracleTx` + `buildPostUpdateAndPushVolSampleTx`. Same atomic post+consume+close pattern as the existing settle/createMarket helpers.
- **Devnet smoke verified end-to-end** at Step 8 Gate 7.5: 11 markets discovered, 11 oracles initialized, 4 seeded (`ec5d3998`, `ef0d8b6f`, `ff61491a`, `e62df6c8`), 7 awaiting first organic crank tick (Hermes stale-window failures during smoke — locked-decision behavior).
- **Step 5 (CU profile) folded into Steps 3+4.** **Step 6 (validator integration tests at warmup boundary) deliberately skipped** — Rust unit tests cover warmup at the boundary already; Stage C exercises the live seam in production.

**Test counts:** pre-Stage-B 28 Rust unit; post-Stage-B 42 Rust unit (+14) + 11 TS vol-oracle + 7 crank unit (= +32 net new tests).

**What Stage B did NOT do (deferred to Stage C):** wire `realized_vol_annualized` into `create_shared_vault`'s American branch; add `get_option_price` read-only instruction for CPI consumers; frontend vol display (Stage H).

### Earlier audit/feature history (compressed — see git log for detail)

- **Run-6 + Run-7 audit-fix arcs (May 4-5 2026):** Closed 19 of 61 audit findings. All 4 CRITs + all 5 PART 1 HIGHs + all 4 PART 2 HIGHs closed. Remaining open: PART 1 7 MEDs/10 LOWs/8 INFOs (+ CRIT-4 disclosure-only); PART 2 4 MEDs/9 LOWs/6 INFOs. Devnet slots from this arc: opta `460518532`, hook `460518751`. UNCHANGED in Stage A (Stage A is pure code addition, no devnet redeploy).
- **HIGH-5 permissionless market creation (`04f2676`, May 5 evening):** Admin gate removed from `create_market`; non-admin can create markets via Pyth proof-of-existence. `migrate_pyth_feed` stays admin-only.
- **V2 secondary listing + Trade × Marketplace merge (May 1-3 2026):** Secondary listing flow merged into unified `BuyModal` on `/trade`; standalone `/marketplace` retired. Net −1044 LOC across 7 slices.
- **Settlement EMA-at-expiry (`4dc6250`, May 3 2026):** Fixed late-crank drift bug. Settlement reads Pyth EMA price at expiry-time with a 60-second window; `publish_time` written to `SettlementRecord` as audit trail.
- **Symmetric 1× collateral (`a8b5f14`, May 3 2026):** CALL and PUT writers now lock equal-strike-magnitude collateral. Model B premium framing (premium paid at trade time, accrues to writer's claimable proportional to vault sales).
- **Writer-side Portfolio dashboard (`1480b3c` + `15a3ac9`, May 3 2026):** § 02 Vaults Written section, claim/withdraw flows wired, Solscan retrofit on both ledgers.
- **CRIT-1 holders-first lockup (`280c1c6`, May 4 2026):** 24-hour `EXERCISE_WINDOW` post-settlement before writers can withdraw collateral. Frontend mirrors via `settled-locked` row state.

---

## 3. Tech Stack

### Languages
- **Rust** — Solana on-chain programs (Anchor framework)
- **TypeScript** — frontend app, tests, scripts, crank bot, SDK
- **Python** — BS-2002 reference value generator (`scripts/gen_bs2002_refs.py`, Python 3.8+, pinned to QuantLib 1.32). NOT a runtime dependency, only used at test-vector generation time.

### On-chain / Anchor
- Anchor `0.32.1`, Rust toolchain pinned via `rust-toolchain.toml`
- SPL **Token-2022** v8.0.1 (`@solana/spl-token ^0.4.14`)
- Cargo workspace at repo root; `programs/*` are the workspace members
- Release profile uses `overflow-checks = true`, `lto = "fat"`
- **`cu-profile` Cargo feature** (new in Stage A): gates the test-only profiling and realloc-test scaffolding instructions. Compiles out in default builds. **Never deploy a cu-profile build to devnet/mainnet** — its IDL contains extra test instructions.

### Frontend (`app/`)
- Vite 8 + React 19 + TypeScript 5.9
- Tailwind 4 (via `@tailwindcss/vite`)
- Solana wallet adapter (`@solana/wallet-adapter-*`) + `@solana/web3.js ^1.98`
- `@coral-xyz/anchor ^0.32.1`
- `@pythnetwork/pyth-solana-receiver ^0.14.0`
- Manual Buffer polyfill in `app/src/polyfills.ts`
- Cluster-aware Solscan helpers in `app/src/utils/solscan.tsx` and cluster inference in `app/src/utils/env.ts`

### Crank (`crank/`)
- Node.js with `ts-node` runtime; one-file bot at `crank/bot.ts`
- Cross-imports helpers from `app/src/` via the `@app/*` tsconfig path alias
- Same Solana stack pins as `app/`

### Tests
- Mocha + Chai + `ts-mocha` at repo root, invoked by `anchor test` (or by `run-tests.sh` for finer-grained control)

### External services
- **Pyth Network** — on-chain oracle for pricing + settlement via the Pull oracle (PriceUpdateV2)
- **Hermes mainnet** (`https://hermes.pyth.network`) — off-chain price update fetching
- **Helius devnet RPC** — operator must set `VITE_RPC_URL` in `app/.env.local` and `OPTA_RPC_URL` for the crank
- **Vercel** — frontend hosting at `opta-solana.vercel.app`. Auto-deploys on push to `main`. **Expected to go red on next deploy attempt** due to Stage A IDL drift (frontend doesn't pass the new `carry_rate_bps` arg yet — Stage H fixes this). Prior good deploy continues serving production.
- **solmath** — on-chain math library; `american_pricing` module composes its primitives but adds no upstream dependency

---

## 4. Architecture

### Programs (2)

| Program | Program ID | Purpose |
|---|---|---|
| `opta` | `CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq` | Main protocol |
| `opta_transfer_hook` | `83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG` | Token-2022 transfer hook — blocks transfers after expiry |

### Instruction inventory (22 production instructions on the main program, post-Stage A)

**Admin (2):** `initialize_protocol`, `initialize_epoch_config`

**Market lifecycle (2):** `create_market` (permissionless post-HIGH-5), `migrate_pyth_feed` (admin)

**Vault writer flow (5):** `create_shared_vault` (now takes `carry_rate_bps` as 6th arg post-Stage A), `deposit_to_vault`, `mint_from_vault`, `withdraw_from_vault`, `claim_premium`

**Vault buyer flow (1):** `purchase_from_vault`

**Settlement (4):** `settle_expiry`, `settle_vault`, `auto_finalize_holders`, `auto_finalize_writers`

**Manual cleanup (3):** `exercise_from_vault`, `withdraw_post_settlement`, `burn_unsold_from_vault`

**V2 secondary listing (3):** `list_v2_for_resale`, `buy_v2_resale`, `cancel_v2_resale`

**Auto-cleanup (1):** `auto_cancel_listings`

**Schema migration (1, NEW in Stage A):** `migrate_shared_vault_carry_rate` — admin-only, batched via `remaining_accounts`. Run once at Stage C deployment time to migrate legacy SharedVaults to the new schema.

Plus **3 cu-profile-gated test-only instructions** (NOT in production IDL): `cu_profile_american`, `shrink_shared_vault_for_test`, `create_test_shared_vault`.

### State accounts — `programs/opta/src/state/`

`protocol.rs`, `market.rs`, `writer_position.rs`, `epoch_config.rs`, `shared_vault.rs` (now includes `carry_rate_bps: i32` at end of struct), `vault_mint.rs`, `settlement_record.rs`, `vault_resale_listing.rs`

### Token-2022 extensions on every option mint
- **TransferHook** — blocks user-to-user transfers after expiry
- **PermanentDelegate** — protocol_state PDA; used by `auto_finalize_holders` for permissionless multi-holder burns at expiry
- **MetadataPointer + TokenMetadata** — on-chain term sheet (asset, strike, expiry, type)

### Frontend — `app/src/`
- Pages: `Landing`, `Markets`, `Trade`, `Write`, `Portfolio` (two-ledger: buyer + writer), `DocsPage`
- Hooks: `useProgram`, `useAccounts`, `useFetchAccounts`, `useVaults`, `useTokenMetadata`, `usePythPrices`, `useIsAdmin`
- Utils: `blackScholes.ts` (TS European BS — production pricing today still routes through here), `constants.ts`, `errorDecoder.ts` (IDL-driven), `format.ts`, `tokenMetadata.ts`, `vaultFilters.ts`, `pythPullPost.ts`, `hermesCatalog.ts`, `env.ts`, `solscan.tsx`
- Feature flag: `USE_V2_VAULTS = true`

---

## 5. Deployments

| What | Where |
|---|---|
| Both programs | **Solana devnet**, program IDs above. **Slot updated by Stage B redeploy on 2026-05-17:** opta `463002816` (was `460518532` from HIGH-5 on May 5), opta_transfer_hook re-uploaded by Anchor at same source (size delta = 0). Stage A's pending source/IDL changes shipped to chain alongside Stage B's. Next redeploy is Stage C when American pricing wires `realized_vol_annualized` into `create_shared_vault`. |
| Frontend | **Vercel** — `https://opta-solana.vercel.app`. Auto-deploys on push to `main`. **Vercel red cleared by Stage A FE follow-on in commit `12e3d8d`** — `useWriteSubmit.ts` now passes the 6-arg `createSharedVault`. |
| Crank bot | Run manually via `npm start` from `crank/`. Reads `OPTA_RPC_URL` and `OPTA_CRANK_KEYPAIR` from env. |
| Devnet USDC mint | `AytU5HUQRew9VdUdrzQuZvZ7s14pHLiYjAF5WqdK3oxL` |
| Devnet faucet wallet | Public keypair baked into `app/src/utils/constants.ts` for demo USDC; in-code warnings flag it |
| Domain | `opta.fyi` purchased but not yet attached to Vercel — parked |

---

## 6. Current State — What Works

- All **24 production instructions** deployed and live on devnet (Stage B added `initialize_vol_oracle` + `push_vol_sample`)
- **Stage A math kernel + plumbing shipped locally and to origin** (commits `3d33abc`, `91b1738`, `7e98a46`). NOT yet wired into any production handler — Stage C is when American vault creation actually invokes the new math.
- **Stage B vol oracle shipped + deployed** (FE fix `12e3d8d` + Stage B commit; opta slot `463002816`). 11 oracles initialized on devnet; 4 seeded at smoke; 7-day warmup running. `realized_vol_annualized` ready for Stage C wire-up but no production handler calls it yet.
- **Full frontend** live on Vercel at the pre-Stage-A IDL: Trade (Deribit-style chain with secondary listings unified into BuyModal), Write, Portfolio (two-ledger), Markets, Docs
- **Permissionless settlement via Pyth Pull oracle** with EMA-at-expiry pricing and on-chain `publish_time` audit trail
- **Symmetric 1× strike collateral** for both CALL and PUT; Model B premium framing throughout UI
- **Permissionless auto-finalize at expiry** — holder burns + ITM payouts + writer collateral returns + dust sweep to treasury
- **V2 secondary listing** unified in Trade BuyModal
- **Writer-side portfolio dashboard** with Claim Accrued Premium / Withdraw Collateral / Burn unsold actions
- **Production CSP + 4 security headers** live on Vercel
- **App-root ErrorBoundary** for cluster-mismatch and other render-phase errors
- **Stale-price indicator** at 4 frontend surfaces
- **CRIT-4 disclosed** via whitepaper §9.6 + BuyModal CALL-only disclaimer
- **24h holders-first lockup** post-settlement; frontend mirrors via `settled-locked` row state
- **HIGH-5 permissionless market creation** via Pyth proof-of-existence

---

## 7. Current State — In Progress / Known Gaps

### Phase 2 American + on-chain pricing — active build

The full Phase 2 plan is documented at **`.context/plans/phase2-american-onchain-pricing-scope.md`** (canonical). Summary:

- **Stage A — SHIPPED to origin May 14 2026.** BS-2002 math kernel + `carry_rate_bps` plumbing + admin migration instruction. See §2 for commits.
- **Stage B — SHIPPED to devnet 2026-05-17.** Per-asset realized-vol oracle (ring buffer + accumulators + annualized read function + crank side-loop). All 11 current devnet feeds initialized; 7-day warmup running. See §2 for commits + slot.
- **Stage C — On-chain pricing wired into American `create_shared_vault` + read-only `get_option_price` for CPI.** 1-2 weeks. American branch of `create_shared_vault` computes premium on-chain (drops `premium_per_contract` arg for American). European path UNCHANGED. **Code can ship anytime — independent of warmup. Per-asset `realized_vol_annualized` returns `Warmup` until that asset's sample count crosses 168; the 4 already-seeded assets unlock 2026-05-24, the other 7 unlock ~1 hour later (when first organic crank tick seeds them).**
- **Stage D — American vault instructions.** 1 week. Mostly branch-guarded reuse of European patterns.
- **Stage E — Token-2022 metadata `exercise_style` field.** 3 days.
- **Stage F — `exercise_american` instruction.** 1 week. New on-chain logic; holder burns tokens + claims intrinsic value pre-expiry.
- **Stage G — Settlement American branch.** 3 days. `settle_expiry` + `auto_finalize_holders` get `exercise_style` check.
- **Stage H — Frontend.** 1.5 weeks. EUR/AMER toggle, exercise UI, on-chain vol display. (Stage A's `carry_rate_bps` 6th-arg pass was bundled with Stage B's deploy in commit `12e3d8d` — that gap is closed.)
- **Stage I — Audit + deploy.** 1 week + audit turnaround. Estimated $12-18K.

**Total remaining: ~9-11 weeks solo + audit turnaround.** (Stage B took 1 session vs the 3-4 week scope estimate.)

### Audit follow-up backlog (parked, not blocking Phase 2)

- **PART 1 HIGH-5 full proof-validation** for `migrate_pyth_feed` (`PriceUpdateV2` account + feed_id match). The zero-feed subset shipped; full validation deferred.
- **PART 1 MEDs (7), LOWs (10), INFOs (8)** — none blocking. MED-1 (Token-2022 raw-byte balance reads lack length+type validation) is the most concrete.
- **PART 2 LOWs (7 remaining), INFOs (6)** — none blocking.
- **Bankrun / litesvm test-infra adoption** — unblocks 3 skipped after-window CRIT-1 tests + future time-gated logic.
- **Test suite refresh** — ~38 failing tests from fixture clock-skew (root cause: hardcoded `Date.now()` in `_pyth_fixtures.ts` drifted past expiry windows). NOT regression; pre-existing tech debt. Est 4-8 hours, Tier-2.

### Frontend gaps / small bugs (deferred to Stage H or later)

- **Vercel build will go red on next deploy** until Stage H wires the `carry_rate_bps` 6th arg in `app/src/pages/write/useWriteSubmit.ts`. Production traffic served by prior good deploy meanwhile.
- Markets page shows "No markets yet" when an asset is registered but has no vaults.
- Indicative Premium panel renders `$0.00` for short-dated OTM options (sub-cent rounding).
- Stale market list on `/markets` after creating a market via AppNav (modal owns own state; Markets page doesn't refetch).
- Broken BTC PUT vault on devnet (user-reported $750k BTC PUT $75,000 / 8 May vault stuck at `total_options_minted = 0`). Funds recoverable via `withdraw_from_vault` once root cause identified.

### Minor housekeeping

- `opta.fyi` Vercel attachment pending
- X handle unclaimed
- Orphaned write-buffer accounts on devnet from earlier deploy sessions (all 0 SOL, harmless)
- `scripts/seed-demo-fresh.ts` staleness (uses 4-arg `createSharedVault` against current 6-arg signature post-Stage-A). Pre-existing; not Stage A's problem.

---

## 8. Key Decisions & Design Choices

### Locked Phase 2 decisions (May 13 2026 — see scope doc for full reasoning)

1. **American gets on-chain pricing. European is untouched** in Phase 2. European migration is a separate future arc.
2. **30-day realized vol window** for the on-chain oracle. Matches Deribit DVOL and industry default.
3. **Crank-driven per-asset on-chain ring buffer** for vol data. Permissionless, autonomous.
4. **Hourly sampling, 720-sample buffer, 7-day warmup** before American vaults can be created on a new market.
5. **Pure on-chain realized vol + BS-2002 pricing. No writer override, no admin vol parameter.** One spec = one mint = one price.

### Stage A implementation decisions (May 13-14 2026)

- **BS-2002 (5 phi) over BS-1993 (3 phi).** Empirical CU measurement showed BS-2002 at 231K CALL / 261K PUT vs BS-1993's projected ~160K. User chose accuracy over CU savings; the CU envelope is accepted. Stage C `create_shared_vault` will need a ~400K compute budget bump for American (already standard practice in Opta — 800K and 1.4M bumps exist for Token-2022 + settle paths).
- **`α·S^β = (B*-K)·(S/B*)^β` reformulation** to avoid SCALE precision underflow at β~11 in low-σ McD-S PUT cases. Never materialize α as a tiny scaled value.
- **`PARITY_SLACK = $0.25`** to absorb the known BS-2002 flat-boundary approximation artifact in deep-ITM short-tenor low-vol regime. Algorithm limit, not a code bug.
- **Python BS-2002 self-implemented as primary reference oracle.** QuantLib 1.32's `BjerksundStenslandApproximationEngine` actually ships BS-1993 despite the class name; cross-val between Python BS-2002 and QL BS-1993 shows max 0.582% / mean 0.003% divergence.
- **`carry_rate_bps: i32`** on SharedVault (NOT on OptionsMarket) — per-vault snapshot, signed for future negative-carry. Appended at struct END for Borsh-safe migration.
- **Explicit migration instruction over lazy realloc.** Anchor's `realloc` constraint runs after typed deserialization, so legacy accounts fail deser before realloc can grow them. The `migrate_shared_vault_carry_rate` admin-only batched instruction is the architecturally correct path. Documented in instruction header.
- **`cu-profile` Cargo feature** for test-only profiling and shrink-for-test instructions. Reusable for Stage B and Stage F. Never deploy a cu-profile build.

### Inherited decisions (pre-Phase-2)

- **Token-2022 over classic SPL** — needed TransferHook + PermanentDelegate + MetadataPointer
- **Options represented as tradable tokens** — enables built-in secondary market
- **European-style settlement, USDC-only** for current production. American comes via Phase 2.
- **V2 shared-vault liquidity model is the only one exposed.** V1 P2P code archived in Stage 1.
- **Pyth Pull oracle (PriceUpdateV2) over deprecated Push oracle**
- **Mainnet Hermes feeds even though protocol runs on Solana devnet** — Solana devnet's Wormhole Core Bridge only verifies Pyth's production guardian set
- **Permissionless settlement + auto-finalize** — crank-driven, anyone can run
- **Settlement reads Pyth EMA at expiry-time, 60s window, on-chain publish_time audit trail**
- **Symmetric 1× strike collateral, Model B premium framing**
- **24h holders-first lockup post-settlement** (`EXERCISE_WINDOW = 86_400` at `state/shared_vault.rs`)
- **Admin-gated migration paths** (`migrate_pyth_feed`, `migrate_shared_vault_carry_rate`)
- **Hardcoded deployer pubkey** (`5YRMuuoY3P7z5GeRAAQND7BxgNdmPSa6CSPCJLca1zZk`) for `initialize_protocol` admin gate per CRIT-3. Lockstep update required if program ever redeployed at a different address.

---

## 9. External Dependencies & People

- **Contributors:** only `nankolib` (Nanko). Solo project. Partner ("Butter") handles security/audit oversight, not a developer.
- **External services:** Pyth Network (Hermes mainnet + Pyth Receiver on-chain; Wormhole Core Bridge for VAA verification), Helius (devnet RPC), Vercel (hosting), GitHub (source).
- **Deadlines:** hackathon submitted (Local + Frontier) as of May 11, 2026. No hard deadline pressure now. Phase 2 paces at ~11-13 weeks solo + audit; rough completion target is August 2026.

---

## 10. Immediate Next Steps

**Phase 2 Stage C planning is the next session.** Plan first, execute via Claude Code propose-then-apply. Stage B (vol oracle) shipped 2026-05-17; Stage C wires `realized_vol_annualized` into `create_shared_vault`'s American branch + adds the read-only `get_option_price` instruction for CPI consumers.

### Tier 1 — near-term

1. **Phase 2 Stage C planning** — on-chain pricing in `create_shared_vault` (American branch) + read-only `get_option_price` for CPI. Reference `.context/plans/phase2-american-onchain-pricing-scope.md` §4 Stage C for the scope outline; open questions to resolve in planning (per the scope doc):
   - `create_shared_vault` signature: drop `premium_per_contract` for American, keep for European?
   - `get_option_price` CU budget (composes BS-2002 ~85K + `realized_vol_annualized` ~4K + Pyth spot read; total ~100K expected, leaves margin for CPI caller's own work)
   - Stale-vol-oracle handling (block American vault creation? error variant?)
   - Buyer-side display: vault stores the computed premium at creation, no mid-life re-pricing
   - **Pre-flight check**: confirm at least 4 assets have crossed warmup (2026-05-24 unlock date for the assets seeded at Stage B Step 8 smoke; rest unlock as soon as their first organic seed lands)
2. **HANDOFF cleanup** — already done in this refresh; future sessions inherit the corrected framing automatically.
3. **Crank operator setup** — Stage B's vol-oracle side-loop is wired but not running as a persistent service. Operator decision: set up systemd / pm2 / Docker `restart: unless-stopped` against the user's hot wallet + Helius RPC. See `crank/README.md` for the production hot-wallet recommendation pattern.
4. **Demo video recording** if not already done — "wake up with USDC, no clicks" beat is the differentiated narrative.

### Tier 2 — quality polish (not blocking Phase 2)

1. **Test suite refresh** — fix 38 fixture clock-skew failures via runtime-relative timestamps + bankrun/litesvm adoption (4-8 hours, unblocks 3 skipped CRIT-1 after-window tests).
2. **PART 1 HIGH-5 full proof-validation arc** for `migrate_pyth_feed` (~250 LOC across 6 files).
3. **Frontend bug bash:** Markets-page-empty-when-asset-has-no-vaults, Indicative Premium `$0` display floor, AppNav modal stale-list refetch.
4. **`opta.fyi` Vercel attachment + DNS setup** when otherwise mainnet-ready.

### Tier 3 — post-launch / mainnet path

5. **European on-chain pricing migration** (separate arc after Stage I; per locked Phase 2 decision, European stays untouched during Phase 2).
6. **Writer-side resale UX framing** — dedicated "Listings I've made" view on Portfolio.
7. **`withdraw_from_vault` mid-life uncommitted-collateral redemption** in writer dashboard.
8. **`auto_burn_unsold_escrow`** (or crank reorder) to close `burn_unsold_from_vault` post-finalize sequencing edge case.
9. **`USE_V2_VAULTS` flag retirement.**
10. X handle claim + social presence.
11. Fresh security audit covering post-Phase-2 codebase.
12. Mainnet deployment readiness.

---

## 11. Gotchas for a New Claude / Engineer

### Environment
- **All Solana scripts run from WSL**, not Windows. Keypair at `/home/nanko/.config/solana/id.json`.
- **Before `anchor deploy`, sync WSL `.so` files** — otherwise you'll overwrite devnet with stale binaries.
- **Devnet clock skew:** add 30-60s buffer when waiting for expiry in test scripts.
- **WSL `/tmp` doesn't persist between invocations.** Each `wsl bash -c` is a fresh session.
- **Solana CLI default RPC** is set to devnet. If a future session runs against localhost it will silently fail.

### Build / runtime
- **Buffer polyfill must be imported first** in `main.tsx` via `app/src/polyfills.ts`.
- **800K CU compute-budget bump** for anything touching Token-2022 extensions + transfer hook. Crank bumps to 1.4M for atomic settle. **Stage C American `create_shared_vault` will need ~400K bump** for BS-2002 (~240K) + Pyth read + Token-2022 mint creation + vault setup.
- **Token-2022 ATA creation must be idempotent** in the frontend.
- **`bigint: Failed to load bindings, pure JS will be used`** on crank startup. Harmless.
- **JSX in `.ts` files works in Vite but breaks `tsx` runner.** Any file with JSX should be `.tsx`.
- **`tsc --noEmit` on Windows can return clean while Vercel's clean-room build fails.** Final verification before push: `npm run build` (forces clean rebuild matching Vercel).
- **`npm run build` from `app/` may fail in WSL with `@rolldown/binding-linux-x64-gnu`** — npm optional-deps bug. Fallback: run from PowerShell, or `rm -rf node_modules && npm install` in WSL.
- **`program.account.<Type>.all()` throws "offset out of range"** on v1-era orphan accounts. Workaround: bypass Anchor for full-collection scans, use raw `getProgramAccounts` + manual byte parsing with sane-max length guard. Same pattern used in `scripts/migrate-shared-vaults-carry-rate.ts` for legacy SharedVault enumeration.

### Stage A specifics
- **`cu-profile` feature must NEVER be enabled in production builds.** The IDL with cu-profile includes 3 extra test instructions; deploying that IDL would expose them as callable methods. Default `anchor build` correctly omits them. Verification grep pattern: `grep -c '"name": *"shrinkSharedVaultForTest"' app/src/idl/opta.json` should return 0.
- **BS-2002 fixed-point precision:** never materialize α as a separately-stored value. The `α·S^β = (B*-K)·(S/B*)^β` reformulation is in `bs2002_call_price` for a reason — bypassing it will silently zero out two terms when β is large.
- **Python reference regen:** `python3 scripts/gen_bs2002_refs.py` runs from Windows Python 3.11 (WSL Python lacks pip by default; Tier 2 fallback per HANDOFF norm). Cross-val tolerance is 1.0% between Python BS-2002 and QL BS-1993; if it ever exceeds 1.0% the script exits non-zero.
- **The `__shrink_shared_vault_for_test` instruction is cu-profile-gated.** Production migration uses `migrate_shared_vault_carry_rate` (admin-only, not feature-gated, production instruction).

### Stage B specifics

- **`bytemuck` is now a direct dep + needs the `min_const_generics` feature.** Anchor 0.32.1's `#[account(zero_copy)]` macro emits bare `bytemuck::` paths (not `anchor_lang::__private::bytemuck::`), so consumer crates must declare `bytemuck` directly. And bytemuck's default `Pod` impls only cover a small whitelist of array sizes; for the 720-element `samples` array in `VolOracle` we need `features = ["min_const_generics"]`. Both gotchas are documented inline in `programs/opta/Cargo.toml` so the next person bumping deps doesn't drop the feature flag.
- **`zero_copy` is mandatory for any account > ~3 KB.** The BPF stack ceiling is 4 KB. Anchor's normal `Account<T>` flow Borsh-deserializes the full struct into a stack-allocated value during account validation — `VolOracle`'s 5760-byte samples array overflows immediately. Fix: `#[account(zero_copy)] + #[repr(C)] + AccountLoader<T> + load_init()/load_mut()/load()`. Field order matters for `bytemuck::Pod` compliance: i128 fields go first to lock 16-byte struct alignment from offset 0, then i64s, then smaller types, then explicit `_padding: [u8; 11]` at the end to make total size a multiple of 16. The compile-time `const _: () = assert!(size_of::<VolOracle>() == 5856)` is the canary against silent layout drift.
- **`test-fast-vol` cargo feature MUST NEVER deploy.** Shrinks `VOL_ORACLE_MIN_PUSH_INTERVAL_SECS` from 55 minutes to 1 second so multi-push integration tests can run against solana-test-validator (no clock-warp helper). Production builds embed the 3300s constant. Verification: `target/idl/opta.json` is feature-agnostic (the constant doesn't appear there), so the IDL grep can't catch this directly — but `cargo clean -p opta` before deploy + a feature-free `anchor build` is the discipline (matches the `cu-profile` never-deploy rule). The hook crate carries a no-op `test-fast-vol` feature mirror so workspace-wide `--features` propagation doesn't error.

### Testing
- **Two test runners:** `anchor test` runs full Mocha+Chai via `ts-mocha`. `run-tests.sh` is a thin wrapper with finer-grained control. Default to `run-tests.sh` for iteration.
- **Tests named `zzz-*.ts`** run last by mocha alpha ordering because they depend on earlier fixtures.
- **38 failing tests pre-Stage-A** — all fixture clock-skew, NOT regression. Tracked as Tier-2 work.
- **cu-profile + realloc tests** require explicit opt-in via `CU_PROFILE=1` env var. They don't run on default `anchor test`.

### Hermes / Pyth specifics
- **Mainnet Hermes is the default**, not Beta. Beta has guardian-set sync issues against Solana devnet's Wormhole Core Bridge.
- **`pyth-solana-receiver-sdk` does NOT expose `get_ema_price_no_older_than`** despite SDK skimming. Read the source manually.
- **Hermes historical endpoint is `/v1`, not `/v2`.** Latest is `/v2/updates/price/latest`; historical for backfills is `/v1/updates/price/{publish_time}`.

### Anchor IDL
- **`anchor deploy` always re-uploads the IDL** even when bytes are identical.
- **`anchor idl fetch` re-orders JSON keys** vs `anchor build`-time emit. Use `python3 -m json.tool --sort-keys` on both before diffing.

### Code org
- **PDA seeds are string constants** repeated in both Rust and TS. `app/src/utils/constants.ts` mirrors the Rust seeds.
- **`USE_V2_VAULTS` feature flag** still gates UI to V2-only. V1 archived.
- **IDL regeneration** — every Rust instruction signature change requires `anchor build` + copy to `app/src/idl/`. After Stage A, frontend IDL drift is expected until Stage H.
- **Cross-package imports from `crank/` to `app/src/`** use `@app/*` tsconfig path alias.
- **The Phase 2 scope doc at `.context/plans/phase2-american-onchain-pricing-scope.md` is canonical** for all Phase 2 Stage planning. Don't re-decide locked items there without explicit user directive.

### Repo hygiene
- `.context/` is gitignored — contains audit outputs, PoCs, and the Phase 2 scope/planning docs. Never commit.
- `*-keypair.json`, `id.json`, `.env*` are gitignored — never commit secrets.
- `__pycache__/` gitignored as of Stage A.
- `.test-fixtures/` is gitignored. Reference-only artifacts; regenerate as needed.
- Several arc audit/plan markdowns are kept local-only by policy.
- `MIGRATION_LOG.md` is committed and carries chronological story across major arcs.
- Always use explicit `git push origin master:main` refspec when mirroring.

---

## 11.5. Phase 2 Plan (canonical reference: `.context/plans/phase2-american-onchain-pricing-scope.md`)

Phase 2 builds American option support with end-to-end on-chain pricing, while leaving European untouched. The scope doc is the source of truth; this section is a navigational summary.

### Why Phase 2 exists

The earlier "on-chain Black-Scholes" framing overclaimed — the math library was linked but no production handler called it. Phase 2 makes that claim true for American options first. By Stage I, American vault creation will compute premium entirely from on-chain data (realized vol from a permissionless oracle + BS-2002 closed-form math), and other Solana programs can CPI `get_option_price` for definitive pricing.

### Five locked decisions

1. American on-chain pricing; European untouched (migrated later in a separate arc)
2. 30-day realized vol window
3. Crank-driven per-asset on-chain ring buffer for vol data
4. Hourly sampling, 720-sample buffer, 7-day warmup
5. Pure realized vol + BS-2002 on-chain; no writer override, no admin vol input

### Stage status

- **A — BS-2002 math kernel + plumbing — SHIPPED** May 14 2026 (`3d33abc` + `7e98a46`)
- **B — On-chain realized vol oracle — NEXT** (~3-4 weeks)
- **C — On-chain pricing wired into American `create_shared_vault` + `get_option_price` for CPI** (~1-2 weeks)
- **D — American vault instructions** (~1 week)
- **E — Token-2022 metadata `exercise_style`** (~3 days)
- **F — `exercise_american` instruction** (~1 week)
- **G — Settlement American branch** (~3 days)
- **H — Frontend (toggle + on-chain vol display + clears Vercel red)** (~1.5 weeks)
- **I — Audit + deploy** (~1 week + audit turnaround)

### Honest pitch framing

Today (European, pre-Stage-C wire-up):
- BS math library is on-chain (linked via solmath)
- Production pricing routes through frontend for writer flexibility
- On-chain pricing instruction is the next protocol arc

After Phase 2 ships:
- American options price entirely on-chain — vol from on-chain realized vol oracle, BS-2002 math on-chain, no admin inputs, no off-chain dependencies
- Any Solana program can CPI `get_option_price` and receive a definitive price
- European migration to on-chain pricing follows in a subsequent arc

Roadmap framing (Phase 4+): full implied vol oracle aggregating multi-venue option prices (not built; positioned as future work).

---

## TL;DR

- **Opta** is a permissionless options primitive on Solana with Token-2022 "living" option tokens, any-asset markets via Pyth, V2 shared-vault liquidity, permissionless auto-finalize. Built for Colosseum Frontier (April 2026); hackathon submitted May 11.
- **Live on devnet** with frontend on Vercel (`opta-solana.vercel.app`). Devnet slots: opta `460518532`, opta_transfer_hook `460518751` (unchanged since May 5; Stage A is pure code addition with no redeploy).
- **Phase 2 Stage A SHIPPED May 14 2026.** BS-2002 American option pricing math kernel + carry_rate_bps plumbing + admin migration instruction. Commits `3d33abc`, `91b1738`, `7e98a46` on master + main. Math kernel is linked + tested + ready; not yet called from production (that's Stage C).
- **Phase 2 plan canonical:** `.context/plans/phase2-american-onchain-pricing-scope.md`. Stage B (on-chain realized vol oracle) is the next arc.
- **Honest pricing framing:** the math library is on-chain; production premium today is computed in the writer's browser and submitted as an arg. Phase 2 fixes this for American options first.
- **Programs ID:** `CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq` (opta), `83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG` (transfer hook).
- **Branches:** master + main mirrored at every commit; both at `7e98a46` as of May 14 2026.
- **Vercel:** next deploy expected red due to IDL drift (frontend missing the 6th `carry_rate_bps` arg). Prior good deploy continues serving production. Stage H clears the red.
- **Biggest gotcha:** the protocol runs on Solana devnet but uses Pyth's mainnet feeds. Don't confuse "we're on mainnet" with "Solana mainnet" — protocol is still devnet; only the price oracle endpoint is production.
