# STATE SNAPSHOT — 2026-07-31T15:26Z (measured, not remembered)

This file is the **only launch source of truth**. Every line below was read from
the box or from chain at the timestamp above, not recalled.

| Service | State |
|---|---|
| `opta-tweet` | posting **LIVE** (`DRY_RUN=false`, 4/day) · replies **LIVE** (`REPLY_DRY_RUN=false` as of 2026-08-01T09:50:10Z, §6c) · `REPLIES_ENABLED=true` · caps **2/day, 1/user** |
| `opta-writer` | asks LIVE, `MAX_CELLS=470`, **440 live orders** · bids LIVE at **`BID_MAX_CELLS=3`** · quoteFailed 240/h steady |
| `opta-taker` | **`DRY_RUN=1`, `ARMED=0`** · band 500/5000bps · float $10k · **OI cap $2.5k** · scanning 454 asks/tick, 0 eligible (453 internal + 1 settled) |
| `opta-indexer` | schema **v5** · 104,969 txs · **98,936 events** · backfill done · wallets **23 ext / 7 int** |
| Boards | profit **3** · volume **23** · referrals **0** · social **0** — UI still flag-gated OFF in prod |
| All 7 units | `active`, **`NRestarts=0`** across writer/crank/taker/indexer/trigger/tweet/quotes |

**Balances (chain):**

| Wallet | SOL | USDC |
|---|---:|---:|
| writer | 13.93 | 190,531 |
| taker | 7.00 | 10,000 |
| faucet | 12.58 | 9,730,000 |
| admin | 4.84 | 10,903,063 |
| crank | 21.57 | 0 |

**Airdrop — 24h+ figure now real (supersedes the 4-run partial):** 25 runs over
28.2h, 2 grants x 2 SOL = **3.41 SOL/day actual**, 8% hit rate. Decline mix is the
surprise: **22 of 23 are faucet `Internal error`, only 1 is rate-limiting** — the
public faucet is mostly broken for us, not throttling us. Comfortably covers
steady-state burn (~0.05 SOL/day); does NOT cover a repost-wave day.

**Still queued, NOT done by any agent:** tenor-roll T-item (no commit touches
`tenors.ts`/`ladder.ts` since Jul-30). Reconstruct the 08:54Z wave, confirm
`EQUITY_MIN_LEAD_SECS=24h` explains the timing, decide whether ~5 SOL/day is
sustained or roll-day-only, then propose ONE fix with numbers. No tenor changes
without a separate greenlight.

---

# GO-LIVE checklist — EPOCH 0 campaign

Everything on this list is **deliberately not done**. Each item is staged,
reversible, and independently verifiable. Nothing here happens until the call is
made to go public.

Current state: the points API runs **loopback-only** on `127.0.0.1:8791` inside
`opta-indexer`. It is unreachable from the internet. Shadow mode is still on —
nothing is user-visible.

---

## 1. Expose the API through nginx — ⚠️ touches the LIVE production domain

`opta.fyi` is a live nginx reverse-proxy to Vercel. This is the highest-risk
step on the list; do it first while attention is on it, not last.

```bash
ssh root@144.202.58.6
cp /etc/nginx/sites-available/opta.fyi.conf \
   /etc/nginx/sites-available/opta.fyi.conf.bak-pre-points     # ROLLBACK POINT
# fold in blocks 1 and 2 from indexer/deploy/nginx/points-api.conf.staged
nginx -t                                     # MUST pass — do not reload on failure
systemctl reload nginx
```

**Verify, in this order:**
1. `curl -sS -o /dev/null -w '%{http_code}\n' https://opta.fyi/` → **200** (the
   Vercel proxy still works — check this BEFORE celebrating the new route)
2. `curl -sS https://opta.fyi/api/points/stats` → JSON
3. `curl -sS -o /dev/null -w '%{http_code}\n' -X POST https://opta.fyi/api/points/referral/code` → 415 (not 404: proxying works, body validation rejects)

**Rollback:** `cp …bak-pre-points …opta.fyi.conf && nginx -t && systemctl reload nginx`

## 2. Consolidate the X bearer token

Phase 2b created `/etc/opta/x-read.env` (`root:opta 0640`) holding a **copy** of
`X_BEARER_TOKEN`. `/opt/opta-tweet/.env` still has its own copy, so the secret
exists in two places — accepted during build, not acceptable at go-live.

