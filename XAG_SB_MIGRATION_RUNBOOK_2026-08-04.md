# XAG → Switchboard migration — RUNBOOK PROPOSAL

**Status: PROPOSAL. Nothing executed.** No transaction was sent, no feed minted,
no market closed, no depth written. Every admin step below is for the founder to
run at his own terminal.

**Founder ruling this serves:** XAG migrates Pyth → Switchboard **before** any
depth is written.

Recon date 2026-08-04. Program `CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq`
(devnet).

---

## 0. The headline, before the steps

**There is no migration instruction. There cannot be one today.** Both candidates
named in the brief were read end to end and neither can do this:

| Instruction | Can it move `oracle_source`? | Can it write an SB feed hash? |
|---|---|---|
| `migrate_market_oracle_source` | **No.** It is a one-time *schema* migration: it grows the account 62 → 63 bytes and **zero-fills** the new byte, which decodes as `0 = Pyth`. It takes no argument and cannot set `1`. Worse, its idempotency guard is `if current_len >= target_size { skip }`, and **XAG is already 63 bytes**, so it would skip XAG untouched. | No. |
| `migrate_pyth_feed` | No — it does not touch `oracle_source` at all. | **No.** It is proof-gated: `require!(pu.price_message.feed_id == new_pyth_feed_id)` against a `PriceUpdateV2` with `verification_level >= Full` (`migrate_pyth_feed.rs:44-55`). An SB feedHash has no Pyth `PriceUpdateV2`, so the gate can never pass. It rotates Pyth → Pyth only. |

`oracle_source` is assigned in **exactly one place in the whole program** —
`create_market.rs:183`. Confirmed by grep across `programs/opta/src/instructions/`.

**Therefore the only path is close-and-recreate**, which is precisely what
`close_market` was built for. Its own header says so: *"Used at cutover to free a
crypto asset's name PDA so an SB-sourced market can be re-created under the SAME
real name (atomic name handover)."* This path is already proven — XRP, FARTCOIN,
ETH and **XAU** all went through it.

**And there is a blocker in front of all of it: the Switchboard XAG feed does not
exist, and there is no obvious way to source it.** See §2. That is the decision
this proposal actually needs from the founder; everything after it is mechanical.

---

## 1. Measured starting state

| Fact | Value | How it was read |
|---|---|---|
| XAG market PDA | `75Evk7GptTLbm127Gc48PjAtUDBYk6mdtmsMLBZ7K6ve` | `["market","XAG"]` |
| Account size | 63 bytes | already post-`migrate_market_oracle_source` |
| `asset_class` | `1` (commodity) | byte 60 |
| `oracle_source` | **`0` = Pyth** | byte 62 |
| Pyth feed id | `f2fb02c32b055c805e7238d628e5e9dadef274376114eb1f012337cabe93871e` | bytes 28..60 |
| Vol oracle | **warm** — 720/168 samples, last push 0.7 h ago, spot $59.67 | VolOracle at `["vol_oracle", pyth_feed_id]` |
| Child vaults | **1**, and it is a shell | see below |
| Open (unexpired) vaults | **0** | full `SharedVault` scan |
| Protocol admin | `5YRMuuoY3P7z5GeRAAQND7BxgNdmPSa6CSPCJLca1zZk` | `protocol_state` @ `5uBcRhU6Hc78w8pNRNgu1X953oRL93fgAHC348CKNajV`, seed `protocol_v2` |

**The one child vault** `DFzCjeN1BNDwc2g4XPxxcB7bz4tHtUyxy5A5RSMABSbL`:
strike $75, expired 2026-05-15T08:00:00Z, `is_settled = true`,
`total_collateral = $0`, `net_premium = $0`, minted 500 / sold 0, and its
`vault_usdc_account` **no longer exists** (fully wound down). By the
`preflight_close_market.ts` rule — *live iff `!is_settled` OR `vault_usdc > 0`* —
this vault is **not live** and does not block the close.

