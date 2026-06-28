// =============================================================================
// crank/registryCrossCheck.ts — dual-source price cross-check (±2% backstop)
// =============================================================================
//
// For each registry row that carries BOTH a Pyth feed id AND an SB feed hash,
// fetch the Pyth price (Hermes) and the SB price (Crossbar `simulateJobs` of the
// feed's job spec) and require agreement within CROSS_CHECK_TOLERANCE_PCT. A
// divergent pair is a likely MISLABELED join — the SB hash resolves to a
// different underlying than the Pyth feed — so the caller drops the SB hash and
// demotes the row to Pyth-only. Same-price ≈ same-underlying is the only
// automated guard against the name-based join's false-match risk.
//
// CRANK-SIDE BY NECESSITY: the FE must stay SB-SDK-free, so the SB price can only
// be fetched here (Crossbar/SB SDK). Phase 1 (gold only): run this as the GATE
// before adding an SB feed to app/src/utils/sbFeedData.ts. Phase 4 (many feeds):
// run it periodically + publish a vetted map the FE reads for runtime demotion.
// Batch-capable (N rows → N verdicts) for that scale.
//
// NOTE: Pyth and SB are PEERS (per the Phase-1 routing amendment) — this utility
// only validates that a dual-source row's two feeds agree on price; it does not
// "prefer" either source.
// =============================================================================

import { CrossbarClient } from "@switchboard-xyz/common";
import { fetchHermesParsedPrice, DEFAULT_HERMES_BASE } from "@app/utils/pythPullPost";
import { lookupSbFeed } from "./sbFeedRegistry";

const CROSSBAR_URL = "https://crossbar.switchboard.xyz";

/** Max tolerated |pyth - sb| / pyth, in percent, for a dual-source row to pass. */
export const CROSS_CHECK_TOLERANCE_PCT = 2;

export interface DualSourceRow {
  ticker: string;
  /** 64-char hex Pyth feed id. */
  pythFeedId: string;
  /** 64-char hex SB feed hash (must be present in sbFeedRegistry for its jobs). */
  sbFeedHash: string;
}

export interface CrossCheckVerdict {
  ticker: string;
  sbFeedHash: string;
  /** True only when both prices resolved AND agree within tolerance. */
  pass: boolean;
  pythPrice: number | null;
  sbPrice: number | null;
  deviationPct: number | null;
  note: string;
}

/** First finite, positive numeric value in a Crossbar `simulateJobs` results array. */
function firstNumber(results: unknown[] | null | undefined): number | null {
  if (!Array.isArray(results)) return null;
  for (const r of results) {
    const n = typeof r === "number" ? r : typeof r === "string" ? parseFloat(r) : NaN;
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

/** Fetch the SB price by simulating the feed's registered jobs via Crossbar.
 *  Returns null if the feed isn't in the registry or the simulate fails. */
async function fetchSbPrice(
  crossbar: CrossbarClient,
  sbFeedHash: string,
): Promise<number | null> {
  const entry = lookupSbFeed(sbFeedHash);
  if (!entry) return null;
  try {
    // entry.jobs are raw OracleJob-shaped objects; Crossbar JSON-serializes them.
    const resp = await crossbar.simulateJobs({ jobs: entry.jobs as any });
    if (resp.error) return null;
    return firstNumber(resp.results);
  } catch {
    return null;
  }
}

/**
 * Cross-check a batch of dual-source rows. Pass ONLY rows that have BOTH ids
 * (Pyth-only and crypto rows need no check). A row whose prices can't both be
 * resolved is reported `pass: false` (suspect) — the caller decides whether to
 * demote or retry.
 */
export async function crossCheckDualSourceRows(
  rows: DualSourceRow[],
  opts: { hermesBase?: string; crossbar?: CrossbarClient } = {},
): Promise<CrossCheckVerdict[]> {
  const hermesBase = opts.hermesBase ?? DEFAULT_HERMES_BASE;
  const crossbar = opts.crossbar ?? new CrossbarClient(CROSSBAR_URL);

  const verdicts: CrossCheckVerdict[] = [];
  for (const row of rows) {
    const [pythPrice, sbPrice] = await Promise.all([
      fetchHermesParsedPrice(row.pythFeedId, hermesBase)
        .then((p) => p?.price ?? null)
        .catch(() => null),
      fetchSbPrice(crossbar, row.sbFeedHash),
    ]);

    let pass = false;
    let deviationPct: number | null = null;
    let note: string;
    if (pythPrice == null || sbPrice == null) {
      note = `missing price (pyth=${pythPrice}, sb=${sbPrice}) — cannot verify, treat as suspect`;
    } else {
      deviationPct = (Math.abs(pythPrice - sbPrice) / pythPrice) * 100;
      pass = deviationPct <= CROSS_CHECK_TOLERANCE_PCT;
      note = pass
        ? `ok (${deviationPct.toFixed(2)}%)`
        : `divergence ${deviationPct.toFixed(2)}% > ${CROSS_CHECK_TOLERANCE_PCT}% — likely mislabeled join, demote to Pyth-only`;
    }

    verdicts.push({
      ticker: row.ticker,
      sbFeedHash: row.sbFeedHash,
      pass,
      pythPrice,
      sbPrice,
      deviationPct,
      note,
    });
  }
  return verdicts;
}
