# PROPOSAL — decouple the chain refresh onto its own timer (`86eyp59v7`)

Local planning doc, deliberately uncommitted.

**Status: PROPOSAL ONLY. Nothing built. Stopping here for the ruling.**

---

## 1. Root cause, exactly

`chainRefreshMs` is 30 s and the refresh runs at ~64 s. The reason is one line at
the tail of the main loop:

```ts
for (let waited = 0; waited < cfg.tickMs && !stopping; waited += 500) {
  await new Promise((r) => setTimeout(r, 500));
}
```

`tickMs = 60_000`. Every subsystem — poller, capital tick, markets refresh, chain
refresh, shadow render — is checked **once per loop iteration**, and each
iteration ends in a 60 s sleep. So `chainRefreshMs = 30_000` can never be
honoured: the loop simply does not come round that often.

This matches the measurement exactly:

```
per-type refresh interval   p50  63.6s   p95 129.4s   max 531.8s
the four scans themselves   p50   1.0s   p95   1.6s   max   3.7s
```

60 s sleep + ~3.6 s of work = 63.6 s. **The cadence constant was never in
control**, which is why widening the staleness threshold was the only thing that
worked.

The p95 of 129.4 s is two loop iterations — an iteration where the poller or
capital tick took long enough to push the chain check past its window.

---

## 2. Proposed change

Run `refreshChain` on its own timer, independent of the tail sleep.

```ts
// sketch, not final
let chainTimer: NodeJS.Timeout | null = null;
let chainInFlight: Promise<void> | null = null;

const chainTick = async () => {
  if (chainInFlight) return;              // never overlap with itself
  chainInFlight = (async () => {
    try { await refreshChain(db, rpc, cfg.programId); }
    catch (e) { log.error("chain refresh failed", { err: (e as Error).message }); }
    finally { chainInFlight = null; }
  })();
  await chainInFlight;
};
chainTimer = setInterval(() => void chainTick(), cfg.chainRefreshMs);
```

and remove the in-loop `lastChain` block.

---

## 3. The four things the ticket requires proving

### 3a. The tape poller is unaffected

The risk is not data corruption — Node is single-threaded and `better-sqlite3` is
synchronous, so there is no interleaved write. The risk is **event-loop
occupancy**: a chain refresh decoding 4,665 vaults holds the loop, and
`poller.tail()` cannot resume until it yields.

- **Proof:** cursor advance before/after, and `txsIndexed` totals over a fixed
  window compared against the current build. The existing
  `poller.cursor.test.ts` guarantee — a partial ingest must not advance the
  cursor — must still hold.
- **Note:** this contention already exists today; decoupling changes *when* it
  happens, not *whether*. Twice as often, though — see §4.

### 3b. The capital tick is unaffected

Runs every 600 s and is far longer than either. Same occupancy argument.

- **Proof:** `capital tick` log lines keep their cadence and their
  `atasPolled` / `flowsIndexed` counts over a fixed window.

### 3c. Warmup re-verified

The ~3.5 min startup window where `/api/chain/*` returns 504 is **synchronous
SQLite startup work blocking the event loop** while the HTTP server is already
bound. A `setInterval` armed before that work completes will queue and fire late,
possibly several times.

- **Mitigation:** arm the timer only after `entering live tail`, and keep the
  single-flight guard so a queued burst collapses to one run.
- **Proof:** restart, watch for the 504 window, confirm it does not lengthen, and
  confirm `/api/chain/meta` reaches `healthy=true` no later than today.

### 3d. Threshold re-derived from fresh numbers

`STALE_AFTER_SEC = 200` was derived from the CURRENT interval distribution. After
this change that distribution moves, and **the constant must be re-measured, not
hand-scaled** — the whole point of the earlier failure was a constant that had
been reasoned rather than measured.

- **Proof:** re-run the same 280-sample collection over ≥6 h post-change, publish
  p50/p95/max, and set the threshold from the new p95 with the same margin rule.
  Expected new p95 is ~35–40 s, which would make 200 s comfortably conservative
  rather than necessary — that is the goal, not a smaller number.

---

## 4. The cost nobody has priced yet — flagging before, not after

Doubling the effective cadence roughly doubles the scan volume.

```
today   ~1,360 cycles/day (86400 / 63.6)  x 4 scans = ~5,440 gPA/day
after   ~2,880 cycles/day (86400 / 30)    x 4 scans = ~11,520 gPA/day
```

Per cycle the scans move ~4.8 MB (vaults 2.79, series 1.93, markets 0.10, epochs
~0). That is roughly **+6,000 gPA calls and +7 GB/day** of RPC egress on the box.

**This arc began with RPC credit exhaustion.** So this is a real trade, not a
free win, and it deserves an explicit decision:

- **Option A — true 30 s.** Best freshness, highest cost.
- **Option B — decouple but keep ~60 s.** Removes the *coupling* (the chain
  refresh stops being hostage to a slow poller iteration, so the 129 s p95 and
  531 s tail collapse) at **no extra RPC cost at all**. Freshness p95 improves
  dramatically even though p50 does not move.
- **Option C — adaptive.** Stretch cadence when scan latency rises. More code,
  and the failure mode is subtle.

**My recommendation is B.** The problem this ticket exists to solve is the p95 and
the tail — 129 s and 531 s — not the median. Option B fixes those for free and
still makes the 200 s threshold conservative. Option A buys a better median at a
cost the earlier credit-exhaustion arc suggests we should not spend without
wanting it specifically.

---

## 5. Shutdown correctness

Today the loop exits and calls `db.close()`. With a timer there is a new hazard:
a refresh in flight during shutdown would write to a closed database.

Required, and cheap:

```ts
if (chainTimer) clearInterval(chainTimer);
if (chainInFlight) await chainInFlight;   // BEFORE db.close()
db.close();
```

- **Proof:** `systemctl stop` during an active refresh still logs
  `stopped cleanly`, with no `database is closed` error.

---

## 6. Effort

| | |
|---|---|
| Timer + single-flight + shutdown ordering | 0.5 d |
| Proof runs for 3a–3c (fixed-window comparison against current build) | 0.5 d |
| ≥6 h observation + threshold re-derivation (3d) | elapsed, not effort |

**~1 day of work, plus a 6 h observation window before the threshold is re-set.**

---

## 7. Open question for the ruling

**A, B or C in §4?** Everything else here is mechanical; that is the only
decision with a cost attached.
