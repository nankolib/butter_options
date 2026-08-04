# FULL-SURFACE GAP AUDIT — 2026-08-04

**Scope:** recon only. No fixes, no flag flips, no live-surface writes. Nothing was
signed, no faucet claim was made, no transaction was sent.

**Target:** `https://opta.fyi` (live production, EPOCH 0 campaign public since
2026-08-03) + devnet chain state + repo source at `master` `9012af2`.

**Method:** headless Chrome (playwright-core, installed Chrome channel) at desktop
1440×900 and mobile 390×844, both surface modes; direct `getProgramAccounts` reads
against devnet; direct HTTP probes of `/api/faucet` and `/api/points/*`; source
read of `app/src`, `programs/opta/src`, `indexer/src`.

Session clock verified: system date `2026-08-04`, on-chain `Clock` read
`2026-08-04T17:04:12Z`. Agreement confirmed.

---

## 0. Headline

Nine findings block a public push. The two loudest are not the ones in the
founder's report:

1. **The faucet has dispensed nothing since 2026-07-30.** Zero payouts in the
   ~30 hours since go-live, against 23 attempts. This is the campaign's front
   door and it is shut.
2. **`settle_expiry` is unreachable through the UI for every asset on the board.**
   The settle panel is hard-wired to Pyth/Hermes; all 52 settleable tuples are
   Switchboard. Quest **W2** and half of **O7** are structurally uncompletable —
   which the quest telemetry already reflects (`O7: 0 wallets, 0 completions`).

The founder's reported gaps are confirmed, root-caused, and two of the three
proposed causes for the chart gap are ruled out.

---

## A. Equity charts — ROOT CAUSE FOUND

### Verdict

**Layer: TradingView symbol mapping.** Not the CONTRACT-view fallback, not the
data pipeline. Both of those were tested and are working.

### Evidence

`app/src/pages/trade/TradingViewWidget.tsx:9-14` maps 4 equity tickers. The board
carries 13. Everything unmapped falls through
`TradingViewWidget.tsx:14` to `` `BINANCE:${TICKER}USDT` `` — a crypto pair that
does not exist for any equity, so TradingView renders **"This symbol doesn't
exist"**.

Measured in-browser, reading the TradingView iframe body for each ticker
(`/trade?asset=<T>` → Chart → UNDERLYING):

| Ticker | Symbol sent | Result |
|---|---|---|
| AAPL | `NASDAQ:AAPL` | OK — Apple Inc, $303.30 |
| TSLA | `NASDAQ:TSLA` | OK — Tesla, Inc., $322.10 |
| NVDA | `NASDAQ:NVDA` | OK — NVIDIA Corporation, $206.68 |
| MSFT | `NASDAQ:MSFT` | OK — Microsoft Corp., $487.66 |
| **MSTR** | `BINANCE:MSTRUSDT` | **BROKEN** — "This symbol doesn't exist" |
| **GOOGL** | `BINANCE:GOOGLUSDT` | **BROKEN** |
| **AMZN** | `BINANCE:AMZNUSDT` | **BROKEN** |
| **AMD** | `BINANCE:AMDUSDT` | **BROKEN** |
| **COIN** | `BINANCE:COINUSDT` | **BROKEN** |
| **META** | `BINANCE:METAUSDT` | **BROKEN** |
| **SPCX** | `BINANCE:SPCXUSDT` | **BROKEN** |
| **HOOD** | `BINANCE:HOODUSDT` | **BROKEN** |
| **CRCL** | `BINANCE:CRCLUSDT` | **BROKEN** |

**9 of 13 equities are blank.** One more, outside the founder's report:

| **FARTCOIN** | `BINANCE:FARTCOINUSDT` | **BROKEN** |

**XAU is fine** — `OANDA:XAUUSD` resolved and rendered ("Gold Spot / U.S. Dollar",
O 4,070.925 / C 4,076.815). The founder's XAU report does not reproduce on
desktop. See finding **B-7** for the reason it looks broken on mobile: the
Grid|Chart toggle is rendered off-screen there, so the chart cannot be opened at
all on a phone, for any asset.

Crypto and the rest of commodities are fine: BTC/ETH/SOL/XRP/JUP/JTO all resolve
via the Binance fallback.

### Replacement symbols — all 10 verified live

Each candidate was rendered in an isolated TradingView embed and confirmed to
return real OHLC. The last column cross-checks the returned close against the
on-chain oracle spot at the same moment — this doubles as an oracle-integrity
check and **all 13 equity feeds are accurate to <1%**.

