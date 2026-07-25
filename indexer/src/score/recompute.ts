// =============================================================================
// recompute.ts — rebuild the PROJECTION + SCORE layers from the tape
// =============================================================================
// Both are fully derived. Dropping and rebuilding them is always safe; the tape
// is never touched.
// =============================================================================

import { streamTape, type DB, type TapeSource } from "../db";
import { INTERNAL_WALLETS, isInternal, labelFor } from "../registry";
import { spanBucket } from "../tape/marketsRefresh";
import { computeMultipliers, multiplierFor, utcDay, type MultiplierResult } from "./multiplier";
import { computePnl, type PnlResult } from "./pnl";
import { computeProvenance, type FlowRow, type ProvenanceRow } from "./provenance";
import { computeReferrals, type ReferralResult, type ReferralRow } from "./referrals";
import { DEFAULT_QUESTS, QUESTS_VERSION, evaluate, type EvaluatorResult } from "./quests/evaluator";
import { DEFAULT_RULES, RULES_VERSION, score, type RulesConfig, type ScoreResult } from "./rules_v1";

/**
 * Rebuild `wallets` from the tape + registry.ts (D2: classification lives here,
 * never on the immutable tape, so changing the registry needs no re-index).
 *
 * PDA EXCLUSION. `counterparty` is harvested alongside `wallet`, and on a
 * VaultPeg fill (kind == 3) the maker is the SharedVault PDA, not a person
 * (events.rs:296-304). The D3 rule already denies those points, but without
 * this filter they would still be COUNTED as unique external wallets and
 * inflate the campaign's headline metric. Any pubkey that appears in
 * `events.vault` is a program account by construction and is excluded here —
 * a broader and more durable test than special-casing kind == 3.
 */
export function rebuildWallets(db: DB): void {
  const vaultSet = new Set(
    (db.prepare("SELECT DISTINCT vault AS v FROM events WHERE vault IS NOT NULL").all() as { v: string }[]).map(
      (r) => r.v,
    ),
  );

  const rows = (
    db
      .prepare(
        `SELECT pubkey, MIN(bt) AS first_seen, MAX(bt) AS last_seen FROM (
         SELECT wallet       AS pubkey, block_time AS bt FROM events WHERE wallet       IS NOT NULL
         UNION ALL
         SELECT counterparty AS pubkey, block_time AS bt FROM events WHERE counterparty IS NOT NULL
       ) GROUP BY pubkey`,
      )
      .all() as { pubkey: string; first_seen: number | null; last_seen: number | null }[]
  ).filter((r) => !vaultSet.has(r.pubkey));

  // The projection is rebuildable: drop any PDA a previous (pre-filter) run left.
  const dropPda = db.prepare("DELETE FROM wallets WHERE pubkey = ?");
  db.transaction(() => {
    for (const v of vaultSet) dropPda.run(v);
  })();

  const upsert = db.prepare(
    `INSERT INTO wallets (pubkey, is_internal, label, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(pubkey) DO UPDATE SET
       is_internal = excluded.is_internal,
       label       = excluded.label,
       first_seen  = excluded.first_seen,
       last_seen   = excluded.last_seen`,
  );

  db.transaction(() => {
    for (const r of rows) {
      upsert.run(r.pubkey, isInternal(r.pubkey) ? 1 : 0, labelFor(r.pubkey), r.first_seen, r.last_seen);
    }
    // Registry wallets that have not appeared on the tape yet still get a row,
    // so the internal set is always fully represented.
    for (const w of INTERNAL_WALLETS) {
      upsert.run(w.pubkey, 1, w.label, null, null);
    }
  })();
}

export interface RecomputeResult extends ScoreResult {
  externalCount: number;
  internalCount: number;
  // ---- Phase 2a ---------------------------------------------------------
  pnl: PnlResult;
  provenance: Map<string, ProvenanceRow>;
  multipliers: MultiplierResult;
  quests: EvaluatorResult;
  referrals: ReferralResult;
  /** wallet -> final points: (base x multiplier) + quests + referral income. */
  finalPoints: Map<string, number>;
  faucetClaimCount: number;
  faucetClaimWallets: number;
  marketsKnown: number;
}

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

