# Seeker vC3 Rev C — indexer read path (hybrid). PROPOSAL ONLY.

**No build. Mint HELD. Submission frozen.** Local doc, uncommitted.
Drafted 2026-08-26, after the Rev B device result.

Device result that forces this: offerings **do** render (fix A confirmed), but the UI hangs
before and repeatedly after. Refresh (60s) << load (120-180s) ⇒ near-continuous scan+decode.
The 19:04–19:16 proxy capture shows the perpetual cycle: scan (n=4) → spot (n=23) → scan,
forever. Client full-chain scanning on mobile is architecturally dead.

---

## 1. Coverage — what the indexer actually serves

Endpoints exist and are **publicly reachable** (verified with `okhttp/4.9.2`, no Origin):

| Endpoint | Account type | gz | raw | Filters |
|---|---|---:|---:|---|
| `/api/chain/vaults` | SharedVault | 518,202 B | 4,268,342 B | `market=`, `keys=` (csv, capped), `limit=` |
| `/api/chain/series` | VaultMint | 604,621 B | 1,663,640 B | same family |
| `/api/chain/markets` | OptionsMarket | 3,632 B | 8,480 B | — |
| `/api/chain/epochs` | EpochConfig | 320 B | 320 B | — |
| `/api/chain/meta` | freshness | 898 B | 898 B | — |

**The unfiltered form is a trap.** `vaults` + `series` unfiltered = 1.12 MB gz / **5.93 MB raw** —
*more* JSON to parse than today's 5.26 MB of base64. Swapping transport alone would not fix
the hang; it would move it.

**Market-filtered is the whole win** (WIF board, `?market=7X7AuBsK…`):

| | gz | raw | rows |
|---|---:|---:|---:|
| `vaults?market=` | 30,900 B | 260,693 B | 326 |
| `series?market=` | 37,013 B | 102,092 B | — |
| **per board** | **~68 KB** | **~363 KB** | |

vs today's **~1.65 MB gz / 5.26 MB raw + 10,434 client-side account decodes**.
**~24× less wire, ~14× less parse, and zero manual offset decoding.**

Row shape carries every field mobile parses (28 SharedVault fields incl. `writerAskCollateralSwept`,
`writerAskEquivShares`), already decoded to JSON.

### Split — indexer vs chain-direct

| Type | Route | Why |
|---|---|---|
| SharedVault | **indexer** `vaults?market=` | the disease, 5,217 accounts |
| VaultMint | **indexer** `series?market=` | the other half, 5,217 accounts |
| OptionsMarket | **indexer** `markets` | 8 KB raw, and the indexer already rejects the 433 legacy rows server-side |
| EpochConfig | **indexer** `epochs` | 320 B |
| **VaultResaleListing** | **chain-direct** | **no endpoint exists.** Currently 1 account / 492 B — trivial gPA, leave it |
| **ProtocolState** | **chain-direct** | no endpoint; single `getAccountInfo`, and it is a **tx-building input** (see §3) |
| **VolOracle** | **chain-direct** | no endpoint; already per-asset `getAccountInfo` in the deferred spot stage |

Free side-effect: `markets` returns 35 rows, not 468. The **880 `Skipping unreadable` bridge
calls per load disappear entirely** — the indexer's own meta reports
`optionsMarket: fetched 468, stored 35, rejected 433` and `sharedVault: rejected 14 {260:14}`.
It already does that filtering server-side.

## 2. Staleness — never worse than today

Envelope per endpoint: `{slot, refreshedAt, ageSec, stale, count, rejected, rows}`.
`/api/chain/meta`: `{healthy, oldestAgeSec, staleAfterSec: 110, lineage:{programId, deploySlot, key}, kinds:{…}}`.

Model on the web FE, `app/src/utils/chainReadPath.ts` — same four types, same fallback:

```ts
const ENDPOINT: Partial<Record<AccountName, string>> = {
  sharedVault: "vaults", vaultMint: "series",
  optionsMarket: "markets", epochConfig: "epochs",
};
...
if (!isServableEnvelope(body, MAX_AGE_SEC)) return null;   // -> caller falls through to chain
```

Rule for mobile:
1. `stale === true`, or `ageSec > staleAfterSec` (110), or `healthy === false` → **fall back to the
   current chain scan**. Today's behaviour is the floor; Rev C can never be worse.
2. **Lineage guard:** reject the envelope if `lineage.key !== programId:deploySlot` the APK expects.
   An indexer pointed at a different deploy must not silently feed a field build.
3. Any non-200, timeout, or parse failure → fall back. Never surface indexer failure as a user error.
4. Ship behind a constant defaulting **off**, mirroring `CHAIN_READPATH_ENABLED`. Flip deliberately.