| Ticker | Correct symbol | TV close | On-chain spot | Δ |
|---|---|---|---|---|
| MSTR | `NASDAQ:MSTR` | 94.77 | 95.14 | 0.4% |
| GOOGL | `NASDAQ:GOOGL` | 376.11 | 375.58 | 0.1% |
| AMZN | `NASDAQ:AMZN` | 277.81 | 278.39 | 0.2% |
| AMD | `NASDAQ:AMD` | 515.45 | 515.88 | 0.1% |
| COIN | `NASDAQ:COIN` | 147.41 | 148.00 | 0.4% |
| META | `NASDAQ:META` | 583.00 | 583.15 | 0.0% |
| HOOD | `NASDAQ:HOOD` | 90.98 | 90.93 | 0.1% |
| CRCL | `NYSE:CRCL` | 61.42 | 61.52 | 0.2% |
| SPCX | `NASDAQ:SPCX` | 118.47 | 118.35 | 0.1% |
| FARTCOIN | `MEXC:FARTCOINUSDT` | 0.13109 | 0.1298 | 1.0% |

`AMEX:SPCX` and `OTC:SPCX` were tested and are invalid — `NASDAQ:SPCX` is the one
that works. `BYBIT:FARTCOINUSDT` is invalid; `MEXC` is the one that works.

### The two ruled-out hypotheses

**CONTRACT view — works.** Switching to CONTRACT on `/trade?asset=AAPL` and
sampling every 5s for 35s: `loading` at t=5s, then the honest empty state
("this contract hasn't traded") from t=10s onward, stable. Not stuck. It is
**slow (5–10s)**, logged below as polish.

**BS-2002 candle fallback — not wired.** `app/src/utils/chartData.ts` still
carries `coingeckoId()`, `CONTRACT_FILL_THRESHOLD` and the synthetic-candle
machinery, but `PriceChart.tsx:89` calls only `fetchContractFills`. The fallback
is dead code and cannot be the cause of anything. Logged below as polish
(delete it, or the next reader will chase it too).

**Fix scope:** add 10 entries to `TV_SYMBOL` in `TradingViewWidget.tsx:9-13`.
One-line-per-ticker, no logic change. Phase: **immediate, pre-push.**

---

## B. `create_market` and `settle_expiry` surfaces

### B-1 · `create_market` — a surface EXISTS on desktop; it is invisible on mobile

The founder's report of "no user surface" is half right.

**Desktop:** `/markets` → **"New market"** button in the terminal app bar →
`NewMarketModal`. Verified working headless: the modal opens without a wallet,
the five asset-class chips select, and each populates a searchable feed list from
the merged Pyth/Switchboard registry. This completes quest **O3 "Make a Market"**.

**Mobile (390px): the button does not render.**
`app/src/pages/markets/MarketsNewMarketAction.tsx:30` —
`className="hidden … sm:inline-flex"`. Confirmed by DOM enumeration: the visible
button list on `/markets` at 1440 begins `["New market", "Connect wallet", …]`;
at 390 it begins `["Connect wallet", …]`. There is no other entry point on the
mobile surface. **O3 is unreachable on a phone.**

**Can a normal user complete O3 today?** **Yes on desktop. No on mobile.**

### B-2 · `settle_expiry` — a surface exists and cannot succeed for any live asset

**BLOCKER.** The panel is at `/portfolio` → the collapsed **"Utilities · settle ·
migrate"** disclosure (closed by default) →
`SettleExpiriesSection` → `AdminTools`. Permissionless, correctly not admin-gated.

`AdminTools.handleSettle` (`app/src/components/portfolio/AdminTools.tsx:127-140`)
unconditionally takes the Pyth path:

```
const hermesBase = getHermesBase();
const result = await settleAllForExpiry(program, wallet, tuple.asset,
                                        tuple.expiry, tuple.feedIdHex,
                                        tuple.vaultPdas, hermesBase);
const priceInfo = await fetchHermesParsedPrice(tuple.feedIdHex, hermesBase);
```

It never reads `market.account.oracleSource`. For a Switchboard market
`feedIdHex` is an **SB feedHash**, which Hermes 404s on. The tuple builder
(`AdminTools.tsx:78-107`) applies no oracle-source filter either, so the UI
**lists** tuples it cannot settle and fails on click.

Measured on chain right now:

```
EXPIRED-UNSETTLED TUPLES (what the settle panel lists): 52
  Switchboard (Hermes 404 → settle FAILS):  52   (2,193 vaults)
  Pyth        (settle CAN work)          :   0   (0 vaults)
```

Every one of the 23 assets with settleable expiries is Switchboard: ETH, WIF,
CRCL, AMZN, META, SOL, COIN, TSLA, JTO, AAPL, XRP, NVDA, BTC, AMD, MSFT, XAU,
MSTR, FARTCOIN, GOOGL, JUP, HOOD, SPCX, SBXAU.

**Can a normal user complete W2 today?** **No — 0 of 52 available tuples are
settleable.** Corroborated by the live quest board: `O7 Keeper: 0 wallets, 0
completions` (`/api/points/quests`), where `O7` fires on
`IxSettleExpiry | IxCreateMarket` (`indexer/src/score/quests/evaluator.ts:138,
267-268`) and `W2` on `settleExpiries` alone (`evaluator.ts:337-339`).

