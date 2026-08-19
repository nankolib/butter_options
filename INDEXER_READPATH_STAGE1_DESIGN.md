# INDEXER READ-PATH — Stage 1 design (2026-08-18)

Local planning doc, deliberately uncommitted.

**Status: R1+R3 SHIPPED. Stopped at the numbers. One finding reframes what is left.**

## R1/R3 SHIP-GATE NUMBERS (prod, 2 runs)

```
                    filter slice     R1+R3            target
cold                7.86 / 7.13      8.14 / 11.24 s   single digit BOTH -> MISSED (1 of 2)
warm (hard reload)  8.04 / 7.86      5.20 /  8.52 s   <2s -> MISSED
warm (in-app nav)   4.22 / 4.08      3.74 /  3.70 s
bytes, reload       13.0 MB          7.67 MB
```

Persistence demonstrably works: on a hard reload the page makes **1** /api/chain
call (`meta`) and serves everything else from IndexedDB. Reload bytes fell
13.0 -> 7.67MB. And yet the clock barely moved.

## THE FINDING: the read path is not on the critical path

`TradeChainV2` renders `visibleRows`, which comes from `useUnifiedChain`, which
imports `fetchUnifiedChain` from `utils/exchangeData` and calls `safeFetchAll`
**zero times**. The rendered grid is fed entirely by exchangeData's raw
getProgramAccounts scans.

Everything built across this arc — indexer, filtered reads, scoped cache,
IndexedDB persistence — feeds `useTradeData`/`useVaults`, which drive the asset
dropdown, expiries and the ticket. **Not the grid.** The measured gains came from
REDUCED CONTENTION (fewer and smaller competing requests), never from moving the
thing being timed.

So "time to first contract row" has been gated by exchangeData's chain scans the
whole time.

**R2 is therefore not a cleanup item — it is the binding constraint.** Warm <2s
is unreachable while the grid's own data still comes from wholesale gPA scans,
no matter what else is cached or persisted. The ticket (`86eyp3myb`) should be
re-scoped from "route three redundant reads through the index" to "move the
GRID onto the read path".

## FILTER-SLICE NUMBERS (prod, 2 runs)

```
                    before slice     after slice        target
cold                 8.28 / 10.21    7.86 / 7.13 s      single digit BOTH -> MET
warm (hard reload)   7.54 / 7.57     8.04 / 7.86 s      <2s -> MISSED
warm (in-app nav)    4.21 / 4.75     4.22 / 4.08 s
bytes, cold          13.2 MB         13.0 MB
```

The board itself now arrives filtered: **vaults 92KB, series 36KB** (was 3.74MB
and 1.46MB) — the ~70x the slice was for.

### Why warm-reload cannot reach <2s as built

The client cache is IN-MEMORY, so a hard reload throws it away and repeats the
whole cold path minus static assets. Reaching <2s on reload needs a PERSISTENT
client cache (IndexedDB), keyed by the deploy-slot lineage that /meta already
publishes. That is a real slice, not a tweak.

In-app navigation — the common case, and what the founder actually does — is
**4.1-4.2s**.

### The remaining 13MB is one legitimate read

`useTradeDockData` reads ALL boards because a wallet's positions are not confined
to the board on screen. It is now deferred to idle (off the critical path, which
is what moved cold under 10s) but still transfers ~5MB. Fixing it properly needs
a by-vault-key endpoint so the dock fetches only the vaults backing the positions
it holds.

### NOT DONE: exchangeData adapter (item 3)

Assessed rather than attempted. `exchangeData.ts` parses raw Buffers with its own
byte-offset decoders at three fetch sites (series, markets, unified-chain
vaults). Routing it through the index needs either raw_b64 served — which
restores the payload this whole path removed — or rewriting those parsers to
consume JSON, in code adjacent to fills. It accounts for 3 residual gPA calls.
Flagged for a ruling rather than done quietly.

## SHIP-GATE NUMBERS (prod, real Chrome, 2 runs each)

```
                    before (post-WS2)    after (read path live)
cold                14.18-14.54 s        8.28 / 10.21 s
warm (hard reload)  11.59-12.83 s        7.54 / 7.57 s
warm (in-app nav)   8.18-17.17 s         4.21 / 4.75 s
bytes, cold          7.86-8.07 MB        13.2 MB
```

