# CREATE-MARKET ARC — 2026-08-12 (1 · 2A · 2B · v1.2 · 2C LIVE — arc NOT complete, SLICE 3 is the headline)

> Refreshed at the 2A close. Everything below this block predates it. Read this
> first; the EPOCH 0 block follows.
>
> ## Where the arc stands
>
> | Slice | Ships | State |
> |---|---|---|
> | **1** | reactive vol-oracle seeding (`7d72d6f`) | **LIVE + PROVEN — 114 s measured on ORE** |
> | **2A** | create-flow identity + honesty (`ca7a6a3`) | **LIVE — founder browser proof pending** |
> | **2B** | written-position visibility + arc close-out (`d05bf49`) | **LIVE** |
> | **v1.2** | O2 quest predicate, retroactive (`b4acdb8`) | **LIVE — 8 wallets recredited** |
> | **2C** | REQUEST LISTING + signed demand sink (`c46b647`) | **LIVE — browser proof NOT yet observed** |
> | **3** | guided first write from the success moment | **NEXT — the remaining headline** |
>
> ## SLICE 2A — `ca7a6a3`, live on opta.fyi + crank restarted 17:10 UTC
>
> **The reported bug was never a hang.** Two addresses "hung the create modal
> forever" — BP (`BPxxfRCX…`) and `9cRCn9…pump`. Both are real, both always
> resolved correctly: BP is *Backpack*, the pump token is *ANSEM*. The resolver
> simply had **no timeout**. Measured against the app's own mainnet fallback RPC:
> one BP mint read took **12,292 ms**, and the same read repeated ran 4,676 / 215
> / 1,663 ms — and the resolver walks 2–5 of those sequentially. Unbounded, not
> infinite; indistinguishable to a user.
>
> **Identity and listability are now two questions.** Icon / symbol / name /
> ✓Verified / mint first, then a SEPARATE verdict line. Four states replace the
> old conflation: `listable` · `no-feed` · `unknown` · `unavailable`. That last
> one exists because *"we could not check"* must never render as *"this does not
> exist"* — a dead lookup is not evidence about a token.
>
> **Source: Jupiter, proxied through `sb-create.opta.fyi/token-identity`.** NOT a
> CORS decision — Jupiter's CORS echoes our origin. A **CSP** decision:
> `img-src 'self' data: blob:` permits no remote image host and token icons live
> on arbitrary third parties, so browser-direct means wildcarding `img-src` (a
> security regression) or shipping no logos. Server-side + `data:` URI = **zero
> CSP change**. Measured live: 100–800 ms cold, 0 ms cached. tokens.xyz was
> evaluated and REJECTED as primary (`401` without a key); it is optional
> enrichment behind `TOKENS_XYZ_API_KEY`, and with the key unset/401/timing out
> the Jupiter answer stands.
>
> **A retry regression I caused the conditions for.** `62f228e` gave the SB arm a
> single auto-refetch on slow wallet approve. D2/G1 then wrapped every connection
> in `withPollingConfirm`, which — correctly, so Anchor would not resend beneath
> it — stopped throwing `TransactionExpired*` and started throwing
> `TxOutcomeError`. `isStaleSubmitError` matched on name and message text, so the
> retry silently stopped firing on the confirm leg: the exact case it existed
> for. It now reads the **structured** outcome (`kind === "dropped" &&
> retryAllowed`), because the outcome is data and the message is prose. A
> `landed` outcome must never retry — that is a second create.
> **The Pyth arm got its first retry ever**, and it REBUILDS rather than
> resubmits (a Pyth create carries an expired price update inside signed bytes).
>
> **Success moment, two variants.** SB-curated → writable now. Pyth → "pricing
> warming, about 2 minutes" + polls the VolOracle PDA and flips live with no
> refresh. Same poll clears the `/write` block, whose tooltip had said "~1 hour"
> since before Slice 1 made that false. One exported constant owns that number.
>
> **Known, NOT fixed in 2A** (all carried into 2B): cache key is lowercased while
> base58 is case-sensitive (`crank/tokenIdentity.ts`) — create is unaffected, the
> feed always comes from the anti-spoofed catalog row; Jupiter NAME search ranks
> poorly ("backpack" → SKHY before BP); `TOKENS_XYZ_API_KEY` is staged locally
> but NOT on the VPS, so enrichment is dormant. ClickUp `86eykm4ek`.
>
> ## SLICE 2C — `c46b647`, LIVE 2026-08-12 (listing demand sink)
>
> 2A made the create modal honest; a token with no feed reads "BP · Backpack ·
> ✓ Verified — no settlement feed yet". Honest, and still terminal. 2C is where
> the wanting goes: a **signed** request, one row per (wallet, mint).
>
> **The auth change is an enum entry.** `verifySigned` is generic — shape, known
> action, TTL, ed25519 over `canonicalMessage`, nonce INSERT as the replay check.
> Adding `listing.request` to the union is the whole change. Dedupe is the
> PRIMARY KEY `(wallet, mint)`, so a repeat is `INSERT OR IGNORE` → 200
> `already-requested`, never an error. Bounds: 10/wallet/rolling-24h checked
> AFTER signature verification; mint base58→32 bytes; symbol 1-16
> `[A-Za-z0-9._-]`; class 0-4. **No per-mint cap — many wallets on one mint IS
> the signal.**
>
> **Schema v7**, additive. `freeze --check` = `9 entries match rules-v1.2-frozen`
> pre- and post-restart: the quest engine is provably untouched.
>
> ⚠️ **BROWSER PROOF NOT YET OBSERVED.** As of this writing `listing_requests`
> has **0 rows** and 0 `listing.request` nonces burned, so no signed request has
> reached the sink. The sink itself IS verified live: `GET …/listing/requested`
> → 200 `{"requested":false}`, `POST` with a forged signature → 401
> `bad_signature` writing nothing and burning no nonce. What is unproven is the
> browser path end to end. Do not record this slice as user-proven until a row
> exists.
>
> ### Founder read path — demand data is the point
>
> ```bash
> ssh root@144.202.58.6 'cd /opt/opta-crank/indexer && node -e "
> const d=new(require(\"better-sqlite3\"))(\"/opt/opta-indexer/points.db\",{readonly:true});
> console.table(d.prepare(\`SELECT mint, symbol, COUNT(*) reqs, MAX(requested_at) newest
>   FROM listing_requests GROUP BY mint ORDER BY reqs DESC, newest DESC\`).all());"'
> ```
>
> ## ⚠️ KNOWN OPS — the points API is dead for ~3 min after an indexer restart
>
> The indexer boot backfill BLOCKS THE EVENT LOOP, so the API accepts
> connections but cannot answer, and nginx gives up at 60s. Observed 2026-08-12:
> four probes returned nginx **504**, then all four were served in one burst at
> `16:19:46` once boot finished (13ms / 11ms / 7ms). **A 504 in the minutes after
> a restart is this, not an outage.** Fix candidate (NOT scheduled): yield the
> loop during backfill, or hold the listener until boot completes so nginx gets a
> refused connection instead of a hang.
>
> ## RULES v1.2 — `b4acdb8`, LIVE 2026-08-12 (retroactive)
>
> **"First Write" (O2) required someone to BUY your option.** It credited from
> `VaultMinted`, and in the mint-on-fill model nothing mints when you WRITE — it
> mints when a buyer fills you. Live tape: **124,369 `OrderPosted` vs 21
> `VaultMinted`**; 36 wallets held O1 and **2** held O2. The chain is strictly
> sequential, so O2 also blocked O3 "Make a Market" — users who created a market
> AND wrote an option froze one step short of the quest their own market was
> meant to unlock.
>
> O2 now credits `VaultDeposited` OR `OrderPosted(kind=WriterAsk)`, and counts a
> qualifying write **whenever it occurred** (four wallets wrote 27–35 seconds
> before their first fill). Sequential award order is kept by clamping the award
> to `max(O1, write)`. Dry-run against a DB copy, approved, then shipped:
> **8 wallets, 1125 points, 525 external. O2 holders 2 → 8.** Live totals matched
> the dry-run to the cent. `rules-v1.2-frozen`, `freeze --check` green,
> `OPTA_INDEXER_COMMIT=b4acdb8`. ClickUp `86eykx8jp`.
>
> ⚠️ The amendment does MORE than add O2: it can move an existing O2 **earlier**,
> widening every downstream `firstAtOrAfter` window. `DnExEYnZ` gained O3+O4+O6
> while gaining no O2. That cascade is why the total was 1125 and not the 375–750
> projected before measuring — **the dry-run is the only reason we knew.**
>
> **`TOKENS_XYZ_API_KEY`: staged on the VPS, auth scheme UNCONFIRMED** (tokens.xyz
> uses Clerk sessions or hashed platform keys per their repo docs; all four
> standard header forms 401). Enrichment is dormant by design and Jupiter is
> primary — **revisit only if Jupiter primary ever degrades.**
>
> ## SLICE 1 — `7d72d6f`, and why it mattered
>
> **A permissionlessly created market used to be unwritable for up to 60 minutes.**
> `/write`'s `volOracleBlock` gate stays shut until a `VolOracle` PDA exists, and
> the only thing that made one was `volOracleCrank`'s hourly pass, aligned to the
> wall-clock hour. `useVolOracleStatus.ts:19-22` claimed since W1 that an
> `onLogs(MarketCreated)` seeder already closed this — **it never existed**: the
> program emits no `MarketCreated` event and no listener was ever written. A
> comment describing work nobody did is why nobody looked again.
>
> **Shipped `7d72d6f`** (master + main): a fast-seed loop in the vol crank,
> `crank/volOracleFastSeed.ts`. Polls every 120 s, gated on
> `ProtocolState.total_markets` so a quiet tick costs ONE 123-byte
> `getAccountInfo` (measured 36 ms vs 627 ms for a sweep). Pyth-sourced markets
> only — SB creates are gated to the 23 curated feeds, all of which already have
> oracles, so SB markets are born writable and the reachable gap is exactly the
> non-curated set. **No program change.**
>
> **LIVE PROOF, founder-run, ORE 2026-08-11:** create `15:29:59Z`
> (`3hcKQLS2…w1kU`) → seed `15:31:53Z` (`5y1vtufs…`) = **114 seconds**. Heartbeat
> at the seed: watermark `475→476`, marketsSeen `31→32`, oraclesKnown `7→8`,
> seededTotal `0→1`, `swept=true`, next tick `swept=false`. Cadence unbroken
> across ticks 50–58, `failuresTotal=0`. Oracle `BBADwVqr…` born correct:
> `source=0`, `seed_vol=0.80`, `last_spot_price=$62.212987`, `sample_count=0` —
> **priceable from minute one.**
>
> **Idempotency is by STATE, not error string.** On any init failure the loop
> re-reads the PDA; if it exists we lost the race and that is a *success*. Only a
> still-missing PDA earns a backoff. A shared `inFlight` set stops the hourly pass
> and the fast loop both submitting for one feed.
>
> **Seeding is NOT price-free** — `initialize_vol_oracle` reads live spot on both
> arms (seed-at-birth writes `last_spot_price`/`last_sample_ts`, and
> `price_american` gates on spot+freshness *before* vol). So an equity outside
> NYSE hours is unseedable by physics, not policy; hence per-feed exponential
> backoff. Do not "optimise" the Hermes fetch out of this path.
>
> **VPS git was repaired the same day.** `/opt/opta-crank/.git` had 878
> root-owned objects; git as `opta` reported `fatal: loose object … is corrupt`,
> which is git's message for *unreadable*, not damaged. `chown -R opta:opta` on
> `.git` **and** on `crank/ app/ indexer/ writer/` (222 more entries). **STANDING
> RULE: git on that box runs as `opta`, NEVER root** — running it as root is what
> caused this. Still root-owned, deliberately: `taker/` (6197, live service),
> `mobile/`, `tests/`, `programs/`, `scripts/`, and two `.env.bak-*` secret
> backups. ⚠️ `git checkout HEAD -- indexer/` is **DESTRUCTIVE**: all 55 tracked
> indexer files legitimately differ from the enclosing HEAD `d1d0471` because
> `indexer/` is pinned at `OPTA_INDEXER_COMMIT=db4069e` via path-overlay. Always
> overlay `indexer/` at its intended ref.
>
> Rollback: `cp crank/volOracleCrank.ts.bak-slice1 crank/volOracleCrank.ts` +
> restart, or `OPTA_VOL_FAST_DISABLED=1`. ClickUp `86eykhx1g`.

---

# SESSION CLOSE — 2026-08-03 15:30Z, §4 §1 §2 REFRESHED 2026-08-10 (EPOCH 0 GO-LIVE EXECUTED · taker ARMED · bid widen DONE, cap bug FIXED)

> Written for a reader with ZERO session memory. **This block supersedes every
> block below it** where they disagree. It covers the EPOCH 0 launch: the weight
> freeze deploy, the public points API, the campaign UI, the bid-widen canary,
> and the taker arming. `indexer/GO-LIVE.md` §7 is the launch source of truth and
> was updated in the freeze commit; this block is the execution record.
>
> **The campaign is LIVE and user-visible at https://opta.fyi.** That is new.
> Everything below this block predates it.
>
> **LESSON (2026-08-10): a stale top block misled a whole session.** §4 still
> described the cap bug as open five days after `bfa8b0d` fixed, shipped and
> deployed it, so a fix session was planned to rewrite code that was already
> live and to flip flags already flipped. **Refresh this block at every session
> close — shipping is not documenting.**

## 1. What went live, in the order it was done

| # | Step | State |
|---|---|---|
| 1 | Frozen indexer build + schema v6 | **DONE** |
| 2 | `/api/points` exposed through nginx on opta.fyi | **DONE** |
| 3 | X bearer token consolidated | **DONE** |
| 4 | `VITE_EPOCH0_UI=1` — campaign UI public | **DONE** |
| 5 | Smoke with founder wallet | **PASSED** (founder-run) |
| 6 | Reply lane | already live since 2026-08-01; **no-op** |
| 7 | Bid widen 3→30 | reverted 2026-08-03; **redone 2026-08-05T14:01:45Z and stable since — see §4** |
| 8 | Taker armed | **DONE — armed and correctly idle** |
| 9 | Announcement | founder's, from his own account |

## 2. Live flag state — REFRESHED 2026-08-10 (was verified 2026-08-03 15:29Z)

```
OPTA_WRITER_BID_ENABLED=1     OPTA_WRITER_BID_MAX_CELLS=30   <- 30 since 2026-08-05T14:01:49Z
OPTA_TAKER_DRY_RUN=0          OPTA_TAKER_ARMED=1             <- ARMED
DRY_RUN=false  REPLY_DRY_RUN=false  REPLIES_ENABLED=true
OPTA_INDEXER_COMMIT=db4069e
```
All 8 units `active`, **`NRestarts=0`**. Indexer: schema **v6**, 133,786 txs /
127,291 events, 23 external / 7 internal wallets, `freeze --check` **9/9**.

## 3. The weight freeze is ENFORCED AT BOOT — read this before touching scoring

`rules-v1-frozen` (commit `c909506`) pins 9 artifacts by sha256 in
`indexer/src/score/FROZEN.json`. `score/frozenGate.ts` runs **first in `main()`,
before the DB is opened**, re-hashes each runtime artifact through
**`require.resolve()`** — the file Node actually loaded, not a path literal — plus
a deep-equal on `DEFAULT_RULES` and both version strings. Any mismatch logs
`SCORE_WEIGHTS_DRIFT expected/actual` and **refuses to start**.

**Consequence: you cannot edit a scoring file and restart.** The service will not
boot. The loop is: edit → `npm run build` → `node dist/scripts/freeze.js --tag <t>
--at <ISO>` → `npm run build` again (so dist carries the manifest) → `--check` →
recompute 3× and diff. A tag alone was never enough: `indexer/dist/` is gitignored
and the VPS deploy is a path-overlay into a checkout whose HEAD is a different
commit, so the bytes that score the campaign are in no commit.

`db4069e` fixed a defect caught during the deploy: `/stats` published the **dist**
hash under the `quests_sha256` label because `frozenSummary()` matched with
`endsWith`, and `indexer/dist/src/score/quests/quests_v1.json` also ends with
`src/score/quests/quests_v1.json`. Anyone verifying the source file against the
published value would have concluded the freeze was broken. `frozenGate.ts` is
deliberately not one of the 9 pinned artifacts, so no frozen hash changed.

**Two ops facts worth keeping:**
- `MemoryMax` was raised 200M → 512M via a systemd drop-in
  (`/etc/systemd/system/opta-indexer.service.d/memory.conf`). This was
  load-bearing, not precautionary: RSS was 151M at deploy and is **277M at
  close**. The old 200M cap would have OOM-killed the service.
- Rollback for the whole of step 1 lives in `/opt/opta-indexer/snapshots/`:
  `points.db.pre-v6-20260803T111327Z` (cold, consistent, verified v5 /
  integrity ok / `wallet_points` absent), `indexer-dist-src.pre-freeze-*.tgz`,
  `.env.pre-freeze-*`. **The v5→v6 migration is one-way.**

## 4. ✅ FIXED — bid notional caps bind. Widen is DONE and stable at 30 cells.

ClickUp **`86eygtf17` — CLOSED.** Fixed at commit **`bfa8b0d`** (2026-08-05),
deployed, and running. **Everything this section used to instruct is done.**

`writer/src/engine.ts` now seeds `globalBidNotional` and `perAsset` from the same
`myBids` that already seeded `liveBidCells`, via `seedLiveBidExposure()` in
`writer/src/bids.ts`. The asymmetry that WAS the bug is gone. Every tick emits
**`bid-exposure-seed`** carrying the live set it seeded — that line is both the
operator's proof the caps are live and the correct measurement instrument for any
future canary. Gated by `bids.test.ts` "gate 10" (5 tests).

**Verify the running code by HASH, never by the checkout SHA.** `/opt/opta-crank`
git HEAD reads `d1d0471` with ~129 dirty files and is **misleading** — the fix was
applied as working-tree edits. The deployed sources are byte-identical to
`bfa8b0d`:

```
engine.ts b5e9457657e1 · bids.ts 1b887c6c68eb · shadow.ts b747481794e6 · cancel-bids.ts 5cb4b74e9b6c
```

Runtime proof: `bid-exposure-seed` fires every tick; taker logs `armed-tick`
(60/h) and `shadow-tick` **0**, so §4 item 4 is also shipped.

**24h canary readback (2026-08-10)** — measured from `bid-exposure-seed`, i.e.
the live set, never summed posts:

| gate | result |
|---|---|
| 0 crosses | `would-cross` **0**; 172 posts / 172 pulls over 3h |
| ≤ $250 / asset | peak **XAU $244.52**, ETH $125.05, SOL $51.52, rest < $1.10 |
| ≤ $2,500 global | peak **$415.88** |
| quote-failure flat | **3.89/tick** (3h) vs **4.00/tick** (24h) — normalized by tick count |

Caps **bind**, not merely go unbreached: `asset-cap` fired once in 3h holding XAU
under $250, and global notional is flat at ~$413.4 across 3h with no tick-over-tick
ratchet. Pre-fix it grew by up to a full cap per tick.

**MEASUREMENT TRAP — still true, still do not repeat it.** Summing `bid-post-ok`
notionals overstates exposure (it read BTC $671 and falsely flagged XAU). Measure
**concurrent** exposure. The easy way now is to read `bid-exposure-seed` directly;
the manual way is replaying `bid-post-ok`/`bid-pull-ok` in timestamp order against
the order pubkey.

**TWO CORRECTIONS to what this section used to instruct:**

1. **Cycling `OPTA_WRITER_BID_ENABLED` 0→1 does NOT retire bids.** The flag is
   INERT by design — `bidPass()`: *"disabled means this pass does nothing at all —
   it does not even sweep resting bids."* Old fix-step 1 was wrong and would have
   reported a retire that never happened. **Retire with
   `writer/src/tools/cancel-bids.ts`**, added in `bfa8b0d` for exactly this.
2. **The 30 over-cap canary bids are GONE.** Live set is 30 bids / **$413.50**
   with **BTC absent entirely**, vs the incident's 30 / $687.08 with BTC $375.96.
   The board turned over under the fixed caps; the NO-DRAIN decision held and no
   drain was ever needed.

**FLAG LEDGER — `BID_MAX_CELLS`**, reconstructed 2026-08-10 from the `/opt/opta-writer/.env`
snapshot chain (`cp -a` preserves mtime, so each backup carries the value live at
its timestamp). Ledgered late; journald only retains from 2026-08-08, so this
chain is the trail.

| when (UTC) | cells | note |
|---|---|---|
| 2026-07-29 18:53 | 3 | first bid canary, `enabled=1` |
| **2026-08-03 12:25:23** | 3 → **30** | Aug-3 canary hour — found the cap bug |
| 2026-08-03 ~14:14 | 30 → 3 | post-canary revert |
| 2026-08-05 11:30 | 3 | pre-drain |
| 2026-08-05 12:52 | 3, `enabled=0` | drain window |
| **2026-08-05 14:01:45** | 3 → **30** | **current state**, set in the `bfa8b0d` session |
| 2026-08-09 18:51 | 30 | untouched by the Helius key rotation |

`BID_MAX_CELLS=30` has been continuously live since **2026-08-05T14:01:49Z** —
~5 days at time of writing, covering the 24h readback above.

## 5. Canary hour — the three named gates PASSED

12:25:43Z → 13:26:00Z at 30 cells. **0 crosses** across 71 posts (`bidPrice <
askResting` every time, 962–2,343 bps below ask). **0 fills** board-wide.
Quote-failure **flat**.

**Gate 3 nearly failed on an artifact — remember this.** The raw heartbeat read
`quoteFailed: 260` against a 245 baseline: z = **+4.62** against a 24h band of
240–245, which reads as an alarming regression. It is not. That heartbeat covered
`ticksSinceLast=13`, not 12, because the restart shifted tick alignment.
Normalised, 260/13 = **20.000 failures/tick** against a 24h mean of 20.035 and sd
0.090 → z = **−0.39**, exactly the baseline rate. The only genuine per-tick outlier
in 24 hours is the *pre-flip* 12:23 reading. **Always normalise heartbeat counters
by `ticksSinceLast` before comparing them.**

## 6. Taker is ARMED and correctly idle

Boot marker 15:17:28Z: `mode:"ARMED" dryRun:false armed:true registered:true`,
band 500/5000 bps, budgets wallet $250/d, global $2,000/d, float $10,000, per-fill
$100, OI $2,500; balances 7 SOL / $10,000 USDC.

**It takes TWO flags, not one.** `taker/src/env.ts:10` — *"A fill requires
DRY_RUN=0 AND ARMED=1. One flag would mean one typo."* Setting `ARMED=1` alone
leaves it inert while looking armed.

`registered:true` means the in-code arming preflight passed: `taker/src/main.ts:270`
`fatal`-exits if the taker's own wallet is not in the indexer's
`INTERNAL_WALLETS`, so a forgotten registration stops the bot instead of poisoning
the tape. Verified on a fresh recompute: `taker-bot FeQnyJpy…5N7p` `is_internal=1`.

**No fill has landed, and that is correct.** Every tick: `scanned 454`,
`skipped.internal_owner: 453`, `settled: 1`, **`eligible: 0`**. The entire ask
board belongs to the writer bot, and `identityGate` (`taker/src/eligibility.ts:200-207`)
rejects internal owners before a quote is even paid for. The armed taker is
refusing to trade with the treasury 453 times a minute. **The first real fill
needs an external user to post an ask** — which is what the campaign exists to
produce. Do not manufacture one to tick a box.

## 7. Rollback levers (all one command, all verified present)

| surface | lever |
|---|---|
| campaign UI | `vercel env rm VITE_EPOCH0_UI production` + redeploy |
| points API | `cp /etc/nginx/sites-available/opta.fyi.conf.bak-pre-points … && nginx -t && systemctl reload nginx` |
| taker | `cp /opt/opta-taker/.env.bak-pre-arm-20260803T151724Z … && systemctl restart opta-taker` |
| writer bids | `/opt/opta-writer/.env.bak-pre-bidwiden-20260803T122523Z` (pre-flip), `.env.bak-post-canary-*` (pre-revert) |
| X token | `/opt/opta-tweet/.env.bak-pre-xshare` + `.service.bak-pre-xshare` |
| indexer | snapshots dir, §3 |
| MemoryMax | `rm /etc/systemd/system/opta-indexer.service.d/memory.conf && systemctl daemon-reload` |

## 8. Corrections to standing docs

- **GO-LIVE §2 is now wrong about rotation.** The X bearer token has exactly
  **one** live consumer, `/etc/opta/x-read.env` — not three. `/opt/opta-crank/.env`
  does not contain it. The only other hits are five historical
  `/opt/opta-tweet/.env.bak*` files, all 0600 root-only; prune the four predating
  2026-08-03 after launch week.
- **`app/.vercel/project.json` names the wrong project.** It says
  `butter_options_app`; `opta.fyi` and `opta-solana.vercel.app` are both served by
  project **`opta`**. Setting env on the wrong project silently does nothing.
- Indexer tests and scripts must run **from WSL** — `indexer/node_modules/better-sqlite3`
  is a Linux binary and Windows node cannot load it.

## 9. Queued next

1. **Bid cap fix session** (§4) — blocks any further widening.
2. Watch for the first external ask; that is when the armed taker gets its first
   real exercise, and when `bidMaxLongPerSeries=10` binds for the first time ever.
3. Campaign day-1 watch: faucet SOL burn (351 claims banked), writer SOL burn
   (~5 SOL/day, 12.9 SOL at close), `/opt/opta-tweet/mentions-flagged.md` (3
   unactioned founder flags), `replies.md` daily read.
4. GO-LIVE §7 still-open items: publish the rules page (it can now cite
   `rules_frozen` from `/api/points/stats`), decide D12 backdating, keep internal
   wallets excluded.

---

# SESSION CLOSE — 2026-07-31 14:05Z (opta-tweet arc CLOSED · both loops LIVE · postReply unverified)

> Written for a reader with ZERO session memory. **This block is SCOPED TO
> `opta-tweet` only.** It supersedes every earlier statement about the X bot.
> It says NOTHING about the protocol side — the 2026-07-24 block below remains
> authoritative for grid/keeper/3012/crossbar, all of which this session did not
> touch. The 3012 strand fix and T2 are unaffected.

## 1. What opta-tweet is and where it lives
Standalone **private** repo `github.com/nankolib/opta-tweet` — **NOT** the opta
monorepo. Deployed at `/opt/opta-tweet` on the crank VPS (144.202.58.6), systemd
unit `opta-tweet.service`, code at **`6b22f30`**. Local clone:
`D:\claude everything\opta-tweet`. One process, **two independent loops**.

VPS git gotchas (cost time this session): the clone has **no `credential.helper`**
despite `/root/.git-credentials` existing → set `git config credential.helper store`
per repo; and **no upstream tracking branch** → use
`git fetch origin main && git merge --ff-only origin/main`, not `git pull`. There
is **no `sqlite3` CLI** on the box; query `data.db` via node + better-sqlite3, run
from `/opt/opta-tweet` or the module won't resolve.

## 2. BOTH loops LIVE as of 2026-07-31 13:56Z
**Posting loop** — `DRY_RUN=false`, 4 posts/day on jittered slots, content-engine
v3 analyst scope: flow-read/vol-structure 30, market-pulse 20, markets-almanac 15,
tokenization-transition 15, mechanics 10, protocol 10. Weekend = crypto-only mode
(equity lanes disabled, stale tape).

**Reply loop** — `REPLY_DRY_RUN=false`, mentions timeline polled every 12 min with
a `since_id` cursor in sqlite. Caps: **10 replies/day, 2/user/day, 1/thread
all-time**, 40 reply model calls/day (metered SEPARATELY from posting's 30 so a
mention flood cannot starve posting), 300 mention-reads/day → pause + ALERT until
UTC rollover. Pipeline: code prefilters → code injection check → classify → draft
→ guardrails → post.

## 3. OPEN ITEM — FIRST THING NEXT SESSION
**`postReply()` has NEVER executed against the live X API.** Shadow mode could not
exercise it by construction, so the one path that has never run is the one that
now runs unattended. Everything else is proven; this is not.

**Verification:** founder reply-baits any bot tweet posted **after 2026-07-29**
(earlier tweets have no stored `tweet_id` → resolve `context_missing` → IGNORE),
then within ~12 min:
```
ssh root@144.202.58.6 'tail -n 5 /opt/opta-tweet/replies.md'
```
PASS = a `replies` row with `status=posted` and a **non-null `tweet_id`**.
On failure the per-mention try/catch logs and the loop stays alive, so check
`journalctl -u opta-tweet` — silence is not proof of health.

## 4. Rollback levers (both = edit `.env` + `systemctl restart opta-tweet`)
- **Soft:** `REPLY_DRY_RUN=true` → replies draft to `replies.md` only; posting
  loop unaffected.
- **Hard:** `REPLIES_ENABLED=false` → mentions loop never starts. No polls, no
  reads, no spend.

## 5. Founder inbox — 3 flags PENDING ACTION
`/opt/opta-tweet/mentions-flagged.md` — the bot **never** auto-replies to these.
Currently 3 unactioned: 2 partnership/BD approaches (@nanko1goatit re self-writing
options vaults, @142C_) and 1 media request (@ownershipfm, Ownership Radio #21).
FLAG covers token/airdrop/listing/price, partnership/BD, press, bug reports,
distress/legal/harassment.

## 6. Daily reads
```
ssh root@144.202.58.6 'tail -n 20 /opt/opta-tweet/replies.md'
ssh root@144.202.58.6 'tail -n 20 /opt/opta-tweet/mentions-flagged.md'
```
**`shadow.md` is DEFUNCT for judging posts** — posting has been live since
2026-07-24, so it is a duplicate log, not a review queue. Read `replies.md`.

## 7. Queued next
- **Exemplar corpus from founder** — hand-written reference posts for voice tuning.
- **Detector-mining pass** — GEX, sweeps, max-pain from the OpenBB /
  SmartMoneyTracker references, to widen `detectors.ts` beyond the current five.
- Protocol side (3012 strand, T2) **unaffected** by this arc.

## 8. Corrections / learnings worth persisting
- **TWO-FLAG SCHEME — never conflate.** `DRY_RUN` gates **posting**;
  `REPLY_DRY_RUN` gates **replies**. They are independent by design so one can be
  live while the other is in shadow. Setting `DRY_RUN=1` to "stop the bot
  replying" would silence the live posting loop and not touch replies at all.
- **Forward-only `tweet_id` + cursor = NO retro-replies, ever.** `since_id`
  advances past every mention whether or not it produced a reply, so anything
  drafted in shadow is permanently behind the cursor (rows stay `status=shadow`,
  `tweet_id` NULL). The two shadow drafts (@Butter4sol 07-29, @AmdfxfastMark
  07-30) will never post. Corollary: mentions replying to tweets from before
  2026-07-29 resolve `context_missing` and are IGNOREd.
- **X API is pay-per-use — links cost ~13×.** $0.015/post vs **$0.20 with a URL**,
  $0.005/read. Guardrails reject URLs partly for this reason. Polling costs reads
  **even in shadow mode** — shadow is not free.
- **A monitor that has never seen a nonzero signal is not proven** (same lesson as
  the dark keeper, §3 of the 2026-07-24 block). `postReply()` is currently exactly
  that.

## 9. Close numbers (opta-tweet)
Shadow ran 07-29 → 07-31: **26 mentions → 21 IGNORE / 3 FLAG / 2 ANSWER**, zero
errors, zero injection attempts on real traffic. Tests **34 → 64** (+30). Caps at
go-live all fresh for UTC day 07-31: 0/10 replies, 0/40 model calls, 0/300 reads.
ClickUp: `86eyez7p1` (shadow), `86eyfw5ud` (LIVE), `86eyfw85c` (arc closed).
Spec: `docs/superpowers/specs/2026-07-29-reply-engine-design.md` in the
opta-tweet repo.

---

# SESSION CLOSE — 2026-07-24 11:10Z (grid cross-day PROVEN · trigger keeper live · 3012 strand fixed · crossbar blocker)

> Written for a reader with ZERO session memory. **This block SUPERSEDES every
> block below it** where they disagree; older blocks remain as history. Anything
> not re-stated here (RULE 1/2/3, monitor inventory, rent-reclaim backlog) is
> still live.

## 1. Grid cross-day reuse — PROVEN under stress (combined acceptance PASS)
The absolute equity strike grid (`ladder.ts`, commit `f7067a1`) faced its first
real cross-day open on a **−13% down day** (TSLA −13.4%, GOOGL −8.5%, every
ticker red). All 13 posted 20/20, **zero unattributed mints**: 4 tickers FULL
REUSE (0 new strikes), the rest edge-slides matching verified ≥1-gridStep moves,
and **MSTR tier-migrated $100→$92.5 grid** (crossed below $100, step $5→$2.5) —
the pre-authorized exception, not a failure. 18 new strikes → shells +42 (30
reused), vs ~260 under the old spot-relative regime = **~84% mint reduction on
the worst-case day**. ClickUp `86eyd3z9g`.

**Meme board stable overnight:** JUP/JTO/WIF repriced all night (hysteresis
damping, 0 oracle-stale skips), sc climbed 67→86, all fresh. **BONK still
parked** — its ~$3.1e-6 dust price collapses all 5 ladder rungs to the same
micro-USDC strike (`toUsdcBN`≈3) and rounds premiums to zero → posts rejected,
no post-ok/no error. Needs a scaled-strike fix (parked).

## 2. Trigger keeper arc — LIVE as its own service
`opta-trigger.service` (own systemd unit, gas wallet `5sHZETYz`, 15s) is now the
**sole keeper**. Arc: SB arm (`b94a824`) + standalone entry `triggerCrankMain.ts`
(`9c2fbdf` — the committed unit pointed at a library with no main guard) +
**within-tick fire retry** (`61d23e0`, bounded fresh-quote loop + `classifyFire-
Error`: gateway=retry, Custom program error=terminal). Deployed SB=1, then live.
Recon: 7 Pyth (all off-board FX/commodity) vs **24 SB** (the whole board), 0
pre-existing TriggerOrders.

**Canary armed, standing acceptance test:** `3o7nTTM8…` StopEntryBuy XRP ≥1.05,
$100 in vault `2gjf5cyH…` + $2 escrow (**both recoverable**; founder DnExEYnZ
−$102, minted 0). Detects/evaluates/passes-margin/attempts-fire cleanly; **fires
the instant crossbar serves a gateway** (see §6). ClickUp `86eyddbfk`.

## 3. THE LESSON (record verbatim)
**The keeper was dark for three stacked reasons — the SB skip, vault-counterparty
liquidity, and no fire retry — and each fix exposed the next. Dark systems hide
failures in layers.** A system that "exists and is deployed" but has never
actually run its full path end-to-end is not proven; it is a stack of untested
assumptions that reveal themselves one at a time only when you force it live.

## 4. Phase B scoped — book-path fire for ALL trigger kinds
The live board is **WriterAsk/book-based** (collateral escrowed per-ask), but
Phase-4 triggers fire through the **vault counterparty** (`fill_vault_peg` /
`exercise_american`) — and **no vault on the board has payout collateral** (1,866
live vaults, 2 funded, both drained). So **both** existing trigger kinds are
structurally unfireable on real liquidity, not just the deferred StopLossSell.
Phase B = route every trigger kind through the book (`fill_order` Bid fill is the
stop-loss exit; `OrderKind::Bid` is live), with the authority-fork + delegate-at-
arm pattern Phase 4 already proved. Proposal is the next deliverable.

## 5. 3012 strand storm — FIXED (noise, not capital)
The ~90/hr `writer-strand` (0xbc4 = 3012 AccountNotInitialized on reprice-cancel)
was a **false alarm**. Work-list is **re-derived per tick** (fresh
`enumerateMyOrders`), NOT a persistent queue → it's a **within-tick race** (proven:
two 30-min windows, 78 vs 73 stranded, **ZERO overlap**): an order swept mid-tick
is cancelled from a now-stale list. Closed orders already returned their escrow →
nothing stranded. Fix (`b0258eb`): existence pre-check before the cancel +
3012-on-send classified terminal-benign (`pull-noop-gone`, no alert/retry); a
genuine failure on a LIVE order still strands. Post-deploy: **~90/hr → 0**
(pull-noop-gone 5, pull-ok 5, real cancels unaffected). Gates 48/0 + strand 6/6.
ClickUp `86eyddwnk`.

## 6. OPEN BLOCKER — Switchboard devnet crossbar gateway outage (escalated to Jack)
The self-hosted crossbar (`localhost:8080`) devnet gateway list is **empty ~95%
of the time** (curled empty 5/5 over 20s). It is now failing **ALL** oracle
pushes (`feedsSupported:23` but `feedsPushed:0 / feedsErrored:23`), and it blocked
the canary fire 78/78 with "No gateways available for network: devnet". NOT a
keeper bug (code byte-identical to the crank; retry correct) and NOT a total
outage (the crank catches rare brief windows by flooding — 8 attempts × 23 feeds/
tick; ~1 XRP push/10min). **Board stales fail-closed toward the 6h freshness gate;
self-heals on recovery.** Both the canary AND board oracle freshness are gated on
this single external dependency. Escalated to Jack.

## 7. Close numbers
shells **1819**, SOL **31.025**, free USDC **$1,455,136** (a +$1.29M external
funding event landed overnight Jul-23), board **90** non-equity (equities repost
13:30Z). Three services active (opta-writer, opta-crank, opta-trigger); the crank
trigger side-loop was retired this session (`OPTA_TRIGGER_CRANK_DISABLED=1`),
leaving opta-trigger the sole keeper. shells/h ≈ 0, burn/h ≈ 0, strand 0.

## 8. Next queue (priority order)
1. **Phase B proposal** — book-path fire for all trigger kinds (§4).
2. **Wave-3 commodities** — XAG + oil, behind Phase B.
3. **BONK dust-fix** — scaled-strike for sub-cent assets (parked).
4. **Aug-7 sweep** — now also reclaims **grid-transition orphans** (old roundSig-
   strike vaults abandoned when equities moved to the grid) + the daily orphans.
5. Gated on §6 recovery: canary auto-fire verification + confirm oracle pushes
   resume board-wide.

---

# SESSION CLOSE — 2026-07-21 20:30Z (DAY CLOSE — churn v2 + funding + equity board)

> Written for a reader with ZERO session memory. **This block SUPERSEDES the
> 11:40Z §1–7 block and the Wave-2 addendum below it** — both remain as history,
> but where they disagree with this block, THIS block is current. Anything not
> re-stated here (rent-reclaim backlog, RULE 1/2/3, monitor inventory) is still
> live from those sections.

## 1. CHURN V2 — the day's headline. Fixed and PROVEN.

**Root cause (do not re-diagnose).** The strike-hysteresis deadband was anchored
to `roundSigStep` — the 3-significant-figure **display-rounding quantum** — while
ladder rungs are spaced at **5% of spot** (`STRIKE_MULTIPLIERS`). Two consequences:
the band was **8×–53× narrower than one rung**, and its width *as a fraction of
spot* swung ~10× with the leading digit of the price (a mantissa accident: SOL at
77.87 → 0.096% of spot; XRP at 1.1489 → 0.653%). So any ordinary ~0.1% drift
re-centred the BTC and SOL ladders, minting a **new series + vault per rung at
~0.0201 SOL of PERMANENT rent**. v1's ε-skip fixed only the *age*-triggered
reprice path; the strike path was never gated in economically meaningful units.

**Fix (commit `9701eec`, live):**
- Band = `HYST_FRAC(0.5) × RUNG_FRAC(0.05) × spot` = **2.5% of spot**, scale-free
  and identical on every asset. `roundSigStep` no longer touches the band.
- **Per-expiry anchors** — `existingStrikesFor` is keyed by expiry and
  `stickyStrike` moved inside the tenor loop. A monthly-only anchor used to
  satisfy a weekly target, report "kept", and then mint anyway because the series
  PDA is `(market, strike, expiry, side)`.
- **Pre-mint budget gate** — free USDC is re-read immediately before ANY init ix;
  insufficient ⇒ `usdc-budget-skip`, never mint-then-strand.
- **Boot marker** now carries `churnFix:"v2"`, `hystFrac`, `bandPctOfSpot`,
  `bandAtBoot` — closes the RULE-1 gap where v1 shipped with no assertable marker.

**Proof (17:00Z→20:00Z, 379-cell board):** shells **1107 → 1111 = +4 = 1.33/h**
(kill threshold 30/h); burn **0.029 SOL/h** (threshold 1.5/h); strand **0**.
Normalised **0.0000765 SOL/h/cell** vs **0.0080** pre-fix at 119 cells ⇒ **~100×**.

**⚠ orderPk overlap is RETIRED as a metric.** It measured 20–36% all evening,
which looks bad and is meaningless: every reprice mints a **new `RestingOrder`
PDA** because the nonce is the timestamp, so pubkeys rotate on ordinary
repricing even when the series is reused (and the cancel refunds that rent).
The pre-fix signature was 0% overlap *coinciding with a shells jump*.
**Judge the writer on `shells/h` and `burn/h` only.**

Harness `writer/scripts/_ladder_repro.ts` (offline, imports the real code paths)
reproduces flip thresholds on live spot: v1 flipped BTC/SOL at ±10–20bp, v2 flips
all six assets at ~±2.3–2.8%. Writer suite **37/37**.

## 2. FUNDING STOP — EXECUTED

- **SOL:** +25 founder `DnExEYnZ…` → writer, sig
  `WGpbtEoBHenLo76aw5vJKn8PTGRr91ffftstxGmz8UMEs4CWrEy6T8QGf12oaWLBsBdFyoip68WDH46Xc5xb71n`.
  (An earlier +20 landed at 13:33Z, sig `2fgXsWGf…`.)
- **USDC:** +$550,000 admin mint (founder-executed), sig
  `5hkJZU59tVH8ZtaJaaiFCkV3dXokwa7cvudGKao8CXAnjycsS5XehNnUbcsRfP8hvzG3Wa76iYofUY2g8oDfy1nq`.
- **Peak board 379 cells** (119 crypto + 260 equity), **$2,061,801.33 locked**.
  Conservation exact to the cent:
  `free 163,196.528 + locked 2,061,801.33 = 685,694.128 + 1,539,303.73`.
  Census tool: `crank/_probe_locked_usdc.ts`.

## 3. EQUITY LIFT — and a LANDMINE that is still armed

`EXCLUDE_CLASSES` **cannot be emptied on the running build.** `Number("") === 0`
and `Number.isFinite(0)` is true, so an empty *or removed* variable parses to
**`[0]`** — silently deny-listing asset_class 0, i.e. the entire live crypto
board, at the exact moment an operator tries to CLEAR the denylist. (`assetsExclude`
never had this bug — it uses `.filter(Boolean)`.)

- The live writer runs the **sentinel `OPTA_WRITER_EXCLUDE_CLASSES=99`** (a class
  that does not exist ⇒ excludes nothing). **DO NOT "correct" the 99.**
- `parseClassList` fix + 7 regression tests shipped in **`656a743`** but the
  running process is on **`9701eec`**, so the fix is **NOT live**.
- **Order of operations:** next *deliberate* writer restart picks up `656a743`;
  only THEN may `.env` be emptied. Not before.

## 4. CANCEL-AT-CLOSE IS DESIGN — corrects an earlier expectation

At **20:04Z the writer pulled all 260 equity asks with `reason:"market-closed"`**,
releasing **$396,941 USDC and +0.79 SOL** of order/escrow rent. This is NOT an
anomaly: `engine.ts:231-239` deliberately pulls off-session equity asks *"so it
can't be filled at a stale off-hours price"*, and `engine.ts:196-198` names the
**cancel-at-close / repost-at-open** cadence explicitly. An earlier session note
expecting equity asks to "rest untouched" overnight was wrong.

**Series PDAs persist, so the repost mints NOTHING** — the reuse path
(`engine.ts` `needSeries`/`needVault`) skips both inits when the PDA exists.

**⇒ TOMORROW 13:30Z VERIFICATION: expect 260 reposts across 13 tickers and
shells FLAT.** If a ticker fails to repost, the first suspect is **MSFT logging
`oracle-not-initialized, samples:0` at 20:10Z** (rather than `oracle-stale`) —
noted, not investigated.

## 5. WAVE-2B — SPCX + HOOD live

Pure births, `asset_class=2`, `oracle_source=1`, feedHash byte-matched, seed
read back exact, `sample_count=0` at birth then **both sampled ≥1**.

| | market PDA | vol oracle PDA | seed |
|---|---|---|---|
| SPCX | `7hVcCiJfESuKEL1EzfsHJshuNRqgjMUsq3iUAUWxfiTS` | `DMxHh7yMzbQ6Q6WQBzvtZsbYRPsx3cCKeeDCE5NLZ4Se` | 1.00 |
| HOOD | `C6ge3zpmchKzdTtyduyE2zJd6ipycvurNquzkMEbMpQL` | `ErFJZnemkXBTqc3D66LVTCycuQzZApxFxyvjxsqSLXZp` | 0.65 |

Equity board **13 tickers**; crank boot marker **`supported:19`** (6 crypto + 13
equity). Crossbar STORE passed the 4-gate chain (GUARD1 local == locked → STORE →
GUARD2 server == local == locked → RESOLVE jobs=2 → LIVENESS 2 sigs + ed25519).
`get_option_price` SANE: SPCX `vol_used = 100.00%` === seed, spot $125.30 vs live
$125.18, premium $14.6407 in band.

**The locked manifest hashes are now REPRODUCIBLE IN-REPO** — `crank/_equity_feed_hashes.ts`
re-derives all 13 byte-exact (they previously existed only as prose literals).
Gates: `_verify_registry_hashes.ts` **19/19 parity, 13/13 resolvable**;
`_probe_wave2_verify.ts` **ALL 13 VERIFIED**.

## 6. FRONTEND — three fixes, live on opta.fyi

- **13-ticker registry.** `assetDisplay.ts`'s hardcoded `EQUITIES` set lagged at 6,
  so 8 tickers grouped under "Other" in the Trade dropdown / Write selector.
  Markets **tabs were already correct** — they key off the on-chain numeric
  `asset_class` (`marketsView.classToTab`), a separate path.
- **BOOK DEPTH stat.** Writer-ask escrow was invisible: **$2.099M escrow vs
  $3,013 vault TVL**. Now its own header cell + inspector stat, derived from the
  existing batched `fetchBook` (one `getProgramAccounts`, zero new RPC).
  **These are different claims — never merge them into one TVL number.**
- **ACTIVE MARKETS 1198 → 384.** It was counting every unexpired vault ever
  minted, including ~1,100 churn shells. Now filtered to tradeable (≥1 resting
  ask OR open interest). `underlyings` uses the same filter for consistency.

Gate: `scripts/check-equity-registry-depth.mjs` — 8 browser-context checks,
passing locally AND in remote mode (`GATE_BASE=https://opta.fyi`).

## 7. RECORD CORRECTIONS (earlier notes were wrong)

- **Crypto sampling is HOURLY (60 min ±1), not "~30-min".** Measured across 12
  consecutive ticks and corroborated by `sample_count` +16 over 16h. The
  "~30-min main push loop" in older blocks is wrong. Successful pushes land in
  the **mid-hour retry at ~:13–:15**; the hourly warming tick still errors
  (`packEd25519Ix`, pre-existing, not service-affecting).
- **JUP / JTO / WIF / BONK are NOT in the crank SB registry.** `supported:19` =
  6 crypto + 13 equity. They log `oracle-stale, samples:67` and are skipped, so
  the **crypto board ceiling is 120 (6 × 20), not 180.** Re-registration is
  tomorrow's arc.
- **Equity off-hours behaviour** — see §4; asks are cancelled by design.
- Equity stale-retry noise does **not** delay crypto sampling: the warming tick
  grew 124s → 189s but finishes ~10 min before the crypto push window. A
  market-hours gate on the crank stays LOW priority (log spam only).

## 8. STATE AT CLOSE (2026-07-21 20:30Z)

| | |
|---|---|
| writer | `9701eec` (churn v2), up since 16:48:28Z, RSS ~57M/350M |
| board | **118 asks, crypto only** (equities cancelled at close, by design) |
| shells | **1111** · SOL **43.8128** · free USDC **$562,042.388** |
| writer `.env` | `MAX_CELLS=470`, `ASSETS_EXCLUDE=SBXAU` (**forever**), `EXCLUDE_CLASSES=99` (sentinel) |
| crank | `supported:19`, RSS ~168M/400M, HEAD `d1d0471` + surgical Wave-2b paths |
| kill-watch | **self-terminated 20:07:46Z** — no session-owned pollers survive (§6 holds) |

Leftover file `/opt/opta-writer/killwatch.sh` is inert (not scheduled, not running).

**T4 read ~07:00Z is now pure verification off the 20:00Z baseline**, and it is
**crypto-only overnight** (equities are cancelled until 13:30Z). Expect shells to
stay at 1111 and burn to stay ≈0.03 SOL/h.

## 9. TOMORROW'S QUEUE (in order)

1. **07:00Z T4 read** — shells/h + burn/h off the 20:00Z baseline (crypto-only).
2. **13:30Z repost verification** — 260 reposts across 13 tickers, shells FLAT;
   watch MSFT (§4).
3. **Deliberate writer restart** — folds in `656a743`, then drop the `=99`
   sentinel from `.env` (in that order, never before).
4. **Meme re-registration arc** — JUP/JTO/WIF/BONK back into the SB registry,
   crypto board 120 → 180.
5. **Exchange build resumes** thereafter.

**Aug-7 void-sweep unchanged** (rent reclaim on settled writer-ask vaults; the
shell count is now ~1111, so the reclaim is materially larger than the earlier
~3 SOL estimate). FE dropdown/registry + book depth are already live — nothing
queued there.

## 10. TODAY'S COMMITS (in order) + checkpoints

| sha | what |
|---|---|
| `5e2ed5e` | wave-2b: register SPCX+HOOD feeds (locked manifest) |
| `93025a2` | wave-2b: extend gates to 13 tickers |
| `94b0ad6` | wave-2b: birth/mint defs + gop probe refs |
| `973bc99` | tooling: writer locked-USDC census probe |
| `cea9e11` | tooling: ladder hysteresis repro harness |
| `9701eec` | **writer churn v2** — rung-fraction hysteresis + per-expiry anchors + pre-mint budget gate |
| `1f64b1f` | fe: 13-ticker equity registry + writer-ask escrow in market depth |
| `9f170bd` | fe: gate supports GATE_BASE for post-deploy verification |
| `306d817` | fe: active-markets counts tradeable markets, not lifetime mints |
| `656a743` | **writer: excludeClasses parse fix** — empty/missing env ⇒ `[]` not `[0]` (NOT live) |

ClickUp (Opta › Engineering, list `901818332352`): `86eyc7rfn` Wave-2b live ·
`86eyc8m0x` churn v2 live · `86eyc9cef` funding STOP + equity board.

---

# SESSION CLOSE — 2026-07-21 11:40Z (writer/market-maker session)

> Written for a reader with ZERO session memory. Everything below is current as of
> the timestamp above. Older sections further down remain valid history.
> **SUPERSEDED by the 20:30Z day-close block above** — retained as history.

## 1. What exists now: the `opta-writer` market-maker bot

Autonomous devnet MM that keeps the board quoted. Per live, quote-ready market it
writes a canonical American series + 0-pool vault and rests a **WriterAsk**.
**Write-only** — it posts/cancels, never fills, so the 6014 self-trade guard is
unreachable. A future taker bot MUST use a different wallet.

- Code: `writer/` (standalone tsc→dist, Node 20). On `main`.
- VPS `144.202.58.6`: code at `/opt/opta-crank/writer` (co-located so the IDL path
  resolves), systemd `opta-writer.service` (User=opta, MemoryMax=350M, RSS ~35MB).
- Config: `/opt/opta-writer/.env`. Keypair `/opt/opta-writer/secrets/writer-keypair.json`
  (VPS-only, chown opta, never in chat/repo).
- **Wallet `HgafDv195BtNc8X4uvNoRuGcUra5PuUwDJgHeKHvgFiS`** — gas+USDC only, no authority.
  Funded by founder (SOL via devnet faucet; USDC minted by admin `5YRMuuoY`).

### Live state at close
`orders: 20 · sol: 7.811 · freeUsdc: $1,634,994 · shells: 657`
Config: `ENABLED=1`, `ASSETS=` (empty ⇒ **full board**), `ASSETS_EXCLUDE=SBXAU`,
`EXCLUDE_CLASSES=2,4`, `MAX_CELLS=15`, `TICK=300s`.
Board is *intentionally* small: cap 15 blocks new posts, so it shed the pre-fix
off-ladder backlog (120 → 76 → 20) without reposting. This is expected, not a fault.

## 2. In-flight / unfinished

**a) Churn fix is deployed but only HALF-PROVEN.** Commit `d1d0471`, 12 unit tests.
- *Reprice ε-skip*: **PROVEN working** — 236 skips/hour observed, each an avoided
  cancel+repost pair. Only the AGE path is ε-gated (1%); drift reprices never skip.
- *Strike hysteresis*: **NOT yet proven.** With `MAX_CELLS=15` nothing can post, so
  no new series can mint regardless. `shells: 657` has not moved, but that is
  *trivially* true. **A valid shells/h reading requires the cap to be raised.**
  Baseline to diff against: **657**.

**b) Equity board is frozen** by `EXCLUDE_CLASSES=2,4` pending funding (below).

**c) Rent reclaim queued** (see §5) — ~3 SOL+, not actionable until after settlements.

## 3. TODAY (Tue 2026-07-21) — queued 13:30Z sequence

1. **Equity sample-counts climbing** + a live-sample `get_option_price` on an equity feed.
2. **Wave-2b births: SPCX + HOOD** → equity board 13. Manifest is LOCKED:
   - `SPCX` feedHash `fd7a0b9ea922e14e18944f8105b151df922487da9b1b2ed5ad52150924ed413f`, seed **1.00** (fresh Nasdaq IPO Jun-12, thin history ⇒ seeded HOT; `reset_vol_oracle` is the admin-only mid-warmup repair lever)
   - `HOOD` feedHash `9801bc9a0cc3eceb1ec4dfb964186a426883bb89a670c5968879b6e2c31b7c8b`, seed **0.65** (full history since 2021 IPO)
   - Both **pure births**, `assetClass=2`, via `crank/_birth_sb_market.ts` (skip the migrate/close leg), then `initialize_vol_oracle` with the locked seeds. Hashes were computed off the FROZEN quotes.opta.fyi scheme and self-verified by recomputing all 11 existing hashes byte-for-byte.
3. **Churn-fix burn measurement → FUNDING STOP → lift classes 2,4 → MAX_CELLS ~470.**

## 4. FUNDING STOP — math state (approved, one term still unmeasured)

- **USDC: $550k approved.** Measured at live spots (Mon Jul-20): **$519,405** for
  13 tickers × 20 cells = 260 cells; $550k adds drift buffer. NOTE the older
  "~$440k" figure was the **11**-ticker number — SPCX+HOOD add ~$80k.
- **SOL line = (measured post-fix burn/h × 48h) + 6.5 + buffer.**
  `6.5` = 260 equity cells × 0.024 SOL cold-board rent. **burn/h is still
  UNMEASURED — it is today's first deliverable.** Pre-fix reference was ~1.55 SOL/h
  (untenable: 48h ⇒ 74 SOL). If the fix lands ~90%, expect ≈17 SOL total.
- **Report alongside it: shells-created-per-hour** (must be ~0 outside genuine spot
  moves). Burn/h alone only shows the bleed *slowed*; shells/h ~0 proves it **dead**.
  Only meaningful once the cap is raised — see §2a.
- Sequence after funding lands: lift `EXCLUDE_CLASSES` (drop 2,4; **keep SBXAU
  forever**) → `MAX_CELLS=470`. Full board is 180 crypto + 260 equity = **440**
  (not 470 — 470 is deliberate non-binding headroom inside `globalVaultCap=500`).

## 5. Why the wallet drained (root cause — do not re-diagnose)

The bot burned ~9 SOL itself, as **permanent account rent**, not fees. Strike wobble
across a `roundSig` boundary minted a NEW series+vault every tick. A cancel refunds
**only** the order+escrow rent (~0.004); the series mint/record/hook accounts and the
vault+vault_usdc are **never closed by a cancel** (~0.020/wobble, permanent).
Result: **657 writer-created SharedVaults, all empty 0-pool shells**, for a board that
never exceeded ~180. Reclaim via `close_settled_writer_ask_vault` — requires the vault
to be **SETTLED**, so run **after the Jul-24 and Jul-31 settlements**, folded into the
**Aug-7 void-sweep** session (~3 SOL+).

## 6. Monitors — all VPS-side, persist without any session

- systemd: `opta-writer.service` (350M), `opta-crank.service` (400M), `opta-quotes.service`
- cron: `*/30 * * * * node /opt/opta-writer/snapshot.js` → `/opt/opta-writer/observe.log`
  (records orders / sol / freeUsdc / orderPks / **shells**)
- Writer emits hourly `heartbeat` + `reprice`/`strand`/`post` events to journald.
- **No session-owned pollers or watchers exist.** Nothing to kill.

## 7. Gotchas a fresh session will otherwise re-learn the hard way

- **RULE 1** — assert `HEAD` + a boot-log marker after EVERY deploy. Never hot-patch
  the box: a hot-patched `engine.ts` silently blocked every `git pull` for two days
  while builds reported green.
- **RULE 2** — `MAX_CELLS`/`globalVaultCap` are throttles, NOT prioritizers; allocation
  is enumeration-order dependent. Denylists are the only real scoping mechanism.
  The real binding cap is `maxCellsPerAsset=20` (9 SB assets × 20 = **180**, not 200).
- **RULE 3** — no loose WIP in this SHARED tree; treat unauthored tree state as
  untrusted (typecheck + suites before building on it).
- Pre-commit compile gate runs `tsc --noEmit` when `writer/src/*.ts` or `crank/*.ts`
  is staged. It **warn-skips where node_modules is absent** — notably the origin/main
  worktree used for HANDOFF commits — so typecheck LOCALLY before copying files there.
- HANDOFF edits ship ONLY via an `origin/main` worktree (a hook blocks them on `codex/*`).
- `writer/` shows permanent **CRLF phantom diffs**; check with `diff --strip-trailing-cr`
  before believing there is uncommitted work.
- **Pyth freeze is permanent**: `oracle_source=0` markets are hard-skipped in code.
- quotes proxy: `QUOTES_CACHE_TTL=20000` (20s) ⇒ 13 tickers at 39 Finnhub calls/min
  against a confirmed 60/min free tier.

---

## SESSION CLOSE ADDENDUM — 2026-07-21 (Wave-2 / crank-side session; tab retired)

> Complements §1–7 above (writer/MM session). That block is authoritative for the
> writer, funding math, and rent/shells root cause — **not repeated here.** This
> addendum records only the equity/crank-side facts a fresh reader would otherwise
> miss. Full narrative detail is in the dated blocks below.

### A. Equity board state (done, verified)
All **11 equity markets are live on Switchboard** and independently re-verified
on-chain (`crank/_probe_wave2_verify.ts` → ALL 11 OK): canonical `assetName`,
`oracle_source=1`, feedHash byte-matches the frozen manifest, `asset_class=2`,
registry-resolvable, vol oracle present **at the market-derived PDA** with
`source=1` + manifest seed, `sample_count=0` (tradeable at birth via seed).
7 migrations + 4 births. `get_option_price` proven SANE on MSFT/AAPL/TSLA
(`vol_used` === seed exactly; `spot_used` ≈ proxy; premium inside an ATM band).

### B. Crank state
Deployed with RULE-1 HEAD assertion; boot marker `supported: 10 → 17` proves the
equity registry live **in-process**. Crypto sampling verified unaffected
(`sc=244`, ~25 min freshness). Equity feeds are attempted and fail cleanly
(honest-stale, bounded 8 retries, 0 crashes) until the 13:30Z open.

### C. Open crank-side items NOT covered in §2
1. **Hourly "warming tick" has pushed NOTHING since Mon 14:02Z** — `feedsPushed:0`,
   error `packEd25519Ix: all triples must share an identical message`. **Pre-existing**
   (predates all Wave-2 work) and **NOT service-affecting**: the ~30-min main push
   loop is what actually samples (proven by `sc=244`). It burns 2–3 min/hour for
   nothing. Own sub-arc — do not conflate with equity staleness.
2. **Quantify stale-retry noise (queued for today AM).** The warming tick went
   124s → 196s when equities joined (~92 failed fetches/tick, 8 retries/feed).
   **Decision rule:** if that materially delays *crypto* sampling, a market-hours
   gate on the crank moves up the list; if it is only log spam, it waits.
3. **PERMANENT RULE — no `import.meta` in any `app/src/utils` module the crank
   imports.** It is an ESM-only *syntax* marker: its mere presence makes Node treat
   the file as ESM, and the crank imports `@app/*` under CJS/ts-node. This
   crash-looped the crank (`exports is not defined in ES module scope`) for ~10 min
   on Jul-21. FE-only idioms belong in FE-only modules (`env.ts` already uses it and
   is never imported by the crank). Fixed in `1898c23`.
4. **PERMANENT RULE — SB-registry registration is a PREREQUISITE of any equity
   migration**, never STEP-4 follow-on work. `_cutover_rebirth`'s create leg resolves
   jobs via `lookupSbFeed` and throws *after* the close has landed → asset goes
   MARKETLESS (happened to MSFT). The tool now `die(12)`s on an unregistered
   feedHash **before** touching the market, and an absent PDA takes a
   marketless-recovery branch (skip scan+close → straight to create).

### D. Tool inventory (all read-only unless noted)
| Tool | Proves / does |
|---|---|
| `crank/_probe_wave2_verify.ts` | 11-row equity board verify (the STEP-3 acceptance table) |
| `crank/_verify_registry_hashes.ts` | registry parity (every entry re-derives its own feedHash) + 11/11 equity resolvable — **run before any migration** |
| `crank/_test_marketless_recovery.sh` | 7/7: absent-PDA recovery + unregistered-feedHash refuses to close |
| `crank/_probe_sb_freshness.ts` | per-feed `sample_count` + freshness (the equity sample-count proof for 13:30Z) |
| `crank/_probe_eq_gop.ts`, `_probe_msft_parity.ts` | `get_option_price` plausibility (vol===seed, spot≈proxy, premium in ATM band) |
| `crank/_probe_fullboard_collateral.ts` | full-board USDC collateral at live SB spots (the funding-STOP USDC term) |
| `crank/_probe_writer_orders.ts` | live writer asks **by asset** (board census) |
| `crank/_probe_writer_bal.ts` | writer SOL + USDC (burn measurement) |
| `crank/_probe_xrp_strikes.ts` | distinct strikes per asset — **the strike-hysteresis / shells proof** (>5 strikes on one asset = wobble minting series) |
| `scripts/_exec_fund_writer.mjs` | **WRITES** — mint USDC + SOL top-up. SIMULATE by default; `OPTA_FUND_SEND=1` to fire |

`_probe_xrp_strikes.ts` is the cheapest way to close §2a's open question: after the
cap is raised, a stable distinct-strike count per asset (5) is direct evidence the
hysteresis holds; a climbing count means wobble is still minting series.

### E. Session-owned background tasks
**None.** No pollers, watchers, crons, or scheduled wakeups were created by this
session. All monitors are VPS-side and persist independently (see §6).

---
# Opta — Engineer Handoff

> **2026-07-21 (WAVE-2 STEP 4 ✅ crank live on 17 feeds. ⚠ TWO INCIDENTS: crank ESM regression (fixed) + WRITER OUT OF GAS (open, sizes tomorrow's block).)**
>
> **[STEP 4 DONE — crank deployed, HEAD-asserted per RULE 1]** `/opt/opta-crank` is a FULL checkout (not sparse) so the `app/` half of the registry ships with a normal pull — the "crank-only checkout re-skips `sbFeedData.ts`" warning does NOT apply to this box. Pre-pull hot-patch scan: only untracked files (`deploy/nginx/opta-headers.conf`, `sb-settle-archive.jsonl`, a leftover `engine.ts.bak`), **no modified tracked files**, so the pull was not blocked. HEAD asserted `1898c23` ✓. Registry gate re-run **on the VPS**: 17/17 parity, 11/11 equity resolvable.
> **Boot marker (the RULE-1 proof):** `sb-oracle warming tick: discovered SB feeds → sbMarkets:22, supported:17, unsupported:4` — **supported went 10 → 17**, confirming the equity registry is live in the running process, not just on disk.
>
> **[STEP 4 VERIFICATION — the three asks]**
> 1. **All 11 equity feeds attempted** ✓ — the warming tick's `failedFeeds` list contains all 11 equity hashes plus the 6 crypto/gold = 17.
> 2. **Honest-stale handled cleanly** ✓ *with a caveat* — **0 crashes**, bounded retries (8/feed) then `push failed after max attempts (retry next tick)` and continue. But it is **noisy**: ~92 fetch failures/tick and the hourly warming tick now runs **196s** (was 124s). Not service-affecting; worth a market-hours gate later so equities aren't retried 8× overnight.
> 3. **Crypto sampling unaffected** ✓ — BTC/ETH/SOL/XRP/FARTCOIN `sample_count=244`, last sample **25.5 min ago**; XAU `sc=553`. Spots moved across the session (BTC $64,668 → $65,146.50). MSFT `sc=0` fresh via seed, as designed. Probe: `crank/_probe_sb_freshness.ts`.
>
> **[⚠ PRE-EXISTING — hourly "warming tick" has pushed NOTHING all day]** `feedsPushed:0 / feedsErrored:10` on EVERY hourly tick from 14:02Z onward, **before** any change of mine (it only widened 10→17). Error: `packEd25519Ix: all triples must share an identical message`. **NOT service-affecting** — the ~30-min main push loop is what actually samples (proven by `sc=244` @ 25min). The warming tick is a separate pass burning 2–3 min/hour for nothing. Own sub-arc.
>
> **[⚠ INCIDENT — crank ESM regression, MINE, fixed in `1898c23`]** `SIMULATION_FEE_PAYER` (from the FE robustness trio) read `import.meta.env.VITE_SIM_FEE_PAYER` in `app/src/utils/constants.ts`. **`import.meta` is an ESM-only SYNTAX marker** — its mere presence makes Node treat the module as ESM, and the CRANK imports that same file via `@app/*` under CommonJS/ts-node. Result: crash-loop `ReferenceError: exports is not defined in ES module scope`, crank down ~10 min. Fixed by hardcoding the pubkey + a loud DO-NOT-REINTRODUCE comment. **PERMANENT RULE: no `import.meta` in any `app/src/utils` module the crank imports** — FE-only idioms belong in FE-only modules (`env.ts` already uses it and is never imported by the crank).
>
> **[🚨 OPEN P1 — WRITER IS OUT OF GAS; board collapsed 180 → 15 asks]** Writer SOL **9.767 → 0.0041** (USDC fine at $1.64M). Burn ≈ **1.55 SOL/h at full board**, i.e. the 9.77 SOL lasted ~6 h. Cause is **transaction churn, not volume**: 6h of logs show **533 `orphan-series` + 627 `reprice-cancel`** pulls. Every reprice is cancel+repost (2 tx) and spot wobble across `roundSig` strike boundaries mints a NEW series each tick, orphaning the old one — so the board rewrites itself continuously. Out of gas → cannot post/cancel → `quoteFailed:240`, asks decaying (29 @ 20:05Z → 15 now). Denylist held throughout: **zero equity asks**.
> **⇒ Tomorrow's funding block must size SOL off the MEASURED burn, not a guess: 10 SOL ≈ 6 h of runway.** Either fund materially more (≥40 SOL for a day) **or** cut the churn first (strike hysteresis so `roundSig` wobble stops minting new series; skip repost when an age-triggered reprice moves price <ε). Recommend churn fix FIRST — otherwise the equity board doubles the burn.
>
> **[DENYLIST CONFIRMED LIVE]** Writer boot log (not just `.env`): `"assets":"all","assetsExclude":["SBXAU"],"excludeClasses":[2,4],"maxCellsThisRun":200`. Verified holding **after** the 11 equity markets appeared — on-chain writer asks are XRP/XAU/JTO only, **no class-2 asks**.

> **2026-07-20/21 (WAVE-2 STEP 3 ✅ COMPLETE — ALL 11 EQUITY MARKETS ON SWITCHBOARD. Board is equity-complete.)**
>
> **[STEP 3 DONE]** 7 migrations (hardened `_cutover_rebirth.ts`, one at a time, `hasUserClaim` = hard stop) + 4 pure births (`_birth_sb_market.ts`). Every create landed **first attempt** once the registry prerequisite was in place — the fix held. Independent on-chain verify (`crank/_probe_wave2_verify.ts`): **ALL 11 OK** — `assetName` canonical, `oracle_source=1`, feedHash **byte-matches** frozen manifest, `asset_class=2`, registry-resolvable, vol oracle present **at the market-derived PDA** with `source=1` + manifest seed, `sample_count=0` (tradeable at birth via seed).
>
> | Ticker | path | market PDA | vol oracle | seed |
> |---|---|---|---|---|
> | MSFT | migrate* | `GoHsfVCh…PyDM` | `9Q4CXgPK…` | 0.30 |
> | AAPL | migrate | `CFftqXKc…BCcp` | `8TYhhZYg…` | 0.32 |
> | GOOGL | birth | `3cdMsczK…uuN7` | `HdUkkcwj…` | 0.35 |
> | AMZN | birth | `Aon1iP5W…jMr7` | `5vLxyZp4…` | 0.35 |
> | META | migrate | `49haznfS…bf5E` | `7aEcm8SD…` | 0.40 |
> | NVDA | migrate+ovr | `EXib8CVy…1j9C` | `14HHRRPR…` | 0.55 |
> | AMD | birth | `CCQSTPwG…Jm5b` | `2xVktAmf…` | 0.55 |
> | TSLA | migrate | `4SQc6d79…1Vtm` | `36UKPKor…` | 0.60 |
> | COIN | birth | `HVAwbCBF…YPZv` | `97mfTNGF…` | 0.75 |
> | MSTR | migrate | `BKAY8rNy…3XiT` | `FLZBdTZk…` | 0.90 |
> | CRCL | migrate | `5h4vkFFA…q8xa` | `2z6oJMck…` | 0.95 |
>
> `*` MSFT completed via the birth driver after the marketless incident (see below) — **parity-verified byte-equivalent** to cutover-tool output, so the board has no divergent migration.
>
> **[NVDA OVERRIDE — ledgered]** Closed over vault `6bm8c9GU…` under founder ruling: *"voided vault, $0.000001 rounding dust, ATA owned by the vault PDA itself, zero holders/writers/backers, hasUserClaim=false. No third-party or recoverable founder value. Orphaned by founder ruling 2026-07-20; dust unrecoverable by design. Tool behavior correct — hard-stop on any value is the intended calibration."* Scan recorded `userClaimOverrides=0`.
>
> **[get_option_price SANITY — plausibility, not just non-error]** MSFT $398 ATM ~30d → **$14.5148**, `vol_used=30.00%` === seed, `spot_used=$398.12` (proxy $397.7). AAPL $325 ATM → **$12.7123**, `vol_used=32.00%` === seed, spot $325.32. TSLA $374 ATM → **$25.1755**, `vol_used=60.00%` === seed, spot $371.82. All premiums inside the ATM band → **SANE**.
>
> **[▶ NEXT]** STEP 4 = **crank overlay / tick verification ONLY** (the registry half was pulled forward as the incident fix). Then STEP 5 Wave-2b births (SPCX `7hVcCiJf…`, HOOD `C6ge3zpm…`, both PDAs verified FREE) → board = 13. **Equity writer funding (~$440k) is a SEPARATE founder-gated block AFTER births** — and note `OPTA_WRITER_EXCLUDE_CLASSES=2,4` keeps equities off the writer board until that lands.

> **2026-07-20 (⚠ MSFT MARKETLESS INCIDENT — recovered. STEP-ORDER DEFECT: registry registration is a PREREQUISITE of equity migrations.)**
>
> **[INCIDENT]** STEP 3's first migration (MSFT) closed successfully, then **all 10 create attempts threw `feedHash … not in SB registry`** (`crank/switchboardCreateMarket.ts:80` — the create leg resolves jobs via `lookupSbFeed`). MSFT sat **MARKETLESS ~2 minutes**. Recovered out-of-band via `_birth_sb_market.ts MSFT` (embedded defs, registry-independent) — created first attempt. **No user funds were ever at risk**: the sole referencing vault was an empty shell, zero live positions. The chain correctly halted before AAPL/TSLA, so only one asset was exposed.
>
> **[⚠ STEP-ORDER DEFECT — the real lesson]** **SB-registry registration is a PREREQUISITE of any equity migration, not STEP 4 follow-on work.** The Wave-2 plan ordered it after the migrations; had we continued, **all 7 equities would have gone marketless in turn.** STEP 4's remaining scope after this = **crank overlay / tick verification only** (the registry half is now done).
>
> **[SECOND DEFECT — recovery advice was fiction]** `die(21)` told the operator to "re-run this driver (idempotent: it skips the close and goes straight to create)", but step 0 `die(10)`'d on the absent PDA, making that impossible. The escalation described behavior that did not exist.
>
> **[FIXES — all verified]**
> - **(a) Registry + parity guard.** All 11 equity feeds registered (`app/src/utils/sbFeedData.ts` data + `crank/sbFeedRegistry.ts` jobs). New **`assertRegistryHashParity()` runs at module load and THROWS on drift** — every entry's `symbol`+jobs must re-derive its own feedHash key (GUARD1 applied to the registry itself). `_verify_registry_hashes.ts` gate: **17/17 parity OK, 11/11 equity feeds resolvable → "GATE PASSED"**.
> - **(b) Recovery patched + tested.** Absent PDA now takes a **marketless-recovery branch** (skip scan+close → straight to create) instead of `die(10)`. Added a **prerequisite gate**: an unregistered feedHash now **`die(12)` BEFORE any close**, so this incident class cannot recur. `_test_marketless_recovery.sh` **7/7 PASS** — reproduces the marketless state (absent PDA) and proves recovery, and proves the gate refuses to close. Escalation text now matches real behavior.
> - **(c) MSFT parity — no divergent migration.** `_probe_msft_parity.ts` **8/8 OK**: `assetName='MSFT'`, `oracle_source=1`, feedHash **byte-matches** manifest, `asset_class=2`, resolves in registry, vol oracle exists **at the market-derived PDA** (`9Q4CXgPK…`) with `source=1`, `seed_vol=300000000000`. **Byte-equivalent to cutover-tool output.**
> - **First equity quote on the board is SANE:** MSFT $398 ATM CALL ~30d → **premium $14.5148** (ATM approx $13.70, band $6.85–$27.39), **`vol_used=30.00%` === seed**, **`spot_used=$398.12`** vs proxy $397.7 (<3%).

> **2026-07-20 (WAVE-2 STEP 2 ✅ — 11 equity vol oracles SEEDED. STEP 3 pre-scanned: 6/7 clean, NVDA blocked on $0.000001 dust.)**
>
> **[STEP 2 DONE — `917830b`]** `initialize_vol_oracle` ×11 with the approved manifest seeds, one at a time via `_birth_sb_market.ts <T> --seed-only` (new flag: creates the oracle and STOPS; markets stay for STEP 3). **All 11 verified on-chain: `oracle_source=1`, `seed_vol` reads back === manifest, `sample_count=0`** → warmup gate satisfied by the seed = tradeable at birth. Seeds ×1e12: MSFT `3e11` `9Q4CXgPK…` · AAPL `3.2e11` `8TYhhZYg…` · GOOGL `3.5e11` `HdUkkcwj…` · AMZN `3.5e11` `5vLxyZp4…` · META `4e11` `7aEcm8SD…` · NVDA `5.5e11` `14HHRRPR…` · AMD `5.5e11` `2xVktAmf…` · TSLA `6e11` `36UKPKor…` · COIN `7.5e11` `97mfTNGF…` · MSTR `9e11` `FLZBdTZk…` · CRCL `9.5e11` `2z6oJMck…`
>
> **[⚠ SEQUENCING CORRECTION — get_option_price spot-check DEFERRED into STEP 3]** It **cannot** run in STEP 2: the program binds `vol_oracle` to `market.pyth_feed_id`, so pairing a new SB oracle with a still-Pyth market fails **ConstraintSeeds (2006)** (verified on both AAPL and TSLA). The plausibility check (vol_used===seed, spot_used≈proxy, premium inside an ATM band — not merely "returns a number") runs **immediately after AAPL + TSLA migrate**, which is a stronger end-to-end proof. Probe: `crank/_probe_eq_gop.ts`.
>
> **[STEP 3 PRE-SCAN — read-only, hardened `_cutover_rebirth.ts`]** All 7 migration targets scanned; **all 7 vol oracles EXIST**; **6/7 CLEAN**:
> - MSFT / AAPL / MSTR — CLEAN (1 empty shell each) · META / CRCL — CLEAN (0 referencing) · TSLA — CLEAN (4 shells)
> - **NVDA — HARD STOP (correctly).** Vault `6bm8c9GUCGjcEv8mNAWGsdn5Wp61yByp5o5BwwLGSoid` (`settled=false voided=true`, strike $220, expiry 1778832000) holds **exactly 1 micro-USDC = $0.000001** rounding dust; `total_collateral=0`, `total_shares=0`, **no holders/writers/backers**, and the ATA owner is the vault PDA itself. **`hasUserClaim=false` — zero third-party exposure.** Needs a founder ruling: `--override=6bm8c9GU…:<ruling>` to orphan the dust, or drain-then-migrate.
> - **Birth PDAs verified FREE** (GOOGL `3cdMsczK…`, AMZN `Aon1iP5W…`, AMD `CCQSTPwG…`, COIN `HVAwbCBF…`; Wave-2b SPCX `7hVcCiJf…`, HOOD `C6ge3zpm…`) — genuine births, no hidden closes.

> **2026-07-20 (WAVE-2 STEP 1 ✅ — all 11 equity SB feeds MINTED + registered. Entry gate satisfied; STEP 2 pending greenlight.)**
>
> **[STEP 1 DONE]** All 11 Wave-2 equity feeds stored on Crossbar with the full guard chain per ticker: **GUARD1** (local `computeOracleFeedId`) → **STORE** → **GUARD2** (server feedId === local === **frozen manifest hash**) → **RESOLVE** (fetch-back, jobs=2) → **LIVENESS** (gateway signed, 2 signatures, ed25519 present). **11/11 GUARD2 PASS — zero hash drift**, so the locked manifest (ClickUp `86eyb0xjz`) is intact. Tooling: equity defs added to `crank/_mint_sb_feed.ts`, using builders **byte-identical** to `crank/_equity_feed_hashes.ts` (the generator that froze the hashes) — re-proved 11/11 before any store.
>
> | Ticker | seed | path | feedHash (frozen = minted) | CID | dev (finnhub vs yahoo) |
> |---|---|---|---|---|---|
> | MSFT | 0.30 | migrate | `b13e5f03…` | `bafkreifrhzpqgc…` | 0.020% |
> | AAPL | 0.32 | migrate | `d0ab87e8…` | `bafkreigqvod6qi…` | 0.037% |
> | GOOGL | 0.35 | birth | `c47268fa…` | `bafkreigeojupuy…` | 0.014% |
> | AMZN | 0.35 | birth | `bf3190ce…` | `bafkreif7ggim4o…` | 0.088% |
> | META | 0.40 | migrate | `56bb4c58…` | `bafkreicwxngfqy…` | 0.163% → resampled 0.05–0.07% (transient) |
> | NVDA | 0.55 | migrate | `53789130…` | `bafkreictpcitba…` | 0.039% |
> | AMD | 0.55 | birth | `28fcb07f…` | `bafkreibi7syh7m…` | 0.063% |
> | TSLA | 0.60 | migrate | `24f5404d…` | `bafkreibe6vae3m…` | 0.009% |
> | COIN | 0.75 | birth | `60e0a2d3…` | `bafkreida4crnge…` | 0.082% |
> | MSTR | 0.90 | migrate | `5dc7af42…` | `bafkreic5y6xuf5…` | 0.010% |
> | CRCL | 0.95 | migrate | `077acbc9…` | `bafkreiahplf4tj…` | **0.19–0.33% (widest)** |
>
> **[NOTE 1 — CRCL is the widest-spread ticker; WATCH]** CRCL's two legs persistently disagree ~0.19–0.33% (re-sampled 3×) — a thin-listing characteristic, not a proxy fault; well inside `maxJobRangePct=5%` with a 2-source median, and its **0.95 seed already prices it as the board's most uncertain name**. Action: watch its oracle marks vs reference over week 1; **if persistently biased, `reset_vol_oracle` is the lever.**
>
> **[NOTE 2 — the 0.1% deviation bar is MISCALIBRATED for equities]** It is tighter than ordinary inter-source tick noise: the AAPL control itself hit 0.106% on one sample, and META spiked 0.163% once then settled at 0.05–0.07%. **Recalibrate future waves to ~0.25% transient / 0.5% systematic** so every mint doesn't re-litigate tick noise.
>
> **[STEP 2 READY]** All 11 vol-oracle PDAs verified **ABSENT** on-chain → clean init, no idempotency conflicts. Seeds scale ×1e12 (0.30 → `300000000000`), `assetClass=2`, `source=1`.

> **2026-07-20 (SCALE-UP FLAGS DECIDED — SBXAU scoped out, globalVaultCap→500 committed. FINAL funding line below.)**
>
> **[FLAG 1 — SBXAU scoped OUT]** `XAU` (BX6rrhdd) is canonical → single XAU exposure. `SBXAU` (4pEmVTXd) stays OFF `OPTA_WRITER_ASSETS` (do NOT close the market artifact now — it rides the **Aug-7 cleanup**). Board drops by $79,800 → **net SB board = $1,535,961** (10 markets, 200 asks).
> **[FLAG 2 — globalVaultCap → 500, COMMITTED]** `writer/src/env.ts` default 250→500 (covers ~480 with Monday equities; MAX_CELLS stays the real throttle). Takes live effect on the scale-up redeploy (rebuild dist), or set `OPTA_WRITER_GLOBAL_VAULT_CAP=500` in `/opt/opta-writer/.env` for an immediate restart.
> **[✅ FINAL FUNDING LINE — founder runs tomorrow AM PKT, WSL, repo root]** `scripts/_exec_fund_writer.mjs` default is now **mint $1,650,000 + 5 SOL** (net-SBXAU board $1,535,961 + ~$133k buffer → writer ATA ≈ $1,668,997). SIMULATE re-verified clean (err:null).
> ```
> NODE_PATH=…/app/node_modules OPTA_RPC_URL="$(cat ~/.opta-rpc-helius)" node scripts/_exec_fund_writer.mjs               # SIMULATE
> NODE_PATH=…/app/node_modules OPTA_RPC_URL="$(cat ~/.opta-rpc-helius)" OPTA_FUND_SEND=1 node scripts/_exec_fund_writer.mjs   # SEND
> ```
> Then Stage 1: `OPTA_WRITER_ASSETS=BTC,ETH,SOL,XRP`, ramp `OPTA_WRITER_MAX_CELLS` 3→30→55→80 across restarts (strand=0 watched); Stage 2 add `,JTO,WIF,FARTCOIN,JUP,BONK,XAU` (NOT SBXAU) → full 200-ask board. **Monday equity mint (~$440k) is a SEPARATE founder-gated block — do NOT fold into tomorrow's mint.**

> **2026-07-20 (WRITER SCALE-UP PREP — full-board USDC math @ current SB spots + funding block. FOUNDER-GATED @ funding, tomorrow AM PKT.)**
>
> **Decision (founder):** staged cap raise (option a); NO read-path parallelization before Monday; (b) engine parallelize + (c) age-reprice gas nit deferred post-Monday.
>
> **[FULL-BOARD COLLATERAL — recomputed at CURRENT SB oracle spots, NOT the stale $5M estimate]** `crank/_probe_fullboard_collateral.ts` replicates the writer's exact ladder (20 cells/mkt = 5 strikes×2 tenors×2 sides; `collateral = strike×qty`, `qty=clamp(round(tn/strike),1,MAX)`; `tn`=$2000 major / $500 meme — env.ts defaults, VPS overrides only ENABLED/ASSETS/MAX_CELLS). Devnet SB feeds are PEGS (BTC $64.7k not ~$118k, SOL $76 not $180) so the number is far below the old guess:
>
> | SB market | class | spot | 20-cell collateral |
> |---|---|---|---|
> | **BTC** | crypto | $64,668 | **$1,293,200** (qty=1: tn $2000 < strike → each cell locks a full ~$58–71k strike) |
> | SBXAU | commodity | $3,987 | $79,800 |
> | XAU | commodity | $3,987 | $79,800 |
> | XRP | crypto | $1.095 | $39,998 |
> | SOL | crypto | $76.10 | $39,983 |
> | ETH | crypto | $1,870 | $37,400 |
> | JTO / WIF / FARTCOIN / JUP | crypto(meme) | — | ~$10,000 each |
> | BONK | crypto(meme) | $0.0000033 | $5,580 |
>
> **SB board total = $1,615,761** (11 markets, 220 asks). **BTC is 80% of the board.** Writer holds **$18,997 USDC / 4.767 SOL** → **mint delta ≈ $1,596,764**.
>
> **[FUNDING BLOCK — `scripts/_exec_fund_writer.mjs`, SIMULATE-clean (err:null)]** Admin `5YRMuuoY` IS the USDC mint authority (verified). Mints USDC to the writer's ATA `Gsy6Vo5Qg6GkwZ1XYUQCe8yFiZje6tRJTKSkpEMS9Dwr` + optional SOL top-up. Defaults: mint **$1,750,000** (board + ~$130k drift/staging buffer), **+5 SOL** (cold board locks ≈1.7 SOL of recoverable account rent across 220 vaults/mints/orders; writer's 4.767 would survive but +5 gives headroom). SIMULATE-by-default; `OPTA_FUND_SEND=1` to fire; devnet genesis-guarded; admin key read in place, never printed. Run (WSL, repo root):
> `NODE_PATH=…/app/node_modules OPTA_RPC_URL="$(cat ~/.opta-rpc-helius)" node scripts/_exec_fund_writer.mjs` (add `OPTA_FUND_SEND=1`).
>
> **[STAGING — on funded, per decision]** MAX_CELLS caps TOTAL live asks, and the writer posts up to that cap in ONE tick — so "fill over 3–4 ticks" = bump `OPTA_WRITER_MAX_CELLS` BETWEEN restarts, watching tick duration + strand count. Suggested ramp: **Stage 1 crypto majors** `OPTA_WRITER_ASSETS=BTC,ETH,SOL,XRP` (80 asks, $1,410,581 — BTC dominates), MAX_CELLS 3→30→55→80 across ~4 ticks (~20 posts/tick ≈ ~45s/tick at the measured ~2s/new-cell). **Stage 2** add `,JTO,WIF,FARTCOIN,JUP,BONK,XAU` and raise to the full 220. Watch `strand` in the heartbeat (should stay 0).
>
> **[⚠ TWO FLAGS]** (1) **Double XAU:** both `SBXAU` (4pEmVTXd) and `XAU` (BX6rrhdd) are SB → the full board double-posts XAU ($159,600 for two identical markets). SCOPE ONE OUT (leave SBXAU off `OPTA_WRITER_ASSETS`, or close the smoke artifact) before uncapping. (2) **globalVaultCap=250** covers the 220-ask SB board ✓, but Monday's equities add ~260 Pyth cells → 480 total > 250 → RAISE `OPTA_WRITER_GLOBAL_VAULT_CAP` (~500) before/with the equity board or it truncates ATM-first.
>
> **[MONDAY EQUITY ADD — separate funding]** The 7 Pyth equities migrating (TSLA/MSFT/CRCL/AAPL/MSTR/NVDA/META) add **+$279,587** at current spots once SB-birthed; the 4 births (GOOGL/AMZN/AMD/COIN) add ~$160k → **~$440k Monday**, fundable in a second mint (same script, bump `OPTA_FUND_USDC`). Equities need NO writer code action — discovery auto-includes them post-birth; the LIVE PROOF to watch is the equity market-hours gate + stale-pull on the board's first NYSE close (cancel-at-close / repost-at-open).

> **2026-07-20 (WRITER slow-first-reconcile — DIAGNOSIS. Structural, not a canary bug. Fix is greenlight-gated w/ scale-up.)**
>
> **[FINDING]** At the current canary scale (`OPTA_WRITER_ASSETS=XRP`, `MAX_CELLS=3`) there is NO slow first reconcile and the bot is healthy: ~12–13 ticks/hour (5-min `tickMs`), 0 strands, quoteFailed 0–1, liveOrders steady at 3. The 3 XRP asks PERSIST on-chain across restarts, so even a post-restart first tick just reprices (fast). The slowness is a **cold-board-at-scale** property, not reproducible at canary.
>
> **[ROOT CAUSE — structural, `engine.ts` `reconcile()`]** The tick is fully SEQUENTIAL and awaited op-by-op:
> - **Read path (every tick):** `readOracle` is one RPC PER in-scope market (loop `:122`), then `fetchQuote` is one simulate PER cell (`:166`) — all in series. Cost scales with markets × cells.
> - **Post path (first cold tick only):** each missing cell posts via `post()` = 2 `accountExists` + one multi-ix create-series/create-vault/post-ask tx + confirm, awaited one at a time. Measured write cadence on the canary: **~0.7s/tx** (6 write-txs in ~4s).
> - Subsequent ticks don't post (asks exist) → fast; only the FIRST cold tick pays the full posting storm, which is why it's uniquely slow.
>
> **[SCALE EXTRAPOLATION]** Monday's full board (all crypto/meme + 11 new equities ≈ tens of markets × ~4–6 cells) cold-started in ONE tick with `MAX_CELLS` uncapped: read path ≈ (markets + markets×cells) sequential RPCs ≈ ~1 min; post path ≈ (asks) × ~1–2s (create-series/vault txs are heavier) ≈ several minutes. First full-board tick ≈ **4–7 min**, exceeding the 5-min `tickMs`.
>
> **[MITIGATIONS]** (a) **Config, no code, already supported:** keep a per-run post cap (`OPTA_WRITER_MAX_CELLS=N`) on scale-up so the cold board fills incrementally over several ticks instead of one multi-minute first tick — `liveGlobal >= maxCellsThisRun` (`:199`) already chunks it. (b) **Code (greenlight-gated — it edits the LIVE MM bot + pairs with the scale-up):** bound-parallelize the READ path — `readOracle` across markets and `fetchQuote` across a market's cells via `Promise.all` with a ~8-wide pool — cuts per-tick read time ~8× and benefits every tick, not just the first. Keep posts sequential (nonce/confirm ordering) or a small ~3-wide pool. (c) **Secondary gas nit:** age-triggered reprice cancel+reposts even on trivial drift (observed 0.021416→0.021368, 0.05%); on an age-only trigger, skip the repost when |drift| < a small epsilon to save 2 txs/ask/cycle.
>
> **[ACTION]** No code shipped — the writer is live and its optimization is a scale-up-coupled change. RECOMMENDATION for the scale-up session: apply mitigation (a) immediately (set `MAX_CELLS` so the cold board fills over ~N ticks), and land (b) as a reviewed engine change with a unit test before removing the cap. ⚠ Both are founder-gated (live-bot change).

> **2026-07-20 (FE ROBUSTNESS TRIO — ✅ FIXED + verified. Pre-Monday board polish.)**
>
> **[1 · disconnected-viewer quote — FIXED, browser-verified]** Every NOT-connected visitor saw "—"/"No live quote" on the American Protocol-quote centerpiece even with a fresh oracle. Root cause (evidence, not guess — `crank/_probe_quote_payer.ts` against live devnet): `optionPriceQuote.ts`'s sim fee-payer fell back to `PublicKey.default` (System Program, owned by NativeLoader) → the RPC still LOADS the fee payer → **InvalidAccountForFee**; a random pubkey → **AccountNotFound**; only a real funded on-curve account decodes. `ContractInspector` auto-fires the RFQ on focus regardless of wallet, so disconnected visitors always hit it. FIX: new `SIMULATION_FEE_PAYER` constant (devnet deployer, funded/stable; `VITE_SIM_FEE_PAYER` override) used when no wallet is connected. Browser-verified: `scripts/check-disconnected-quote.mjs` drives a DISCONNECTED headless Chrome to /trade?asset=SOL, focuses an American row → centerpiece resolves to a $ premium (was "—").
>
> **[2 · seedQuote clobber — FIXED]** `OrderTicket.tsx` re-seeded `rfq` from the inspector's `seedQuote` on EVERY seedQuote change (it was in the reset effect's deps), so a churning seedQuote clobbered a user-requested quote. FIX: reset only on CONTRACT-identity change (seed read via a ref, not a dep); a late seedQuote for the same contract is adopted only while `rfq` is still null — never overwrites a user quote. (React-deps fix; no headless wallet harness exists to browser-drive the connected path.)
>
> **[3 · over-gated book fill — FIXED, unit-tested]** `needsFreshAmerQuote` gated EVERY American buy on a fresh model quote — including a fill landing entirely on a resting WRITER-ASK at the maker's fixed price (no model quote needed), so book fills were blocked whenever the oracle warmed/stalled. FIX: the fresh-quote gate now applies to a buy only when it ROUTES TO THE PEG (model-priced). Extracted the pure predicate `buyRoutesToPeg` into `app/src/pages/trade/sweepPlan.ts` (split the pure planners out of `marketSweep.ts`'s anchor/web3 executor graph). Plans the sweep against resting asks ONLY (peg excluded): covers qty → maker-priced → un-gated; spills past book depth → peg → still gated. `sweepPlan.test.ts` 8/8 against the real `planSweep`. Write stays gated (posts against peg fair value; unchanged, out of the reported scope).
>
> **[NOTE — build-vs-tsc]** `npm run build` (rolldown) caught an `OrderType`→`"market"|"limit"` narrowing that `tsc --noEmit` passed — per the standing rule, FE final verify is `cd app && npm run build`, not tsc alone.

> **2026-07-19 (SOL/BTC SB DOUBLE CUTOVER — ✅ COMPLETE. Both crypto markets now oracle_source=1.)**
>
> **[DONE — devnet]** The two Pyth crypto markets are reborn on Switchboard, in order BTC then SOL, each an atomic `close_market → create_market(SB)` via `crank/_cutover_rebirth.ts`.
> - **BTC** `G3PT11Zy…` → reborn SB, `get_option_price` green ($1268.85 quote). Prior collateral ($715k) had already auto-finalized to GkG (GtoM6B7f $65k + EaV3yxWb $650k, both permissionless `auto_finalize_writers`; EaV3yxWb swept at expiry+24h, verified received).
> - **SOL** `7ke68gTGTKTz3ENygmrcPLp4415pPpajywSdZcaggd7U` → reborn SB (`oracle_source=1`, feed `e01fe3bb…`, vol_oracle `8Ag1qR7k…` sc=218). Close sig `4gN12LT5…`, create sig `62LXZKos…`. `get_option_price` green: **$80 CALL Jul-31 = $0.70 @ 39.5% vol, spot $75.69** (devnet SB feed peg, not real-SOL). $120–200 strikes correctly deep-OTM → 6012 dust guard.
> - Close permitted under 3 founder-ruled overrides: `fGvpt9Ao` ($70) + `FqYC97En` ($0) logged in the OVERRIDE LEDGER; `EWwhESru` classified an all-zero shell by the current rule (its $246 sits in the writer-ask pot + holder DnExEYnZ — see BLOCKER). All founder-owned → harmless. Aug-7 void sweep recovers fGvpt9Ao $70 + EWwhESru $246 to GkG (calendared).
>
> **[✅ HARD BLOCKER — RESOLVED early 2026-07-20, ahead of Monday]** `_cutover_rebirth.ts`'s shell rule was `coll==0 && shares==0 && vault_usdc==0` on the **SharedVault only** — blind to the **writer-ask pot** and **option holders**, so on SOL it silently classified `EWwhESru` ($246 in `writer_ask_pot_usdc` + a holder on DnExEYnZ) as an empty shell. FIX: the shell decision is now a pure, unit-tested classifier `crank/vaultShellRule.ts` (`classifyVaultShell`) wired into the cutover scan. A vault is orphanable ONLY if empty on ALL axes — `vault_usdc==0 AND writer_ask_pot_usdc==0 AND option-mint holders==0 AND pool writers==0 AND ask backers==0`; `total_collateral/total_shares` are treated as stale counters (preflight parity). Holders are split **on-curve WALLET vs off-curve protocol PDA** (5uBcRhU6 lesson) → a real wallet holder sets `hasUserClaim` and prints a loud ⚠ in the override ledger / STOP. **Proof:** `crank/vaultShellRule.test.ts` 8/8 (lead test reproduces EWwhESru — RED against the old rule, GREEN after); `crank/_probe_ewwhesru_classify.ts` ran the classifier against the LIVE EWwhESru vault → OLD `isShell=true` (silent orphan) vs HARDENED `isShell=false, hasUserClaim=true` (flagged). Read-only dry-scan on still-Pyth AAPL: CLEAN, 1 empty shell orphaned, new deep-scan code executes on-chain without error. Monday STEP 3 entry gate is now satisfied by the tool itself.

> **2026-07-19 (P0 — SB VOL-ORACLE OUTAGE: dead crossbar devnet key; FIXED. + two follow-up bugs.)**
>
> **[ROOT CAUSE + FIX]** All 5 SB vol oracles (BTC/ETH/SOL/XRP/FARTCOIN) went **stale ~30h** (frozen Jul-18 09:00Z). Chain: FE "No live quote" ← `get_option_price` reverts **6045 VolOracleStale** ← oracles stale ← `sb-oracle` crank push failed every tick with *"No gateways available for network: devnet"* ← the **crossbar** (`/opt/crossbar`, `switchboardlabs/rust-crossbar`) had `SOLANA_DEVNET_RPC` = the **Helius key deleted in the Jul-16 rotation** → every devnet RPC call `NetworkError` → zero devnet gateways cached. **`getHealth` returned "ok" (unauthenticated) so the dead key was masked.** FIX: set `/opt/crossbar/.env` `SOLANA_DEVNET_RPC` to the crank's working key + `docker compose up -d --force-recreate`. Verified: 7 devnet gateways, sb-oracle pushing sigs, 5 oracles fresh (<0.1h), get_option_price green (XRP $1.09 CALL = $0.0219). The FE H-05 gate was working correctly (refusing a stale oracle) — NOT an FE bug.
>
> **[⚠ KEY-ROTATION CHECKLIST — permanent rule]** A rotation MUST enumerate **every consumer** of the key. The Jul-16 Helius rotation missed the crossbar container env; it died silently 30h later. RULE: after ANY key rotation, `grep -rIl "<oldkey>" /opt /etc /root /home /usr/local /srv /lib/systemd` + histories + `docker inspect` envs → expect ZERO; and add a per-consumer healthcheck that **exercises the credential** (an authenticated call, not `getHealth`). Consumers to date: crank (`/opt/opta-crank/.env`), crossbar (`/opt/crossbar/.env`), quotes svc, writer, app (Vercel `VITE_*`). (Old key `afed2170…` purged box-wide 2026-07-19.)
>
> **[WRITER STALE-PULL BUG — scale-up gate]** Resting asks are NOT pulled when their oracle goes stale. `engine.ts:91-95` skips the whole market on `!oracle.ready` BEFORE the per-cell quote, so the `quote-fail→pull` rule (`:133`, threshold 2) is unreachable; the fallback orphan-sweep (`:171`) is gated `assets == null` (full-board only) so it's off in scoped runs. Canary proof: 3 XRP asks live 20h, `quoteFailed:0 cancelled:0`. FIX before scale-up: in the `!oracle.ready` branch, PULL that market's resting asks before `continue` (explicit, mode-independent; meets the ~2-tick bar). Full-board mode masks it via the orphan-sweep, but don't rely on that.
>
> **[FE robustness — pre-Monday, non-blocking]** (1) disconnected viewers: `optionPriceQuote.ts` payer falls back to `PublicKey.default` → `InvalidAccountForFee` → quote fails even with a fresh oracle. (2) `OrderTicket.tsx:104` slaves `rfq` to the inspector's churning `seedQuote` → can clobber a good quote. (3) `needsFreshAmerQuote` over-gates writer-ask book fills (maker-priced, no model quote needed).

> **2026-07-18 (SOL/BTC SB EARLY-CUTOVER — BTC SETTLED, SOL PREPPED) ▶ SUNDAY 2026-07-19 RESUME** — a SEPARATE track from the Monday Wave-2 equity block below (both active).
>
> **[TONIGHT — done, devnet]** BTC both settled OTM (CALL $65k; GtoM6B7f $64,087.60, EaV3yxWb $64,125.64). **GtoM6B7f $65k already auto-finalized to GkG** (see rule below). **EaV3yxWb $650k settled, LOCKED until Sun 17:16:09Z** (24h holder window). SOL prepped: 6GfxUov external holder 5uBcRhU6 discharged (`auto_finalize_holders`, burned 5 OTM, $0; sig `ibi5Q4Lg…`) + backer DnExEYnZ reclaimed $400 (`withdraw_writer_ask_residual`, sig `3faPSvcr…`). Preflight hardened (funds+positions, `total_collateral` dropped as a stale counter) + **logged `--override=<vault>:<ruling>`** flag. Commits `2f20ecd..8e13c0d` master+main. ClickUp `86eyb72uc`/`86eyb72ud`/`86eyb7uqp`.
>
> **[⚠ LOCKUP RULE — CORRECTION, worked example]** The holders-first withdraw window (`withdraw_post_settlement.rs:49`, mirrored in `auto_finalize_writers`) keys on **CUMULATIVE `total_options_sold > 0` OR `writer_ask_collateral_swept > 0`** — **NOT current holders**. Unlock = **`vault.expiry + EXERCISE_WINDOW (86_400s / 24h)`**. Worked example tonight: GtoM6B7f (0 sales) → fast path → **auto_finalize_writers swept its $65k to GkG's USDC ATA 25s after settlement, untriggered** (tx `4iDBx3qz…`, +$65,000.00 to GkG). EaV3yxWb (5 sales, all OTM/worthless) → window applies → no withdraw NOR auto-sweep until expiry+24h (Sun 17:16:09Z). **PREDICT for every future sole-writer vault:** a permissionless `auto_finalize_writers` will sweep its collateral to the writer's ATA + close it — immediately at settlement if 0 sales, else at expiry+24h. (Watcher `_watch_eav_unlock.ts` armed for the Sun unlock.)
>
> **[▶ SUNDAY 2026-07-19 — LOCKED COMBINED SEQUENCE, in order]**
> 1. **~13:00Z — XRP canary 24h verdict** (auto-writer session reports). Gate for the evening scale-up.
> 2. **17:16Z+ — EaV3yxWb withdraw GATE** ($650k → GkG; may already be auto-finalized — verify GkG received it) → **BTC preflight** (expect SAFE, ~65 shells orphaned under the hardened rule) → **GATE close_market BTC** → rebirth SB BTC (`_birth_sb_market`, warm oracle by feedHash) → verify spot + vol oracle → **SOL preflight w/ 3 ruled overrides** (`fGvpt9Ao` = "founder $70, phantom mint counter, recover via Aug-7 void"; `FqYC97En` = "founder $0, same phantom-counter class, Aug-7 void"; `EWwhESru` = "deliberate orphan per decision #3, $246 via Aug-7 void hatch") → **GATE close_market SOL** → rebirth SB SOL → verify → **registry cross-check** → HANDOFF + per-asset ClickUp checkpoints.
> 3. **Evening — scale-up STOP** (full board + ~$5M WSL funding block) — contingent on a clean XRP verdict + BOTH rebirths verified.
>
> **[Aug-7 void sweep — calendared]** SOL orphans recover via `initialize_void`→`reclaim_unsettled`/`reclaim_writer_ask_residual` (void ignores oracle_source; no real holders → zero forfeiture): GkG reclaims fGvpt9Ao $70 + EWwhESru $246; FqYC97En $0. The Jul-31 Pyth guard is a **no-op post-double** (both markets SB) — retained only if the double aborts. Verified: guard CANNOT settle a reborn-SB vault (Hermes 404 on SB feedHash `e01fe3bb…`; SB arm needs SB accounts + 300s window).

> **2026-07-17 (WAVE-2 STEP 0.5 — quotes.opta.fyi HONEST-STALE PROXY LIVE + 11 EQUITY FEEDHASHES FROZEN; STEP 1-5 SPLIT TO MONDAY) ▶ RESUME HERE** — supersedes ALL prior ▶ RESUME markers below.
>
> **▶ MONDAY 2026-07-20 13:30Z (NYSE open) — WAVE-2 STEP 1→5** against the proxy proven in BOTH states. Entry gate = the 11 frozen feedHashes (ClickUp `86eyb0xjz`, table below). Sequence: STEP 1 mint+register 11 feeds (verify quotes vs reference, flag >0.1%) → STEP 2 `initialize_vol_oracle` ×11 (approved seeds; verify src=1, seed reads back, sc=0; get_option_price spot-check 2 tickers) → STEP 3 markets ONE AT A TIME (**✅ ENTRY GATE SATISFIED — `_cutover_rebirth.ts` shell rule hardened 2026-07-20: inspects writer-ask pots + option holders (on-curve wallet vs PDA), test 8/8 flags EWwhESru, live-vault probe confirms. Any non-shell vault now STOPs with a ⚠USER-CLAIM tag unless explicitly `--override`-ruled**; 7 migrate via husk rule `voided && vault_usdc==0`, reuse `crank/_cutover_rebirth.ts`; 4 birth GOOGL/AMZN/AMD/COIN; any NON-shell live vault → STOP) → STEP 4 crank overlay (add 11 to `sbFeedData.ts`+`sbFeedRegistry.ts`, surgical crank/ overlay — remember the overlay surface now includes `app/src/utils/sbFeedData.ts`, a `crank/`-only checkout re-skips them) → STEP 5 close. Naming clean — TSLA is TSLA.
>
> **[quotes.opta.fyi LIVE]** The equity feeds' Finnhub-key proxy (Wave-2's blocking prerequisite) is built + browser-verified. nginx TLS → loopback **opta-quotes** Node svc (`127.0.0.1:8090`, dedicated user, systemd, 15s cache `QUOTES_CACHE_TTL`). **Honest-stale, both legs 503-on-stale:** Finnhub fresh iff `c>0 && (now-t)≤180s`; Yahoo fresh iff `regularMarketPrice>0 && now∈currentTradingPeriod.regular[start,end] && (now-regularMarketTime)≤180s`. **CORRECTION vs the approved design:** Yahoo's `/v8/chart` has NO `marketState` (that's the `/quote` endpoint) — swapped for the `currentTradingPeriod` window + print-age (better; no feedHash impact). `minJobResponses=2` → one stale leg fails the whole feed (median never degrades to one stale source). Key server-side `/opt/opta-quotes/.env` (`FINNHUB_KEY`, root:root 600), never in repo/URL/logs. Committed `deploy/nginx/quotes.opta.fyi.conf` + `deploy/quotes/{quotes-svc.js,opta-quotes.service}` (**09020cf**). Verified: loopback + public HTTPS + **real headless-Chrome** both legs fresh in-hours (AAPL/TSLA agree <0.1%).
>
> **[11 EQUITY FEEDHASHES — FROZEN, Monday's mint targets]** Job def (all): Finnhub `https://quotes.opta.fyi/finnhub/quote?symbol=X`→`$.c` + Yahoo `https://quotes.opta.fyi/yahoo/chart/X`→`$.chart.result[0].meta.regularMarketPrice`; `symbol=X/USD`, `minOracleSamples=2`, `minJobResponses=2`, `maxJobRangePct=5e9`, class=equity, source=SB. **ZERO edits — any URL change re-mints every hash.**
>
> | Ticker | feedHash | seed | path | PDA (migrate) |
> |---|---|---|---|---|
> | MSFT | `b13e5f030af9a49150591b6cbce83810184331e5b6a0eae8b303a49153496c56` | 0.30 | migrate | `GoHsfVCh…PyDM` |
> | AAPL | `d0ab87e8218247d61f3b60e0d9c7e9dc93f691f30849552e0923aa8acd15fdc8` | 0.32 | migrate | `CFftqXKc…BCcp` |
> | GOOGL | `c47268fa603180997ab954702ef058dcf56d97f597085d095278dfffd37c9103` | 0.35 | birth | — |
> | AMZN | `bf3190ce3b040d25d1af35c66461fe8fee2f7dd4c83e72e5c13dcc89929abf3f` | 0.35 | birth | — |
> | META | `56bb4c5863ad44b5c59d75cce27d170f8c05e50b9698c9a27480bc7c47f11570` | 0.40 | migrate | `49haznfS…bf5E` |
> | NVDA | `5378913080bd823885beb8cc37d55842d438e2198f8ce711b7385b527a542bdf` | 0.55 | migrate | `EXib8CVy…1j9C` |
> | AMD | `28fcb07fb1301a399cbe35b809cd8ffa45a22f5bd4e3a15845b4fca219846668` | 0.55 | birth | — |
> | TSLA | `24f5404db181873fead6fd9ad15c7edc2265e8b7a494b3168055fa3bfbb3ced3` | 0.60 | migrate | `4SQc6d79…1Vtm` |
> | COIN | `60e0a2d31235e2e3c7414635f3bf0c14c671098ef953b0823d380913d627c868` | 0.75 | birth | — |
> | MSTR | `5dc7af42f5237fb2d39aa65374c91234da9a92ba940ac9a5613b51d59d9a830a` | 0.90 | migrate | `BKAY8rNy…3XiT` |
> | CRCL | `077acbc9a679e4660b8ace50be067bd08a443f1ea7c0a48b4b6e444c23c17040` | 0.95 | migrate | `5h4vkFFA…q8xa` |
>
> **[WEEKEND TASK]** Capture the off-hours honest-stale proof into the session record: after 20:00Z Fri the public endpoint should return **503 both legs** (market closed) and the feed produce no value. Session hash script (untracked): `crank/_equity_feed_hashes.ts`. ClickUp: `86eyb0xjz`.

> **2026-07-16 (SESSION CLOSE — P0 WEB-TRANSPORT FIX + WAVE-1 MEME CRANK OVERLAY LIVE)** — supersedes ALL prior ▶ RESUME markers below (their content stays valid as history).
>
> **[P0 PROD-WEB OUTAGE — FIXED]** After `VITE_RPC_URL` was repointed to `https://rpc.opta.fyi/devnet`, opta.fyi/trade showed a full-page "couldn't reach devnet." Three stacked failures (all four suspects checked read-only): **(1) CSP (primary)** — `connect-src` lacked `rpc.opta.fyi` (`'self'` ≠ the rpc subdomain; `*.helius-rpc.com` doesn't match it) → browser blocked every RPC fetch *before it left*; **proof:** nginx access log had ZERO `Mozilla` UAs (only mobile `okhttp`). **(2) CORS (latent)** — preflight `Allow-Headers` was `Content-Type` only (web3.js sends `solana-client`) + duplicate `ACAO` (nginx `https://opta.fyi` + Helius `*`). **(3) rate-limit (latent)** — `burst=40` < the ~138-market first-paint scan. Env injection was fine (bundle used the proxy, no `clusterApiUrl` fallback).
>   - **FIX (all three):** CSP `+https://rpc.opta.fyi` in **`app/vercel.json`** (master+main **`996c93a`**, Vercel prod). NOTE: `opta-headers.conf` is **dead for opta.fyi** — `opta.fyi.conf` no longer includes it, Vercel owns the header (opta.fyi returns 1 CSP header). VPS nginx `rpc.opta.fyi`: preflight `Allow-Headers "Content-Type, solana-client"` + `proxy_hide_header` ×3 (single ACAO) + `burst 40→200 nodelay`; `nginx -t` + reload; backup `rpc.opta.fyi.bak-p0-1784226336`. ClickUp `86eyap2mm`.
>   - **VERIFIED** server-side (CSP present, preflight single-ACAO+solana-client, POST single ACAO) + **live browser tail: 143 `Mozilla` POST /devnet, all 200, zero 503.** Founder browser gate GREEN (markets/trade/write render). **STANDING LESSON reaffirmed: browser-context verification is mandatory before shipping any web transport change — curl has no CSP, mobile RN has no CORS/CSP; both passed while the browser was 100% blocked.**
>   - **⚠️ REPO DRIFT:** `deploy/nginx/rpc.opta.fyi.conf` (repo template) is BEHIND live — missing `burst=200`, `solana-client` allow-header, the 3 `proxy_hide_header` lines (applied on VPS only). Sync on next repo touch.
>
> **[WAVE-1 MEME CRANK OVERLAY — LIVE]** The last Wave-1 item: the VPS sb crank now samples the 4 meme oracles. **Overlay = 2-file surgical checkout** (the `crank/`-only plan was insufficient — `REGISTRY = SB_FEED_DATA.map(...)` is driven by `@app/utils/sbFeedData`, so the meme `JOBS_BY_FEED` is inert without the `SB_FEED_DATA` entries): `git -C /opt/opta-crank checkout fcd5d7e -- crank/sbFeedRegistry.ts app/src/utils/sbFeedData.ts` → restart (19:08Z, NRestarts=0, 10 feeds loaded at boot).
>   - **VERIFIED:** `feedsSkippedUnsupported 4→0`, `feedsSupported 6→10`; **all 4 meme oracles `sample_count 0→1`** (pushed T20:13 via the crank's mid-hour retry); accumulating ~1/hr. Existing 6 feeds + settle baseline unaffected.
>   - **⚠️ COSMETIC (not a failure):** the hourly `:02` sb-oracle warming-tick log perpetually shows `feedsErrored:4` — the memes' samples land on the **`:13` mid-hour retry**, so the `:02` tick fires ~49 min later, inside the 55-min rate limit (`6046 VolOraclePushTooSoon`), which the sb crank mislabels as `feedsErrored` (the Pyth crank has a separate `feedsSkippedRateLimit` bucket). Samples ARE accumulating on-chain. **Fix (future crank touch): categorize `6046` as rate-limit-skip in `sbOracleCrank`, not errored.**
>   - **CRANK OVERLAY SURFACE (for the next deploy session):** VPS is now `13d6ab7` + Slice-1 + Slice-3 + **the registry pair** (`crank/sbFeedRegistry.ts` + `app/src/utils/sbFeedData.ts` — includes **one `@app` data file**). A future `crank/`-only checkout would DROP the `@app` file and re-skip the memes — always include `app/src/utils/sbFeedData.ts`. ClickUp overlay checkpoint filed.
>
> **RESUME NEXT:** (1) BTC close ~Jul-19 / SOL ~Aug-1 (reuse `_cutover_rebirth.ts`). (2) Wave-2 equity feeds (Gate-1 locked, ClickUp `86eya296r`; needs the honest-stale `quotes.opta.fyi` proxy). (3) De-noise items when convenient: sb crank `6046`-as-skip; sync `deploy/nginx/rpc.opta.fyi.conf`; VPS full-sync remains its own two-gated session. Today's ClickUp ledger (5): cutover `86eyakfck`, rotation `86eyakzgk`, births `86eyanefa`, P0 `86eyap2mm`, overlay (this).

> **2026-07-16 (SESSION CLOSE — WAVE-1 MEME BIRTHS + HELIUS KEY ROTATION)** — supersedes ALL prior ▶ RESUME markers below (their content stays valid as history).
>
> **[WAVE-1 MEME FEEDS MINTED + MARKETS BORN — Block 3]** JUP/JTO/WIF/BONK now live on Switchboard (devnet, admin `5YRMuuoY`). Rebuilt the missing SB feed-mint tooling and DRY-PROVED it against FARTCOIN's known hash (`9612492e…`) before any real mint — GUARD1 (local `computeOracleFeedId`) → `storeOracleFeed` /v2/store → GUARD2 (server feedId === local) → resolve. Registry `sbFeedData.ts` + `sbFeedRegistry.ts` on master+main **`fcd5d7e`**; all 10 feeds verified self-consistent (`buildOracleFeed→computeOracleFeedId === key`). Vercel prod deployed.
>
> | Asset | market PDA | feedHash / cid | vol oracle | seed | close→create sigs |
> |---|---|---|---|---|---|
> | JUP | `9zRB1AtkqpoDuqC4hhB6SiF1n9wbPmrz9BMq7arTQbGg` | `5f42a2a7…be0239f2` / `bafkreic7ik…rz6i` | `9KKKgiVbh2pk3dySQhbU1acsYfCrZkYdNqExBRRqPHf4` | 1.10e12 | close `2yBLfALq…` / create `2zueaHP2…` |
> | JTO | `2EL5cnxnipXS1DWcQr2gzbbTKDrAgRnbdzqoULaJKpGF` | `bc8e0c27…121317ec4` / `bafkreif4ry…l6yq` | `4LmvanBuViCpWxX7uTXBPhML6PS7BhuCsQPboNGWQDEK` | 1.10e12 | seed `436ip1yD…` close `rQnGVa5g…` create `3dUgFdew…` |
> | WIF | `7X7AuBsKZ5i15os6e4CnYaR3PrBH1gvAGDNq392r8jdS` | `c186e106…96801294a` / `bafkreigbq3…jjji` | `4CgaiuKR4yvRsQaLq3gTpoXDicLnA7EguVCYkwwqa1eN` | 1.40e12 | seed `5hZ5YaTe…` create `4ECVK1kC…` (BIRTH, no close) |
> | BONK | `9GcsKprT4M2qDQQLoT4v3dcVmHthPSTCnoWneEGu4u7V` | `c062a25a…8660e32f` / `bafkreigamk…hdf4` | `KmxweFHhByiXKvTxy4w8eZRyXjVgbjDWTMPiTmSUDvR` | 1.40e12 | seed `3pky5v65…` close `arBt4ewn…` create `56cmDNxZ…` |
>
> - **JUP/JTO/BONK = MIGRATIONS** (already existed as 0-vault Pyth → preflight-rescanned 0 live → `close_market` Pyth → `create_market` SB, same PDA). **WIF = pure BIRTH** (PDA was free). All verified: `oracle_source=1`, feedHash byte-match, `assetName` canonical (no suffix), `seed_vol` reads back = manifest (JUP/JTO 1.10e12, WIF/BONK 1.40e12), `sample_count=0` → **warmup gate satisfied by the seed = tradeable at birth**.
> - **Job defs = the deployed template** (Binance/Coinbase/Gate patterns copied verbatim from BTC-XRP/FARTCOIN, symbol substitution only). Each feed gateway-signed a 2-oracle quote at mint (liveness proven).
> - **⚠️ CRANK OVERLAY PENDING (founder decision — NOT done):** the VPS sb crank (unchanged) discovers the 4 markets (`sbMarketsFound 5→9`) but **skips all 4 as `feedsSkippedUnsupported`** — it needs `sbFeedRegistry.ts` `JOBS_BY_FEED` (now on master `fcd5d7e`) deployed via a **surgical `crank/` path-overlay onto `13d6ab7`** (NEVER full checkout). `feedsErrored:0`, existing 6 feeds `feedsPushed:6` unaffected. Until overlaid the meme oracles run on `seed_vol` (tradeable; realized-vol samples don't accumulate). This is the ONLY remaining Wave-1 step.
> - **Session drivers (untracked scratch, `crank/`):** `_mint_sb_feed.ts` (mint: GUARD1→store→GUARD2→resolve→liveness), `_birth_sb_market.ts` (seed vol oracle + migrate/create, sim-gate + fresh-quote retry), `_verify_registry_hashes.ts` (registry self-consistency).
>
> **[HELIUS DEVNET KEY ROTATED — post-leak]** Old key (leaked to a transcript via a `solana balance` CLI error URL) rotated + killed. Live path clean (`.env` `OPTA_RPC_URL` + nginx `set $args` both on the new key, hash-verified); `rpc.opta.fyi/devnet` + crank verified on the new key AFTER the kill (nothing rode the old key). ClickUp `86eyakzgk`.
>   - **⚠️ CORRECTED NGINX MECHANISM (supersedes earlier "sourced from .env" phrasing):** the `rpc.opta.fyi` Helius key is a **DEPLOY-TIME HARDCODE** in the nginx conf's `set $args "api-key=…"` directive — nginx does **NOT** read it from `/opt/opta-crank/.env` at runtime. `.env` and the nginx conf are **two independent edits** on any future rotation.
>   - **Hygiene follow-up (flagged, low-sev):** ~10 historical `/opt/opta-crank/.env.bak*` files hold OLD Helius keys (perms 600, not world-readable, not in git); `.env.bak3` is a documented rollback point. Separate authorized sweep recommended. Vercel `VITE_RPC_URL` flagged for a dashboard check (Helius URL? → rotate there / prefer the proxy).
>
> **RESUME NEXT:** (1) **Wave-1 crank overlay** — deploy `fcd5d7e`'s `crank/sbFeedRegistry.ts` to the VPS (surgical overlay onto `13d6ab7`) so the 4 meme oracles sample; verify `feedsSkippedUnsupported:0`, `feedsPushed:10`. (2) **BTC close ~Jul-19 / SOL ~Aug-1** (reuse `_cutover_rebirth.ts`; same empty-shell class). (3) **Wave-2 equity feeds** (Gate-1 locked, ClickUp `86eya296r`; needs the honest-stale `quotes.opta.fyi` proxy). ClickUp this session: Wave-1 meme births (file token, Engineering).

> **2026-07-16 (SESSION CLOSE — SB CRYPTO CUTOVER + XAU EXECUTED, Blocks 1–2)** — supersedes ALL prior ▶ RESUME markers below (their content stays valid as history).
>
> **WHAT SHIPPED (devnet, admin `5YRMuuoY`):** Four markets closed from Pyth and reborn as Switchboard (`oracle_source=1`) under **canonical names, same PDA, warm oracle inherited by feedHash** — the Pyth→SB crypto cutover (XRP/FARTCOIN/ETH) + the XAU gold migration. Warmup gate was GREEN (5/5 SB crypto vol oracles ≥168 @ ~10:00Z; anchor met exactly). One at a time, close→create as an uninterrupted sequence, verified between each.
>
> | Asset | Market PDA (unchanged) | feedHash (SB) | close sig | create sig | vol oracle @ verify |
> |---|---|---|---|---|---|
> | XRP | `3LjAQGDSZXYoEVgg4rfdU19BGtzjtdyxMShEeu3anRc3` | `a1c4ce28…8405f736` | `evC8pknq…aire3C` | `3sahzxRi…gr26E` | `Fm7i7sQd…h5Ko` sc=171 |
> | FARTCOIN | `Em7EoNJztXXYhguCMZyVUbzCfSqQCmnddAXD6GGfB7rE` | `9612492e…7357a5f2` | `4Z5wyAbe…AMgcWD` | `2HSt3wHR…knAMq2` | `Gx9nCPhw…JGvN` sc=171 |
> | ETH | `HouoTH9ZLxB3q1oCv7ZKH4o4vyRyCNYGiDReVDWeztFu` | `1d8f55a0…9349caa3` | `2Rc7bsH5…QWToRT` | `2BoNqwBY…25SpLAq` | `96DDVTbJ…drAB` sc=171 |
> | XAU | `BX6rrhdd6EnYuHMNRceFHw2GCaQjXuA3rVhi4cmG3BYY` | `6c3c5cc7…1167355e` | `47nzA5DJ…FNnp9` | `5heyxBF4…CXkagW` | `AK8M6ZKb…TfFcF` sc=480 |
>
> All four verified: `oracle_source=1`, on-chain feedHash **byte-matches** the manifest, assetName canonical (no suffix/provenance), warm vol oracle resolves for the feedHash (crypto ~171, gold 480). Two create legs took a 2nd attempt (FARTCOIN: transient ed25519 message-consistency; ETH: transient signed-quote oracle-key mismatch) — the driver's fresh-quote retry landed both; public crossbar throughout, no die(21), no marketless window persisted.
>
> **ETH OVERRIDE RECORD (Ruling 1):** ETH's close was preflight-REFUSED by design (42 live child vaults). Immediately before close the driver re-decoded all referencing vaults: **63 referencing, 42 live, 42/42 all-zero shells** (`settled=false, voided=false, total_collateral=0, total_shares=0, vault_usdc=0`), **0 non-shell live** → founder-approved override applied, close proceeded. The 42 empty shells re-associate cosmetically with the reborn ETH SB market (nothing at stake). **XAU (Ruling 2):** in-session preflight → **3 referencing, 1 live, 1/1 all-zero shell** (the drained $4,500 gold husk `8DLZ` from the treasury sweep) → override applied.
>
> **CLOSE-OUT VERIFICATION:**
>   - **Market sweep (read-only):** the SB (`oracle_source=1`) set is now **5** — XRP, FARTCOIN, ETH, XAU + the pre-existing test artifact **SBXAU** (`4pEmVTXd…`). The Pyth crypto (`source=0`) set dropped 10→7. **BTC (`G3PT11Zy…`, `e62df6c8…`) and SOL (`7ke68gTG…`, `ef0d8b6f…`) remain `oracle_source=0` Pyth — untouched** (BTC close ~Jul-19, SOL ~Aug-1).
>   - **Known cosmetic:** XAU and the leftover **SBXAU** test market both carry gold feedHash `6c3c5cc7…` and share the one gold vol oracle (`AK8M6ZKb…`) — by-design (vol oracles are feedHash-keyed/shared); SBXAU display cleanup rides the design overhaul, not this session.
>   - **Crank tick evidence (no deploy — VPS untouched):** the live crank already handles the reborn markets with **no overlay**. Hourly **vol-oracle tick** logs `marketsSkippedSb` (Slice-1 partition dropping SB markets from the Pyth push set — 1 pre-cutover=SBXAU; ticks to 5 at the next 14:00Z run); **sb-oracle warming tick** `feedsPushed:6 feedsErrored:0` (all crypto+gold SB feeds sampled — this is what warmed the reborn oracles 168→171 during the session); post-cutover **settle tick** `tuplesFound:6` are the pre-existing off-hours equity 404s (`errorsHermesNoUpdate`), the 4 SB markets correctly absent from the Pyth settle set; `finalizeVaultsErrors:0 reclaimErrors:0`. Crank wallet `5sHZ…` 24.31 SOL; crossbar container healthy.
>   - **FE (Stage 3 Slice 2) = SHIPPED** (`c0eb003`, master+main): `app/src/hooks/useSpotPrices.ts` + `spotSources.ts` render SB-source (`oracleSource:1`) spot via the same-origin `/xbar/` proxy with an on-chain `last_spot_price` "as of HH:MM UTC" fallback → **the reborn markets already render spot in the web FE** (no FE change needed this session).
>
> **BLOCK 3 DEFERRED (meme mints — separate gated sub-arc):** JUP/JTO/WIF/BONK + Wave-1 are NOT touched. Reason surfaced this session: **no turnkey SB feed-mint tooling exists** in-repo — `buildSwitchboardCreateMarketTx` creates a market against an *already-minted* feedHash, but the Crossbar-store op that produces a feedHash has no script (Gate B's `35a5adc` mint was a one-shot). The Wave-1 manifest carries **no pre-committed meme feedHashes** (job defs only), so a hand-authored mint is unverifiable → catastrophic-if-wrong. Block 3 needs the mint path located/rebuilt + proven dry (mint → confirm feedHash → register → market ops) as its own gate.
>
> **DRIVER ARTIFACT:** `crank/_cutover_rebirth.ts` — untracked session script (convention of `smoke-create-sb-market.ts`). Parameterized close→create for ONE asset: pre-close scan replicates `preflight_close_market.ts`'s live rule (`!is_settled || usdc>0`) + the approved all-zero-shell override (STOPs on any non-shell live); direct `close_market` ix mirroring preflight byte-for-byte (preflight `--execute` can't be used — it REFUSEs the override cases); fresh-quote create retry ×10 with sim-gate; die(21) escalation never leaves an asset marketless. Reusable for BTC (~Jul-19) + SOL (~Aug-1), which are the SAME empty-shell class. Invocations recorded in-session.
>
> **RESUME NEXT:** (1) **Block 3 (Wave-1 memes)** once the SB feed-mint tooling is resolved. (2) **BTC close ~Jul-19** (`EaV3yxWb` settles Jul-18 → finalize → run `_cutover_rebirth.ts BTC baf182b5… 0 --execute`). (3) **SOL close ~Aug-1**. (4) **Wave-2 equity feeds** (Gate 1 locked — see ClickUp `86eya296r`; needs the honest-stale `quotes.opta.fyi` proxy before minting). ClickUp checkpoint this session: crypto+XAU cutover (file token, Engineering list).

> **2026-07-15 (SESSION CLOSE — DRAIN + BUNDLE DEPLOY + TREASURY SWEEP DONE; CUTOVER + WAVE-1 ARMED FOR JUL-16)** — supersedes ALL prior ▶ RESUME markers below (their content stays valid as history).
>
> **▶ RESUME (Jul-16, ONE combined session; wakeup ~10:00–10:40Z, session-bound — if dead, invoke manually):**
>   1. Verify all 5 SB crypto vol oracles ≥168 + fresh (anchor: 168 @ ~10:00Z).
>   2. **CRYPTO CUTOVER Gate 2** per the LOCKED Jul-14 manifest (no re-derivation): ONE surgical `crank/` overlay (`bot.ts:241` SB-skip + `runSettleGuard` + 4 meme registry entries) + single restart → close+create XRP → FARTCOIN → ETH (same-PDA, close precedes create, source=1, feedHashes per manifest, warm oracles inherit by feedHash) → FE browser verify on prod (names once, provenance-clean DOM, spot + "as of HH:MM UTC" stamp — screenshot; enabling code already live on master) → ETH founder write smoke + settle sim.
>   3. **WAVE 1 Gate 2** (locked): mint 4 SB feeds (IMMUTABLE job defs: BONK=Binance+Coinbase; JUP/JTO/WIF=Binance+Gate) → `initialize_vol_oracle` ×4 seeded (BONK/WIF `1.40e12`, JUP/JTO `1.10e12`) → close+create BONK/JUP/JTO (0-vault Pyth migrations) + create WIF (birth) → XAU close+create source=1 (drained; gold oracle warm 436+, feedHash `0x6c3c5c…`) → BONK write smoke → `sbFeedData.ts` + `sbFeedRegistry.ts` entries → ClickUp per arc (FILE token, line 1). Husk re-association (ETH 63 / FARTCOIN 3) = known cosmetic.
>
> **[SHIPPED THIS SESSION]**
>   - **BUNDLE DEPLOYED Jul-15:** slot **476190764**, hash-verified (1,604,520 B + zero tail). `close_market` + self-trade guard + strike-cap LIVE. ⚠️ **CORRECTION: self-trade error = 6014 `CannotBuyOwnOption`** (6023 = `CollateralCommitted` — old doc stale). `anchor idl upgrade` must run separately (silently no-ops on larger IDL). XAUSMOKE `close_market` live-smoked. Merge **ace835d** master+main. ClickUp `86ey9tafq`.
>   - **DRAIN:** 121 admin vaults, **$2,806,500**, conservation exact, ATA $10,901,761.163.
>   - **WRITER-ASK CLEAR:** the 8 "stuck" vaults = settled WriterAsk vaults (misdiagnosis, NOT a bug; no live culprit path). Cleared via `withdraw_writer_ask_residual` ×8 + close ×8; **$714.83** to rightful backers (6 external). `admin_sweep` NOT built (would misappropriate). Follow-up logged: crank finalize loop should call `withdraw_writer_ask_residual` post-window. ClickUp `86ey9m8rd`.
>   - **TREASURY SWEEP** (ClickUp `86ey9vtu7`): NVDA reclaim **$220,226.217428 → GkG** (holders $0, Inv #6, both founder wallets); burns+withdraws $39,830 + $1,960 + $4,500 (**XAU now CLOSE-READY**); **FIRST LIVE AMERICAN EXERCISE** ×13 (atomic Pyth post + `exercise_american`, 1.4M CU, ~$2.175/contract) → Vault B $0. GkG total **$266,516.217428**. GkG keypair at `~/.config/solana/gkg.json` (600, pubkey-verified — nothing currently pending needs it again).
>   - **FE MINT-GATE live `4053519`:** BTC/SOL writes paused, keyed `oracle_source==0` → auto-frees on rebirth. ClickUp `86ey9upad`. Spot-stamp (`useSpotPrices` + `formatAsOfUtc`) confirmed **ALREADY ON MASTER**; codex/seeker branch is BEHIND master (earlier inverted-diff report corrected).
>   - **SOL BUYOUT DEAD BY CODE:** Vault A OTM PUT blocks exercise; "14 holders" = 3 wallets, 1 genuinely external. Vault B self-unwound. SOL close ~Aug-1 (2 Jul-17 holder vaults settle naturally + `fGvpt9Ao`'s $70 @ Jul-31).
>
> **[AFTER JUL-16]**
>   - **BTC:** `EaV3yxWb` ($650K/5-sold) settles Jul-18 → finalize → close+create ~Jul-19.
>   - **WAVE 2** (spec SIGNED OFF Jul-14): `quotes.opta.fyi` keyless proxy (key-inject + honest-stale + cache) → keyed-job smoke (`variableOverrides` vs SB Secrets) → weekend carry-forward tests XAG/WTI/NATGAS (pass=ship, fail=defer) → 11 equities (Finnhub+Yahoo median, seed_vol, market-hours sampling, Fri-16:00-ET expiries) → second-cutover closes (11/13 non-crypto Pyth markets close-ready; USOILSPOT→WTI, UKOILSPOT→BRENT). SPX/NDX + FX deferred to mainnet.
>   - **seed_vol CONFIRMED DEPLOYED** → seeded-IV birth = instant-tradeable markets.
>   - Then: **auto-writer bot** (crank side-loop, ladders, dry-run+caps) → gamified campaign. Locked design: trader-priced actions 24/7; oracle-priced actions freshness-gated; equity vol market-hours only; forward-priced weekend exercise via existing trigger machinery = a future deploy, spec'd.
>
> **▶ 2026-07-13 — SEEKER MOBILE ARC COMPLETE: Opta 1.0.0 SUBMITTED to the Solana dApp Store (status IN REVIEW).** The entire mobile app lives on branch `codex/seeker-terminal-build` (UNMERGED; it holds the main clone's working tree). Submitted 13 Jul 2026.
>   - **STORE:** release ID `801dec38…`, package `com.opta.seeker`, versionCode **2** / v1.0.0, signed-APK SHA-256 `450929D0AB923619693CBA1F76939B84BD0D7B059D5CC95F9AE036003D26CDB9`. **Publisher wallet `AjMu…Vb1y`** (fresh Phantom, self-custodied, PERMANENT). **App NFT + Release NFT minted** — mint `3sembGLq…`, collection `ARWvanaU…`, tx `3UbgdnAf…`. Portal API key held **env-only** (never committed). Portal **Details tab may still show Draft — it publishes on release approval; re-check after review.**
>   - **INFRA — RPC proxy LIVE `https://rpc.opta.fyi/devnet`:** nginx + certbot TLS on the VPS (144.202.58.6, same box as opta.fyi/sb-create/feeds; sites-available/enabled symlink). `/devnet`→Helius devnet, **key server-side** (`set $args "api-key=…"` sourced from the box's `/opt/opta-crank/.env` `OPTA_RPC_URL`; do NOT use `rewrite … break` — `break` halts the rewrite phase and skips the injection → Helius "missing api key"). `/mainnet` reserved (404); per-IP `limit_req` 20r/s; CORS `https://opta.fyi`. Repo conf `deploy/nginx/rpc.opta.fyi.conf`. **Store APK bakes the proxy URL and carries NO key** (bundle verified: `rpc.opta.fyi/devnet`=1, helius=0, api-key=0). This fixes the public-devnet-429 permanent-skeleton bug (a keyless build fell back to `clusterApiUrl("devnet")` which 429s every gPA scan); paired with a 15s scan `withTimeout` (`748314a`) so a stalled RPC surfaces the existing error→Retry instead of infinite skeletons.
>   - **KEYS CUSTODY:** release keystore (`D:\claude everything\keys\opta-release.keystore`, cert SHA-256 `08:7F:F9:CB…`, RSA-4096 valid→2056) **+ publisher wallet BACKED UP (Bitwarden + Drive); keystore password ROTATED** (the original was printed to a transcript, now dead — the live value exists only in gitignored `mobile/android/keystore.properties`).
>   - **SITE:** `/privacy`, `/support` (contact = X `@optafinance`), `/terms` are LIVE on opta.fyi (shipped directly to master+main, editorial paper pattern). **Legal caveat:** `/terms` covers ONLY the founder-given substance — NO invented governing-law / arbitration / liability / indemnification clauses; **real counsel required before mainnet.**
>   - **BRANCH — `codex/seeker-terminal-build` MERGED to master at `a556f0c` (2026-07-13, plain merge commit; branch kept on origin as historical record; only HANDOFF.md conflicted → union). Original merge plan (executed):** the arc is `mobile/*` ADDITIONS + a few shared touches — IDL byte-parity `8454793901…` across `target/idl` + `app/src/idl` + `mobile/src/idl`; `deploy/nginx/rpc.opta.fyi.conf`; root `.easignore`; `.gitignore` keystore/keys patterns. **Web-deploy safety check BEFORE merge:** master is AHEAD of codex in `app/` (the site pages `/privacy` `/support` `/terms` shipped straight to master — a naive merge could REVERT them). Verify: `app/` diff is additive-only, no `app/src/App.tsx` conflict (site routes live on master), IDL byte-parity holds post-merge, nginx conf lands. Mobile store binaries (`mobile/assets/store/*` are committed; keystore.properties + node_modules stay gitignored/local).
>   - **ROADMAP:** v1.1 = mobile CLOB read + fill (mobile Trade currently reads only vault-mint-unsold + resale — no `RestingOrder`/`WriterAskPosition`; the "17-Jul-SOL missing expiry" was CLOB-only liquidity invisible to mobile). v1.2 = limit posting. **S5 backlog:** `normalizeAccount` regression test (base58 string→PublicKey), tx-harness as a pre-APK gate (build+simulate both flows vs devnet), monochrome themed-icon glyph (the dot alone), decode cross-check test (VolOracle offsets vs Anchor coder), real legal counsel on `/terms` before mainnet.
>   - **POST-REVIEW TODO:** verify the listing goes live on a real Seeker → confirm install + data load through `rpc.opta.fyi/devnet` → RPC-quota delist-risk check (Helius devnet quota vs public store traffic; the per-IP `limit_req` protects it but watch usage after approval).
>   - **SESSION CLOSE:** ClickUp checkpoint logged `86ey9cxnt` (seeker merge + store submission). **NEXT SESSION = SB CRYPTO CUTOVER (~Jul 20, HARD DATE).** Prerequisite: **program-upgrade bundle deploy** (`close_market` + self-trade guard `6023` + European strike-cap) from the parked `feat/program-upgrade-bundle` worktree — **must reconcile against current master FIRST** (master now includes the seeker merge `a556f0c` + Stage-3 Slices 2/3, so the bundle's base has moved) before any deploy. Then: SB crypto market creation under canonical names via `close_market` name-handover + the deferred **visual spot+stamp verification on the first visible SB market**. **Watching:** dApp Store review status; Helius quota vs store traffic post-approval.
>
> **▶ 2026-07-12 — Stage 3 Slice 3 (SB settlement self-indexer) SHIPPED ✅ + LIVE.** master+main `2bb3621` (squash of `feat/stage3-self-indexer`; branch deleted). Crank-only; NO Rust, NO on-chain anchoring. Switchboard signed quotes are unrecoverable ~3.5min after use — so at each SB settle CONFIRMATION we persist one re-verifiable attestation.
>   - **`crank/settlementArchive.ts`** — pure record builder (key `sb-settle:{asset}:{expiry}`: `edIx.data` base64, broken-out sig triples, feedHash, spotFromMsg [i128 LE @ msg offset 64, ÷1e12], on-chain settlementPrice + recentSlot, settleTxSig, queue/programId) + **NON-THROWING `archiveSbSettlement`**. **`crank/sbOracleCrank.ts`** — captures the `{ixs, captured}` triples at the settle quote build; archive block fires AFTER the confirmed-send (`send` confirms at `"confirmed"` + throws on err; dry-run/forced/wiring branches `return` before send → archive only on a real confirmed settle); `archived`/`archiveErrored` counters on `SbSettleReport` + end-of-pass settle-check log. **`scripts/verify-sb-settlement.ts`** — standalone offline sig-verify (reuses `decodeAndVerifyEd25519`) + on-chain cross-check (`settlement_price` + the **`pyth_publish_time`-repurposed-as-`recent_slot`** for SB); exit codes 0/2/3/4/5/6.
>   - **ARCHIVE DESIGN — JSONL-as-truth / Upstash-as-convenience.** Step 1 (durable source of truth): append one JSON line to `/opt/opta-crank/sb-settle-archive.jsonl` (env `OPTA_SB_ARCHIVE_JSONL`; dir is `ReadWritePaths` for the `opta` user under `ProtectSystem=strict` — writable). Step 2 (best-effort): raw-`fetch` Upstash SET, **no `@upstash/redis` dep**. Neither sink can throw out of the helper — **settlement is never blocked/delayed by an archive failure.** KV env absent ⇒ Upstash silently skipped (`upstashOk=true`); `archiveErrored++` only on a *configured-and-failed* SET.
>   - **DEPLOY = surgical `crank/` path-checkout (JSONL-only, opt (b)).** `git -C /opt/opta-crank checkout origin/feat/stage3-self-indexer -- crank/` onto HEAD `13d6ab7`, pinned post-tick, restart `--no-block`. **VPS overlay state now = `13d6ab7` + Slice-1 guards + Slice-3 archive** (9 crank files over HEAD; HEAD unmoved). Rollback = `git checkout HEAD -- crank/` + restart. Verified 2026-07-12 ~19:03 UTC: clean restart (`NRestarts=0`), no module errors, JSONL path writable, warmup **6/6 unaffected** at 20:01, archive path correctly dormant (no SB settles → counters 0). Expiry re-verify was CLEAR (the one SB vault `Ad5zz684`/SBXAU is a $0 voided husk 259h past expiry — can't trigger `settle_expiry`).
>   - **PARKED — verifier Step 3** (signer ∈ queue authorized-oracle set) deferred: offline verify + on-chain match suffices for loss-protection (the on-chain `settle_expiry` SB arm already enforced queue-authorization via `QuoteVerifier` before writing the price). **MUST land before the verifier is presented as institutional-grade audit tooling** (rides the indexer arc or the SB-anchor-dep decision).
>   - **PARKED — optional KV wiring (ops).** Upstash convenience is dormant until the founder copies `KV_REST_API_URL` + `KV_REST_API_TOKEN` from the **Upstash dashboard directly into `/opt/opta-crank/.env`** (values never transit CC — `vercel env pull` does NOT expose these integration-managed secrets). Helper picks them up on next crank restart, **no code change**.
>
> **▶ 2026-07-12 — Stage 3 Slice 2 (FE routing) SHIPPED ✅ + LIVE.** master+main `c0eb003` (squash of `feat/stage3-fe-routing`; branch deleted). SB-aware spot display + Write-dropdown leak fix + planner skip-own tests. Pyth path byte-identical (`usePythPrices.ts` untouched). Founder-verified on preview: `/xbar/` proxy live in-browser, Pyth spots normal, Write dropdown clean, self-trade skip proven point-blank (own bid+ask at identical price → zero execution; market orders skip own orders; vault fills work where capacity exists, 75C 3-of-3).
>   - **Source-aware hook** (`app/src/hooks/useSpotPrices.ts` + pure `spotSources.ts`): source==0 → `usePythPrices` UNCHANGED; source==1 → same-origin `/xbar/` proxy (`VITE_XBAR_BASE`) with on-chain `last_spot_price` (i64 @1e12) auto-fallback rendered as muted-mono "as of HH:MM UTC" on Markets/Trade/Write. 7 display sites wired, no output-contract change. **Write leak fix:** both chip-builders route through `canonicalAsset()`. **Planner:** skip-own-order is VERIFY-ONLY (predates the self-trade guard) + 4 unit tests + entry-point audit → **the program-upgrade bundle's FE sequencing gate is satisfied by tests, not new code.** Gates: tsc/build/provenance-0, planner 6/6, spotSources 16/16, Write-leak rendered-DOM proven, `feeds.opta.fyi` browser-proven.
>   - **OPS — `feeds.opta.fyi` LIVE.** New nginx TLS block (`/etc/nginx/sites-available/feeds.opta.fyi`, comments genericized — no provider terms) reverse-proxies loopback `127.0.0.1:8080` (the local price service, never publicly exposed); Let's Encrypt cert (exp 2026-10-10, auto-renew). `app/vercel.json` has ONE `/xbar/:path* → feeds.opta.fyi` rewrite (browser stays same-origin → **zero CSP change**). `VITE_XBAR_BASE=/xbar` set in Vercel **Production + all-Preview** (value-length-verified = 5). **`sb-create.opta.fyi` HANDOFF item CLOSED — found already-live** (enabled nginx block + cert + `/liveness` HTTP 200; the "long-open" item was already done).
>   - **⚠️ GATE LESSON (cost us ~an hour):** **CLI `vercel deploy` from a git *worktree* does NOT record a branch, so branch-scoped Vercel env vars are IGNORED at build.** ALL preview env vars must be scoped **all-Preview-branches**, never branch-specific. Both `VITE_XBAR_BASE` and `VITE_RPC_URL` bit us this way. Also: this Vercel project has **no git-integration preview builds** (a branch push produces nothing — previews are CLI-only), and CLI deploy uploads the **working tree**, so the CRLF `Opta_Whitepaper_v1.md` (autocrlf artifact; committed blob is LF) breaks the whitepaper-slicer — normalize to LF for the upload (uncommitted) or the build fails. `.gitattributes eol=lf` on the whitepaper would kill this permanently.
>   - **CUTOVER CHECKLIST += "visual spot+stamp on first visible SB market."** The SB spot+stamp RENDER path is code-gated (spotSources 16/16) but NOT yet browser-verified, because every current `oracle_source==1` market has a HIDDEN name (SBXAU/XAUSMOKE → `canonicalAsset`→null) and the 5 crypto have no market yet — so nothing visible routes to the SB branch until cutover recreates the crypto markets with real names. Verify the live spot + "as of HH:MM UTC" stamp on the FIRST visible SB market at cutover.
>   - **PARKED — UX polish (non-blocking, later slice):** when the only crossable liquidity is the taker's OWN orders and/or an exhausted vault, the order ticket shows the generic "no resting bid/ask within slippage" — should say **"only your own orders are crossable"**, and vault rows should indicate **depleted capacity**. Cosmetic copy only; the skip/partial behavior is correct.
>
> **▶ 2026-07-11 — ON-CHAIN TRACK: Stage 3 Slice 1 (crank SB-skip guards) SHIPPED ✅ + LIVE.** master+main `05fb47b` (squash of `feat/stage3-crank-guards`; branch deleted). Two Pyth-only cranks got the source skip-route their siblings already had, BEFORE SB markets exist at cutover.
>   - **volOracleCrank** `partitionPythMarkets()` drops `oracle_source==1` before feed discovery (an SB market stores its SB feedHash in `pyth_feed_id`, deriving the SAME `[b"vol_oracle", feed_id]` PDA the sb-oracle crank owns → a Pyth push would win an init race + seed a Pyth-source oracle, or be SB-arm-rejected); `report.marketsSkippedSb`. **triggerCrank** `buildTriggerMarketMaps()` excludes SB from the Hermes feed set + skips their orders (`report.skippedSbMarket`) — the trigger crank is live+sending, so this was a pre-cutover blocker, not theoretical. **livenessCrank + sbCreateMarketEndpoint** now honor `OPTA_CROSSBAR_URL` so ALL live SB traffic self-hosts. +6 unit tests (vol 3 / trigger 3); `tsc --noEmit` clean.
>   - **VPS DEPLOY = SURGICAL `crank/` PATH-OVERLAY (deliberate, recorded).** VPS runs branch `main` @ `13d6ab7` — **17 commits behind master** (16 are the FE terminal arc). The crank imports `@app/*` (safeFetchAll +44, constants +42, pythPullPost…, 611 lines / 14 files across the gap), so a full checkout would drag FE churn into the live warmup crank mid-flight. Instead: `git -C /opt/opta-crank checkout origin/feat/stage3-crank-guards -- crank/` (crank/ is byte-identical between `13d6ab7` and master except this commit; the guards add ZERO new `@app` imports) → `systemctl restart --no-block`. HEAD stayed `13d6ab7`; rollback = `git checkout HEAD -- crank/` + restart. Deployed 2026-07-11 ~21:06 UTC after a clean hourly tick; verified live: `marketsSkippedSb:2`, `skippedSbMarket` field present, warmup `sample_count` **59→60** through the restart (on-chain state, unaffected).
>   - **PARKED — VPS full sync to `main` tip** = a post-cutover DELIBERATE deploy with its own verification pass. **Until then, ALL crank deploys are surgical `crank/`-path checkouts** onto `13d6ab7`, never a full branch checkout (protects the mid-warmup `@app` dependency surface).
>   - **XAUSMOKE = first `close_market` sweep candidate** (market `4FU8cV8sMdWJX4GDvwBzp52YHoummFc7pCoHmqq9Z3Qf`, gold smoke-test seed, FE-hidden via `canonicalAsset`→null; feedHash `47634b5791…`, i.e. the sb-crank's lone "unsupported" feed). Sweep during the program-upgrade deploy's post-deploy cleanup.
>   - **Instruction-count correction:** the deployable (feature-free) count is **50**, not the stale "42" cited in older notes.
>   - **Multi-agent note:** a parallel **seeker/codex** arc (`codex/seeker-terminal-build`, mobile terminal build) holds the main clone's working tree — OUT OF SCOPE / untouched. This ship ran via an isolated `../opta-merge` worktree so the seeker tree was never disturbed.
>   - **Program-upgrade bundle** (self-trade guard + EUR strike-cap + `close_market`) authored + committed on `feat/program-upgrade-bundle` (`3d51117`, pushed, **UNMERGED** — merges during the founder-gated deploy) with `PROGRAM_UPGRADE_BUNDLE_DEPLOY.md`; its FE skip-own-level sequencing gate is satisfied by Stage 3 Slice 2's planner tests (the skip predates the guard — locked by tests, not new code).
>   - **NEXT — Stage 3 Slice 2 (FE routing), branches off `05fb47b`:** SB-aware spot display (source-aware hook: `/xbar/` env proxy → neutral `feeds.opta.fyi`, with on-chain `last_spot_price` "as of HH:MM UTC" auto-fallback), Write-dropdown `canonicalAsset` leak fix, planner skip-own unit tests + entry-point audit. Ops sub-step (two-gated): nginx `feeds.opta.fyi` + rider `sb-create.opta.fyi` + certbot + `vercel.json` `/xbar/` rewrite.
>
> **▶ RESUME HERE (2026-07-11) — FE TRACK.** **4-page terminal migration COMPLETE** (Markets · Trade · Write · Portfolio) + **Portfolio polish Slice A shipped** (collapsible sections · BY ASSET rollup · cross-page solscan sweep; master+main `a7786f9`) + **Create-market terminal shipped** (`39306f8` — terminal cockpit · cluster-smart mint resolver · six-string provenance leak fix; **+ mainnet-transport 403 fix `35b7a0f`** — publicnode default; see the CREATE-MARKET block below). Next candidate FE slices (no active brief): Trade trigger-placement UI · strategy writer · Utilities terminal reskin · Activity full vocabulary · Markets State-A solscan links — see Parked Items. Pipeline: **brief → Claude Design lock → recon-gated build → rendered-DOM gates → preview verify → squash-ship.**
>   - **⚠️ STANDING RULE — ONE active CC slice per clone.** Parallel slices on ONE working tree collide (this session: a Portfolio-polish slice and a create-market-terminal slice shared the tree — B's uncommitted WIP broke the build mid-gate + entangled staging). **Parallel slices REQUIRE separate `git worktree`s** (`git worktree add ../opta-<slice> <branch>`), each its own branch. Stage by explicit path always; never `git add -A`. Re-verify `git branch --show-current` + `git status` before any commit.
>   - **PENDING — live production crossing confirmation:** the multi-level market sweep + marketable-limit crossing are **surface-verified on prod only** (opta.fyi `5933025`). A founder wallet click to exercise a real sweep / cross tx on production is **not yet done**.
>   - The **on-chain track (parallel, still live — SB warmup cutover ~Jul 20 + Pyth expiry)** is the block directly below; unchanged.
>
> **[CREATE-MARKET TERMINAL — SHIPPED ✅ 2026-07-11, `39306f8`]** Terminal reskin of the New-market modal (locked design 1a) behind `CREATE_MARKET_TERMINAL_UI` (default true); legacy paper modal retained byte-identical as the flag's fallback. Both submit arms (Pyth / SB) unchanged except the one approved fix. Gate `scripts/check-create-market-visibility.mjs` = 8 pass / 4 skip / 0 fail; `npm run build` green.
>   - **Six-string provenance leak fix.** The recon sweep found SIX rendered provider strings, not the two known Hermes ones — genericized all six (2 Hermes catalog banners + the loading placeholder + the shared `hermesCatalog` error string + 2 Switchboard toasts in `newMarketCreate.ts`/legacy `mapSbError`). Gate asserts `hermes|switchboard|pyth|ewma` = 0 across every open-modal state.
>   - **Smart crypto asset input — cluster-smart mint resolver (`resolveMintSymbol.ts`).** Paste a token mint → resolve its symbol, then anti-spoof match a CANONICAL catalog asset ("Matches catalog asset: X"); the feed always comes from the matched catalog row, the pasted mint NEVER reaches the chain, so cross-cluster reads are safe by construction. Chain: **Token-2022 metadata ext → Metaplex PDA (raw borsh)**, run against whichever cluster found it. **Probe *first* the app cluster (devnet), and on ANY non-resolve fall through to public mainnet-beta** (`api.mainnet-beta.solana.com` — already in the CSP `connect-src`, no `vercel.json` touch). **Root cause of the BONK bug (probe-proven):** popular mints exist on devnet as **bare clones with no metadata**, so a "cross-cluster only on account-*absent*" rule got stuck at no-metadata and never reached the real mainnet metadata — the fix falls through on absent/no-symbol/read-error/rpc-error alike. Read-only probe against the live module (deleted, not committed): `BONK → resolved "Bonk" (mainnet metaplex)`, `PYUSD → resolved "PYUSD" (mainnet t22)`, `fresh keypair → not-found`. Owner-branch skips a redundant T22 read for classic mints; one retry on a thrown `getAccountInfo` (public RPC rate-limits bursts); `console.debug` logs cluster + path.
>   - **Four-state failure set:** `INVALID` (malformed address) · **`not-found`** ("Token not found." — absent on both clusters) · `no-metadata` ("Couldn't read token metadata for this address." — exists but no symbol) · `no-feed` ("No price feed exists…" — symbol resolved, no catalog match).
>   - **Other debt closed:** `oracle_source` now forwarded into the Pyth `create_market` builder (killed the hardcoded `0`); success moment → **`/write?asset=` deep-link** (`WriteTerminalPage` reads the param, validated fallback); create-success **`invalidateAccountScans(program, ["optionsMarket"])` + markets refetch** (lifted `useMarketsData` to `MarketsPage` — closes the AppNav-era cross-owner gap); `useIsAdmin` docstring corrected (creation is permissionless).
>   - **Two accepted judgment calls:** (1) the `/markets` "New market" entry opens the modal **regardless of connection** — the modal owns its own "Wallet not connected." + Connect state (per design 1a); **AppNav's separate entry is parked/untouched**. (2) The pending lifecycle shows the tx **sig at the success moment, not mid-flight** — threading the sig into "pending" would need a callback into the shared submit path and break the byte-identical guarantee.
>   - **[TRANSPORT FIX — 2026-07-11, `fix/resolver-mainnet-transport`]** The first ship's mainnet probe used `api.mainnet-beta.solana.com`, which returns **HTTP 403 to browser-origin requests** (proven in-browser; the Node probe passed only because it has no origin) → BONK still yielded `no-metadata` on prod. Fix: `getMainnetRpcUrl()` (env.ts) → **`VITE_MAINNET_RPC_URL` or a browser-CORS-friendly default `https://solana-rpc.publicnode.com`** (200 + `acao:*`, keyless, no Vercel-env dependency). CSP `connect-src` += publicnode (one deliberate committed line, parked-local exception #2). New **`transport-error`** resolve state ("Couldn't verify this token right now — retry." — retryable) reserves `no-metadata` for a *successful* read with no symbol. **In-browser proven** (real modal, system Chrome): BONK → `resolved` "Matches catalog asset: BONK", publicnode 200×2. Gate adds a browser-origin transport guard (publicnode 200 / labs 403).
>   - **MAINNET CHECKLIST (added):** re-verify the **full memecoin listing flow at mainnet** (create → write → trade). The resolver + mainnet transport are now browser-proven (BONK resolves via publicnode from a real browser origin), so this is an end-to-end flow check, not a resolver/transport risk.
>   - **PROCESS ADDENDUM (standing):** **Node probes prove LOGIC, not browser TRANSPORT.** Node has no CORS/origin, so cross-origin calls that a browser blocks (403/CORS/rate-limit) pass silently in Node. Any feature that crosses origins (a non-app-RPC host, a third-party API) MUST be verified from a real **browser context** (Playwright + system Chrome, network captured) before ship — see the resolver-transport bug above.
>
> ---
>
> **2026-07-09 (SESSION CLOSE — JUL-8 RECLAIM FLIP EXECUTED + SB MIGRATION GATE D DEPLOYED + SB WARMUP RESCUE (SELF-HOSTED CROSSBAR + ROBUSTNESS) + PYTH EXPOSURE SCANNED). ON-CHAIN RESUME — supersedes the 2026-07-07 "▶ RESUME HERE" (its items 1 + 2 are now DONE).**
>
> **▶ ON-CHAIN RESUME (SB cutover ~Jul 20 + Pyth expiry, in order):**
> 1. **SB WARMUP MONITOR → CUTOVER (~Jul 20).** 5 crypto SB vol oracles warming; **168h clock anchored at `sample_count=1` = 2026-07-09T11:00:50Z → warm ~2026-07-16T10:00Z** (~4d before cutover). Warmup RESCUED this session (see the crossbar block): public crossbar was flaky (tick2 = 0/5 crypto), now on **self-hosted crossbar** (proven 6/6) + mid-hour retry. Watch `sample_count` climb hourly on BTC/ETH/SOL/XRP/FARTCOIN (all should reach 168 barring outages). At warm: stop new Pyth crypto mints → last Pyth vaults expire/settle → `close_market` old 5 → `create_market` real names `source=SB` (Gate C2 `close_market` + cutover deploy still undeployed — ships here).
> 2. **PYTH EXPIRY — WRITER-SIDE ONLY, no gate needed (holder scan done).** 186 live Pyth vaults; **46 expire 2026-09-25** (> Jul-31) but **ALL 46 have 0 third-party holders** (0 outstanding option tokens; every canonical mint supply = 0). $956,780 is writer collateral, returned by the proven reclaim path → **no holder harm, self-resolves**. Optional: $500 one-month Hermes bridge to settle normally, or nothing. Max mintable expiry is UNBOUNDED (no upper-bound check) → a future-mint Pyth expiry gate is **writer-UX only, not holder-safety** — build only if desired.
> 3. **Pending user actions (carried):** Vercel dashboard redeploy (cache UNCHECKED). (`VITE_RPC_URL` now SET on Vercel Preview + Prod — `reference_vercel_env_gap` CLOSED 2026-07-10.)
>
> **[JUL-8 RECLAIM FLIP — COMPLETE ✅ 2026-07-09]** Executed via the crank's `runReclaimSweep` (VPS `opta-crank`, HEAD then `a2e1a1a`). Flag `OPTA_RECLAIM_CRANK_ENABLED=1` **KEPT ON permanently** (Nanko decision). **5 vaults wound down** (voided, NOT settled — invariant #6; holders paid $0 by design): `Ad5zz684…`(SBXAU), `BAhgX8uA…`(BTC husk, 0 writers), `GteYo9R…`(MSFT), `8xW8ewi…`(TSLA), `5HUGDsiQ…`(**MSTR $175k — authorized as 5th target after read-only vetting: 0 VaultMint records / 0 holders / feed-parity-identical to the approved MSFT+TSLA**).
> - **Exact conservation: $399,575.378947** moved, verified to the micro-USDC (Σ ATA increases == Σ payouts). Crank-reported `usdcMoved` metric = **$399,365.378947** (excludes Ad5's $10 pool via the net-negative-drawn quirk at [reclaimUnsettled.ts:324-325](crank/reclaimUnsettled.ts#L324) + the $200 residual — both expected). Reclaim gas **0.000050000 SOL** (10 tx × 5000 lamports). Post-sweep ATAs exact: `DnExEYnZ`=$5,081,454.944760, `GkG1UX8M`=$3,013,110.441916, `5YRMuuoY`=$7,163,137.663081.
> - **All sweep paths live-proven** (2nd tick found 0 candidates, no re-processing, 0 errors). **10 sigs** (5 `initialize_void` + **4** `reclaim_unsettled` [BTC 0-writer → no reclaim] + 1 `reclaim_writer_ask_residual`):
>   - `initialize_void`: MSTR `PcnDRayb…h5Fb` · TSLA `2EUWj6WY…X3Gd` · Ad5 `57S2ZLMD…HHQ6` · BTC `oDq6zJxD…dJSm` · MSFT `2ufJg9qU…xfXM`
>   - `reclaim_unsettled`: MSTR `225JxMWz…bwhm` · TSLA `2yMczoCc…VBzb` · Ad5 `5W6UeLzr…WnNS` · MSFT `pNMp9hie…7ktk`
>   - `reclaim_writer_ask_residual` (Ad5 pot → backer `5YRMuuoY`, $200.000000): `5eDE3PU3…ge6E5`
> - **The July-8 4-candidate runbook is SUPERSEDED/DONE** (executed as a 5-candidate sweep; MSTR added mid-flight after vetting).
>
> **[SB CRYPTO MIGRATION — GATE D DEPLOYED ✅ 2026-07-09]** The warmup mechanism is **config, not a new code branch**: the existing `sbOracleCrank.ts` `OPTA_SB_FORCE_FEED` ops-hook already does registry-filtered pre-market warming. **Deploy = VPS `git pull --ff-only` `a2e1a1a`→`1e73ada`** (ships `35a5adc` = the 5-feed registry; ff-safe, no dep change, IDL unchanged, `VOL_ORACLE_SEED` intact) **+ `OPTA_SB_FORCE_FEED`=<5 crypto feedHashes>** appended to `/opt/opta-crank/.env` (backup `.env.bak-pre-gated`). Restart → boot warming tick pushed **all 5** crypto oracles (`feedsSupported:6 feedsPushed:5`; the 1 error was gold's transient SB-gateway miss, retries next hour). **168h warmup anchored ~2026-07-09T09:06Z** (first push reseeded stale birth baseline → `sample_count` starts climbing next hour). PDAs: BTC `35Ruih…`, ETH `96DDVT…`, SOL `8Ag1qR…`, XRP `Fm7i7s…`, FART `Gx9nCP…`. All other loops unaffected, 0 errors post-deploy. (Tick-2 10:00Z then FAILED all 5 crypto on the public crossbar; tick-3 11:00Z recovered 6/6 → `sample_count=1` — the public crossbar is unreliable, which drove the crossbar-rescue below.)
>
> **[SB WARMUP RESCUE — SELF-HOSTED CROSSBAR + PUSH ROBUSTNESS SHIPPED ✅ 2026-07-09, `13d6ab7`]** Public crossbar (`crossbar.switchboard.xyz`) proved unreliable across 3 ticks (5/1 → 0/6 → 6/0), and the on-chain reseed gap is only **2h** (`VOL_ORACLE_MAX_SAMPLE_GAP_SECS`) → intermittent misses threatened to keep resetting `sample_count`. **Root fix — self-hosted crossbar:** Docker (`switchboardlabs/rust-crossbar:stable`) at `/opt/crossbar` on the VPS, bound **127.0.0.1:8080-8081**, `mem_limit 512m`, `SOLANA_DEVNET_RPC`=Helius. Proven **6/6 feeds** via the real managed-quote path (0.4–1.5s each) vs the public one failing. **Code (`sbOracleCrank.ts`):** (A) `CROSSBAR_URL` env-driven via `OPTA_CROSSBAR_URL` (set `=http://localhost:8080` in `.env`, backup `.env.bak-pre-crossbar`); (B) 7s inter-feed stagger; (C) `SB_PUSH_MAX_ATTEMPTS` 4→8; (D) **mid-hour retry sub-cadence** (+10/+20/+30min on `failedFeeds`) so a transient miss can't silently exceed the 2h gap. Both typechecks clean; crank pulled `1e73ada`→`13d6ab7` + restarted (PID 86222), boot config shows `OPTA_CROSSBAR_URL=http://localhost:8080`, reclaim still `{enabled,dryRun:false}` `reclaimCandidates:0`, 0 errors. **NOTE:** boot warming tick failed 6/6 with `6046 VolOraclePushTooSoon` — EXPECTED (tick-3 pushed <55min prior); the local crossbar served the quotes fine (reached sim). **Authoritative warmup anchor: `sample_count=1` @ 2026-07-09T11:00:50Z → 168 @ ~2026-07-16T10:00Z** (supersedes the earlier ~09:06Z estimate). ⚠️ `.git` on the VPS needed a `chown -R opta:opta` (340 root-owned objects blocked the pull) — watch for recurrence. **Gotcha for the tight 1.9GB box:** don't run 2 ts-node probes concurrently (OOM → SSH drop); crossbar itself is lean (~67MB).
>
> **[PYTH EXPIRY EXPOSURE — HOLDER-SCAN DONE: WRITER-SIDE ONLY, no gate needed]** 186 live Pyth vaults; **46 expire 2026-09-25** (> Jul-31). Holder-side scan: **ALL 46 have 0 third-party holders** (0 outstanding option tokens; every canonical mint supply = 0 — pure writer seed inventory). $956,780 vault_usdc is writer collateral, returned by the proven reclaim path → **no holder harm; self-resolves**. Max mintable expiry = **UNBOUNDED** (no upper-bound check in `create_shared_vault`/`create_series`). A future-mint Pyth expiry gate (`require!` on `oracle_source==0` creation, cutoff e.g. 2026-07-31) is **writer-UX only, not holder-safety** — build only if desired. Optional: $500 one-month Hermes bridge to settle the 46 normally, else they reclaim.
>
> ---
>
> **2026-07-11 (FE — PORTFOLIO POLISH SLICE A SHIPPED: collapsible sections + BY ASSET rollup + cross-page solscan sweep. Squash-merged `feat/portfolio-polish` → master + main as ONE commit `a7786f9`. Founder browser-verified on Vercel preview. Frontend-only; all instruction paths byte-identical.)**
>
> **[PORTFOLIO POLISH — LIVE on master + main 2026-07-11]** Three additions on the locked 1c terminal vocabulary (no new design round):
>   - **Collapsible sections** — HOLDINGS · WRITTEN · ACTIVITY · UTILITIES + the new BY ASSET band each collapse from their header band (whole band is a `<button aria-expanded>` with a rotating chevron; count + accent border stay visible when collapsed). Per-section state persists to `localStorage["opta.portfolio.sections.v1"]`; UTILITIES default-collapsed. `useSectionCollapse` hook; `SectionBand` extended (portfolioUi.tsx). Data hooks live in the PAGE, so collapse never unmounts a provider — summary strip + BY ASSET stay live while collapsed.
>   - **BY ASSET rollup** (`assetRollup.ts` + `ByAssetSection`) — new band between the summary strip and HOLDINGS, one row per asset with any exposure. **WRITER P&L** is the green/red health number: `Σ(premiumClaimed+claimable) − Σ(mark × optionsSold)` per asset, using the SAME mark the ledgers show (settled → intrinsic `payoutPerContract`; live → B-S at spot). Missing spot → mark unavailable → row shows `—` + a muted **`partial`** tag and that vault is EXCLUDED from the P&L sum (never 0.00). Columns: PREMIUM EARNED / HOLDINGS VALUE / CLAIMABLE / COLLATERAL. Honest footnote "Writer P&L is mark-to-market on sold contracts. Holder P&L pending indexer." — **no holder-PnL column.** Honesty bias (approved): `optionsSold` is cumulative — early-American-exercise reduction isn't tracked FE-side, so a live American vault's liability can be slightly OVERstated (P&L reads worse, never better).
>   - **Solscan sweep** — new canonical `components/SolscanLink` (kinds `tx`/`token`/`account`, mono external-link glyph, `--text-3`→`--text-2`, cluster-aware, builds `solscan.io/{kind}/{id}?cluster=devnet`). Applied everywhere an on-chain identity renders: Portfolio holder rows (mint) · writer rows (vault) · ACTIVITY sigs; Trade dock positions (mint/vault) · order+trade history sigs · open-order rows (order PDA); Write success banner (sig + mint + vault); Markets **ContractInspector** (mint). The legacy paper drill-down was renamed **`SolscanLinkLegacy`** (utils/solscan.tsx; 2 legacy import sites updated). **Never** links feed/oracle accounts.
>   - **Gate** `scripts/check-portfolio-visibility.mjs` extended: asserts `SolscanLink` href host `solscan.io` + `cluster=devnet` (deterministic via the public Markets inspector); collapse + BY-ASSET + row-level solscan are wallet-gated → SKIP (founder pass). **7 pass · 9 skip · 0 fail** in isolation. `cd app && npm run build` green (3 known warnings).
>   - **⭐ PARKED — Markets State-A asset-row solscan links:** State-A rows are per-asset AGGREGATES (an asset spans multiple markets) — no single honest on-chain identity. Wiring them needs a representative `OptionsMarket` PDA threaded into the `useMarketsData` asset aggregate. Skipped this slice; decide if wanted. (State-B contract rows drill down via the inspector, which now has the link.)
>   - **⚠️ MULTI-AGENT COLLISION (resolved) — see the STANDING RULE in the RESUME marker.** This slice was built while a concurrent `create-market-terminal` slice (B) shared the SAME working tree/clone. B's uncommitted WIP (a broken duplicate `NewMarketModal` decl mid-edit) broke the build mid-gate; I proved my slice green by briefly stashing ONLY B's file, then created `feat/portfolio-polish` and staged ONLY my 18 named files by explicit path. **B had also added a stray unused `useSearchParams` import to `WriteTerminalPage.tsx` (my file); it would have failed the Vercel tsc build and wasn't mine, so it was EXCLUDED from my commit — B re-adds it during their deep-link wiring.** B's WIP + `stash@{0}` backstop left intact on `feat/create-market-terminal`. Henceforth: one active slice per clone, or separate worktrees.
>   - **Staging:** 18 named files (no `git add -A`); B's files (`NewMarketModal`, `NewMarketTerminalModal`, `newMarketCreate`, `resolveMintSymbol`, `MarketsNewMarketAction`, `useIsAdmin`, `hermesCatalog`, `pythPullPost`, `constants.ts`) untouched + unstaged; no existing-flag flips. New: `components/SolscanLink.tsx` + `pages/portfolio/terminal/{useSectionCollapse,assetRollup,ByAssetSection}`; edited `utils/solscan.tsx` · `pages/portfolio/{PositionsTable,WriterPositionsTable,PortfolioTerminalPage}` · `pages/portfolio/terminal/{portfolioUi,HoldingsLedger,WrittenLedger,ActivitySection,UtilitiesSection}` · `pages/trade/{TradeDock,OpenOrders}` · `pages/markets/ContractInspector` · `pages/write/WriteTerminalPage` · `scripts/check-portfolio-visibility.mjs`.
>
> ---
>
> **2026-07-10 (FE — PORTFOLIO TERMINAL SURFACE SHIPPED + settle/claim MUTATION-REFRESH DEBT CLOSED. Squash-merged `feat/portfolio-terminal-surface` → master + main as ONE commit `2ec4a4e`. Founder browser-verified on Vercel preview. Frontend-only; NO on-chain change, NO transaction-logic change. This COMPLETES the 4-page terminal migration: Markets · Trade · Write · Portfolio.)**
>
> **[PORTFOLIO TERMINAL REDESIGN — LIVE on master + main 2026-07-10]** Reskin + restructure of `/portfolio` to the terminal language (Slice 3, after Trade + Write). Behind **new** flag `PORTFOLIO_TERMINAL_UI = true` (Trade/Write precedent — new flag defaulting true, NOT a flip of an existing gate). `PortfolioPage` is a flag switch: legacy paper surface renamed `PortfolioPageLegacy` in-file = byte-identical fallback; terminal = new `PortfolioTerminalPage`. `App.tsx`/routing untouched.
>   - **Shape:** `TerminalAppBar` + dark `useSurfaceMode` over a fixed-height flex column → **summary strip** (Claimable now · Locked+countdown · Collateral · Holdings value + the ONE teal **Claim all**) → **HOLDINGS** ledger (teal band, LONG) → **WRITTEN** ledger (crimson band, SHORT) → **ACTIVITY** → collapsed **UTILITIES**. Dense tables, 28–32px rows, sticky headers, Plex Mono tabular right-aligned, EUR/AMER + EPOCH/CUSTOM badges, `--text-3` only on dimmed rows. **No PnL column** (honest footnote "Mark from pool mid. Unrealized PnL once indexed.").
>   - **Grouping:** holdings CLAIMABLE→OPEN→EXPIRED; written CLAIMABLE→OPEN→LOCKED (claimable sorts to top). LOCKED writer rows (settled + inside the 24h holders-first window) disable the primary with a live mono countdown; `settled-locked` state was already modeled in `writerRows.ts`.
>   - **⭐ MUTATION-REFRESH DEBT CLOSED (the flagged follow-up).** Root cause: Portfolio reads every ledger via `safeFetchAll` → `coalescedProgramAccounts` (in-flight dedupe, no TTL), and **`useVaults` does NOT subscribe to the `mutationBus`** — so `refreshAfterMutation`'s bus-emit never reached the ledgers, and a post-action `refetchAll` could join a pre-mutation in-flight scan (stale-until-manual-reload). **Fix = invalidate-before-refetch:** new `invalidateAccountScans(program, names[])` helper (`useFetchAccounts.ts`, wraps `invalidateProgramAccounts` over the private `DISCRIMINATORS` map) drops all 7 coalesced scans, called at the top of `usePortfolioData.refetchAll`, which is wired into EVERY action `onSuccess` (exercise / claim / withdraw / burn / cancel). No more stale UI after a confirmed action. **This is the pattern for any future surface that reads via `safeFetchAll` + doesn't subscribe to the bus** (distinct from Trade's bus-driven reconcile).
>   - **⭐ Claim all** (the one teal primary): sequential FE loop over the **deduped** claimable set — writer premium (live, claimable>0 → `claim_premium`), settled-**unlocked** residual (→ `withdraw_post_settlement`, which auto-claims premium per HIGH-01, so these are EXCLUDED from the premium pass — never both on one row), holder settled-ITM payout (→ `exercise_from_vault`). One approval each, continue-on-failure, `Claiming k/N`, disabled when empty. **No new instruction** — reuses the byte-identical per-row flows. Excluded: American early-exercise (discretionary), resale, dust-burn.
>   - **ACTIVITY:** bounded order-tape adapter (`portfolioActivity.ts`) over `tradeHistory.scanRecentActivity` (≤40 sigs → ≤40 getTransaction) → Wrote / Listed / Bid / Bought / Sold / Cancelled / Swept, AMOUNT direction-colored, mono sig + explorer link. Added an additive `role: maker|taker` field to `scanRecentActivity` (backward-compatible for the Trade dock) to derive Bought vs Sold correctly. Footnote "Recent on-chain activity — full history pending indexer" (honest — see Parked: full vocabulary).
>   - **Conflict resolutions (founder-decided):** kept a **cancel-resale** affordance on listed holder rows (no stranded live listings); **parked** resale-listing creation + OTM dust-burn (worthless — legacy retains both behind the flag); **UTILITIES** = collapsed de-emphasized disclosure below ACTIVITY preserving `SettleExpiriesSection` (public crank) + `MigrateFeedSection` (admin, self-gates via `useIsAdmin`). Both carry the legacy PAPER palette inside the collapse — accepted debt (see Parked).
>   - **Accepted constraint (founder-OK):** the states-appendix "truncated in-flight sig during pending" is NOT shown — the actions use `.rpc({commitment:"confirmed"})` (send+confirm in one blocking call), so there's no mid-flight sig without restructuring the byte-identical submission. Pending = progressive button label + 2px teal progress bar; the sig lands on confirm (toast + ACTIVITY). No plumbing added.
>   - **Light-teal token** `--color-l-up-text` (`#0E9B80` light / `#1AC6A5` dark, ≤12px teal TEXT only; fills/buttons keep `--color-l-up` `#1AC6A5`) added to both `@theme` + the dark override in `index.css`. `WriterRow.origin` (epoch/custom, from `SharedVault.vaultType`) added.
>   - **Gate** `scripts/check-portfolio-visibility.mjs`: **7 pass · 5 skip · 0 fail**. Deterministic PASS (no wallet): TerminalAppBar, dark default, connect-wallet state, mode toggle, **light-teal token rgb-exact** (probe: dark text `rgb(26,198,165)`, light text `rgb(14,155,128)`, fill `rgb(26,198,165)` both modes), provenance=0 both modes, mobile primary in-viewport. SKIP (wallet-gated → founder pass): section-band accents, group ordering, summary strip, activity rows, LOCKED countdown. `cd app && npm run build` green (3 known warnings).
>   - **Staging:** 16 named files (no `git add -A`); parked locals (`App.tsx`, `AppNav.tsx`, routing `constants`, `vercel.json`, `pages/seeker/*`) untouched; no existing-flag flips. New: `pages/portfolio/PortfolioTerminalPage.tsx` + `pages/portfolio/terminal/{usePortfolioData,useClaimAll,portfolioActivity,portfolioUi,SummaryStrip,HoldingsLedger,WrittenLedger,ActivitySection,UtilitiesSection}` + `scripts/check-portfolio-visibility.mjs`; edited `useFetchAccounts.ts` · `index.css` · `constants.ts` · `pages/portfolio/{PortfolioPage,writerRows}.tsx` · `pages/trade/tradeHistory.ts`.
>   - **⭐ PARKED — Activity full vocabulary (Exercised / Settled / Claimed):** the ACTIVITY scan covers the exchange ORDER tape only (`orderPosted/Filled/Cancelled/Swept`). Exercised / Settled / Claimed fire from non-order instructions (`exercise_from_vault` / `exercise_american` / settle / `claim_premium` / `withdraw_post_settlement`) — needs **event-decode verification** on those instructions (do they emit decodable Anchor events?) then a wider scan. The honest footnote ("full history pending indexer") covers the gap. **Rides the indexer arc.**
>   - **⭐ PARKED — Utilities terminal reskin:** `SettleExpiriesSection` + `MigrateFeedSection` still carry the legacy PAPER palette (scoped in a light panel inside the collapsed disclosure so it reads intentional). **Same class as the Markets `NewMarketModal` paper-skin debt** — a terminal reskin of these three is a later polish slice.
>   - **Parked/untouched:** flags (`PORTFOLIO_TERMINAL_UI`, `WRITE_TERMINAL_UI`, `WRITER_ASKS_ENABLED`, `TRADE_V2_UI`, `AMERICAN_ENABLED_UI`); `PortfolioPageLegacy` ternary fallback + all legacy portfolio components (`positions.ts`, `Open/Written/ClosedPositionsSection`, `*Table`, `SummaryBand`, `StatementHeader`, `ResaleModal`) still imported by the legacy path — do NOT delete. ⚠️ **Screenshots weren't in the build session's context — built to the textual contract + Trade/Write reference; founder pixel-verified on preview.**
>
> ---
>
> **2026-07-10 (FE — WRITE TERMINAL SURFACE SHIPPED. Squash-merged `feat/write-terminal-surface` → master + main as ONE commit `d6d9728`. Founder browser-verified on Vercel preview. Frontend-only; NO on-chain change, NO transaction-logic change.)**
>
> **[WRITE TERMINAL REDESIGN — LIVE on master + main 2026-07-10]** Reskin + restructure of `/write` to the terminal language (Slice 2 of the FE terminal track, after Trade). Behind **new** flag `WRITE_TERMINAL_UI = true` (Trade precedent — a new flag defaulting true, NOT a flip of an existing gate). **`WritePage` is now a flag switch**: legacy paper surface renamed `WritePageLegacy` in-file = byte-identical fallback; terminal = new `WriteTerminalPage`. `App.tsx`/routing untouched (page owns which surface it mounts, exactly like `TradePage`'s V1/V2 ternary).
>   - **Shape:** shared `TerminalAppBar` + dark-default `useSurfaceMode` over a fixed-height flex column → **split cockpit** (contract builder left · premium centerpiece right) → full-width **ladder table** (Epoch·Ladder only) → **docked footer strip** with the ONE teal primary. Top-level **EPOCH|CUSTOM segmented control**; **per-mode form state persists** across switches (two independent `WriterFormValues`, never cleared). Epoch **SINGLE** = three **dated tenor chips** (`Weekly · Jul 17` etc. from `tenors.ts`, real dates, roll past `min_epoch_duration`); **LADDER** = three %-sliders + the cell table (TENOR/EXPIRY/%/CONTRACTS/PREMIUM-CT/COLLATERAL + Total). Custom = date+time **UTC** inputs (mono), no tenor/ladder. Primary label: `Write option` (single/custom) / `Write ladder (N cells)`.
>   - **⭐ EXERCISE DEFAULT = AMERICAN** in both modes' fresh state (deliberate product change; European remains selectable).
>   - **Premium centerpiece:** `WritePremiumPanel` = a terminal restyle of `LiveQuoteCard` (same honest quote logic — European FE-BS, American on-chain BS-2002 via `useOptionPriceQuote`, stale/warmup indicative fallback + advisory kept). Centerpiece = **total received** (largest numeral on the page, 46px Plex Mono tabular — gate-asserted vs 15px next), `total received · X.XX / ct` subline, **greeks grid** (Δ Γ Θ V IV Breakeven — **FE-computed** via `calculateCall/PutGreeks`; IV = on-chain `volAnnualized` for American / baseline smile for European; breakeven = strike ± premium; the on-chain quote carries NO greeks), hairline, `Collateral total`. Display-only — zero tx impact.
>   - **UNTOUCHABLES preserved byte-identical:** all tx assembly in `useWriteSubmit.ts` (atomic bundle `[CU 600K, create_and_deposit, mint_from_vault]`, the Epoch·American canonical-series `create_series`+`create_shared_vault`+`post_order(writerAsk)` path, `BN(1)` American premium sentinel, `epoch_config` null-for-Custom, N-sequential cells with retry scoped to failed cells only, wallet-replay guard) + `tenors.ts` math. The gate/cell/premium logic was ported VERBATIM from the two paper sections into a new `terminal/useWriteController` hook — the terminal panels are the only new surface; the write itself is the same engine.
>   - **⭐ MUTATION REFRESH wired (was UNWIRED on legacy Write).** Legacy `handleSuccess` only `refetchMarkets()`; a landed Epoch·American write posts a `WriterAsk` resting order that didn't reflect without a manual reload. Now `refreshAfterMutation(program, {})` fires on landed epoch cells (**reconcile-only** — `sendCell` returns no `BookOrder`, and the legacy/Custom `mint_from_vault` path posts no resting order at all, so no optimistic insert). Custom/legacy = markets refetch, sufficient.
>   - **FaucetIconButton = NO-OP this slice.** It already renders the real `SolMark`/`UsdcMark` (SOL tri-bar, USDC $-in-circle) from `assets/BrandMarks` — brand-colored, **kept as-is** (founder decision — do NOT recolor to `currentColor`; brand colors read in both modes and are the recognizable marks). Work-item-2 was already shipped by the Trade/Markets slice.
>   - **Asset dropdown:** Write-local `WriteAssetSelect` modeled on Trade's `AssetDropdown` (grouped Crypto/Equities/Commodities/FX via `assetClassOf`, viewport-safe left-anchored panel) + **right-aligned live spot** per row + crimson "oracle pending" dot. Trade's component left untouched (no propagation).
>   - **Gate:** new `scripts/check-write-visibility.mjs` (rendered-DOM after real interaction — visible rects + `offsetParent` + computed geometry, never node-presence/text). **13 pass · 1 skip · 0 fail**: TerminalAppBar, dark default, EPOCH↔CUSTOM panel swap (tenor row ↔ expiry inputs, each absent in the other), SINGLE dated chips selectable, LADDER sliders + cell rows, asset dropdown visible+selects (19 assets, within viewport), **Exercise=AMERICAN on fresh load**, **premium centerpiece is largest numeral (46 vs 15px)**, mode toggle dark↔light, **provenance grep = 0 both modes**, mobile primary present. SKIP = faucet SVG marks (connected+devnet only → founder-wallet pass, verified on preview). `cd app && npm run build` green (3 known warnings).
>   - **Staging discipline:** 9 named files only (no `git add -A`); parked locals (`App.tsx`, `AppNav.tsx`, routing `constants`, `vercel.json`, `pages/seeker/*`) untouched; no existing-flag flips. New files: `pages/write/WriteTerminalPage.tsx` + `pages/write/terminal/{useWriteController,WriteContractPanel,WritePremiumPanel,WriteLadderTable,WriteAssetSelect}` + `scripts/check-write-visibility.mjs`; edited `pages/write/WritePage.tsx` + `utils/constants.ts`.
>   - **Parked/untouched:** flags (`WRITE_TERMINAL_UI`, `WRITER_ASKS_ENABLED`, `TRADE_V2_UI`, `AMERICAN_ENABLED_UI`); `WritePageLegacy` ternary fallback intact (unreachable at flag=true); the 5 paper Write files (`WriterForm`, `LiveQuoteCard`, `ExpiryPicker`, `EpochVaultSection`, `CustomVaultSection`, `WriteStatementHeader`) are the legacy path, still imported by `WritePageLegacy` — do NOT delete. **⚠️ Screenshots weren't in the build session's context — built to the textual behavioral contract + Trade v2 as visual reference; founder pixel-verified on preview.**
>   - **⭐ PARKED — Strategy writer (next Write slice, FE-only):** strike-ladder + call/put **multi-leg cell generators** on the existing **N-cell submit engine** (`useWriteSubmit` already fans out N sequential atomic writes — a multi-leg strategy is just a different cell-generator feeding the same `WriteCell[]`). **No cross-margin — each leg posts full collateral** (the vault model has no netting). FE-only; no Rust. E.g. verticals/straddles/strangles/calendars generated as N cells, one wallet approval each.
>
> ---
>
> **2026-07-10 (FE — TRADE TERMINAL SURFACE SHIPPED. Squash-merged `feat/trade-terminal-surface` → master + main as ONE commit (6-commit arc). Founder browser-verified on preview AND production. Frontend-only; NO on-chain change.)**
>
> **[TRADE TERMINAL REDESIGN — LIVE on master + main 2026-07-10]** Reskin + restructure of the V2 Trade surface to the terminal language (design lock 2026-07-09). Shared `TerminalAppBar` extracted to `components/` (+ `FaucetIconButton` moved there); Markets renders it via a `pageAction` slot (the New-market control), pixel-identical (markets gate 16/16); old `MarketsAppBar` removed. `/trade` is dark-default via `useSurfaceMode`. Symmetric mirrored chain `[IV Δ OI MARK ASK BID] · g · STRIKE · g · [BID ASK MARK OI Δ IV]` (equal gutters BY CONSTRUCTION, strike dead-center, direction-color price flash, NO ⓘ column / NO details modal). Docked `ContractInspector mode="docked"` (discriminated union; Markets `mode="modal"` intact) = protocol-quote centerpiece + RFQ, collapsible analytics (persists), position block (Close/Exercise), shared `OrderTicket variant="docked"` (routing/gating verbatim), order book, recent-trades tape, open orders. Full-width collapsible `TradeDock` (positions / open-orders / order+trade history / balances) on real derived data (`useTradeDockData` mirrors Portfolio assembly). Deep-links reconciled to ONE canonical `asset·expiry·strike·side` (both Markets emitters updated). New gate `scripts/check-trade-visibility.mjs` (6 deterministic PASS; 4 data-dependent SKIP → founder wallet pass). `ContractDetailModal` removed from Trade.
>   - **DATA HONESTY:** order/trade history = BOUNDED "recent activity" tx-scan (`tradeHistory.ts`) labeled "full history pending indexer" — no indexer exists. Position PnL: series holders have no per-holder cost basis on-chain → block shows Mark/Value/BE + "unrealized PnL once indexed" (never a fabricated PnL). Stop/TP-SL tabs ship GATED with an honest inline state — **placement is the next Trade slice** (on-chain `place_trigger`/`execute_trigger` + VPS crank are LIVE; only the FE placement UI + the StopEntryBuy/TakeProfitSell-no-StopLoss taxonomy labeling remain).
>   - **⛔ CHART DECISION (LOCKED, made TWICE):** UNDERLYING = TradingView embed (ALL asset classes via `tvSymbol`, real exchange feeds, reliable on this layout, no free-API rate limits); CONTRACT = on-chain OrderFilled tape. A reskin subagent silently re-architected this to lightweight-charts + CoinGecko OHLC (crypto-only) during Phase 1; caught at Phase-2 review, reverted by founder ruling. Loud DO-NOT block now heads `PriceChart.tsx`; `tvSymbol` extended to equities/metals/oil.
>   - **⚠️ PROCESS LESSON — subagent scope-drift.** Phase-0 plan said "reskin PriceChart (token swap)"; the dispatched agent re-architected the data+render path and its summary read as a clean reskin, so it was absorbed into the Phase-2 report instead of flagged. **Standing rule now in effect: subagent output is diffed against the approved file plan BEFORE presenting; any deviation from approved scope is surfaced as a deviation, never silently absorbed.**
>   - **⚠️ LOAD-RELIABILITY FIXES (2 preview bugs).** (BUG-1) Trade's asset dropdown dropped SOL/BTC + showed blank rows and defaulted to nothing. (BUG-2) wallet-connect blanked the surface; Markets→Trade deep-link hung on "Loading forever". **Root cause:** the Trade page fires ~11 full-program `getProgramAccounts` scans on mount (useVaults 4 + useTradeData 2 + useUnifiedChain 4 + useBook 1, with sharedVault/vaultMint/optionsMarket/restingOrder each scanned TWICE) vs ~5 on Markets — and **Preview has `VITE_RPC_URL` UNSET → public devnet (`api.devnet.solana.com`)**, which rate-limits/stalls that burst → partial loads + a scan with no client timeout hanging. **Fixes:** (a) `utils/programAccounts.ts` `coalescedProgramAccounts` — in-flight coalescing (no TTL, so never stale after a trade) + 25s timeout; routed `safeFetchAll` + `exchangeData.getByDisc` through it (collapses the duplicate scans, bounds hangs). (b) Trade's asset universe/default(highest-OI)/expiries now derive from `useUnifiedChain` (tolerant, same data the grid renders) — dropdown can't list an un-chartable asset; `useTradeData` auto-select relaxed to not fight. (c) `useUnifiedChain` keeps prior rows on error; shell gates the surface on chain-has-assets (wallet-connect never blanks; resolved empty/error state, no infinite spinner). (d) AssetDropdown flattened (no odd-count grid gaps) + filters empty/"?". Gate `check-trade-visibility.mjs` extended (13/13): dropdown ⊇ Markets State A + no blanks, default auto-selects, deep-link resolves. **DEFINITIVE SERVER FIX DONE ✅ 2026-07-10: `VITE_RPC_URL` set to a private RPC on Vercel Preview + Prod** (`reference_vercel_env_gap` closed) — the coalescing/timeout are now belt-and-suspenders, not the sole mitigation.
>   - **⛔ CANONICAL ASSET DISPLAY (provenance hard-rule).** `utils/assetDisplay.ts` `canonicalAsset(symbol)` is the SINGLE data-layer map (on-chain symbol → clean display symbol; `null` = hide from discovery), applied in `fetchUnifiedChain` (chain) + `useTradeData` + `useMarketsData` so no surface renders provenance. Disposition (devnet): **XAU** = real gold (shown); **SBXAU** = Switchboard gold SEED (1 vault) → **HIDDEN** (distinct market, never merged into XAU); **XAUSMOKE** → hidden; **USOILSPOT** → shown as **WTI**; **UKOILSPOT** (Brent, 0 vaults) → hidden. Catch-all hides any un-mapped `^SB…` / `…SPOT|SMOKE|TEST`. Trade dropdown now `[BTC,ETH,FARTCOIN,SOL,AAPL,MSFT,MSTR,NVDA,TSLA,WTI,XAG,XAU]`. Gate asserts VISIBLE dropdown options (rect+offsetParent, not just DOM text — the earlier empty-render slipped a text-only check) + no `^SB`/raw-feed symbols on Trade AND Markets. Empty-dropdown regression fixed by unioning the chain + td asset sources (robust to either partial-loading).
>   - **Breadth-based default asset.** Cold-load default = highest-BREADTH asset (# live contracts), tie-broken by OI then name → **SOL**. NOT raw OI (contracts-sold): a thin high-OI asset (FARTCOIN) with an empty nearest expiry outranked SOL on OI. The one-shot default WAITS for the chain fetch to settle (`chain.loading===false`) so a partial set can't lock a low-breadth pick; deep-links apply immediately. AssetDropdown panel is `left-0` anchored + width-clamped to the viewport (was `right-0` → clipped off the left gutter).
>   - **⚠️ GATE-DEPTH LESSON (two shallow-gate escapes).** (1) chain geometry SKIPped without data yet read as covered; (2) the dropdown "passed" reading DOM `textContent` while the rendered panel was EMPTY (data-array vs rendered-DOM). **Standing rule: visibility/interaction gates assert RENDERED-DOM facts after a real interaction — visible options (rect+offsetParent), computed position within the viewport — never node presence/text alone.** `check-trade-visibility.mjs` is now 16/16 on those terms.
>   - **6-commit arc (squashed to one):** build → chart revert (TradingView underlying + ⛔ DO-NOT block, decision made TWICE) → asset-list/load-reliability (coalescing + chain-source + graceful states) → canonical `assetDisplay` (provenance) → dropdown left-anchor + breadth default.
>   - **Polish debt:** the docked inspector's quote caption "Model estimate · EUR" reads as a currency — change "· EUR" → "· European". **Trigger PLACEMENT is the next Trade slice** (on-chain `place_trigger`/`execute_trigger` + VPS crank are LIVE; FE needs the placement UI + the **two-kind taxonomy decision**: only StopEntryBuy + TakeProfitSell exist on-chain — no StopLoss — so the Stop/TP-SL tab labels must be reconciled deliberately).
>   - **⭐ MUTATION-REFRESH PATTERN (STANDARD for all future mutating surfaces).** Shipped 2026-07-10 after a stale-UI-after-cancel bug (a confirmed tx didn't reflect until manual refresh). Root cause: `coalescedProgramAccounts` had no invalidation (a refetch could join a pre-mutation in-flight scan) + gPA index lag + the cancel path refetched only `useBook`, not `useUnifiedChain`. **The pattern (use it everywhere a tx changes visible state):** (1) OPTIMISTIC — mutate the shared store instantly (`useBook.optimisticRemoveOrders/optimisticUpsertOrder`); removed items are SUPPRESSED (`exchangeData`, 8s TTL) so a lagging scan can't re-add them; posts insert under the REAL derived PDA (`orderFlows.deriveOrderPubkey`) so reconcile replaces in place. (2) RECONCILE — `programAccounts.invalidateProgramAccounts` + `exchangeData.invalidate{Book,Vault}Cache` drop the coalesced scans, then a module-level **`mutationBus`** emits twice (now + ~1.3s for index propagation); every data hook subscribes and refetches chain-fresh. Single entry point: **`orderRefresh.refreshAfterMutation(program, {removed, added})`** — wired into OrderTicket (post/fill/write/peg), OpenOrders (cancel), docked inspector (close). Normal mounts stay coalesced (fresh-refetch ONLY on mutation). **⚠️ FOLLOW-UP: Portfolio settle/claim** (`withdraw_post_settlement`/`claim_premium`) shares the same coalescing-staleness class — its `refetchAll` should adopt this invalidate-before-refetch pattern; **ships with the Portfolio redesign slice.**
>   - **⭐ MULTI-LEVEL MARKET SWEEP (Phase 1, shipped 2026-07-10).** Buy·Market / Sell·Market now walk the book across up to **4 price levels in ONE legacy tx** (`marketSweep.ts` `planSweep` pure planner + `executeSweep`; instruction builders `buildPegFillIx` / `buildFillOrderIx` / `buildFillWriterAskIx` in `orderFlows.ts` — the proven `.rpc()` single-fill paths left byte-identical). Fixes stranded depth (peg-1 + writerAsk-9 → filled 10 in one tx). **Honest partial** (>4 levels or a slippage breach vs the best level → "Filled X of Y · avg $Z", **never** auto-post residual). **Self-trade:** FE filters the taker's own orders out of the sweep. Peg leg `max_premium` = **TOTAL** ceiling (`qty × per-contract × (1+slip)`) per `fill_vault_peg.rs:205-211` — the old single-peg path passed a **per-contract** value (reverted `SlippageExceeded` for qty>1); **`SimpleTradePanel` had the same live-on-prod bug** (auto-picks qty>1, no gate) → fixed to `cost × 1.15`. Book "vault peg" tag → **"vault"** (shipped). **⚠️ QUEUED — next program-upgrade bundle:** (1) on-chain **`fill_order` self-trade guard** (`taker != maker`, resaleAsk/bid parity — `fill_writer_ask` already blocks it), (2) **European strike-cap** fix. **Follow-ups:** **v0 tx + LUT** for >4-level deeper books; **Phase 2 = marketable-limit crossing** (Buy·Limit ≥ best ask → sweep then rest residual at limit; Sell·Limit ≤ best bid mirror).
>   - **⭐ GRID BID/ASK = LIVE BOOK (shipped 2026-07-10).** The chain grid's ASK/BID cells read best resting bid/ask from the **live `useBook`** via ONE shared selector `exchangeData.bestRestingBidAsk(byOptionMint, mint)` — NOT the staler `useUnifiedChain.bestAsk/bestBid` snapshot (which lagged a just-posted order and showed the wrong best). `TradeChainV2` calls `useBook()` (bus-subscribed) so cells update instantly on post/cancel and equal the book panel by construction. **Scope (accepted):** ASK cell = best **RESTING** ask (resale+writer — **firm quotes only**); the vault peg stays in the MARK column + the book's "vault" band (folding the model-mark peg would mismatch the actual quote + hit a sold-out edge). Gate: **"grid ask == book best ask"** (grid `data-field=ask`/`data-mint` vs `OrderBookLadder` `book-best-ask` marker).
>   - **⭐ MARKETABLE-LIMIT CROSSING (Phase 2, shipped 2026-07-10) — ✅ MATCHING ARC COMPLETE.** Buy·Limit ≥ best ask / Sell·Limit ≤ best bid now CROSS: `marketSweep.crossLimit` sweeps levels within the LIMIT (the limit IS the ceiling — `planSweep.priceCeiling` + `executeSweep.pegMaxPerContract`) up to 4 levels in ONE tx, then rests the residual at the limit (**TWO-TX**). A **one-iteration RIDER** re-checks the refetched book once before resting (no infinite loop; a stale re-sweep is caught → falls through to resting). Reports "Filled X · rested N @ limit" / "residual N failed to post — retry" (fills stand). Self-trade filtered; optimistic remove (swept) + insert (residual at its derived PDA) + `refreshAfterMutation` on both legs. Shared `buildAskLevels`/`buildBidLevels` (the market sweep was refactored onto them). **The exchange now has multi-level market sweeps + marketable limits.** **Queued follow-ups (unchanged, NOT this branch):** program-upgrade bundle — on-chain **`fill_order` self-trade guard** + **European strike-cap**; **v0 tx + LUT** for >4-level deeper books.
>   - **Parked/untouched:** flags (`TRADE_V2_UI`, `WRITER_ASKS_ENABLED`, `AMERICAN_ENABLED_UI`) + parked files (`App.tsx`, `constants.ts`, `vercel.json`, `AppNav.tsx`, `pages/seeker/*`). V1 `TradePage` ternary shell intact (V1 unreachable at flag=true). ⚠️ **`TradingViewWidget.tsx` is a LIVE consumer** (PriceChart's underlying chart) — NOT dead; do not delete.
>
> ---
>
> **2026-07-08 (SESSION CLOSE — FE DESIGN ARCS: LANDING + MARKETS TERMINAL SHIPPED. Frontend-only; NO on-chain change.)**
>
> **▶ THE ON-CHAIN RESUME POINTER IS UNCHANGED.** This block does not touch the Jul-8 reclaim flip or the SB crypto migration — those (in the 2026-07-07 block below) remain THE next priorities. This is pure FE/design work.
>
> **[LANDING REDESIGN — LIVE on master `9e3a6aa`]** One-viewport landing, dual-mode (light default), Fraunces-in-logo-only, IBM Plex Mono eyebrow/routes, slow ~2.6s dot pulse, progressive staircase headline stagger. Sets `data-mode` via `useLandingMode` (light). Gate `scripts/check-landing-visibility.mjs` (6/6). Verified on deployed opta.fyi: both modes, 3 routes, provenance-clean.
>
> **[MARKETS TERMINAL REDESIGN — LIVE on master this session, squash-merged from branch `markets-terminal`]** Replaces the paper/statement Markets browser with a dark-default terminal discovery surface. **Route-scoped ONLY** — new `MarketsAppBar` + `useSurfaceMode(dark)`; the other 4 trader pages keep AppNav + paper palette (untouched). Files: `pages/markets/{MarketsPage,MarketsTerminal,PulseTiles,ContractInspector,FaucetIconButton,MarketsAppBar,marketsView,useMarketsData}` + `hooks/useSurfaceMode` + `assets/BrandMarks` + `index.css` (l-* dual-mode tokens, dark override block) + `pages/trade/TradePageV2` (deep-link `?asset=&expiry=` intake, one-shot/defensive).
>   - **Shape:** terminal header (logo · nav · faucet icons · DEVNET · mode toggle · New market · wallet) → protocol strip → 5 pulse tiles → class tabs + Jump-to-asset combobox → two-level table (State A one row/asset → State B contracts grouped by expiry, Side+Expiry chips, collapsible "Settled & expired") → Contract Inspector modal (model greeks + on-chain RFQ premium + payoff diagram).
>   - **REAL DATA ONLY (mandate):** every number binds to chain/derived state. **24h %/Vol/IV-move CUT** — no trade/price time-series indexer exists, so none are derivable; substituted OI · vault depth · model-IV · cumulative-premia · expiring<7d tiles. IV = deterministic vol MODEL (labelled); premia = CUMULATIVE `vault.netPremiumCollected` (labelled). Aggregates count LIVE contracts only (settled/expired excluded except the collapse). Inspector premium = `fetchOptionPriceQuote` (400K-CU manual simulate, NEVER `.view()`; American) with a **model-premium fallback** (real: live spot+vol) labelled "Model estimate — live quote warming up" when the read-only sim can't price; upgrades to "Protocol quote" with a wallet.
>   - **Provenance invisible:** 0× pyth/switchboard/hermes in the rendered DOM (State A/B/inspector, BOTH modes) — asserted by `scripts/check-markets-visibility.mjs` (16/16). Fraunces only in the logo; Inter labels; IBM Plex Mono tabular right-aligned numerals.
>   - **Faucet feedback:** `/api/faucet` returns 200 `{sol:0.05}` / 200 `{balance}` / 429 `{error,retryAfter:secs}` / 503. `FaucetIconButton` surfaces EVERY outcome (logo flip + inline mono flyout "+0.05 SOL" / "12,345 USDC" / "Cooldown · 3h 59m" / reason, ~2.5s fade). No toasts. (Before: click succeeded but was silent → felt dead.)
>   - **Dark label-contrast RULE (enforced this session):** labels/eyebrows/column-headers use `--text-2` (l-muted `#8C897C`) minimum in dark mode; **`--text-3` (l-faint `#5E5B50`) is reserved EXCLUSIVELY for de-emphasized content** (settled/expired rows, disabled). Never put a label on l-faint.
>   - **⚠️ LESSON — a scroll container must NOT be a flex column.** The scroll body was `flex flex-col overflow-auto`; its children are flex items with default `flex-shrink:1`, so a TALL State-B table overflowing made flexbox **compress the pulse-tile row to ~38px** (headlines half-clipped) instead of scrolling. State A's short table never overflowed, which masked it as an intermittent "sticky" bug. **Fix: plain block `flex-1 overflow-auto`** (children keep natural height) + reset `scrollTop=0` on any filter/breadcrumb/state change + `[overflow-anchor:none]`. Gate now asserts tiles stay full-height (≥120px, measured 185px) AND scrollTop resets from a deep scroll.
>   - **⚠️ DEBT — NewMarketModal is paper-skinned.** The restored "New market" button (secondary outlined; Connect wallet stays the only primary; connect-first gate) reuses the existing `NewMarketModal` AS-IS — its paper palette clashes with the terminal chrome. **Terminal reskin is a later slice.** Also deferred (optional): persistent SOL+USDC balance readout by the wallet chip (space + extra RPC reads).
>   - **Parked forward:** the other 4 trader pages stay paper until their own redesign slices (the FE-overhaul roadmap item); flags untouched (`WRITER_ASKS_ENABLED`, `TRADE_V2_UI`, `AMERICAN_ENABLED_UI`); branches `markets-terminal` + `landing-oneview` deleted post-merge.
>
> ---
>
> **2026-07-07 (SESSION CLOSE — PYTH-DEADLINE RECON + SB CRYPTO MIGRATION STAGED + MAGICBLOCK CODE-VERIFIED/PARKED). ▶ RESUME HERE — this is the current resume pointer; it supersedes the "▶ RESUME HERE" markers in every block below (their content stays valid as history; the Jul-8 flip runbook + VITE_RPC_URL gap are still LIVE open items, carried forward here).**
>
> **▶ RESUME HERE (next session, in order):**
> 1. **JUL-8 RECLAIM FLIP** (~23:25Z devnet cluster time, after Ad5 grace `2026-07-08T23:19:56Z`) — **runbook UNCHANGED**, see the 2026-07-06 recon block + the 4-candidate July-8 runbook below (do not re-derive). **Run the Pyth-deadline exposure scan alongside it** (prompt exists): scan all live Pyth vaults for expiries **> Jul 31**, check max mintable expiry, propose a minimal gate.
> 2. **On "flip done" → GATE D of the SB migration:** `volOracleCrank` SB branch (registry-driven), VPS deploy, 2-tick verify. **⏱ WARMUP CLOCK STARTS HERE — 168h.** Every hour of delay slips cutover.
> 3. **Pending user actions:** Vercel dashboard redeploy (cache **UNCHECKED**) + devtools verify RPC hits **Helius**; add `VITE_RPC_URL` to **Preview** via dashboard. (See the VITE_RPC_URL gap in the 2026-07-06 block — still open.)
>
> ---
>
> **[PYTH DEADLINE — DRIVES EVERYTHING]**
> Pyth Core goes **paid July 31, 2026** (Hermes needs an API key, **$500/mo Starter**). Breaks **all 7 Hermes touchpoints** (full inventory in this session's 2026-07-07 recon). **DECISION: the entire crypto surface migrates to Switchboard.** Pyth stays in code as a **dormant branch** — re-adding later = buy a key + create Pyth-source markets. **Settlement model: fresh-at-settle (300s window); Opta pays the settlement crank, users pay all other pulls.**
>
> **[SB CRYPTO MIGRATION — PHASE A STAGED]**
> Recon corrections: the **live crypto surface = 5 assets, not 16** (BTC ETH SOL XRP FARTCOIN, all Pyth oracles warm). **No in-place source flip exists** for markets or vol-oracles — the path is **parallel SB-born accounts + name handover at cutover**.
> - **Gate B DONE (`35a5adc`):** 5 SB feeds minted + registered. **FARTCOIN = Gate+MEXC median** (Bybit doesn't list it). All feeds **≤0.062% vs Pyth**.
> - **Gate C DONE:** 5 SB vol oracles birthed, `sample_count=0`, SB write path proven via sim (6046 revert lands post-quote-verification). PDAs in the session log / on-chain by `feedHash`.
> - **Gate C2 DONE (`0b19271`):** `close_market` drafted + **3/3 bankrun tests** + `preflight_close_market.ts` (refuses if live vaults). **NOT DEPLOYED — ships in the cutover deploy.**
> - **Gate D HELD** until the reclaim flip is done.
> - **CUTOVER (~Jul 20, after warmup):** stop new Pyth crypto mints → last Pyth vaults expire/settle → `close_market` the old 5 → `create_market` **real names** BTC/ETH/SOL/XRP/FARTCOIN, `source=SB`, warm oracles inherited by `feedHash`. **NAMING RULE:** clean names only — no suffixes, no lowercase, **no oracle branding ever** (UX rule: oracle provenance is never user-visible; SBXAU/XAUSMOKE display cleanup lands with the design overhaul, not before).
>
> **[MAGICBLOCK — PARKED POST-PMF, ARCHITECTURE DECIDED]**
> Read-only code recon of `ephemeral-spl-token` + `magicblock-engine-examples`: **Q1 mint-on-fill in-ER = NO** (no mint path exists; the in-ER `EphemeralAta` ledger bypasses the token program). **Q2 custom hook in-ER = leaning NO** (zero hook handling anywhere; bare `TransferChecked`; invariant-bypass risk). **Q3 mainnet fees/audit = unanswered** (nothing in-repo; validator self-labels unaudited) — asked again. **DECIDED ARCHITECTURE when revisited: match-in-ER / mint-on-L1 at commit.** Two PoCs specced (**PoC-A** mint, **PoC-B** hook side-effect) if ever needed. **Follow-up sent to MagicBlock** re: split reference architecture + Q3.
>
> **[AWAITING EXTERNAL]**
> - **Jack / Switchboard:** devnet costs at 50+ feeds, rate limits, sources by asset class (equities off-hours, longtail Solana). **Gates the BOARD-EXPANSION ARC** (campaign assets JUP/JTO/WIF/BONK + equities + commodities; equities need **~4–5wk warmup** so their feeds must be created first).
> - **MagicBlock:** split reference architecture + mainnet fees/audit.
>
> **[ROADMAP QUEUE AFTER MIGRATION]**
> 1. **Frontend design overhaul** — Claude Design + CC, full site + text, design-book deliverable. Includes the clean asset-name display mapping.
> 2. **Gamified devnet experience** (user acquisition) — points engine, quests/leaderboard, taker bots, PostHog instrumentation; sybil design needed. The board-expansion arc feeds it.
> 3. **Seeker app finalization.**
>
> ---

> **2026-07-06 (RECON CORRECTION — 3 HANDOFF-STALE ITEMS VERIFIED DONE, read-only). ▶ RESUME HERE.** Supersedes any older "held pending" language for these three in the historical blocks below (do not re-open them).
>
> **(A) SWITCHBOARD STAGE 3 — COMPLETE.** Commit `9bf4dda` ("Stage 3 arc COMPLETE — deployed + exercised live"). The read path **branches on `oracle_source`** (no longer unconditionally Pyth): `settle_expiry.rs:116-138` + `exercise_american.rs:118-135` (`match ORACLE_SOURCE_PYTH / ORACLE_SOURCE_SWITCHBOARD`). `sbOracleCrank` is **wired into the live bot** (`bot.ts:1144-1166`); the liveness loop is env-gated (`bot.ts:1176-1209`). The **HIGH-5 proof gate is branched by `oracle_source`** (`create_market.rs:75`, `migrate_pyth_feed.rs:44`). The deployed program (slot **473901900**, feature-free, authority `5YRMuuoY`) already carries all of this — no redeploy needed. **No separate backend indexer exists** — the FE self-indexes via direct on-chain reads; the crank serves `GET /liveness` from an in-memory map. Any "**held pending Jack / devnet-oracle confirmation**" language is **VOID**.
>
> **(B) TRADFI SURFACE — LIVE.** 2 on-chain Switchboard **gold** markets: **SBXAU** `4pEmVTXdg6GayFeFmnSphiK3eLLYrPGSfX8g9ah8ADT1` + **XAUSMOKE** `4FU8cV8sMdWJX4GDvwBzp52YHoummFc7pCoHmqq9Z3Qf` (the only two `oracle_source==1` markets on-chain). Pilot is **gold-via-SB**, NOT a PAXG-named market. ⚠️ **Decode caveat:** of 446 optionsMarkets, **427 are OLD-LAYOUT legacy markets** whose `oracle_source` byte decodes as **garbage (values 2–255)** against the current IDL — they are **NOT** SB markets. Only **17 clean Pyth (`==0`) + 2 SB (`==1`)** are current-layout. Never count "non-Pyth" as SB from a raw scan.
>
> **(C) TRADE PAGE V2 — FLIPPED + LIVE.** `TRADE_V2_UI = true` (`constants.ts:145`) + `AMERICAN_ENABLED_UI = true` (`constants.ts:134`), both committed on master; flip merge `943c6b8`. `constants.ts` + `vercel.json` are **no longer parked locals** — both tracked and clean (empty `git status`). Live buildId **`8e399cf` == repo tip**.
>
> **▶ ADDED OPEN ITEM (this recon):** **⚠️ VITE_RPC_URL VERCEL GAP.** The prod build env does NOT set `VITE_RPC_URL` (`env.ts:61` fallback note), so `opta-solana.vercel.app` runs on the **PUBLIC devnet RPC**, not Helius — the Helius key exists only in local `app/.env.local`. **Fix:** add `VITE_RPC_URL` to the Vercel project env + redeploy. Rate-limit risk under load until fixed.
>
> **▶ JUL-8 RECLAIM FLIP — RECON DONE, FLIP PENDING (2026-07-06, read-only; the flip is a separate greenlit step).**
>   - **4 canaries verified on-chain** (all len=276, `is_settled=0`, `voided=0`, SettlementRecord ABSENT): `Ad5zz684…49S` (SBXAU $100, pool $10 + ~$200 pot), `BAhgX8uA…GAxT` (BTC $85k husk, 0 writers), `GteYo9R…dYXB` (MSFT Put $400, vault_usdc **$204,300.48**), `8xW8ewi…7ViR` (TSLA Put $400, vault_usdc **$20,064.90**).
>   - **Eligibility:** BAh/Gte/8xW eligible NOW (grace +38–45d); **Ad5 grace ends 2026-07-08T23:19:56Z** → **flip at/after ~23:25Z** to sweep all 4 in one tick (earlier → Ad5 reverts `GracePeriodNotElapsed`, crash-isolated, retries next tick — safe).
>   - **Crank:** `OPTA_RECLAIM_CRANK_ENABLED` **absent** from `/opt/opta-crank/.env` (DARK, `bot.ts:380`). Vault discovery = **discriminator memcmp** (`safeFetchAll`, `bot.ts:554`) — immune to the 260-byte length bug. One tick sweeps ALL eligible (`reclaimUnsettled.ts:282`; cluster-time grace `:286`). Wallet `5sHZ…` **20.85 SOL**, sweep **<0.05 SOL**.
>   - **Funds:** writer-only, owner-pinned (`reclaim_unsettled.rs:228` + `:73`); cranker is gas-only (permissionless, `:190-193`) → **no admin key on the VPS**. Voided pays holders **$0** by design (invariant #6). Gte/8xW writer = `DnExEYnZ…`; Ad5 pool writer = admin `5YRMuuoY`.
>   - **Flip sequence:** dry-run `_probe_reclaim_dryrun.ts` (expect `candidates=4`, `errors=0`) → **verify Ad5 `writer_ask_pot_usdc`** (~$200 is HANDOFF-sourced, UNVERIFIED this recon) → add `OPTA_RECLAIM_CRANK_ENABLED=1` → `systemctl restart --no-block opta-crank` → expect `voided=4, writersReclaimed=3, usdcMoved≈$224,375.38` → manual permissionless `reclaim_writer_ask_residual` on the Ad5 pot backer → conservation check → decide keep-or-revert.
>   - **Deployed reclaim = the H-03 premium-bearing version, slot `473901900`** (supersedes the Pass-D `469592830` references in the historical blocks below).
>
> ---

> **2026-07-06 (SESSION CLOSE — TRADE-PAGE QA MATRIX PASSED + LADDER LIVE-ROLLED + 3 FE FIXES SHIPPED).**
>
> **(1) TRADE-PAGE QA MATRIX — ✅ ALL 6 SLICES PASSED ON PROD (real money, every one conserving to the micro-USDC).** Read-only verification of the already-shipped exchange, driven by Nanko's clicks on `opta.fyi/trade` + `/portfolio`, verified around each. Guinea-pig = the **canary series** SOL $80 Call exp 2026-07-10 (mint `Ck9mXZct…`, vault `CSTik3B863…`).
>   - **S1 vault-peg mint-on-fill** — `fill_vault_peg`, premium split (vault_share + 50 bps fee), 0→1 minted. (Found FE gap: no grid peg-capacity gate → fixed in (3).)
>   - **S2 limit bid + cancel** — `post_order`(bid) escrows USDC / `cancel_order` refunds exact + rent round-trip; zero option-token movement (bid = USDC-only).
>   - **S3 writer-ask** — `post_order`(writerAsk) locks $80 strike → `fill_writer_ask` mint-on-fill; premium to writer, collateral escrow→**writer_ask_pot**; vault counters UNCHANGED (pot-tracked); self-fill blocked (`taker≠order.owner`).
>   - **S4 resale** — `fill_order` **ResaleAsk** branch: option escrow→taker, supply unchanged (transfer, no mint), `maker_usdc` pinned to order.owner.
>   - **S5 bid + sell-into-bid** — `fill_order` **Bid** branch → **C-1 PROVEN**: raw-byte check of the destination ATA `owner(32..64)==order.owner ∧ mint(0..32)==option_mint` (the delivered token forced into the bidder's pinned account, not the taker's).
>   - **S6 early exercise** — `exercise_american` (atomic Pyth-post + exercise + close): burns 1, pays capped intrinsic from the **VAULT** (never the pot; pot is settle-time only), `exercised_options`/`early_exercise_payout` bumped, supply 2→1. **MED-1 cap** ran (min()) but non-binding at this moneyness (would clamp only at spot ≥ 2×strike=$160). Actual payout $1.123838 (from the in-tx Pyth spot), which surfaced FE toast bug → fixed in (3).
>   - **Canary end state:** supply 1 (B `GkG1UX8ML4…` holds the S3 writer-ask contract), vault_usdc $82.04 (**free $78.88 < $80 ⇒ 0 mintable = SOLD OUT**), pot $80.
>
> **(2) LADDER GENERATOR — ✅ FULL LIVE ROLL DONE (board populated).** `crank/ladderGenerator.ts`. Sequence: **filters** `--strike`/`--tenor` added (`f8ce8d3`, compose AND w/ `--asset`/`--side`; off-grid rejected); **idempotency scan-bug fixed** (`698e3e0`) — the scan gated account TYPE on `data.length===260`/`===137`, but SharedVault grew 260→268→276 (Phase-3 writer-ask fields) so **110/124 devnet vaults were INVISIBLE** → broke idempotency + Policy-B; fix = 8-byte discriminator memcmp (length now a read-safety floor, not a size gate); **canary** (SOL $80C weekly) then **full roll 161/161 cells, 0 failures**, ~3.25 SOL + $3.74M devnet USDC. Board = 3 assets (BTC/ETH/SOL) × 7 strikes (ATM±3 round grid) × 2 sides × 4 Fridays (Jul-10/17/31 + Sep-25), all American mint-on-fill, spread_bps=0. Idempotent re-run = clean no-op (0 CREATE / 164 SKIP / 4 policy-B). LIVE is dual-gated (`--live` **AND** `OPTA_GENERATOR_LIVE=1`; either alone → safe dry-run). Runs from LOCAL WSL (admin key + `~/.opta-rpc-helius`). Corrected an earlier mis-finding: the "2 ETH orphan-heals" were fully-seeded 276 B vaults misread by the same 260-bug.
>
> **(3) 3 FE DISPLAY BUGS — ✅ FIXED + SHIPPED (each solo, protocol-safe, `npm run build` clean, master+main).** All surfaced during the QA matrix; none affect funds/on-chain.
>   - **`a81544b` — λ mismatch.** Ticket λ divided by `estPrice` (transaction price), greeks panel by model premium → disagreed for the same contract. Unified the ticket on `mark.premium` (`OrderTicket.tsx:164`) — λ is a greek (Δ·S/V), V must be the price the delta was computed against. Now matches ContractDetailModal + SimpleTradePanel.
>   - **`3f702be` — exercise toast estimate.** The early-exercise success toast recomputed a $ payout from a **post-submit** Hermes fetch that races the in-tx Pyth price (~$0.96 shown vs $1.12 paid). Dropped the estimate → "N contract(s) exercised · USDC sent to your wallet" (`usePortfolioActions.ts`); removed 2 now-dead imports.
>   - **`24302d6` — peg-capacity gate.** Buy·Market was capacity-blind → an exhausted peg reverted `InsufficientVaultCollateral`. `OrderTicket` now derives `pegRemaining = floor(free/cpt)` from a **single-account** vault read (`free = (total_collateral − early_exercise_payout) − (minted − exercised)×cpt`), disables Buy ("Sold out · vault capacity exhausted") **only on the peg route** (a resting resale/writer ask ≤ peg still fills). Verified: the canary cell (free $78.88 → 0 remaining, empty book) now renders the disabled sold-out button.
>
> **(4) DEAD opta.fyi STATIC-DEPLOY PATH REMOVED (`7296cf0`).** ⚠️ **This SUPERSEDES the 2026-07-04 "reverted to self-host" correction below (the `RECORD CORRECTION` paragraph).** This session **re-verified live**: `/etc/nginx/sites-available/opta.fyi.conf` on `root@144.202.58.6` is a **reverse-proxy → `opta-solana.vercel.app`** (`location / { proxy_pass … }`, TLS via certbot), 0 5xx over 24h, buildId parity with Vercel. So the static path was genuinely dead: **deleted `scripts/deploy-web.sh` + `deploy/nginx/opta-headers.conf` from the repo, removed `/opt/opta-web/` on the VPS**; KEPT `opta.fyi.conf.bak-preproxy` + `/etc/nginx/snippets/opta-headers.conf` on the box as paired break-glass rollback artifacts. **Faucet note:** because `location /` proxies ALL paths (incl. `/api/*`) to Vercel, the H-04 faucet `/api/faucet` now works on `opta.fyi` too — the "opta.fyi faucet GAP" in the blocks below is RESOLVED as long as the proxy is in place.
>
> **▶ BUG-1 CONFIRMED LIVE (2026-07-06).** "Sold out · vault capacity exhausted" renders + Buy disabled on an exhausted cell (verified on ETH $1650 Call, one of **22** currently-exhausted American series cells found by a read-only scan). **Gate scoping verified BOTH directions** (spot moving mid-check gave a natural A/B test): peg cheapest-but-exhausted → BLOCKS; any resting ask ≤ peg → ALLOWS + fills the ask. The gate's `!(bestRestingAsk ≤ pegRef)` byte-mirrors the submit router's `asks[0].price ≤ pegRef` choice, so it blocks iff the router would route to the exhausted peg — never a fillable ask. (Masking nuance: the RFQ must resolve fresh or `amerQuoteGate` fires first and hides `pegGate` — so a deep-OTM/short-dated cell shows "Request quote", not "Sold out".)
>
> **▶ OPEN ITEMS (next session):**
>   - **Settlement QA slice (deferred — needs an expiry wait).** The one lifecycle path not yet prod-proven: let a vault reach expiry → `settle_vault` (with the writer-ask **pot sweep** + D2a equiv-shares merge) → `exercise_from_vault` / `auto_finalize_holders` (holder side) → `withdraw_post_settlement` (writer residual). The canary's own expiry is 2026-07-10; or seed a short-tenor custom vault to test sooner.
>   - **2 optional trade-page UX follow-ups (both cosmetic, protocol-safe — [[project_parked_tech_debt]] items 5+6):** (a) **grid sold-out badge** — the `24302d6` gate blocks in the ticket; the GRID cell still shows a normal price on an exhausted cell. Thread per-vault capacity from `useTradeData` (expose `vaults`, already via `useVaults`) → `TradeChainV2`, badge/dim the cell. (b) **smarter router** — Buy·Market on an exhausted-but-cheapest peg BLOCKS rather than falling through to the next fillable ask *above* the peg (user works around via Buy·Limit at the ask). Teach the router to skip an exhausted peg → next ask.
>
> ---

> **2026-07-04 (SESSION CLOSE — AppNav scroll-overlap fix + record correction).**
>
> **AppNav opaque-nav fix.** Commit `d5a9cbe` (master+main, live Vercel `d5a9cbe`). The shared fixed `AppNav` had NO background + `pointer-events-none` (a leftover transparent-overlay idiom), so on scroll page content showed AND clicked THROUGH the nav on every trader route (write/trade/markets/portfolio). Fixed in the ONE shared component: added `bg-paper` (#F1ECE2, the `--color-paper` token) + `border-b border-rule`, and removed `pointer-events-none`/`[&>*]:pointer-events-auto` so the opaque bar owns pointer events over its area. **Kept `position:fixed` (NOT sticky)** — all 4 pages already offset content with `<main pt-[120px]>`; sticky would stack the bar height on top and double the gap. `z-[200]` already sits above page content (modals `z-[300]` + grain `z-[9000]` intentionally higher). tsc+build clean; applies uniformly since it's the shared nav (per-route visual eyeball still worth a glance).
>
> **⚠️ RECORD CORRECTION — opta.fyi reverted to SELF-HOSTING (another agent; see [[project_opta_fyi_selfhost]]).** The `opta.fyi → Vercel reverse-proxy` I set up earlier this session is NO LONGER in place: opta.fyi again serves its own static build from `/opt/opta-web/dist` and **`deploy-web.sh` is REVIVED** (the "dead-code removal / 24h hold / delete-tomorrow" notes in the blocks below are VOID). **Consequence:** the H-04 faucet `/api/faucet` works ONLY on `opta-solana.vercel.app`, NOT on the static opta.fyi (no backend) — run faucet/API-dependent demos on the Vercel domain. The reverse-proxy + dead-code paragraphs below are HISTORICAL.

> **2026-07-04 (SESSION CLOSE — FAUCET v2: DURABLE COOLDOWNS + API-ROUTED SOL ✅ SHIPPED, FUNDED & LIVE-VERIFIED).**
>
> **Faucet limits reworked.** Commits `02d6f60` (feature) + `dc18034` (time-format fix), master+main, live on Vercel `02d6f60` (opta.fyi proxy serves it too).
> - **`app/api/faucet.ts`** now takes `{ wallet, kind?: "usdc" | "sol" }`. **Durable per-wallet cooldown** via Upstash Redis (Vercel "Upstash for Redis" — `KV_REST_API_URL` + `KV_REST_API_TOKEN` auto-injected, connected by Nanko): atomic `SET NX EX` (USDC `faucet:usdc:<w>` 86400s=24h; SOL `faucet:sol:<w>` 14400s=4h), `DEL`-released if the transfer fails so a failed tx never burns the window; 429 returns remaining from `TTL`. **FAIL-SAFE:** Redis unconfigured/throws → per-instance in-memory fallback + logged warning (faucet stays up). **SOL branch:** `SystemProgram.transfer` 50_000_000 lamports (0.05 SOL). USDC unchanged (10k cap + devnet-genesis guard). Old in-memory Map is now the fallback only.
> - **`DevnetSolButton`** POSTs `{kind:"sol"}` (was client `requestAirdrop`, which couldn't enforce an amount + was unreliable — a live `requestAirdrop(0.05)` returned `-32603`).
> - **Dep:** `@upstash/redis` added via `--package-lock-only` (10-line lock change, zero transitive deps). It shows a LOCAL-ONLY IDE "cannot find module" (not in local `node_modules`; `api/` is outside the tsc/vite build so `npm run build` is clean) — Vercel installs it and it works in prod (verified).
> - **FAUCET WALLET FUNDED:** 5 SOL admin `5YRMuuoY…` → faucet `J8Kct5tS…` (sig `3hHrYKNq…`); faucet now **5.497936 SOL** (~109 SOL-drops @ 0.05). Admin left 14.04 SOL. Script `scripts/_exec_fund_faucet.mjs` (untracked-local; reads the WSL admin keypair in place).
> - **LIVE VERIFY (throwaway `21nR5Tv8…`, all 4 pass):** USDC #1 → 200 balance 10,000 (sig `5sP6hQ6j…`); USDC #2 → **429** "try again in 24h"; SOL #1 → 200 sol 0.05 (sig `5kMDednv…`); SOL #2 → **429** "try again in 4h". (The verify found the `23h 60m`/`3h 60m` rounding bug → fixed in `dc18034`.)
>
> **▶ STILL PENDING from the prior arc:** opta.fyi→Vercel reverse-proxy is LIVE; **dead-code removal HELD** (`scripts/deploy-web.sh` + `snippets/opta-headers.conf`) until the proxy has 24h clean traffic (≥2026-07-05) — deploy-web.sh is the instant rollback path (see the block below). Option (c) DNS-to-Vercel queued (needs Hasan).

> **2026-07-04 (SESSION CLOSE — H-04 FAUCET-KEY ROTATION + H-05 AMERICAN QUOTE HARD-GATES ✅ BOTH SHIPPED & LIVE-VERIFIED).** Both closed pending Nanko's 3-click UI smoke on prod.
>
> **(1) H-04 — BUNDLED FAUCET KEY REMOVED (server-side rotation).** Commit `da6a11b` (master+main, 5 files). The devnet faucet 64-byte secret was bundled in `app/src/utils/constants.ts` (`DEVNET_FAUCET_KEYPAIR`) and shipped in the Vercel bundle + committed since `5807eeb` — now deleted everywhere.
>   - **New serverless route `app/api/faucet.ts`** (Vercel Node function; NOT in the Vite/tsc client build — outside `src/`). Holds the key in server-only env var **`FAUCET_SECRET_KEY`** (JSON-array format, NO `VITE_`/`NEXT_PUBLIC_` prefix). Signs the USDC transfer server-side (faucet = fee payer + authority; user signs nothing). Guards: **devnet-genesis hard check**, fixed 10k-USDC cap, best-effort per-wallet cooldown.
>   - `Header.tsx`: deleted the key import + `Keypair.fromSecretKey`; `handleUsdcFaucet` → `fetch('/api/faucet')`; graceful "Faucet not configured" toast on 503.
>   - **Prebuild secret gate** `app/scripts/check-no-bundled-secrets.mjs` + package.json `"prebuild"` — fails any build containing `DEVNET_FAUCET_KEYPAIR`, `Keypair.fromSecretKey`, or a 32+ byte `Uint8Array` literal. Runs on every Vercel build. Teeth-proven (probe → exit 1).
>   - **KEY ROTATION DONE (real devnet money moved):** burned wallet `D6wgdCN1JNNUF28BGks9tNz2yDZdoqMgtxJys4xq1e1n` DRAINED → new server-side wallet **`J8Kct5tS5SvbmNj8fiuND94D4ZL5Cvip1MXsJLFRpEPz`**. TX1 `2Qrboe3v…` (9,980,000 USDC swept + burned ATA closed), TX2 `xcXgrmuy…` (0.497951 SOL swept, burned account zeroed/reaped). Burned key now controls NOTHING (still public in git history — irrelevant, devnet-only + empty; NO history rewrite needed). Local drain tool `scripts/_exec_drain_faucet.mjs` kept untracked (holds only the already-public burned key).
>   - **LIVE-VERIFIED on `opta-solana.vercel.app`:** `GET /api/faucet` → 405 JSON from the handler (proves it's a **function**, NOT swallowed by the `/(.*)→/index.html` rewrite — Vercel resolves functions before rewrites). `POST` valid → **200** + real sig `4Po1uJDK…` + balance. Devnet-genesis guard + 10k cap enforced.
>   - **⚠️ COOLDOWN CAVEAT — ACCEPTED (decision A).** Per-wallet cooldown is in-memory (module-scope Map) and does NOT survive across Vercel's multiple function instances — confirmed live (rapid repeat → 200, not 429). A scripted caller could loop-drain the faucet. ACCEPTED because it's devnet mock-USDC (valueless, re-mintable) behind the devnet-genesis + fixed-cap guards. Durable throttling (Vercel KV / Upstash) is a future opt-in slice, NOT built.
>   - **🚩 `opta.fyi` GAP — PROPOSAL ONLY (pending greenlight, NOT built).** The serverless faucet exists ONLY on the Vercel domain. `opta.fyi` is static nginx on the VPS (`root@144.202.58.6`, `scripts/deploy-web.sh`) with no `/api` functions → the faucet button there 404s. Fix (if wanted): an nginx `location /api/faucet` proxy to the Vercel function or a tiny local signer. Security goal is met regardless (key is off every client bundle).
>
> **(2) H-05 — AMERICAN QUOTE HARD-GATES.** Commit `8dbd72b` (master+main, 8 files). American writes/buys could proceed on the EUR Black-Scholes model / cheap aggregate when the on-chain `get_option_price` quote was warming/stale/uninitialized/never-requested. Now a **fresh protocol quote is a hard submit gate** on every American surface; European paths byte-identical (B-S stays display-only, never a gate).
>   - **Shared authority (one definition of "fresh"):** `optionPriceQuote.ts` → `quoteFreshness(loading, error, quote)` → `{isFresh, statusReason}` (fresh = resolved quote ∧ ¬loading ∧ ¬error). Documented extension point for a future VolOracle `sample_count` decode (M1 warming badge) — NOT built. Reactive wrapper `hooks/useOptionPriceQuoteFreshness.ts`.
>   - **Gated:** `OrderTicket` (primary V2 ticket — confirmed LIVE via TradePageV2+ContractDetailModal, not dead): American Buy·Market/Buy·Limit/Write hard-block until RFQ fresh; **killed the EUR `mark.premium` fallback** in the peg reference + peg `maxPremium`; RFQ button now also renders in Write mode so the gate is satisfiable; Sell (resale) not gated. `BuyModal` (`canSubmit` requires fresh). `OfferingsPanel` (EUR `fairPremium` no longer a vs-fair basis for American → pills suppress, display-only). `WriterForm` (new `americanQuoteBlock` prop; `Custom/EpochVaultSection` compute it via the shared hook — freshness is expiry-independent so the front/chosen expiry validates the whole write). `LiveQuoteCard` UNCHANGED (already advisory/indicative).
>   - Verified: `tsc -b` + vite build clean; H-04 secret gate still green. Interactive warm-vs-warming smoke pending on prod.
>
> **▶ NEXT SUBSTANTIVE ARC:** trade-page v1 arc (per the 2026-07-03 ordering, now that H-04/H-05 are done).

> **2026-07-04 (SESSION CLOSE — H-03 PREMIUM-BEARING RECLAIM ARC ✅ COMPLETE, live-proven).**
>
> **The last open funds-recovery gap is closed.** `reclaim_unsettled` now pays each writer's unclaimed premium + pro-rata collateral atomically (one `vault_usdc→writer_usdc` transfer, cranker signs, payout owner-pinned to the writer). Replaces the old `ClaimPremiumFirst` precondition that stranded premium-bearing dead-feed vaults (claim_premium needs the writer to sign — impossible once the feed is dead). Zero-premium path byte-identical; accounts struct unchanged (no IDL change); `ClaimPremiumFirst` enum variant retained (still used by withdraw_from_vault → error codes unshifted).
>
> **(1) RUST — ✅ SHIPPED + DEPLOYED.** Commit `d712ea9` (master+main). Deployed **opta ONLY, feature-free, slot 473901900** (was 473707105), authority admin `5YRMuuoY`, `.so` sha256 `fc9f2051…`, deploy sig `4FetSCDA…`. Smaller-upgrade (1596176 vs prior 1604624) → on-chain first-N == local, 8448-byte tail all-zero (verified). Gates: cargo clean / **bankrun 15/15 reclaim** (new: single / partial-prior-claim / multi-writer / double-call / malicious-cranker→ConstraintRaw / not-voided→VaultNotVoided) + full bankrun suite exit 0 / host-unit 84-0 / **validator 90-pass 0-fail 66-pending**. NO hook redeploy, NO VPS redeploy.
>
> **(2) LIVE CANARIES — ✅ BOTH PROVEN (real money moved, admin as cranker on THIRD-PARTY writers).**
>   - **Canary A** = TSLA Call $450 `8jrkhmvhY66uBAkAxrnvmKviKQLirHLUcuv58T7uFdGe` (single writer `GkG1UX8M…`). initialize_void (`4LdfddLc…`) → reclaim (`41TVZC9M…`): premium $24.743934 + collateral $22,500.00 = **$22,524.743934** to writer ATA; vault_usdc→0; shares→0; premium_claimed→24743934; conservation exact.
>   - **Canary B** = AAPL Call $300 `8AGz9VrJLEQkmG3ghQFm3WaGr2YLL3b4Kr4YbYbALRtc` (2 writers). void (`3zPAYnMo…`) → reclaim W1 `GkG1UX8M…` (`5UXnD4kG…`, **premium_debt=5281766** case, +$60,017.902588) → reclaim W2 `DnExEYnZ…` (`oD8P1Zsk…`, +$150,057.960885). Running CR/TS decremented per-writer; vault_usdc→0; **conservation exact, 0 floor dust** (CR==TS 1:1). Proves per-writer iteration + voided-doesn't-block-2nd-writer + nonzero premium_debt.
>
> **(3) CRANK — ✅ COMMITTED + DEPLOYED TO VPS.** Commit `3ca63cc` (master+main): removed the `premium_per_share_cumulative != 0` skip in `runReclaimSweep` + refreshed stale "zero-premium only" comments (reclaimUnsettled.ts + bot.ts). 2-phase orchestrator unchanged. crank tsc + typecheck:tests clean. **Deployed to the VPS 2026-07-04** — pulled `main` to tip `a2e1a1a`, restarted (PID 25769); reclaim stays DARK (`OPTA_RECLAIM_CRANK_ENABLED` absent). See the redeploy note + July-8 flip runbook below.
>
> **▶ 2 VAULTS INTENTIONALLY HELD as premium-bearing crank canaries — DO NOT void/reclaim manually:**
>   - **MSFT Put $400** `GteYo9RbYjHQ4EMBoLDQ86xByDMWmfVR1N7xgxFndYXB` (1 writer, ~$204,300)
>   - **TSLA Put $400** `8xW8ewiqbCrE6H9s5opQ3XCXq6JgL19ESDM6g7Ca7ViR` (1 writer, ~$20,065)
>   They are the live proof for the crank's AUTOMATED premium-bearing sweep — now unblocked (VPS at `3ca63cc`, reclaim dark until the July-8 flip).
>
> **▶ VPS CRANK REDEPLOY — ✅ DONE 2026-07-04 (pulled early; hard prerequisite for the flip).** SSH `root@144.202.58.6` `/opt/opta-crank`, `git pull` `main` → tip `a2e1a1a` (was `01adb9d`, which PREDATED `8b4c9b3` — the running crank had NO reclaim pass at all, so this redeploy was mandatory before any flip). `systemctl restart --no-block opta-crank` → new PID 25769, `active`, config `"reclaim":{"enabled":false}` (DARK), ticks clean (trigger / vol-oracle / sb-oracle), no fatal errors, errors = pre-existing equity 404s only. `OPTA_RECLAIM_CRANK_ENABLED` still ABSENT. No `npm install` (no dep/IDL change); ts-node is `transpileOnly` so the VPS app/src typecheck errors (app node_modules not installed there) don't block startup — pre-existing, unrelated.
>   - **Dry-run PROOF (deployed code, `crank/_probe_reclaim_dryrun.ts`):** **3 candidates today** — `8xW8ewi` TSLA Put (premium, 1 writer, +43d grace) + `GteYo9R` MSFT Put (premium, 1 writer, +43d) + `BAhgX8uA` BTC husk (zero-premium, 0 writers, +36d); `usdcMoved=0`, `errors=0`, nothing sent. **Confirms `3ca63cc` filter removal is LIVE** — both premium-bearing vaults now appear (on the old code only `BAhgX8uA` showed → the July-1 "1 candidate"). `Ad5zz684` correctly grace-EXCLUDED (void-eligible `2026-07-08T23:19:56Z` > now) → it becomes the **4th** candidate exactly on July 8. Canary A/B vaults (voided) correctly excluded.
>
> **▶ JULY-8 FLIP RUNBOOK (23:19:56Z, one sitting) — 4 candidates in ONE tick. SUPERSEDES the 2-candidate July-8 runbook in the 2026-07-02 block below.** VPS is already at tip; just flip `OPTA_RECLAIM_CRANK_ENABLED=1` in `/opt/opta-crank/.env` → `systemctl restart --no-block opta-crank` → observe ONE tick process all 4:
>   - `Ad5zz684…` seed vault (mixed $10 pool + $200 pot) — `initialize_void` (sweeps pot → vault_usdc, D2a merge) + `reclaim_unsettled` → D's $10 pool share.
>   - `BAhgX8uA…` BTC husk (0 writers) — void ONLY (nothing to reclaim; terminal).
>   - `GteYo9R…` MSFT Put $400 (1 writer `DnExEYnZ…`, ~$204,300) — void + **premium-bearing** reclaim (unclaimed premium + pro-rata collateral, atomic).
>   - `8xW8ewi…` TSLA Put $400 (1 writer `DnExEYnZ…`, ~$20,065) — void + **premium-bearing** reclaim.
>   Then MANUAL permissionless `reclaim_writer_ask_residual` on `Ad5zz684` (backer, expected ~$200 — verify exact). **Conservation check across ALL 4** (each vault_usdc → 0 or documented floor dust; Σ payouts == pre-void balances). Decide whether reclaim stays enabled after. Live-proves BOTH the zero-premium and premium-bearing automated crank sweeps + the writer-ask void residual in one run.
>
> **▶ HARNESS NOTE (local-only):** `.test-fixtures/run-tests.sh` needs `mkdir -p .anchor` before launching the validator (else `--ledger .anchor/test-ledger` fails to boot and the suite hangs). Applied on-disk locally, but `.test-fixtures/` is gitignored (`.gitignore:35`) so it is NOT committed — either un-ignore run-tests.sh specifically or re-apply the one-liner in fresh checkouts. Also: run validator gates on a **/tmp ledger**, not /mnt/d (too slow).
>
> **▶ NEXT SUBSTANTIVE ARC:** H-03 done → per the 2026-07-03 ordering, next is frontend/ops (H-04 bundled faucet key removal, H-05 American quote hard-gates), then the trade-page v1 arc. Read-only H-03 tooling kept local (untracked): `scripts/_probe_h03_candidates.ts`, `_probe_h03_sizes.ts`, `_probe_h03_canary{A,B}.ts`, `_exec_h03_canary{A,B}.ts`.

> **2026-07-03 (SESSION CLOSE — TWO-AUDIT MERGE FIXES LIVE + VALIDATOR DEBT RESOLVED). ▶ RESUME HERE:**
>
> **(1) AUDIT-FIX SLICE — ✅ 5 PATCHES LIVE.** Merged Run-8 + A-to-Z static audit; landed on-chain fixes only. Commit `7a1be4c` (20 files, +817/−75), pushed master+main. Deployed both programs, opta first: **opta slot 473707105** (was 473484452, tx `5BqyZ6bz`), **hook slot 473707252** (was 464160129, tx `3PkGsUmT`), authority admin `5YRMuuoY`, sbf v3 feature-free. Patches:
>   - **C-1 (CRITICAL):** fill_order Bid branch — pinned maker_option_account to order.owner/option_mint (raw byte-check) → closed theft of every open Bid's escrowed USDC. New err MakerOptionAccountInvalid (6077).
>   - **H-1 (High):** bounded permissionless seed_vol to 0-sentinel or [0.05, 2.0] in initialize_vol_oracle; reset_vol_oracle re-seeds (admin repair path); L-7 sign guard in quote.rs. New err SeedVolOutOfBounds (6078).
>   - **H-2 (High):** holders-first window now gates on `total_options_sold > 0 || writer_ask_collateral_swept > 0` (withdraw_post_settlement + auto_finalize_writers) → writer-ask ITM holders no longer front-run by pool writers. Accounting-safe (touches no settlement math).
>   - **A-to-Z H-01:** hook protocol_state → Signer; both opta CPI sites (create_series, mint_from_vault) → new_with_signer(PROTOCOL_SEED) → closed pre-init squat. Touched BOTH programs (why opta deploys first — matched pair).
>   - **M-1/M-03:** reconciled feature_flags to WRITER_ASKS_ENABLED + AMERICAN_ENABLED both TRUE (the Jul 1 flip is intentional); fixed RED invariant test + stale dark-launch comments.
>   - **Live smokes ALL PASSED:** P4 CPI pair (create_series tx `uj4YSVbN` + mint_from_vault, hook PDAs init'd), fill_order Bid honest path (fillBid tx `3M43NWEy`, pin accepts legit maker acct). Theft-blocked negative path is bankrun-proven.
>
> **(2) VALIDATOR TEST DEBT — ✅ RESOLVED (deterministic 0).** The 31 stale failures were 3 drift classes, not ~15 sites. Commits `3db2a0c` (83 site-edits: initializeVolOracle 3-arg + SB-null across 17 files, + tsconfig.typecheck.json + `npm run typecheck:tests` gate wired into `npm test`, teeth-verified catches 2-arg drift) and `74216eb` (reach-0: deleted zzz-vol-oracle.ts [bankrun-covered], future-dated SOL fixture for shared-vaults, shrank settle_expiry offsets to base+2..7 to beat validator clock lag, opta hook test → signed bogus keypair). Both pushed master+main. **Validator now 90/0/66, deterministic across 3x runs; bankrun 194/0/2; typecheck green.** Drift now caught at compile time.
>   - Known skip: `_vol_oracle_helpers.ts` stays any-typed (calls test-synth-only synthWarmVolOracle absent from feature-free IDL); inline callers in typed files ARE gate-covered.
>
> **▶ JULY 8 RUNBOOK STILL STANDS** (from 2026-07-02 block below, 23:19:56Z) — void seed reclaim canary is unchanged and unaffected by today's slice. Do not lose it; July 8 is close.
>
> **▶ NEXT SUBSTANTIVE ARC = H-03 premium-bearing reclaim** — the last open funds-recovery gap. Needs a NEW Rust instruction: permissionless dead-feed vault unwind that atomically pays unclaimed premium + pro-rata collateral to the writer's ATA (cranker signs, payout pinned to writer, never redirected). Currently premium-bearing dead-feed vaults are writer-gated + stranded by design (claim_premium needs writer Signer). Then, in order: frontend/ops (H-04 bundled faucet key removal, H-05 American quote hard-gates), then alignment (crank redeploy — 1 commit behind on default-OFF sweep, functional no-op; untracked-work commit + gitignore split).

> **2026-07-02 (SESSION CLOSE — WRITER-ASK ARC LIVE + PROVEN; void seeded). ▶ RESUME HERE:**
>
> **(1) WRITER_ASKS_ENABLED — ✅ LIVE.** Upgrade `2HqRePHq…PcyL`, slot 473200808→473317653, hash `a8d16dfc…9028b8b`, authority admin, buffer consumed (+10.448 SOL recovered), NO brick (behavior-only, no schema delta). Flag commit `9ab31dd`. Dark source rebuilt byte-identical to prior on-chain 276 (reproducible).
>
> **(2) SETTLE-PATH — ✅ FIRST-EVER LIVE PROOF, 13/13** (commit `9f28206`, `scripts/_smoke_writer_ask_devnet.ts`). post_order(WriterAsk) → fill_writer_ask (mint-on-fill, maker +$3.98, treasury +$0.02 @50bps, pool untouched) → settle_vault pot-sweep (sig `HaNCCDPU…`): swept $158, pot_usdc→0, vault_usdc $10→$168, equiv 158M, total_shares 10M→168M (D2a merge live). Artifacts left on-chain as proof.
>
> **(3) VOID SEED — ✅ PLANTED (commit `72bd9d6`, `scripts/_seed_void_writer_ask_devnet.ts`). VOID-ELIGIBLE 1783552796 = 2026-07-08T23:19:56Z.** SBXAU American CUSTOM mixed vault **`Ad5zz684isTKpt8QjCUmFxozkL4RLPuGK8aXMe4yy49S`** — $10 pool + $200 pot ($100 cpt × 2), ppsc==0, expiry 1782947996. Settlement PDA **`3geeo9bu6gDfXYMtsrZby4DXxMcjLCs7pfEGyeRD9Lfj`** ABSENT — confirmed at expiry+360s AND at +554s with the SB crank LIVE (correctly classifies past-window, never settles). Dead-feed forced via ~9-min `OPTA_SB_CRANK_DISABLED=1` VPS pause spanning the 300s SB settle window → `SwitchboardSettleWindowElapsed` permanent; VPS reverted (=0, PID 1497450, loops clean, errors = pre-existing equity 404s only). `OPTA_RECLAIM_CRANK_ENABLED` confirmed absent from .env. Seed sigs: series `D9mfZnZi…`, vault `3Pr4b7WA…`, post `dXSSDig6…`, fill `2EcCTCcu…`; buyer `59SdYhcJ…`. **RECORD CORRECTIONS:** (a) SB gold quotable 24/7 via PAXG (Binance/Coinbase) — weekend-closure dead-feed does NOT work; pause lever mandatory. (b) `reclaim_writer_ask_residual` is PERMISSIONLESS (cranker signs, payout pinned to backer) — crank not wiring it = plain wiring gap (future follow-up), NOT GATE-C class.
>
> **▶ JULY 8 RUNBOOK (23:19:56Z, one sitting):** flip `OPTA_RECLAIM_CRANK_ENABLED=1` on the VPS → observe ONE tick process BOTH candidates: seed vault `Ad5zz684…` (initialize_void + reclaim_unsettled → D's $10 pool) + husk `BAhgX8uA` (void only) → manual permissionless `reclaim_writer_ask_residual` (backer, expected $200 — verify exact) → conservation check → decide whether reclaim stays enabled. Closes the void path + live-proves the wired crank pass in one run.
>
> **▶ NEXT ACTIVE ARC = TRADE PAGE v1.** Cut LOCKED: GRID (Deribit chain) + CHART (TradingView, CONTRACT/UNDERLYING, BS-2002 mark fallback) + merged ticket (Market/Limit buy, writer-ask posting, cancel) + positions. **TP/SL + Stop + keeper (phase 4) = post-launch fast-follow; RFQ deferred.** First step: trade-v2 autopsy recon (v2 aborted broken 2026-06-29, `TRADE_V2_UI` false, CSP must be proven on a Vercel preview branch). Parked parallel: ladder-gen SOL canary (Nanko's run) for book depth.

> **2026-07-01 (RECLAIM-WIRING ARC — ✅ SHIPPED DARK, committed 8b4c9b3, master+main). ▶ RESUME CONTEXT:** the dead-feed reclaim sweep is wired into the crank as a Phase-3 tick() pass, default-OFF (`OPTA_RECLAIM_CRANK_ENABLED` unset → block skipped entirely on the live VPS; verified dark). `runReclaimSweep` (in `crank/reclaimUnsettled.ts`) reuses already-fetched vaults+markets (no new gPA), gates on cluster-time 7-day grace, filters ZERO-PREMIUM only (`premium_per_share_cumulative==0`), probes settlement-record absence, crash-isolates per candidate, USDC-delta accounts. Premium-bearing reclaim stays writer-gated by design (`claim_premium` needs writer signer — GATE C finding). Dry-run PROVEN (`crank/_probe_reclaim_dryrun.ts`): exactly 1 candidate (`BAhgX8uA` BTC husk, 33d past grace), 2-phase planned, usdcMoved=0, 0 errors, tsc clean. **LIVE CANARY HELD** — `crank/_canary_reclaim.ts` takes `<VAULT_PUBKEY>` as CLI arg, created but NOT run. Reason: the only current candidate (`BAhgX8uA`) has 0 writers, so it would prove only `initialize_void`, not `reclaim_unsettled` — and voided is a terminal one-way door for zero recovery. Reclaim leg stays bankrun-only until a writer-bearing zero-premium candidate exists; both legs get proven together then. **R3 ORDER-CUTOVER now VERIFIED COMPLETE** (book empty, 0 orphans, all 3 legacy orders cancelled+closed pre-R-2 — resolves the prior UNVERIFIED flag).
>
> **NEXT FORWARD PATH:** (1) `WRITER_ASKS_ENABLED` flip — its own redeploy, the last step in the writer-ask arc, after the writer-ask lifecycle is proven; (2) operational `reset_vol_oracle` SB-gold seed (`6c3c5cc7`, commodity seed `550000000000`) if/when weekend gold writes are exercised; (3) trade-page build (the next major FE arc). The 4 premium-bearing dead-feed equity vaults (~$456k devnet-USDC notional: AAPL/2×TSLA/MSFT) remain writer-gated + stranded by design — recovery needs a new Rust arc (fold premium into reclaim_unsettled payout), deferred, devnet test USDC only.

> **⚠ ARCHITECTURAL BOUNDARY (Phase 3 Slice D1, 2026-06-30) — settle_vault sweeps EXACTLY ONE writer-ask pot.** `settle_vault` folds the writer-ask pot into the settlement waterfall by sweeping the single pot passed in its optional accounts (pinned via `writer_ask_pot.vault == shared_vault.key()`). **A vault with WriterAsk pots on >1 series mint would strand the un-passed pots — settle is once-only (the `is_settled` guard), so a second sweep can't run.** The production series model (D5: one canonical mint per American vault → one pot) prevents this. **If multi-mint-per-vault is ever introduced, `settle_vault` MUST loop over all pots (remaining_accounts) or it strands writer-ask collateral.** This is dark until the Phase 3 gate flips (post-D3).

> **2026-07-01 (GATE C finding — permissionless reclaim is writer-gated for premium-bearing vaults).** `claim_premium` requires `writer: Signer` (`claim_premium.rs`), so the permissionless cranker cannot zero a third-party writer's unclaimed premium on their behalf. Because `reclaim_unsettled` requires `unclaimed_premium == 0`, a premium-bearing dead-feed vault cannot be permissionlessly wound down — its collateral is stranded until the writer themselves signs `claim_premium`. Crank reclaim wiring must therefore target zero-premium (or already-claimed) voidable vaults only; premium-bearing ones are writer-gated by design. Proven live: `6bm8c9GU` (NVDA) is `voided=true` but its 226.22 USDC premium + 220k collateral await writer `GkG1UX8M…`'s own claim. Zero-premium path proven on `C7tYE86f` ($3.6M, full reconcile). **CANDIDATE FUTURE RUST ARC (not scoped, not built):** fold unclaimed premium into `reclaim_unsettled`'s permissionless payout so writer-abandoned collateral can be wound down — a protocol-design decision, deferred.

> **2026-07-01 (R+M+C REDEPLOY WINDOW — ✅ CLOSED & RECONCILED). ▶ RESUME HERE:** the window is DONE. Program live at **276** (slot **473200808**, hash **`a2e8c9e8…00c8fef`**, authority admin `5YRMuuoY`); **80 healthy vaults migrated 260→276** (14 corrupt untouched, 261,863.585 USDC intact); **crank cut over to `01adb9d`** on the VPS running the rewired **10-account `settle_vault`** (0 deser errors, finalizing 276 vaults clean); **`crank/reclaimUnsettled.ts` committed but DORMANT** (not wired into the loop — the cutover changed only the settle path + IDL). **`WRITER_ASKS_ENABLED` still FALSE** (feature-free build; post/fill revert 6054). **NEXT ARC = (1)** wire + gate the reclaim loop — **zero-premium voidable vaults ONLY** (premium-bearing reclaim is writer-gated: `claim_premium` needs `writer: Signer`; see the GATE C finding above); **(2)** later, its own redeploy — the `WRITER_ASKS_ENABLED` flip. **Still UNVERIFIED:** R3 order-cutover — the 3 legacy 146-byte orders `2SDtxyJe`/`4KbPbxh6`/`CXxCkx1j` deser-fail at 154 bytes post-deploy; confirm they were cancelled pre-R-2 or are now bricked orphans. The block below is the HISTORICAL execution runbook, kept as the record.

> **2026-07-01 (R+M+C RUNBOOK v2 — HISTORICAL; window EXECUTED & CLOSED, superseded by the ✅ CLOSED pointer above).**
>
> **WINDOW STATE — R-1 (extend) LANDED, inert, NO brick. R-2…W pending.**
> - **R-1 extend** tx `45TaWvPsRtGiBGQ2jUXNGFk164LAiAor6KJSQfFk96ZJvwZDNbNLckVeT5Hvao1sS47si5uLg6zYupk4cEampn1w`; ProgramData `1,433,552 → 1,564,624` (+131,072); admin SOL `25.801 → 24.889` (rent delta 0.9123). **Capacity now sufficient for R-2** (1,564,624 ≥ opta.so 1,489,112; 75,512 B headroom for the later F flip).
> - ⚠ **`Last Deployed Slot` moved `472308749 → 473101461` — this is a METADATA bump from the extend tx, NOT a redeploy.** Executable unchanged; crank confirmed looping clean post-extend; all vaults still readable; **no brick**. **R-2 verify compares slot against the NEW baseline `473101461`** (a real upgrade pushes it ABOVE that), never 472308749.
> - **NEXT = GATE R-2.** The brick window opens the instant R-2's upgrade lands. **R-2 → M1 → M2 → M3 → M4 → C → W MUST run as ONE coordinated sitting** — between R-2 and M-complete the 80 vaults are deser-bricked (260 < new 276) and all settlements revert. Crank stays RUNNING throughout (Window Rule a).
>
> **BUILD ARTIFACT:** `target/deploy/opta.so` sha256 **`a2e8c9e8711ad5cf427e9aa91d9d44a45fa1d0ef4c571f0091d56713500c8fef`**, 1,489,112 B, feature-free, built from master `3c328cb` via `cargo build-sbf --arch v3 --tools-version v1.54` (NO `--features` — LOW-5 clean, no `compile_error!`). Toolchain: solana-cli 4.1.0-rc.1 (Agave), cargo-build-sbf 4.1.0, platform-tools v1.54. ⚠ **If the next session is a FRESH CONTAINER the .so won't persist → REBUILD + RE-HASH-VERIFY (must equal `a2e8c9e8…00c8fef`) before R-2.**
>
> **CORRECTED DEPLOY FACTS (caught at R build-sanity):** (1) local `target/deploy/opta-keypair.json` = `BFoJTD7F…` ≠ deployed `CtzJ4…` → **upgrade BY ADDRESS, never the keypair file** (keypair-file deploy would create a broken new program at BFoJ). (2) program upgrade authority = admin `5YRMuuoY` = config keypair `/home/nanko/.config/solana/id.json`.
>
> **═══ RUNBOOK v2 — CANONICAL EXECUTION DOC ═══**
>
> **WINDOW RULES (apply throughout):**
> - **(a) Crank stays RUNNING through R-2→M — do NOT pause.** Its settle/finalize loops are sim/pre-check gated (`txSent:0` on failure → gas-free); it catches+retries (no crash); the vol/sb oracle-push loops are unaffected by R/M and keep warming feeds. C restarts it with rewired code anyway.
> - **(b) ALL expiry/settlement timing uses DEVNET CLUSTER TIME** (`getBlockTime(getSlot())`), never the local clock (~5h skew confirmed).
> - **(c) Pre-existing Hermes-404 settle blocker is OUT-OF-WINDOW.** The crank's stuck `(asset,expiry)` tuples are old/equity vaults (PriceTooOld >30d / equity-404); a 404 there is NOT a cutover regression. GATE C uses a price-resolvable SYNTHETIC vault.
>
> **GATE R-2 (🔴 buffer write + upgrade — THE BRICK; verify baseline slot 473101461):**
> ```
> solana program write-buffer target/deploy/opta.so \
>   --buffer-authority /home/nanko/.config/solana/id.json \
>   --keypair /home/nanko/.config/solana/id.json \
>   --url "$(cat ~/.opta-rpc-helius)"
> #   → BUFFER_PUBKEY (re-runnable; on failure REUSE the buffer, don't re-write). Buffer
> #   authority = admin so the upgrade's authority check (buffer.auth == program.upgrade_auth) passes.
> solana program upgrade <BUFFER_PUBKEY> CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq \
>   --upgrade-authority /home/nanko/.config/solana/id.json \
>   --url "$(cat ~/.opta-rpc-helius)"
> ```
> Verify: `_phase0_capture.ts` → slot > 473101461, deployed hash == `a2e8c9e8…`, authority still admin; fetch a target vault via the new IDL → `AccountDidNotDeserialize` (BRICK CONFIRMED → go STRAIGHT to M1).
>
> **GATE M1–M4 (🔴 each batch its own greenlight; idempotent skip-if-grown, resumable):**
> ```
> OPTA_RPC_URL="$(cat ~/.opta-rpc-helius)" MODE=sim  BATCH=B1 npx ts-node --transpile-only scripts/_exec_migrate.ts
> # greenlight, then:
> OPTA_RPC_URL="$(cat ~/.opta-rpc-helius)" MODE=exec BATCH=B1 npx ts-node --transpile-only scripts/_exec_migrate.ts
> ```
> 80 healthy vaults (94 − 14 corrupt) in B1/B2/B3/B4 of 20 (partition in `scripts/_phase0_baseline.json`). Admin pays rent delta (~0.009 SOL total). Per-batch verify (in-script): all 20 → len 276; running count 20→40→60→80. ⚠ Executor **sim is only valid POST-R-2** (instruction absent pre-upgrade). The 14 corrupt are EXCLUDED (unmigratable — see corrupt-vault entry below).
>
> **GATE C (🟡 off-chain VPS; roll-forward):** settle crank 4→6 derived accounts (`app/src/utils/pythPullPost.ts:977`); reclaim path → 2-phase `initialize_void` → `reclaim_unsettled` (drops `market` + `settlement_record`). Pull rewired crank + synced IDL (IDL first), `npm install` if deps changed, `systemctl restart opta-crank --no-block` + poll the drain (never `journalctl -f`).
> Verify (SYNTHETIC, deterministic): create fresh SOL EUR vault `expiry = cluster_now + ~120s` + small deposit (born 276, no migration); wait CLUSTER time past expiry; rewired crank `settle_expiry` (live SOL print, publish_time ∈ [expiry, expiry+60]) + `settle_vault` (6 accounts) → `is_settled=true`. **No pre-existing vault is settleable** (7× PriceTooOld >30d, 1× MSTR equity-404).
>
> **PHASE W (window-close, read-only):** all 80 at 276 & readable; the synthetic settled; crank driving; the 14 corrupt still 260 AND vault_usdc still **261,863.585 USDC** (diff vs `scripts/_phase0_baseline.json`). Cluster time throughout.
>
> **OUT OF WINDOW — F (`WRITER_ASKS_ENABLED` flip):** a separate later redeploy after the writer-ask lifecycle is proven; this window stays DARK (`WRITER_ASKS_ENABLED=false`).
>
> **OPS ARTIFACTS (untracked, local in `scripts/`):** `_phase0_capture.ts` (+ `_phase0_baseline.json` baseline), `_exec_migrate.ts` (pre-staged executor, reads the baseline), `_recon_vault_sizes.ts`, `_recon_corrupt_claims.ts`, `_recon_c_candidates.ts`, `_recon_r3_orders.ts`, `_exec_r3_cancel.ts`. VPS: `ssh -i ~/.ssh/_vps_key root@144.202.58.6` (chmod-600 copy of `/mnt/c/Users/pc/.ssh/id_ed25519`; known_hosts at `/mnt/c/Users/pc/.ssh/known_hosts`). RPC: `~/.opta-rpc-helius`. Admin keypair: `/home/nanko/.config/solana/id.json` (5YRMuuoY, LOCAL-only).
>
> **═══ END RUNBOOK v2 ═══**

> **2026-07-01 (devnet corrupt-vault inventory — LOGGED, no action) — 14 SharedVaults are deser-corrupt at the `is_settled` byte; excluded from the 276-migration; ~261.9k devnet-USDC + 14 writer claims stranded behind them. Standalone future force-recovery workstream (NOT in R+M+C scope, NOT built, NOT proposed). Devnet test USDC, no real-money value — logged so stranded collateral isn't silently abandoned, not an emergency.**
> **This inventory is the SOURCE of the locked 80-vault migration scope (94 live − 14 corrupt) that the R+M+C redeploy window operates on — not just a cleanup log; the migration batch count + window plan derive from the numbers here.**
>
> **What.** A read-only gPA-by-discriminator sweep of all 94 live SharedVaults (uniform 260 bytes; deployed `INIT_SPACE`=252) found **14** whose `is_settled` (byte 178) holds a **non-bool** value — 176 (×9), 208 (×4), 171 (×1), not 0/1. All 14 are **expired since April 2026**, `voided=0`, and never reached a clean settled/voided terminal state. **Excluded from the 276-migration:** the migration grows by SIZE only (raw realloc, never reads `is_settled`), so growing them to 276 does NOT repair the byte — Borsh rejects `is_settled ∉ {0,1}` at 276 exactly as at 260, so they stay unreadable by the typed `Account<SharedVault>` path (which is why `safeFetchAll` already drops them). Migrating them would only spend admin rent on accounts that remain dead. **Migration scope = 80 healthy vaults / 4 batches of 20.**
>
> **Stranded value (read-only, 2026-07-01).** 261,863.585 devnet USDC across 14 WriterPositions in 13 vaults (`ECbN1dX8…` is the lone empty husk — 0 USDC / 0 WP). Corruption is **localized to byte 178** — layout intact through byte 106, so the `vault_usdc` pointers (`stored == derived ["vault_usdc", vault]` for all 14) and balances are trustworthy. Several show `vault_usdc > WP deposited` = buyer premium from real pre-corruption trading (e.g. `8mep` 153,731.25 vs 150,000 deposited).
> ```
> vault                                          vault_usdc(USDC)  WPs  series
> 8mepVcJHnp8bWxW36bnTBzNo2oBqyi7eFwd7RLG5qvY7      153,731.250     1   Call $75000
> ET6u7t2r8Tt3qvfaRYmH8HvqDpR85KMT7jxVcKkZbTkF       85,000.000     1   Put  $85000
> 7GBBKsubDBRU4qZzTWES92V9YHubLKyToyLjdKvd7vvp        6,400.000     1   Call $3200
> HYnyBaQjr8ZVKYfQo5t3dgWwqEaNEjBodsJJEXrfaFf2        4,919.400     1   Call $2400
> 4AUTwwgMzoArSCxft6WXDbbViY12gsMHd3Xcu9rkZfq8        2,004.975     1   Call $100
> 73cXhWK83kdeEnNpnnbpX3Wyg47h52RPiedNz6Q9yziU        1,800.000     1   Call $90
> 9wE8QzAPttjknbF6gct1jrfLneCP49jVxcdyDrbgUvBh        1,800.000     1   Call $90
> HgLEJwExFHYWp2fdRp2wjhcVKjQp7q5fVafRXrQN7ADY        1,800.000     2   Call $90
> HhsYhnSspWLxqXM2rzGsDZYgjvw3ME6t1maCrtzcqxGH        1,800.000     1   Call $90
> 28R4CMDnyiPNh8qCr6HeRWMitUGry33cJbBhN5qaAt1x          807.960     1   Put  $80
> 5SnQ5m3mF3n8UyBxqtWzxWbvdGf4TXkBSRGV9eYJfw9m          700.000     1   Put  $70
> BzKXfkH4jR53ZbyxhXQpW2n2ge8PNXbqVSjXAy3ydzfo          700.000     1   Put  $70
> 9SV3fN1YPbcwxzCtceW2Bb13iRZTLMyu5JXRyiRzAuqA          400.000     1   Call $200
> ECbN1dX8ASyTQZNsQvsjNYeAfZF8t3hGsGCkuiVCvvcb            0.000     0   Put  $60  (empty husk)
> TOTAL                                             261,863.585    14
> ```
>
> **Recovery path (future, OUT of R+M+C scope — NOT built, NOT proposed).** A standalone admin workstream: either (a) a raw-write admin instruction repairing the `is_settled` byte to a valid value, then normal settle/withdraw drains each vault to its writer(s); or (b) a force-close admin instruction returning `vault_usdc` to the WriterPosition owner(s) and closing the vault. Both need new Rust + an audit; neither is part of the redeploy/migration/crank window. Flagged so the 261.9k + 14 claims aren't silently abandoned.
>
> **Status.** Devnet test USDC, no real-money value — NOT an emergency; a logged cleanup/recovery item. The healthy-vault migration proceeds without it.

> **Phase 3 settle_vault DERIVED-POT RETRO-HARDEN SHIPPED (2026-06-30, dark — applied, gated green + audited, COMMITTED this session). Closes the omit-the-pot griefing surface flagged across the D2.5 + D3 entries — `settle_vault`'s writer-ask pot is now UN-OMITTABLE + UN-SUBSTITUTABLE, mirroring `initialize_void`'s derived-pot pin. The settle-side of the three pre-flip on-chain gates is now CLOSED.**
> - **Handler (`settle_vault.rs:99-145`):** derive `canonical_mint` from vault identity (`[VAULT_OPTION_MINT_SEED, market, strike, expiry, option_type, exercise_style]`), `require_keys_eq!` the passed `option_mint` / `writer_ask_pot` / `writer_ask_pot_usdc` to the vault-derived addresses, THEN branch on `writer_ask_pot.data_is_empty()`. Non-empty also pins `pot.vault == vault.key()` + `pot.usdc_account == writer_ask_pot_usdc.key()` — byte-identical mechanism to `initialize_void` (D3).
> - **Context:** the pot accounts moved from trailing OPTIONALS → REQUIRED (`UncheckedAccount`). No-pot/EUR/pool-only passes the derived-empty pot → `data_is_empty()` ⇒ swept=0 ⇒ settlement state byte-identical. NO new error (reuses `InvalidVaultMint` 6029 + `WriterAskSweepAccountsMissing` 6072). NO schema delta.
> - **Test wiring:** new dependency-free `tests/shared/settle-pdas.ts` (programId-param derivations + `settlePotAccountsFor`, used by BOTH the bankrun + validator harnesses) feeds the now-required accounts; 11 settle callsites rewired (6 bankrun via the `settlePotAccounts` helper + the `settleVaultOnly` collapse with a canonical-pin assert; 5 validator via the `settlePotAccountsFor` spread).
> - **Adversarial proof — RUN, not asserted (`tests/bankrun/zzz-settle-griefing-attack.test.ts`, 4 passing):** (a) omit → "Account `writerAskPot` not provided"; (b) substitute another vault's pot → `InvalidVaultMint` (6029, require_keys_eq); (c) empty account at a wrong addr → `InvalidVaultMint` (pin fires BEFORE `data_is_empty`); (d) honest derived-empty no-pot → settles, swept=0, total_shares unchanged. The funded pot cannot be omitted/substituted/bypassed to strand collateral.
> - Audit `.context/audits/phase3-settle-retroharden-2026-06-30.md` (local): **0 CRIT/H/M**, parity-with-`initialize_void` table, no-pot byte-identity, settle/void mutual-exclusion preserved. Gates: bankrun **170/2/0** + 4 griefing, host-unit **84**, builds feature-free + testing clean, validator **36/61/30** (known harness class, zero settle/pot failures — no regression).
> - **PRE-FLIP GATES NOW (updated):** settle-grief CLOSED. Remaining = (1) R3 cutover, (2) the 276-migration, (3) **crank rewiring** — the settle crank (`app/src/utils/pythPullPost.ts:976`) must now pass the derived 6 accounts, and the reclaim crank the 2-phase `initialize_void` flow. `WRITER_ASKS_ENABLED` stays false; no deploy.

> **Phase 3 Slice D3 SHIPPED (2026-06-30, dark — applied, gated green + audited, NOT yet committed). Void-path writer-ask reconciliation — the LAST writer-ask slice. The arc A→D3 is now complete.** Replicates the D2a settle-merge on the dead-feed void path so both buckets are made whole exactly, with E socialized by share (no origin attribution — E_wa is structurally unknowable + unnecessary under the merge):
> - **NEW `initialize_void` — the SOLE atomic voided-setter** (relocated from `reclaim_unsettled.rs:107`; grep-confirmed one writer). After grace + no SettlementRecord, derives the canonical pot from vault identity (un-omittable; sound via D2.5's canonical pin), sweeps the counter pot_usdc→vault_usdc (donation→treasury, closes pot_usdc), applies the shares-unification merge (total_shares += equiv_total, collateral_remaining = TC + swept − E), flips voided — all atomically. Solana tx atomicity ⇒ `voided == true` ⟺ the full merge committed (no partial-init). No-pot/EUR → byte-identical to the old self-void seed (swept=0). New error VaultNotVoided (6076) + event VaultVoidInitialized.
> - **`reclaim_unsettled` (pool) now `require!(voided)`** — no longer self-voids; the no-record + grace gates moved to initialize_void; pro-rata payout byte-identical (auto-scales). **Context dropped `market` + `settlement_record`.** Late-feed safe: once voided is terminal, reclaim never re-checks → a post-void SettlementRecord can't re-block (settle_vault's !voided guard blocks applying it).
> - **NEW `reclaim_writer_ask_residual` (backer void)** shares the extracted `writer_ask_residual_core(.., enforce_window)` with `withdraw_writer_ask_residual` (settle path). Void wrapper: gate `voided`, window OFF. **The extraction is PURE — the D2a residual suite passes UNCHANGED with the exact numbers (CR₀=1070/equivs 40/30/Σ=CR₀/T→0).**
> - **Close extended:** `total_shares==0 && (voided || (is_settled && swept>0))` (scope-check first preserves the D2a revert order) — the void arm drops swept>0, also fixing the pre-existing pool-only/EUR-voided vault_usdc rent-strand.
> - **No schema delta** (reuses writer_ask_collateral_swept + writer_ask_equiv_shares; INIT_SPACE 268). Audit `.context/audits/phase3-sliceD3-...md`: 0 CRIT/H/M/L (conservation under interleaving, the 4-part sole-voider proof, no-pot byte-identity, pure-writer-ask, close exactness, AND the constructed late-feed cross-handler sequence in retrofitted reclaim tests 12/13). Gates: bankrun **170/2/0** (+6 writer-ask-void), Pass-D suite retrofitted 10/10, host 84, validator 36/61/30.
> - **PRE-FLIP WIRING (crank, blocking before redeploy):** the `reclaim_unsettled` crank call must (a) drop `market` + `settlement_record`, and (b) call `initialize_void` first (the new 2-phase void flow). Same class as the Slice C sweep-crank wiring.
> - **PRE-FLIP BLOCKER (unchanged, re-affirmed):** `settle_vault` (D1) still has the omit-the-pot griefing surface (permissionless settle omitting the pot strands it). D3's `initialize_void` is un-griefable via the derived-pot pin; `settle_vault` must be retro-hardened the SAME way before the flip. The three pre-flip gates are now: R3 cutover + the 276-migration + the settle_vault retro-harden.

> **Phase 3 Slice D2.5 SHIPPED (2026-06-30, dark — applied, gated green + audited, NOT yet committed). Canonical-mint pin for writer-asks — a pre-flip CORRECTNESS fix that also unblocks D3.** A D3 sub-recon found `post_order`'s WriterAsk arm pinned `option_mint` to the vault (via `vault_mint_record`) but NOT to the canonical series mint — so a WriterAsk could rest on a per-writer `mint_from_vault` mint (seeds `[…, vault, writer, created_at]`, not vault-derivable), whose pot D3's `initialize_void` could never derive → stranded collateral on void. D2.5 closes it:
> - **`post_order` WriterAsk arm + `fill_writer_ask` (mirror):** `require!(vault_mint_record.writer == Pubkey::default(), CanonicalMintRequired)` (6075). The `writer` sentinel is exact + total (grep: only `create_series` writes `default`, `mint_from_vault` writes the minter). Composed with the pre-existing `.vault == shared_vault` + spec-only canonical-mint derivation, a posted WriterAsk is provably on THE canonical mint for the vault's exact spec — the one D3 derives. Bid/ResaleAsk byte-identical (sibling arms untouched). Dark (6054 before the pin feature-free). No schema delta.
> - **D5 now ENFORCED for writer-asks** (was an unenforced assumption the A/B/C/D1/D2a tests exploited by posting on per-writer mints). Pool collateral may still rest on per-writer mints (the legitimate write-flow output) — orthogonal; the pin touches writer-asks only.
> - **Test retrofit (6 files):** `writer-ask-{post,fill,cancel,settle,residual}` + the D2b `withdraw-from-vault-gate-correctness` tripwire now post writer-asks on `create_series` canonical mints (shared `createSeries` helper in `helpers.ts`). Behavior-preserving — only the mint changes; the D2a residual conservation now asserts the EXACT unchanged numbers (CR₀=1070, swept=70, pool 1000, equivs 40/30, Σ=CR₀, total_shares→0). The fill-mirror synthetic was DROPPED (unreachable via the public API — post is the sole canonical-pinning order-creator; brittle setAccount fabrication would test the harness, not the system; the require! + audit carry it).
> - Audit `.context/audits/phase3-sliceD2.5-...md`: 0 CRIT/H/M/L. Gates: bankrun **164/2/0** (+2 new `writer-ask-canonical-pin`), host-unit 84 (INIT_SPACE 268), feature-free + testing builds clean.
> - **BLOCKING PRE-FLIP TASK (logged here, for D3 or a separate hardening):** `settle_vault` (D1) has the IDENTICAL omit-the-pot griefing surface — a permissionless settle that omits the pot strands it (`is_settled` once-only). It MUST be retro-hardened with the same derived-pot pin as D3's `initialize_void` before the gate flip. D2.5's canonical pin is the precondition that makes that derived-pot approach sound (one canonical pot per vault). Not built in D2.5/D3 yet — a hard pre-flip gate.

> **Phase 3 Slice D2a SHIPPED (2026-06-30, dark — applied, gated green + audited, NOT committed/deployed). Post-settlement writer-ask residual + shares-unification + the close path.** Three new instructions + a 7th SharedVault schema field (`writer_ask_equiv_shares: u64`, INIT_SPACE 260→268, on-disk 268→276):
> - **`settle_vault` shares-unification (the D2a bump):** at settle, `total_shares += writer_ask_equiv_shares` where `equiv_total = swept × total_shares / total_collateral` (or `= swept` when `total_collateral == 0`, the pure writer-ask vault). Both pool-writers and writer-ask-backers then claim the post-holder residual against ONE jointly-decremented `(collateral_remaining, total_shares)` — conservation reduces to the existing single-bucket telescoping proof. No-pot path byte-identical (equiv_shares 0 → total_shares unchanged).
> - **`withdraw_writer_ask_residual` (PURE):** a backer claims `payout = equiv_shares × collateral_remaining / total_shares` where `equiv_shares = committed × writer_ask_equiv_shares / swept`; decrements the shared denominator, zeroes the position (no close). PERMISSIONLESS, payout PINNED to `position.backer`. Enforces the holders-first `EXERCISE_WINDOW` (writer-ask-minted holders may still exercise — the CRIT-1 mirror). UNGATED (exit/refund path). `total_collateral` is NOT touched (the swept collateral was never in it).
> - **`close_settled_writer_ask_vault` (Opt-1):** reclaims a fully-drained vault's USDC. **EXACT, unspoofable precondition `is_settled && !voided && writer_ask_collateral_swept > 0 && total_shares == 0`** — while ANY claimant is owed their weight is still in `total_shares`, so it is impossible to close a vault that still owes a claimant. Dust + rent → **treasury** (no cranker payout). PERMISSIONLESS, UNGATED.
> - **(a) DEPLOY — run ONLY the consolidated 276-migration.** `migrate_shared_vault_residual_shares` grows a vault at ANY prior size (260 pre-D1 or 268 post-D1) straight to 276, zero-filling all trailing bytes → it **SUPERSEDES the D1 `migrate_shared_vault_writer_ask_swept` (268) migration**. The deploy runbook calls the 276-migration only; the D1 instruction stays compiled for any already-run callers.
> - **(b) Opt-1 SAFE UNDER-CLOSE GAP (known, logged).** A mixed pool+writer-ask vault whose pool ratio drifted via a truncated partial withdrawal can land at `total_shares == D > 0` floor-dust after every position drains → the close NEVER fires (vault USDC stays open, ≈ rent + ≤ D micro-USDC stranded, **NO claimant harmed**). This is a safe under-close (refuses to act), the opposite of a dangerous over-close, and is reclaimable later by a future admin force-close. In the common 1:1 pool case `D == 0` (equiv_total == swept) and the close fires — proven in bankrun.
> - **Ungated/inert feature-free:** residual + close don't reference the dark flags; in a feature-free build no pot is funded (`fill_writer_ask` reverts 6054) so every settled vault has `swept == 0` and both revert harmlessly (`NothingToClaim` / `NotAWriterAskVault`) — present but unreachable. **Gate stays false until D3 + the flip.** New errors 6073 `NotAWriterAskVault` / 6074 `VaultNotFullyDrained`. Gates: bankrun 162/2/0 (+5), host-unit 84 (INIT_SPACE 268 lock). Audit: `.context/audits/phase3-sliceD2a-...md`.

> **Phase 3 Slice D2b DROPPED (2026-06-30):** the BREAK-2 free-collateral "fold" is a no-op — every writer-ask contract is backed by the same cpt as a pool contract, so `WriterAskPot.total_collateral ≡ cpt × WriterAskPot.total_contracts`, the fold cancels (`folded ≡ OLD`), and `OLD` is already the correct merged-solvency bound (the pot's D1 settle-sweep reimburses the per-exercise freeing). **No change to `withdraw_from_vault`** (comment-only). Tripwire test `withdraw-from-vault-gate-correctness` proves it on real on-chain state + fails loudly if cpt-uniformity ever breaks. **The BREAK-2 residual concern — a pre-void LP withdrawal against an unswept pot (the pool fronts un-reimbursed writer-ask early-exercises) — moves to D3's `reclaim_unsettled` reconciliation scope.** Remaining Phase-3 work: **D2a SHIPPED (2026-06-30, dark — see the D2a entry above)**; D3 (void-path pot-reclaim + the BREAK-2 void reconciliation) is the last slice before the gate flip.

> **2026-06-29 (SESSION CLOSE — write-flow + supply-side arcs) — three arcs shipped (atomic write, tenor/ladder, ladder generator); Trade-v2 flip ABORTED (broken on localhost); priority pivots to the SPARTAN meeting (Wed).**
>
> **(A) SHIPPED (live on master+main):** (1) Atomic write bundle — useWriteSubmit.ts collapsed 3 approvals → 1 (create_and_deposit + mint_from_vault, one legacy tx); proven on-chain tx 4Q8pm2J8…, 433,655 CU. (2) Tenor/ladder write flow — new utils/tenors.ts (wk/mo/qtr date math + snapLadder reserve-1-then-floor + same-Friday collision merge); single tenor or %-split across tenors → N sequential atomic cells, per-cell BS premium on each tenor's TTE, retry scoped to failed cells; pure FE. (3) Admin ladder generator — crank/ladderGenerator.ts (cc5931b), one-shot CLI seeding ask-only vault-pegged inventory ([create_series, create_and_deposit], mint-on-fill, spread_bps=0); DRY-RUN default, LIVE dual-gated; idempotent scan + policy-B proven live.
>
> **(B) GENERATOR DRY-RUN VERIFIED (local), NOT RUN LIVE.** 161 cells (168 gross − 7 policy-B user-vault skips), 4 Fridays (Jul-3/Jul-10/Jul-31/Sep-25, no collisions), $3.39M USDC + 3.23 SOL, coverage OK. Admin keypair 5YRMuuoY is LOCAL ONLY (/home/nanko/.config/solana/id.json) — NOT on VPS by design; generator runs locally.
>
> **(C) NEXT CHECKPOINT — SOL canary (Nanko's run):** --asset SOL --side call --live (~25 cells / ~$1,750 / ~0.5 SOL), then fill one seeded cell to prove seed→ask→mint-on-fill. Only after a clean fill → widen SOL→ETH→BTC. First real-capital op.
>
> **(D) TRADE-V2 FLIP — ABORTED.** v2 tested on localhost → broken → flip cancelled, TRADE_V2_UI stays false, nothing committed. Do NOT flip until v2 fixed AND CSP proven on a Vercel preview branch (localhost can't prove the Vercel-applied CSP header).
>
> **(E) PRIORITY — SPARTAN MEETING WED.** Clay (Colosseum) intro'd Nanko to Eric (venture @ The Spartan Group, top-tier crypto VC). Next 2 days = prep. VC framing not hackathon: 2-min narrative (why options on Solana, why now, why permissionless, defensibility); working demo (atomic write live + Solscan + ladder UI); hard questions + answers; what Nanko wants from Spartan. Traction: Anatoly QRT, Colosseum Frontier, Foundation outreach.
>
> **(F) WEEKEND TWITTER (Sun night).** Off the live atomic-write + ladder work (not broken v2). Ladder screenshot + term-structure/liquidity narrative; self-reply on writer yield; QRT'd from personal.
>
> **(G) STILL OPEN (non-blocking):** live ladder smoke; SOL canary + fill; Namecheap DNS → SB-create; set_spread_bps Rust IF LP markup wanted later.

> **2026-06-28 (Write-page arc — post-handoff, via live smoke) — SHIPPED. Two Write-page fixes surfaced by live testing after the session-close handoff below. master+main at `6ce7b48`.**
>
> - **2c-FE — `6904aaf`** (`feat(write): indicative premium + stale/warmup oracle advisory`). When the American on-chain quote reverts on a stale/warming vol oracle, the Write panel shows the European client-side estimate labeled "indicative — not the on-chain price" (if a Hermes spot resolves) + a prominent tailored advisory (distinguishes `oracle-stale` 6045 vs `oracle-warmup` 6044) instead of blank dashes. Write button gating unchanged (the program is the real gate).
> - **Write spot-decouple — `6ce7b48`** (`fix(write): decouple American on-chain quote from Hermes display spot`). **Root cause of an intermittent blank-panel-on-FRESH-oracle:** `LiveQuoteCard`'s `ready` gate required a Hermes **display** spot for the WHOLE panel, and the American `get_option_price` `.view()` was gated on it — so a transient Hermes spot-fetch miss suppressed a compute-layer on-chain quote that **doesn't depend on the Hermes spot at all** (it carries the oracle's own spot). Fix: split into **`baseReady`** (asset/strike/expiry → gates the American quote) and **`ready`** (`+spot` → gates only the European client-side estimate). The SPOT row falls back to `amerQuote.spotUsed` (marked "· oracle") when the Hermes spot is null, degrading independently without blanking IV/premium/total/breakeven. 2c-FE advisory moved to `baseReady` (shows whenever the quote ran); the indicative European figure stays spot-gated.
> - **Proven working:** a **SOL American write landed end-to-end** this session (tx `53yC77Qi…`) — the write path is sound on a fresh oracle; the bug was display-only.
> - **Spot-decouple CONFIRMED LIVE (`6ce7b48`):** a SOL American write now renders the real **on-chain IV 72.7%, SPOT $70.61 "· oracle", premium $2.60**; **multiple SOL writes landed (3/3 tenors)**. The intermittent blank-panel-on-fresh-oracle bug is **resolved**.
> - **NEW BACKLOG (UX polish, low priority — not a bug):** show the asset spot price **immediately on asset-click**, before a strike is entered. Today the panel stays blank until `strike > 0` (the `baseReady` gate requires strike). Pre-fetching/displaying spot on select would feel more responsive. A nicety, not a defect.
> - **CONFIRMED PATTERN (not gold-specific):** ANY TradFi asset without a live 24/7 source (gold, oil/`USOILSPOT`, etc.) fails writes off-hours with **"VOL ORACLE STALE"** until its oracle is fed. This **broadens** the pending `reset_vol_oracle` work — it's a general off-hours-oracle-freshness operation, not just a gold one.
> - **STILL PENDING (NEXT session, operational, no new code): 2c-vol-freshness** — admin `reset_vol_oracle` to seed the **SB gold oracle (`6c3c5cc7`)** with the **commodity seed `550000000000`** so weekend gold writes land on an SB-sourced market. The two-gold-oracle finding (Pyth `765d2ba9` warm/weekend-stale vs SB `6c3c5cc7` fresh-24/7/unseeded) is documented in the session-close entry below (§B); this is the operational follow-through (now known to apply to all off-hours TradFi, per the confirmed pattern above).

> **2026-06-28 (unified asset registry — Phases 1+2 + fixes) — SHIPPED across 6 commits, master+main at `6904aaf`. The create flow is source-aware (Pyth/SB peers, liveness-routed); the broad TradFi asset list is live; the Write page is honest about stale oracles. One operational follow-up (`reset_vol_oracle` seed) gates weekend gold writes. Read the two-gold-oracle finding (§B) before touching vol.**
>
> **(A) CLOSED + COMMITTED THIS SESSION (6 commits).**
>   1. **Stale-tx fix — `62f228e`** (`fix(markets): auto-refetch on stale SB create…`). `isStaleSubmitError` broadened to the **`custom program error: 0x3` / "failed to simulate"** stale fingerprint (an opaque InstructionError on the ed25519/verify path when the SB quote/blockhash expires; NEVER a genuine Opta error — Opta enum is 6000+). Also consulted at the `signTransaction` catch (after the user-rejection check) for Phantom's hard-refusal. The opaque **"Program error 3" is eliminated** — a slow wallet-approve now auto-refetches a fresh tx once and re-signs; a 2nd stale → "Transaction expired — please try again promptly." **SB-arm only** (the fn is referenced only in the SB flow); Pyth path untouched.
>   2. **Registry Phase 1 — `26f8143`** (`feat(registry): unified source-aware asset registry…`). `app/src/utils/assetRegistry.ts`: a **runtime merge** of the live Pyth/Hermes catalog (broad base) + the curated `sbFeedData` (SB hashes), **one routed row per asset** carrying BOTH feed ids + `canonicalSource`. **Conservative join** (same-class + exact-ticker + UNIQUE match; ambiguity/zero → no SB attach → Pyth-only — a false link is unacceptable, a miss is fine). Crank-side **±2% price cross-check** (`crank/registryCrossCheck.ts`, Crossbar `simulateJobs` vs Hermes) **validated LIVE at 0.223% on gold**. Closes the empty-TradFi-asset-list gap. **Proven:** `EURUSD` created on-chain from the browser (PDA `aZG2Z4Jg…`, `oracle_source=0`, `asset_class=3` forex, tx `r2CkxApA…`, CU 25,853).
>   3. **Phase 2a — `b2aa46c`** + scoping **`31a0dc0`**. Crank **liveness loop** (`crank/livenessCrank.ts` + `livenessStore.ts`) + **`GET /liveness`** route on the existing sb-create endpoint (CORS + crash-isolation reused, 10s cache). Feed-id-keyed map `{updatedAt, feeds:{<feedIdHex>:{source,live,asOf,samples}}}`; batched Pyth probe (60s, live=`now-publish_time≤120s`, recursive-split on Hermes-404) + per-feed SB `simulateJobs` (180s) with bounded retries. **Hysteresis: live→dead after K=3 consecutive misses, dead→live on 1 hit** (a transient miss never flips). Gated on `OPTA_SB_CREATE_ENABLED` (+ `OPTA_LIVENESS_DISABLED` kill-switch). **Scoped** the probe set from the full **2199-feed catalog (~44 Hermes calls/min, 62% no-data) → curated marquee (~30 tickers) + existing-market feeds + SB ≈ 73 feeds, ~2 calls/min** (`OPTA_LIVENESS_PROBE_ALL=1` reverts to full). **Live on the VPS crank.**
>   4. **Phase 2b — `9d7d0aa`** (`feat(markets): liveness-driven advisory peer routing`). `app/src/utils/liveness.ts` (`getLiveness` cached fetch + `resolveSource`). FE reads `/liveness` and routes create-time source as **peers**: dual-source → the LIVE source (gold → **SB** on weekends, Pyth-XAU stale); both live → `canonicalSource` tie-break; single-source TradFi stays **creatable** + a "pricing resumes at market open" hint; untracked/crypto → Pyth, no hint; **map stale/missing → silent fall back to the Phase-1 static default**. **No Phase-1-creatable asset becomes un-creatable** (verified: `resolveSource` never returns "blocked"); stale-tx auto-refetch + Pyth path intact; FE stays SB-SDK-free.
>   5. **Phase 2c-FE — `6904aaf`** (`feat(write): indicative premium + stale/warmup oracle advisory…`). When the Write page's American on-chain quote reverts on a **stale/warming** vol oracle, it shows the **European client-side estimate labeled "indicative — not the on-chain price"** (when a Hermes spot resolves) + a **prominent tailored advisory** (distinguishes `oracle-stale` 6045 vs `oracle-warmup` 6044), instead of blank dashes. SB-sourced feeds (Hermes 404, no spot) keep the dash + warning. **Write button gating unchanged** (the program is the real gate — advisory, not blocking); fresh-oracle/European/crypto paths untouched. **NOTE: this makes the page honest; it does NOT make the write land — that's (C) below.**
>
> **(B) THE TWO-GOLD-ORACLE FINDING (critical — read before touching vol).** Gold has **TWO vol oracles, keyed by `feed_id`** (PDA = `[b"vol_oracle", feed_id]`):
>   - **Pyth gold (`765d2ba9…`):** `oracle_source=0`, **WARM** (296 samples) but **weekend-STALE** (last sample 54h old — Pyth-XAU stops publishing at Friday's close). A write reading it → `price_american` staleness gate (`now - last_sample_ts > 6h`) → **`VolOracleStale`**.
>   - **SB gold (`6c3c5cc7…`):** `oracle_source=1`, **FRESH 24/7** (0.2h — the SB oracle crank pushes from PAXG every cycle) but **NOT warm** (53 < 168) **and unseeded** (`seed_vol=0` — born ~2.2d ago, BEFORE the 2026-06-27 seed-at-birth deploy). A write reading it → **`VolOracleWarmup`**.
>   **The decisive structural fact:** the vol oracle is **feed-id-keyed**, and an SB quote's feed_id is the SB hash — so **you CANNOT push SB samples to the Pyth-keyed oracle**. A **Pyth-sourced gold market is inherently weekend-stale** and cannot be salvaged. The freshness engine already EXISTS and WORKS (SB crank → SB oracle, confirmed 0.2h fresh) — it just feeds the SB-keyed oracle. **Fix path = write on SB-sourced gold markets (Phase-2 create routing already routes gold→SB) + SEED the SB oracle** so it prices while warming. The on-chain staleness gate is `programs/opta/src/utils/american_pricing/quote.rs:93-96` (fires BEFORE the warm/seed branch; called by `mint_from_vault` American + `get_option_price`).
>
> **(C) OPEN FOLLOW-UPS.**
>   - **Phase 2c-vol-freshness (operational, NEXT — no new code):** admin **`reset_vol_oracle`** (instruction already exists) to seed the SB gold oracle (`6c3c5cc7`) with the **commodity seed `550000000000`** so it prices immediately while the ring warms; then rely on Phase-2 gold→SB routing so writes read the FRESH SB oracle off-hours. Confirms weekend gold writes land end-to-end. (`synth_warm_vol_oracle` also exists as an alternative; new SB births post-seed-deploy already carry seed_vol.)
>   - **Phase 3 (optional, deferred):** on-chain `AssetRegistry` account + admin `register_asset` — only if trustless/composable on-chain lookup is wanted. The create UX works without it (the proof is the gate); the registry today is an off-chain runtime merge.
>   - **Phase 4 (deferred):** feed expansion (EUR/silver/oil via `crossbar.store` + the cross-check gate); **equity market-hours + the vol-floor**. CRITICAL: **equities have NO 24/7 proxy** (unlike gold↔PAXG) → they stay weekend-stale AND flat-tape → need BOTH a weekend source AND a per-class vol floor (`max(realized, floor)`). **The 2c gold fix does NOT generalize to equities.**
>   - **Minor:** the curated oil/natgas tickers (`BRENT/WTI/NATGAS/UKOIL/USOIL`) **don't resolve** in the Pyth catalog (logged `curatedSkipped`) — refine the ticker strings if oil markets are wanted. Metals/FX/equities/ETFs all resolved.
>   - SB create stale-tx is now auto-refetch-handled (A.1).
>
> **(D) LOCKED ARCHITECTURE DECISIONS (do not re-litigate without a scope reference).**
>   - **Off-chain liveness** (NOT on-chain) — liveness is real-time + costly on-chain, and `create_market`'s proof is the real create-time enforcement, so on-chain liveness is redundant. The crank publishes; the FE reads.
>   - **Peer-source routing (decision "a")** — Pyth and SB are **peers**, not canonical-vs-fallback. `canonicalSource` is the **both-live tie-break only** (per-class: TradFi→SB), not a preference. The shape carries both ids so this re-resolves without a structural change.
>   - **Liveness is ADVISORY for create, not blocking** — create only needs feed existence (proof-enforced); TradFi is legitimately closed most hours. Liveness drives routing + hints, never disables create/write.
>   - **Broad-seed registry = runtime merge, not a static file** — the Pyth base is the live Hermes catalog (hundreds of feeds), so a static curated list would lose breadth + go stale.
>
> **(E) STAGING HYGIENE.** Six source commits this session (`62f228e` → `26f8143` → `b2aa46c` → `31a0dc0` → `9d7d0aa` → `6904aaf`), each staged with ONLY its named files; this HANDOFF doc-commit rides on top. The 3 **parked locals (`App.tsx`, `constants.ts`, `vercel.json`) remain unstaged + untouched** across the entire session.

> **2026-06-28 (admin ladder generator) — SHIPPED (script committed, NOT yet run). A standalone crank CLI seeds a Deribit-style chain as vault-pegged ASK-ONLY inventory (the supply side; complements the write/ladder demand side). Zero Rust, zero deploy, zero IDL/FE change. master+main at `cc5931b`. Remaining = Nanko runs the dry-run, then a scoped live canary before a full roll.**
>
> **(1) WHAT LANDED (commit `cc5931b`, 1 new file `crank/ladderGenerator.ts`, +338).** A one-shot CLI (modeled on `smoke-create-sb-market.ts`) that pre-seeds asks: per asset×strike×tenor×side, a `[create_series, create_and_deposit]` cell — **mint-on-fill** (no tokens at seed; the first `fill_vault_peg` mints to the buyer), **`spread_bps=0`** (see gating finding below → model-fair BS-2002 ask, no LP markup). BTC/ETH/SOL only (warm oracles); ATM±3 on the per-asset round grid (BTC $5k / ETH $250 / SOL $10) centered on `VolOracle.last_spot_price`; 4 tenors `[weekly, weekly+7d, monthly, quarterly]` deduped by Friday; both sides; 1 contract/cell (collateral = strike). Imports the pure `@app/utils/tenors` + `toUsdcBN`; derives all PDAs inline.
>
> **(2) GATING FINDING — `spread_bps` is unsettable on-chain.** It's declared on `SharedVault`, read in `fill_vault_peg`, and only ever **zero-filled** by the migration — there is **no setter and no creation param** (verified across all 42 instructions). So every seeded ask prices at the pure BS-2002 quote (`apply_spread(base,0)=identity`). A non-zero LP spread would need NEW Rust (an additive admin `set_spread_bps`, or a `spread_bps` param on `create_and_deposit`) — explicitly OUT of scope for this v1.
>
> **(3) IDEMPOTENCY + POLICY B (the safety core).** One `getProgramAccounts` per type builds a Set of series-record PDAs (`VaultMint` 137 B, writer==default) + a Map of vault PDAs→`created_at` (`SharedVault` 260 B). Per cell, independent `hasRecord`/`hasVault` checks emit **only the missing instruction(s)** — never blind re-create (the deposit is additive). **Discriminators are HARDCODED + verified live** (`VaultMint [219,139,…]`, `SharedVault [195,36,…]` == on-chain bytes AND the IDL) — a wrong discriminator would silently empty the scan and double-deposit, so they're pinned, not derived from the processed `program.idl` (which drops them). **Policy B (`SEED_EXISTING_VAULTS=false`, locked by Nanko):** a vault PRESENT + record MISSING = a user vault the generator didn't seed → **SKIP** (never activate a peg on someone's collateral). Orphan-heal (vault MISSING + record PRESENT, e.g. `2P8Annr4`) gates on the OPPOSITE `hasVault` → emits `create_and_deposit` only, unaffected by policy B.
>
> **(4) SAFETY RAILS.** DRY-RUN is the DEFAULT (computes + prints the plan, sends nothing). LIVE requires BOTH `--live` AND `OPTA_GENERATOR_LIVE=1`; refuses to start if signer SOL/USDC < the plan's requirement; 5-second abort banner; per-cell failure → decoded + recorded + **continue** (one failing strands nothing — atomic); stale-retry **re-checks the chain before resending** (never double-sends a landed cell). Oracle pre-flight excludes any cold/stale asset (seeding it makes unfillable vaults). `--asset`/`--side` filters let Nanko stage incrementally. Signer = admin `5YRMuuoY` (holds SOL+USDC; permissionless instructions, no authority needed); keypair from `OPTA_GENERATOR_KEYPAIR` (never printed); RPC from `~/.opta-rpc-helius` (redacted).
>
> **(5) VERIFIED (script committed, not yet run live).** `cd crank && npm run typecheck` → exit 0. ts-node boot proven: `@app` resolves, IDL loads, live plan builds, **inventory scan works** (a SOL-call dry-run detected 3 pre-existing user vaults and policy-B-skipped them — live proof the discriminators + policy B fire; a wrong discriminator would've shown 0 skipped / all CREATE). Full-roll dry-run (this chain, 2026-06-28): **168 cells, 0 collisions (Jul 3 / Jul 10 / Jul 31 / Sep 25 distinct), 168 create_series + 164 create_and_deposit, ~3.35 SOL rent + ~$3.39M USDC** (BTC = 97%), admin covers both. (Costs scale: `--asset SOL --side call` ≈ 25 cells / $1,750 / 0.50 SOL — the natural canary.)
>
> **(6) THE MANUAL STEPS REMAINING (Nanko, after this commit).** The script NEVER auto-runs. Sequence: (a) **dry-run** `OPTA_GENERATOR_KEYPAIR=… ts-node … ladderGenerator.ts` (review the plan + totals); (b) **scoped live canary** `--asset SOL --side call --live` with `OPTA_GENERATOR_LIVE=1` (~$1,750, smallest blast radius) — confirm cells seed + a test `fill_vault_peg` mints against one; (c) only then a **full roll**. It's a standalone CLI, **not** a 5th crank loop (per the locked admin-script decision) — `bot.ts` untouched.
>
> **(7) STAGING HYGIENE.** One source commit (`cc5931b`, parent `5091f12` — local master had advanced beyond the prior arc's `20688a5`, likely another agent; my commit landed cleanly on top), staged with ONLY `crank/ladderGenerator.ts`; this HANDOFF doc-commit rides on top. Parked locals (`App.tsx`, `constants.ts`, `vercel.json`, `pages/seeker/*`) remain unstaged + untouched.

> **2026-06-28 (tenor selector + ladder write flow) — SHIPPED. Writers can now pick Weekly / Monthly / Quarterly, or ladder collateral across tenors — built on top of the atomic write bundle. Pure FE, no Rust, no deploy. master+main at `ab0850d`. One manual smoke remains (a 2-3 tenor ladder write).**
>
> **(1) WHAT LANDED (commit `ab0850d`, 6 files, +763/−339).** Recon proved tenor is a pure FE label: weekly/monthly/quarterly all resolve to a **Friday 08:00 UTC** expiry, which `is_valid_epoch_expiry` accepts under the live `epoch_config` (`HdqbiUK6…`: Fri/08:00/monthly_enabled/min 1d) — **zero on-chain change** (`monthly_enabled` is inert; the validator only checks weekday+hour+minute+second). New `app/src/utils/tenors.ts` computes `weeklyExpiry` / `monthlyExpiry` (last Friday of month, roll-forward) / `quarterlyExpiry` (last Friday of Mar/Jun/Sep/Dec, roll-forward) + `snapLadder`. The Epoch section gains a **tenor selector** (single) and a **ladder toggle** (% per tenor); Custom is unchanged (arbitrary expiry).
>
> **(2) LADDER = N SEQUENTIAL ATOMIC CELLS.** Two cells don't fit one tx (**size-bound** ~1313 B > 1232; CU would fit at 870K) → ladder fans out into **N sequential atomic writes, one wallet approval each**, every cell the proven `[CU600K, create_and_deposit, mint_from_vault]` bundle (instruction assembly byte-identical — preserved verbatim in `useWriteSubmit.sendCell`). `submit()` loops cells; a cell failure is **recorded, not aborted** (atomic → strands nothing, just fewer tenors). **Return shape `WriteSubmitResult` → `CellResult[]`.**
>
> **(3) THE PURE LOGIC (verified by running it before applying).** `snapLadder`: (a) merge tenors landing on the **same Friday** into one cell (sum %), (b) **reserve 1 contract per unique expiry** (min-usable: `N ≥ #expiries` else validation error), (c) floor the remaining `N−G` by %, leftover units → largest-% group, (d) collateral = strike × contracts. Verified outputs: 50/30/20 N=10 → 5/3/2; N=7 → 4/2/1 (Q reserved); collision (W+M same Fri) → merged 8 + Q 2; date roll-forwards correct (e.g. now past Sep last-Friday → quarterly Dec 25).
>
> **(4) PER-CELL PREMIUM (the one mid-build correction).** Premium is computed **per cell keyed on that cell's `expiryTs`** (not once) — a flat front-tenor premium underprices longer European tenors. Override (Advanced) → flat across all cells; BS default → recomputed with each cell's `days`-to-expiry (`EpochVaultSection.handleSubmit`'s `writeCells.map`). American is uniform (mint ignores premium, prices on-chain). The hook reads `cell.premiumPerContract` (`sendCell`).
>
> **(5) RETRY IS FAILED-CELLS-ONLY (NOT idempotent on re-run).** The bundle's deposit is **additive** and the mint uses a **fresh `createdAt` nonce**, so re-running a LANDED cell double-deposits + double-mints. The banner's "Retry N failed" re-runs **only the failed cells** (`retry === submit` with the failed subset). A per-cell wallet rejection is recorded as `error:"Cancelled"` (vs `decodeError`) so the banner reads cleanly; the loop continues to remaining tenors.
>
> **(6) BLAST RADIUS + BUILD.** 6 files: `tenors.ts` (new), `useWriteSubmit.ts` (loop/array/retry/per-cell premium), `WriterForm.tsx` (+2 optional props: `epochExpirySlot`, `ladderBlock`), `EpochVaultSection.tsx` (tenor/ladder UI + preview), `CustomVaultSection.tsx` (1-cell array), `WritePage.tsx` (N-row banner + scoped retry; removed dead `epochExpiryTs`/`epochExpiryLabel`/`nextFridayUtc8`/sync `useEffect`). **`cd app && npm run build` green** (tsc + vite, only the 3 known warnings).
>
> **(7) THE ONE MANUAL STEP REMAINING.** A **live devnet ladder smoke**: connect a wallet, Epoch → Ladder, a 2-3 tenor split on a warm-oracle crypto asset (BTC/ETH/SOL), and confirm **N wallet popups** (one per tenor), **per-cell mints** land (each tenor's vault + position + option tokens), and the **collision-merge** case (pick a week where the next Friday IS the month's last Friday → Weekly+Monthly should merge into one cell/one approval). No on-chain deploy or IDL change in this arc; Vercel auto-deploys on the `main` push.
>
> **(8) STAGING HYGIENE.** One source commit (`ab0850d`), staged with ONLY its 6 named files; this HANDOFF doc-commit rides on top. The parked locals (`App.tsx`, `constants.ts`, `vercel.json`, `pages/seeker/*`) remain unstaged + untouched.

> **2026-06-28 (direct-write atomic bundle) — SHIPPED. The 3-approval writer flow is now ONE user-signed atomic transaction. FE-only, no on-chain change. master+main at `8081a08`. One manual smoke remains (a live devnet wallet write).**
>
> **(1) WHAT LANDED (commit `8081a08`, single file `app/src/pages/write/useWriteSubmit.ts`, +112/−226).** The Write page used to fire THREE separate `.rpc()` calls in sequence — `create_shared_vault` → `deposit_to_vault` → `mint_from_vault` — i.e. **3 wallet approvals** (2 if the vault PDA already existed), with a vault-exists pre-check, a deposit snapshot, per-stage landed-checks, `submitStageWithRecovery`, and 1/3·2/3·3/3 labels. It is now **ONE legacy tx**: `[ ComputeBudget.setComputeUnitLimit(600_000), create_and_deposit, mint_from_vault ]`, sent via one `.rpc()` = **one approval**, fresh-or-existing vault alike. `create_and_deposit` (Pass C, `init_if_needed`) fuses create+deposit and creates-or-reuses the vault in one ix; the atomic send removes the **stranded-collateral** and **double-deposit-on-retry** hazards structurally (the FARTCOIN path).
>
> **(2) WHAT WAS DELETED vs KEPT.** Deleted (all existed only because the flow was multi-tx): `submitStageWithRecovery`, the `vaultExists` pre-check + fetch, `depositSnapshot`, per-stage landed-checks, the staged labels, and the 400K/800K/1.4M CU ladder. **Kept** the single wallet-replay guard (one `isWalletReplay` → `vault_mint_record` landed-check) — `errorDecoder.ts:88` registers `useWriteSubmit` as a consumer of the "already processed → already confirmed" sentinel; this is a single-tx wallet quirk, not multi-tx scaffolding. **Mint behavior is byte-identical** to before: premium sentinel (`isAmerican ? BN(1) : premiumBN`, satisfying `mint_from_vault.rs:57 require!(premium > 0)` while American prices on-chain), `epoch_config` null-for-Custom (IDL marks it OPTIONAL), and the 15-account `mint_from_vault` block — all verified unchanged against the original.
>
> **(3) ZERO BLAST RADIUS.** The exported shapes (`WriteSubmitInput` / `WriteSubmitResult` = `{txSignature, vaultPda, optionMint}` / `UseWriteSubmit` = `{submitting, stageLabel, submit}`) were preserved deliberately, so the four consumers — `WritePage`, `WriterForm`, `EpochVaultSection`, `CustomVaultSection` — needed **no edits**. `stageLabel` is now a single "Writing…". **Build green:** `cd app && npm run build` (`tsc -b && vite build`) clean; only the 3 known pre-existing warnings.
>
> **(4) GROUNDING (the recon that preceded the build).** CU proven by live devnet `simulateTransaction` (sigVerify:false, replaceRecentBlockhash:true, NOT sent): bundle worst case = **435K CU** (ATM PUT, full BS-2002 via `mint_from_vault`), 917 B, 21 accounts — **fits ONE legacy tx** (1232 B / 1.4M CU caps) with no ALT. A CALL takes the cheaper European fast-path (~232K). **No Pyth-post ix rides in the bundle** — `mint_from_vault` prices American off the **crank-warmed VolOracle PDA** (hourly `push_vol_sample` lives in the crank, not the user tx); the only precondition is the existing W1 "oracle seeded" submit gate. **FE IDL needed no sync** — `app/src/idl/opta.json` is already 42-instr and carries `create_and_deposit` + `mint_from_vault` with current sigs (the old HANDOFF "drift" note was superseded).
>
> **(5) THE ONE MANUAL STEP REMAINING.** A **live devnet wallet write** to smoke-confirm: pick a warm-oracle crypto asset (BTC/ETH/SOL), submit a write, verify **exactly ONE wallet popup** and a clean mint (vault + position + option tokens all land in one tx; portfolio shows the written position). Everything else (typecheck, build, CU, account/size budget, byte-identical mint behavior) is already verified. There is NO on-chain deploy and NO IDL change in this arc, so this is a pure FE acceptance smoke — Vercel auto-deploys on the `main` push.
>
> **(6) STAGING HYGIENE.** One source commit (`8081a08`), staged with ONLY `useWriteSubmit.ts`; this HANDOFF doc-commit rides on top. The 3 **parked locals (`App.tsx`, `constants.ts`, `vercel.json`) remain unstaged + untouched**.

> **2026-06-27 (class-first create-market — SB arm) — LANDED but DARK. The class-first create-market UX is built end-to-end and on master+main at `e6708ad`. Crypto create is LIVE (Pyth, unchanged). Switchboard create (commodity/equity/forex/etf) is wired the whole way through — FE → VPS endpoint → user-signs → submit — but INERT until two switches flip. Nothing SB-create is reachable in production yet; do NOT assume users can make SB markets.**
>
> **(1) THE FOUR COMMITS (all master+main, HEAD `e6708ad`).**
>   1. **`2aacc38`** — `refactor(sb)`: extracted pure SB feed data into a shared dependency-free module `app/src/utils/sbFeedData.ts` (mirrors `seedVol.ts`). `crank/sbFeedRegistry.ts` now imports the data + keeps only SDK-bound construction (jobs, real `PublicKey`/queue constants, `buildOracleFeed`) + a fail-loud drift guard asserting the base58 strings still equal the live SDK constants. Gold path byte-identical. This is what lets the FE consume feed data WITHOUT pulling the SB SDK.
>   2. **`49721be`** — `feat(markets)`: class-first modal restructure. User picks **asset class FIRST** → class-scoped search. Crypto → Hermes catalog filtered to class 0 → existing Pyth create (live, untouched). Commodity/equity/forex/etf → `sbFeedData` search → SB arm (stubbed at this commit). Class-change resets selection; Hermes-failure auto-Advanced scoped to crypto only.
>   3. **`a97759d`** — `feat(crank)`: the SB create-market HTTP endpoint (`crank/sbCreateMarketEndpoint.ts`, Node built-in `http`, no framework). Builds the UNSIGNED SB create tx (`[ComputeBudget, ed25519 quote ix, create ix]`) and returns it base64. Mounted in `bot.ts` OUTSIDE `Promise.all(loops)`, **env-gated OFF** (`OPTA_SB_CREATE_ENABLED=1` to start). CORS allowlist (opta-solana.vercel.app + opta.fyi [+www]), per-IP rate limit, 2KB body cap, full input validation (assetName regex, supported-feed, class match, valid pubkey).
>   4. **`e6708ad`** — `feat(markets)`: FE wired to the endpoint. SB arm = POST `${VITE_SB_CREATE_ENDPOINT}/sb-create-market` → deserialize unsigned tx → `anchorWallet.signTransaction` → `sendRawTransaction` + `confirmTransaction({signature, blockhash, lastValidBlockHeight})`. **Retry once ONLY on genuine stale** (blockhash-expiry / quote-stale) by re-POSTing a FRESH tx and re-signing it — never re-submit/re-sign the stale tx; all other errors (network, 4xx/5xx, user-rejection) fail fast. User-rejection → neutral "Signature cancelled" info toast. **No SB SDK in the FE bundle** (+1 kB gzip on the main chunk, verified).
>
> **(2) ARCHITECTURAL DECISIONS LOCKED THIS ARC (do not re-litigate).**
>   - **SB create = server-side builder, user-signs-ALONE** — NOT a browser port of the SB SDK. Recon proved the SB create tx needs only the `create_market` `creator` signature (= the user); the ed25519 quote ix is **oracle-signed**, independent of the fee-payer; there are NO ephemeral signers. So the endpoint returns an unsigned, fully-compiled `VersionedTransaction` and the user's wallet is the sole signature. This avoided porting the heavy SB SDK (+ a 2nd Anchor + protobufjs + axios, est. +250–450 kB gzip) AND the A5 hazard (the `switchboardQuotePost.ts` deep-CJS-require + monkeypatch that doesn't survive browser ESM bundling).
>   - **Endpoint holds NO key** — it builds with `userPublicKey` as creator/payer and never signs; the crank wallet is used only to load the read-only SB program for the quote fetch.
>   - **Crash-isolated** — mounted outside `Promise.all(loops)`; request handler wrapped (any throw → 500 + log); `server.on("error")` swallows listen/socket errors; mount call in try/catch. A create-endpoint failure can NEVER halt settle/vol/trigger/sb or exit the process.
>   - **Stateless + freshness-bound** — every POST builds fresh (fresh quote + fresh blockhash). The response carries only `lastValidBlockHeight`; that is SAFE because blockhash validity (~150 slots / 60–90s) is TIGHTER than the SB create-quote window (300s / 750 slots), so quote-expiry is IMPLIED by blockhash-validity. Documented as an invariant in the endpoint with an explicit "if this inverts, return a quote deadline too" assertion.
>
> **(3) ACTIVATION SEQUENCE (two switches; ordered to avoid a live break).** Nothing SB-create works until BOTH the Vercel env var and the VPS flag are set. Recommended order:
>   1. **nginx** — add a TLS server block for the public SB-create domain (e.g. `sb-create.opta.fyi`) proxying to `127.0.0.1:8787` (the endpoint binds localhost by default — `OPTA_SB_CREATE_HOST`/`PORT` to override). Set `OPTA_SB_CREATE_TRUST_PROXY=1` so per-IP rate limiting reads `X-Forwarded-For`.
>   2. **VPS** — set `OPTA_SB_CREATE_ENABLED=1` in the crank's env/secrets, `systemctl restart opta-crank.service`, confirm the `sb-create endpoint listening` log line. (Endpoint up but not yet reachable by the FE — safe.)
>   3. **Vercel** — set `VITE_SB_CREATE_ENDPOINT=https://sb-create.opta.fyi` (HTTPS base ONLY, no `/sb-create-market` path, no trailing slash), redeploy FE via push-to-main (NOT the vercel CLI — monorepo tree-scan issue).
>   4. **Browser smoke** — class-first modal → Commodity → search "gold"/XAU (the one feed in `sbFeedData`, feedHash `6c3c5cc7…`) → Create → wallet signs → confirm the SB market lands (`oracle_source=1`). This is the live acceptance gate for the FE→endpoint→chain path (the endpoint builder itself is the same machinery proven by the `SBXAU` create smoke).
>   - **Until then it ships safely dark:** unset `VITE_SB_CREATE_ENDPOINT` → the SB arm shows a clean "SB create not configured" toast, no crash; crypto/Pyth create is fully live regardless.
>
> **(4) CARRY-FORWARD DEBT (none blocking; flagged so it surfaces).**
>   - **`ctx.program as any` cast** in `sbCreateMarketEndpoint.ts` (the `buildSwitchboardCreateMarketTx` call) marked **`UN-APPLY ON IDL SYNC`** — matches the seed-vol cast convention; drop it when the crank-loaded app IDL syncs to the 4-arg `create_market` (oracle_source) signature. (The wired `opta.json` ALREADY carries the 4-arg shape; the cast persists because `switchboardCreateMarket.ts` itself casts.)
>   - **Global build-concurrency cap** — a one-line `TODO` in the endpoint header: each request can trigger up to `OPTA_SB_CREATE_BUILD_ATTEMPTS` (default 3) SB gateway fetches, so per-IP rate limiting alone does NOT bound total upstream load. A process-wide semaphore (→ 503 when saturated) is a pre-real-traffic follow-up.
>   - **feed_id uniqueness is name-collision-only** — "one asset = one market" is enforced solely by the market PDA seed `[b"market", asset_name]` + the collision pre-check; two DIFFERENT names pointing at the SAME feed_id are NOT blocked. Acceptable pre-mainnet; revisit (on-chain feed_id-uniqueness or an indexer check) before mainnet.
>
> **(5) WHAT'S STILL DEFERRED (unchanged from the class-first plan).** Equity market-hours gating (commodities ~24/5 dodge it; equities stall off-hours) — not built. SB feed catalog beyond gold — `sbFeedData`/`sbFeedRegistry` hold ONE feed (XAU); every commodity/equity wanted searchable needs its vetted feedHash + jobs added (ongoing data task, not a build). Commodities-first remains the shortest path.
>
> **(6) STAGING HYGIENE.** Four source commits this arc (`2aacc38` → `49721be` → `a97759d` → `e6708ad`), each staged with ONLY its named files; this HANDOFF doc-commit rides on top. The 3 **parked locals (`App.tsx`, `constants.ts`, `vercel.json`) remain unstaged + untouched** across the entire arc — re-apply or commit them separately when ready.

> **2026-06-27 (seed-at-birth) — DEPLOYED + PROVEN LIVE. A brand-new market is tradeable from minute ZERO — the 7-day dead-warmup period is eliminated, proven end-to-end on a real Switchboard QuoteVerifier flow. The whole arc (on-chain Changes 1-3 + initialize_vol_oracle + off-chain wiring + deploy) is DONE and verified on devnet. master+main at `ea3f134`.**
>
> **(1) DEPLOYED this session (upgrade-first, one coordinated window).**
>   - **Program upgrade:** v3 by-address upgrade to **slot 472308749**, code-hash **`31c5239d…`** — byte-for-byte == the feature-free `--arch v3` artifact that passed the 133-test bankrun suite (deployed==tested; verified by hashing the first 1,370,560 program bytes — the whole-dump hash differs only by benign trailing zero-padding from the smaller-program allocation). Authority `5YRMuuoY…` unchanged; buffer rent refunded (net cost ~tx fees). Deploy sig `62JuyLAa…`.
>   - **App IDL synced** (commit **`e39b623`**): bundled `app/src/idl/opta.json` + `opta.ts` now carry 3-arg `initialize_vol_oracle` + 3 SB accounts + the `VolOracle` `_pad_align`/`seed_vol` tail. Re-emitted in the repo's escaped-unicode encoding so the diff is ONLY init + VolOracle (~87 lines), not 645 lines of benign anchor raw-UTF-8 churn. Un-`as any`'d the `pythPullPost.ts` init builder. **On-chain Anchor IDL deliberately SKIPPED** as cosmetic — the crank + FE load the bundled file, not the on-chain IDL account; updating it is a low-priority `anchor idl upgrade` follow-up if ever wanted.
>   - **VPS crank** pulled to `ea3f134` + restarted — running new code against the new program, no `InstructionDidNotDeserialize`. Upgrade-first was correct: the only breaking coupling was crank↔program (no FE race), so old-crank-meets-new-program would only break on the next oracle-birth, gated by the prompt restart.
>
> **(2) LATENT BUG FOUND + FIXED** (commit **`ea3f134`**). The Pyth-path builders (`buildPostUpdateAndPushVolSampleTx` + the settle/create/exercise siblings) omitted the 3 SB **optional** accounts; **anchor 0.32.1 rejects the call client-side** ("Account `sbQueue` not provided") — it does NOT auto-null unprovided optionals at `.instruction()` build time. **PRE-EXISTING, not a deploy regression** (fired 96× in the 6h before deploy; anchor version never changed, no `npm install`). It had been **silently skipping ALL Pyth vol-oracle warming pushes**, unnoticed only because the majors were already warm. **Fix:** pass `sbQueue/sbSlothashes/sbInstructions: null` in the 4 Pyth-path builders whose instruction carries SB accounts (left `migrate_pyth_feed` + `settle_vault` alone — no SB accounts). Post-fix: `feedsPushed` 0→5; **BTC/ETH/SOL recovered** (first push hit the gap-reseed branch — fresh `last_sample_ts`, `sample_count` unchanged, sampling resumes next on-cadence tick) — caught them BEFORE they hit the 6h staleness gate.
>
> **(3) POST-FIX STEADY STATE — verified benign.** `feedsSkippedStalePyth:10` = the on-chain 60s freshness gate (`VolOraclePriceStale`/6047) correctly rejecting **off-hours equities (6: MSFT/TSLA/CRCL/MSTR/AAPL/NVDA) + thin commodities (4: XAU/XAG/UKOIL/USOIL)** whose Hermes `publish_time` is genuinely >60s old. **NOT a crank-timing bug** — each feed is fetched fresh immediately before its own send; the split is purely by asset class (all 5 crypto feeds — incl the 3 majors — push fine; only slow/closed feeds stale). Slow equity/commodity warming is exactly what the class-first arc addresses, not a defect.
>
> **(4) PROVEN LIVE — the seed-at-birth smoke (the payoff).** Created **`XAUSMOKE`** (commodity, gold-priced; fresh feedHash **`47634b…4750`** ≠ gold's `6c3c5cc7`, via gold's PAXG jobs + a Kraken `PAXGUSD` source → fresh oracle PDA `Cgbe4mm…`; name distinct from canonical `XAU` so it can't shadow the real gold market). **tx1** `create_market` `5uEbhYKR…`, **tx2** `initialize_vol_oracle` `4PDVD2qV…` (separate txs, each its own fresh quote — the `find_ed25519_ix_index`-returns-first topology). **Birth fields (all 5):** `oracle_source=1`, `seed_vol=550000000000` (0.55 commodity), `last_spot_price=$4074.90`, `last_sample_ts≈now`, `sample_count=0`. **`get_option_price`** (Call $4000 +30d) → premium **$301.36** with **`vol_used=550000000000` == seed_vol** at `sample_count=0` — priced off the seed via the `quote.rs` handoff; all three gates (warmup/stale/spot) passed because birth seeded the fields. **This is the exact path bankrun couldn't reach (litesvm can't sign a slothash), now proven on a real SB QuoteVerifier flow.** XAUSMOKE is a safe artifact (market+oracle only, no vault → no `reclaim_unsettled` exposure); it won't auto-warm (not in `sbFeedRegistry`) but is tradeable indefinitely off `seed_vol`.
>
> **(5) NEXT-SESSION OPTIONS (no decision needed now):**
>   1. **Class-first create-market UX arc** — the FE-led arc this work UNBLOCKS. Its create→warm-gap question is now **SOLVED** (seed-at-birth). Inherits the FE separate-tx create flow (the descoped old "5c") + the partial-failure handling (tx1-ok/tx2-fail → retry oracle-birth; idempotent re-call; crank `!existing` sweep as backstop). Commodities-first; equity market-hours gating is the later layer.
>   2. **IV/price display bug on the Write page** — a post-SB FE regression flagged at the very start of this session, still OPEN (live frontend issue).
>   3. **Optional cleanups:** add `XAUSMOKE`/real commodity feeds to `sbFeedRegistry` if we want them warming; the on-chain Anchor IDL `anchor idl upgrade` (cosmetic); the **validator-mode test caller updates** (`zzz-*` + `ensureVolOracle`: 2-arg → 3-arg `initialize_vol_oracle`) flagged in the seed-vol commit — needed before the validator suite runs (bankrun is the gate; validator is not).
>
> **(6) COMMIT STATE.** master + main at **`ea3f134`** (source/arc state; this HANDOFF doc-commit rides on top). Session commits: `59aeb2e` (on-chain Changes 1-3 + bankrun tests, 133 passing) → `e09f904` (off-chain seed-vol wiring) → `e39b623` (app IDL sync) → `ea3f134` (Pyth-builder SB-null fix), plus `docs(handoff)` commits between. The 3 **parked locals (`App.tsx`, `constants.ts`, `vercel.json`) remain unstaged + untouched** across the entire arc — re-apply or commit them separately when ready.

> **2026-06-26 (seed-at-birth, off-chain wiring) — THE OFF-CHAIN SEED-VOL LAYER IS COMPLETE + build-green, committed `e09f904` (master+main), but INERT (committed-but-undeployed, coupled to the program deploy). On-chain capability (Changes 1-3) landed earlier at `59aeb2e`. Everything for instant-tradeable markets is now WRITTEN; nothing is LIVE until ONE coordinated deploy window.**
>
> **(1) WHAT LANDED THIS PASS (5a + 5b, commit `e09f904`).** The per-class seed table + the oracle-birth builders that pass it on-chain. **5a** — `app/src/utils/seedVol.ts` (new): `SEED_VOL_BY_ASSET_CLASS` (crypto 0.80 / commodity 0.55 / equity 0.45 / forex 0.12 / etf 0.25, encoded ×1e12 i64) + `seedVolForAssetClass(class)` (throws on unknown class — 0 is the on-chain "no seed" sentinel). **THE single source of truth — no Rust-side table**; the crank imports it via the `@app/*` alias, the FE will import it directly. Dependency-free plain integers; the call site wraps in `BN` at the i64 boundary. **5b** — wired it into oracle birth: `buildPostUpdateAndInitializeVolOracleTx` (`pythPullPost.ts`) `+seedVol` arg → `initializeVolOracle(feedId, 0, new BN(seedVol))` + null SB accounts; `volOracleCrank.ts` reads `asset_class` off each market, resolves the seed, threads it (log+skip on unknown class, never crash the loop); `sbOracleCrank.ts` `birthSbOracle` now seeds + verifies a fresh quote at birth (the **un-deferred SB proof** — `[CU, ed25519, init(source=1, seed_vol, +SB accounts)]`), reads class off the SB market, birth-skips a `FORCE_FEED` with no market (push path unaffected). **Build-green both typechecks: `crank tsc --noEmit` + `app tsc -b/vite` clean.**
>
> **(2) SCOPE REFRAME — LOCKED.** The FE is **Pyth/crypto-only** (`pythPullPost.ts:542` hardcodes `oracle_source=0`); SB market creation is **crank-only** (`switchboardCreateMarket.ts`, no FE path). So **seeding lives in the CRANK**, and the **FE separate-tx oracle-birth create flow (the old bundle item "5c") is REMOVED from this deploy bundle** — there is no FE caller of `initialize_vol_oracle` to wire. It moves to the **class-first create-market UX arc** (the NEXT-ARC block below), where the FE first gains an SB create path and oracle-birth-in-the-create-flow finally has a reason to exist. This bundle is now exactly: program deploy + app IDL sync + crank pull. The FE bundle is UNCHANGED this window → **no FE↔program race**.
>
> **(3) THE DEPLOY SESSION — next, as ONE coordinated window. Direction LOCKED: UPGRADE-FIRST.** Sequence:
>   1. **Program upgrade** — v3 by-address, the committed Rust (Changes 1-3 + `initialize_vol_oracle`), **feature-free build** (LOW-5 guard: prod builds MUST be feature-free).
>   2. **App IDL sync** — `app/src/idl/opta.json` + `opta.ts` to the new 3-arg `initialize_vol_oracle` + 3 SB accounts. **Then un-`as any` `pythPullPost.ts:695`** (the single new cast — see §5).
>   3. **Crank pull + restart LAST** — VPS pulls to `e09f904` (or the deploy HEAD); `npm install` only if the SB SDK dep changed; `systemctl restart opta-crank.service` so it loads the synced IDL (note the prior arc's lesson: SB-enable needed `restart --no-block` + poll through the ~8-min drain).
>   **RATIONALE for upgrade-first:** the ONLY breaking coupling is **crank↔program** — the only 3-arg `initialize_vol_oracle` caller is the crank; the FE is unchanged this bundle, so there is NO FE `InstructionDidNotDeserialize` race (unlike the 1c-i-B create_market window). Upgraded-program + old-crank-code only breaks on the crank's NEXT oracle-birth attempt, which we control by restarting promptly. Crank-first would instead break on any new market the moment the old 2-arg crank code meets the new program. Upgrade-first minimizes the live-break surface to a window we gate.
>
> **(4) REQUIRED IN THE DEPLOY SESSION — the live SB-birth devnet smoke.** The SB birth happy-path is the one path bankrun CANNOT reach (litesvm can't fabricate a valid signed `slothash`). After deploy: create a real SB market (commodity, e.g. gold) + birth its oracle with a fresh signed quote, and confirm born `oracle_source=1`, `last_spot_price>0` + `seed_vol` set + `last_sample_ts≈now`, HIGH-5/`sb_current_spot_scale` passed on a real quote, and an American mint prices off the seed. This is the deploy-session acceptance gate for the SB arm.
>
> **(5) THE SINGLE NEW `as any` TO REMOVE POST-SYNC: `pythPullPost.ts:695`** (the `(program.methods as any).initializeVolOracle(...)` chain — cast only because the 3-arg sig + SB optional accounts aren't in the stale `opta.ts` this session). The **3 SB chains in `sbOracleCrank.ts` (birth :440, push :514, settle :682) were PRE-EXISTING** — leave them or revisit per the prior arc's note; only :695 is this arc's debt.
>
> **(6) STAGING HYGIENE.** Three commits this session — `59aeb2e` (on-chain + bankrun tests), `a2572ef` (HANDOFF), `e09f904` (off-chain wiring). The parked locals **`App.tsx`, `constants.ts`, `vercel.json` remain unstaged + untouched** across all three (deliberately excluded; `seedVol.ts` was created NEW so the dirty `constants.ts` stayed parked). Re-apply or commit those three separately when you're ready — they predate this session.

> **2026-06-26 (seed-at-birth) — INSTANT-TRADEABLE seed-vol capability LANDED on-chain, bankrun green (133 passing), committed `59aeb2e` (master+main). The on-chain seed-at-birth ability EXISTS but is UNDEPLOYED, and the off-chain layer is UNWIRED — both are a single deferred coordinated bundle (below). Do NOT assume markets are instant-tradeable in production yet.**
>
> **(1) WHAT LANDED (commit `59aeb2e`, on-chain source only — NOT deployed).** A brand-new market can be priced from minute one instead of waiting ~7 days (168 samples) for the vol oracle to warm. Three fields are now seeded at oracle birth so `price_american`'s spot + freshness gates pass at minute zero and it prices off a per-asset-class seed vol while the realized-vol ring warms and later takes over. **Change 1** (`state/vol_oracle.rs`): `seed_vol: i64` claimed in place from the old `_padding` (now `_pad_align[2]` + `seed_vol[8]`); **size unchanged at 5856** → legacy oracles read `seed_vol=0` via `load_init` zero-fill, **migration-free** (same trick as `oracle_source`). Zero-safe sentinel: `seed_vol==0` = "no seed, behave as before". **Change 2** (`initialize_vol_oracle.rs`): `+seed_vol` arg; writes `seed_vol` + `last_spot_price` + `last_sample_ts` at `load_init`. Spot is **source-routed** — `pyth_current_spot_scale` (Pyth, reads spot from the proof `PriceUpdateV2` already passed in) / `sb_current_spot_scale` (Switchboard), which **UN-DEFERS the SB feed-existence proof to birth** (was deferred to first push). `+3` trailing SB optional accounts (`sb_queue`/`sb_slothashes`/`sb_instructions`). **Change 3** (`american_pricing/quote.rs`): the ONE handoff site — warm (`sample_count>=168`) uses realized vol UNCHANGED; else `seed_vol!=0` uses the seed; else reverts `VolOracleWarmup` (legacy behavior). **Warm majors (BTC 394 / ETH 392 / SOL 394, confirmed live) never consult the seed — strictly additive.** Note the tightened Pyth init: birth now also enforces spot>0 / conf≤200bps / freshness≤60s (it reads a real spot to cache).
>
> **(2) TESTS (bankrun is the gate; `target/idl`, NOT app IDL — no app-IDL touch needed for tests).** New `tests/bankrun/initialize-vol-oracle-seed.test.ts` (6 tests): cold+seeded Pyth (premium monotonic in seed_vol), cold+seeded **SB-sourced** (fabricated `oracle_source=1` oracle — proves the handoff is source-agnostic), warm-ignores-seed (premium invariant when seed patched 0→5.0), cold+unseeded reverts `VolOracleWarmup`, birth populates spot+ts, 5856 legacy-load. Rewrote `sb-init-vol-oracle-source.test.ts` for the un-deferred SB proof (no-SB-accounts → `SwitchboardAccountsMissing`). Mechanically updated the breaking callers (`+seed_vol` `+3 null SB accts`): `bankrun/helpers.ts` `setupEnv`, `lifecycle-smoke`, `pass2-money-logic`. **Full suite: 133 passing, 0 failing.**
>
> **(3) SB BIRTH HAPPY-PATH IS UNPROVEN — required post-deploy live devnet smoke.** litesvm cannot fabricate a valid signed SB `slothash`, so a REAL Switchboard-quote birth (the `QuoteVerifier` path through `sb_current_spot_scale`, writing spot+ts+seed at init) is NOT exercised in bankrun — the SB tests fabricate the oracle via `setAccount` and cover only the handoff + guard surface. **The deploy session MUST include a live devnet smoke: create an SB commodity market + birth its oracle with a fresh signed quote, confirm `oracle_source=1` + `last_spot_price>0` + `seed_vol` set + an American mint prices off the seed.** Same limitation that has deferred every live SB happy-path in this codebase.
>
> **(4) PRE-EXISTING FLAKE FIXED (so it's not a mystery later).** `sb-create-market-source.test.ts` `(IDx)` (a `create_market` test, committed `eb225b0`, unrelated to this arc) was order-sensitive: its re-call is byte-identical to its first `createMarket`, so litesvm dedups it under full-suite ordering (passes in isolation, failed in full-suite). My new test file sorts before `sb-` and shifted ts-mocha ordering, exposing it. Fixed with the one-line `.preInstructions([CU(390_000)])` workaround its own sibling `(IDok)` already documents. Not a behavioral change; restores green.
>
> **(5) THE DEFERRED COORDINATED DEPLOY BUNDLE — NEXT SESSION'S SCOPE (everything below ships together; nothing is live until it does).**
> - **(a) Per-class seed table** → `app/src/utils/constants.ts` (`SEED_VOL_BY_ASSET_CLASS` + `seedVolForAssetClass`): crypto 0.80, commodity 0.55, equity 0.45, forex 0.12, etf 0.25, encoded `round(σ×1e12)` → i64. SINGLE source — crank imports via the `@app/*` alias, FE imports directly (no duplication).
> - **(b) Shared builder** `buildPostUpdateAndInitializeVolOracleTx` (`app/src/utils/pythPullPost.ts:653`): `+seedVol: BN` arg `+3 null SB accounts` (`as any` casts to keep builds green pre-IDL-sync). Crank `volOracleCrank.ts` reads `asset_class` off the market and passes `seedVolForAssetClass`. **COUPLED to the program deploy** — the live VPS crank loads the same `opta.json`, so this code activates/breaks only at deploy.
> - **(c) FE create flow** (`NewMarketModal.tsx`): **separate-tx topology** — tx1 `create_market`, tx2 `initialize_vol_oracle`, ONE user action. Pyth-only in the FE (FE has no SB create today). **Each tx self-posts its own fresh Pyth update**, so tx2 trivially meets the **≤60s init freshness** window. SB create-flow birth (crank) reuses `buildManagedQuoteUpdateIxs` + `[ComputeBudget, edIx, ix]`, **also separate txs**. **WHY SEPARATE TXS (not one):** `find_ed25519_ix_index` returns the FIRST ed25519 ix in the Instructions sysvar (no feed-matching); two ed25519 quotes in one tx would collide and both calls would resolve to the first. Separate txs → exactly one ed25519 quote each → unambiguous. (The same signed SB quote can be re-attached to each tx while still inside its slot window.)
> - **(d) Partial-failure handling** (tx1 lands, tx2 fails — RPC hiccup / quote ages past 60s / wallet drops 2nd sign): (i) FE detects tx1-ok/tx2-fail → retry ONLY oracle-birth (re-running both is also safe — `create_market` is `init_if_needed`, silent-Ok on re-call); (ii) **idempotent re-attempt VERIFIED** — `initialize_vol_oracle.vol_oracle` is plain `init`: a FAILED first birth rolls back → PDA absent → re-callable; a SUCCEEDED birth → reverts "account already in use" (no double-birth); **and the crank `!existing` sweep auto-births any orphaned market within one cycle** (seeded identically — same `asset_class` lookup) = the safety net; (iii) UI reuses `useVolOracleStatus` "pending" gating during the (now ~1-tx) gap — a market with no oracle degrades to today's "pending", never to a mispricing.
> - **(e) App IDL sync** (`app/src/idl/opta.json` + `opta.ts`): the `+seed_vol` arg + 3 SB accounts on `initialize_vol_oracle`. **Deliberately NOT done this arc** (the live crank + FE both read this file; syncing it without deploying breaks them).
> - **(f) Coordinated program deploy** (Stage-I feature-free build), lockstep with (e). Then the §3 live SB smoke.
> - **(g) Validator-mode test callers** — the `zzz-*` suite (`run-tests.sh`, NOT run this arc) still calls the old 2-arg `initializeVolOracle` and needs the same `+seed_vol` `+3 null SB accts` mechanical update before it runs: `tests/_vol_oracle_helpers.ts` (`ensureVolOracle`, canonical), `zzz-vol-oracle.ts` (10 sites), `zzz-american-vault-lifecycle.ts`, `zzz-exercise-american.ts`, `zzz-get-option-price.ts`, `zzz-mint-from-vault-american-pricing.ts`, `cu-profile-get-option-price.ts`, `cu-profile-mint-from-vault-american.ts`.
>
> **(6) HOW THIS COMPOSES WITH THE class-first UX arc below.** Seed-at-birth is the answer to that arc's "§6 open UX question — the create→warm gap": a seeded market is tradeable at minute zero instead of dead for ~7 days. The two arcs SHARE the deferred bundle (the class-first create flow IS where tx2 oracle-birth + the per-class seed lookup get wired). Recommend folding (5a–5g) into the class-first deploy rather than a standalone deploy.

> **2026-06-26 (session 2) — NEXT ARC LOCKED: class-first market-creation UX (route oracle by asset class; one asset = one market). Spec'd, reverse-engineered to current state, shortest-path sequenced. Build starts fresh next chat.** This is the FE-led arc that turns the now-live SB create capability into a real user-facing flow. On-chain side is DONE (both create paths live + proven — Pyth arm 1c-i-A, SB arm Part 1); this arc is overwhelmingly FE + a registry/catalog + one deferred crank piece.
>
> **(1) THE UX SPEC (locked, Nanko's words distilled).** Create Market popup becomes **asset-class-first**: (a) user picks asset class FIRST (crypto / equity / commodity); (b) class routes the oracle invisibly — **crypto → Pyth, equity + commodity → Switchboard** (user never sees "Pyth vs Switchboard," just picks what kind of thing it is); (c) user then searches by name ("gold", "copper") OR enters a feed ID, scoped within the class; (d) **ONE asset = ONE market** — searching "gold" finds the existing gold market; NO `XAU` vs `SBXAU` duplication, no "gold pro max," no gold-under-the-crypto-banner. The `SBXAU` name from the Stage-3 smoke was a TEST artifact only — in the real UX gold is just `XAU`/`GOLD`, backed by SB because it's a commodity.
>
> **(2) WHY THE CLASS-FIRST SPLIT IS THE KEY PRIMITIVE.** It eliminates the duplication problem STRUCTURALLY, for free: markets are keyed by `asset_name` and a name can only hold one `oracle_source` (the 1c-i-B source-aware idempotent guard rejects same-name-different-source with `AssetMismatch`). Since class routes the oracle and commodity ALWAYS → SB, there is no Pyth-gold to collide with an SB-gold — gold is only ever creatable as SB (gold isn't crypto, so the crypto/Pyth path never offers it). The "no duplication" requirement FALLS OUT of class-first routing — it is not extra work. The only enforcement: name-search must scan ALL markets so "gold" finds the existing `XAU` regardless of who made it (scoping the existing search correctly).
>
> **(3) WHERE WE STAND vs THE SPEC (the gap).** On-chain: COMPLETE (both `create_market` paths live + proven; `pyth_feed_id` is a dual-purpose 32-byte oracle id that holds a Pyth feed-id OR an SB feedHash, meaning routes by `oracle_source`; `asset_class` field exists on-chain 0-4). The gap is almost entirely FE + data: (i) **popup restructure → class-first** (new FE); (ii) **wire the SB-create path into the FE** — port `crank/switchboardCreateMarket.ts` → `app/` + add the SB SDK browser-side (the deferred "when a browser SB-create UI is built" work), route class∈{crypto}→existing Pyth builder, class∈{equity,commodity}→SB builder (FE + the port); (iii) **SB feed search/lookup in the FE** — the registry currently lives `crank/sbFeedRegistry.ts` (gold-only), needs an FE-accessible version or an API (FE + registry exposure); (iv) **scope search across all markets** for the no-duplication enforcement (mostly free, FE).
>
> **(4) THE TWO THINGS THAT ARE NOT SHORT (be honest).** (a) **The SB feed catalog** — for "search copper → get a feed," copper's SB feedHash + jobs must be vetted + in the registry. Registry currently = ONE entry (gold). Every equity/commodity wanted searchable needs its feed added — a data-gathering task, ongoing, NOT a one-time build. The UX works the moment a feed's in the registry; it just won't find feeds that aren't. (b) **Market-hours gating for equities** — equity feeds don't update when markets are closed; the warming crank needs market-hours awareness or it stalls/errors off-hours. NOT BUILT. Commodities (gold/silver/oil ~24/5) mostly dodge this; equities don't.
>
> **(5) SHORTEST-PATH SEQUENCING (the recommendation).** **Ship COMMODITIES first (gold/silver/oil), defer equities.** Rationale: commodities need NO market-hours work (the hard new piece) — they trade ~24/5 like gold already does; gold is already created + warming (the proof case); the FE work (class-first popup + SB-create wiring + search) is built ONCE regardless of class; equities become a clean follow-on (add market-hours gating to the crank + populate equity feeds). So the shortest path to the UX = **the FE rebuild (class-first popup + SB-create wiring + cross-market search) + commodity feeds in the registry**, with equities + market-hours as the next layer.
>
> **(6) THE ONE OPEN UX QUESTION (Nanko to decide at arc start) — the create→warm gap.** A freshly-created SB market is NOT tradeable until its oracle warms (~7 days / 168 samples). The spec lets a user CREATE a market but didn't cover what they see between "created" and "tradeable." A 7-day-dead market is a bad first experience. Options: (a) show a "warming, tradeable in ~Nd" state on the market; (b) pre-warm a curated set of common commodities so they're instantly tradeable (needs a pre-warm crank pass — more than FE); (c) something else. **This answer shapes whether the arc is purely FE or also needs a pre-warm crank pass — decide first.**
>
> **PREREQUISITE STILL PENDING (from the Stage-3 close):** gold's full lifecycle isn't proven end-to-end yet — the ~7-day warmup is running (oracle `AK8M6Z`, `sample_count` reseeded to 0 on the crank-enable push), then the post-warmup smoke (seed an `XAU`/`SBXAU` vault → trade → settle via the deployed SB path) is the final lifecycle proof. Cleaner to prove gold end-to-end BEFORE building the UX that creates more SB markets — so this UX arc and the post-warmup smoke are both ~live-after-warmup, and the smoke arguably comes first (don't stack an unproven UX on an unproven settle path).

> **2026-06-26 — SWITCHBOARD STAGE 3 ARC COMPLETE: deployed + exercised live on devnet. The full SB surface (read-routing, VolOracle birth, create-market, warming crank, settle) is live; both QuoteVerifier paths proven on real data; the gold SB market is created and autonomously warming.** Program `CtzJ4M…` at slot **472083747** (1c-i-B), code-hash `1094656bfcea07c9ce283ed5309a62a8589b89f9a7f99882899f55c8e4502e6e` (deployed==tested); FE/IDL/program all 4-arg consistent. HANDOFF baseline is now `120d157` (the FE/IDL Phase-B push; on-chain at 1c-i-B / slot 472083747).
>
> **(1) The coordinated deploy — DONE (Phase A/B/C).** **Phase A:** crank VPS pull to `a6434ae`, SB gated OFF (`OPTA_SB_CRANK_DISABLED=1`, spawn-skipped) — zero-risk, 3 Pyth loops unperturbed; required `npm install` for the SB SDK (the one non-obvious safety item — `bot.ts` imports the SB module at load before the gate). **Phase-B prereqs (`5237e9e`):** the 4 FE Pyth builders switched `.accountsStrict()` → `.accountsPartial()` (NOT plain `.accounts()` — that rejects explicitly-passed derivable PDAs; partial accepts the full set + auto-omits trailing optionals → byte-identical Pyth tx) + the net-new `crank/switchboardCreateMarket.ts` SB-create builder (in `crank/` NOT `app/` so the SB SDK isn't forced into the FE bundle) + the staged `app/src/idl/opta.phase-b.json` (42-instr feature-free IDL, synth_warm filtered). **Phase B (the coupled window, `120d157`):** on-chain 1c-i-B v3 by-address upgrade (sig `4Q4ufnaN…`, slot 471951060→472083747, code-hash match) + applied the staged IDL → live `opta.json`/`opta.ts` (4-arg create_market, 42 instrs) + FE create-caller `+,0` + Vercel promote. **Vercel CLI pre-build/promote DIED on the monorepo tree-scan (locked validator ledgers + 2.4 GB scan despite `.vercelignore`)** → fell back to push-to-main (Vercel clones the git tree, excluding gitignored artifacts). Gap was ~3-4 min (4-arg FE met 3-arg program — the "+ New Market" button only, rare devnet op), NOT the projected seconds, because Vercel built in ~1-2 min faster than the buffer-confirm. **LESSON: with a sub-2-min Vercel build, "upgrade-first" is the tighter direction (not the FE-first we used).**
>
> **(2) Phase C — the live exercise (both QuoteVerifier paths proven).** **Part 1 — generalized HIGH-5 proven LIVE** (the last deferred happy-path in the whole arc; litesvm couldn't fabricate `signed_slothash`): the create-as-SB smoke (`crank/smoke-create-sb-market.ts`, scratch) created market **`SBXAU`** (commodity, gold feedHash `0x6c3c5cc7…`), PDA **`4pEmVTXdg6GayFeFmnSphiK3eLLYrPGSfX8g9ah8ADT1`**, `oracle_source=1`, via create tx `3AiaYQdu…` — the SB arm verified a real signed gold quote through `QuoteVerifier`/`sb_prove_feed_exists`, clean on attempt 1. **Market-only (no vault → untradeable/safe artifact); visible in the FE but inert.** **Part 2 — SB crank enabled** (VPS pulled `a6434ae`→`120d157` FIRST to sync the 4-arg/SB IDL — the critical pre-req, else the live SB loop builds txs against the stale IDL; `.env`: `OPTA_SB_CRANK_DISABLED=0` + `OPTA_SB_DRY_RUN=0`; backup `.env.bak-20260626-115313`; no `npm install` needed — no crank dep change). SB loop spawned, discovered `SBXAU`, **VolOracle birth SKIPPED** (its PDA = `["vol_oracle", gold_feedHash]` = **`AK8M6Z…`** = the oracle 1c-i-A already birthed). First warming push `47Kn459r…` wrote `last_spot_price=$4028.18` (live gold); gap-reseed (1c-i-A push was hours ago, past the 2h floor) → `sample_count=0`, warmup restarts fresh. 3 Pyth loops unperturbed; crank wallet `5sHZ…` = 26.14 SOL.
>
> **(3) WHAT'S PROVEN NOW vs WHAT COMPLETES OVER WARMUP.** **Proven live, real data:** the entire SB on-chain surface (4 read sites routed + deployed dark; VolOracle birth; create-market HIGH-5; BOTH QuoteVerifier paths — push arm 1c-i-A + create arm Part 1); the SB crank (warming + settle passes) live on the VPS; gold market created + the autonomous crank writing live gold. **Completes over the ~7-day warmup** (autonomous, hourly `push_vol_sample` SB sends, 168 samples): the gold oracle becomes PRICEABLE → enabling the final end-to-end lifecycle proof — seed a real `SBXAU` vault → trade it → settle via the deployed `settle_expiry` SB arm + the crank's settle pass. **THAT POST-WARMUP SMOKE IS THE NEXT NATURAL SESSION (~7 days out).** SB-trigger ≤2-sig CONFIRMED resolved: gold resolves to a 2-sig quote (ed25519 = 318 B in both create + push) → gold triggers fit the 1200 B/32 B-margin tx.
>
> **(4) SOL economics (confirmed live):** SB push = **0.000015 SOL** (cheaper than Pyth's ~0.000025 — no ephemeral PriceUpdateV2); VolOracle birth = 0.0417 SOL one-time (skipped for gold — `AK8M6Z` pre-existed). Crank wallet `5sHZ…` ≈ 26.14 SOL → ~640 SB oracles of runway; the gate is gateway/RPC throughput, not SOL.
>
> **(5) HOUSEKEEPING (flagged, your call):** (i) The pre-existing local **`.gitignore`** change was inadvertently discarded during the Phase-B Vercel cleanup (`git checkout -- .gitignore` reverted Vercel's edit AND the local tweak; unstaged → not git-recoverable; `.gitignore` now at HEAD). Re-apply whatever that local ignore tweak was if needed. The other 3 locals (`App.tsx`, `constants.ts`, `vercel.json`) are untouched. (ii) A stray empty Vercel project **`butter_options`** (`prj_JkCe…`) created by `vercel link --yes` — safe to delete in the Vercel dashboard.
>
> **AFTER STAGE 3 (sequencing unchanged):** (1) ✅ Stage 3 DONE (deployed + exercised; only the autonomous warmup + the post-warmup lifecycle smoke remain). (2) **Epoch-vault ladder arc** — the rolling tenor generator (BTC/ETH/SOL Deribit-style surface, Pyth-sourced; SOL cost now known-cheap per §4). (3) **Trade-v2 flip** — unified launch on a POPULATED chain (the postable "people are using it" moment). Stage 3's SB routing now enables adding the TradFi surface (gold/equities/FX — gold already proven) to that ladder as a post-launch expansion.

> **2026-06-25 (session 3) — SWITCHBOARD STAGE 3 BUILD ARC COMPLETE. Every SB piece built, tested, dry-run-proven, committed. The ONLY remaining Stage 3 work is one coordinated multi-surface deploy.** The live `QuoteVerifier` is proven (session 2 gold smoke); create-market-as-SB + the warming crank + settle-at-expiry are all built and held. The indexer question was RESOLVED by reading the crate source — it's marginal, not built. HANDOFF baseline is now `c6c1c51`.
>
> **(1) The full SB build map (all committed):** **1a/1b** read-routing surface, 4 sites, deployed dark (`c126589`, upgrade sig `ndkfaRAT…`). **1c-i-A** SB VolOracle birth (`initialize_vol_oracle` 2-arg + optional price_update) — DEPLOYED (`db55c20`, sig `4twddmJV…`, slot 471951060, code-hash `9102e957…`) + the live verifier PROVEN (gold smoke, $4018.80 write, tx `4UuEtqHV…`). **1c-i-B** create-market-as-SB + branched HIGH-5 (`eb225b0`) — HELD undeployed. **1c-ii-A** SB warming crank, 5th side-loop (`df46ca7`) — HELD, gated-off. **1c-ii-B** SB settle-at-expiry, pure crank (`c6c1c51`) — HELD, gated-off.
>
> **(2) The indexer verdict — MARGINAL, not built (the key session-3 finding).** Verified in `switchboard-on-demand@0.13.0/quote_verifier.rs`: `SYSVAR_SLOT_LEN=512`, and BOTH verify paths (`verify_instruction_at` inline AND `verify_account` persisted) route through the IDENTICAL slothash+max_age core. A persisted quote is verifiable only within ~512 slots (~3.5 min) of SIGNING — `verify_account` does NOT escape the wall, there's no historical-attestation store or alternate freshness model. So a self-indexer can't extend settlement reach past the wall; the guarantee is a tight LIVE fetch+settle within the window. Built no indexer, no persistence (crank stays stateless). This collapsed the hardest-sounding SB piece into "don't build it," and made 1c-ii-B pure crank.
>
> **(3) SB settle = pure crank, low stakes.** The on-chain SB settle path was already complete (the `settle_expiry` SB arm deployed dark in 1b + `reclaim_unsettled`), so 1c-ii-B needed ZERO Rust. The Pyth settle loop now SKIPS SB markets (single guard `if oracleSource===1 continue` in `computeExpiredTuples`; Pyth markets byte-identical); SB settle lives in `sbOracleCrank` (one loop, two cadences: 45s settle-check well inside the 300s window + hourly warming push; fast-path no-op when zero SB markets). A missed settle → `reclaim_unsettled` (holders forfeit, writers get collateral, NO FUND LOSS) — so settle timing is OPTIMIZATION, not correctness. Retry bound 3, per-tuple isolation.
>
> **(4) THE COORDINATED DEPLOY (the one remaining Stage 3 step — next session).** Four surfaces, one window, gated-STOP discipline like the 1c-i-A deploy. **(a) On-chain:** ONE v3 by-address upgrade carrying ONLY 1c-i-B (`create_market` 4-arg + branched HIGH-5 + SB accounts). 1c-ii is pure crank — NOT on-chain. (b) **Crank (VPS pull):** 1c-ii-A + 1c-ii-B; set `OPTA_SB_CRANK_DISABLED`/`OPTA_SB_DRY_RUN` defaults (ship gated-off + dry-run-first like the trigger keeper was). (c) **App IDL sync + Vercel redeploy (FE-redeploy-COUPLED):** the live, ungated "+ New Market" button calls 3-arg `createMarket` → the moment the 4-arg program deploys, an un-redeployed FE breaks with `InstructionDidNotDeserialize`. The on-chain upgrade + FE redeploy MUST land in the same window. **The IDL sync is now MULTI-INSTRUCTION** (bigger than just create_market): 1a/1b never synced the SB trailing accounts into `app/src/idl/opta.json` (they were on-chain-only), so push/settle/exercise/trigger SB accounts + the 2-arg init (already synced) + 4-arg create_market ALL need to be in the app IDL — likely a FULL replacement from the feature-free production `target/idl`, not surgical block-copies. The crank loads the app IDL at runtime, so without this sync the production SB crank builds SB txs MISSING their accounts (currently compiled with `any` casts on the push/settle method-chains — revisit the casts post-sync). Also the deferred FE caller fix: `buildPostUpdateAndCreateMarketTx` `+,0` + a NEW SB-create-market off-chain builder module (the SB analog of the Hermes-post builder, using `buildManagedQuoteUpdateIxs`). (d) **First SB market + the create-as-SB devnet smoke** — the one happy-path the dry-runs couldn't reach (no live SB market exists yet; create-SB-market is held). Create an SB market for the gold feedHash with a fresh quote, confirm born `oracle_source=1` + HIGH-5 passed. Then the SB crank can warm it and the SB settle can be smoked against a real SB vault.
>
> **(5) DEFERRED ITEMS STILL DUE (carried, post-deploy or at-deploy):** (i) **SB-trigger tx-size gate** — SB-routed `execute_trigger` is 1200 B / 32 B margin vs 1232 assuming a ≤2-sig quote (a 3-sig quote +~96 B OVERFLOWS). Before any SB market has triggers: confirm the SB feed resolves ≤2 sigs OR move the SB-trigger path to versioned-tx+ALT (~500 B recovered). The gold pilot is 2-sig (`min_oracle_samples=2`), so gold triggers fit — but this gates adding feeds. (ii) **The §6 hazard** — do NOT create a live TRADEABLE SB market until the crank is live+warming AND settle is live: a tradeable SB market needs its SB VolOracle birthed + WARMED (168 samples / ~7 days) before it can price, and needs the settle pass live before expiry. So sequence: deploy → crank warms gold oracle (~7 days) → only then is a gold SB market tradeable. (iii) **The `any` casts** in `sbOracleCrank` (push + settle chains) become properly typed once the app IDL is synced. (iv) **Validator-suite SB nulls** — the `ts-node --transpile-only` validator suite has lacked SB nulls in settle/push `accountsStrict` calls since 1a/1b; before any validator-suite run against a deployed SB surface, those need the SB nulls (bankrun is the gate, validator suite is not — low priority).
>
> **(6) Crank SOL reality (ground-truthed session 3):** an SB push costs **0.000015 SOL** (empirical, on the proof tx — CHEAPER than Pyth's ~0.000025, no ephemeral PriceUpdateV2 post/consume/close; the inline `verify_instruction_at` persists nothing). The only meaningful cost is the one-time **0.0417 SOL** VolOracle rent (not reclaimable). Crank wallet `5sHZ…Gfqa` = 26.78 SOL → sustains ~640 SB oracles. Warmup ~0.0025 SOL, steady-state ~0.00036/day. The gate is gateway/RPC throughput, NOT SOL — which also de-risks the epoch-ladder cost concern by proportion.
>
> **AFTER STAGE 3 (unchanged sequencing):** (1) finish Stage 3 (the coordinated deploy above), (2) epoch-vault ladder arc (fills a Deribit-style BTC/ETH/SOL surface, Pyth-sourced — SOL cost now known-cheap), (3) Trade-v2 flip (unified launch on a POPULATED chain, the postable "people are using it" moment). Stage 3's SB routing later enables adding the TradFi surface (gold/equities/FX) to that ladder as a post-launch expansion.

> **2026-06-25 (session 2) — LIVE QuoteVerifier HAPPY-PATH PROVEN on devnet + SB VolOracle birth path (1c-i-A) DEPLOYED. Stage 3's single biggest unknown is RETIRED.** The one thing deferred through every read-routing sub-unit (litesvm can't fabricate a valid `signed_slothash`) is now proven live: a real signed gold quote verified on-chain through `push_vol_sample`'s SB arm, writing `last_spot_price = $4018.80` (band-gated; live gold drifted ~$35 from the $4053.90 fixture). Proof tx `4UuEtqHVzMnQcanCKuKymuNk7BNCAqUFcKL4vPhAAr2LZuxLNtpLLS2pwLYxQRC9o4JQs77NVFjnKeJaCgMaBtwz`. The whole SB read path is validated end-to-end on the real oracle network: SB VolOracle birth (oracle_source=1, price_update=None) → self-packed ed25519 multi-sig quote the precompile accepts (SDK Custom:2 bug worked around at N=2) → `QuoteVerifier` (ed25519-ix-from-sysvar + SlotHashes freshness) → `sb_extract_feed_value` + `sb_i128_to_scale` (1e18→1e12) → on-chain write, routed purely off the VolOracle byte.
>
> **(1) 1c-i-A — the SB birth path (commit `db55c20`, DEPLOYED).** Until this, NOTHING on-chain could set `oracle_source=1` (create_market / initialize_vol_oracle both hardcoded Pyth; migrate only zero-fills). 1c-i-A generalized `initialize_vol_oracle` with an `oracle_source: u8` arg (validated 0|1, else 6066); `price_update` → `Option` (required Pyth, None SB). **SB feed-existence proof DEFERRED to first push_vol_sample** (a junk feedHash is inert — push's SB arm rejects unknown feeds with `SwitchboardFeedNotFound`, oracle stays cold, cost is the initializer's own ~0.041 SOL rent; the real proof belongs at market-create / 1c-i-B HIGH-5). **Instruction-data break (accepted):** the trailing arg breaks existing 1-arg `initialize_vol_oracle` txs, but init is one-time per feed, every existing oracle is already initialized → break touches only NEW oracle creation. **Deploy-coupled caller fix shipped in the same commit:** the vol-oracle crank (`volOracleCrank.ts`, gated `if !existing`) is the one runtime actor calling init — updated its builder `+,0` + surgical `initialize_vol_oracle` block-copy into `app/src/idl/opta.json`+`opta.ts` (NOT a full resync — the fresh IDL is testing-flavored, 43 vs 39 instrs). FE never invokes the builder (compile-dep only). `crank/idl/opta.json` untouched.
>
> **(2) Deploy (1c-i-A).** v3 by-ADDRESS upgrade, sig `4twddmJV…`, slot `471951060` (prev `471883039`). Code-hash `9102e957…` (on-chain truncated to local `.so` length == local) — deployed==tested, definitively. `.so` 1,361,840 B, ELF 0x3, ~70 KB headroom, no extension, authority `5YRMuuoY…` unchanged. On-chain IDL `initialize_vol_oracle` now shows `[feed_id, oracle_source]` + `price_update` optional, 42 instrs (no test pollution). **Canary lesson applied: caught the baseline in a clean no-push window this time → canary byte-identical (vol+spot unchanged, sample counts unchanged). Code-hash is the primary proof; canary secondary.** HANDOFF baseline is now `db55c20` (deployed); the dark-routing baseline `c126589` is its parent.
>
> **(3) Smoke artifact.** An unlisted SB-sourced VolOracle `AK8M6ZKbhCmADR6f6P5Rs1inwxU3YYK27VV8eyBTfFcF` (gold feedHash `0x6c3c5cc7…`) now exists on devnet with one real gold sample — harmless, market-free, no FE surface lists it. Smoke script `.opta-build/smoke-sb-vol-oracle.mjs` (gitignored scratch, inlines `packEd25519Ix` + the `buildManagedQuoteUpdateIxs` capture-hook). Gateway flakiness (~3/15 clean per root-cause) did NOT bite — clean land on attempt 1/8.
>
> **NEXT — Stage 3 1c-i-B + 1c-ii (build the SB surface on a PROVEN foundation).** The verifier risk is retired; remaining Stage 3 is now known build work, no unknowns in the way. **1c-i-B — create-market-as-Switchboard + generalized HIGH-5:** generalize `create_market` with an `oracle_source` arg + branched create-time proof (Pyth → existing `PriceUpdateV2` Full-check at `create_market.rs:68-81`; SB → one `QuoteVerifier` pass asserting a feed with matching `feed_id()` exists, via the unit-proven `sb_extract_feed_value`). `pyth_feed_id` holds the 32-byte SB feedHash with NO schema change (documented double-duty, `market.rs:76-80`). Same trailing-optional SB account pattern; `create_market` is permissionless. SB create-market off-chain builder needs the SB analog of `buildPostUpdateAndCreateMarketTx` (the ed25519-quote machinery). **1c-ii — SB crank posting loop** (5th side-loop, wires the now-proven `switchboardQuotePost.ts`+`ed25519SelfPack.ts`, gated `OPTA_SB_CRANK_DISABLED`, dry-run first) **+ the self-indexer** (mandatory — SB has no historical archive, every signed attestation persisted for settlement). **DEFERRED ITEMS STILL DUE:** (i) SB-trigger tx-size gate — SB `execute_trigger` is 1200 B / 32 B margin vs 1232 assuming ≤2-sig (3-sig +~96 B overflows) → confirm ≤2-sig feeds OR versioned-tx+ALT before SB triggers go live; (ii) SB settle 5-min window crank scheduling (`crank/bot.ts` settle loop must post+settle SB markets promptly at expiry); (iii) the §6 hazard — do NOT create a live TRADEABLE SB market until the SB crank exists (Pyth-only off-chain builders can't service it; vaults would only wind down via `reclaim_unsettled`). **Off-chain callers needing SB updates when SB markets go live: `crank/volOracleCrank.ts` (DONE for init), `crank/triggerCrank.ts` (+`.dryrun`), `crank/bot.ts`, plus the new SB create-market FE builder.**

> **2026-06-25 — SWITCHBOARD STAGE 3 READ-ROUTING SURFACE: built, tested, and DEPLOYED DARK to devnet. All 4 oracle-read sites now route by oracle_source; every arm reads 0=Pyth so existing behavior is byte-identical. Stage 3 is UNBLOCKED — no dependency on Jack (ed25519 SDK bug self-packed, committed dormant at e331f94).** Upgrade sig `ndkfaRAT…`, slot `471418448 → 471883039`, on-chain `.so` 1,360,016 B (code hash `0e64bdde…3895a56` == local 115-test build — the definitive proof), ProgramData headroom 73,491 B (no extension), authority `5YRMuuoY…` unchanged.
>
> **(1) The keystone simplification.** Only 4 LIVE oracle-read sites, not 6-7: `get_option_price`/`mint_from_vault`/`fill_vault_peg` read the CACHED `VolOracle.last_spot_price` via `price_american`, NOT Pyth live. `push_vol_sample` is the sole writer of that cache → routing it carries the entire American pricing tree. The 4 routed sites: `exercise_american` (1a-i `65791eb`), `execute_trigger` (1a-ii `b335e0d`), `push_vol_sample` (1a-iii keystone `8406182`), `settle_expiry` (1b `c126589`). HANDOFF baseline is now `c126589` (deployed).
>
> **(2) The decoder = a crate verifier, NOT a hand-rolled offset.** Switchboard ships `QuoteVerifier` (crate `switchboard-on-demand = "=0.13.0"`, features `["anchor"]` = anchor-lang + solana-v2, NEVER `client`) — does discriminator + owner + multi-sig + slothash + freshness internally, returns `OracleQuote` with `feed_id()`/`feed_value(): i128 @ 1e18`. Our empirical `+32` read was correct but the absolute "offset 186" was a ~154-byte program-header artifact (would've been brittle) — retired. Build-smoke proved the crate links +8.9 KB (precompile does ed25519 via instruction introspection, no heavy crypto links) and fits ProgramData. Seam built unwired in unit 1 (`912f886`): three `sb_*` siblings mirroring the Pyth shapes, `secs_to_slots` (5/2=2.5 slots/sec), pinned fixture (`tests/fixtures/sb_quote_message.bin`, XAU 6c3c5cc7… → $4053.90). **Cargo.lock is gitignored — dep changes never show in `git status`; every dep change must be named in the commit body.**
>
> **(3) The trailing-optional pattern (load-bearing for all of Stage 3).** Each routed handler: `price_update` → `Option<Account<PriceUpdateV2>>` (present for Pyth = wire-identical), + 3 trailing `Option<UncheckedAccount>` SB accounts (queue, SlotHashes sysvar, Instructions sysvar). Pyth txs omit the trailing optionals → identical account vector, NO reordering. **REQUIRES `anchor-lang` feature `allow-missing-optionals`** (Cargo.toml:62) — without it anchor 0.32.1 errors `AccountNotEnoughKeys` on an absent trailing optional. Verified ON in the feature-free production build, adds no deps, inert for every shipping instruction (the only trailing optionals in the program are the new SB accounts; `epoch_config`/`price_update` resolve via the sentinel path). The ed25519 ix index is DERIVED ON-CHAIN (`find_ed25519_ix_index` scans the Instructions sysvar) — NEVER an instruction arg (an arg breaks Pyth instruction-data byte-identicality). Errors 6064-6069 (PriceUpdateMissing/SwitchboardAccountsMissing/InvalidOracleSource/NoEd25519Instruction/InvalidSwitchboardSysvar/SwitchboardSettleWindowElapsed).
>
> **(4) The VolOracle padding-claim (1a-iii — NO migration).** `push_vol_sample` has no market account, so `oracle_source` rides on `VolOracle` itself — claimed 1 byte from the existing 11-byte `_padding` (insert after `bump` @ struct offset 5845 / account-absolute 5853; `_padding` 11→10). **Struct stays exactly 5856 B** (`size_of==5856` assertion holds) → no realloc, no migrate instruction, and every legacy oracle reads `oracle_source=0=Pyth` for free. This is the ONLY safe path for a zero-copy account — a size-growing change panics `AccountLoader::load` (bytemuck length mismatch) on every legacy account. Gate proven: a hand-rolled pre-migration VolOracle loads clean, reads Pyth, pushes with the ring intact. New oracles born Pyth via `initialize_vol_oracle`.
>
> **(5) SB settlement = persist-at-expiry (1b — NO schema change).** SB has NO historical archive and SlotHashes retains only ~512 slots (~3.5 min) — so SB CANNOT settle on a historical at-expiry price like Pyth (Hermes archive, 30d window). Instead the SB arm verifies a FRESH quote within `SB_SETTLE_WINDOW_SECS = 300` (5 min) of expiry. `MarketNotExpired` (6006) fires before the match (source-agnostic); the SB window gate is 6069. The SB quote's `recent_slot` is stored in the REPURPOSED `pyth_publish_time` field (slots fit i64) → no `SettlementRecord` schema change. **CONFIRMED: no claim path re-reads the oracle** — `settle_expiry` is the sole settlement oracle read; `settle_vault` copies record→vault, all claims drain from `vault.settlement_price`. Miss-the-window → `reclaim_unsettled` (existing permissionless 7-day hatch, writers-only payout) handles it — extend nothing.
>
> **(6) DEPLOY discipline reconfirmed + a NEW canary lesson.** v3 by-ADDRESS upgrade (`--program-id CtzJ4M… --upgrade-authority 5YRMuuoY…`, NEVER local keypair). ELF Flags MUST be 0x3 (`cargo-build-sbf --arch v3 --tools-version v1.54` feature-free) — a plain `anchor build` v2/0x0 artifact gets REJECTED. Anti-blind-retry paid off: first buffer write failed (RPC throughput, 209 chunks) → verified program unchanged → closed partial buffer (recovered 9.47 SOL) → `--use-rpc` retry → upgraded. **NEW LESSON — the live byte-identical canary is FRAGILE: `vol_used`/`spot_used` match only if NO vol-push lands between baseline and post-deploy. The retry stretched the window 1→13 min past a push tick → canary "differed" (benign coherent ~4-5% market move, +1 sample/oracle) and tripped the literal STOP gate. The REAL guarantee is the on-chain code-hash == local-`.so`-hash equality (independent of oracle state); the canary is a fragile secondary. NEXT DEPLOY: anchor the canary to a no-push window or a frozen oracle snapshot, and treat the hash match as primary.**
>
> **NEXT — Stage 3 1c: create-market-as-Switchboard + generalized HIGH-5 (the thing that makes all the dark routing REACHABLE).** Today `create_market` hardcodes `oracle_source = ORACLE_SOURCE_PYTH` — no market can be born Switchboard. 1c adds: (a) a create path that sets `oracle_source = Switchboard`, (b) generalized HIGH-5 — the create-time feed-existence proof must branch on source (Pyth → existing `PriceUpdateV2` Full-verification at `create_market.rs:60-76`; Switchboard → one `QuoteVerifier` pass asserting a feed with matching `feed_id` exists). Then the SB CRANK POSTING LOOP (5th side-loop, wires the dormant `crank/switchboardQuotePost.ts` + `crank/ed25519SelfPack.ts`, gated `OPTA_SB_CRANK_DISABLED`, dry-run first) + the SELF-INDEXER (mandatory — SB has no historical archive, every signed attestation persisted for settlement). **DEFERRED ITEMS THAT COME DUE AT 1c:** (i) the live `QuoteVerifier` happy-path devnet smoke (litesvm can't fabricate a valid `signed_slothash` — every sub-unit deferred the success-path verify to a real on-chain quote; 1c is where it's finally proven); (ii) the SB-trigger tx-size gate — SB-routed `execute_trigger` is 1200 B with only 32 B margin vs 1232, assuming a ≤2-signature quote (a 3-sig quote +~96 B overflows) → before any SB trigger goes live, confirm the SB feed resolves ≤2 sigs OR move the SB-trigger path to versioned tx + ALT (~500 B recovered); (iii) the SB settle 5-min window crank scheduling (the settle loop must post+settle SB markets promptly at expiry, not lazily — `crank/bot.ts` settle loop). **Off-chain callers needing SB account-list + slot/ed25519 updates when SB goes live: `crank/volOracleCrank.ts`, `crank/triggerCrank.ts` (+`.dryrun`), `crank/bot.ts`.**
>
> **LAUNCH SEQUENCING (revised this session):** Trade-v2 flip is DECOUPLED from Switchboard and DEFERRED to post-ladder. Order: (1) finish Stage 3 (1c + crank + indexer), (2) epoch-vault ladder arc (fills a Deribit-style BTC/ETH/SOL surface, Pyth-sourced), (3) Trade-v2 flip — unified launch on a POPULATED chain (the postable "people are using it" moment). Stage 3's SB routing later enables adding the TradFi surface (gold/equities/FX) to that same ladder as a post-launch expansion.

> **2026-06-24 — PHASE 4 TRIGGER ORDERS COMPLETE: built, deployed, and AUTONOMOUS on the VPS keeper. Production instruction count 39 → 42.** Stop/limit + stop-entry triggers live on devnet, firing real `execute_trigger` txs unattended on the 15s crank loop. Built P0–P2, deployed + smoke-validated P3, margin-tuned P3.4, live on the VPS P3.5. Commits (master+main mirrored at each): **P0 `95a9af5`** (`TriggerOrder` state + `place_trigger`/`cancel_trigger`), **P1 `3495203`** (`vault_peg_fill_core` + `american_exercise_core` extraction + `execute_trigger`), **P2 `6ee01bd`** (keeper loop), **margin-tune `b047a69`** (50bps). On-chain-only pass set; the 50bps commit is the sole code change since.
>
> **(1) Deploy (P3).** opta upgraded **by-ADDRESS** (write-buffer → `deploy --buffer --program-id CtzJ4M… --upgrade-authority 5YRMuuoY`, NEVER the local keypair), **slot `470808425` → `471418448`**, upgrade sig `4Y4qQMRM…`, **feature-free** (LOW-5). Built **v3** (`cargo-build-sbf --arch v3 --tools-version v1.54`) — **P1's plain `anchor build` produced a v2 (Flags 0x0) artifact that would've been REJECTED** upgrading the v3 devnet program; the v3 rebuild was the fix (ELF Flags 0x3). ProgramData **no extension** (new 1.30 MB `.so` fit the existing 1.43 MB). Hook `83EW…fZMAG` unchanged. On-chain IDL auto-upgraded clean (no `RequireGteViolated`; `fetch` == local). **New surface:** `place_trigger`/`cancel_trigger`/`execute_trigger`; errors **6059 `TriggerConditionNotMet`** + **6060 `TriggerSourceAtaInvalid`**; account **`TriggerOrder`** (212 B incl. disc); events `TriggerPlaced`/`TriggerCancelled`/`TriggerExecuted`/`TriggerSkipped`. EUR byte-identical verified on-chain (premium 7000000 1:1); `get_option_price`/`price_american` green on the deployed binary.
>
> **(2) Architecture.** Two vault-counterparty kinds — **StopEntryBuy** (fires `fill_vault_peg`; USDC escrowed at placement = `max_premium × quantity`; unspent refunded at fire) + **TakeProfitSell** (fires `exercise_american`; delegate-burn at fire, ITM-only). **StopLoss deliberately DROPPED** — `exercise_american` reverts OTM, so a stop-loss on a long is mechanically unfireable (the OTM case is exactly the one it's for); true stop-loss needs the book path (deferred). **Underlying-keyed** (Pyth EMA), not contract-keyed. **On-chain re-validation = the security invariant:** `execute_trigger` re-reads a fresh EMA (`pyth_current_spot_usdc`, 60s/200bps — mirrors `exercise_american` byte-for-byte) and re-checks the stored comparator ITSELF; the keeper is only a scheduler. SELL fire-time theft guard re-asserts the stored ATA owner+mint (6060) before the delegate burn; partial-fire fires `min(qty,balance)`, decrements, stays open; zero-balance = clean no-op.
>
> **(3) Two shared cores (byte-identical discipline, like `price_american`).** `vault_peg_fill_core` + `american_exercise_core` extracted, taking authority/USDC-source/mint-dest/burn-source/payout-dest as params so BOTH the original instructions AND `execute_trigger` call them. The **`Option<&AccountInfo>`/`Option<u8>` authority-fork** was kept intentionally (Some = external signer; None/bump = protocol-PDA signs — escrow debit / delegate burn). Proven byte-identical: bankrun 96/96 (incl. regression cases re-running the original peg+exercise), cargo 72/72, + the on-chain EUR-verbatim canary.
>
> **(4) The keeper (P2, `crank/triggerCrank.ts`).** A **fourth crank side-loop**, **15 s fixed cadence** (not hour-aligned), fail-loud + `shouldShutdown` like the vol loop. **Batched Hermes** (ONE `/v2/updates/price/latest?ids[]=…` per tick for deduped feeds — scales to 1 call regardless of trigger count; zero 429s). **BUY budget pre-check** via `get_option_price` simulate + vault spread (skips over-budget buys → no `SlippageExceeded` fee-burn; trigger stays live). **SELL OTM pre-skip.** **50 bps fire-margin** (`TRIGGER_FIRE_MARGIN_BPS`, env-overridable) — tuned from live spot↔EMA data (SOL 5–19 bps calm, ~33 bps move-peak; BTC/ETH tighter; keeper reads SPOT, chain re-checks EMA, margin avoids boundary-6059 sends). Reads **`crank/idl/opta.json`** (the DEPLOYED IDL, not stale `app/src/idl` — keeper tracks the chain; discovery uses the fresh IDL coder, not app-side `safeFetchAll`). `crank/hermesBackoff.ts` = extracted shared AIMD (trigger loop uses it; settle loop still inline — convergence parked).
>
> **(5) VPS state (current — `opta-crank.service`, 3 autonomous loops).** Checkout pulled `f514c2b` → **`b047a69`** (was 48 commits behind; clean ff). **`.env`: `OPTA_TRIGGER_CRANK_DISABLED=0`, `OPTA_TRIGGER_DRY_RUN=0` (LIVE)**; backups `.env.bak2` (dry-run) + `.env.bak3` (pre-live); rollback = `cp .env.bak3 .env && systemctl restart opta-crank`. `OPTA_VOL_CRANK_DISABLED` untouched. The settle loop now also runs the **unconditional `sweep_expired_orders` finalize pass** (rode in on the pull — clean, `sweepOrdersErrors:0`; first suspect if the finalize loop ever wobbles). Loops: settle (slow ticks ~67 s–6.8 min cold-cache, pre-existing), vol (hourly), trigger (15 s, LIVE-firing). **Crank wallet `5sHZ…Gfqa`: 29.26 SOL.** **Empirical per-fire cost ~0.000025 SOL** (~25 k lamports base fee; the `post_update_atomic` ephemeral rent IS reclaimed by `closeUpdateAccounts` — measured clean on the autonomous fire, caller=crank/owner=placer, no rent-refund conflation = Stage-A's deferred isolation). Runway **~36 days** at ~0.8 SOL/day baseline; triggers negligible; no top-up. **Proven autonomous fire (tx `5pRKFTpV…`):** placed → keeper fired in **1 tick (~12 s)**, NO manual step; 1 contract minted, escrow debited peg **$3.48**, **$16.52 refunded**, both PDAs closed, `TriggerExecuted` emitted; `emaUsed $68.81 ≥ threshold $65`, 50 bps margin held.
>
> **(6) Phase 4 open items (non-blocking).** (a) **Orphan-ephemeral reclaim sweep** — a mid-flight fire error could strand ~0.0096 SOL in an unreclaimed `PriceUpdateV2`; a periodic reclaim is a parked crank follow-up (not observed; the real fire reclaimed cleanly). (b) **50 bps margin** held trivially ($3.8 headroom) — watch the first NEAR-THE-MONEY autonomous fires for 6059 churn; bump via env (no redeploy) if they spin. (c) **Settle-loop AIMD convergence** — residual inline duplicate vs `crank/hermesBackoff.ts`. (d) **FE IDL/constants sync** — `app/src/idl` + `constants.ts` still lack trigger symbols (trigger seed consts crank-local) — rides the FE arc / Trade-v2 flip.
>
> **NEXT SESSION — EPOCH-VAULT LADDER ARC (the rolling tenor generator).** The series primitive is LIVE (`create_series` Pass A + `fill_vault_peg` Pass B); what's missing is the thing that DRIVES it on a schedule — a generator that calls `create_series` (+ creates the backing American vault) on weekly/monthly/quarterly boundaries, re-centers + rolls them into a Deribit-style chain. ("Series minting for epoch vaults" = this arc.) **Three open decisions to settle at session start:** (1) **crank loop vs admin script** — a 4th side-loop is lean, BUT `create_series` + vault creation costs real SOL rent PER CELL (unlike near-free triggers) → crank-wallet runway math changes materially; **ground-truth the per-cell SOL cost first**; (2) **strike-ladder rule per tenor** (biggest unspecified piece) — strike count + spacing, re-centered on spot each period — proposed default **ATM ± 3 strikes at round-number spacing**; (3) **assets + tenor depth** — proposed default **BTC/ETH/SOL only** (warm Pyth crypto; TradFi waits on Switchboard), **front+next weekly + front monthly + front quarterly** (all ≤90 d → all vault-auto-priced) ≈ **84 series**. Ladder size = assets × tenors × strikes, each cell = 1 series + 1 vault (real SOL each) → scope needs explicit bounds; the **≤90 d auto-price gate caps tenor depth** (no yearlies v1). Vaults = ask-only pegged orders at BS-2002+spread, mint-on-fill, one book; American-only by `create_series` design (D12). **First step:** read-only scope of `create_series` + vault-creation + the crank loop structure + the crank-wallet SOL reality → generator spec + rulings → build prompts.
>
> **STILL BLOCKED ON JACK (unchanged):** Switchboard Stage 3 (authoritative quote-account layout); the Trade-v2 flip stays coupled to Switchboard for the unified launch.

> **2026-06-23 — Trade v2 American-pricing bug FIXED + committed; Switchboard gold proof-of-life PROVEN IN SIM on the QUOTE-program path (BLOCKED on Jack).** **(a) Trade v2 fix (commit `dbfa62e`, master+main, behind `TRADE_V2_UI`).** The v2 Trade pricing/RFQ path conflated two independent axes — it keyed on `provenance==="series"` (axis 2) and assumed legacy⟹European, so legacy-AMERICAN vaults showed "EUR — model price only" and never fired the on-chain `get_option_price` quote, while the header still badged AMERICAN. Fix = gate **pricing** on `exerciseStyle==="american"` (axis 1), leave **routing** on provenance (legacy→classic vault flow, correct). Gate-swapped the three pricing surfaces (RFQ gate, MARK·MODEL, payoff/breakeven) in `ContractDetailModal.tsx` + `OrderTicket.tsx`; MARK·MODEL + payoff now style-aware (American → on-chain quote or "—" when the vol oracle is cold; never the structurally-low EUR number). Greeks untouched (European approximation, accepted). Safe pre-flip: `get_option_price` is a read-only view with NO `AMERICAN_ENABLED` gate (accounts are only market+vol_oracle — it can't even read the flag; 6052 lives only on create/mint/exercise/fill). `npm run build` green; eyeball-confirmed live on a legacy-American SOL contract (oracle spot $72.63). **(b) Switchboard gold proof-of-life — PROVEN IN SIM, on the QUOTE program (`orac1e…`), NOT the classic feed.** Devnet finding: the classic **secp PullFeed update path is DEAD on devnet** — oracles return `ORACLE_UNAVAILABLE` for secp/V1 but sign 2 responses for **ED25519/V2** (same oracles, same run). `FqwdpnDr…` is a classic PullFeed whose feedHash we repointed `0x91eb28…`→**`0x6c3c5c…`** (computeOracleFeedId of the corrected 5%-range / 2-of-2 config; Stage-1a crossbar `/v2/store` + Stage-1b on-chain `setConfigsIx` both verified) — but it is a **DEAD END for landing data**: classic secp `pullFeedSubmitResponseConsensus` can't credit a computeOracleFeedId-keyed feed (ChecksumMismatch 6056), and the ED25519/new-scheme path writes to a SEPARATE quote-program account, never a classic PullFeed. **Real target = the quote PDA `AADETRuB…` = `OracleQuote.getCanonicalPubkey(queue, [0x6c3c5c…], orac1e…)`** (seeds: queue+feed_id). **Production fetch path = `queue.fetchManagedUpdateIxs([feed], {numSignatures:2})`** (V2 feed-inline, ED25519) — NOT classic secp / `fetchUpdateIx` (the SDK pins that to a deprecated crossbar `/fetch` 400 + tags the wrong hash). Sim proves the full round trip: it creates+writes `AADETRuB…` (1064B, owned by `orac1e…`), manual decode shows our feed_id at **offset 186** with the live gold price (~$4,180, i128 LE / 1e18). **BLOCKED on Jack (message sent, awaiting reply):** (1) confirm the quote-program account is the intended devnet target; (2) authoritative **Rust struct for the 1064-byte quote-account layout** (our offset-186 read is EMPIRICAL — must NOT be hard-coded into settlement); (3) ed25519 fetch flakiness (~1 in 2: `InstructionError[1,Custom:2]` at the ed25519 ix — the gateway non-determinism Jack mentioned). **Next session:** if Jack confirms + sends the layout → one real send to land proof-of-life on the quote account, then write Stage 3 prompts (oracle routing dispatch, SB crank, generalized HIGH-5, self-indexer) against the CONFIRMED target. **Corrected scoping fact:** the gold feed hash is now `0x6c3c5c…` (not `0x91eb28…`), but the integration keys off the quote PDA / feed_id, NOT `FqwdpnDr…`; the Stage-1a/1b crossbar+repoint work on `FqwdpnDr…` validated config mechanics but is MOOT for the update path. Off-repo scratch + sim repros: `/home/nanko/sb-pilot-scratch/` (WSL) + `.opta-build/*.mjs` (Windows, gitignored). **(c)** Series tenor-ladder convergence design note appended under "Series tenor ladder — future" in `.context/plans/switchboard-integration-scoping.md` (gitignored, local).
>
> **2026-06-22 — TRADE V2 PAGE BUILD COMPLETE (Passes 0–13). Committed, behind `TRADE_V2_UI = false`. NOT yet flipped.** Full Deribit-style v2 Trade page built across 11 commits: P0 `be0eadb` (IDL sync — 4 ix + 3 errors + OrderKind::VaultPeg + oracle_source + VaultReclaimed; read hooks useBook/useSeries/useUnifiedChain + exchangeData.ts; seed script) → P1 `a1dda1f` (grid on the book, series+legacy provenance) → P2 `b104ab2` (order ticket + write-path routing; peg/post_order live) → P3 `c64ee66` (Pro contract chart — later removed) → P4 `92bbd34` (RFQ quote-on-demand, manual simulate @400K CU, NOT `.view()`) → P5 `a4b0be7` (persona toggle Pro/Simple; Simple perps/meme mode w/ TradingView widget) → P6 `5aab44a` (contract detail modal — payoff diagram, full greeks, order-book ladder, position row) → P7 `d8795ea` (pre-flip polish + modal Call/Put toggle; `vercel.json` CSP held OUT of commit) → P8 `4f52786` (unified OrderTicket + OrderBookLadder + AssetDropdown + chart-page terminal) → P9 `9c4f24e` (Pro chart marker crash fix + modal book rebalance) → **P12–13 `a337dc6`** (chart pivot + layout fix). `master` + `main` mirrored at `a337dc6`.
>
> **The chart saga + pivot (the hard part).** Pro CHART page's lightweight-charts repeatedly crashed then rendered blank (CC can't see a browser → 3 blind fixes failed). **DECISION (locked): pivot the Pro underlying chart to the SAME TradingView Advanced Real-Time Chart widget Simple uses** (proven, auto-sizes, brings indicators). Pro CONTRACT mode → a "Recent trades" fills readout (price/size/time from the OrderFilled tape) instead of a candle chart — devnet tape is sparse, and neither lightweight-charts (render-fragile) nor the TradingView widget (no symbol for an on-chain option price) can chart the contract honestly. **`lightweight-charts` removed from the chart page** (173 kB chunk gone; dep still in package.json, unused — lockfile cleanup parked). **This also closes the parked "lightweight-charts vs widget" decision (Hasan) — resolved in favor of the widget.** Strike/BE/spot shown as text near the chart (iframe can't draw overlay lines). Layout: `items-stretch` two-column band (chart + ticket tops/bottoms flush, order book below) — same applied to Simple. Eyeballed live: both render. Spec T3 updated. Canonical spec: `.context/plans/trade-page-spec.md` (gitignored).
>
> **THE FLIP — not done; this is the immediate next action whenever ready (3 steps, IN ORDER):** (1) push the **uncommitted `vercel.json` CSP** to a Vercel PREVIEW branch first → verify live V1 still connects (wallet/RPC/Pyth) + TradingView loads — the CSP is a GLOBAL header so it hits production immediately (made permissive: https:/wss: wildcards + unsafe-inline/eval). (2) Set **`VITE_RPC_URL` = Helius devnet** in Vercel production env (Settings → Environment Variables; hooks read `import.meta.env.VITE_RPC_URL || clusterApiUrl("devnet")`; public devnet can't sustain book scans / RFQ simulates). (3) Flip **`TRADE_V2_UI = true`** (`app/src/utils/constants.ts`) + commit `constants.ts` + `vercel.json` + push → production serves v2. **Order: CSP-preview → env → flip.**
>
> **Devnet seeded test series (for v2 eyeballing):** SOL CALL $75 American, expiry 2026-07-31, mint `9cnVqQrm`, vault `FqYC97En`, $1000 collateral, ~7 OrderFilled fills (~$5.85), book bid $4.5651 undercutting a vault-peg ask. Re-seed: `scripts/seed-trade-series-devnet.ts`.
>
> **Parked (non-blocking, await user feedback):** the UNDERLYING/CONTRACT toggle framing — option to drop the toggle and move the fills table to a tape panel below the order book. Revisit after real user feedback.
>
> **DO NOT TOUCH:** `App.tsx`, `AppNav.tsx`, `pages/seeker/*` are uncommitted local Seeker-app work (separate arc — a mobile Seeker shell shown building-in-public). Leave untouched, don't stage, don't revert. May show a stray Seeker nav item in local dev — ignore.
>
> **Switchboard Stage 3 — UNBLOCKED (Jack responded).** Devnet oracles now available (were fleet-wide `ORACLE_UNAVAILABLE`). Next session = complete Switchboard Stage 3: wire oracle routing dispatch (`price_oracle.rs` is currently unconditional Pyth; `oracle_source: u8` field is live on `OptionsMarket` at offset 62 but INERT) + SB crank builder + generalized HIGH-5 gate + mandatory self-indexer (Switchboard has no historical archive — settlement must catch the live window + persist signed attestations). This lights up **equity + commodity** feeds (the "options on any asset" wedge). Gold pilot feed live: `FqwdpnDr…`. **Flip decision deferred until after Switchboard** — flip + Switchboard land together, then reassess.
>
> **After flip + Switchboard, what remains:** frontend polish + visual accuracy (incl. the contract-toggle feedback item), audit completion (~42 MED/LOW/INFO open; all CRITs + HIGHs done), Vercel/PostHog analytics tracker, gamified market-making bot sim (devnet UA campaign). Pre-mainnet must-fix: atomic 3-tx write flow (partial flow strands collateral). Parked: burn-expired-positions button, V2 vault resale marketplace (3 new Rust instructions). The big architectural builds are essentially done — what's left is hardening, instrumentation, and user acquisition.

> **2026-06-18 — STAGE-I DONE. Phase 2 fully shipped; AMERICAN OPTIONS ARE LIVE ON DEVNET.** This is the canonical seed context for the next session — read this whole note.
>
> **(1) The flip.** Matched pair-flip: `AMERICAN_ENABLED` `false`→`true` (`programs/opta/src/feature_flags.rs`) + `AMERICAN_ENABLED_UI` `false`→`true` (`app/src/utils/constants.ts`). Rust built **feature-free** (LOW-5 guard) as an **SBPFv3** artifact (ELF **e_flags 0x3**, `--arch v3 --tools-version v1.54`); deployed **in-place** → program ID + hook unchanged, **slot `470150095` → `470304536`**, upgrade sig `3TQpK7r8…`, authority `5YRMuuoY…`, ~16.25 SOL after (no stranded buffer). Canaries green (`scripts/smoke-stage-i-flip.ts`): **6052 gate now OPEN** (American create simulates to success) + **EUR byte-identical** (premium stored 1:1). FE `AMERICAN_ENABLED_UI = true` live on Vercel. **Flip commit `97ad1fb`.**
>
> **(2) Toolchain resolution + NEW DEPLOY PROCEDURE (critical — future deploys depend on this).** Devnet runs **Agave 4.1-beta**, which requires SBPFv3 binaries. Deploying needed BOTH: a **v3-emitting build toolchain** (`cargo install cargo-build-sbf --version 4.1.0` → invoke `~/.cargo/bin/cargo-build-sbf … --install-only --tools-version v1.54 --force-tools-install`, then `--arch v3 --tools-version v1.54`) AND a **v3-capable deploy CLI** (`agave-install init 4.1.0-rc.1`). The old `solana-cli 2.2.14` rejected the v3 binary **locally, pre-flight** (`Detected sbpf_version … not enabled`) — that was the real blocker, NOT the cluster. **The active `solana` CLI is now `4.1.0-rc.1` (was 2.2.14) — do NOT revert it** (reverting re-breaks deploys). Deploy with: `solana program deploy target/deploy/opta.so --program-id CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq --upgrade-authority <5YRMuuoY id.json> --url "$(cat ~/.opta-rpc-helius)" --use-rpc` on the 4.x CLI. **NEVER `anchor deploy`** — a prior `cargo clean` regenerated `target/deploy/opta-keypair.json` to the WRONG address (`Fw9fbLyG…`), so `anchor deploy` would create a new program instead of upgrading. Full saga + corrected root cause: committed **`OPTA_DEVNET_DEPLOY_BLOCKER.md`** (status RESOLVED).
>
> **(3) American write FE fix (today, commit `7ef6fdf`).** First live American write failed with **Anchor error 2006 (ConstraintSeeds)** — the frontend derived the vault PDA with the **European** seed (`b"shared_vault"`) for an American vault. Fixed in `app/src/hooks/useAccounts.ts` (+ `app/src/pages/write/useWriteSubmit.ts`): PDA derivation now **branches on `exercise_style`** → American uses `b"shared_vault_american"` (seeds: `["shared_vault_american", market, strike_price(8 LE), expiry(8 LE), option_type(1)]`). American writes now work end-to-end.
>
> **(4) Verified working LIVE on devnet:** European write end-to-end (create→deposit→mint, Solscan-confirmed); American write end-to-end (after the `7ef6fdf` seed fix); on-chain American pricing renders in the UI (**on-chain realized-vol IV + BS-2002 premium** via `get_option_price`). Read-only surface re-verified (`scripts/verify-stage-i-readonly.ts`): BTC/ETH/SOL American CALL+PUT quotes return sensible ATM premiums, no 6052.
>
> **(5) Open / next-session items:** **(a)** sanity-check vol inputs — American **on-chain IV ~41.6%** (realized-vol oracle) vs European **baseline IV ~64.7%** (off-chain pricer) is a wide gap worth verifying (which is right, and should they reconcile?). **(b)** §10 post-flip canaries still OPEN: runtime peg canary (`fill_vault_peg`), book×series live proof, the two peg-aware collateral-gate live-verifies (Pass C), crank wallet top-up, pre/post vault re-enumeration. **(c)** FE bundled IDL (`app/src/idl/*`) is still **Stage-H** — missing the newer instructions + errors **6056/6057/6058** (cosmetic; American write/quote/exercise work without it; sync when convenient). **(d)** recheck `npm run test:bankrun` builds/runs under the new **4.x toolchain**. **(e)** per-asset warmup — metals (~days) + equities (US-market-hours gated) light up as each crosses 168 samples; BTC/ETH/SOL already warm. **(f)** Switchboard 24/7 TradFi-feed arc (scoped, post-launch — see `.context/plans/switchboard-integration-scoping.md`). Crank/VPS untouched this session.
>
> Updated 2026-06-09 after the **Stage-I remediation session**. Phase 2 Stages A–H are all shipped (A–G on devnet, H to Vercel, dark-launched behind `AMERICAN_ENABLED_UI = false`). This session: **revived the vol-push crank** (it was gated off for cost during Stage H, not down — §5); ran a **full American-surface audit** (3 phases — money-conservation, pricing/oracle, flag/secondary/griefing/FE) → **0 CRIT / 0 HIGH**, money-conservation invariant proven; and shipped **four remediations** to devnet + `master`/`main`: **MED-2** (vol gap-reseed guard on `push_vol_sample`), **LOW-5** (fail-closed `testing`-marker deploy guard — production builds MUST be feature-free), **`reset_vol_oracle`** (new admin instruction; production count +1), and **MED-1** (American settlement per-contract cap, mirroring early exercise). **11 gap-polluted vol-oracles were reset** → a clean 7-day warmup completing **~2026-06-16**. opta redeployed twice this session → slot **`468290108`** (hook unchanged `464160129`); `master`+`main` at **`5b2cbf8`**. European byte-identical throughout; **`AMERICAN_ENABLED` still `false`**. **The ONLY remaining Stage-I work is the `AMERICAN_ENABLED` flag flip, after the warmup (~Jun 16).**

> **2026-06-10 — Exchange Phase 1 (limit order book) BUILT + DEPLOYED to devnet (slot `468668989`).** Custom-minimal `RestingOrder` book — `post_order` / `fill_order` / `cancel_order` / `sweep_expired_orders` — generalizing the V2 resale flow and reusing the hook-token escrow pattern verbatim. Additive only (one new error 6054, 4 tape events, no existing-handler logic touched); European/American byte-identical. Gates: bankrun **53/0** (14 new), validator untouched **101/0/68**, FE build green, feature-free IDL byte-identical. Deployed feature-free (program ID + hook unchanged); **production on-chain instruction count now 33**. Post-deploy verified: 6052 gate live, EUR premium-verbatim, full book smoke (`scripts/smoke-book-devnet.ts`) all-pass. `AMERICAN_ENABLED` still false; FE resale→book migration is a later arc. Canonical spec: `.context/plans/opta-exchange-spec.md`. Code commits `0d394a1` `54acb62` `68a556c` `c2a124f` on `master`+`main`.
>
> **2026-06-12 — Phase 2 Pass A DEPLOYED to devnet (slot `468771120`) + migrated + `main` mirror RESTORED.** `create_series` (ONE Token-2022 mint per spec — spec-only seeds, D5; American-only, D12; sentineled `VaultMint` series record so the Phase 1 book needs zero changes) + `migrate_shared_vault_exchange_fields` (SharedVault append `spread_bps` u16 + `voided` bool, 257→260). Program live **feature-free** (program ID + hook unchanged); **62/62 SharedVaults migrated 257→260** (`spread_bps=0`/`voided=false`; batch sigs in §5); on-chain instruction count now **35**. Verified: 6052 gate live, EUR premium-verbatim (= deser-window-closed proof), `create_series` smoke + negatives (dup-revert, European→6055) all-pass via `scripts/smoke-pass-a-devnet.ts`; **book×series deferred** (the series's American vault can't be created while `AMERICAN_ENABLED=false` — bankrun series-create test 4 proves the interop). `safeFetchAll` **48→48 (zero migration drops)** — the migration restored those 48 under the new IDL; **14 chronic corrupt-at-`is_settled` vaults** are pre-existing devnet cruft (byte 178, untouched by the migration), dropped by `safeFetchAll` before and after. **`main` mirror RESTORED** (master+main at the new HEAD; Vercel auto-deploys, expected green). **Deploy hiccup (resolved):** the on-chain IDL *account* was 116 bytes too small for the grown IDL (`IdlSetBuffer`→`RequireGteViolated`, 21314<21430) — program deployed fine, but the IDL-account step failed; fixed via `anchor idl close` + `anchor idl init`, on-chain IDL `fetch` verified **== local** (sorted). One stranded IDL buffer from the failed step remains (small SOL; address not captured — minor follow-up). Helius was flaky all session (one connection reset, repeated gPA timeouts) — bounded retries throughout, every RPC output redacted. `AMERICAN_ENABLED` still false; Pass A dark until Pass B + the Stage-I flip. Commits `83fec3b` `4b6ad06` `c236611` `a74645f` + this session's docs/smoke commit. Spec: `.context/plans/opta-exchange-spec.md` §7.
>
> **2026-06-12 — Phase 2 Pass B `fill_vault_peg` BUILT (commit `3a908dd`) + DEPLOYED dark to devnet (slot `468926799`).** The mint-on-fill vault peg: a taker fills against an American series' shared vault at a price computed AT FILL TIME (BS-2002 via the shared `price_american` helper + `vault.spread_bps`), contracts mint-on-fill from pooled collateral; premium stays pool-share-proportional (D7). **Additive only** — one new instruction, one new error (`VaultVoided` 6056), reuses the `OrderFilled` tape (`OrderKind::VaultPeg = 3` appended); `mint_from_vault` + all settlement untouched, European byte-identical. **NO schema delta** (Pass A already appended `spread_bps`/`voided`) → **no migration, no deser window, VPS untouched**. Upgrade tx `3JweX26D…`, ProgramData auto-extended **1306592 → 1324656**; **IDL auto-upgraded cleanly during `anchor deploy` — the Pass A `RequireGteViolated` did NOT recur, no `close`/`init` needed this time** (on-chain IDL `fetch` == local, sorted-key diff identical). Program ID + hook unchanged; deployed **feature-free** (LOW-5 guard). Gates: Rust unit **63/0** (+7), bankrun **65/0** (+6 peg, exchange-book **14/0** unchanged), feature-free IDL has 0 test instructions. Post-deploy canaries all ✓: **6052 gate** (American `create_shared_vault` reverts `AmericanVaultsDisabled`), **EUR premium-verbatim**, full **book smoke** (`scripts/smoke-book-devnet.ts` — all assertions pass, 5 touched handlers behaviorally unchanged), **on-chain IDL contains `fill_vault_peg`**. The runtime peg canary (a priced fill) is **unconstructable while dark** — `create_shared_vault` American is itself flag-gated, so no peg target can exist feature-free; it's a post-flip checklist item (§10). `AMERICAN_ENABLED` still false; Pass B inert until the Stage-I flip (~Jun 16). **FE IDL drift:** `app/src/idl/*` deliberately NOT synced with `fill_vault_peg` — rides the FE arc, same precedent as Stage A→H. Commit `3a908dd` on `master`+`main` + this session's docs commit. Spec: `.context/plans/opta-exchange-spec.md` §7.3.2.
>
> **2026-06-12 — Phase 2 Pass C BUILT (commit `dc86c76`) + DEPLOYED dark to devnet (slot `468946122`).** The write-flow collapse (§7.6, D8/D9). **`create_and_deposit`** — the atomic write merge: fuses `create_shared_vault` + `deposit_to_vault` into ONE tx via `init_if_needed` (first caller creates+deposits, subsequent caller just deposits; `created_at == 0` fresh sentinel; identity/config fields set on fresh ONLY, never rewritten). **The heavy mint left the write path entirely** (D9 — minting is mint-on-fill now), so it carries no Token-2022 mint + no BS-2002 → the partial-flow stranded-collateral hazard **dies structurally**. PLUS **two peg-aware American-only collateral gates** that Pass B's peg made necessary (flip-blocker-class money bugs): `mint_from_vault` gains a vault-level free gate closing the peg→direct-mint over-commit race; `withdraw_from_vault` gains a DUAL gate (per-writer AND vault-level) so an LP can't withdraw collateral the peg sold contracts against. Both reuse Pass B's `vault_free_collateral` (single source of truth); EUR arms add zero computation → **byte-identical**. **Errors reused** (`InsufficientVaultCollateral` / `CollateralCommitted`) — **no 6057 taken**. Additive (`create_shared_vault` + `deposit_to_vault` stay live, D-ruling). **NO schema delta → no migration, no deser window, VPS untouched.** Upgrade tx `4GfFFS5T…`, ProgramData auto-extended **1324656 → 1393752**; **IDL auto-upgraded cleanly during `anchor deploy`** (no `close`/`init`; `fetch` == local sorted). Program ID + hook unchanged; **feature-free** (LOW-5). Gates: Rust **63/0**, bankrun **70/0** (+5 Pass C, exchange-book **14/0** unchanged). Canaries 6–10 all ✓ (`scripts/smoke-pass-c-devnet.ts`): 6052 on American `create_and_deposit` (`create_and_deposit.rs:69`), EUR fresh + existing-path (created_at/creator unchanged on-chain), EUR mint premium-verbatim (a2-touched handler), EUR withdraw regression (a-touched handler), on-chain IDL has `create_and_deposit`. The two American gates can't be exercised live while dark (no American vault/peg feature-free) — bankrun-proven (tests 4–5), live-verify rides the Stage-I flip (§10). `AMERICAN_ENABLED` still false. **FE IDL drift:** `app/src/idl/*` deliberately NOT synced — FE write-collapse + Portfolio withdraw button ride the FE arc post-flip. Commit `dc86c76` on `master`+`main` + this session's docs commit. Spec: §7.3.3 / §7.6.
>
> **2026-06-15 — Phase 2 Exchange Pass D (reclaim_unsettled + voided gating) BUILT + DEPLOYED dark to devnet (slot `469592830`).** The dead-feed safety hatch. **`reclaim_unsettled`** — universal (NOT `exercise_style`-gated; serves EUR + AMER), permissionless per-writer wind-down for a vault whose Pyth feed dies pre-settlement: pays each `WriterPosition` pro-rata via `withdraw_post_settlement`'s formula (vault-PDA signer), seeds `collateral_remaining = total_collateral − early_exercise_payout` (Stage-G F→G expression, verbatim) and sets `voided = true` on the FIRST call; **never sets `is_settled`, never writes a `SettlementRecord`** (audit centerpiece — a zero-price record would let PUT holders drain `strike − 0`). Preconditions: `SettlementRecord` non-existence (seeds-pinned `UncheckedAccount`, handler asserts `data_is_empty()`) + 7-day grace (`GRACE_WINDOW = 604_800`) + premium-claimed-first (reuses `ClaimPremiumFirst`). Per-writer idempotency = zeroed shares (not account-close) → 2nd writer not blocked, double-claim hits the zero-shares guard. Plus **voided gating** — `require!(!vault.voided, VaultVoided)` (6056) on four handlers: `settle_vault` + `withdraw_from_vault` (after `is_settled`, reachable) and `exercise_from_vault` + `auto_finalize_holders` (BEFORE `is_settled` so 6056 is reachable — a voided vault is always `is_settled=false`). New errors `SettlementRecordExists` (6057) + `GracePeriodNotElapsed` (6058); new `VaultReclaimed` event. **Additive, NO schema delta → no migration, no deser window, VPS/crank untouched.** Upgrade tx `3wsmZdDf…`, ProgramData 1393752 → 1413576; **IDL auto-upgraded cleanly** (Pass B/C path, no close/init; `fetch` == local). Program ID + hook unchanged (`464160129`); **feature-free** (LOW-5). **Production on-chain instruction count now 38.** Gates: cargo **63/0**, bankrun **80/0** (reclaim 10/10, incl. a EUR dead-feed happy-path), validator **100 pass / 0 real failures**. Canaries: 6052 gate live, EUR premium-verbatim (proves the 4 guards are EUR no-ops), on-chain IDL has `reclaim_unsettled` + 6057/6058. **Runtime reclaim canary DEFERRED** (needs a dead-feed vault + 7d grace — post-flip). European byte-identical. `AMERICAN_ENABLED` still false. Commit `71b4373` on `master`+`main`. Spec: `.context/plans/opta-exchange-spec.md` §7.3–§7.6.
>
> **2026-06-15 — Flip trigger REVISED + warmup reality check.** The old "~Jun 16, all 11 reset oracles ≥168" trigger was structurally wrong: equities push only during US market hours (weekend-gated, ~6.5 samples/trading-day), so AAPL/MSFT/MSTR/TSLA (~20 samples) are **~4–5 weeks** from 168 and will never warm on the crypto clock. **Warmup is enforced per-asset on-chain at mint time** (`realized_vol_annualized` → `VolOracleWarmup` until that asset crosses 168), so flipping `AMERICAN_ENABLED` just opens the surface — each asset self-gates. **New flip trigger (Nanko, 2026-06-15): BTC + ETH + SOL each ≥168** (+ optionally a warm commodity — UKOIL already 230). Crypto majors cross ~30–34h out → **realistic flip ~Jun 17 early UTC**. Metals (~3d) + equities (weeks, market-hours gated) light up per-asset post-flip; they do NOT block the flip. Warmup snapshot (2026-06-15): UKOIL 230 ✅ · XRP 138 · SOL 138 · BTC 137 · FARTCOIN 135 · ETH 134 · XAG 89 · XAU 88 · equities 20–75 (weekend-gated). Crank **10.42 SOL** (~13d runway), `opta-crank.service` active (PID 1151560), vol-loop LIVE.
>
> **2026-06-15 — Switchboard oracle arc SCOPED (call held w/ Jack @ Switchboard).** The 24/7 TradFi-feed wedge for the "options on any asset" thesis + a devnet UA campaign. **Call outcome:** devnet real-time feeds AVAILABLE; 24/7 equity/commodity/FX/ETF feeds YES via a verified-API attestation model (Switchboard verifiably publishes whatever a public endpoint returns; off-hours price = source-defined, e.g. last close); **NO historical feed** (current-price-at-request only) → Opta must self-index the attested updates for historical settlement; cost a fraction of a cent per request. **Model:** Switchboard = verifiable attestation layer; Opta picks the source per asset (source quality = settlement quality). **Coexist, not rip-and-replace** — Pyth stays for crypto (American crypto flips ~Jun 17 on Pyth, independent), Switchboard backs TradFi. **Changes:** crank spot source, `settle_expiry` read, spot reads in `get_option_price`/`exercise_american`, the HIGH-5 proof-of-existence gate, + an `oracle-source` flag on `OptionsMarket`. **Unchanged:** the vol ring buffer + `realized_vol` + BS-2002 are oracle-agnostic. **Key consequence:** no historical fallback → the crank MUST hit the settlement window at every expiry for Switchboard assets; self-index the SWITCHBOARD-ATTESTED (signed) updates as the missed-window + audit backstop. **UA campaign:** sim market-maker bots write options, users trade on devnet; phase crypto-first (Pyth, now) + TradFi-second (Switchboard devnet); provision feeds NOW (lead time), don't serialize behind exchange completion; devnet/sim = top-of-funnel, not PMF (instrument devnet→mainnet retention). **Post-Stage-I arc — does NOT block the Jun 17 crypto flip.** Full scoping: `.context/plans/switchboard-integration-scoping.md`.
>
> **2026-06-21 — Switchboard Stage 1 + Stage 2 DEPLOYED to devnet (slot `470808425`).** First on-chain step of the Switchboard arc; folds in the held Stage 1 refactor. **Stage 1 (commit `ccacf10`, was held for this deploy):** extracted a source-routed price-read abstraction `utils/price_oracle.rs` wrapping the three Pyth spot-read seams (`settle_expiry`, `exercise_american`, `push_vol_sample`) + `sb_value_to_usdc`/`sb_value_to_scale` bridge fns (dead code until Stage 3). Pure refactor — error codes, gate order, EMA-vs-spot, USDC/SCALE normalization byte-identical; single unconditional Pyth path, NO routing. **Stage 2 (commit `081030e`):** `OptionsMarket` gains a trailing **`oracle_source: u8`** (0=Pyth, 1=Switchboard) appended after `bump` (**62→63 bytes**), reusing the 32-byte `pyth_feed_id` as the oracle id for BOTH sources; `create_market` defaults it to Pyth (**HIGH-5 gate untouched**); new admin-only **`migrate_market_oracle_source`** (modeled on `migrate_shared_vault_carry_rate`; idempotent; `len>=63` skip; BATCH_SIZE 20) grows legacy markets. **ZERO routing logic — `price_oracle.rs` stays unconditionally Pyth; the field is INERT until Stage 3.** **Production on-chain instruction count now 39** (+1). **Deploy saga (keep this):** `solana program deploy --program-id target/deploy/opta-keypair.json` minted a NEW throwaway program (`6ajEareb…`) because that local keypair's pubkey is NOT the live ID — **upgrades MUST pass the program ADDRESS** (`solana program deploy --buffer <BUF> --program-id CtzJ4M… --upgrade-authority <5YRMuuoY id.json>`; an upgrade needs only the authority, not the program keypair). The accidental program was closed (8.97 SOL reclaimed). Two transient-Helius `write transactions failed` (150, then 37) each orphaned a ~9-SOL buffer (**both reclaimed via `solana program close`** after verifying the program slot was unchanged — Pass-A precedent); the resilient path that worked = **`solana program write-buffer` to a SELF-CONTROLLED keypair** (resumable, no orphan; `--max-sign-attempts 1000 --with-compute-unit-price 100000`) then `deploy --buffer` against the address. Upgrade tx `62ByYBc2…`; program ID + hook unchanged; **feature-free** (LOW-5; `AMERICAN_ENABLED=true` in BOTH cfg arms, Stage-I preserved). **Migration fired immediately post-deploy** (single tx `5Pd6LgV5…`, deser window one-tx wide) — **16/16 current markets migrated 62→63B, oracle_source=0** (AAPL BTC CRCL ETH FARTCOIN MSFT MSTR NVDA SOL TSLA UKOILSPOT USDPKR USOILSPOT XAG XAU XRP); idempotency re-run `migrated=0 skipped=16`; the **433 pre-Stage-2 per-variation orphans** (87/88/68B, same discriminator) intentionally untouched (unreachable on-chain — every typed-load site resolves a market by asset_name → one of the 16; `len>=63` auto-skips). On-chain IDL upgraded cleanly (no `RequireGteViolated`). Gates: cargo **69/0**, bankrun **80/0**, validator **101/0/68**; canaries 6052 American gate live + EUR premium-verbatim. Committed migration runner `scripts/migrate-market-oracle-source.ts`. `master`+`main` at **`081030e`**. **Stage 3 (Switchboard read arm + routing dispatch) HELD** pending the live-oracle signed-update proof — blocked on Switchboard devnet oracle availability (gateway returns `ORACLE_UNAVAILABLE` fleet-wide on `fetch_signatures_consensus`; pending Jack). Off-chain pilot validated: gold (XAU via PAXG: Binance+Coinbase median) feedHash `0x91eb28…adb6`, on-chain pull feed `FqwdpnDr…` live, off-chain resolve works; permissionless on-chain posting blocked only by oracle availability. Scoping: `.context/plans/switchboard-integration-scoping.md`. **Next session: the exchange Trade page (#2)** — Stage 3 stays parked until Switchboard devnet oracles are live (pending Jack).
>
> **Stage H CU gotcha (worth keeping):** `get_option_price` via Anchor's `.view()` hits the **200K CU simulation ceiling** on the American **PUT** branch (full McDonald-Schroder BS-2002, ~270–280K CU). The American **CALL at carry=0** slips under because it takes the q=0 fast path (~30K CU, returns European exactly — a zero-dividend American call is never optimally early-exercised); a carry≠0 CALL (equities) would also exceed 200K. Fix (the locked decision-4 fallback): `fetchOptionPriceQuote` uses a **manual `simulate` + `ComputeBudgetProgram.setComputeUnitLimit(400_000)` + return-data decode**, not `.view()`. 400K covers the ~278K PUT worst case and future carry≠0 CALLs. Caught at the Stage H live eyeball (the Gate-B `.view()` proof only exercised a CALL).

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
- **Latest commits (2026-06-15 — Phase 2 Pass D DEPLOYED dark; `master`+`main` both at `71b4373`):**
  - *(this docs(handoff) commit — see `git log` for its hash; pushed `master` THEN `master:main`)*
  - `71b4373` feat(exchange): Pass D — reclaim_unsettled dead-feed hatch + voided gating
- **Latest commits (2026-06-12 — Phase 2 Pass A DEPLOYED + migrated; `main` mirror RESTORED):**
  - *(this docs(handoff) + smoke-script commit — see `git log` for its hash; pushed `master` THEN `master:main`)*
  - `e5ccdf2` docs(handoff): Pass A built — create_series + migration, undeployed (2026-06-11)
  - `a74645f` test(bankrun): series-create suite + schema lockstep
  - `c236611` feat(frontend): Pass A IDL + series seed layout mirror
  - `4b6ad06` feat(series): Pass A — canonical series mint + exchange-fields migration
  - `83fec3b` test(validator): fix deposit→mint confirmation race in shared-vaults §9
  - **`main` mirror RESTORED this session** — both refs at the new HEAD after deploy + migration + canaries; Vercel auto-deploys (additive FE; IDL consistent with the migrated chain).
- **Latest commits (2026-06-10 — exchange Phase 1 book BUILT, undeployed):**
  - *(docs(handoff) refresh — see `git log` for its hash)*
  - `c2a124f` test(bankrun): exchange-book suite — 14 tests; escrow invariants, bid fills, sweep zero-balance grace
  - `68a556c` feat(crank): sweep_expired_orders pass — batch 8, pre-holder slot, cache-gate threading (local only; VPS untouched)
  - `54acb62` feat(frontend): book IDL + seed mirrors + restingOrder discriminator
  - `0d394a1` feat(book): Phase 1 limit book — RestingOrder + post/fill/cancel/sweep
- **Latest commits (2026-06-09 Stage-I remediation session) — `master`+`main` both at `5b2cbf8`:**
  - `5b2cbf8` fix(settlement): cap American per-contract payout at collateral_per_token (AM-MED-1)
  - `2408222` feat(opta): fail-closed testing-marker deploy guard + reset_vol_oracle admin instruction (LOW-5 + new instruction)
  - `c5fde94` fix(vol-oracle): reseed on >2h sample gap to prevent realized-vol inflation (AM-MED-2)
  - `e55db39` docs(handoff): correct crank status — gated off not drained, revived 2026-06-09
  - `f514c2b` feat(crank): env-gate vol-oracle side-loop via OPTA_VOL_CRANK_DISABLED (off until Stage I)
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

**Post-Stage-B follow-on (2026-05-19):** `scripts/migrate-shared-vaults-carry-rate.ts` run against devnet (admin, 2 txs `543JDEY1…` + `3YsFpGbv…`, 27 vaults migrated 236→240 bytes, cost ~761k lamports). On-chain SharedVault census moved from `1 at 240 / 27 at 236 / 14 at 204` to `28 at 240 / 0 at 236 / 14 at 204`. The 14 pre-Phase-2 (204-byte) vaults remain at policy-hidden legacy size — `isPostPhase2Vault` filter would gate them out anyway. Migration was triggered by the May-17 redeploy silently dropping all 41 legacy vaults from `safeFetchAll` (legacy Borsh deser fails on the trailing-byte length mismatch).

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
- **`testing` Cargo feature + LOW-5 fail-closed deploy guard (new 2026-06-09).** Two `compile_error!` guards in `programs/opta/src/lib.rs` **refuse to build a deployable artifact** if any of `{test-fast-vol, test-synth-vol, cu-profile}` OR `american-enabled` is set **without** the `testing` marker. So: **production deploys MUST be feature-free** (`anchor build`, no `--features`); **test builds MUST pass `--features testing …`** — now wired into `package.json` `test:bankrun` and the gitignored `.test-fixtures/run-tests.sh` (the latter isn't committed, so a fresh clone runs only the bankrun harness — pre-existing). The Stage-I flip is the `feature_flags.rs` default edit deployed **feature-free**, never `--features american-enabled`. Hook crate carries a no-op `testing` mirror for workspace feature propagation. (Replaces the old "discipline-only" never-deploy rule for the test features with a hard compile-time gate.)

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
- Mocha + Chai + `ts-mocha` at repo root.
- **CANONICAL COMMAND: `npm test`** (= `bash ./.test-fixtures/run-tests.sh "tests/**/*.ts"`), or a single file via `npm run test:file tests/<file>.ts`. The harness builds with the test-only feature set (`test-fast-vol,american-enabled,test-synth-vol`), **regenerates runtime-relative Pyth `PriceUpdateV2` fixtures**, launches a manual `solana-test-validator` with `--account` flags to load them, then runs `ts-mocha`.
- **DO NOT use `anchor test` / bare `ts-mocha`.** `Anchor.toml [test.validator]` has no `--account` entries, so those paths launch a **bare validator with zero fixtures** — every `settle_expiry` / `initialize_vol_oracle` / `push_vol_sample` then reverts `AccountNotInitialized (3012)` on `price_update`, cascading widely. This is the "fixture-rot / 97-failures" phantom: the fixtures were never broken — the wrong launch command was. The working harness has always been `run-tests.sh`; `npm test` now points at it.
- **Fixture-rot remediation (2026-06-06):** fixed two real regressions — the Pass-2 `vol_oracle` uniform-context account (vault tests now `ensureVolOracle` before minting; killed the 3007s) and protocol-state mint contamination (tests reuse the singleton's USDC mint; killed the 2003s). Added the `test-synth-vol` instruction (`synth_warm_vol_oracle`) to plant a warmed oracle so American pricing tests run without 168 rate-limited pushes. **NEVER deploy a `test-synth-vol` build** (same rule as `cu-profile` / `test-fast-vol`; verified by IDL grep = 0).
- **Settle-dependent suites are `describe.skip` with `[needs bankrun setClock — Stage G]`:** `auto-finalize-holders`, `auto-finalize-writers`, `CRIT-1 holders-first gate`, and individual settle tests in `opta` / `zzz-audit-fixes` / `shared-vaults`. They settle a vault whose expiry the test computes at run time, but fixtures carry fixed publish_times written at suite start — the 60s settle window can't align over a multi-minute suite (PriceUpdateBeforeExpiry / ExpiryInPast). Deterministic only under bankrun's per-test `setClock`; bankrun adoption is deferred to Stage G. These were already failing pre-remediation — not a regression.

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

### Instruction inventory (42 production instructions on the main program as of 2026-06-24 — was 39 pre-Phase-4 (incl. `get_option_price` as a view; 38 excluding it), now +3 Phase-4 trigger orders. Breakdown: 29 Phase-2 + 4 Phase-1 exchange book + 2 Phase-2 Pass A series + 1 Phase-2 Pass B peg + 1 Phase-2 Pass C write merge + 1 Phase-2 Pass D hatch + 1 Switchboard Stage-2 market-migrate + 3 Phase-4 trigger orders; the groups below are the post-Stage-A snapshot — the Phase 2 B–I additions + the exchange book + Pass A + Pass B + Pass C + Pass D are listed at the end of this section)

**Admin (2):** `initialize_protocol`, `initialize_epoch_config`

**Market lifecycle (2):** `create_market` (permissionless post-HIGH-5), `migrate_pyth_feed` (admin)

**Vault writer flow (5):** `create_shared_vault` (now takes `carry_rate_bps` as 6th arg post-Stage A), `deposit_to_vault`, `mint_from_vault`, `withdraw_from_vault`, `claim_premium`

**Vault buyer flow (1):** `purchase_from_vault`

**Settlement (4):** `settle_expiry`, `settle_vault`, `auto_finalize_holders`, `auto_finalize_writers`

**Manual cleanup (3):** `exercise_from_vault`, `withdraw_post_settlement`, `burn_unsold_from_vault`

**V2 secondary listing (3):** `list_v2_for_resale`, `buy_v2_resale`, `cancel_v2_resale`

**Auto-cleanup (1):** `auto_cancel_listings`

**Schema migration (1, NEW in Stage A):** `migrate_shared_vault_carry_rate` — admin-only, batched via `remaining_accounts`. Run once at Stage C deployment time to migrate legacy SharedVaults to the new schema.

**Phase 2 B–I additions (7, bringing the production count to 29):** `initialize_vol_oracle` + `push_vol_sample` (Stage B vol oracle), `reset_vol_oracle` (**NEW 2026-06-09** — admin-only; zeroes a polluted/broken VolOracle's ring + accumulators + counters + last_spot so the next push re-seeds), `get_option_price` (Stage C Pass 3 typed-return view), `exercise_american` (Stage F early exercise), `migrate_shared_vault_exercise_style` (Stage C Pass 1) + `migrate_shared_vault_exercise_tracking` (Stage F). **Two behavioral changes shipped 2026-06-09:** `push_vol_sample` now **reseeds** (spot+ts only, no sample) on a gap > `VOL_ORACLE_MAX_SAMPLE_GAP_SECS` (7200s) so a crank outage can't inject a vol outlier (MED-2); the **American** settlement payout path (`exercise_from_vault` + `auto_finalize_holders`) now **caps each contract at `collateral_per_token`** via the early-exercise helper (MED-1; European byte-identical, `settle_vault`'s emitted aggregate untouched).

Plus **3 cu-profile-gated test-only instructions** (NOT in production IDL): `cu_profile_american`, `shrink_shared_vault_for_test`, `create_test_shared_vault`. Plus `synth_warm_vol_oracle` (`test-synth-vol`-gated). None ship — enforced by the LOW-5 `testing`-marker compile guard (§3).

**Exchange Phase 1 book (4 instructions, DEPLOYED 2026-06-10):** `post_order`, `fill_order`, `cancel_order`, `sweep_expired_orders` — the `RestingOrder` limit book (generalizes the V2 resale flow), built at commit `0d394a1`, **DEPLOYED to devnet at slot `468668989`** (upgrade tx `nKRmaYeHM…`); **production on-chain count is now 33.** Adds the `RestingOrder` account + `OrderKind` enum + 4 tape events + error 6054 (`WriterAsksDisabled`). Devnet-verified end to end via `scripts/smoke-book-devnet.ts`. **FE has NOT migrated resale → book yet** (spec §6.7 — a later arc; resale UI still live). Canonical spec: `.context/plans/opta-exchange-spec.md`.

**Exchange Phase 2 Pass A (2 instructions, DEPLOYED 2026-06-12):** `create_series` (canonical per-spec Token-2022 series mint — spec-only PDA seeds, American-only per D12, sentineled `VaultMint` series record) + `migrate_shared_vault_exchange_fields` (SharedVault `spread_bps`+`voided` append, 257→260). Built at `4b6ad06`, **DEPLOYED to devnet slot `468771120`**; **production on-chain count is now 35.** Adds the `SeriesCreated` event + error 6055 (`SeriesMustBeAmerican`). **62/62 SharedVaults migrated 257→260** at deploy time. Devnet-verified via `scripts/smoke-pass-a-devnet.ts` (create_series + negatives + EUR-verbatim deser proof; book×series deferred — American-vault gate). Both inert/dark until Pass B + the Stage-I flip. `mint_from_vault` untouched. Spec: `.context/plans/opta-exchange-spec.md` §7.

**Exchange Phase 2 Pass B (1 instruction, DEPLOYED 2026-06-12):** `fill_vault_peg(quantity, max_premium)` — the mint-on-fill vault peg. Prices an American series at fill time via the shared `price_american` helper (BS-2002) + `vault.spread_bps` (floored u128), takes USDC (pool premium + floored fee → treasury, same split as `purchase_from_vault`/`fill_order`), and mints `quantity` contracts to the taker — `protocol_state` signs the `mint_to` (the series mint authority, per `create_series.rs:185`); no hook runs on a mint; **`vault_namespace_seed` is intentionally unused** (premium flows IN, no vault-PDA payout). Commitment counters advance on both the `SharedVault` and the series `VaultMint` record (minted == sold; mint-on-fill, no inventory); premium accumulator (H-01) grows. Free-collateral cap: `free = (total_collateral − early_exercise_payout) − (total_options_minted − exercised_options) × cpt`, gated `free ≥ qty × cpt`. Built at `3a908dd`, **DEPLOYED to devnet slot `468926799`** (upgrade tx `3JweX26D…`); **production on-chain count is now 36.** **Event/error notes:** reuses `OrderFilled` with **`OrderKind::VaultPeg = 3`** appended (Borsh-append-safe; tape convention — `order` = series record PDA, `maker` = vault PDA, `quantity_remaining` = post-fill peg depth `floor(free/cpt)`); one new error **`VaultVoided` (6056)**; `post_order` refuses a hand-crafted `kind = 3` by reusing **`WriterAsksDisabled`** (no new code — the peg is virtual, never a resting order), and the 4 book consumers (`fill_order` ×2, `cancel_order`, `sweep_expired_orders`) carry `unreachable!` arms (structurally impossible — no stored order can hold kind 3). **No schema delta** (Pass A appended the fields) → no migration, no deser window. Gated by `AMERICAN_ENABLED` (first runtime gate) — dark until the Stage-I flip; the runtime peg canary is a post-flip item (§10). `mint_from_vault` + settlement untouched, European byte-identical. **FE IDL drift:** `app/src/idl/*` deliberately NOT synced with `fill_vault_peg` — rides the FE arc (same Stage A→H precedent). Spec: `.context/plans/opta-exchange-spec.md` §7.3.2.

**Exchange Phase 2 Pass C (1 instruction, DEPLOYED 2026-06-12):** `create_and_deposit(strike, expiry, option_type, vault_type, collateral_mint, carry_rate_bps, exercise_style, amount)` — the atomic write merge (D9). Fuses `create_shared_vault` + `deposit_to_vault` into ONE tx via `init_if_needed` on `shared_vault`/`vault_usdc`/`writer_position`: the first caller for a spec creates+deposits, a subsequent caller just deposits. Fresh detected by `created_at == 0`; identity/config fields written on fresh ONLY (never rewritten — the 5 core spec dims are PDA-seed-encoded so a mismatch is structurally impossible; the 3 non-seed params are creation-only). The heavy mint left the write path (D8/D9) → no Token-2022 mint, no BS-2002, ~light CU; the partial-flow stranded-collateral hazard dies structurally. Reuses `VaultCreated` (fresh only) + `VaultDeposited` (always). **ALSO ships two peg-aware American-only collateral-gate fixes** (the Pass-B peg's vault-level commitment was invisible to the old per-writer gates): (1) **`mint_from_vault`** — vault-level free gate (`free ≥ qty × cpt`) closing the peg→direct-mint over-commit race; (2) **`withdraw_from_vault`** — DUAL gate (existing per-writer AND vault-level) so an LP can't withdraw collateral the peg sold contracts against. Both reuse Pass B's `vault_free_collateral` (single source of truth); EUR arms add zero computation → byte-identical. Errors **reused** (`InsufficientVaultCollateral` / `CollateralCommitted`) — **no 6057**. Built at `dc86c76`, **DEPLOYED to devnet slot `468946122`**; **production on-chain count is now 37.** Additive — `create_shared_vault` + `deposit_to_vault` stay live for legacy callers; `burn_unsold_from_vault` untouched. **No schema delta** → no migration, no deser window. American `create_and_deposit` gated by `AMERICAN_ENABLED` (dark until Stage I). Devnet-verified (`scripts/smoke-pass-c-devnet.ts`): 6052 gate, EUR fresh+existing-path (created_at/creator unchanged), EUR mint-verbatim, EUR withdraw regression — all pass. **FE IDL drift:** `app/src/idl/*` NOT synced; the FE write-collapse (3tx→1) + Portfolio withdraw button ride the FE arc post-flip. Spec: `.context/plans/opta-exchange-spec.md` §7.3.3 / §7.6.

**Exchange Phase 2 Pass D (1 instruction, DEPLOYED 2026-06-15):** `reclaim_unsettled()` — the dead-feed safety hatch. Universal (NOT `exercise_style`-gated; the only `exercise_style` read is the `vault_namespace_seed` signer, which serves EUR + AMER), permissionless per-writer wind-down for a vault whose Pyth feed dies pre-settlement: pays each `WriterPosition` pro-rata via `withdraw_post_settlement`'s formula (vault-PDA signer), seeds `collateral_remaining = total_collateral − early_exercise_payout` (Stage-G F→G expression, verbatim) and sets `voided = true` on the FIRST call. **Never sets `is_settled`, never writes a `SettlementRecord`** (invariant #6 — a zero-price record would let PUT holders drain `strike − 0`). Preconditions: `SettlementRecord` non-existence (seeds-pinned `UncheckedAccount`, handler asserts `data_is_empty()`) + 7-day grace (`GRACE_WINDOW = 604_800`) + premium-claimed-first (reuses `ClaimPremiumFirst`). Per-writer idempotency = zeroed shares (not account-close) → 2nd writer not blocked, double-claim hits the zero-shares guard. **ALSO adds voided gating** — `require!(!vault.voided, VaultVoided)` (6056) on four handlers: `settle_vault` + `withdraw_from_vault` (after `is_settled`, reachable) and `exercise_from_vault` + `auto_finalize_holders` (BEFORE `is_settled` so 6056 is reachable — a voided vault is always `is_settled=false`). New errors **`SettlementRecordExists` (6057)** + **`GracePeriodNotElapsed` (6058)**; new **`VaultReclaimed`** event. NOT `AMERICAN_ENABLED`-gated (exit path stays open). Built at `71b4373`, **DEPLOYED to devnet slot `469592830`**; **production on-chain count is now 38.** **No schema delta → no migration, no deser window, VPS untouched.** Spec: `.context/plans/opta-exchange-spec.md` §7.3–§7.6.

**Exchange Phase 4 Trigger Orders (3 instructions, DEPLOYED 2026-06-24, slot `471418448`):** `place_trigger` / `cancel_trigger` / `execute_trigger` — TP/SL + stop-entry on the vault counterparty. **StopEntryBuy** fires `fill_vault_peg` (USDC escrowed at placement = `max_premium × quantity`, unspent refunded at fire); **TakeProfitSell** fires `exercise_american` (delegate-burn at fire, ITM-only; **StopLoss dropped** — OTM is structurally unfireable via exercise). Underlying-keyed (Pyth EMA); `execute_trigger` re-reads a fresh EMA (`pyth_current_spot_usdc`, 60s/200bps) + re-checks the stored comparator ITSELF (the keeper is only a scheduler) + a SELL fire-time owner/mint theft guard (6060); partial-fire = `min(qty,balance)`, decrement, stay-open. **Two shared cores extracted** — `vault_peg_fill_core` + `american_exercise_core` (authority/source/dest as params; `Option<&AccountInfo>`/`Option<u8>` fork; the original `fill_vault_peg`/`exercise_american` AND `execute_trigger` all call them; byte-identical, bankrun 96/0, cargo 72/0). New errors **`TriggerConditionNotMet` (6059)** + **`TriggerSourceAtaInvalid` (6060)**; new account **`TriggerOrder`** (212 B incl. disc); new events `TriggerPlaced` / `TriggerCancelled` / `TriggerExecuted` / `TriggerSkipped`. Upgraded by-ADDRESS, **v3** (`--arch v3 --tools-version v1.54`), feature-free; **production on-chain count is now 42.** **Off-chain keeper** = a 4th crank side-loop (`crank/triggerCrank.ts`, 15s cadence, batched Hermes, `get_option_price` budget pre-check, SELL OTM pre-skip, 50bps fire-margin env-overridable, reads `crank/idl/opta.json` not the stale FE IDL) — LIVE-firing autonomously on the VPS (per the 2026-06-24 top block). Commits `95a9af5` `3495203` `6ee01bd` `b047a69` on `master`+`main`. Spec: `.context/plans/opta-exchange-spec.md` (trigger-order spec v1).

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
| Both programs | **Solana devnet**, program IDs above. **Stage G Pass 2 redeploy 2026-06-06:** opta `467823489` (was `467614822` from Stage F), commit `7ba6364`, deploy tx `4SpJzaTA…` (Helius RPC). opta_transfer_hook `464160129` unchanged. Surface: universal F→G settlement handshake (`collateral_remaining = total_collateral − early_exercise_payout`; European subtracts 0, byte-identical), the 4-site `vault_namespace_seed` payout-handler seed sweep, the tight 60s `exercise_american` staleness gate. **Zero IDL delta; no migration** (no new fields). Post-deploy verify: 6052 canary (feature-free, `AMERICAN_ENABLED` false); fresh EUR mint at a 257-byte vault, premium verbatim. Stage G Passes 1/3a/3b were test-only — no further redeploy. **Stage-I remediation redeploys 2026-06-09 (current slot `468290108`):** opta `467823489` → `468260768` (MED-2 gap-reseed + LOW-5 guard + `reset_vol_oracle`; commits `c5fde94` + `2408222`) → `468290108` (MED-1 settlement cap; commit `5b2cbf8`) — both **feature-free** via Helius; hook **unchanged** `464160129`. Each verified by the 6052 gate + EUR-verbatim canaries (`AMERICAN_ENABLED` still false). **Phase 1 exchange-book deploy 2026-06-10 (current slot `468668989`):** opta `468290108` → `468668989` — **feature-free** via Helius, **program ID unchanged**, hook **unchanged** `464160129`; Agave auto-extended ProgramData 1178384 → 1263352 bytes for the 4 new book instructions. Upgrade tx `nKRmaYeHMAhjZdDLxtDiVAMtYDtQ3Za4T6Qy5gKDzKT77sHJYKo6ekBeLYZq7wByQbKyW9S4gJo8LCsKujqFmLL`. Verified: 6052 gate live (`create_shared_vault.rs:45`), EUR premium-verbatim canary, and a full `RestingOrder` book smoke (`scripts/smoke-book-devnet.ts`) — EUR mint→purchase, post/partial-fill/cancel ask, bid post/fill, fee→treasury, all PDAs close, all assertions PASS. `AMERICAN_ENABLED` still false. **Phase 2 Pass A deploy 2026-06-12 (current slot `468771120`):** opta `468668989` → `468771120` — **feature-free** via Helius, **program ID unchanged**, hook **unchanged** `464160129`; Agave auto-extended ProgramData 1263352 → 1306592 for `create_series` + `migrate_shared_vault_exchange_fields`. Upgrade tx `EsX4kX3dGPu2UQZ8AZ6JRmK318FqkRhRW2Ffkhm5Hp3qWMXEPa7goqHQb7XgfDbdMnUoW9WJnWL2UCjkn21Cc9u` (the first attempt hit a transient Helius connection-reset with **zero on-chain effect** — verified slot/balance unchanged — and the retry deployed cleanly). **IDL-account incident:** the program deployed fine but the on-chain IDL *account* upgrade failed (`IdlSetBuffer`→`RequireGteViolated`, 21314<21430 — the grown IDL exceeded its account); fixed post-canaries via `anchor idl close` + `anchor idl init`, on-chain IDL `fetch` verified **== local** (sorted-key diff). One stranded IDL buffer from the failed step remains (small SOL, address not captured — minor follow-up). **Migration (immediately after deploy):** dry-run census (62 vaults, all 257) → live run — **62/62 SharedVaults grown 257→260, `spread_bps=0`/`voided=false`** — batch sigs `2SbGKZvSsKxQ…NCjb9`, `4zaUkqR63ReC…AZgdn`, `3M1EjtvJRuxX…8sBGy`, `4mpfA4ZWsu1D…cXwEU`. Post-census: all 62 at 260; `safeFetchAll` **48→48 (zero migration drops)** — **14 pre-existing corrupt-at-`is_settled` vaults** (byte 178, untouched by the migration) stay dropped, as before. Verified: 6052 gate, EUR premium-verbatim (deser-window-closed), `create_series` smoke + negatives (`scripts/smoke-pass-a-devnet.ts`, series mint `2P8Annr4LZZpBuG1e6Z1Nqp2Jtjhn1vg2Qyr9NM9hq8Q`); book×series deferred (American-vault gate). **Deser window** = slot 468771120 (deploy) → migration completion; VPS settle-loop tick-failures during the window were expected + harmless (vol pushes use VolOracle, warmup unaffected). Helius flaky all session (connection reset + gPA timeouts) — bounded retries, redacted output. `AMERICAN_ENABLED` still false. **Phase 2 Pass B deploy 2026-06-12 (current slot `468926799`):** opta `468771120` → `468926799` — **feature-free** via Helius, **program ID unchanged**, hook **unchanged** `464160129`; Agave auto-extended ProgramData 1306592 → 1324656 for `fill_vault_peg`. Upgrade tx `3JweX26D37CUGxjgMCaBVSfZQqumDJXiEBWH8Q5wzXZy5veTP3bu7zKE9unpuXmj5878mZJTh4W2mLczBpTX7Kxx`. **NO schema delta → no migration, no deser window, VPS untouched.** **IDL auto-upgraded cleanly during `anchor deploy`** — the Pass A `IdlSetBuffer`→`RequireGteViolated` did NOT recur (no `close`/`init` needed); `anchor idl fetch` == local (sorted-key diff identical). Deployer balance 17.69 SOL pre-deploy; single clean deploy, no blind retry. Canaries: 6052 gate (`create_shared_vault.rs:45`), EUR premium-verbatim, full book smoke (`scripts/smoke-book-devnet.ts` — all pass, 5 touched handlers unchanged), on-chain IDL contains `fill_vault_peg`. Runtime peg canary unconstructable while dark (post-flip, §10). `AMERICAN_ENABLED` still false. **Phase 2 Pass C deploy 2026-06-12 (current slot `468946122`):** opta `468926799` → `468946122` — **feature-free** via Helius, **program ID unchanged**, hook **unchanged** `464160129`; Agave auto-extended ProgramData 1324656 → 1393752 for `create_and_deposit` + the two gate fixes. Upgrade tx `4GfFFS5TGmHaTcSnu8FYKvbA3aFRpPUjKAh6GUm65ByZSUCPNF7pZnsafmuWbv3nc29gDzkfX72wwbKNApsS4D8v`. **NO schema delta → no migration, no deser window, VPS untouched.** **IDL auto-upgraded cleanly during `anchor deploy`** (no `close`/`init`; `anchor idl fetch` == local sorted). Deployer 17.13 SOL pre-deploy; single clean deploy. Canaries 6–10 (`scripts/smoke-pass-c-devnet.ts`): 6052 on American `create_and_deposit` (`create_and_deposit.rs:69`), EUR fresh+existing-path (created_at/creator unchanged on-chain), EUR mint premium-verbatim, EUR withdraw regression, on-chain IDL has `create_and_deposit` — all ✓. `AMERICAN_ENABLED` still false. **Phase 2 Pass D deploy 2026-06-15 (current slot `469592830`):** opta `468946122` → `469592830` — **feature-free** via Helius, **program ID unchanged**, hook **unchanged** `464160129`; Agave auto-extended ProgramData 1393752 → 1413576 for `reclaim_unsettled` + the four voided guards. Upgrade tx `3wsmZdDfqJDJ5jaH62RH2PGGBeNWrnTkPWUXSNJdaFtdCJK6TgKwQDSwRhAQ8hMjzQtEk9Pp4TKUe5KMWsH2f3bK`. **NO schema delta → no migration, no deser window, VPS untouched.** **IDL auto-upgraded cleanly during `anchor deploy`** (Pass B/C path, no `close`/`init`; `anchor idl fetch` == local). Deployer 16.60 SOL pre-deploy; single clean deploy, no stranded buffers. Canaries: 6052 gate (American `create_shared_vault` reverts `AmericanVaultsDisabled` at `create_shared_vault.rs:45`), EUR premium-verbatim (`premium_per_contract=42000000` verbatim — proves the four new guards are EUR no-ops), on-chain IDL has `reclaim_unsettled` + errors 6057/6058. Runtime reclaim canary DEFERRED (needs a dead-feed vault + 7d grace — post-flip, §10). `AMERICAN_ENABLED` still false. |
| Frontend | **Vercel — `https://opta-solana.vercel.app`, GREEN at buildId `5b98825` (Stage H, 2026-06-08).** Auto-deploys on push to `main`. Stage H added the full AMER UI surface, dark-launched behind `AMERICAN_ENABLED_UI = false` (European byte-identical). IDL byte-identical to the deployed Stage G program (re-confirmed at Stage H Gate A — no regen needed). |
| Crank bot | **RUNNING throughout** — `opta-crank.service` on Vultr VPS `root@144.202.58.6` (`bud-fox-agent`, Ubuntu 22.04), user `opta`, install `/opt/opta-crank/`, dedicated devnet keypair `5sHZETYzbbdBQnFLmDCG3gyCikew39pL8kAE5xroGfqa`. The service ran continuously and the **settle loop stayed healthy** the whole time. Only the **vol-push side-loop was intentionally gated OFF** (`OPTA_VOL_CRANK_DISABLED=1` in `/opt/opta-crank/.env`, set during Stage H 2026-06-08 to save cost while American is dark) — that gating, NOT a drain, is why the vol-oracles went stale (no pushes ran, by design). Wallet **9.999 SOL** (~zero burn while vol was off — settle txs just 404 on equity/archive-gap tuples and never send). **Revived 2026-06-09 ~09:23 UTC**: commented the `.env` flag line + `systemctl restart opta-crank` (no daemon-reload); new PID `1121215`; vol loop spawned immediately (continuous mode), first push ~6s later. Post-revive on-chain read @ 09:29: **8/16 oracles fresh** (the crypto/liquid feeds, e.g. XRP `ec5d3998`); the other 8 were skipped legitimately by the on-chain Pyth-freshness gate (NOT a crank fault) — equity/illiquid feeds on `VolOraclePriceStale` (6047, warm only at US market open), one broken zero-spot feed on `VolOracleInvalidSpot` (6048, `80515916`, dead until that feed is fixed), one freshly re-initialized feed (`92b8527a`, first sample next round). **Revive procedure for the record = unset the flag + restart — NO SOL refill, NO 7-day re-warmup** (oracles are warm-but-stale, `sampleCount` persists through the gap, so one push per oracle clears the 6h `VolOracleStale` gate). `.env.bak` backup on the VPS; to re-disable, restore the line + restart. **Watch-item:** with vol pushes resumed, burn is ~0.8 SOL/day. **2026-06-09 update:** balance **9.53 SOL** (~11–12-day runway — covers the 7-day warmup, no top-up needed); the **11 gap-polluted oracles were reset** via `reset_vol_oracle` (clean 7-day warmup completing **~2026-06-16**) — the crank must stay running + funded to carry it to completion. Two equity feeds parked for the equity/European arc: `80515916` (dead zero-spot feed, `VolOracleInvalidSpot` 6048 — reset won't help) and `925ca92f` (dormant equity with an old outlier the crank can't currently push past). |
| Devnet USDC mint | `AytU5HUQRew9VdUdrzQuZvZ7s14pHLiYjAF5WqdK3oxL` |
| Devnet faucet wallet | Public keypair baked into `app/src/utils/constants.ts` for demo USDC; in-code warnings flag it |
| Domain | `opta.fyi` purchased but not yet attached to Vercel — parked |

---

## 6. Current State — What Works

- **38 production instructions** (Stage F added `exercise_american` + `migrate_shared_vault_exercise_tracking`; 2026-06-09 `reset_vol_oracle`; 2026-06-10 the 4 Phase-1 book instructions; 2026-06-12 the 2 Phase-2 Pass A series + Pass B peg + Pass C write merge; 2026-06-15 the Phase-2 Pass D hatch). The `create_shared_vault` signature takes 7 args including `exercise_style: ExerciseStyle`.
- **Exchange Phase 2 Pass D dead-feed hatch — DEPLOYED to devnet 2026-06-15 (slot `469592830`).** `reclaim_unsettled` — universal, permissionless per-writer pro-rata wind-down for a vault whose Pyth feed dies pre-settlement; seeds `collateral_remaining = total_collateral − early_exercise_payout`, sets `voided = true`, **never sets `is_settled` / never writes a `SettlementRecord`** (invariant #6). Preconditions: no `SettlementRecord` + 7-day `GRACE_WINDOW` + premium-claimed-first. PLUS `!voided` gating on `settle_vault` / `withdraw_from_vault` / `exercise_from_vault` / `auto_finalize_holders`. New errors 6057/6058; new `VaultReclaimed` event. NOT `AMERICAN_ENABLED`-gated. **No schema delta → no migration, no deser window, VPS untouched.** Upgrade tx `3wsmZdDf…`, ProgramData 1393752→1413576; IDL auto-upgraded cleanly. Gates: cargo **63/0**, bankrun **80/0** (reclaim 10/10), validator **100 pass / 0 real failures**. Canaries: 6052 gate, EUR premium-verbatim (proves the 4 guards are EUR no-ops), on-chain IDL has `reclaim_unsettled` + 6057/6058. Runtime reclaim canary deferred (post-flip, §10). European byte-identical. Commit `71b4373`. Spec: §7.3–§7.6.
- **Exchange Phase 2 Pass C write merge — DEPLOYED to devnet 2026-06-12 (slot `468946122`).** `create_and_deposit` — atomic create+deposit (D9; mint left the write path → stranded-collateral hazard dies structurally) + two peg-aware American-only collateral gates (`mint_from_vault` vault-level free gate vs the peg→direct-mint over-commit race; `withdraw_from_vault` dual gate so an LP can't withdraw peg-committed collateral). Errors reused (no 6057). **No schema delta → no migration, no deser window, VPS untouched.** Upgrade tx `4GfFFS5T…`, ProgramData 1324656→1393752; IDL auto-upgraded cleanly (no close/init). Gates: Rust **63/0**, bankrun **70/0** (+5 Pass C, exchange-book 14/0). Canaries 6–10 (`scripts/smoke-pass-c-devnet.ts`) all ✓. Additive (`create_shared_vault`/`deposit_to_vault` stay live); EUR byte-identical. Dark behind `AMERICAN_ENABLED`; live-verify of the two gates rides the flip (§10). Spec: §7.3.3 / §7.6.
- **Exchange Phase 2 Pass B vault peg — DEPLOYED to devnet 2026-06-12 (slot `468926799`).** `fill_vault_peg(quantity, max_premium)` — mint-on-fill pegged ask: BS-2002 (shared `price_american`) + `spread_bps` at fill time, pooled-premium economics (D7), mint-on-fill from vault collateral. Additive; one new error `VaultVoided` 6056; `OrderKind::VaultPeg = 3` appended (reuses `OrderFilled` tape). **No schema delta → no migration, no deser window, VPS untouched.** Upgrade tx `3JweX26D…`, ProgramData 1306592→1324656; IDL auto-upgraded cleanly (no close/init). Gates: Rust **63/0**, bankrun **65/0** (+6 peg, exchange-book 14/0). Canaries (`scripts/smoke-book-devnet.ts` + `smoke-stage-d-gate.ts`): 6052 gate, EUR-verbatim, book smoke, on-chain IDL has `fill_vault_peg` — all ✓. Dark behind `AMERICAN_ENABLED`; runtime peg canary is a post-flip item (§10). `mint_from_vault` + settlement untouched. Spec: §7.3.2.
- **Exchange Phase 2 Pass A series mint — DEPLOYED to devnet 2026-06-12 (slot `468771120`).** `create_series` (canonical per-spec Token-2022 mint, D5; American-only, D12) + `migrate_shared_vault_exchange_fields` (`spread_bps`+`voided`, 257→260). **62/62 vaults migrated** at deploy; bankrun **59/0**, validator **101/0/68** (×3). Devnet smoke (`scripts/smoke-pass-a-devnet.ts`): 6052 gate, EUR premium-verbatim (deser-window-closed), create_series + negatives all-pass; book×series deferred (American-vault gate, bankrun-proven). Additive; `mint_from_vault` untouched; **inert/dark until Pass B + the Stage-I `AMERICAN_ENABLED` flip** (the series carries no peg yet, and its American vault can't be created while the flag is false). Spec: `.context/plans/opta-exchange-spec.md` §7.
- **Exchange Phase 1 limit book — DEPLOYED to devnet 2026-06-10 (slot `468668989`).** `RestingOrder` book with `post_order`/`fill_order`/`cancel_order`/`sweep_expired_orders`, reusing the hook-token escrow pattern verbatim. bankrun **53/0** (14 new exchange-book tests), validator suite **untouched-green** (101/0/68), FE build green. Post-deploy devnet smoke (`scripts/smoke-book-devnet.ts`) passed all assertions end to end: EUR mint→purchase, post/partial-fill/cancel ask, bid post/fill, fee→treasury, all PDAs close. Additive only; European/American byte-identical; `AMERICAN_ENABLED` still false. **`sweep_expired_orders` is deployed but not devnet-smoked** (needs a real expiry wait — covered by bankrun). FE resale→book migration is a later arc (spec §6.7). Spec: `.context/plans/opta-exchange-spec.md`.
- **American-surface audit COMPLETE (2026-06-09) — 0 CRIT / 0 HIGH.** Three phases (money-conservation, pricing/oracle, flag/secondary/griefing/FE). The cardinal money-conservation invariant (Σ payouts ≤ total_collateral, across spot paths / partial exercise / multi-writer pools) is **proven**. Tally: 3 MED (MED-1 resolved, MED-2 fixed, MED-3 accepted), 5 LOW (LOW-5 fixed, rest accepted), 6 INFO, 21 VERIFIED. Artifacts (gitignored): `.context/audits/american-surface-{audit-scope,findings}.md`.
- **MED-2 vol gap-reseed guard** — `push_vol_sample` reseeds (spot+ts only, no sample) on a gap > 7200s, so a crank outage no longer injects a multi-day move recorded as one "hour" into the vol estimator. Deployed `468260768`.
- **`reset_vol_oracle`** (new admin instruction) — zeroes a polluted/broken VolOracle so the next push re-seeds; used 2026-06-09 to clear the 11 gap-polluted oracles (clean 7-day warmup running to ~Jun 16).
- **MED-1 American settlement per-contract cap** — `exercise_from_vault` + `auto_finalize_holders` cap each American contract's payout at `collateral_per_token` (= strike) via the same `exercise_capped_intrinsic` helper as early exercise, closing the hold-to-settlement / finalize-race edge. American is now consistent (early-exercise + settlement both capped). **European byte-identical.** Deployed `468290108`.
- **LOW-5 fail-closed deploy guard** — production builds can't carry test/dev features or `american-enabled` without the `testing` marker (hard `compile_error!`); production deploys are feature-free. See §3 + §11.
- **Stage A math kernel + plumbing shipped** (commits `3d33abc`, `91b1738`, `7e98a46`). Pass 2 will wire `american_call_price` / `american_put_price` into `mint_from_vault` for American vaults.
- **Stage B vol oracle shipped + deployed** (FE fix `12e3d8d`). 11 oracles initialized on devnet; 7-day warmup running. Pass 2 will call `realized_vol_annualized` from `mint_from_vault`.
- **Stage C Pass 1 shipped + migrated** (commit `6c1551c`, opta slot `463947205`). `SharedVault` gained `exercise_style: ExerciseStyle` field (Borsh-safe append). New PDA seed `b"shared_vault_american"` lets EUR and AMER vaults coexist at the same `(market, strike, expiry, option_type)` tuple. 31 legacy 240-byte vaults migrated to 241 bytes (all defaulted to European).
- **Stage C Pass 2 shipped to devnet 2026-05-22** (opta slot `464159895`). `mint_from_vault` now branches on `vault.exercise_style`: European stores `premium_per_contract` arg verbatim (zero EUR regression — proven via devnet smoke at strike $402 tx `5cJG6P3MFYqYCCqq5rUv8ogNx1EKZiYgK3dyMV7EpzSmsgk2QfHpssf7ARFPJWc1DdY3NNhfWvP8Tn8DEwJSjaWK`); American computes premium on-chain via `VolOracle.last_spot_price` + `realized_vol_annualized` + BS-2002, ignoring the arg. Required `vol_oracle` account on uniform context across both styles (auto-derived from `market.pyth_feed_id` in IDL — existing FE call sites get the account for free). 427 stale pre-Phase-2 markets without seeded oracles are isolated from users by the `PHASE2_CUTOFF_TIMESTAMP` UI filter — direct CLI calls against them would fail, but no UI flow can hit them.
- **Stage C Pass 3 shipped to devnet 2026-05-24** (opta slot `464568346`). First Anchor typed-return instruction in the codebase. New `get_option_price` CPI-callable view returns `OptionPriceQuote { premium_per_contract, vol_used_scaled, spot_used_scaled, computed_at_ts }` from on-chain BS-2002 without requiring a vault. European calls revert with `ViewNotSupportedForEuropean` (code 6051) — frontend keeps using the off-chain TS pricer for EUR previews. `price_american` helper extracted to `utils/american_pricing/quote.rs` as single source of truth for the AMER pricing path; `mint_from_vault` AMER branch now ~50 LOC lighter, byte-identical behavior (verified via $402 EUR regression smoke → `premium_per_contract = 42_000_000` verbatim, tx `2DtuyJqNSxgtF9TKBq4QNCZB7tgWYFHXXAL9puGhaHF7Af69AytMpeVwy1nLxeTghWxbvxCs8ABnpFbo3FXKWLx4`). EUR rejection path measures **5,003 CU** on devnet (first real Pass 3 CU number); AMER path calculated at ~248K CALL / ~278K PUT (well under the 400K plan target; direct empirical measurement deferred to fixture-rot remediation). **Stage C COMPLETE** with Pass 3.
- **Stage D shipped to devnet 2026-06-05** (opta slot `467317459`, commit `302ce6e`). `vault_namespace_seed` seed-helper fix on `withdraw_from_vault` + `claim_premium`; `AMERICAN_ENABLED` gate (default `false` until Stage I); error 6052. EUR byte-identical (verified on-chain). American vault creation/minting reverts 6052 until the Stage I flag flip.
- **Test harness corrected (fixture-rot remediation, 2026-06-06, commit `56223da`).** Canonical command is **`npm test` → `.test-fixtures/run-tests.sh`** (NOT `anchor test`). Suite: 93 pass / 0 fail / 67 pending (pending = documented Stage-G deferral set). Stage D's seed fix proven end-to-end via the un-skipped American lifecycle test. `test-synth-vol` feature-gated test instruction — never deploy. No production logic changed; no redeploy.
- **Stage H frontend American-options surface shipped + LIVE (dark-launched)** (commit `5b98825`, Vercel buildId `5b98825`, 2026-06-08). EUR/AMER write toggle (American disabled until the Stage I flip), American write path (premium=1 sentinel + 1.4M CU), EUR/AMER position badge on both Portfolio ledgers, `exercise_american` early-exercise UI, and on-chain BS-2002 quote + realized-vol display on Trade via `get_option_price`. Gated behind `AMERICAN_ENABLED_UI = false`; European behavior byte-identical. The shared `fetchOptionPriceQuote` util uses a manual `simulate` @ 400K CU (NOT `.view()`, which caps at 200K and CU-exhausts on the American PUT branch). Program slots unchanged (FE-only stage).
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
- **Persistent crank on VPS** via systemd `opta-crank.service`. `Restart=on-failure`, `TimeoutStopSec=300`, sandboxed (`NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true`).
- **Two SharedVault migrations complete on devnet:** Stage A (2026-05-19, 27 vaults 236→240) + Stage C Pass 1 (2026-05-21, 31 vaults 240→241). 31/45 vaults at current 241-byte schema; 14 pre-Phase-2 vaults remain hidden by `isPostPhase2Vault` policy filter.
- **Phase 1 crank hardening** (commit `fb31811`): wallet balance check (boot + periodic), settle-loop heartbeat, Node version pins (`engines >=18.0.0` + `.nvmrc` pinning Node 20).

---

## 7. Current State — In Progress / Known Gaps

### Exchange Phase 1 book — built, deploy pending

The `RestingOrder` limit book (post/fill/cancel/sweep) is **built, tested (bankrun 53/0), and committed to `master`+`main`** (commits `0d394a1`/`54acb62`/`68a556c`/`c2a124f`) but **NOT deployed to devnet** — production on-chain count remains 29. Deploy is a deliberate separate decision (it adds 4 callable instructions and gates the FE resale→book migration, spec §6.7). Crank wiring (`sweep_expired_orders` pass) is in local code only; the VPS service is untouched and the vol-loop stays env-gated OFF until Stage I. Canonical spec: `.context/plans/opta-exchange-spec.md`.

### Phase 2 American + on-chain pricing — active build

The full Phase 2 plan is documented at **`.context/plans/phase2-american-onchain-pricing-scope.md`** (canonical). Summary:

- **Stage A — SHIPPED to origin May 14 2026.** BS-2002 math kernel + `carry_rate_bps` plumbing + admin migration instruction. See §2 for commits.
- **Stage B — SHIPPED to devnet 2026-05-17.** Per-asset realized-vol oracle (ring buffer + accumulators + annualized read function + crank side-loop). All 11 current devnet feeds initialized; 7-day warmup running. See §2 for commits + slot.
- **Stage C — Pass 1 (schema) SHIPPED to devnet 2026-05-21** (commit `6c1551c`, opta slot `463947205`). New `ExerciseStyle` enum + field on `SharedVault` + dual PDA seed namespace (`b"shared_vault"` for EUR, `b"shared_vault_american"` for AMER) + admin migration. 31 vaults migrated 240→241 bytes.
- **Stage C — Pass 2 (mint-time American pricing) SHIPPED to devnet 2026-05-22** (opta slot `464159895`). First production handler to call the on-chain math kernel. New `AmericanPricingFailed` error (code 6050) wraps any BS-2002 internal failure. `vol_oracle` required on `mint_from_vault` context (uniform across EUR + AMER; auto-derived from `market.pyth_feed_id` in IDL). Devnet smoke confirmed both branches behave correctly. Earliest live American demo on all 11 feeds: 2026-05-26 (warmup-gated; per-asset `realized_vol_annualized` returns `Warmup` until that asset's sample count crosses 168). 4 oldest oracles unlock 2026-05-24; until then any American mint reverts at preflight with `VolOracleWarmup` — correct behavior, just not visually compelling for demo.
- **Stage C — Pass 3 (`get_option_price` view) SHIPPED to devnet 2026-05-24** (commit `ddddc07`, opta slot `464568346`). First Anchor typed-return instruction. CPI-callable AMER pricing view; EUR returns `ViewNotSupportedForEuropean` (code 6051). Shared `price_american` helper extracted from Pass 2's inline arm — `mint_from_vault` AMER branch refactored byte-identical, EUR regression smoke at $402 confirms `premium_per_contract = 42_000_000` verbatim. BTC oracle at 111/168 samples as of deploy; AMER end-to-end via `.view()` unblocks for that asset ~2026-05-26. **Stage C COMPLETE.**
- **Stage D — American vault instructions. SHIPPED to devnet 2026-06-05** (opta slot `467317459`, commit `302ce6e`; hook unchanged). Flag-off deploy — `AMERICAN_ENABLED = false` until Stage I. EUR byte-identical, **verified on-chain**: $401 EUR mint stored `premium_per_contract = 42_000_000` verbatim (tx `yXdQV8kBK9Nk7jgvJSYSenhd4gG4SJz3tEtrgfpSVvstswui5piyT12Ac9CSDCbSAmcmQpFuuPzfxGAnUToiFKq`); an American `create_shared_vault` simulate reverts `AmericanVaultsDisabled` (6052 / `0x17a4`), proving the gate is live above the warmup check. The scoping report established the real work: every handler that signs a USDC payout AS THE VAULT PDA hardcoded `SHARED_VAULT_SEED`, so on an American vault (PDA from `SHARED_VAULT_AMERICAN_SEED`) the re-derived signer never matched and the CPI failed. Delivered:
  - **`vault_namespace_seed(style) -> &'static [u8]`** in `state/shared_vault.rs` — single source of truth for the vault-PDA seed namespace. `withdraw_from_vault` + `claim_premium` now branch through it on `vault.exercise_style`; European returns byte-identical bytes (zero EUR change). These two were the only Stage-D-scope handlers with the bug (deposit is writer-signed; purchase + mint sign with PROTOCOL_SEED; create/mint pricing were Stage C).
  - **`AMERICAN_ENABLED` feature flag** (`feature_flags.rs`): compile-time const, default `false`, flipped `true` by the new `american-enabled` Cargo feature (no-op mirror on the hook). Runtime `require!(AMERICAN_ENABLED, AmericanVaultsDisabled)` at the top of the American arm of `create_shared_vault` + `mint_from_vault`. **Introduced Stage D; FLIP AT STAGE I** — flip the `not(feature)` default to `true` and deploy FEATURE-FREE; never deploy a `--features american-enabled` build.
  - New error `AmericanVaultsDisabled` (code 6052) — the only IDL delta. Helper unit tests (primary regression); `tests/zzz-american-vault-lifecycle.ts` is now **un-skipped and GREEN** (see Fixture-Rot Remediation below).
  - **Three locked calls (Nanko) — deferred OUT of Stage D:** (1) the same hardcoded-seed bug in the settlement handlers (`withdraw_post_settlement`, `auto_finalize_holders`, `auto_finalize_writers`) → swept in **Stage G** via the new helper (safe: flag off until Stage I); (2) `auto_finalize_writers` partial-supply logic → **Stage G** (needs Stage F's `exercised_count`); (3) `exercise_from_vault` American guard → **Stage F** (built alongside `exercise_american`).
- **Fixture-Rot Remediation — COMPLETE 2026-06-06** (commit `56223da`; no deploy — production binary + IDL unchanged). Corrected the diagnosis: the "97 failures / fixture rot" was a phantom — the Pyth fixtures regenerate fine; the failures came from `anchor test` / bare `ts-mocha` launching a validator with **no `--account` fixtures**. **Canonical command is now `npm test` → `.test-fixtures/run-tests.sh`** (regenerates fixtures + manual validator with `--account` + ts-mocha); `npm run test:file tests/<f>.ts` for one file. Suite via the harness: **93 passing / 0 failing / 67 pending**. **Stage D's seed fix is validated end-to-end** — `zzz-american-vault-lifecycle.ts` runs the full American lifecycle (create → deposit → mint → purchase → claim_premium → withdraw) on a warmed oracle, exercising the vault-PDA signer on a live CPI. Fixed two real regressions (Pass-2 `vol_oracle` uniform-context account → `ensureVolOracle` in vault tests; protocol-state mint contamination → reuse `protocol_state.usdc_mint`). New **`test-synth-vol`** Cargo feature + `synth_warm_vol_oracle` instruction plants a warmed oracle without 168 pushes — **feature-gated, NEVER deploy** (feature-free IDL grep = 0, byte-identical to committed `app/src/idl/`). The **67 pending** are the documented **Stage-G deferral set** (settle timestamp-drift suites + bankrun-only tests + a full-suite premium-contamination cluster that passes standalone). Canonical scope + 8-item Stage-G checklist in `.context/plans/phase2-american-onchain-pricing-scope.md`.
- **Stage E — Token-2022 metadata `exercise_style` field. SHIPPED to devnet 2026-06-06** (commit `3f5d06e`, opta slot `467548106`; hook `464160129` unchanged). Writes an `exercise_style` (`european`/`american`) pair into every new option mint's Token-2022 `additional_metadata` via `mint_from_vault`. `ExerciseStyle::metadata_str` is the single source of truth (European→"european", American→"american"). On-chain write ONLY — frontend EUR/AMER badge deferred to Stage H (reads `vault.exercise_style` directly, not metadata). No backfill of legacy mints (default-on-read; missing key coalesces to European, accurate while flag is off). **Zero IDL delta.** Verified on-chain: 6052 `AmericanVaultsDisabled` canary confirms feature-free build; fresh post-deploy EUR mint (`9vFr2LX9…`, tx `4BLB7yDu…`) carries the pair + all 8 priors intact. First metadata-decode test added (`tests/zzz-metadata-exercise-style.ts`, EUR + AMER). Suite 95 pass / 0 fail / 67 pending.
- **Stage F — `exercise_american` instruction. SHIPPED to devnet 2026-06-06** (commit `c88fd7a`, opta slot `467614822`; hook unchanged). Holder-initiated early exercise: burns N tokens pre-expiry, pays capped intrinsic in USDC from the vault — **CALL `min(spot−strike, collateral_per_token)`, PUT `strike−spot`** (capped-call; the CRIT-4 cap enforced per-contract since there's no pool-level floor pre-settlement). Spot from a fresh `PriceUpdateV2` EMA read. First payout handler to sign via `vault_namespace_seed`. Records two new trailing `SharedVault` fields — `exercised_options` + `early_exercise_payout` — consumed by Stage G. `exercise_from_vault` seed fixed via `vault_namespace_seed` (European byte-identical). Partial exercise allowed; OTM rejected (`OptionNotInTheMoney`); new error `NotAmericanOption` (6053). `AMERICAN_ENABLED` still false until Stage I. Migration `migrate_shared_vault_exercise_tracking` ran (57 legacy vaults → 257; **all 58 vaults now unified at the 257-byte schema**, incl. the 14 ancient 204-byte pre-carry_rate ones). Verified on-chain: 6052 canary (feature-free), fresh EUR mint at a 257-byte vault, premium verbatim. Suite 100 pass / 0 fail / 69 pending. **Known interim:** exercise staleness is the loose 30d `PYTH_MAX_AGE` backstop — a tight `publish_time`-vs-now gate is a **Stage-I flip-blocker** (see Stage I), built + bankrun-tested in Stage G.
- **Stage G — Settlement American branch + test-infra + F→G handshake. SHIPPED 2026-06-06** (4 passes). Pass 1 — bankrun harness (`0969b67`, coexists with the validator harness). Pass 2 — money-logic, deployed devnet slot `467823489` (`7ba6364`): universal F→G handshake (`collateral_remaining = total_collateral − early_exercise_payout`; no `exercise_style` branch — European subtracts 0, byte-identical), the 4-site `vault_namespace_seed` payout-handler seed sweep, and the tight 60s `exercise_american` staleness gate. Pass 3a — clock-dependent suite ports to bankrun (`57b4a35`). Pass 3b — test-hygiene: contamination root-cause + `get_option_price` localnet conversion + dust-sweep (`d75dd8c`). Tests: **bankrun 33/0** (settle / auto-finalize / CRIT-1 24h / exercise / ring-wrap, all clock-controlled via `setClock`) + **validator 101/0/68**; every formerly-skipped clock-dependent + contamination test now runs deterministically. EUR byte-identical throughout; no production redeploy after Pass 2. **Closed 2 of the 4 Stage-I pre-flip blockers (staleness gate + all-handler seed sweep).**
- **Stage H — Frontend. SHIPPED to Vercel 2026-06-08** (commit `5b98825`, buildId `5b98825`, GREEN; FE-only, no program redeploy). Full American-options surface, **dark-launched behind `AMERICAN_ENABLED_UI = false`**, European byte-identical. EUR/AMER write toggle + American write path (premium=1 sentinel + 1.4M CU); EUR/AMER badge on both Portfolio ledgers; `exercise_american` early-exercise UI; Trade on-chain BS-2002 quote + realized-vol via `get_option_price`; shared `fetchOptionPriceQuote` util (manual `simulate` @ 400K CU + return-data decode — the `.view()` 200K ceiling CU-exhausts on the American PUT branch) + `useOptionPriceQuote` hook. Verification trail: Gate A (IDL byte-identical) → Gate B (`.view()` decode + 6051 proven) → flag-true builds green every phase → live eyeball (CALL + PUT render) → CU-ceiling bug caught at eyeball + fixed → clean flag-false shipping build → Gate C push. **Stage H COMPLETE.**
- **Stage I — `AMERICAN_ENABLED` flip. ← NEXT (only the flip remains, after the warmup ~2026-06-16).** The vol-push crank is **revived** (2026-06-09 — see §5). Pre-flip blockers: (1) **flag pair-flip** — Rust `feature_flags::AMERICAN_ENABLED` default `not(feature)` → `true`, deploy FEATURE-FREE (never `--features american-enabled`); FE `AMERICAN_ENABLED_UI` → `true`, push to `main` — **OPEN (the only remaining work)**; (2) tight `exercise_american` staleness gate (≤60s) — **DONE (Stage G)**; (3) `vault_namespace_seed` in all settlement payout handlers — **DONE (Stage G)**; (4) fresh audit over the American surface — **DONE (2026-06-09, 0 CRIT / 0 HIGH; all remediation shipped — MED-1/MED-2 + LOW-5 + `reset_vol_oracle`)**. The audit also surfaced and fixed a **vol-oracle pollution incident**: the ~10-day vol-gate outage left oracles stale, and on revival the first push recorded a 10-day move as one "hour" → ~1.7× σ inflation (AM-MED-2); fixed forward by the gap-reseed guard, and the existing pollution cleared by resetting **11 oracles** — clean 7-day warmup completing **~2026-06-16**. Two equity feeds parked (`80515916` dead zero-spot; `925ca92f` dormant). **MED-3 (accepted/deferred):** EUR mints require the `vol_oracle` ACCOUNT to exist (`mint_from_vault` loads it for the bump on both arms) → availability-only, UI-isolated by the `PHASE2_CUTOFF` filter; revisit with the European arc + ensure new markets get oracle-init at creation.

**Total remaining: ~9-11 weeks solo + audit turnaround.** (Stage B took 1 session vs the 3-4 week scope estimate.)

### Audit follow-up backlog (parked, not blocking Phase 2)

- **PART 1 HIGH-5 full proof-validation** for `migrate_pyth_feed` (`PriceUpdateV2` account + feed_id match). The zero-feed subset shipped; full validation deferred.
- **PART 1 MEDs (7), LOWs (10), INFOs (8)** — none blocking. MED-1 (Token-2022 raw-byte balance reads lack length+type validation) is the most concrete.
- **PART 2 LOWs (7 remaining), INFOs (6)** — none blocking.
- **Bankrun / litesvm test-infra adoption** — unblocks 3 skipped after-window CRIT-1 tests + future time-gated logic.
- **Test suite refresh** — **97 failing tests** (count updated 2026-05-22 from Pass 2's full `anchor test` run; previously framed as ~38 clock-skew failures). Root cause is broader than clock skew: the dominant failure mode is `Error: AnchorError caused by account: price_update. Error Code: AccountNotInitialized (3012)` — the Pyth `PriceUpdateV2` fixtures referenced by `tests/_pyth_fixtures.ts` are not being loaded into solana-test-validator. 19 direct `price_update` failures cascade to ~78 dependent test failures (anything calling `createMarket`, `initializeVolOracle`, `pushVolSample`, `settleExpiry`, or downstream vault flows). Pre-existing infrastructure rot; NOT regression. Adding Pass 2 changes contributed 0 new failure modes — the new `zzz-mint-from-vault-american-pricing.ts` is `describe.skip`'d pending fixture-rot fix. Estimated fix: fixture regeneration + bankrun/litesvm adoption (8-16 hours, Tier-2).
- **Devnet vol oracle coverage gap** — **12/439 markets have seeded VolOracles** (verified 2026-05-22 via `scripts/verify-vol-oracle-coverage.ts`). The 427 missing are stale pre-Phase-2 duplicates from earlier seed runs (9-asset seed in April, subsequent re-seeds). Functional impact: ANY direct CLI call to `mint_from_vault` against one of the 427 stale markets fails with `vol_oracle: AccountNotInitialized`. The live UI cannot surface these markets — `isPostPhase2Vault` policy filter (`PHASE2_CUTOFF_TIMESTAMP`) hides them entirely. Not user-actionable; documented for future Claude sessions evaluating whether the gap matters.

### Frontend gaps / small bugs (deferred to Stage H or later)

- **Vercel green at `fb31811`** as of 2026-05-19. Stage A FE follow-on (`12e3d8d`) wired the `carry_rate_bps` 6th arg; SharedVault migration cleared the legacy-vault drop. Local `npm run build` clean in 39.78s; only pre-existing warnings (crypto externalized, 500kB chunk, opta-whitepaper-slicer timing).
- Markets page shows "No markets yet" when an asset is registered but has no vaults.
- Indicative Premium panel renders `$0.00` for short-dated OTM options (sub-cent rounding).
- Stale market list on `/markets` after creating a market via AppNav (modal owns own state; Markets page doesn't refetch).

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

### Stage-I remediation decisions (2026-06-09)

- **MED-1 — cap the American settlement payout per-contract.** American CALL settlement now caps each contract at `collateral_per_token` (= strike), gated on `exercise_style`, reusing the early-exercise helper `exercise_capped_intrinsic` in `exercise_from_vault` + `auto_finalize_holders`. Rationale: a deep-ITM American CALL could otherwise extract `settlement − strike` (> strike) by racing settlement instead of exercising early — inconsistent with the early-exercise cap and the CRIT-4 per-contract bound. **European left uncapped-clamped + byte-identical** (its disclosure/cap question is pre-existing, parked for the European arc). `settle_vault`'s emitted aggregate is event-only and untouched.
- **LOW-5 — fail-closed `testing`-marker deploy discipline.** Chosen over a `production` marker because fail-closed: forgetting the marker breaks a *test* build loudly rather than silently shipping test code. Production builds are feature-free; the Stage-I flip is the `feature_flags.rs` default edit, never `--features american-enabled`. (See §3 + §11.)
- **MED-3 — accepted/deferred.** EUR mints depend on the `vol_oracle` ACCOUNT existing (the bump constraint loads it on both arms). Availability-only, UI-isolated by the `PHASE2_CUTOFF` filter — accepted; revisit with the European arc and seed oracles at market creation.
- **Vol-oracle reset over wait-it-out.** Rather than let gap-outliers age out of the 720-sample ring (up to 30 days), reset the 11 polluted oracles via the new `reset_vol_oracle` to start a clean 7-day warmup immediately. The MED-2 gap-reseed guard prevents recurrence.

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

**Phase 2 Stages A–H + exchange Passes A–D shipped; the Stage-I audit + all remediation are DONE (2026-06-09). The ONLY remaining work is the `AMERICAN_ENABLED` flip — trigger (REVISED 2026-06-15): BTC + ETH + SOL vol-oracles each `sample_count ≥ 168` (realistic flip ~2026-06-17 early UTC), NOT the old "all 11 reset oracles ≥168 / ~Jun 16" cohort gate.** Audit was clean (0 CRIT / 0 HIGH); MED-1/MED-2 + LOW-5 + `reset_vol_oracle` shipped. The **Later** / **Post-launch** lists hold deferred quality polish and the mainnet path.

### Immediate — the Stage-I flip-day checklist (one list; the trigger is the vol warmup COUNT, not the date)

All Phase-2 backend is shipped + dark (Stages A–H, exchange Phase 1 + Pass A series + Pass B peg + Pass C write-merge + Pass D hatch). Flip day runs this list top-to-bottom:

1. **Warmup gate (trigger, REVISED 2026-06-15):** run the read-only `scripts/check-vol-warmup.ts`; confirm **BTC + ETH + SOL each have `sample_count ≥ 168`** (a warm commodity like UKOIL — already 230 — is a bonus, not required). **The three crypto majors are the trigger — not the old 11-oracle cohort, not a calendar date.** Rationale: warmup is enforced **per-asset on-chain at mint time** (`realized_vol_annualized` → `VolOracleWarmup` until that asset crosses 168), so flipping `AMERICAN_ENABLED` only OPENS the surface — each asset self-gates. Equities push only during US market hours (weekend-gated, ~6.5 samples/trading-day) → ~4–5 weeks to 168; metals ~3 days; both light up per-asset post-flip and do NOT block the flip. Majors cross ~30–34h out (snapshot 2026-06-15: BTC 137 · ETH 134 · SOL 138) → realistic flip **~2026-06-17 early UTC**.
2. **Rust flip + deploy:** flip `feature_flags::AMERICAN_ENABLED` default `not(feature)` → `true`; **deploy FEATURE-FREE** via Helius (LOW-5 guard enforces feature-free — never `--features american-enabled`).
3. **FE flip:** `AMERICAN_ENABLED_UI` (`app/src/utils/constants.ts`) → `true`; push to `main` (auto-deploys Vercel). **Rust FIRST, then FE** — avoid an FE-on/Rust-off 6052 surface. (This FE push is also where `app/src/idl/*` finally syncs `create_series` + `fill_vault_peg` + `create_and_deposit`.) **FE arc gains (post-flip, the D8/D9 FE halves):** the Portfolio `withdraw_from_vault` button (D8 mid-life collateral exit) + the write-flow **3 tx → 1** collapse onto `create_and_deposit` (D9).
4. **Live-verify the dark surfaces:** Trade AMER preview, the "American" position badge, the early-exercise click-through — they render only off real AMER inventory, impossible on devnet until the flag is on.
5. **Runtime peg canary (deferred from Pass B):** a priced `fill_vault_peg` fill against a freshly created American vault + series — premium > 0, USDC conservation (vault_share + fee == total), `quantity` contracts minted to taker, counters advance. Unconstructable while dark (`create_shared_vault` American is flag-gated), so it lands here.
6. **Book × series live proof (deferred from Pass A):** `post_order` Bid on a real series mint + a fill — proves the mint-agnostic book trades series inventory end to end on-chain (bankrun series-create test 4 proves it deterministically today).
7. **Re-enumerate devnet vaults before/after the flip** for orphan American state (the inert husk `8RRJfQyf…` — empty + settled — is a no-op; confirm nothing funded appears). Prior pre-flip blockers already cleared: staleness gate + all-handler seed sweep (Stage G); audit + remediation (2026-06-09).
8. **Crank wallet top-up:** confirm the crank devnet keypair (`5sHZETYz…Gfqa`) has runway — burn continues post-flip; last balance ~5.9 SOL. Top up if needed so the vol-push + settle loops survive past the flip.
9. **Live-exercise the two peg-aware collateral gates (Pass C, deferred):** on a real American series + peg-backed vault — (a) a `mint_from_vault` that would over-commit the pool past `vault_free_collateral` must revert; (b) an LP `withdraw_from_vault` past the vault-level free must revert. Both are bankrun-proven (create-and-deposit tests 4–5) but **unconstructable while dark** (no American vault/peg can exist feature-free), so they land here.

### Later — Deferred quality/backlog

1. **Phase 2 Stage C Pass 2 (mint-time American pricing) — SHIPPED 2026-05-22** (opta slot `464159895`). `mint_from_vault` branches on `vault.exercise_style`; American branch loads `VolOracle` via `market.pyth_feed_id`, calls `realized_vol_annualized` + `american_call_price`/`american_put_price`, stores result in `VaultMint.premium_per_contract`. Frontend bumps to 1.4M CU on American mints (per Stage H wiring; today still EUR-only in UI). Live demo on all 11 feeds blocked until 2026-05-26 (warmup-gated).
2. **Phase 2 Stage C Pass 3 (view instruction) — SHIPPED to devnet 2026-05-24** (commit `ddddc07`, opta slot `464568346`). `get_option_price` returning `OptionPriceQuote { premium_per_contract, vol_used_scaled, spot_used_scaled, computed_at_ts }` via Anchor typed-return. EUR rejection path measured at 5,003 CU on devnet; AMER calculated at ~248K CALL / ~278K PUT. BTC oracle at 111/168 samples as of deploy; AMER end-to-end via `.view()` unblocks for that asset ~2026-05-26. Frontend integration into Trade-page preview deferred to Stage H. **Stage C COMPLETE.**
3. **HANDOFF cleanup** — current refresh covers the 2026-05-21 state; future sessions inherit corrected framing automatically.
4. **Crank operator setup** — superseded by the 2026-05-19 VPS deploy (see §5 Crank row). This item is closed; kept here as a sequencing reference.
5. **Demo video recording** if not already done — "wake up with USDC, no clicks" beat is the differentiated narrative.
6. **Test suite refresh** — fix 38 fixture clock-skew failures via runtime-relative timestamps + bankrun/litesvm adoption (4-8 hours, unblocks 3 skipped CRIT-1 after-window tests).
7. **PART 1 HIGH-5 full proof-validation arc** for `migrate_pyth_feed` (~250 LOC across 6 files).
8. **Frontend bug bash:** Markets-page-empty-when-asset-has-no-vaults, Indicative Premium `$0` display floor, AppNav modal stale-list refetch.
9. **Stale carry_rate migration warning cleanup** — `scripts/migrate-shared-vaults-carry-rate.ts:9-16` still says "DO NOT RUN until Stage C deployment"; now stale post-Pass-1. Quick 5-line cleanup; surfaced during Pass 1.

### Post-launch / mainnet path

5. **European on-chain pricing migration** (separate arc after Stage I; per locked Phase 2 decision, European stays untouched during Phase 2).
6. **Writer-side resale UX framing** — dedicated "Listings I've made" view on Portfolio.
7. **`withdraw_from_vault` mid-life uncommitted-collateral redemption** in writer dashboard.
8. **`auto_burn_unsold_escrow`** (or crank reorder) to close `burn_unsold_from_vault` post-finalize sequencing edge case.
9. **`USE_V2_VAULTS` flag retirement.**
10. X handle claim + social presence.
11. Fresh security audit covering post-Phase-2 codebase.
12. Mainnet deployment readiness.
13. **Switchboard 24/7 TradFi-feed oracle arc** (equities/commodities/FX/ETF, the "options on any asset" wedge + devnet UA campaign) — SCOPED 2026-06-15, see `.context/plans/switchboard-integration-scoping.md` (call held; devnet + 24/7 confirmed, no historical feed, coexist with Pyth).

---

## 11. Gotchas for a New Claude / Engineer

### Environment
- **All Solana scripts run from WSL**, not Windows. Keypair at `/home/nanko/.config/solana/id.json`.
- **Before `anchor deploy`, sync WSL `.so` files** — otherwise you'll overwrite devnet with stale binaries.
- **Devnet clock skew:** add 30-60s buffer when waiting for expiry in test scripts.
- **WSL `/tmp` doesn't persist between invocations.** Each `wsl bash -c` is a fresh session.
- **Solana CLI default RPC** is set to devnet. If a future session runs against localhost it will silently fail.
- **PowerShell 5.1 `Invoke-RestMethod` corrupts non-ASCII in JSON body strings.** Em-dashes, arrows, and other multi-byte UTF-8 chars get demoted to single-byte ASCII at the HTTP transport layer even when the in-memory source string is verifiably correct (confirmed via `[System.Text.Encoding]::UTF8.GetBytes($src)` hex dump pre-send). The corruption happens inside `Invoke-RestMethod`'s body serialization, not in `ConvertTo-Json` or the .NET string. Fix: send body as raw UTF-8 bytes — `$bytes = [System.Text.Encoding]::UTF8.GetBytes($json); Invoke-RestMethod ... -Body $bytes -ContentType 'application/json; charset=utf-8'`. Discovered 2026-05-24 during ClickUp Docs setup; cost 2 orphan docs + 3 API attempts before root-causing. Diagnose with `($resp.RawContentStream.ToArray())` hex-dump on the response side. Bonus ClickUp-specific gotcha discovered alongside: ClickUp v3 Docs API returns 405 on both `PUT /workspaces/{id}/docs/{id}` and `DELETE /workspaces/{id}/docs/{id}` — title updates and doc deletion are UI-only.
- **Commit from Windows git, NOT WSL — CRLF/LF.** WSL git and Windows git interpret line endings differently; WSL `git status` reports a phantom ~140-file "modified" set that is pure EOL interpretation, not real changes. Windows git (the canonical commit tooling) sees only the real changed files. Always stage explicitly named files and commit/push from Windows (PowerShell). NEVER run `git checkout` in WSL — it rewrites EOLs Windows git considers correct. `git diff --ignore-all-space` confirms edited files contain only intended lines. (Surfaced Stage E, 2026-06-06.)
- **Public devnet RPC throttles large program deploys.** `api.devnet.solana.com` 429-throttles and drops write chunks during `anchor deploy`, stranding a buffer (and SOL). Use the Helius devnet RPC for deploys (read URL from `~/.opta-rpc-helius`; never print it). After a failed public attempt, reclaim the stranded buffer (`solana program close --buffers`) to recover SOL. (Surfaced Stage E, 2026-06-06; recovered 7.81 SOL.)
- **★ UPGRADE BY PROGRAM ADDRESS, NEVER THE LOCAL KEYPAIR (Switchboard Stage 2, 2026-06-21).** `solana program deploy --program-id target/deploy/opta-keypair.json` **mints a brand-new throwaway program** when that local keypair's pubkey ≠ the live program ID (`CtzJ4MJYX6…`) — and it is `6ajEareb…`, not the live ID (a `cargo clean` regenerated it; same root cause as the earlier `anchor deploy` warning). Upgrades MUST target the live program **ADDRESS**: `solana program deploy --buffer <BUFFER_ADDR> --program-id CtzJ4MJYX6dC24tQuwRn6ddKkaE5L84z9Cq --upgrade-authority <5YRMuuoY id.json>` (an upgrade is authorized by the upgrade authority — the program keypair is NOT a signer). The robust path through Helius flakiness: **`solana program write-buffer target/deploy/opta.so --buffer <self-controlled keypair>`** (resumable across retries — re-running fills only missing chunks, no orphan; use `--max-sign-attempts 1000 --with-compute-unit-price 100000`), then `solana program deploy --buffer <addr>` against the live address. After ANY transient-Helius `write transactions failed` OR an accidental throwaway program, **verify the live program's `Last Deployed In Slot` is unchanged BEFORE retrying** (a reset can land zero on-chain effect — Pass-A discipline), then reclaim the orphaned buffer / throwaway via `solana program close <ADDR> --recipient <id.json> [--bypass-warning]`. This session reclaimed ~18 SOL that way (two ~9-SOL buffers + one 8.97-SOL accidental program). All RPC output redacted (`sed` the Helius URL); URL read from `~/.opta-rpc-helius`, never printed/committed.
- **★ PRODUCTION DEPLOYS MUST BE FEATURE-FREE (LOW-5 compile guard, 2026-06-09).** `programs/opta/src/lib.rs` has two `compile_error!` guards that **abort the build** if any of `{test-fast-vol, test-synth-vol, cu-profile}` OR `american-enabled` is set **without** the `testing` marker. So a clean `anchor build` (no `--features`) is the only deployable build. **Test builds MUST pass `--features testing …`** — wired into `package.json` `test:bankrun` and the gitignored `.test-fixtures/run-tests.sh`. The Stage-I American flip is the `feature_flags.rs:28` default edit **deployed feature-free** — NEVER `--features american-enabled`. This replaces the older "discipline-only / IDL-grep" never-deploy checks for the test features with a hard compile-time gate. (A `--features american-enabled` build now fails to compile by design — confirmed.)
- **bankrun coexists with the validator harness; `test:bankrun` self-builds.** Clock-dependent suites (settle / auto-finalize / CRIT-1 24h / exercise / ring-wrap) run under `solana-bankrun` (in-process SVM with `setClock`); the rest stay on `run-tests.sh` (real validator). `npm run test:bankrun` self-builds the test-feature `.so` first (`anchor build -- --features 'test-fast-vol american-enabled test-synth-vol'`), so it's immune to whatever build `target/` holds — important because the deploy gate leaves a feature-free build there. Bootstrap: `tests/bankrun/bootstrap.ts` (auto-loads both programs via Anchor.toml; Token-2022 + ATA are built into bankrun; Pyth `PriceUpdateV2` fixtures injected via `setAccount`, receiver not loaded since settle only deserializes). NOTE: `.view()` instructions can't sign under `BankrunProvider.simulate` — view tests stay on the validator harness with a synth-warmed oracle. (Stage G, 2026-06-06.)

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

### Stage H specifics
- **`get_option_price` via Anchor `.view()` caps simulation at 200K CU** and CU-exhausts on the American PUT branch (full McD-S BS-2002, ~270–280K). The American CALL at carry=0 slips under via the q=0 fast path (~30K, = European). Use a **manual `simulate` + `setComputeUnitLimit(400_000)` + return-data decode** (decision-4 fallback) — implemented once in `app/src/utils/optionPriceQuote.ts`, shared by the Write `LiveQuoteCard` and the Trade `BuyModal`. 400K covers the ~278K PUT worst case + future carry≠0 CALLs.
- **`AMERICAN_ENABLED_UI` (`app/src/utils/constants.ts`) is the FE mirror of the Rust `AMERICAN_ENABLED` flag** — both default false, both flip true together at Stage I (Rust deploys feature-free; FE pushes to `main`). The Rust flag is a compile-time const (not on-chain readable), so the FE cannot read it — hence the mirror. The const gates the Write toggle + the early-exercise button.
- **The Trade AMER preview, the early-exercise button, and a real "American" position badge are dark and visually unverified** until the Stage I flip — they render only off real AMER inventory, which can't exist on devnet until the Rust flag is on. The Write `LiveQuoteCard` AMER quote IS verifiable (vault-free via `get_option_price`) and was eyeballed live at Stage H.
- **`get_option_price` simulate uses `sigVerify:false` + a throwaway fee payer** (`PublicKey.default` fallback), so `fetchOptionPriceQuote` resolves even from the read-only (disconnected) provider — no signature popup. The original Anchor `.view()` path required `wallet.publicKey` for the fee payer; the manual-simulate fallback removes that. In practice the in-browser consumers (`LiveQuoteCard`) still gate the call on a connected wallet anyway.

### Stage-I remediation specifics (2026-06-09)
- **`reset_vol_oracle` (admin-only) is the clean-slate tool for a polluted/broken oracle.** It zeroes the ring + both accumulators + `sample_count` + `head` + `last_spot_price` + `last_sample_ts` (preserves `feed_id`), so the next push hits the seed branch and a fresh 7-day warmup starts. Used once (2026-06-09) to clear 11 gap-polluted oracles. The ring is zeroed in place via `iter_mut()` — NOT `samples = [0; 720]`, which would materialize a 5760-byte array on the ~4KB BPF stack.
- **`push_vol_sample` reseeds on a gap > 7200s (MED-2).** After a crank outage the first resumed push would otherwise compute `ln(new/last_spot)` over a multi-day gap and the estimator (which annualizes by `sqrt(8760)` assuming hourly spacing) treats it as one hour → a vol outlier persisting up to 30 days. The guard reseeds (spot+ts only, no sample). `VOL_ORACLE_MAX_SAMPLE_GAP_SECS = 7200` is **independent of `test-fast-vol`** (cadence-semantic, not a rate limit).
- **MED-1 cap is American-only and reuses the early-exercise helper.** `exercise_from_vault` + `auto_finalize_holders` cap the American per-contract payout at `collateral_per_token` via `exercise_capped_intrinsic`; the European arm is the unchanged uncapped match (only reindented — `git diff --ignore-all-space` shows the EUR logic is byte-identical). `settle_vault`'s `payout_per_contract` feeds only the emitted `VaultSettled` event and is intentionally untouched.
- **Equity-feed oracle edges parked (not reset):** `80515916` is a dead zero-spot feed (`VolOracleInvalidSpot` 6048 — reset won't help, the next push fails the same way); `925ca92f` is a dormant equity (the crank can't currently push past it). Both flagged for the equity/European arc.

### Testing
- **Two test runners:** `anchor test` runs full Mocha+Chai via `ts-mocha`. `run-tests.sh` is a thin wrapper with finer-grained control. Default to `run-tests.sh` for iteration.
- **Tests named `zzz-*.ts`** run last by mocha alpha ordering because they depend on earlier fixtures.
- **38 failing tests pre-Stage-A** — all fixture clock-skew, NOT regression. Tracked as Tier-2 work.
- **cu-profile + realloc tests** require explicit opt-in via `CU_PROFILE=1` env var. They don't run on default `anchor test`.

### Hermes / Pyth specifics
- **Mainnet Hermes is the default**, not Beta. Beta has guardian-set sync issues against Solana devnet's Wormhole Core Bridge.
- **`pyth-solana-receiver-sdk` does NOT expose `get_ema_price_no_older_than`** despite SDK skimming. Read the source manually.
- **Hermes historical endpoint is `/v2`.** Both latest (`/v2/updates/price/latest`) and historical (`/v2/updates/price/{publish_time}`) live on `/v2`. The `/v1` historical endpoint was **decommissioned in the 2026-05-20 Pyth cutover** (commit 126604d) and now returns HTTP 404 for *every* timestamp, recent or old. Do not use `/v1`.

### Anchor IDL
- **`anchor deploy` always re-uploads the IDL** even when bytes are identical.
- **`anchor idl fetch` re-orders JSON keys** vs `anchor build`-time emit. Use `python3 -m json.tool --sort-keys` on both before diffing.

### Code org
- **PDA seeds are string constants** repeated in both Rust and TS. `app/src/utils/constants.ts` mirrors the Rust seeds.
- **`USE_V2_VAULTS` feature flag** still gates UI to V2-only. V1 archived.
- **IDL regeneration** — every Rust instruction signature change requires `anchor build` + copy to `app/src/idl/`. After Stage A, frontend IDL drift is expected until Stage H.
- **Cross-package imports from `crank/` to `app/src/`** use `@app/*` tsconfig path alias.
- **The Phase 2 scope doc at `.context/plans/phase2-american-onchain-pricing-scope.md` is canonical** for all Phase 2 Stage planning. Don't re-decide locked items there without explicit user directive.
- **Cross-package imports from `crank/` → `app/src/*` require `app/node_modules` at runtime UNLESS `NODE_PATH` points at `crank/node_modules`.** Production VPS uses `NODE_PATH=/opt/opta-crank/crank/node_modules` in `/opt/opta-crank/.env` to sidestep this. If you ever do install `app/` deps on a deploy target, `app/package-lock.json` has a `Missing: ms@2.0.0` drift that rejects `npm ci` — use `npm install --legacy-peer-deps` and discard the lockfile rewrite, or fix the lockfile first.
- **SharedVault schema migration is operator-driven, not automatic.** `scripts/migrate-shared-vaults-carry-rate.ts` must be run after any Stage-A-class schema change. The docstring saying "DO NOT RUN until Stage C deployment" was overly conservative — the schema migration is self-contained and safe to run independently. **Lesson: never block a script run on a downstream stage that may slip.** (2026-05-19 incident: the docstring was honored too literally, so 41 legacy vaults silently dropped from the UI for 2 days post-Stage-B redeploy.)

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
- **B — On-chain realized vol oracle — SHIPPED** 2026-05-17 (devnet slot `463002816`). Vol oracles **11/11 seeded** as of 2026-05-19; warmup unlock dates **2026-05-24** (4 originals from Step 8 smoke) and **2026-05-26** (7 newer, seeded by the VPS crank's first organic tick at 11:42 UTC). Crank running persistently on Vultr VPS — see §5 Crank row.
- **C — Pass 1 (schema) SHIPPED** 2026-05-21 (commit `6c1551c`, devnet slot `463947205`). Added `ExerciseStyle` enum + `SharedVault.exercise_style` field + `b"shared_vault_american"` PDA seed namespace + `migrate_shared_vault_exercise_style` admin instruction + cu-profile-gated test scaffolding + 2 new test files. 31 SharedVaults migrated 240→241 bytes (tx sigs in arc memory).
- **C — Pass 2 (mint-time American pricing) SHIPPED** 2026-05-22 (devnet slot `464159895`). `mint_from_vault` branches on `vault.exercise_style`; American branch wires Stage A's BS-2002 + Stage B's `realized_vol_annualized` into the first production-handler call site. Required `vol_oracle` account uniform across EUR + AMER context (auto-derived from `market.pyth_feed_id` in IDL). New `AmericanPricingFailed` error (code 6050). Risk-free rate parked at 5% module const. Devnet smoke verified both branches (AMER preflight-reverts `VolOracleWarmup`; EUR mint at strike $402 stored premium $42 verbatim, tx `5cJG6P3MFYqYCCqq5rUv8ogNx1EKZiYgK3dyMV7EpzSmsgk2QfHpssf7ARFPJWc1DdY3NNhfWvP8Tn8DEwJSjaWK`).
- **C — Pass 3 (`get_option_price` view) SHIPPED** 2026-05-24 (commit `ddddc07`, opta slot `464568346`). First Anchor typed-return instruction; CPI `OptionPriceQuote` view; EUR returns `ViewNotSupportedForEuropean` (6051). **Stage C COMPLETE.**
- **D — American vault instructions SHIPPED** 2026-06-05 (opta slot `467317459`, commit `302ce6e`). `vault_namespace_seed` seed-helper fix + `AMERICAN_ENABLED` gate (default false) + error 6052. EUR byte-identical; American reverts 6052 until the Stage I flip.
- **E — Token-2022 metadata `exercise_style` — SHIPPED** 2026-06-06 (commit `3f5d06e`, devnet slot `467548106`)
- **F — `exercise_american` instruction — SHIPPED** 2026-06-06 (commit `c88fd7a`, devnet slot `467614822`; 57 vaults migrated → 257, all 58 unified)
- **G — Settlement American branch + test-infra — SHIPPED** 2026-06-06 (4 passes: bankrun harness `0969b67`; money-logic devnet slot `467823489` `7ba6364`; clock-suite ports `57b4a35`; hygiene `d75dd8c`). Universal F→G handshake + all-handler seed sweep + 60s staleness gate; bankrun 33/0 + validator 101/0/68. Closed Stage-I flip-blockers 2+3.
- **H — Frontend — SHIPPED** to Vercel 2026-06-08 (commit `5b98825`, buildId `5b98825`, dark-launched behind `AMERICAN_ENABLED_UI = false`; EUR byte-identical).
- **I — `AMERICAN_ENABLED` flip ← NEXT (only the flip remains, after the ~Jun 16 warmup).** Sub-milestones DONE 2026-06-09: vol-push crank revived (§5); **full American-surface audit — 0 CRIT / 0 HIGH**; remediations shipped (MED-1 settlement cap + MED-2 gap-reseed + LOW-5 deploy guard + `reset_vol_oracle`, opta slot `468290108`, `master`/`main` at `5b2cbf8`); 11 polluted oracles reset → clean 7-day warmup. Staleness gate + seed sweep were done in G. Remaining pre-flip = **just the flag-flip**.

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

- **Latest (2026-06-15): Exchange Pass D (`reclaim_unsettled` dead-feed hatch + voided gating) DEPLOYED dark to devnet — slot `469592830`, `38` production instructions, `master`+`main` at `71b4373`.** Additive, no schema delta, feature-free, European byte-identical. **Flip trigger REVISED: BTC + ETH + SOL vol-oracles each ≥168 (realistic ~2026-06-17 UTC)** — per-asset on-chain warmup gating makes flipping safe with only the majors warm; equities (market-hours gated, ~4–5 wk) and metals (~3 d) self-gate per-asset post-flip and don't block. See §10.
- **Stage-I remediation COMPLETE (2026-06-09); only the flag flip remains, after the BTC/ETH/SOL warmup (~Jun 17).** Phase 2 Stages A–H all shipped. This session: revived the vol-push crank, ran a **full American-surface audit → 0 CRIT / 0 HIGH** (money-conservation invariant proven), and shipped four fixes to devnet + `master`/`main`: **MED-1** (American settlement per-contract cap), **MED-2** (vol gap-reseed guard), **LOW-5** (fail-closed `testing`-marker deploy guard — production builds MUST be feature-free), and **`reset_vol_oracle`** (new admin instruction). 11 gap-polluted oracles reset → clean 7-day warmup to ~Jun 16. `AMERICAN_ENABLED` still false; European byte-identical.
- **Deploy discipline (LOW-5):** a `compile_error!` guard refuses to build a deployable artifact carrying any test/dev feature or `american-enabled` without the `testing` marker. Production = feature-free `anchor build`; tests = `--features testing …`. The Stage-I flip is the `feature_flags.rs` default edit deployed feature-free.
- **Opta** is a permissionless options primitive on Solana: Token-2022 "living" option tokens, any-asset markets via Pyth, V2 shared-vault liquidity, permissionless auto-finalize, on-chain BS-2002 American pricing + a permissionless realized-vol oracle.
- **Live on devnet** with frontend on Vercel (`opta-solana.vercel.app`, buildId `5b98825`). opta redeployed twice this session → slot **`468290108`** (was `467823489`; chain `468260768` → `468290108`), opta_transfer_hook unchanged `464160129`.
- **Phase 2 Stages A–H + exchange Passes A–D all SHIPPED; the Stage-I audit + remediation are DONE.** Stage I (NEXT) = **only the `AMERICAN_ENABLED` flip**, after the BTC/ETH/SOL vol warmup (~Jun 17).
- **Vol-push crank — revived 2026-06-09.** It was never down/drained: the settle loop ran throughout; only the vol-push side-loop was gated off (`OPTA_VOL_CRANK_DISABLED`) for cost during Stage H, which is why the oracles went stale. Now pushing again; the 11 gap-polluted oracles were reset → clean 7-day warmup to ~Jun 16. Wallet **9.53 SOL** (~11–12-day runway, covers the warmup — no top-up needed). See §5.
- **Stage I flip (the only remaining work):** Rust `AMERICAN_ENABLED` default → true (deploy feature-free) + FE `AMERICAN_ENABLED_UI` → true (push to `main`, Rust first). Single FE const lights up the Write toggle + early-exercise. Staleness gate + seed sweep done (Stage G); audit + remediation done (this session).
- **Programs ID:** opta `CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq`, transfer hook `83EW6a9o9P5CmGUkQKvVZvsz6v6Dgztiw5M4tVjfZMAG`.
- **Branches:** master + main mirrored at every commit (`master:main` refspec); both at `5b2cbf8` (Stage-I remediation; range `e55db39..5b2cbf8`).
- **Biggest gotcha:** the protocol runs on Solana devnet but uses Pyth's mainnet feeds. "On mainnet" ≠ "Solana mainnet" — protocol is devnet; only the price oracle endpoint is production.

---

## Off-hours oracle proof — quotes.opta.fyi 503 both legs (2026-07-18 15:49Z, Sat)

Captured over REAL public TLS transport (not the 127.0.0.1 loopback svc): off-hours,
both `quotes.opta.fyi` legs return HTTP 503 and produce NO value. This is the
oracle-layer backstop the `opta-writer` bot relies on for equity market-hours
(alongside the client `isMarketHours` gate) — off-session equity writes fail clean.

Time of capture: Sat 2026-07-18 15:49Z (NYSE closed, weekend). Symbols TSLA/AAPL/NVDA,
identical result on all three:

- finnhub leg  `GET /finnhub/quote?symbol=SYM`  -> **503**  `{"stale":true,"ageS":~71393}`
- yahoo leg    `GET /yahoo/chart/SYM`           -> **503**  `{"stale":true,"inRegular":false,"ageS":~71394}`

`ageS ~71,393s (~19.8h)` = since Fri ~20:00Z NYSE close. FRESH_MAX (180s) exceeded on
both legs; Yahoo additionally `inRegular:false`. No `regularMarketPrice`/`c` field is
returned -> the SB equity feed gets no signed value off-hours (`minJobResponses=2`, so
one stale leg fails the whole feed) -> equity settle/quote has no input until the
session reopens. Proves the "fail clean, not cryptic" off-hours enforcement end-to-end.

---

## Wave-2B Gate 1 — SPCX + HOOD locked + QUOTES_CACHE_TTL 20s (2026-07-18)

**Manifest signed off** (computed off the FROZEN quotes.opta.fyi scheme, zero edits; recipe self-verified by recomputing all 11 frozen hashes byte-for-byte):

| Ticker | feedHash (64-hex, lowercase, no 0x) | seed σ | basis |
|---|---|---|---|
| SPCX | `fd7a0b9ea922e14e18944f8105b151df922487da9b1b2ed5ad52150924ed413f` | 1.00 | fresh Nasdaq IPO (Jun 12 2026), thin history → seed HOT; `reset_vol_oracle` = mid-warmup repair lever |
| HOOD | `9801bc9a0cc3eceb1ec4dfb964186a426883bb89a670c5968879b6e2c31b7c8b` | 0.65 | full history since 2021 IPO; high-beta fintech, realized-derived, just under COIN (0.75) |

- Both **PURE BIRTHS** (assetClass=2): zero `SPCX`/`HOOD` refs in app/crank/registries/frozen-11 → no market-PDA or vol-oracle-PDA collision. Birth via `crank/_birth_sb_market.ts` (skip migrate/close leg), then `initialize_vol_oracle` with the locked seeds. Writer bot discovery auto-picks them up next tick once scale-up is live.
- HOOD has an upstream Pyth feed we deliberately do NOT use (SB-only, per the Pyth freeze).
- **Execution:** Monday, immediately after the 11 land — same session if clean, else standalone 2b.

**QUOTES_CACHE_TTL bumped 15s → 20s** (preemptive rate lever) on the VPS `opta-quotes` service. Finnhub tier confirmed FREE (60/min real). 13 tickers now refresh at 3×/min = **39 Finnhub calls/min** (was 52/60). Applied: `QUOTES_CACHE_TTL=20000` in `/opt/opta-quotes/.env` + `systemctl restart opta-quotes`; verified `/healthz` 200, effective process env = 20000, public endpoint serving (off-hours 503 as expected). Bump back toward 15s only if Wave-2c shrinks the set.

---

## PERMANENT RULES from the 2026-07-20 full-board session

**RULE 1 — DEPLOY VERIFICATION. Never hot-patch the box.**
Every VPS deploy MUST assert that git `HEAD` *and* a boot-log marker match the
intended commit. Do not trust `git pull` output or a green `npm run build`.

Tonight's failure mode: someone edited `/opt/opta-crank/writer/src/engine.ts`
directly on the VPS (stale-pull fix, `.bak` left alongside). That local
modification silently **blocked every subsequent `git pull`** ("local changes
would be overwritten … Aborting") while `npm run build` still reported success —
because it recompiled the *stale* source. HEAD sat at `117176a` for two days, so
`globalVaultCap=500` and the committed stale-pull fix were **never actually
live**. The deploy reported green and did nothing.

Detection that worked: a boot-log field that only exists in the new build.
Remediation: diff the hot-patch vs `origin/main` FIRST (confirm nothing
VPS-only would be lost), `git checkout -- <file>`, then pull + rebuild + restart
and re-assert the marker.

**RULE 2 — Cap allocation is enumeration-order dependent.**
`MAX_CELLS` / `globalVaultCap` are throttles, NOT prioritizers. Whichever markets
`getProgramAccounts` returns first consume the cap. Proven live: at cap 55 the
board filled JTO 20 / WIF 15 / XRP 12 (BTC/ETH/SOL got nothing); at cap 100 it
filled JUP 20 / SOL 20 / WIF 5. Never rely on a cap to prioritize a market or to
starve a class — and note the USDC budget is ONE shared pool that only skips a
cell when that single cell exceeds the whole remaining balance, so it does not
ring-fence a per-class buffer either.
**Class/ticker denylists (`OPTA_WRITER_EXCLUDE_CLASSES` / `OPTA_WRITER_ASSETS_EXCLUDE`)
are the only real scoping mechanism.** They are evaluated before the allow-list and
survive `assets=null`.

### Full-board state at end of session
`assets=null`, exclude `SBXAU` + classes `2,4`. Board saturated at **180 asks =
9 SB assets x 20** — the binding cap is `maxCellsPerAsset=20`, NOT `MAX_CELLS`
(so "200 crypto" is really 180). All src=1; Pyth guard skipping EURUSD/HYPE/RAY/
UKOILSPOT/USDPKR/USOILSPOT/XAG. SBXAU verified 0 orders on-chain (single gold book
via XAU). USDC $1,535,631 locked / $139,367 free. SOL 4.94. strand=0 throughout.

---

## OPEN QUESTION — is the stranded-vault case a CLASS or a one-off?

Recorded because the local scratch probe that asked it (`crank/_probe_vault_anomaly.ts`)
was deleted on 2026-08-07: it never compiled, and it was blocking every `crank/`
commit behind `--no-verify`.

Its diagnostic value was one scan the rest of the tooling does **not** reproduce:
*vaults with `total_shares > 0`, **zero** WriterPosition accounts, and `vault_usdc > 0`* —
i.e. collateral with no writer to claim it. It was written for vault
`2gjf5cyHCv4JMXP7DPNwxcqJE85mRvQ78DeuCMj9Ykyn` ($100 stranded).

**The Session-H recovery scan used a DIFFERENT predicate** (expired + unsettled +
`tvl>0 or premium>0`) and found 2 tuples / 3 vaults. Those two predicates do not
have to agree, so the class question is **still open**: there may be vaults with
orphaned collateral that the recovery scan never looked at.

Worth one clean read-only pass when someone next has RPC budget to spend. The
probe body is not worth resurrecting — it used `p.account.sharedVault.fetch`,
which is exactly the Anchor typing that made it fail to compile.

---

## PROOF — the 2026-08-06 RPC outage lost NO tape data (window enumerated)

**Window: `2026-08-06T18:21:35Z` -> `19:52:47Z`, 91 minutes.** Enumerated from
chain against BOTH the opta program and the transfer hook, cross-checked on
Helius AND public devnet. Both agree exactly:

> **ONE signature in the entire window**, at 19:52:47 (the boundary), already in
> the tape with its event decoded. **Zero program transactions occurred during
> the outage.** Nothing was lost. No backfill was needed or performed.

### The trap, recorded so nobody falls in it twice

The tape showed eight consecutive empty 10-minute buckets, and the first report
of this incident estimated **~1,725 missing transactions** by extrapolating the
pre-outage rate (1,135/hr) across the gap. **That was wrong.**

That rate is almost entirely generated by our OWN bots — writer, crank, taker,
trigger — and every one of them was down with the same 503s for the same 91
minutes. The empty buckets meant *nothing happened*, not *data was lost*.

**Absence of records is not evidence of failed ingestion when the things that
generate the records were themselves down.** Enumerate the window from chain
before reporting a gap size — it is one query and it is the only thing that
distinguishes the two cases.

---

## TICKET — trigger-placement UI carries a REVERT obligation (TRIGGER-UI-REVERT)

The Trade trigger-placement UI is a parked FE slice (HANDOFF "Next candidate FE
slices"). Whoever picks it up **must also revert the trigger crank tick from
5min back to 15s** in the same change.

Why the two are bound together. On 2026-08-07, after the Helius credit
exhaustion, `DEFAULT_TRIGGER_TICK_MS` was widened 15s -> 5min. The measured
justification: the trigger crank was issuing **5,720 getProgramAccounts/day —
98.6% of all gPA traffic on the key** — while every tick logged
`triggersFound: 0`. That was free to widen ONLY because the placement UI does
not exist, so no user can arm a trigger and no stop can be late.

**The moment placement ships, that reasoning inverts.** A stop that fires up to
5 minutes late against a real user trigger is a product defect. The saving was
borrowed against a feature that did not exist yet; shipping the feature repays it.

Grep `TRIGGER-UI-REVERT` — it appears in `crank/triggerCrank.ts` beside the constant
and here. Both must change together.

---

## RULE 6 — `freeze --check` is a DEPLOY-time gate, not a local one (2026-08-08)

FROZEN.json pins hashes of `indexer/dist/**` — **compiler output**. Those bytes
depend on the toolchain that produced them, so the byte check only means
something where the deployed build is produced: VPS preflight and the boot gate.
It is green there. On 2026-08-08 the live gate logged `score weights verified
against freeze, gitTag: rules-v1.1-frozen, artifacts: 7`.

The same check run from a Windows/WSL working copy reports all 7 dist artifacts
drifted, from a CLEAN tree with zero indexer changes. That is **toolchain noise,
not weight drift** — the source-level artifacts match, and `git status` on
`indexer/` is clean. Do not chase it, and do not re-freeze to silence it:
re-freezing from a local build would overwrite the manifest the VPS verifies
against and break the boot gate on the next deploy.

So the pre-push gate locally is the SEMANTIC one — the scoring deep-equal plus
the test suites. The byte gate runs at deploy. If you want the byte check to be
meaningful locally, the fix is to pin the compiler/Node version or to freeze
SOURCE hashes rather than emitted JS; until then a local FAIL is expected and
proves nothing.

---

## RULE 5 — two standing facts from the 2026-08-07 maintenance audit

### The crank settles TUPLES, not vaults. 2,184 vaults depend on someone clicking.

`settle_expiry` writes the per-(asset,expiry) SettlementRecord and the crank
stops there, deliberately — `settleGuardJul31.ts` says so outright: *"the guard
settles TUPLES, not vaults: one settle_expiry per tuple makes every vault at that
(asset,expiry) settleable."* The per-vault fan-out is `settle_vault`, which is
**permissionless, oracle-free, has no deadline — and has exactly two callers,
both in the frontend.** The crank never calls it.

**There is no `options_minted == 0` skip anywhere.** The only guard in the fan-out
path is `!v || v.isSettled`. Vaults sit unsettled because nobody has clicked, not
because anything filtered them — and until Session C removed the BLK-9
oracle-source filter, the UI was not even listing the 45 record-backed tuples.

So **2,184 vaults currently depend on a human opening /portfolio → Utilities and
pressing settle.** That is a real operational gap, not a bug: holders cannot claim
and writers cannot withdraw until someone does it. If it should be automatic, the
fix is a crank job that watches for SettlementRecords and fans out — not a change
to the settle instructions, which already work.

### VPS working-tree "drift" is CRLF-only. Compare NORMALISED, or you will chase ghosts.

`/opt/opta-crank` sits at an old HEAD with a hand-built index, because the deploy
is a path-overlay, not a checkout. A raw `git status` there shows ~128 entries and
reads like heavy drift. It is not:

- `crank/`, `writer/`, `deploy/` — **0 files differ from origin/main**
- of the 16 `indexer/` files listed, **10 differ by exactly 0 lines** — line
  endings only
- EOL-normalised shas MATCH origin/main and the frozen manifest: `rules_v1.ts`
  box `990bcf013d2de94c` = origin `990bcf013d2de94c` = the `FROZEN.json` source
  hash
- the files that look "deleted" are untracked in the stale index; they exist and
  are correct

**Future drift audits must compare EOL-normalised content**
(`tr -d '
' | sha256sum`), not `git status`. And do NOT reconcile by resetting:
that would destroy the deployed `dist/` overlays and risk all seven live units to
fix a cosmetic index. `freeze --check` 9/9 is the real proof the bytes are right.

---

## RULE 4 — simulation and analysis run on COPIES; live points.db is service-owned (2026-08-05)

**The live `/opt/opta-indexer/points.db` is written by the deployed indexer service
and by explicitly greenlit migrations. Nothing else.** One-off analysis or
simulation scripts against live projections are now in the same class as flag
flips: **propose-before-execute**.

Why this exists. During the W2/O7 amendment session, two "simulation" recomputes
were pointed at a copy with `OPTA_DB_PATH=/tmp/simA.db`. The indexer reads
**`OPTA_INDEXER_DB`** (`env.ts:88`). The unknown variable was silently ignored,
`loadConfig()` fell back to the default state dir, and both runs recomputed the
**live production database** with an unreviewed, unfrozen build. Blast radius was
nil — the amendment is inert without backfilled tape rows, and every one of the 8
point columns across all 35 wallets was afterwards proven byte-identical to a
fresh v1 recompute on the same tape — but that was luck, not design.

**Two habits this session earned, both non-negotiable:**

1. **Print the resolved path, do not trust the knob.** Any script that takes a DB
   must echo `path.resolve(loadConfig().dbPath)` before it writes, and assert each
   copy's mtime moved. A knob you have not proven connected is not a knob.
2. **A negative result requires a positive control.** Sim A ("no retroactive
   effect") and Sim B ("no effect even with backfill") both returned a 0-diff —
   which is also exactly what a completely broken harness returns. The result only
   became evidence once a deliberately-detectable control (an injected
   `IxSettleVault` for an external wallet in a clean week) produced the expected
   non-zero. **If your control cannot go red, your zero means nothing.**

**Do not use file mtime as the "live untouched" invariant.** The indexer writes
`points.db` continuously as it indexes the tape, so mtime moves on its own and
produced a false alarm on the first run of the fixed harness. The precise
invariant is **`wallet_points.computed_at`**, which only `recompute` stamps: if it
lands inside your run window, you wrote to live.

---

## RULE 3 — no loose WIP in the shared tree; unauthored state is untrusted (2026-07-21)

This clone's working tree is shared by multiple concurrent agent sessions. Loose
uncommitted edits are indistinguishable from finished work.

1. **Never leave uncommitted WIP in the shared tree.** Commit it to a branch or
   `git stash` it. If it is not committed, another session cannot tell it is
   half-done.
2. **Treat tree state you did not author as UNTRUSTED.** Before building on it or
   committing it: `tsc --noEmit` **and** run the suites. Do not assume it compiles.

**Incident that produced this rule.** The writer churn fix (strike hysteresis +
reprice ε-skip) was found as uncommitted WIP in the shared tree. It **did not
compile** — `vaultStrike` undeclared, `REPRICE_EPSILON` undefined — and
`existingStrikes` was never passed to `buildLadder`, so the hysteresis was
entirely **inert**. It was nearly shipped. Note the commit gate never failed:
`git log -S` confirms those symbols appear in exactly one commit (`d1d0471`), so
the broken code was never committed and never reached the box. The gap was loose
WIP, not a bypassed gate.

**Enforcement — pre-commit compile gate** (`.git/hooks/pre-commit`, local to this
clone, therefore covering every session that uses it). Staging `writer/src/*.ts`
or `crank/*.ts` runs `tsc --noEmit` in that project and BLOCKS the commit on
failure (`git commit --no-verify` to override deliberately). Verified both ways:
green tree passes; an injected type error blocks with the diagnostic.
`crank/bs58.d.ts` was added so `crank` type-checks clean (bs58 v4 ships no types)
— a red gate would have blocked every session's crank commits.

**Known limitation:** the gate skips (warns) where `node_modules` is absent —
notably the `origin/main` worktree used for HANDOFF/main commits. So the primary
discipline stands: type-check and run the suites in the local tree BEFORE copying
files into the worktree to commit.

### Queued: rent-reclaim sweep (Aug-7 void-sweep session)
Writer churn minted **657 empty 0-pool SharedVault shells** (board never exceeded
~180). A cancel refunds only the order+escrow rent; the series mint/record/hook
accounts and the vault+vault_usdc are never closed by it — ~0.020 SOL per wobble,
permanently. That, not fees, is what drained the writer wallet (~9 SOL).
`close_settled_writer_ask_vault` can reclaim the vault rent but requires the vault
to be SETTLED — so run it **after the Jul-24 and Jul-31 settlements**, folded into
the Aug-7 void-sweep session so all scavenging happens in one sitting (~3 SOL+).

### Funding-STOP metric (added)
Alongside measured burn SOL/h, report **shells-created-per-hour post-fix** — it
should be ~0 outside genuine spot moves. Burn/h alone shows the bleed *slowed*;
shells/h ~0 is the direct proof the permanent-rent bleed is **dead**.

---

## DISCIPLINE (adopted 2026-07-30) — the ledger rule for MULTI-AGENT operation

**Applies to every agent and every session, not just this one. Relay it.**

Several agents operate this repo, this workstation and the VPS concurrently, with
legitimate keys. That is normal. What is not normal is finding out about it from
chain forensics.

### 1. Every fund movement gets a ClickUp entry AT EXECUTION TIME
Amount, source→destination, purpose, session identifier. Written when the
transfer is sent, not batched afterwards.

**An unledgered movement is an INCIDENT by default** and gets investigated as one
until proven otherwise. That default is deliberate: the cost of a wasted
investigation is an hour; the cost of ignoring a real drain is the treasury.

### 2. Program upgrades additionally require a PRE-announce
A `solana program deploy` against `CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq`
invalidates any live canary and re-bases every running service. Announce BEFORE
the buffer is funded, naming the commit and the expected downtime window. Check
for running canaries first.

### What triggered this (worked example)

2026-07-30. A parallel agent needed ~11.56 SOL per deploy buffer, admin held
~3.56, so it moved **8.0000 SOL writer → admin at 15:28:25Z** and upgraded the
program at **16:28:53Z** — 24 minutes into a live writer-bid canary that had been
greenlit specifically because a previous attempt failed.

Reconstructing that cost a full forensic pass: transaction decode, VPS auth/cron/
timer/service audit, a 7-day cross-wallet movement scan, and finally a byte-level
match of the deployed program against the local `target/deploy/opta.so`. The
conclusion — legitimate agent, own keys, no compromise — was reached only after
seriously entertaining key exposure and drafting a rotation plan.

**One ClickUp line at 15:28:25Z would have replaced all of it.**

Two forensic lessons worth keeping:
- `auditd` is NOT installed on the VPS, so there is no process-level attribution.
  Chain-of-custody conclusions are inferential. Consider installing it.
- `atime` is useless for proving keypair reads — `relatime` only updates atime
  when it is older than mtime or >24h stale.

### DISCIPLINE (2026-07-30) — a monitor must prove it can see a nonzero signal

Same rule as "a regression test must fail against the known-broken state". A
measurement query that errors, mis-scopes, or matches nothing does not report
"nothing happened" — it reports **success**, and success is what you were hoping
for. That is the whole trap.

**Before believing a zero, make the query produce a nonzero.** Point it at a
window you know has activity, or invert the predicate, and confirm the count
moves. Only then is a zero evidence.

Three instances in one week, all mine, all initially read as clean results:

| # | Query | Failure | Read as |
|---|---|---|---|
| 1 | `grep -ci "bid.*fail\|...\|cross"` | matched unrelated crank sweep errors | 4 phantom bid errors/tick |
| 2 | Mutation harness `run()` | bash `local` is dynamically scoped — `restore()`'s `for f` clobbered `run()`'s `local f`, so every mutation hit the LAST file in the list | "16 SKIPs" — an entire result set that tested nothing |
| 3 | `journalctl --since "…T18:07:48Z"` | ISO `Z` suffix is unparseable; use `"2026-07-30 18:07:48"` | 7 consecutive samples of all-zero bid activity — 9,398 journal lines were in that window |

Instance 2 is the sharpest: it would have certified an untested safety framework
as "20/20 mutations caught". The only reason it surfaced was that SKIP was
printed rather than swallowed.

**Corollary:** make monitors print what they scanned (line counts, row counts,
window bounds), not just what they found. Instance 3 was caught by one stray
`Failed to parse timestamp` line that happened to reach stdout.

### DISCIPLINE EXTENSION (2026-07-31) — the ledger covers LIVE-SURFACE state too

The ledger rule adopted 2026-07-30 named funds and program upgrades. Extend it:
**any change that alters what the outside world can see or receive** gets a
ClickUp entry at execution time, naming the flag, the old and new value, the
reason, and the session.

That includes, non-exhaustively: `REPLY_DRY_RUN` / `REPLIES_ENABLED` on
opta-tweet, `OPTA_TAKER_ARMED` / `OPTA_TAKER_DRY_RUN`, `OPTA_WRITER_BID_ENABLED`,
`VITE_EPOCH0_UI`, and any nginx route exposure. Funds and program bytes were never
the point — **irreversibility** was. A posted tweet is not revertible by editing a
file.

**Worked example.** At 13:54:23Z an automated session on this workstation flipped
`REPLY_DRY_RUN=false` and restarted opta-tweet. It was competent work — backup
first, edit, restart — and it was unledgered. Five minutes later, at 13:59:45Z, a
different session (me) wrote the ClickUp entry recording that the reply lane
**stays in shadow through launch week** and flips only after ~10 accumulated
drafts. Two sessions, five minutes apart, moving the same switch in opposite
directions, neither aware of the other.

One reply went out live before the revert: `2083202301074853964`. It was a good
reply — correct, on-voice, on our own thread — which is precisely why this is
worth writing down. The failure was not bad output. The failure was that the
10-draft gate was decided, committed (`8c456b9`), and silently overridden, and the
only reason anyone noticed is that Nanko happened to see a reply in the wild.

**Corollary for agents sharing this environment:** before flipping any live-surface
flag, read the current GO-LIVE checklist and grep HANDOFF for the flag name. If a
gate exists, the gate wins — take it up in ClickUp rather than in `.env`.

---

## TRIGGER ARC CLOSED — 2026-07-31

The trigger order arc (B0 → B4 scaffold) is complete through the live buy canary.
`execute_trigger` routes fires to the BOOK on both tapes, in production.

**What shipped**
- **B1.5** (`bf8a6a0`) keeper book discovery: `enumerateAsksForMint` (gPA by
  discriminator + option_mint) → `selectBestAsk` bounded by the trigger's
  per-contract ceiling → `assembleBookAccounts`. Before this the keeper hardcoded
  all eleven book optionals to null, so `BOOK_TRIGGERS_ENABLED` was unreachable —
  routing is `flag && book_order.is_some()`, and the flag alone was a no-op.
- **FLIP** (`6b04606`) deployed **slot 480011440**, hash-verified byte-exact. The
  prod artifact grew 1,632,896 → 1,660,384 B: with the const false LLVM had
  dead-code-eliminated both book arms.
- **B1.6** (`ec24721`) ALT'd the fire. Legacy book fire + SB ed25519 quote
  measured **1305 B** against the 1232 limit; resolving the static set through
  table **8DhpYaktjhBLeEqQY1151yphbvSoFGkT8BmFUN36X464** brings it to **1031 B**
  (274 B saved, 201 B headroom). Keeper suite 76/0.

**Canary — fired end-to-end on live board liquidity**
`QJJgQUnh9Rqtc8u9S6CMKjSSNsnRhLwN9ormtQf5JepPucqMydYwbeGfgeGp64sUVcmPfmLQrz38CrSrzWrzcnC`
slot 480231064, v0 tx with 1 ALT lookup, SB tape, `route:"book"`.
Conservation zero-residue: +1 contract minted to the founder; pot 0.968 → 1.936
(= strike × 1); ask 2066 → 2065; maker +9001, treasury +45 (= 1 × ask 0.009046,
fee = floor(9046 × 50bps)); escrow 20000 − 9046 = 10954 refunded; trigger and
escrow closed, rent to owner. Keeper is production-viable on both tapes.

### Lessons — carry these forward

1. **`str.replace` patching is BANNED.** Three separate silent no-ops this arc
   (a print block, a commit message, the ALT env-read that then shipped to the
   VPS half-wired). Python's `str.replace` returns the input unchanged on a miss
   and the script happily prints success. Use real edits with match verification.
2. **Every env-read wire needs a gate.** The ALT suite was green while
   `cfg.alt` was never populated from the environment, because no test asserted
   the env → config path. A gate that cannot see the wire is not covering it.
3. **One writing session at a time.** VPS `.env` flips and service restarts get
   an immediate ClickUp checkpoint; a parallel agent enabling writer bids
   mid-session invalidated a stated safety premise ("the bid side is empty")
   without anyone noticing until a board read contradicted it.
4. **`--max-sign-attempts 200` is the devnet deploy fix**, not priority fees.
   Four deploys died on write-throughput with `--with-compute-unit-price`; the
   fifth landed first try with the raised sign-attempt budget. Each failure
   orphans a rent-exempt buffer — check `solana program show --buffers`.
5. **Canary expiry must outlast plausible outages.** The B1-era canary series
   expired mid-arc and forced a re-target; pick expiries weeks out, not days.
6. **The ALT is at 250/256.** It works, but it cannot grow. Rebuild lean
   (9 static only, ~245 B saved) at mainnet prep — mainnet needs its own table
   regardless, since the SB queue is cluster-specific and the boot assertion
   enforces it.

### Open

- **Vault `2gjf5cyHCv4JMXP7DPNwxcqJE85mRvQ78DeuCMj9Ykyn` — $100 recoverable, no
  code fix needed.** Diagnosed 2026-07-31, read-only. NOT anomalous: the vault is
  simply **unsettled**. `settle_expiry` ran at expiry+24s (SettlementRecord price
  1.1134) but `settle_vault` never ran for this vault, so `is_settled` is still
  false and `collateral_remaining` is still its initial 0 (settle_vault is what
  sets it = total_collateral). The WriterPosition **does exist**
  (`BPEcJarLfXH9WpRiiSJv5zEpznYhDquE5cPYztPzGnp`, owner `DnExEYnZ…`, shares 100,
  deposited 100) — an earlier report of "zero WriterPosition accounts" was a
  probe bug (memcmp at offset 8, which is `owner`; `vault` is at offset 40).
  History: deposit 2026-07-23 → nothing ever minted (options_minted 0) → expiry →
  settle_expiry → stop. Recovery is the NORMAL path: `settle_vault` then
  `withdraw_post_settlement`. The void/`reclaim_unsettled` path is wrong here and
  would revert (`initialize_void` requires an empty SettlementRecord).
- **Class:** 3 vaults past expiry + unsettled + collateral > 0; 2 hold USDC,
  **170.000001 total**. `fGvpt9Ao…` (70.000001, expired 2026-07-31) is normal
  crank lag. Only `2gjf5cy…` is genuinely stale at 7 days — worth checking why
  the settle crank skipped a vault with `options_minted == 0`.
- Writer-bids C2 review pending (early unauthorized run reconciliation).
- **C3 relist is mandatory before bid scale** — without it every bid fill is dead
  capital until expiry (no on-chain net-off, no early exercise on 0-pool vaults).
- B3 OCO + B4 trigger sweep queued.
- Aug-7 maintenance: void sweep + 108 orphans + VPS repo reconciliation + auditd.

---

# ARC CLOSE — EPOCH 0 BUILD COMPLETE (2026-07-31T15:26Z)

**Read `indexer/GO-LIVE.md` first — it is the only launch source of truth and it
carries the measured state snapshot. This block is the narrative around it.**

Nothing is queued until Sunday's weight review. Any agent picking up work reads
GO-LIVE.md and this block **before touching a flag**.

## What Epoch 0 is, end to end

A gamified devnet campaign, built as one pipeline and currently **entirely dark or
in shadow**:

```
chain → TAPE (immutable, deterministic row ids)
      → SCORE (pure, versioned, recomputable)
      → quests + multiplier + provenance
      → points API (loopback only, ed25519 signed writes)
      → campaign UI (flag-gated OFF in prod)
      → opta-taker (buyer of last resort, DRY_RUN + unarmed)
      → writer bids (live, throttled to 3 cells)
```

The separation that makes it defensible: **TAPE is fact, SCORE is a function.**
Rules can change and a full recompute reproduces the same result on the same tape.

## Where it actually stands

Everything user-visible is still off. Posting is the single live outward surface,
and it predates this arc (LIVE since 2026-07-24). The reply lane is in shadow
pending a founder ruling — see GO-LIVE §6c, which records a genuine conflict
between two sessions rather than a decision.

Proven this arc, with evidence rather than assertion:

- **Reconciliation identity closes** — `[W]+[V]+[F]+[U] == 0`, residual **$8.57 on
  $11.2M gross**. Reported, never tuned to pass.
- **Bid canary PASSED a clean hour** — 7 posts, all exactly 1500bps under model
  mark and 2273–2287bps under their resting anchors, **0 crosses, 0 fills,
  0 restarts**, quote-failure flat 267→265, boards unmoved.
- **Taker safety mutation-verified 20/20** — every gate broken deliberately and the
  suite confirmed to fail. Arming is blocked in code until the wallet is in
  `INTERNAL_WALLETS` (it now is, verified on a recompute).
- **Upgrade compatibility clean** — the Jul-30 program upgrade was a one-line flag
  flip; 38 events, 0 layout changes, all 7 consumed instructions byte-identical.
  Tape rows since are sound; no re-index.
- **Writer burn decomposed to 3 decimals** — reprice/cancel are rent-neutral
  (370 txs = −0.00185 SOL against a −0.00186 measurement). The whole ~5 SOL/day is
  `CreateSeries` rent on repost waves. **Steady-state burn is ~0.045 SOL/day.**

## The three disciplines this arc produced

All three came from real incidents, all three are in this file above:

1. **Ledger rule** — fund movements and program upgrades get a ClickUp entry at
   execution time. Unledgered movement is an incident by default.
2. **Extended to live-surface flags** — `REPLY_DRY_RUN`, `OPTA_TAKER_ARMED`,
   `OPTA_WRITER_BID_ENABLED`, `VITE_EPOCH0_UI`, nginx routes. Irreversibility was
   always the criterion, not the asset class.
3. **A monitor must prove it can see a nonzero signal** — three separate queries
   this week reported clean zeros because they had silently errored.

**A fourth, learned at arc close:** the ledger must be in **one** place. The
reply-lane flip WAS documented — in git, 21 minutes after execution — and a
ClickUp-only check read it as unledgered, producing a forensic pass and a revert
that undid a deliberate, successful verification. Two honest agents, two
good-faith records, two different systems. **ClickUp at execution time is the
rule; a git commit is not a substitute.**

## Dates

- **Sunday 2026-08-02 — WEIGHT FREEZE.** `quests_v1.json` + `rules_v1` frozen. A
  post-launch rules change re-scores retroactively: correct by design, alarming to
  a user mid-campaign.
- **Monday 2026-08-03 — GO-LIVE EXECUTION**, in the locked order in GO-LIVE.md:
  ops → nginx → X secret → Vercel env+deploy → smoke → bid widen (3→30 + canary
  hour) → arm taker → announcement. Sequenced by blast radius; everything before
  the announcement is reversible in seconds.

## Nanko's outstanding items

1. **RULE ON THE REPLY LANE** (GO-LIVE §6c) — live per `fa93ef4`, or shadow until
   ~10 drafts per `8c456b9`. `postReply()` is now verified either way. Blocking for
   Monday.
2. **3 founder flags unactioned** in `/opt/opta-tweet/mentions-flagged.md` — two
   BD approaches (@nanko1goatit re self-writing vaults, @142C_) and one media
   request (@ownershipfm). The bot never auto-replies to these.
3. **Quest panel visual pass** — the one surface automated screenshots never
   covered; needs a real wallet, both themes, mobile.
4. **Confirm the 15:28Z 8 SOL writer→admin transfer** was the deploy top-up we
   reconstructed (it funded a program-deploy buffer; balances all recovered).
5. **Decide the airdrop posture** — 3.41 SOL/day at an 8% hit rate, and 22 of 23
   declines are the faucet erroring, not throttling. Fine for steady state, thin
   for repost-wave days.

## Queued, not started

- **Tenor-roll T-item** — no agent has touched it. Recon only, then ONE fix
  direction with numbers. **No tenor logic changes without a separate greenlight.**
- Stale IDL refresh at writer/indexer/taker/app (15-field `TriggerOrder`, drop the
  `synth_warm_vol_oracle` testing artifact). Harmless today; one commit.
- NYSE holiday table beyond 2026 + make exhaustion fail loud.