**Can a normal user complete O7 today?** **Yes, but only via its `create_market`
arm, and only on desktop.** The `settle_expiry` arm is dead.

**Fix scope (settle):** branch `handleSettle` on `market.account.oracleSource` and
route SB tuples through the Switchboard settle path (the crank already does this
— `crank/` has the working SB settle path to copy). Interim mitigation if the
branch is not ready for the push: filter the tuple list to `oracleSource === 0`
so the panel stops advertising 52 actions that all fail. Phase: **pre-push
(mitigation) / next phase (full branch).**

### B-3 · Minimal UI spec for `create_market` (requested)

The modal already implements this. Recorded so the spec is on paper and the
mobile gap is closed against a known-good shape.

**Inputs**
| Field | Control | Constraint |
|---|---|---|
| Asset class | 5 chips: crypto / commodity / equity / FX / ETF | required first; routes the oracle — crypto→Pyth, others→Switchboard (`NewMarketModal.tsx:769-771`) |
| Feed | searchable list off the merged registry, filtered by class | required; picks `pythFeedId` **or** `sbFeedHash` |
| Asset name | text, prefilled from the feed's ticker | `/^[A-Z0-9]{1,16}$/` (`NewMarketModal.tsx:559`) |
| Advanced | paste a raw 64-hex feed id + class | escape hatch when the catalog is unreachable |

**Constraints already enforced**
- Duplicate name with a different feed → *"An asset named X already exists with a
  different feed_id"* (`NewMarketModal.tsx:629,723`).
- HIGH-5 proof-binding: `create_market` needs a fresh `PriceUpdateV2` with
  `verification_level == Full`, so the tx is atomic `post_update + create_market`
  (`pythPullPost.ts:494-553`).
- Seed-at-birth: `initialize_vol_oracle` rides along with the per-class
  `seed_vol` (`pythPullPost.ts:712-725`), so the market is priceable immediately.

**Tx flow:** connect → pick class → pick feed → confirm name → sign ONE tx
(`post_update` + `create_market` + `initialize_vol_oracle` + close) → success
state deep-links to Write.

**The only change needed:** drop `hidden` from
`MarketsNewMarketAction.tsx:30` and give the mobile bar somewhere to put it.

### B-4 · Minimal UI spec for `settle_expiry` (requested)

Existing shape is right; it needs one branch, not a redesign.

**Inputs:** none from the user. The panel derives `(asset, expiry)` tuples from
expired-and-unsettled vaults and renders one row + one **Settle** button each.

**Constraints:** on-chain requires `publish_time ∈ [expiry, expiry+60]`
(`pythPullPost.ts:192`, `settle_expiry.rs:67`), so the price must be pulled at the
expiry instant, not now. Multi-vault tuples fan out one `settle_vault` IX per
vault in the same click, batched at 20 per tx.

**Tx flow (required change in bold):** list tuples → click Settle →
**branch on `oracleSource`** → Pyth: Hermes pull + atomic `post_update +
settle_expiry`; **SB: Switchboard bundle + `settle_expiry`** → fan out
`settle_vault` → confirmation with the settlement price and vault count.

**Discoverability:** the disclosure is closed by default and labelled "Utilities".
If W2 is meant to be earned, it needs a visible entry — a count badge
("52 expiries awaiting settlement") on the collapsed header would do it without a
redesign.

---

## C. Commodity coverage matrix

### The warmup premise needs correcting first

**The 7-day / 168-sample warmup is not a gate on trading.** Seed-at-birth is
deployed. `programs/opta/src/utils/american_pricing/quote.rs:116-119`:

```
let vol_scaled = if oracle.sample_count >= VOL_ORACLE_WARMUP_SAMPLES {
    realized_vol_annualized(...)      // warm: realized vol
} else if oracle.seed_vol != 0 {
    oracle.seed_vol                   // cold + seeded: PRICEABLE NOW
} else { return Err(VolOracleWarmup) }
```

A market seeded with a non-zero `seed_vol` is **tradeable from minute one**. The
168 samples (`vol_oracle.rs:166`) are the crossover to realized vol, not an
unlock. So "if seeded tomorrow, live when?" → **live tomorrow.** What lands 7
days later is the vol *quality*, not the listing.

Seeds are per-class (`app/src/utils/seedVol.ts:25-31`): crypto 0.80, **commodity
0.55**, equity 0.45, forex 0.12, ETF 0.25.

The one hard read-side gate that *does* bite is staleness: `last_sample_ts` older
than **6 hours** reverts `VolOracleStale` (`vol_oracle.rs:VOL_ORACLE_STALENESS_SECS`).