## 3. Correctness — the re-read is ABSENT and must be added

**Verified, not assumed.** `mobile/src/solana/transactions.ts`:

- `buildPrimaryPurchaseTx` uses `const vault = offering.vault;` / `const vaultMint = offering.vaultMint;`
  and reads `vault.account.vaultUsdcAccount` (:353), `vault.account.market` (:348),
  `offering.vaultMint.account.optionMint` (:393) — **all from the snapshot**.
- Only `protocolState` is chain-direct (`fetchDecodedAccount`, :103).

Today those snapshot objects come from a chain scan, so they are chain-derived but possibly
stale. Under Rev C they would become **index rows**, which is a genuine correctness change.

**Mandatory in Rev C:** before signing, re-read the specific `sharedVault` and `vaultMint` by
pubkey chain-direct via `fetchDecodedAccount`, and build the tx from those. Two reads, ~1 KB,
on a path the user already waits on. Index rows may drive *display*; they must never drive
*a signature*. Same rule the web ticket adopted.

## 4. Same build regardless (independent of the indexer flag)

| Change | File | Detail |
|---|---|---|
| `AUTO_REFRESH_MS` 60s → **300s** | `state/useMarketState.ts` | 60s was senseless at these payloads even post-fix |
| Aggregate the per-account warns | `solana/program.ts` | one `Skipping N unreadable X accounts` line instead of 880 bridge calls |
| Pause refresh when backgrounded | `state/useMarketState.ts` | the `AppState` listener already exists (refreshes on `active`); add interval clear on `background`. Trivial |

## 5. Effort, numbers, risk

### Wiring

| File | Change | est. LOC |
|---|---|---:|
| `solana/indexerReadPath.ts` *(new)* | endpoint map, envelope validation, lineage guard, timeout, flag | ~120 |
| `solana/marketData.ts` | try indexer per type, fall back to `safeFetchAll`; pass `market` filter | ~60 |
| `solana/transactions.ts` | chain-direct re-read of vault + vaultMint before build (§3) | ~25 |
| `solana/program.ts` | aggregate warns | ~10 |
| `state/useMarketState.ts` | refresh interval, background pause | ~15 |
| `constants.ts` | `INDEXER_BASE`, `INDEXER_ENABLED`, expected lineage | ~6 |
| tests | envelope/stale/lineage/fallback + re-read guard | ~150 |
| **Total** | | **~390** |

### Expected after

- **Time-to-offerings: ~3–6 s** for the selected board (68 KB gz, JSON.parse of 363 KB, no manual decode),
  against 25–40 s estimated for Rev B and the observed 120–180 s before it.
- **Refresh cost: ~68 KB per board per 300 s**, vs ~1.65 MB per 60 s. That is roughly a **125× drop in
  sustained bytes**, and it is the number that ends the perpetual cycle.
- The near-continuous decode that produces the hangs simply stops existing.

### Rev B fixes stay

A, B and C are correct regardless of where the data comes from and must **not** be reverted.
A is what guarantees a first paint under any latency; B stops refresh starvation; C keeps the
spot tail off the first paint. Rev C reduces the load that made them load-bearing — it does not
replace them.

### Risks

| Risk | Assessment |
|---|---|
| **CORS from RN/okhttp** | **Verified non-issue.** Vhost sends `Access-Control-Allow-Origin: https://opta.fyi`, but all five endpoints returned **200** to `okhttp/4.9.2` with **no Origin header** — RN is not a browser and does not enforce CORS. Confirmed empirically, not assumed |
| **Indexer becomes a hard dependency** | Mitigated by §2 fallback. Worst case = today |
| **Index rows driving a signature** | §3 re-read is mandatory, not optional |
| **Indexer is a single box** | `127.0.0.1:8791` behind one nginx on one host. No redundancy. A field APK that trusts it inherits that. Fallback covers correctness, not latency |
| **`cache-control: public, max-age=10`** | Fine for display; another reason signatures must not use it |
| **Unfiltered fetch by mistake** | 5.93 MB raw is *worse* than today. The `market=` filter is not an optimisation, it is the requirement |
| **Baked base URL** | `INDEXER_BASE` bakes into the APK like `EXPO_PUBLIC_RPC_URL`. Same class of build-time footgun that shipped `api.devnet.solana.com` |

## 6. Recommendation

Rev C as scoped: **four types to the indexer, market-filtered, with fallback and a mandatory
chain-direct re-read on the buy path.** Ship the §4 changes in the same build regardless of the
flag. Land the flag **off**, flip after a device check.

Arc D (close settled/voided records, −75.1%) remains worth doing — it shrinks the indexer's own
payloads and every fallback scan — but Rev C no longer depends on it.