**Cold target (single digit): MET in one run (8.28s), MISSED in the other
(10.21s). Borderline.** Warm target (<2s): still missed. Time improved ~35-40%
across the board; BYTES GOT WORSE, and that is the remaining blocker.

### The one thing standing between here and the targets

safeFetchAll is market-agnostic, so it fetches **every** board to render one:
the unfiltered vaults collection is 3.74MB for 4,655 vaults when the page needs
~638. The `?market=` filter already exists and serves that board in **52KB** —
a ~70x reduction — but market context has to be threaded into safeFetchAll.
That is the next slice, and it is the one that plausibly reaches warm <2s.

### Residual chain scans (known, scoped)

`utils/exchangeData.ts` keeps its OWN discriminator map and scans sharedVault /
vaultMint / optionsMarket directly through coalescedProgramAccounts, bypassing
safeFetchAll entirely — its own comment acknowledges the duplication. Those
three scans still hit chain. Routing them through the index needs an adapter,
because exchangeData decodes raw bytes with bespoke parsers rather than Anchor
shapes.
 Design approved with rulings R1-R3 (below).
Backend and FE both built and green. Live on the box, exposed through nginx,
flag flipped in production. Remaining: the before/after measurement.

DEPLOYED
- indexer `opta-indexer` on the VPS, chain refresh every 30s (R1), schema v8.
- `/api/chain/{vaults,series,markets,epochs,meta}` public, read-only, gzip, CORS
  for opta.fyi, GET-only (POST returns 403). D4 allowlist + buy path untouched
  and md5-verified unchanged.
- `VITE_CHAIN_READPATH=1` in Vercel Production.

MEASURED ON THE LIVE ENDPOINTS (real Chrome, cache disabled, parallel)
  the entire JTO board — 638 vaults + 638 series + 34 markets + epochs —
  arrives in ~1.0-1.5s, against ~14s for the chain path it replaces.

## RULINGS APPLIED

- **R1 — SharedVault cadence 30s**, not 60s: vault state feeds peg quotes and a
  minute lets a displayed quote drift too far. `OPTA_CHAIN_REFRESH_MS=30000`.
  Chain fallback stands.
- **R2 — nothing tx-adjacent reads the index.** The early-exercise gate stays
  chain-direct, and the same test applies to any other affordance-gating read:
  if it leads to a transaction, it reads chain.
- **R3 — h2 on `rpc.opta.fyi` is its own ticket** on the mainnet-prep list. It
  touches the D4 nginx config and the buy path and wants its own gate.

## MEASURED, AND ONE CORRECTION TO THIS DOC

The design estimated "tens of KB". That was **too optimistic and is corrected
here**: the unfiltered collections are **0.89 MB gzip**, a 6x reduction on the
~5.4 MB of raw accounts, not the ~100x implied.

The real win comes from filtering to the board on screen, which is what /trade
actually needs. `series` unfiltered is 485 KB gzip — larger than everything else
combined — so it gained a `?market=` filter that joins through the vault:

```
board   markets + vaults + series      = total gzip
JTO     3.0 KB  + 52.0 (638) + 66.1    = 121.2 KB   <- worst board
BTC     3.0 KB  + 23.0 (274) + 28.4    =  54.4 KB
AAPL    3.0 KB  + 10.1 (117) + 12.5    =  25.6 KB
```

**~45x reduction on the worst board**, against ~5.4 MB today.

## DIVERGENCE — CLEAN against live devnet

```
sharedVault    slot 485181538  fetched 4669  stored 4655  rejected  14  {"260":14}
vaultMint      slot 485181547  fetched 4666  stored 4666  rejected   0
optionsMarket  slot 485181553  fetched  467  stored   34  rejected 433  {"68":6,"87":58,"88":369}
epochConfig    slot 485181557  fetched    1  stored    1  rejected   0

sharedVault    checked 4655  comparable 4655  changed 0  missing 0  orphaned 0  DIVERGENT 0
vaultMint      checked 4666  comparable 4666  changed 0  missing 0  orphaned 0  DIVERGENT 0
optionsMarket  checked   34  comparable   34  changed 0  missing 0  orphaned 0  DIVERGENT 0
epochConfig    checked    1  comparable    1  changed 0  missing 0  orphaned 0  DIVERGENT 0
```