/** Mirrors OPTA_SOCIAL_MAX_PER_DAY; the evaluator re-applies it independently. */
const SOCIAL_MAX_PER_DAY = Number(process.env.OPTA_SOCIAL_MAX_PER_DAY ?? 3);

/** mint -> underlying, joining tape (mint->vault->market) to the markets table. */
function buildUnderlyingMap(db: DB, tape: TapeSource) {
  const marketRows = db.prepare("SELECT pubkey, asset_name, asset_class FROM markets").all() as {
    pubkey: string;
    asset_name: string;
    asset_class: number;
  }[];
  const marketInfo = new Map(marketRows.map((m) => [m.pubkey, m]));

  // vault -> market, from VaultCreated (added to the allowlist in Phase 2a
  // precisely so this edge exists) and SeriesCreated.
  const vaultToMarket = new Map<string, string>();
  for (const e of tape()) {
    if (e.name !== "VaultCreated" && e.name !== "SeriesCreated") continue;
    try {
      const f = JSON.parse(e.fields_json) as { market?: string };
      if (e.vault && f.market && !vaultToMarket.has(e.vault)) vaultToMarket.set(e.vault, f.market);
    } catch {
      /* ignore */
    }
  }

  const out = new Map<string, { assetName: string; bucket: string }>();
  for (const e of tape()) {
    if (!e.option_mint || out.has(e.option_mint)) continue;
    const vault = e.vault;
    if (!vault) continue;
    const market = vaultToMarket.get(vault);
    if (!market) continue;
    const info = marketInfo.get(market);
    if (!info) continue;
    out.set(e.option_mint, { assetName: info.asset_name, bucket: spanBucket(info.asset_class) });
  }
  return { underlyingOf: out, marketsKnown: marketRows.length };
}