```bash
cp /opt/opta-tweet/.env /opt/opta-tweet/.env.bak-pre-xshare     # ROLLBACK POINT
sed -i '/^X_BEARER_TOKEN=/d' /opt/opta-tweet/.env
# add to /etc/systemd/system/opta-tweet.service, under the existing EnvironmentFile:
#   EnvironmentFile=/etc/opta/x-read.env
systemctl daemon-reload && systemctl restart --no-block opta-tweet
```

**Verify:** `systemctl is-active opta-tweet` → active, `NRestarts` unchanged, and
the bot's next cycle logs a successful X call. **Rollback:** restore the `.bak`
and remove the extra `EnvironmentFile` line.

**Also:** confirm the rotation checklist covers the new file. A key rotation must
now update **three** consumers, not two: `/opt/opta-crank/.env`,
`/etc/opta/x-read.env`, `/opt/opta-tweet/.env`.

## 3. Faucet SOL top-up — PARTIALLY DONE (covers early campaign, not scale)

**Executed 2026-07-30.** Faucet went 4.58 -> **17.58 SOL = 351 claims** at 0.05
each (5 SOL from admin + 8 SOL from the writer wallet). USDC side is not a
constraint: faucet holds $9.73M and the admin can mint on demand.

- [x] Top-up executed; faucet at 351 SOL claims
- [ ] **NOT sufficient for scale.** 351 claims covers the early campaign only.
      SOL cannot be minted — it must be accumulated.
- [ ] **Accumulate devnet SOL before pushing past ~300 testers:** daily
      `faucet.solana.com` grabs, and/or request a devnet SOL grant from the
      Solana Foundation or Helius. Start this early — it is rate-limited and
      slow, so it cannot be done reactively.
- [ ] Set a low-balance alert on the faucet wallet.

### 3b. ⚠️ WRITER SOL BURN — more urgent than the faucet

Measured over a 17-hour window (2026-07-29 17:20Z 25.774 SOL -> 2026-07-30
10:20Z 21.940 SOL): **~3.83 SOL burned = ~5.4 SOL/day.**

The writer runs ~200 reprices + ~200 cancels per hour, plus periodic repost
waves that mint new series and vaults (the 08:54Z heartbeat shows `posted:180`)
— and series/vault creation pays rent, which dominates the fee cost.

After sending 8 SOL to the faucet the writer holds **13.94 SOL ≈ 2.6 days** at
that rate. The funding plan assumed "~17.7 SOL ≈ 125 days", which implied
~0.14 SOL/day — roughly **38x lower than measured**. Two things compounded: the
writer had already burned 3.8 SOL overnight before the transfer, and the burn
assumption itself was wrong.

- [ ] **Decide within ~2 days:** top the writer back up, or accept it stopping.
      A writer with no SOL stops market-making entirely — the board goes stale
      and every quote surface with it.
- [ ] Options: return ~5 SOL from the faucet (leaves 251 claims, still ample for
      early testing), or from the admin reserve (only 5.2 SOL, earmarked for
      program upgrades), or accumulate externally per 3 above.
- [ ] Add a writer low-SOL alert. `OPTA_WRITER_LOW_BALANCE_WARN_SOL` defaults to
      1.0, which at 5.4 SOL/day is under 5 hours of warning — raise it to ~10.
- [ ] Longer term the burn itself is the problem: ~5 SOL/day is ~150 SOL/month
      of devnet gas that no reshuffling fixes.

## 4. Provenance completeness — gates the profit board

- [x] **DONE 2026-07-26.** `atasPolled` plateaued at **15 for 12 consecutive
      ticks** (~2h). Coverage is understood, not merely flat: eligible 28,
      polled 15, unpolled 13 — and **all 13 unpolled have no known USDC ATA
      because they never claimed from the faucet**, so `faucet_in = 0` and they
      are already profit-ineligible ("no faucet claim on record"). Zero unpolled
      wallets are classified not-a-wallet; zero unpolled for any other reason.
      The gap therefore cannot wrongly qualify anyone.
- [x] **DONE 2026-07-26.** `atasSkippedOverCap = 0` in every `capital tick`.
- [ ] Accept or fix: faucet history starts **2026-07-04**, three days after the
      trade tape, so wallets funded before then show `faucet_in = 0` and are
      correctly excluded. Fine for a fresh campaign; state it publicly if any
      existing wallet expects to compete.

## 5. Scaling — Phase 3 prerequisite, on the record since 2a

External-inflow detection is **O(wallets)**: per-ATA polling, capped at
`OPTA_INDEXER_ATA_MAX=500`. A plain SPL `transfer` does not name the mint, so no
single account observes every USDC movement.