> ⚠️ My scan checked two axes. `_cutover_rebirth.ts` classifies on **five**
> (`vaultShellRule.ts`): vault USDC, writer-ask-pot USDC, option-mint holders,
> pool writers, ask backers — and splits holders into on-curve wallets vs the
> protocol PDA. `minted = 500 / sold = 0` means 500 option tokens were minted and
> never sold, so the **option-mint-holders axis is the one that could still
> flag**. Do not take my verdict as the gate. Run the dry scan (step 5) and let
> the classifier rule.

**No warm Switchboard XAG oracle exists.** All 17 orphan VolOracles on chain are
stale abandonments from the crypto cutover (last pushed 361–920 h ago); the only
SB one among them is a dead gold seed. A new market on a new feed id starts with
a **cold** oracle.

---

## 2. ⛔ THE BLOCKER — there is no Switchboard silver feed, and no easy source

`crank/sbFeedRegistry.ts` is the SB feed registry. It contains **23 feeds**: XAU,
9 crypto (BTC/ETH/SOL/XRP/FARTCOIN/JUP/JTO/WIF/BONK) and 13 equities. **No XAG.
No WTI.** `app/src/utils/sbFeedData.ts` (the FE copy) carries gold only.

Every obvious source was tested live today and all of them fail:

| Candidate source | Result |
|---|---|
| `quotes.opta.fyi/finnhub/quote?symbol=XAG` | **503** `{"error":"upstream"}` |
| same, `SI=F` / `OANDA:XAG_USD` / `XAGUSD=X` | **400** `{"error":"bad symbol"}` |
| `quotes.opta.fyi/yahoo/chart/SI=F` and `/XAGUSD=X` | **400** `{"error":"bad symbol"}` |
| Binance `XAGUSDT` / `KAGUSDT` / `XAGXUSDT` / `AGXUSDT` | **`-1121 Invalid symbol`** (all four) |
| Coinbase `XAG-USD` / `KAG-USD` | **`NotFound`** |

Two conclusions:

1. **The equity job pattern does not extend to XAG.** `quotes.opta.fyi` is
   symbol-allowlisted to the 13 equities (`AAPL` returns a real stale-flagged
   payload; every silver shape is rejected as a bad symbol). Extending it is
   **VPS work on the proxy**, not a registry edit.
2. **The XAU trick does not transfer.** Gold works because **PAXG** — tokenized
   gold — is deeply listed on both Binance and Coinbase, so its job pair is two
   independent crypto-exchange tickers. There is no equivalent tokenized silver
   on either venue.

So step 1 of the runbook is a **founder decision with real cost attached**:

- **(a) Extend `quotes.opta.fyi`** with a silver symbol (Finnhub's
  `OANDA:XAG_USD` is a paid-tier symbol; Yahoo has `SI=F` and `XAGUSD=X` free).
  Reuses the proven two-leg equity job shape and the existing stale-honesty
  logic. Cost: proxy allowlist + deploy, and a Finnhub tier check.
- **(b) Point the SB job at third-party metals APIs directly** (no proxy). SB
  oracles are server-side so CORS is irrelevant, but you need **two independent,
  reliable, key-free HTTPS endpoints** or the feed inherits their uptime. Cheapest
  to build, weakest to operate.
- **(c) Don't migrate XAG.** Reconsider the asset. **WTI is in the same position
  and worse** — its `USOILSPOT` vol oracle is 205.7 h stale against a 6 h gate, so
  it is broken on Pyth *today* independent of any migration.

Nothing below can start until this is answered.

---

## 3. Why the ruling is right (and what it costs to get wrong)

Migrating **before** depth is written is the correct call, and the reason is
structural, not stylistic: `close_market` frees the name PDA
`["market","XAG"]` so the SB market can be born under the same real name. Once
vaults carry live collateral, every one of them is a `LIVE` child that
`preflight_close_market.ts` will refuse to close around — and the only way
forward would be to settle or drain each vault first. The window where this is
cheap is exactly now, while open vaults = 0.

---

## 4. The migration, exactly

Everything is admin-signed with `5YRMuuoY…`, which lives **only** at
`/home/nanko/.config/solana/id.json` in WSL and is deliberately **not** on the
VPS. All of this runs from WSL.

### Step 1 — resolve the feed source *(blocked, §2)*
Founder picks (a), (b) or (c). If (a): extend `quotes.opta.fyi` and confirm both
legs return a parseable price for the chosen silver symbol.

