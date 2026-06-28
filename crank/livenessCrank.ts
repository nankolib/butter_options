// =============================================================================
// crank/livenessCrank.ts — source-liveness probe loop (Phase 2a)
// =============================================================================
//
// Maintains the shared liveness map (livenessStore.ts) that the FE reads (via the
// sb-create endpoint's GET /liveness) to route create-time source selection in
// Phase 2b. Probes two source families on independent cadences:
//
//   Pyth (cheap, batched, frequent): one Hermes /v2/updates/price/latest call for
//     many feed ids → publish_time per feed. Live = now - publish_time <= max age.
//     A stale publish_time or a missing feed → miss (this naturally marks
//     off-hours equities/FX dead — correct). Hermes 404s the WHOLE call if ANY id
//     is unknown, so a failed chunk is recursively split to isolate the bad id.
//
//   Switchboard (per-feed, less frequent): crossbar.simulateJobs of the feed's
//     job spec (the same call the Phase-1 cross-check uses). A successful simulate
//     with a positive price = a hit; bounded retries per probe absorb the ~3/15
//     gateway flakiness.
//
// HYSTERESIS (protects the one SB asset from flicker): a hit flips dead->live
// IMMEDIATELY (misses reset to 0); a miss flips live->dead ONLY after
// DEAD_AFTER_MISSES consecutive misses. A single transient simulateJobs / Hermes
// miss therefore never marks a feed dead — the state holds.
//
// SCOPING NOTE (flag for review): by default this probes TradFi Pyth feeds
// (classes 1-4) + all SB feeds, NOT the full Hermes catalog. Crypto (class 0) is
// ~always-live AND the FE defaults crypto->Pyth regardless, so probing the
// hundreds of crypto feeds every cycle is pure Hermes load for ~zero value — a
// missing crypto entry just makes the FE use its static default (Pyth), which is
// already correct. Set OPTA_LIVENESS_PROBE_ALL=1 to probe the entire catalog.
//
// ISOLATION: every probe call is wrapped (per-chunk / per-feed try/catch) so a
// transient failure never escapes the loop. Mounted in bot.ts's Promise.all set
// with the same fail-loud wrapper as the other side-loops; only a genuine bug
// (not a transient probe error) would propagate -> supervisor restart.
// =============================================================================

import { CrossbarClient } from "@switchboard-xyz/common";
import { fetchCatalog } from "@app/utils/hermesCatalog";
import { SB_FEED_DATA } from "@app/utils/sbFeedData";
import { lookupSbFeed } from "./sbFeedRegistry";
import { setLivenessMap, type FeedLiveness } from "./livenessStore";

export interface LivenessCrankContext {
  hermesBase: string;
  log: (
    level: "info" | "warn" | "error",
    msg: string,
    fields?: Record<string, unknown>,
  ) => void;
  shouldShutdown: () => boolean;
}

export interface LivenessCrankOptions {
  tickOnce?: boolean;
}

// ---- tunables (env-overridable) --------------------------------------------
const numEnv = (v: string | undefined, d: number) => {
  const n = v ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : d;
};
const PYTH_PROBE_MS = numEnv(process.env.OPTA_LIVENESS_PYTH_MS, 60_000);
const SB_PROBE_MS = numEnv(process.env.OPTA_LIVENESS_SB_MS, 180_000);
const CATALOG_REFRESH_MS = numEnv(process.env.OPTA_LIVENESS_CATALOG_MS, 3_600_000);
const PYTH_LIVE_MAX_AGE_SECS = numEnv(process.env.OPTA_LIVENESS_PYTH_MAX_AGE_S, 120);
const HERMES_BATCH = numEnv(process.env.OPTA_LIVENESS_HERMES_BATCH, 50);
/** K — flip live->dead only after this many CONSECUTIVE misses (hysteresis). */
const DEAD_AFTER_MISSES = numEnv(process.env.OPTA_LIVENESS_DEAD_AFTER, 3);
const SB_SIMULATE_ATTEMPTS = numEnv(process.env.OPTA_LIVENESS_SB_ATTEMPTS, 4);
const PROBE_ALL_PYTH = (process.env.OPTA_LIVENESS_PROBE_ALL ?? "") === "1";
const CROSSBAR_URL = "https://crossbar.switchboard.xyz";
const SHUTDOWN_CHECK_MS = 5000;