- [ ] **Before any launch beyond ~500 active wallets**, replace this with a
      Helius webhook or a mint-wide stream. The cap logs loudly when hit, but a
      truncated provenance set silently mis-qualifies wallets.

## 6. Quest panel visual pass — REQUIRED before the flag goes on

The 2c automated screenshot set (56 shots, both modes x desktop/mobile) covers
every campaign surface EXCEPT one: the quest panel sits inside
PortfolioTerminalPage's connect-wallet gate, and headless chromium has no
wallet, so all 12 portfolio shots show the connect prompt rather than the panel.
Its logic is unit-tested; its APPEARANCE has never been reviewed.

- [ ] Connect a real wallet and review the quest panel in **dark** and **light**
- [ ] Check every block renders: totals, 7-step chain, referral (code + copy +
      bind), social submit, bounty submit
- [ ] Exercise the signed-action states — idle -> confirm in wallet -> pending ->
      success/fail — at least once end-to-end
- [ ] Verify on a **mobile viewport** too

```bash
ssh -N -L 8791:127.0.0.1:8791 root@144.202.58.6 &
cd app && VITE_EPOCH0_UI=1 VITE_POINTS_API_BASE=/api/points npx vite
```

## 6b. Writer-bid widening — canary passed at 3 cells, widening is a GO-LIVE call

The writer bid side is **LIVE** at `OPTA_WRITER_BID_MAX_CELLS=3`
(`OPTA_WRITER_BID_ENABLED=1`), flipped 2026-07-30T16:04:28Z. A full clean hour
passed on 2026-07-30 18:07–19:14Z: 7 posts, all exactly 1500 bps below model
mark and 2273–2287 bps below their resting anchors, **zero crosses, zero fills,
zero restarts**, quote-failure flat (267→265), boards unmoved.

Three cells is a canary throttle, not a market. It produces a visible two-sided
book on ~1 series at a time out of ~320.

- [ ] **Widen to 20–50 cells** and run a SECOND canary hour at the wider setting
      before calling the bid side done. The gates that matter change character at
      scale: `cell-cap` stops binding (it absorbed 1,062 skips at 3 cells), so
      `bidMaxNotionalPerAsset` / `bidMaxNotionalGlobal` / `bidReserveUsdc` become
      the live constraints for the first time.
- [ ] Re-verify no-cross across the wider set — 3 bids is a weak test of a
      no-cross invariant that must hold across every series simultaneously.
- [ ] Watch inventory: `OPTA_WRITER_MAX_LONG_PER_SERIES=10` has never bound,
      because no bid has ever been filled. At 20–50 cells a fill becomes likely
      and that cap gets its first real exercise.

## 6c. Reply lane — RESOLVED **LIVE with tightened caps** (founder ruling 2026-08-01)

> **FOUNDER RULING 2026-08-01T09:50:10Z — `REPLY_DRY_RUN=false`. Lane is LIVE.**
>
> The shadow-until-10-drafts gate below (`8c456b9`) is **superseded**. At the
> tightened caps it is roughly a week of accumulation for evidence that already
> exists: `postReply()` is verified live (`2083202301074853964`, `status=posted`,
> non-null `tweet_id`). **The caps are the safety mechanism, not the shadow flag.**
>
> | field | value |
> |---|---|
> | flag | `REPLY_DRY_RUN` `true` → `false` |
> | unchanged | `REPLIES_ENABLED=true`, `MAX_REPLIES_PER_DAY=2`, `MAX_REPLIES_PER_USER_PER_DAY=1` |
> | executed | 2026-08-01T09:50:10Z, one-line `.env` diff, backup `.env.bak.20260801-reply-live` |
> | verified | both loops up clean; reply loop logs `REPLY_DRY_RUN=false poll=12m caps: 2/day, 1/user, reads 300/day — LIVE, replying on X`; first poll clean; no errors in 60s; `NRestarts=0` |
> | ledger | ClickUp `86eyg1yxu` (Opta › Engineering), filed at execution time |
> | rollback | `cp /opt/opta-tweet/.env.bak.20260801-reply-live /opt/opta-tweet/.env && systemctl restart opta-tweet.service` |
>
> Everything below this block is **historical record**. The 10-draft flip gate is
> closed as superseded; do not re-open it as a blocker.
>
> **Known behaviour, not a bug:** at `1/user/day` a second mention from the same
> handle inside one UTC day is dropped by `replyFilters.ts` as
> `per-user daily cap reached (1)` — before any model call, so it produces no
> draft, no flag, and no journal line beyond the poll counter. This already
> happened once (mention `2083227921557201156`, 2026-07-31T16:30Z). Silent-drop
> is the intended cost of the cap.