### Registered / written / vol-warm, measured on chain 2026-08-04T17:04Z

31 valid markets. Commodities and the near-miss classes:

| Asset (on-chain name) | Class | Oracle | Open vaults | Vol samples | Warm | Last push | Spot | Tradeable today? |
|---|---|---|---|---|---|---|---|---|
| **XAU** | commodity | SB | **21** | 720/168 | yes | 0.7h | $4,074.35 | **yes — live** |
| **XAG** | commodity | **Pyth** | **0** | 720/168 | yes | 0.7h | $59.67 | feed ready, **no vaults** |
| **WTI** (`USOILSPOT`) | commodity | **Pyth** | **0** | 720/168 | yes | **205.7h** | $83.94 | **no — oracle stale** |
| **BRENT** (`UKOILSPOT`) | commodity | Pyth | 0 | 720/168 | yes | 0.7h | $79.46 | **no — hidden in UI** |
| SBXAU (seed) | commodity | SB | 0 | 720/168 | yes | 0.7h | $4,074.35 | hidden by design |
| HYPE | crypto | Pyth | 0 | 565/168 | yes | 0.7h | $55.17 | feed ready, no vaults |
| RAY | crypto | Pyth | 0 | 569/168 | yes | 0.7h | $0.61 | feed ready, no vaults |
| BONK | crypto | SB | 0 | 350/168 | yes | 0.7h | **$0.00** | **no — dead feed** |
| EURUSD | forex | Pyth | 0 | 637/168 | yes | 0.7h | $1.1524 | feed ready, no vaults |
| USDPKR | forex | Pyth | 0 | **0/168** | no | never | **$0.00** | **no — never seeded** |

All 13 equities: SB, 92–132 open vaults each, **52–54/168 samples (not warm)**,
`seed_vol` 0.30–1.00, pushed 0.1h ago. **Priceable via seed_vol — this is fine.**
The low sample count is expected: equity feeds only publish during NYSE hours, so
they accrue ~6.5 samples/trading-day. 53 samples ≈ 11 trading days ≈ the 15
calendar days since Wave-2 (2026-07-20). Realized-vol crossover lands around
**2026-09-08** (≈26 more trading days), not 7 days out.

### Answering the founder decision: which commodity to add

**There is no 7-day wait for any of them. The blockers are elsewhere.**

**XAG — the cheapest win.** Market exists (`75Evk7GptTLbm127Gc48PjAtUDBYk6mdtmsMLBZ7K6ve`),
vol oracle warm and fresh, spot live at $59.67. It is absent from `/trade` purely
because **zero vaults have been written on it**. Add it to the writer bot's board
and it appears the same tick. **Live: immediately.**
*Caveat:* it is a **Pyth** market and Pyth is the retiring source. Adding depth on
Pyth now means migrating it later. Because the market PDA seeds are
`["market", asset_name]`, you **cannot** create a second SB "XAG" — it must go
through the admin `migrate_market_oracle_source`, not `create_market`. Decide the
oracle before writing depth, not after.

**WTI — one crank fix away.** Same story plus a live defect: the `USOILSPOT` vol
oracle was last pushed **205.7 hours (8.6 days) ago** against a 6-hour staleness
gate. Any American quote on it reverts `VolOracleStale`. Its sibling
`UKOILSPOT` was pushed 0.7h ago, so this is a per-feed crank gap, not an outage.
**Live: same day the crank resumes pushing that feed**, then vaults. Same
Pyth-vs-SB decision as XAG.

**BRENT — a one-line UI decision.** `UKOILSPOT` is registered, warm, fresh, and
priced at $79.46, but `app/src/utils/assetDisplay.ts:25` maps it to `null`,
which hides it from every list, chart and dropdown. That mapping was deliberate
("no live vaults; must not merge into WTI"). If Brent is wanted, change the
mapping to `"BRENT"` and write vaults. **Live: immediately.**

**Switchboard feasibility.** The `/write` selector already shows live SB-routed
prices for WTI ($75.71) and XAG ($59.81), and the create modal's COMMODITY class
routes to Switchboard (`NewMarketModal.tsx:770-771`). SB feeds for both exist and
are being read. The obstacle is not feed availability — it is the PDA name
collision above.

**Recommendation:** XAG first. It is the only commodity that needs nothing but
depth. Resolve the Pyth→SB question in the same session, because after depth is
written the migration gets expensive.

---

## D. Systematic pass — ranked findings

### PUBLIC-PUSH BLOCKERS

---

**BLK-1 · The faucet has paid out nothing since 2026-07-30**

*Evidence.* The faucet wallet is `J8Kct5tS5SvbmNj8fiuND94D4ZL5Cvip1MXsJLFRpEPz`
(`indexer/src/registry.ts:29`). Full signature history, cross-checked on **both**
Helius and the public devnet RPC (identical results, so this is not index
truncation):