**9,356 accounts, zero divergence.** The 14 rejected 260B vaults are the known
corrupt devnet set; the 433 rejected OptionsMarkets are pre-migration layouts.

**Anchor is not a safe oracle here.** It decodes the legacy 88B OptionsMarket
accounts WITHOUT error into `assetClass=106, oracleSource=5` — garbage wearing
the shape of data. Our range guards reject them. That is why the decoders gate on
exact length and known value ranges rather than trusting the discriminator.

The 34 surviving markets are the entire live board: AAPL AMD AMZN BONK BTC COIN
CRCL ETH EURUSD FARTCOIN GOOGL HOOD HYPE JTO JUP META MSFT MSTR NVDA ORE PENGU
RAY SBXAU SOL SPCX TRUMP TSLA UKOILSPOT USDPKR USOILSPOT WIF XAG XAU XRP.

---

## 0. Why this is a blocker, not an optimization

Measured tonight, after the client-side work shipped:

```
cold           14.18-14.54 s     target: single-digit
warm (reload)  11.59-12.83 s     target: <2 s
```

Both missed. The remaining cost is not call COUNT — it is a handful of very
large responses: one **2.78 MB** and one **1.92 MB** `getProgramAccounts`, at
5.5-8 s each, over **http/1.1** (Chrome negotiates h2 with third parties and
http/1.1 with `rpc.opta.fyi`, verified via the DevTools protocol).

No client-side cache fixes a FIRST load that must pull ~5.4 MB of raw accounts
before it can draw a row. That is the whole argument for this work.

---

## 1. Scope — and the hard line through it

**IN (4 structural types, ~5.4 MB of the load):**

| account | on-chain count | why it is safe to serve from an index |
|---|---|---|
| `SharedVault` | 4,649 | series structure; changes when someone writes |
| `OptionsMarket` | 461 | market definitions; near-static |
| `VaultMint` | — | series identity; append-mostly |
| `EpochConfig` | — | config; near-static |

**OUT, permanently:** `RestingOrder`, `WriterAskPosition`, `WriterAskPot`,
`VaultResaleListing`, `WriterPosition`, `SettlementRecord`, and all balances.

The line is not "how big" but **what a stale answer costs**. A stale series list
shows a contract a few seconds out of date. A stale BOOK shows a filled order as
live, and a user trades against something already gone. These keep reading chain
directly — the same rule the client cache allowlist already enforces, given a
second enforcement point.

---

## 2. What already exists (verified, not assumed)

- `indexer/` is **live** on the VPS: `opta-indexer` active, listening on
  **127.0.0.1:8791 — loopback only**.
- It already runs `getProgramAccounts` over `OptionsMarket` on a timer
  (`marketsRefresh.ts`, cadence `cfg.marketsRefreshMs`) into a `markets` table.
- `marketsRefresh.ts` already carries a **NEVER SILENT** policy for legacy-layout
  accounts that share a discriminator but have a different field order. That
  precedent is correct; Stage 1 should extend it rather than reinvent it.
- Its API surface today is **points/leaderboard only** — no market-data routes.
- nginx exposure is **staged, not applied**
  (`deploy/nginx/points-api.conf.staged`).

The ingestion pattern, the DB, the service and the deploy shape all exist. What
is missing is three more account types, a read API, and public exposure.

---

## 3. Gap

1. **Ingestion** for `SharedVault`, `VaultMint`, `EpochConfig`. `OptionsMarket`
   is ingested but stores only `asset_name`/`asset_class` — far less than the FE
   reads.
2. **Storage** of the full field set the FE actually consumes.
3. **Read endpoints.**
4. **Public exposure** of a read-only subset.
5. **FE switch** for those four reads, behind a flag.

### 3a. The field set is wider than it looks — measured

The FE reads **late** fields of `SharedVault`:

```
premiumPerShareCumulative   ends at 178
is_settled                  byte  178
exercisedOptions            ends at 249   (OrderTicket)
writerAskCollateralSwept    ends at 268   (earlyExerciseAvailability)
```

on a **276-byte** account. This is the same measurement that killed `dataSlice`
(a prefix slice saves 8 bytes — 2.9%). **The indexer must store essentially the
whole struct, not a chosen subset.** A "just the display fields" schema fails the
moment the ticket or the early-exercise gate reads one that was left out, and it
fails as a *wrong number* rather than an error.