### Prior reconciliation (historical — superseded by the ruling above)

> **RECONCILED 2026-07-31T15:26Z.** Two sessions decided this in opposite
> directions within four minutes and neither could see the other:
>
> | time (UTC) | event |
> |---|---|
> | 13:54:23 | a parallel agent set `REPLY_DRY_RUN=false` |
> | 13:56:38 | this session committed `8c456b9` — "reply lane stays shadow" |
> | 13:56:42 | their restart |
> | 14:15:57 | their `fa93ef4` — documents both loops LIVE, names `postReply()` as THE open item, verification = "founder reply-baits a bot tweet" |
> | 14:44:45 | @nanko1goatit reply-bait → reply posts — **their verification PASSED** |
> | 14:51:49 | this session reverted to `REPLY_DRY_RUN=true` |
>
> The flip was **deliberate and documented** — in git, not ClickUp, 21 minutes
> after execution, which is why a ClickUp-only check read it as unledgered. The
> reply this session treated as an incident was their verification succeeding.
>
> **`postReply()` IS NOW VERIFIED.** Their open item is closed by evidence:
> `2083202301074853964`, to @nanko1goatit, on our own msft thread, `status=posted`
> with a non-null `tweet_id` — exactly the PASS condition `fa93ef4` specifies.
> Reply quality was sound: correct on gap risk vs delta hedging, on-voice,
> `injection=0`, full thread context.
>
> **STATE AS OF THAT RECONCILIATION: `REPLY_DRY_RUN=true`** (that session's revert), caps 2/day
> 1/user. The 10-draft gate below and `fa93ef4`'s "both loops LIVE" are in direct
> conflict. **Nanko rules; neither agent should flip it again in the meantime.**
> Arguments both ways are recorded — the gate wanted evidence before a public
> write path, and the evidence now exists (3 drafts + 1 verified live reply).

### Original 6c decision (SUPERSEDED 2026-08-01 — retained for the record)

`REPLY_DRY_RUN=true` on `opta-tweet`. **It does not flip at go-live.** The
review found the filters refuse nothing — `prefilter()` 0 refusals,
`detectInjection()` 0 refusals — so the narrow funnel is the classifier declining
threads it cannot see, which is correct behaviour. Nothing needs loosening. What
is missing is evidence: **two** shadow drafts is not a basis for turning on a
public write path.

**Draft surfacing already works — no build needed.** `processMention` emits every
ANSWER to `/opt/opta-tweet/replies.md` with the mention, the draft, the reason and
an `[our-thread]` marker. Both existing drafts are there, fully formed.

- [ ] **Daily during launch week:** read `/opt/opta-tweet/replies.md`. ~~post any
      good draft **manually** from the @optafinance account. The bot writes
      nothing.~~ **As of 2026-08-01 the bot posts these itself** — the daily read
      is now after-the-fact review of what already went out, capped at 2/day.
- [x] ~~**Flip gate (separate decision, NOT part of go-live):** at ~**10 accumulated
      drafts**, review them as a set, then flip `REPLY_DRY_RUN=false` with
      `MAX_REPLIES_PER_DAY=2` for the first week.~~ **CLOSED as superseded
      2026-08-01** — founder ruled the caps are the safety mechanism and
      `postReply()` was already verified. Flipped live; `MAX_REPLIES_PER_DAY=2`
      retained as specified.
- [ ] Do **not** read the `(draft N/10)` counter in `replies.md` as progress
      toward that gate — it is `repliesToday+1 / MAX_REPLIES_PER_DAY`, a DAILY
      counter. Both current drafts read `1/10` and they are days apart. Count
      lines in the file instead.
- [ ] At ~1 live mention/day this takes ~2 weeks. Accept the wait or accept a
      thinner evidence base — deliberately, not by drift.
- [ ] Do **not** add third-party thread fetching to lift the IGNORE rate. It pipes
      attacker-controlled text from arbitrary threads into the prompt for marginal
      gain; the live answer rate is already 2/2.

---

# EXECUTION ORDER — weight freeze Sun 2026-08-02, go-live Mon 2026-08-03

Ordered so each step's blast radius is contained by the one before it, and so
nothing user-visible appears before the thing behind it is proven.

| # | Step | Why here |
|---|------|----------|
| 1 | **Ops** (§9) — backups, uptime check, `MemoryMax`, retention, **+ snapshot `points.db` + `-wal` BEFORE first boot of the v6 build**, then deploy the frozen build and set `OPTA_INDEXER_COMMIT` (§7) | Do it while nothing is live. After launch there is no quiet window. **The v5→v6 migration is one-way — the snapshot is the rollback.** The boot gate ships in this build: a restart on a drifted `dist/` now refuses to start, so this must land before anything depends on the API. |
| 2 | **nginx** (§1) — expose `/api/points` | Highest-risk step, touches the live domain. First, while attention is on it. Verify `https://opta.fyi/` still 200s BEFORE checking the new route. |
| 3 | **X secret** (§2) — consolidate `X_BEARER_TOKEN` | Independent of the campaign; get the two-copy secret down to one before more services exist. |
| 4 | **Vercel env + deploy** — `VITE_EPOCH0_UI=1` | The API must already be reachable (2) or the UI ships pointing at a 404. |
| 5 | **Smoke** — quest panel visual pass (§6), signed-action round trip, mobile viewport | The one surface automated screenshots never covered. Must pass before anyone is invited. |
| 6 | **Bid widen** (§6b) — `MAX_CELLS=3 → 30`, then a canary hour | A real two-sided book before users arrive. 30 is the midpoint of the proposed 20–50; the notional/reserve caps bind for the first time here. |
| 7 | **Arm taker** — registry re-derive verified, then `DRY_RUN=0`, then `ARMED=1` | LAST of the machinery. Arming is one env flip because the registry half is already done; the boot marker must read `mode: "ARMED"` with the expected band and budgets. |
| 8 | **Announcement** | Only after 1–7 are green. Everything above is reversible in seconds; an announcement is not. |

Weight freeze on **Sunday 2026-08-02** (§7): `quests_v1.json` and `rules_v1`
frozen, because a rules change after launch re-scores retroactively — correct by
the TAPE/SCORE design, and alarming to a user mid-campaign.

## 7a. AMENDMENT — `rules-v1.1-frozen` (2026-08-05), the W2/O7 settle_vault change

**The first change to the frozen scoring surface since the 2026-08-02 freeze.**
`rules-v1-frozen` stays in history, untouched and re-checkable; `rules-v1.1-frozen`
supersedes it as the live tag.

### What changed — three things, nothing else

1. `settle_vault` added to `IX_TARGETS` (`tape/ixDecode.ts`) at **ZERO base
   points**. `rules_v1`'s scoring switch has no case for `IxSettleVault` and ends
   in `default: break`, so it earns no `takerPts`, no `makerPts`, no flat award.
   Quest credit only.
2. **W2** now counts **DISTINCT `(asset, expiry)` settlement records per ISO
   week**, not raw settle events. `settle_expiry` fires once per tuple so the two
   were equivalent under v1; `settle_vault` fires once per **vault**, so without
   the dedupe one click finalising a 129-vault expiry would have scored 129×.
   **60 points and the 3/week cap are unchanged.**
3. **O7's settle arm** credits `settle_vault` the same way. **The `create_market`
   arm is untouched.**

### Why

W2 — "Settle an expiry" — was **structurally crank-owned and effectively
unearnable by a user**. `settle_expiry` is the only act v1 credited, and for a
Switchboard market its signed quote is verifiable for only
`SB_SETTLE_WINDOW_SECS = 300` after expiry, against a SlotHashes sysvar that
retains ~512 slots. A human could not realistically win that race, and the crank
settles automatically.

`settle_vault` is the **user-facing settle act**: permissionless, oracle-free,
no deadline, and the half the crank deliberately does not do — `settleGuardJul31.ts`
states it outright: *"the guard settles TUPLES, not vaults."* Crediting it puts
the quest on the work a user can actually perform.

### Retroactive effect: **EXACTLY ZERO**, for two independent reasons

1. `settle_vault` was never in `IX_TARGETS`, so there are **zero `IxSettleVault`
   rows on the tape**. The 101 `VaultSettled` rows are emitted logs with
   `wallet = null` and cannot attribute an executor. The amendment is
   **forward-only**.
2. **Even with a full backfill it is still zero.** All 101 historical
   `settle_vault` instructions, across 35 signatures, were executed by exactly two
   wallets — **both INTERNAL** (crank-gas 99, admin 2), and both excluded from
   every board. Their W2 is already saturated: crank-gas sits at the **3/week cap
   (180 = 3×60)** in W27–W31 from `settle_expiry` alone, and admin's 2
   `settle_vault` tuples are the **same tuples** it already earned `settle_expiry`
   credit for in W27.

Measured on copies against one shared tape snapshot: **baseline v1 → amended
(no backfill) = 0 diffs / 35 wallets. baseline v1 → amended (101 rows
backfilled) = 0 diffs / 35 wallets.** External wallet delta **0.00** in both.
**No wallet's total changes. Nothing needs a public correction.**

Those zeros are evidence only because a positive control proved the harness could
go non-zero: 3 synthetic `IxSettleVault` rows for an external wallet in a clean
week, spanning 2 distinct settlement records, produced W2 = **120 = 2×60 (not
180)** — proving both the credit path and the tuple dedupe — with the delta
entirely in `quest_points` and `base_capped` unchanged, proving zero base points.

### Version strings — all three move together or it will not boot

`RULES_VERSION` `"v1.1"` (`rules_v1.ts`) · `quests_v1.json` `version` `"v1.1"` ·
`FROZEN.json` `rulesVersion`/`questsVersion` `"v1.1"`. `frozenGate` deep-equals
all three, so a partial bump refuses to start. **Filenames are unchanged on
purpose** — renaming would churn every frozen `path`/`specifier` for no benefit.
The version is the contract, not the filename.

### Re-freeze checklist — AMENDED 2026-08-05, and this defect is the citation

**Every re-freeze must now include a READ-PATH SWEEP before the tag is cut:**
grep every consumer of every VERSIONED table and confirm each read filters on the
version column. A versioned table is any table whose primary key carries a
version — today `quest_completions` `(quests_version, wallet, quest_id, period_key)`.

**Why.** `rules-v1.1-frozen` shipped with `freeze --check` 9/9, the boot gate
green, and a **provably zero** live points diff — and still broke the public API.
`recompute` deletes only its OWN version before reinserting, so prior rulesets'
rows survive by design as an audit trail. Three read paths queried the table with
no version filter, and the moment a second version existed they double-counted:
`/points/wallet/<w>` returned every quest twice, and `/points/quests` reported
`completions` at 2x (O1 **34** instead of 17, W1 **38**, W2 **12**). Scoring was
never wrong — `wallet_points` comes from the evaluator, not from summing that
table — which is exactly why every existing gate passed and nothing caught it.

**The lesson is about what the gates measure.** `freeze --check`, the boot gate
and a zero points-diff all verify the SCORING surface. None of them look at a
read path. A version bump changes the shape of the data every reader sees, so the
readers are part of the change whether or not they are in the manifest.

Fixed in `handlers.ts` (wallet path, quests catalog, and the referral O1 gate —
the third was not yet mis-behaving but was equally unscoped). Gated by
`api.test.ts` *"a STALE prior-version quest row is invisible to every read path"*,
which fails against the unfiltered code. `handlers.ts` is not a frozen artifact:
`freeze --check` stayed **9/9** across the fix, which is the proof of that claim.

---

### Tags

| tag | meaning |
|---|---|
| `rules-v1-frozen` (`c909506`) | the 2026-08-02 freeze. **Untouched**, still in history, still re-checkable. |
| `rules-v1.1-frozen` | live from 2026-08-05. 9 artifacts re-hashed, `freeze --check` 9/9, 3× recompute byte-identical (`e509c938…`). |

### ⚠️ Read RULE 4 in HANDOFF before running any analysis against scoring

This amendment's own measurement session recomputed the **live** database twice by
accident — `OPTA_DB_PATH` was passed where the indexer reads `OPTA_INDEXER_DB`, so
the unknown variable was ignored and `loadConfig()` fell back to the default state
dir. Blast radius was nil and was **proven** nil, but by luck. HANDOFF **RULE 4**
now governs: simulation runs on copies only, live `points.db` is service-owned,
scripts must print the resolved `dbPath`, a negative result requires a positive
control, and the live-untouched invariant is `wallet_points.computed_at` — **never
file mtime**, which the service moves continuously while indexing.

---

## 7. Shadow → live cutover — WEIGHTS FROZEN 2026-08-02

> **FROZEN 2026-08-02T19:25:00Z · git tag `rules-v1-frozen` · `rules_version=v1`,
> `quests_version=v1`.** A rules change after launch re-scores retroactively —
> correct by the TAPE/SCORE design, alarming to a user mid-campaign. From here a
> weight edit is a deliberate, tagged, re-frozen act, not a deploy side effect.

### Weight edits applied at the freeze

| # | Change | Why |
|---|---|---|
| D16 | Chain is **O1 O2 O3 O4 O6 O7** (6 steps). **O5/O5b moved OUT** to standalone bonuses | `TriggerPlaced` has no user surface — `OrderTicket.tsx` gates the Stop/TP-SL tabs "placement UI coming soon". With O5 mid-chain, strict D12 sequencing walled off O6, O7 and OC for **every** wallet. |
| D17 | `createMarketLifetimeCapPts: 200` (decay curve untouched) | `create_market` is permissionless and needs no capital; ~20 markets paid ~360/day for 20 txs while a trader needed $500 premium for 500. |
| — | **D1** threshold `100_000_000 → 50_000_000` µUSDC ($100 → $50), points **30 → 50** | D1 was priced below D2 (40) while being strictly harder; 0 lifetime completions. |

**Points possible is unchanged at 625**: chain 450 + OC 100 = **550 reachable
through the chain**, plus O5 50 + O5b 25 = **75 dark** until the trigger
placement UI ships. O5/O5b stay in the catalog and pay the moment a trigger is
actually armed — they block nothing.

### finalPoints is now the served number

`recompute()` always built `finalPoints` = (base × multiplier) + quests + social
+ bounty + referral bond + commission — and `persistProjections()` never read it.
The UI reassembled its own total client-side as `base + quests + social`, which
silently dropped the multiplier on base, all bounty points, and the entire
referral economy. Schema **v6** adds `wallet_points` (total + all seven
components); `GET /wallet` serves `points.total`; `QuestPanel` and `PointsChip`
read it. On the measured tape this moves Σ external from **2,469.61 → 2,488.17**.

### Freeze mechanism

`indexer/src/score/FROZEN.json` pins 9 artifacts. The boot gate
(`score/frozenGate.ts`, called first in `main()`) re-hashes each runtime entry
through **`require.resolve()`** — the file Node actually loaded, not a path
literal — plus a deep-equal on `DEFAULT_RULES` and both version strings, which a
file hash cannot see. Any mismatch logs `SCORE_WEIGHTS_DRIFT expected/actual`
and **refuses to start**: an indexer that boots with drifted weights does not
fail, it quietly republishes everyone's history at unreviewed values.
`node dist/scripts/freeze.js --check` is the same comparison, for CI and pre-deploy.

| layer | sha256 | path |
|---|---|---|
| runtime | `5363c4ed4ea3137e552695c6340a8562839a73853b74a4c02f27793ba167fb5f` | `indexer/dist/src/score/quests/quests_v1.json` |
| runtime | `42f969c7dbc21c987819b1958b82f435f52ae3a900a4aa47b6efa94ab458de26` | `indexer/dist/src/score/rules_v1.js` |
| runtime | `2b3df8c9c898217b0fa2e8cf0a45b05eed73e25b6d53753e4e711cd49fc5b25c` | `indexer/dist/src/score/quests/evaluator.js` |
| runtime | `ac993838a0eecf37fbb28e5e52cf9f4ef1860da653144c635c27b23ad90eb502` | `indexer/dist/src/score/multiplier.js` |
| runtime | `7161781f693e3223297e74fec534f28b92c6df26661d997dd8ae4c0231336b01` | `indexer/dist/src/score/recompute.js` |
| runtime | `0f583c5ce0d4743b63a9b453f96624dbe07b6f2b4e0436c18df0027aac0c7676` | `indexer/dist/src/score/positions.js` |
| runtime | `6b60f9ad7706565fd26d68784983592867dd5a936866ab67c683223525612cbb` | `indexer/dist/src/score/referrals.js` |
| source | `927a036c0aee5a61dc3f2793be7f900d67ec83ca2f233bc30ab59f792e25a93d` | `indexer/src/score/quests/quests_v1.json` |
| source | `3ae81d42997d163c01f23757195481ccd218639c251bdb96b4dee98d26859c85` | `indexer/src/score/rules_v1.ts` |

`referrals.js` is pinned because pinning the referral *parameters* is not the
same as pinning the referral *rules*: the rate, bond and 25% cap live in
`quests_v1.json`, but non-circularity, activation-gating and what the cap is
measured against live in the code, and any of it can be changed without touching
a config value.

**Why hashes and not just the tag:** `indexer/dist/` is gitignored and the VPS
deploy is a path-overlay into a checkout whose HEAD is a different commit, so the
bytes that score the campaign are in no commit. A tag on `src/` would certify a
file the runtime never opens.

### Proof recorded at the freeze

- **Determinism, pre-edit:** 3× recompute on the tape at `asOf=1785685388`
  (2026-08-02T15:43:08Z; 123,819 txs / 117,435 events) — byte-identical, and
  **residual 0** against the VPS's own last recorded recompute across `scores`
  (24 rows), `quest_completions` (76) and `streak_state` (24).
- **Determinism, post-edit:** 3× recompute on the same tape — byte-identical
  (`26a62554fb6895177fa35b22cb2ddfa31c2f0a6bc2af7da7fc8dc47fcff14dc5`), including
  the run on which the v5→v6 migration fires.
- **Gate proven to reject:** a tampered `quests_v1.json` produces
  `SCORE_WEIGHTS_DRIFT` and exit 1 from both `freeze --check` and the boot gate.
- **Tests 97 → 118** (9 → 11 files), all passing. New: `finalPoints.test.ts`
  (written red — 5/6 failed before the wiring fix), `frozenGate.test.ts`, D16
  regression, D17 cap, D1 unit pin.
- **Measured effect on the live tape:** O5 now pays 2 wallets × 50 that the old
  chain blocked; the D17 cap clips `create_market` 374.77 → 200 and 259.29 → 200
  (both **internal**, so no board moves); funnel unchanged at O1=14.
- **D1 remains aspirational at $50:** the best taker-premium day ever recorded is
  **$23.54**. Halving the threshold created zero retroactive completions.

### Still open

- [ ] Review the backdated funnel: **O1=14, O2–O7=0** under D12 strict
      sequencing. If the campaign starts fresh this is fine; if it credits
      history, retune D12 first
- [ ] Decide whether existing internal wallets stay excluded (they should)
- [ ] Publish the rules page before the API is public — `GET /points/stats` now
      returns `rules_frozen {tag, hashes}` so the page can cite a verifiable hash,
      and `GET /points/quests` now enumerates O5b, W3b and the referral schedule
      (it previously omitted 75 points of bonuses and the whole referral economy)
      - **STILL UNPUBLISHED as of 2026-08-05.** The v1.1 amendment therefore has
        no live page to amend. When it ships it MUST carry this line verbatim,
        and cite `rules-v1.1-frozen`:
        > *"From rules v1.1, W2 (Settle an expiry) credits `settle_vault` — the
        > permissionless settle step a user performs — in addition to
        > `settle_expiry`. One expiry counts once however many vaults it
        > finalises. No wallet's points changed retroactively."*
- [ ] **Monday, ops step 1:** deploy the frozen build and set
      `OPTA_INDEXER_COMMIT` in `/opt/opta-indexer/.env`. The boot gate ships in
      this build — an indexer restart on an unfrozen or drifted `dist/` will now
      refuse to start, by design. Deploy before nginx exposure (§1).
- [ ] **Accepted for Epoch 0, revisit at E1:** social points are STORED TRUTH —
      `OPTA_SOCIAL_POINTS=20` is stamped into `social_posts.points` at submit
      time, so changing it does not re-score existing posts. This is the one
      point source that is not a pure projection over the tape, and bounty points
      (operator-typed per submission) are not freezable at all.

## 8. Purge Phase 2b test rows

Acceptance testing wrote real rows into the live DB via the API. They must go
before any public board is served.

```sql
-- test referrer / referee (deterministic keys from Buffer.alloc(32,'A'|'B'))
DELETE FROM referrals      WHERE referrer_wallet = 'FnDw11RnMuVPfRYeo2h9aGj8siN4iWJTz5UwdLtKcfA4';
DELETE FROM referral_codes WHERE wallet         = 'FnDw11RnMuVPfRYeo2h9aGj8siN4iWJTz5UwdLtKcfA4';
DELETE FROM social_posts   WHERE tweet_id       = '2080003991203725576';
DELETE FROM wallet_handles WHERE x_handle       = '_thekhay';
DELETE FROM bounty_submissions WHERE kind = 'bug' AND proof_url LIKE '%/issues/1';
```

- [x] **DONE 2026-07-26.** All five write-path tables purged to zero; both
      boards return `rows: []` after recompute.

## 9. Operational

- [ ] Raise `MemoryMax` above 200M **or** confirm the streaming render keeps peak
      under it (Phase 2b Item 0 brought the peak down — re-measure after a month
      of tape growth)
- [ ] Add `opta-indexer` to whatever uptime check the other services use
- [ ] Confirm `points.db` is included in any backup routine — the tape rebuilds
      from chain, but `referrals` / `social_posts` / `bounty_submissions` are
      **user-submitted data that exists nowhere else**
- [ ] Decide retention for `nonces` (swept hourly) and `write_cooldowns` (never
      swept — small, but unbounded in wallet count)

---

**Nothing above is done. Nothing above should be done until we say go.**