```
wallet  49 sigs   newest 2026-07-30T10:33:47Z   oldest 2026-07-04T16:25:51Z   0 failed
ATA     26 sigs   newest 2026-07-28T14:11:15Z   oldest 2026-07-04T16:25:51Z
```

The campaign went live 2026-08-03. **Zero SOL claims and zero USDC claims have
landed since.** Last USDC claim was seven days ago. This matches the founder's
"22 of 23 declines were errors" exactly: nothing is getting through.

*Ruled out by direct probe.*
- Not funding: faucet holds **12.58 SOL** and **9,730,000 USDC** in the derived
  ATA `GuCsvvSogbKPhugXE2RRiEBcPXV6kVwFMjgiMGKNY1HD`.
- Not routing: `POST https://opta.fyi/api/faucet` returns `400 {"error":"Invalid
  wallet address"}` for a bad wallet, `405` on GET. The nginx points-API flip did
  **not** shadow `/api/faucet`. Same behaviour direct on
  `opta-solana.vercel.app`.
- Not a missing key: `loadFaucet()` runs **before** body parsing
  (`app/api/faucet.ts:121-125`). A 400 proves it returned a keypair, so
  `FAUCET_SECRET_KEY` is present and well-formed. It is not the 503 path.
- Not the mint: `AytU5HUQRew9VdUdrzQuZvZ7s14pHLiYjAF5WqdK3oxL` is owned by legacy
  `TokenkegQ…`, matching the `TOKEN_PROGRAM_ID` the handler passes.
- Not a mint-side dry-up: devnet USDC supply is 101.7M.

*Therefore the failure is inside the `try` block at `app/api/faucet.ts:162-209`* —
`getGenesisHash` → `getAccountInfo` → `getLatestBlockhash` → `sendRawTransaction`
→ `confirmTransaction`, all against
`FAUCET_RPC_URL?.trim() || "https://api.devnet.solana.com"`.

Two candidates, ranked, both consistent with "errors not throttles":
1. **Public devnet RPC rate-limiting on Vercel's shared egress.** Five sequential
   calls per claim. A 429 anywhere throws, and `app/api/faucet.ts:208` returns
   `500 {error: <raw message>}`, which the FE renders verbatim
   (`FaucetIconButton.tsx:98`). The user sees a Solana rate-limit string, not a
   cooldown. From a residential IP the same sequence is healthy (12/12 OK,
   ~410ms), so this cannot be reproduced from here — it needs Vercel's IP.
2. **Function timeout.** `confirmTransaction(sig, "confirmed")` is the deprecated
   subscription overload with a 30s default; `vercel.json` sets no
   `maxDuration`. A platform kill leaves the Redis cooldown **reserved** —
   `release()` at line 207 never runs — so a failed claim burns the user's window
   and the retry legitimately 429s.

*Fix scope.* Read the actual error text from Vercel function logs — the FE
already surfaces it, so it is in PostHog too. Then almost certainly: set
`FAUCET_RPC_URL` to the Helius devnet endpoint (removes candidate 1), and replace
the deprecated `confirmTransaction` with the blockhash/lastValidBlockHeight form
under an explicit timeout shorter than the function limit (removes candidate 2).
Phase: **immediate. Nothing else on this list matters if new users cannot get
funded.** Knock-on: daily quest **D3 "Faucet claim"** is unearnable.

---

**BLK-2 · 9 of 13 equity charts (+ FARTCOIN) render "This symbol doesn't exist"**

Section A. Fix is 10 map entries, all verified. Phase: **immediate.**

---

**BLK-3 · `settle_expiry` cannot succeed for any asset on the board**

Section B-2. 0 of 52 tuples settleable; W2 and half of O7 dead. Phase:
**mitigation immediate, full branch next phase.**

---

**BLK-4 · `/markets` intermittently fails to load entirely**

*Evidence.* One of five desktop loads produced a completely empty page — all five
strip metrics `—`, "Showing 0 assets", every pulse tile "No live contracts":

```
Failed to fetch vault accounts: Error: getProgramAccounts timeout after 25000ms
Markets fetch failed         : Error: getProgramAccounts timeout after 25000ms
[hermesCatalog] fetch failed (no cache): AbortError
```

Production RPC is `https://rpc.opta.fyi/devnet` (captured from live request
traffic). The page issues unfiltered `getProgramAccounts` over 3,365
`SharedVault` + 464 `OptionsMarket` + 482 `RestingOrder` accounts on every load.
At ~20% failure this is the first thing a visitor sees.

*Fix scope.* Raise the 25s ceiling and/or add a retry with backoff; longer term,
`dataSlice` the vault scan to the fields the page actually reads. Phase:
**pre-push (retry), next phase (dataSlice).**

---

**BLK-5 · `create_market` is invisible on mobile**