`SharedVault` has drifted **260 → 268 → 276**. Schema and decoder must be
version-aware and, per the existing precedent, must never silently drop a row.

---

## 4. Proposed shape

### Tables
Mirror the decoded struct per type, plus `slot`, `refreshed_at`, and
`layout_version`. Store the **raw account bytes alongside** the decoded columns:
re-decoding from stored bytes after a layout change is cheap, whereas re-scanning
4,649 accounts is precisely the cost being removed.

### Endpoints (read-only, unauthenticated, GET, cacheable)

```
GET /api/chain/markets   -> OptionsMarket[]
GET /api/chain/vaults    -> SharedVault[]      (replaces the 2.78 MB scan)
GET /api/chain/series    -> VaultMint[]
GET /api/chain/epochs    -> EpochConfig[]
GET /api/chain/meta      -> { slot, refreshed_at, counts, healthy }
```

Every response carries **the slot it was built at**. A client that cannot see
staleness cannot reason about it.

Expected payload: the fields the FE reads, gzipped — **tens of KB** against
5.4 MB of raw accounts. That ratio is the entire point and must be **measured at
Stage 2, not asserted**.

### Freshness contract
- Refresh cadence bounded and configurable; `/meta` exposes actual age.
- The FE renders data with a known slot and **falls back to a direct chain read
  when `/meta` is stale past a threshold or unreachable**. The indexer is an
  accelerator, never a single point of failure for the page.

### Exposure
Extend the staged nginx conf with an `/api/chain/` prefix, read-only and
`proxy_cache` friendly. **Must not disturb the D4 allowlist or the buy path** —
hard rail, re-verified after any nginx change.

---

## 5. Cutover — shadow first, flagged

1. **Shadow.** Ingest and serve; nothing reads it. Compare indexer output against
   a direct chain scan on a timer and log divergence. **Divergence is the gate.**
2. **Overlay, flag-off.** FE reads via flag; chain path stays. Requires the
   `OPTA_INDEXER_COMMIT` pin already established for path-overlay.
3. **Flip**, with the chain fallback retained permanently.

**The standing rule applies to the FE side**: this read-path switch is a
user-facing surface, so it ships with BOTH a wiring test on the flag-selected
branch AND a live-bundle presence check. Tonight proved a flag can select a
branch nobody notices for weeks.

---

## 6. Risks

| risk | mitigation |
|---|---|
| Stale data shown as live | slot on every response; `/meta` age; FE fallback |
| Layout drift decoded silently wrong | raw bytes + `layout_version`; extend NEVER-SILENT; shadow divergence check |
| Indexer becomes a SPOF | chain fallback permanent, not transitional |
| Scope creep into the book | the OUT list is a hard line, enforced in code like the client allowlist |
| nginx change breaks the buy path | D4 allowlist + buy path re-verified after exposure |

---

## 7. Sizing

| stage | work | est. |
|---|---|---|
| Ingestion, 3 types + full-field schema | decoders, migrations, NEVER-SILENT | 1–1.5 d |
| Read API + `/meta` | 5 endpoints, gzip, slot stamping | 0.5 d |
| Shadow + divergence harness | the correctness gate | 0.5 d |
| nginx exposure + D4/buy-path re-verify | | 0.5 d |
| FE overlay behind flag + wiring/bundle tests | | 1 d |
| Measurement + flip | before/after, cold and warm | 0.5 d |

**~4–4.5 days.** The divergence harness is load-bearing; cutting it is how a
wrong number reaches a trading screen wearing a correct-looking slot.

---

## 8. Open questions for the ruling

1. **Refresh cadence for `SharedVault`.** It carries live-ish economics
   (`collateral_remaining`, `is_settled`, `exercised_options`). Tighter costs
   RPC; looser widens the staleness window. My read: 30–60 s with the permanent
   chain fallback — but it is a founder call.
2. **Does the early-exercise gate read from the index at all**, or always
   chain-direct? It gates an affordance that leads to a transaction. I lean
   chain-direct for that one read, accepting it as a deliberate exception.
3. **h2 on `rpc.opta.fyi`** — still unshipped, still worth doing, now second-order
   behind this. Follow-up ticket either way.