/** Full recompute. `asOf` is injected — no scoring module reads the clock. */
export function recompute(db: DB, asOf: number, cfg: RulesConfig = DEFAULT_RULES): RecomputeResult {
  rebuildWallets(db);

  const tape = streamTape(db);
  const result = score(tape, cfg, asOf);

  const ins = db.prepare(
    `INSERT INTO scores (rules_version, wallet, points, points_capped, breakdown_json, computed_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(rules_version, wallet) DO UPDATE SET
       points         = excluded.points,
       points_capped  = excluded.points_capped,
       breakdown_json = excluded.breakdown_json,
       computed_at    = excluded.computed_at`,
  );

  db.transaction(() => {
    db.prepare("DELETE FROM scores WHERE rules_version = ?").run(RULES_VERSION);
    for (const s of result.scores) {
      ins.run(RULES_VERSION, s.wallet, s.points, s.pointsCapped, JSON.stringify(s.breakdown), asOf);
    }
  })();

  let externalCount = 0;
  let internalCount = 0;
  for (const s of result.scores) {
    if (isInternal(s.wallet)) internalCount += 1;
    else externalCount += 1;
  }

  // ==== Phase 2a layers, all pure functions over the tape =================
  const walletRows = (db.prepare("SELECT pubkey FROM wallets").all() as { pubkey: string }[]).map((r) => r.pubkey);
  const flows = db.prepare("SELECT wallet, direction, source, amount_usdc FROM capital_flows").all() as FlowRow[];
  const provenance = computeProvenance(flows, walletRows);

  const pnl = computePnl(tape);
  const multipliers = computeMultipliers(tape, asOf);

  const faucetClaims = db
    .prepare("SELECT wallet, block_time FROM faucet_claims WHERE kind = 'usdc' ORDER BY block_time ASC")
    .all() as { wallet: string; block_time: number | null }[];
  const allClaims = db.prepare("SELECT COUNT(*) n, COUNT(DISTINCT wallet) w FROM faucet_claims").get() as {
    n: number;
    w: number;
  };

  const { underlyingOf, marketsKnown } = buildUnderlyingMap(db, tape);
  const quests = evaluate({
    tape,
    faucetClaims,
    underlyingOf,
    multipliers,
    cfg: DEFAULT_QUESTS,
    asOf,
  });

  // ---- Base points x multiplier (D11: after the cap, at the day's rate) ---
  // rules_v1 already applied the daily cap; the multiplier is applied here to
  // each day's capped contribution, using that day's rate.
  // D15 (Phase 2b): EXACT per-day attribution. rules_v1 now returns post-cap
  // points bucketed by the UTC day they were earned, so each day is multiplied
  // at THAT day's rate — the D11 semantics as specified. Phase 2a used a
  // whole-wallet average multiplier because this breakdown did not exist, which
  // over-credited quiet days and under-credited streak days.
  const baseMultiplied = new Map<string, number>();
  for (const s of result.scores) {
    let total = 0;
    for (const [day, pts] of Object.entries(s.perDay)) {
      total += pts * multiplierFor(multipliers, s.wallet, day);
    }
    baseMultiplied.set(s.wallet, round4(total));
  }

  // ---- Self-earned (base + quests), then referral income against it ------
  // Social + approved bounty points are self-earned too. Social is capped
  // per UTC day in the EVALUATOR as well as at submit time — defence in depth,
  // so a bug or a race in the API cannot mint uncapped points.
  const socialByWallet = new Map<string, number>();
  {
    const rows = db
      .prepare("SELECT wallet, verified_at, points FROM social_posts WHERE verified_at IS NOT NULL ORDER BY verified_at ASC, tweet_id ASC")
      .all() as { wallet: string; verified_at: number; points: number }[];
    const perDay = new Map<string, number>();
    for (const r of rows) {
      const k = `${r.wallet}|${utcDay(r.verified_at)}`;
      const n = (perDay.get(k) ?? 0) + 1;
      perDay.set(k, n);
      if (n > SOCIAL_MAX_PER_DAY) continue; // evaluator-side cap
      socialByWallet.set(r.wallet, (socialByWallet.get(r.wallet) ?? 0) + (r.points ?? 0));
    }
  }
  const bountyByWallet = new Map<string, number>();
  for (const r of db
    .prepare("SELECT wallet, COALESCE(SUM(points), 0) AS p FROM bounty_submissions WHERE status = 'approved' GROUP BY wallet")
    .all() as { wallet: string; p: number }[]) {
    bountyByWallet.set(r.wallet, r.p);
  }

  const selfEarned = new Map<string, number>();
  for (const w of new Set([
    ...baseMultiplied.keys(),
    ...quests.totals.keys(),
    ...socialByWallet.keys(),
    ...bountyByWallet.keys(),
  ])) {
    selfEarned.set(
      w,
      round4(
        (baseMultiplied.get(w) ?? 0) +
          (quests.totals.get(w) ?? 0) +
          (socialByWallet.get(w) ?? 0) +
          (bountyByWallet.get(w) ?? 0),
      ),
    );
  }

  // D14: activation is DERIVED, not stored. A referee is "activated" when they
  // complete O3 (Make a Market); the tape already knows when that happened, so
  // a stored column would be a second source of truth a recompute could
  // contradict.
  const o3At = new Map<string, number>();
  for (const c of quests.completions) {
    if (c.questId === "O3") o3At.set(c.wallet, c.completedAt);
  }
  const referralRows: ReferralRow[] = (
    db.prepare("SELECT code, referrer_wallet, referee_wallet, bound_at FROM referrals").all() as {
      code: string;
      referrer_wallet: string;
      referee_wallet: string;
      bound_at: number;
    }[]
  ).map((r) => ({ ...r, activated_at: o3At.get(r.referee_wallet) ?? null }));
  const earnedAfter = (wallet: string, sinceTs: number): number => {
    // Points the referee earned at/after activation. Quests carry timestamps;
    // base points are prorated by the share of active days after `sinceTs`.
    let questAfter = 0;
    for (const c of quests.completions) {
      if (c.wallet === wallet && c.completedAt >= sinceTs) questAfter += c.points;
    }
    const perDay = multipliers.byWalletDay.get(wallet);
    let frac = 1;
    if (perDay && perDay.size > 0) {
      const cutoff = utcDay(sinceTs);
      let after = 0;
      for (const d of perDay.keys()) if (d >= cutoff) after += 1;
      frac = after / perDay.size;
    }
    return round4(questAfter + (baseMultiplied.get(wallet) ?? 0) * frac);
  };
  const referrals = computeReferrals(referralRows, selfEarned, earnedAfter, DEFAULT_QUESTS.referral);

  const finalPoints = new Map<string, number>();
  for (const w of new Set([...selfEarned.keys(), ...referrals.bondPoints.keys(), ...referrals.commission.keys()])) {
    finalPoints.set(
      w,
      round4(
        (selfEarned.get(w) ?? 0) + (referrals.bondPoints.get(w) ?? 0) + (referrals.commission.get(w) ?? 0),
      ),
    );
  }

  persistProjections(db, asOf, { pnl, provenance, multipliers, quests, finalPoints });

  return {
    ...result,
    externalCount,
    internalCount,
    pnl,
    provenance,
    multipliers,
    quests,
    referrals,
    finalPoints,
    faucetClaimCount: allClaims.n,
    faucetClaimWallets: allClaims.w,
    marketsKnown,
  };
}