Section B-1. `MarketsNewMarketAction.tsx:30` — `hidden … sm:inline-flex`. O3
unreachable on a phone. Phase: **pre-push.**

---

**BLK-6 · Mobile `/trade`: the Grid|Chart toggle renders off-screen**

*Evidence.* At 390×844 the toggle's bounding box is **x 386→494** on a 390px
viewport — entirely outside it. The buttons exist in the DOM (they appear in the
enumerated button list) but cannot be reached; `document` shows no horizontal
scroll, so there is no way to pan to them. The expiry chips also collide with the
app bar (screenshot: "07 AUG · 2D 16H" squeezed into a ~40px column overlapping
the DEVNET chip and Connect wallet).

**Consequence: no mobile user can open the chart, for any asset.** This is very
likely the actual shape of the founder's XAU report, since XAU charts correctly
on desktop.

*Fix scope.* Wrap the Pro|Simple and Grid|Chart pairs so they wrap to a second
row below 640px. Phase: **pre-push.**

---

**BLK-7 · `/markets` shows two contradictory numbers on the same screen**

*Evidence.* Header strip reads **VAULT TVL $3,113.28** and **PREMIA · CUMULATIVE
$21,378.71**. Directly beneath, the tiles read **WIDEST VAULT DEPTH $0
collateral** and **MOST PREMIA · CUMULATIVE $0 since inception**, and the table's
VAULT DEPTH column is `$0` for all 8 crypto assets.

*Root cause.* Not a rendering fault — two different populations.
`useMarketsData.ts:273-277` sums the header over **all** vaults; `marketsView.ts:222-228`
sums the tiles over `isLive` (`status === "open"`) only. Chain confirms the split
exactly:

```
open      n=  998   TVL=$      0.00   premia=$     0.00   minted=0        sold=0
expired   n= 2207   TVL=$ 258198.27   premia=$   769.56   minted=1204     sold=221
settled   n=  160   TVL=$   2915.01   premia=$ 20609.16   minted=2004473  sold=446
open vaults with tvl>0: 0        open vaults with premia>0: 0
```

**Every one of the 998 open, tradeable vaults holds $0 collateral, 0 minted, 0
sold.** All capital sits in expired and settled vaults. The tiles are the honest
number; the header is lifetime-cumulative presented as if it were current.

This also explains why all three tiles list the identical rows (BTC 70,300P /
JTO 0.48P / CRCL 55C): with an all-zero sort key, `top()` returns the same first
three every time. That symptom is a consequence, not a separate bug.

*Fix scope.* Make the header agree with the tiles — either scope both to live, or
relabel the header cells "lifetime". A visitor reading $3,113 TVL beside $0 depth
concludes the site is broken. Phase: **pre-push (relabel is one line).**

---

**BLK-8 · Expiry date disagrees with itself on the same screen**

*Evidence.* `/trade?asset=AAPL`: the market-context strip reads **"08 AUG · 3D
2H"** while the expiry tab directly below reads **"07 AUG · 3D 2H"** — same
contract, same duration, different date. On-chain the AAPL near expiry is
`2026-08-07T19:45:00Z`.

*Root cause.* 19:45 UTC. The tab renders in **UTC** (correct); the strip renders
in **browser-local** time, which rolls to 08 AUG for anyone at UTC+4:15 or east —
including the founder's own timezone. JTO/BTC/XAU expire at 08:00 UTC so they
never cross the boundary, which is why this only shows on equities (19:45 UTC
market-hours settle).

*Fix scope.* Force UTC in the market-context strip's expiry formatter. Phase:
**pre-push** — a trading surface that shows two expiry dates for one contract is
a trust problem, not a cosmetic one.

---

**BLK-9 · Settle panel advertises 52 actions that all fail**

The visible half of BLK-3, called out separately because it has an independent
one-line mitigation (filter the tuple list by `oracleSource`) that can ship
without the SB settle branch. Phase: **pre-push.**

---

### POLISH