### Step 2 — define the job pair and mint the feed hash
Add an XAG entry to `JOBS_BY_FEED` in `crank/sbFeedRegistry.ts` following the
`eqJobs()` shape, then derive its hash with
`FeedHash.computeOracleFeedId(buildOracleFeed(entry))`.
Precedent generator: `crank/_equity_feed_hashes.ts`.

> ⚠️ **Job order, URLs and JSON paths are load-bearing.** The registry re-derives
> every hash at module load and a mismatch is fatal — `crank/_verify_registry_hashes.ts`
> is the parity guard. Editing a URL after minting silently invalidates the hash
> and the crank will refuse to boot.

### Step 3 — create the SB feed on chain
`crank/_mint_sb_feed.ts` (precedent: `crank/_birth_sb_market.ts`).
Remember the split: **create and init are separate transactions**, and the
managed-quote shape is `feedHash@msg32` / `spot@msg64` with a sim-gate retry.

### Step 4 — seed the vol oracle
`initialize_vol_oracle(feed_id = <SB XAG hash>, oracle_source = 1, seed_vol = 550_000_000_000)`.

`550_000_000_000` is commodity `0.55` from `app/src/utils/seedVol.ts:27`, the
single source of truth, and sits inside the on-chain `[MIN_SEED_VOL, MAX_SEED_VOL]`
bounds.

**This is the step that makes XAG tradeable — not the warmup.** `quote.rs:116-119`
prices off `seed_vol` while `sample_count < 168`, so the market quotes from
minute one. The 168 samples (7 days at the hourly crank cadence) are only the
crossover to realized vol. **If seeded on day D, XAG is live on day D and
switches to realized vol on D+7.**

### Step 5 — preflight the close *(read-only, run it and read it)*
```
RPC_URL=$(cat ~/.opta-rpc-helius) npx ts-node scripts/preflight_close_market.ts XAG
```
No `--execute`. Expect a CLEAN verdict on the single settled shell (§1). **If it
says STOP, stop** — that means the option-mint-holder axis found a real claim and
this proposal's read was too shallow.

### Step 6 — close and re-create, as ONE sequence
```
cd crank
OPTA_RPC_URL="$(cat ~/.opta-rpc-helius)" \
ts-node --transpile-only -r tsconfig-paths/register _cutover_rebirth.ts \
  XAG <SB_FEEDHASH_HEX> 1            # dry scan + verdict, read-only
```
then the same command with `--execute`.

`1` is the commodity asset class. The driver closes and re-creates in one
uninterrupted sequence, retrying the create with a fresh signed quote until it
lands, and escalating loudly (exit 21) rather than leaving XAG marketless. That
retry behaviour is the whole reason to use the driver instead of two hand-rolled
transactions.

### Step 7 — verify before any depth
- Market at `["market","XAG"]` is 63 bytes with `oracle_source == 1` and the SB
  feed hash in bytes 28..60.
- `get_option_price` returns a sane premium for a near-dated XAG strike.
- Crank boots (the parity guard passes) and pushes a first vol sample.
- FE: XAG appears under **Commodities** in the Trade dropdown with a live spot.

### Step 8 — only now, depth
Add XAG to the writer board. Not before step 7 passes.

---

## 5. What I did not do, and why

- **Nothing was executed.** No feed minted, no market closed, no tx sent.
- **XAG was not added to the writer board.** Depth comes after migration, per the
  ruling.
- **No code was changed for XAG.** The registry edit in step 2 is deliberately
  left for the session that also mints the hash — splitting them is how the
  parity guard gets tripped.

## 6. Open questions for the founder

1. **Which silver source** — (a) extend `quotes.opta.fyi`, (b) direct third-party
   APIs, or (c) drop XAG? Nothing proceeds without this.
2. **Is XAG still the right pick** now that the true cost is a new feed rather
   than a flag flip? XAU is already live on SB with 21 open vaults and 91 vaults
   total; adding depth there is free by comparison.
3. **WTI** is in the same position plus a **205.7 h stale** vol oracle. Its crank
   gap is worth fixing regardless of whether it ever migrates, because it makes
   WTI unquotable today.