/** Write the recomputable projections. Dropped and rebuilt wholesale. */
function persistProjections(
  db: DB,
  asOf: number,
  d: {
    pnl: PnlResult;
    provenance: Map<string, ProvenanceRow>;
    multipliers: MultiplierResult;
    quests: EvaluatorResult;
    finalPoints: Map<string, number>;
  },
): void {
  const insMetrics = db.prepare(
    `INSERT INTO wallet_metrics
       (wallet, faucet_in, external_in, external_out, pct_faucet, usdc_in, usdc_out,
        deployed, realized_pnl, roi, volume_usdc, writer_premium, profit_eligible, ineligible_reason)
     VALUES (@wallet,@faucet_in,@external_in,@external_out,@pct_faucet,@usdc_in,@usdc_out,
             @deployed,@realized_pnl,@roi,@volume_usdc,@writer_premium,@profit_eligible,@ineligible_reason)`,
  );
  const insQuest = db.prepare(
    `INSERT INTO quest_completions (quests_version, wallet, quest_id, period_key, completed_at, points)
     VALUES (?,?,?,?,?,?)`,
  );
  const insStreak = db.prepare(
    `INSERT INTO streak_state
       (wallet, current_streak, longest_streak, shields_banked, shields_consumed, multiplier, last_active_day)
     VALUES (?,?,?,?,?,?,?)`,
  );
  const insShield = db.prepare("INSERT OR IGNORE INTO shield_events (wallet, day, action) VALUES (?,?,?)");

  db.transaction(() => {
    db.exec("DELETE FROM wallet_metrics");
    db.prepare("DELETE FROM quest_completions WHERE quests_version = ?").run(QUESTS_VERSION);
    db.exec("DELETE FROM streak_state");
    db.exec("DELETE FROM shield_events");

    const wallets = new Set([...d.pnl.byWallet.keys(), ...d.provenance.keys()]);
    for (const w of [...wallets].sort()) {
      const f = d.pnl.byWallet.get(w);
      const p = d.provenance.get(w);
      const faucetIn = p?.faucetIn ?? 0;
      const realized = Number(f?.realizedPnl ?? 0n);
      insMetrics.run({
        wallet: w,
        faucet_in: faucetIn,
        external_in: p?.externalIn ?? 0,
        external_out: p?.externalOut ?? 0,
        pct_faucet: p?.pctFaucet ?? null,
        usdc_in: Number(f?.usdcIn ?? 0n),
        usdc_out: Number(f?.usdcOut ?? 0n),
        deployed: Number(f?.deployed ?? 0n),
        realized_pnl: realized,
        roi: faucetIn > 0 ? realized / faucetIn : null,
        volume_usdc: Number(f?.volumeUsdc ?? 0n),
        writer_premium: Number(f?.writerPremium ?? 0n),
        profit_eligible: p?.eligible ? 1 : 0,
        ineligible_reason: p?.ineligibleReason ?? null,
      });
    }
    for (const c of d.quests.completions) {
      insQuest.run(QUESTS_VERSION, c.wallet, c.questId, c.periodKey, c.completedAt, c.points);
    }
    for (const s of [...d.multipliers.state.keys()].sort()) {
      const st = d.multipliers.state.get(s)!;
      insStreak.run(
        st.wallet,
        st.currentStreak,
        st.longestStreak,
        st.shieldsBanked,
        st.shieldsConsumed,
        st.multiplier,
        st.lastActiveDay,
      );
    }
    for (const e of d.multipliers.shieldEvents) insShield.run(e.wallet, e.day, e.action);
  })();
  void asOf;
}