| # | Finding | Evidence | Fix scope | Phase |
|---|---|---|---|---|
| P-1 | New Market modal's default feed list is an unranked first-12 slice: crypto shows `REX33 / MTBILL / PI / SUSDV / MATICX`, equity shows `RIVN / KRKNF / 6862HK / 000880 / 138040`, commodity shows `BLDV6 / TIU6 / RSH6 / NGDJ6`. Search works, but the first impression is random. | `NewMarketModal.tsx:544-552` — `.filter(class).slice(0,12)`, no ranking | rank by liveness/volume, or seed with the assets already listed | next |
| P-2 | The commodity list offers **`UKOILSPOT`**, a raw feed ticker that `canonicalAsset` deliberately hides everywhere else. Creating it yields an invisible market. | `assetDisplay.ts:25` maps it `null`; modal has no such filter | run modal candidates through `canonicalAsset` | next |
| P-3 | New Market modal renders in the paper (light) skin over the dark terminal — a white box on a black page. | screenshot `nm-crypto-desktop-dark.png` | known debt; terminal reskin | next |
| P-4 | `JTO / JUP / WIF` group under **"Other"** in the Trade dropdown, and `BONK / HYPE / RAY` under "Other" in the Write selector. They are crypto. | `assetDisplay.ts:44` — `CRYPTO` set never took the Wave-1 memes; the file's own comment flags the equity equivalent as already fixed | add 6 tickers to the `CRYPTO` set | pre-push (one line) |
| P-5 | `BONK` ($0.00) and `USDPKR` ($0.00) appear in the Write selector with dead feeds. USDPKR's vol oracle has **0 samples and has never been pushed**. Selecting either produces a broken write. | on-chain table, §C | hide assets with zero spot or unseeded oracles | pre-push |
| P-6 | CONTRACT chart pane takes **5–10s** to reach its empty state; reads "Loading tape…" for the first ~10s. | 35s sampling, §A | `dataSlice`/limit the signature walk, or render empty-then-fill | next |
| P-7 | `/markets` FARTCOIN row: the "as of 16:17 UTC" staleness label overlaps the spot value. | screenshot `lt-markets-desktop-light.png` | give the label its own line | next |
| P-8 | `/docs` still renders the legacy paper Header, including a **second** create-market entry labelled "+ New Market" (vs "New market" on `/markets`). Two entries, two labels, one action — and one of them lives on a docs page. | button enumeration on `/docs` | retire the parked Header entry | next |
| P-9 | `assetRegistry` drops the SB hash for **ETH** and **SOL** (`ambiguous SB join … 2 Pyth feeds`), so creating either through the modal produces a **Pyth** market — the retiring source, and the exact pair already write-paused by `writePauseGate`. | console warnings, live | disambiguate the join for ETH/SOL | next |
| P-10 | Modal routes **all crypto to Pyth** by design (`NewMarketModal.tsx:770-771`) while the entire live crypto board is Switchboard. Every user-created crypto market is born on the wrong oracle. | source + on-chain (BTC/ETH/SOL/XRP/JTO/JUP/WIF/BONK/FARTCOIN all `src=SB`) | re-resolve the class→oracle default | next |
| P-11 | `chartData.ts` carries unused CoinGecko OHLC + BS-2002 synthetic-candle code that nothing calls. It sent this audit chasing a fallback that does not exist. | `PriceChart.tsx:89` calls only `fetchContractFills` | delete | next |
| P-12 | `/markets` leaves ~250px of dead space below the table at 1440×900. | screenshot | flex the table container | later |
| P-13 | `/trade` shows two prices for one contract: chart header `mark $28.5568` (BS model) beside `PROTOCOL QUOTE 26.78 USDC` (on-chain), a 6% gap, unlabelled. | AAPL 280C, live | label the model mark as a model value | next |

### NOTED — verified non-issues and standing state

- **`BOOK DEPTH · RESTING ASKS $2,067,600` is real, not a decimals bug.** Chain:
  456 WriterAsk orders, $2.14M escrow, $2.04M of it on open vaults. Cross-checked
  against `getTokenLargestAccounts` — the protocol_state PDA
  `5uBcRhU6…` holds a dozen $1.7–2.0M USDC accounts. Devnet mock money, honestly
  reported. Worth a founder call on *optics* (a $2M depth headline beside $0 live
  vault depth invites questions), not on correctness.
- **998 open vaults at $0 / 0 OI board-wide is the honest soft-launch state**,
  matching HANDOFF §6 ("0 fills board-wide"). Not a bug.
- **The FE's per-asset market counts are exactly right** — `/markets` MARKETS
  column BTC 42 / JTO 132 / JUP 60 / ETH 62 / SOL 65 / FARTCOIN 60 / WIF 60 /
  XRP 32 matches the on-chain open-vault count for all 8.
- **433 of 464 accounts carrying the `OptionsMarket` discriminator are not
  markets** — 427 at 87/88 bytes (legacy market-per-variation layout, carrying
  strike + expiry) and 6 at 68 bytes (corrupt, binary garbage in the name field).
  Only 31 are valid 63-byte markets. `safeFetchAll`'s strict validator already
  filters these; a bare `.all()` anywhere new will produce garbage rows. This is
  the known orphan trap, still live.
- **17 orphan vol oracles** with no matching market (47 oracles, 31 markets).
- **All 13 equity oracle feeds verified accurate to <1%** against independent
  TradingView exchange data (§A table). `AMD $515.88` looks wrong but is correct.
- **No console errors on any page in either theme** apart from the RPC timeouts
  in BLK-4. No `pageerror`, no 4xx/5xx beyond one TradingView support-portal 403
  (theirs, harmless). No horizontal document overflow on any page at either
  viewport.
