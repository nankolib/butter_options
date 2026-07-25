// =============================================================================
// handlers.ts — read + write endpoint logic (transport-agnostic, testable)
// =============================================================================
// Every handler takes plain data and returns { status, body }. server.ts owns
// sockets; this file owns rules. That split is what lets the whole surface be
// tested against a fixture DB with no listener running.
// =============================================================================

import { createHash, randomBytes } from "node:crypto";

import bs58 from "bs58";

import type { DB } from "../db";
import { isInternal } from "../registry";
import { DEFAULT_QUESTS } from "../score/quests/evaluator";
import { checkCooldown, verifySigned, type SignedEnvelope } from "./auth";
import { verifyTweet, type XConfig } from "./xVerify";

export interface ApiResponse {
  status: number;
  body: unknown;
}

export interface ApiDeps {
  db: DB;
  x: XConfig;
  cooldownSecs: number;
  socialPointsPerPost: number;
  socialMaxPerDay: number;
  now: () => number;
}

const ok = (body: Record<string, unknown>): ApiResponse => ({ status: 200, body });
const err = (status: number, error: string, extra: Record<string, unknown> = {}): ApiResponse => ({
  status,
  body: { error, ...extra },
});

function computedAt(db: DB): number | null {
  const r = db.prepare("SELECT MAX(computed_at) AS t FROM scores").get() as { t: number | null };
  return r?.t ?? null;
}