const short = (e: unknown) => String((e as any)?.message ?? e).slice(0, 200);
const nowSec = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const norm = (hex: string) => hex.toLowerCase().replace(/^0x/, "");

/** First finite, positive numeric value in a Crossbar simulateJobs results array. */
function firstNumber(results: unknown[] | null | undefined): number | null {
  if (!Array.isArray(results)) return null;
  for (const r of results) {
    const n = typeof r === "number" ? r : typeof r === "string" ? parseFloat(r) : NaN;
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

interface FeedState {
  source: 0 | 1;
  jobs?: Array<Record<string, unknown>>; // SB only
  live: boolean;
  asOf: number;
  samples: number | null;
  misses: number;
}

/** Probe a chunk of Pyth ids into `out` (id -> publish_time). On a non-200 (Hermes
 *  404s the whole call if ANY id is unknown) recursively split to isolate the bad
 *  id; a failing singleton stays absent -> counted a miss by the caller. */
async function probePythInto(
  ids: string[],
  hermesBase: string,
  out: Map<string, number>,
): Promise<void> {
  if (ids.length === 0) return;
  const qs = ids.map((h) => `ids[]=0x${h}`).join("&");
  const url = `${hermesBase}/v2/updates/price/latest?${qs}&encoding=base64`;
  let ok = false;
  try {
    const resp = await fetch(url);
    if (resp.ok) {
      const json: any = await resp.json();
      for (const p of json?.parsed ?? []) {
        const id = norm(String(p?.id ?? ""));
        const pt = p?.price?.publish_time;
        if (id && typeof pt === "number") out.set(id, pt);
      }
      ok = true;
    }
  } catch {
    /* network/parse error → treat as a failed chunk, split below */
  }
  if (ok || ids.length === 1) return;
  const mid = ids.length >> 1;
  await probePythInto(ids.slice(0, mid), hermesBase, out);
  await probePythInto(ids.slice(mid), hermesBase, out);
}

/**
 * Run the liveness probe loop. Resolves only on shutdown (or after one tick when
 * opts.tickOnce). Defensive throughout — transient probe failures are caught and
 * logged, never propagated.
 */
export async function runLivenessCrank(
  ctx: LivenessCrankContext,
  opts: LivenessCrankOptions,
): Promise<void> {
  const crossbar = new CrossbarClient(CROSSBAR_URL);
  const state = new Map<string, FeedState>(); // feedIdHex -> state
  let lastCatalog = 0;
  let lastSb = 0;

  const markHit = (s: FeedState, asOf: number) => {
    s.live = true;
    s.misses = 0;
    s.asOf = asOf;
  };
  const markMiss = (s: FeedState) => {
    s.misses += 1;
    if (s.misses >= DEAD_AFTER_MISSES) s.live = false;
  };

  const refreshFeedSet = async () => {
    // Pyth feeds from the live Hermes catalog (TradFi by default; +crypto if PROBE_ALL).
    try {
      const entries = await fetchCatalog(ctx.hermesBase);
      let added = 0;
      for (const e of entries) {
        if (!PROBE_ALL_PYTH && e.suggestedAssetClass === 0) continue;
        const id = norm(e.feedIdHex);
        if (!state.has(id)) {
          state.set(id, { source: 0, live: false, asOf: 0, samples: null, misses: 0 });
          added++;
        }
      }
      ctx.log("info", "liveness feed-set refreshed (Pyth)", {
        catalogEntries: entries.length,
        pythTracked: [...state.values()].filter((s) => s.source === 0).length,
        added,
        probeAllPyth: PROBE_ALL_PYTH,
      });
    } catch (e) {
      ctx.log("warn", "liveness catalog refresh failed (keeping prior feed set)", {
        err: short(e),
      });
    }
    // SB feeds (always probed — the high-value set).
    for (const d of SB_FEED_DATA) {
      const id = norm(d.feedHashHex);
      if (!state.has(id)) {
        const entry = lookupSbFeed(id);
        state.set(id, {
          source: 1,
          jobs: entry?.jobs,
          live: false,
          asOf: 0,
          samples: d.minOracleSamples ?? null,
          misses: 0,
        });
      }
    }
  };

  const probePyth = async () => {
    const ids = [...state.entries()]
      .filter(([, s]) => s.source === 0)
      .map(([id]) => id);
    if (ids.length === 0) return;
    const pt = new Map<string, number>();
    for (let i = 0; i < ids.length; i += HERMES_BATCH) {
      await probePythInto(ids.slice(i, i + HERMES_BATCH), ctx.hermesBase, pt);
    }
    const now = nowSec();
    let live = 0;
    for (const id of ids) {
      const s = state.get(id)!;
      const t = pt.get(id);
      if (t !== undefined && now - t <= PYTH_LIVE_MAX_AGE_SECS) {
        markHit(s, t);
        live++;
      } else {
        markMiss(s);
      }
    }
    ctx.log("info", "liveness Pyth probe", { tracked: ids.length, live });
  };

  const probeSb = async () => {
    let live = 0;
    let total = 0;
    for (const [, s] of state) {
      if (s.source !== 1 || !s.jobs) continue;
      total++;
      let price: number | null = null;
      for (let a = 1; a <= SB_SIMULATE_ATTEMPTS && price === null; a++) {
        try {
          const resp = await crossbar.simulateJobs({ jobs: s.jobs as any });
          if (!resp.error) price = firstNumber(resp.results);
        } catch {
          /* transient gateway miss — retry */
        }
      }
      if (price !== null) {
        markHit(s, nowSec());
        live++;
      } else {
        markMiss(s);
      }
    }
    if (total > 0) ctx.log("info", "liveness SB probe", { tracked: total, live });
  };

  const publish = () => {
    const feeds: Record<string, FeedLiveness> = {};
    for (const [id, s] of state) {
      feeds[id] = { source: s.source, live: s.live, asOf: s.asOf, samples: s.samples };
    }
    setLivenessMap({ updatedAt: nowSec(), feeds });
  };

  ctx.log("info", "liveness crank started", {
    pythProbeMs: PYTH_PROBE_MS,
    sbProbeMs: SB_PROBE_MS,
    pythMaxAgeS: PYTH_LIVE_MAX_AGE_SECS,
    deadAfterMisses: DEAD_AFTER_MISSES,
    probeAllPyth: PROBE_ALL_PYTH,
    tickOnce: !!opts.tickOnce,
  });

  do {
    if (Date.now() - lastCatalog >= CATALOG_REFRESH_MS) {
      await refreshFeedSet();
      lastCatalog = Date.now();
    }
    await probePyth();
    if (Date.now() - lastSb >= SB_PROBE_MS) {
      await probeSb();
      lastSb = Date.now();
    }
    publish();

    if (opts.tickOnce) break;

    // Interruptible sleep (SHUTDOWN_CHECK_MS granularity) until the next Pyth tick.
    let slept = 0;
    while (slept < PYTH_PROBE_MS && !ctx.shouldShutdown()) {
      const chunk = Math.min(PYTH_PROBE_MS - slept, SHUTDOWN_CHECK_MS);
      await sleep(chunk);
      slept += chunk;
    }
  } while (!ctx.shouldShutdown());

  ctx.log("info", "liveness crank stopped cleanly");
}