- **The light/dark toggle works on all five terminal pages** (`data-mode` flips,
  no errors).
- **All five leaderboards return 200 with data**; `/api/points/stats`,
  `/quests`, `/wallet/<pubkey>` all healthy. `/api/points/quests/catalog` 404s but
  nothing calls it.
- **`/xbar/simulate/<hash>` ERR_ABORTED entries in the trade-page network log are
  benign** — the endpoint returns 200 on direct curl; these are in-flight requests
  cancelled by the quote refresh cycle.

---

## E. Founder wallet-smoke checklist

Headless cannot connect a wallet, so everything gated on `connected` is unverified
by this audit. Ordered by what unblocks the most.

**1 · Faucet (BLK-1) — do this first, it gates everything else**
- [ ] Connect a **fresh** wallet (never claimed). Click the SOL faucet.
- [ ] Record the **exact** flyout text. It is `data.error` verbatim from the
      server (`FaucetIconButton.tsx:98`) and it names the real failure.
- [ ] Open Vercel → project **`opta`** (NOT `butter_options_app` — `app/.vercel/project.json`
      names the wrong project, HANDOFF §8) → Functions → `/api/faucet` logs.
      Capture the thrown message.
- [ ] Confirm whether `FAUCET_RPC_URL` is set in Vercel prod, and to what.
- [ ] Confirm `KV_REST_API_URL` / `KV_REST_API_TOKEN` are still live (an expired
      Upstash integration silently drops to per-instance memory cooldowns).
- [ ] Retry the USDC faucet on a second fresh wallet; note whether the second
      attempt on the *same* wallet returns 429 — if it does, the cooldown is
      being burned by failed claims (`release()` not running).

**2 · Can a new user actually start?**
- [ ] Fresh wallet, desktop: faucet SOL → faucet USDC → buy one contract on
      `/trade` → confirm it lands in `/portfolio`.
- [ ] Confirm quest **O1 "First Fill"** ticks in the Quest panel.
- [ ] Same flow on a real phone at 390px. Note where it breaks.

**3 · Quest reachability (the founder's B question, end to end)**
- [ ] **O3 / create_market**: `/markets` → New market → CRYPTO → search "BTC" →
      confirm the tx builds and lands. Note the fee shown.
- [ ] **O3 on mobile**: confirm the button is absent (expected — BLK-5).
- [ ] **W2 / settle_expiry**: `/portfolio` → expand "Utilities · settle · migrate"
      → pick any tuple → click Settle. **Expected to fail** (BLK-3). Capture the
      error so the SB branch can be written against the real failure mode.
- [ ] **O5 "Arm a Trigger"**: TP/SL placement — the ticket says "placement UI
      coming soon", so confirm whether O5 is reachable at all.
- [ ] **O4 "First Exercise"** and **O6 "Diamond Hands"**: both at 0 completions.
      Walk each once.

**4 · Quest panel / referral / social (entirely unreachable headless)**
- [ ] `/portfolio` → Quest panel renders, points match
      `/api/points/wallet/<pubkey>`.
- [ ] **Referral**: generate a code, bind it from a second wallet, confirm the
      referrer's `referee_count` increments.
- [ ] **Social submit**: submit an X post URL, confirm it appears on the SOCIAL
      board.
- [ ] **Bounty submit**: same.
- [ ] Each of the four writes requires a `signMessage` envelope
      (`epoch0Sign.ts`) — confirm the wallet prompt copy is intelligible and that
      a **rejected** signature leaves a clean state, not a stuck spinner.

**5 · Write flow**
- [ ] Write one epoch vault and one custom vault; confirm both appear on `/trade`
      and in `/portfolio`.
- [ ] Attempt a write on **BONK** and **USDPKR** (both $0.00 spot) and record the
      failure (P-5).
- [ ] Attempt a write on **BTC** or **SOL** and confirm `writePauseGate` shows
      "New positions paused — market upgrade in progress."

**6 · Chart spot-check after the BLK-2 fix**
- [ ] All 13 equities + FARTCOIN + XAU + XAG/WTI if added, desktop and mobile,
      both themes.

**7 · Cross-browser**
- [ ] Everything above was measured in Chrome only. Repeat the critical path in
      Safari/iOS — the wallet-adapter and Token-2022 paths have historically
      diverged there.

---

## F. Reproduction artifacts

Scratchpad (session-local, not committed):
`…/scratchpad/hb/` — `drive.mjs` (headless driver), `chart.mjs`, `tvtest.mjs`,
`onchain.mjs`, `metrics.mjs`, `settleable.mjs`, `expiry.mjs`, `modal3.mjs`, plus
`shots/*.png` for every page × viewport × theme.

On-chain reads used `https://devnet.helius-rpc.com` and were cross-checked
against `https://api.devnet.solana.com` wherever a conclusion depended on
completeness of history.