const utcDay = (ts: number) => new Date(ts * 1000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// READS
// ---------------------------------------------------------------------------

export type Board = "profit" | "volume" | "writer" | "referrals" | "social";

export function getLeaderboard(db: DB, board: string, limit: number): ApiResponse {
  const boards: Board[] = ["profit", "volume", "writer", "referrals", "social"];
  if (!boards.includes(board as Board)) return err(400, "unknown_board", { valid: boards });
  const n = Math.min(Math.max(1, limit || 50), 200);

  let rows: unknown[] = [];
  if (board === "profit") {
    rows = db
      .prepare(
        `SELECT wallet, realized_pnl, deployed, faucet_in, roi
         FROM wallet_metrics WHERE profit_eligible = 1 AND wallet IN (SELECT pubkey FROM wallets WHERE is_internal = 0)
         ORDER BY roi DESC, wallet ASC LIMIT ?`,
      )
      .all(n);
  } else if (board === "volume") {
    rows = db
      .prepare(
        `SELECT wallet, volume_usdc FROM wallet_metrics
         WHERE wallet IN (SELECT pubkey FROM wallets WHERE is_internal = 0)
         ORDER BY volume_usdc DESC, wallet ASC LIMIT ?`,
      )
      .all(n);
  } else if (board === "writer") {
    rows = db
      .prepare(
        `SELECT wallet, writer_premium FROM wallet_metrics
         WHERE writer_premium > 0 AND wallet IN (SELECT pubkey FROM wallets WHERE is_internal = 0)
         ORDER BY writer_premium DESC, wallet ASC LIMIT ?`,
      )
      .all(n);
  } else if (board === "referrals") {
    // NOT-internal, rather than "present in `wallets` and flagged external".
    // Referring people is itself campaign activity, so a referrer who has not
    // traded yet has no `wallets` row — an IN(...external) filter would hide
    // exactly the people this board exists to rank.
    rows = db
      .prepare(
        `SELECT r.referrer_wallet AS wallet, COUNT(*) AS referees
         FROM referrals r
         WHERE r.referrer_wallet NOT IN (SELECT pubkey FROM wallets WHERE is_internal = 1)
         GROUP BY r.referrer_wallet ORDER BY referees DESC, wallet ASC LIMIT ?`,
      )
      .all(n);
  } else {
    // Same reasoning, plus: this board previously had NO internal filter at all.
    rows = db
      .prepare(
        `SELECT wallet, COUNT(*) AS posts, COALESCE(SUM(points), 0) AS points
         FROM social_posts
         WHERE verified_at IS NOT NULL
           AND wallet NOT IN (SELECT pubkey FROM wallets WHERE is_internal = 1)
         GROUP BY wallet ORDER BY points DESC, wallet ASC LIMIT ?`,
      )
      .all(n);
  }
  return ok({ board, limit: n, computed_at: computedAt(db), rows });
}

export function getWallet(db: DB, pubkey: string): ApiResponse {
  try {
    if (bs58.decode(pubkey).length !== 32) return err(400, "bad_pubkey");
  } catch {
    return err(400, "bad_pubkey");
  }

  const w = db.prepare("SELECT pubkey, is_internal, label, first_seen, last_seen FROM wallets WHERE pubkey = ?").get(pubkey) as
    | { pubkey: string; is_internal: number; label: string | null; first_seen: number | null; last_seen: number | null }
    | undefined;
  // A wallet can exist to the campaign without ever touching the tape — it may
  // have bound a referral or verified a post but not yet traded. 404 only when
  // it is genuinely unknown EVERYWHERE.
  const knownOffTape =
    db.prepare("SELECT 1 FROM referrals WHERE referee_wallet = ? OR referrer_wallet = ? LIMIT 1").get(pubkey, pubkey) ??
    db.prepare("SELECT 1 FROM social_posts WHERE wallet = ? LIMIT 1").get(pubkey) ??
    db.prepare("SELECT 1 FROM referral_codes WHERE wallet = ? LIMIT 1").get(pubkey) ??
    db.prepare("SELECT 1 FROM bounty_submissions WHERE wallet = ? LIMIT 1").get(pubkey);
  if (!w && !knownOffTape) return err(404, "unknown_wallet");

  const m = db.prepare("SELECT * FROM wallet_metrics WHERE wallet = ?").get(pubkey) as Record<string, unknown> | undefined;
  const s = db.prepare("SELECT points, points_capped, breakdown_json FROM scores WHERE wallet = ?").get(pubkey) as
    | { points: number; points_capped: number; breakdown_json: string }
    | undefined;
  const streak = db.prepare("SELECT * FROM streak_state WHERE wallet = ?").get(pubkey) as Record<string, unknown> | undefined;
  const quests = db
    .prepare("SELECT quest_id, period_key, completed_at, points FROM quest_completions WHERE wallet = ? ORDER BY quest_id, period_key")
    .all(pubkey) as { quest_id: string; period_key: string; completed_at: number; points: number }[];
  const questPoints = quests.reduce((a, q) => a + q.points, 0);
  const chainStage = quests.filter((q) => /^O[1-7]$/.test(q.quest_id)).length;

  const referredBy = db.prepare("SELECT referrer_wallet, code, bound_at FROM referrals WHERE referee_wallet = ?").get(pubkey) as
    | { referrer_wallet: string; code: string; bound_at: number }
    | undefined;
  const refereeCount = (db.prepare("SELECT COUNT(*) AS n FROM referrals WHERE referrer_wallet = ?").get(pubkey) as { n: number }).n;
  const myCode = db.prepare("SELECT code FROM referral_codes WHERE wallet = ?").get(pubkey) as { code: string } | undefined;
  const handle = db.prepare("SELECT x_handle FROM wallet_handles WHERE wallet = ?").get(pubkey) as { x_handle: string } | undefined;
  const socialPoints = (db.prepare("SELECT COALESCE(SUM(points),0) AS p FROM social_posts WHERE wallet = ?").get(pubkey) as { p: number }).p;

  const rankOf = (sql: string): number | null => {
    const r = db.prepare(sql).all() as { wallet: string }[];
    const i = r.findIndex((x) => x.wallet === pubkey);
    return i < 0 ? null : i + 1;
  };

  return ok({
    computed_at: computedAt(db),
    wallet: pubkey,
    is_internal: w?.is_internal === 1,
    label: w?.label ?? null,
    first_seen: w?.first_seen ?? null,
    last_seen: w?.last_seen ?? null,
    on_tape: !!w,
    points: {
      base: s?.points_capped ?? 0,
      base_raw: s?.points ?? 0,
      base_breakdown: s ? JSON.parse(s.breakdown_json) : {},
      quests: Math.round(questPoints * 1e4) / 1e4,
      social: socialPoints,
    },
    multiplier: streak?.multiplier ?? 1,
    streak: streak
      ? {
          current: streak.current_streak,
          longest: streak.longest_streak,
          shields_banked: streak.shields_banked,
          shields_consumed: streak.shields_consumed,
          last_active_day: streak.last_active_day,
        }
      : null,
    chain_stage: chainStage,
    quests,
    provenance: m
      ? {
          faucet_in: m.faucet_in,
          external_in: m.external_in,
          external_out: m.external_out,
          pct_faucet: m.pct_faucet,
          profit_eligible: m.profit_eligible === 1,
          ineligible_reason: m.ineligible_reason,
        }
      : null,
    pnl: m ? { realized_pnl: m.realized_pnl, deployed: m.deployed, roi: m.roi, volume_usdc: m.volume_usdc, writer_premium: m.writer_premium } : null,
    referral: { my_code: myCode?.code ?? null, referred_by: referredBy ?? null, referee_count: refereeCount },
    x_handle: handle?.x_handle ?? null,
    ranks: {
      profit: rankOf(
        "SELECT wallet FROM wallet_metrics WHERE profit_eligible = 1 AND wallet IN (SELECT pubkey FROM wallets WHERE is_internal = 0) ORDER BY roi DESC, wallet ASC",
      ),
      volume: rankOf(
        "SELECT wallet FROM wallet_metrics WHERE wallet IN (SELECT pubkey FROM wallets WHERE is_internal = 0) ORDER BY volume_usdc DESC, wallet ASC",
      ),
      writer: rankOf(
        "SELECT wallet FROM wallet_metrics WHERE writer_premium > 0 AND wallet IN (SELECT pubkey FROM wallets WHERE is_internal = 0) ORDER BY writer_premium DESC, wallet ASC",
      ),
    },
  });
}

export function getQuests(db: DB): ApiResponse {
  const counts = db
    .prepare("SELECT quest_id, COUNT(DISTINCT wallet) AS wallets, COUNT(*) AS completions FROM quest_completions GROUP BY quest_id")
    .all() as { quest_id: string; wallets: number; completions: number }[];
  const byId = new Map(counts.map((c) => [c.quest_id, c]));
  const decorate = (q: { id: string; name: string; points: number }) => ({
    ...q,
    wallets: byId.get(q.id)?.wallets ?? 0,
    completions: byId.get(q.id)?.completions ?? 0,
  });
  return ok({
    computed_at: computedAt(db),
    version: DEFAULT_QUESTS.version,
    chain: DEFAULT_QUESTS.chain.map(decorate),
    chain_complete_bonus: decorate(DEFAULT_QUESTS.chainCompleteBonus),
    dailies: DEFAULT_QUESTS.dailies.map(decorate),
    weeklies: DEFAULT_QUESTS.weeklies.map(decorate),
  });
}

export function getStats(db: DB): ApiResponse {
  const t = db.prepare("SELECT COUNT(*) n, MAX(block_time) hi, MIN(block_time) lo FROM txs").get() as {
    n: number;
    hi: number | null;
    lo: number | null;
  };
  const e = db.prepare("SELECT COUNT(*) n FROM events").get() as { n: number };
  const w = db.prepare("SELECT SUM(CASE WHEN is_internal = 0 THEN 1 ELSE 0 END) ext, SUM(is_internal) int FROM wallets").get() as {
    ext: number | null;
    int: number | null;
  };
  const meta = (k: string) =>
    (db.prepare("SELECT value FROM meta WHERE key = ?").get(k) as { value: string } | undefined)?.value ?? null;
  return ok({
    computed_at: computedAt(db),
    tape: { txs: t.n, events: e.n, first_block_time: t.lo, last_block_time: t.hi },
    wallets: { external: w.ext ?? 0, internal: w.int ?? 0 },
    backfill_done: meta("backfill_done") === "1",
    schema_version: Number(meta("schema_version")),
    faucet_claims: (db.prepare("SELECT COUNT(*) n FROM faucet_claims").get() as { n: number }).n,
  });
}

// ---------------------------------------------------------------------------
// WRITES
// ---------------------------------------------------------------------------

function authOrFail(deps: ApiDeps, env: SignedEnvelope, expected: string): ApiResponse | { wallet: string } {
  const now = deps.now();
  if (env?.action !== expected) return err(400, "action_mismatch");
  const res = verifySigned(deps.db, env, now);
  if (!res.ok) return err(res.reason === "replayed" ? 409 : 401, res.reason);
  if (!checkCooldown(deps.db, res.wallet, res.action, now, deps.cooldownSecs)) {
    return err(429, "cooldown", { retry_after: deps.cooldownSecs });
  }
  return { wallet: res.wallet };
}

const isFail = (v: ApiResponse | { wallet: string }): v is ApiResponse => "status" in v;

/** 6-char base58 code, deterministic from the wallet so it is idempotent. */
function deriveCode(wallet: string, salt: number): string {
  const h = createHash("sha256").update(`opta-referral|${wallet}|${salt}`).digest();
  return bs58.encode(h).slice(0, 6).toUpperCase();
}

export function postReferralCode(deps: ApiDeps, env: SignedEnvelope): ApiResponse {
  const a = authOrFail(deps, env, "referral.code");
  if (isFail(a)) return a;
  const { db } = deps;

  const existing = db.prepare("SELECT code FROM referral_codes WHERE wallet = ?").get(a.wallet) as { code: string } | undefined;
  if (existing) return ok({ code: existing.code, created: false });

  // Collision-resilient: bump the salt rather than failing the request.
  for (let salt = 0; salt < 32; salt++) {
    const code = deriveCode(a.wallet, salt);
    try {
      db.prepare("INSERT INTO referral_codes (code, wallet, created_at) VALUES (?, ?, ?)").run(code, a.wallet, deps.now());
      return ok({ code, created: true });
    } catch {
      /* collision — try the next salt */
    }
  }
  return err(500, "code_generation_failed");
}

export function postReferralBind(deps: ApiDeps, env: SignedEnvelope): ApiResponse {
  const a = authOrFail(deps, env, "referral.bind");
  if (isFail(a)) return a;
  const { db } = deps;
  const code = String((env.params as { code?: unknown } | undefined)?.code ?? "").toUpperCase();
  if (!code) return err(400, "missing_code");

  // 1. code must exist
  const owner = db.prepare("SELECT wallet FROM referral_codes WHERE code = ?").get(code) as { wallet: string } | undefined;
  if (!owner) return err(404, "unknown_code");
  // 2. no self-referral
  if (owner.wallet === a.wallet) return err(400, "self_referral");
  // 3. referee not already bound
  if (db.prepare("SELECT 1 FROM referrals WHERE referee_wallet = ?").get(a.wallet)) return err(409, "already_bound");
  // 4. bind must PRECEDE the referee's first fill (O1)
  const o1 = db.prepare("SELECT 1 FROM quest_completions WHERE wallet = ? AND quest_id = 'O1'").get(a.wallet);
  if (o1) return err(409, "already_active", { detail: "bind must precede your first fill" });
  // 5. referrer must not be internal
  if (isInternal(owner.wallet)) return err(403, "internal_referrer");

  db.prepare("INSERT INTO referrals (referee_wallet, code, referrer_wallet, bound_at) VALUES (?, ?, ?, ?)").run(
    a.wallet,
    code,
    owner.wallet,
    deps.now(),
  );
  return ok({ bound: true, referrer: owner.wallet, code });
}

export async function postSocialSubmit(deps: ApiDeps, env: SignedEnvelope): Promise<ApiResponse> {
  const a = authOrFail(deps, env, "social.submit");
  if (isFail(a)) return a;
  const { db } = deps;
  const url = String((env.params as { tweet_url?: unknown } | undefined)?.tweet_url ?? "");
  if (!url) return err(400, "missing_tweet_url");

  const now = deps.now();
  const day = utcDay(now);

  // Daily cap checked BEFORE burning an X API call.
  const todayCount = (
    db
      .prepare("SELECT COUNT(*) AS n FROM social_posts WHERE wallet = ? AND verified_at >= ? AND verified_at < ?")
      .get(a.wallet, Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000), Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) + 86400) as {
      n: number;
    }
  ).n;
  if (todayCount >= deps.socialMaxPerDay) return err(429, "daily_cap", { cap: deps.socialMaxPerDay });

  const outcome = await verifyTweet(url, deps.x, now);
  if (!outcome.ok) {
    // Upstream trouble must NOT consume the submission — generic message only.
    if (outcome.reason === "upstream") return err(502, "verification_unavailable");
    return err(400, outcome.reason);
  }
  const { tweetId, authorHandle } = outcome.tweet;

  if (db.prepare("SELECT 1 FROM social_posts WHERE tweet_id = ?").get(tweetId)) return err(409, "duplicate_tweet");

  // 1:1 handle binding, enforced in BOTH directions.
  const boundForWallet = db.prepare("SELECT x_handle FROM wallet_handles WHERE wallet = ?").get(a.wallet) as
    | { x_handle: string }
    | undefined;
  const walletForHandle = db.prepare("SELECT wallet FROM wallet_handles WHERE x_handle = ?").get(authorHandle) as
    | { wallet: string }
    | undefined;

  if (boundForWallet && boundForWallet.x_handle.toLowerCase() !== authorHandle.toLowerCase()) {
    return err(409, "handle_mismatch");
  }
  if (walletForHandle && walletForHandle.wallet !== a.wallet) return err(409, "handle_taken");
  if (!boundForWallet) {
    db.prepare("INSERT INTO wallet_handles (wallet, x_handle, bound_at) VALUES (?, ?, ?)").run(a.wallet, authorHandle, now);
  }

  db.prepare("INSERT INTO social_posts (tweet_id, wallet, x_handle, verified_at, points) VALUES (?, ?, ?, ?, ?)").run(
    tweetId,
    a.wallet,
    authorHandle,
    now,
    deps.socialPointsPerPost,
  );
  return ok({ tweet_id: tweetId, x_handle: authorHandle, points: deps.socialPointsPerPost, posts_today: todayCount + 1 });
}

export function postBountySubmit(deps: ApiDeps, env: SignedEnvelope): ApiResponse {
  const a = authOrFail(deps, env, "bounty.submit");
  if (isFail(a)) return a;
  const p = (env.params ?? {}) as { kind?: unknown; proof_url?: unknown };
  const kind = String(p.kind ?? "").slice(0, 40);
  const proof = String(p.proof_url ?? "").slice(0, 500);
  if (!kind || !proof) return err(400, "missing_fields");
  if (!/^https?:\/\//i.test(proof)) return err(400, "bad_proof_url");

  const id = bs58.encode(randomBytes(12));
  deps.db
    .prepare("INSERT INTO bounty_submissions (id, wallet, kind, proof_url, status, points) VALUES (?, ?, ?, ?, 'pending', 0)")
    .run(id, a.wallet, kind, proof);
  return ok({ id, status: "pending" });
}
