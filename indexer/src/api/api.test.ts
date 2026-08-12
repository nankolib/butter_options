// API: auth matrix, bind rejections, social cap + handle binding, reads.
// run: npx ts-node --transpile-only src/api/api.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { ed25519 } from "@noble/curves/ed25519";
import bs58 from "bs58";

import { makeWriter, openDb, type DB, type EventRow, type TxRow } from "../db";
import { SCHEMA_VERSION } from "../schema";
import { recompute } from "../score/recompute";
import { DEFAULT_QUESTS, QUESTS_VERSION } from "../score/quests/evaluator";
import { DEFAULT_RULES, RULES_VERSION } from "../score/rules_v1";
import { MULTIPLIER_STEP, MULTIPLIER_CAP, SHIELD_STREAK_LENGTH, SHIELD_BANK_MAX } from "../score/multiplier";
import { canonicalJson, canonicalMessage, verifySigned, type SignedEnvelope } from "./auth";

/** Shape of a quest row in the /quests catalog payload. */
type QuestCount = { id: string; wallets: number; completions: number };
import {
  getLeaderboard,
  getQuests,
  getRules,
  getStats,
  getWallet,
  postBountySubmit,
  postReferralBind,
  postReferralCode,
  postSocialSubmit,
  type ApiDeps,
  type ApiResponse,
  LISTING_REQUEST_DAILY_CAP,
  getListingRequested,
  postListingRequest,
} from "./handlers";

const NOW = 1_784_000_000;
const VAULT = "VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV";

function keypair() {
  const priv = ed25519.utils.randomPrivateKey();
  const pub = ed25519.getPublicKey(priv);
  return { priv, wallet: bs58.encode(pub) };
}
const KP_A = keypair();
const KP_B = keypair();

let nonceSeq = 0;
function sign(kp: { priv: Uint8Array; wallet: string }, action: string, params: unknown = {}, over: Partial<SignedEnvelope> = {}): SignedEnvelope {
  const nonce = `n${++nonceSeq}`;
  const expiry = NOW + 60;
  const msg = canonicalMessage(action, kp.wallet, params, nonce, expiry);
  const sig = ed25519.sign(Buffer.from(msg, "utf8"), kp.priv);
  return { wallet: kp.wallet, action, nonce, expiry, params: params as Record<string, unknown>, signature: bs58.encode(sig), ...over };
}

function tmpDb(): { db: DB; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opta-api-"));
  return { db: openDb(path.join(dir, "points.db")), dir };
}

function deps(db: DB, over: Partial<ApiDeps> = {}): ApiDeps {
  return {
    db,
    x: { bearer: null, mentionHandle: "@optafinance", maxAgeSecs: 172_800 },
    cooldownSecs: 0,
    socialPointsPerPost: 20,
    socialMaxPerDay: 3,
    now: () => NOW,
    ...over,
  };
}

let evtN = 0;
const evt = (over: Partial<EventRow>): EventRow => ({
  id: `E${++evtN}:0`, sig: `E${evtN}`, ordinal: 0, ix_index: null, source: "log",
  name: "OrderFilled", wallet: null, counterparty: null, vault: VAULT,
  option_mint: null, kind: 2, amount_usdc: 1_000_000, quantity: 1,
  fields_json: "{}", block_time: NOW - 86_400, ...over,
});

function seed(db: DB, rows: EventRow[]): void {
  const write = makeWriter(db);
  for (const r of rows) {
    const tx: TxRow = { sig: r.sig, slot: 1, block_time: r.block_time, ok: 1, truncated: 0 };
    write(tx, [r]);
  }
  recompute(db, NOW);
}

// ---------------------------------------------------------------------------
// AUTH
// ---------------------------------------------------------------------------

test("auth: a valid signature passes", () => {
  const { db, dir } = tmpDb();
  const r = verifySigned(db, sign(KP_A, "referral.code"), NOW);
  assert.equal(r.ok, true);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("auth: an expired signature is rejected", () => {
  const { db, dir } = tmpDb();
  const env = sign(KP_A, "referral.code");
  assert.deepEqual(verifySigned(db, env, NOW + 3600), { ok: false, reason: "expired" });
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("auth: an expiry further out than the max TTL is rejected", () => {
  const { db, dir } = tmpDb();
  const kp = KP_A;
  const nonce = "far";
  const expiry = NOW + 99_999;
  const msg = canonicalMessage("referral.code", kp.wallet, {}, nonce, expiry);
  const env: SignedEnvelope = {
    wallet: kp.wallet, action: "referral.code", nonce, expiry, params: {},
    signature: bs58.encode(ed25519.sign(Buffer.from(msg, "utf8"), kp.priv)),
  };
  assert.deepEqual(verifySigned(db, env, NOW), { ok: false, reason: "expired" });
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("auth: REPLAY of the same nonce is rejected", () => {
  const { db, dir } = tmpDb();
  const env = sign(KP_A, "referral.code");
  assert.equal(verifySigned(db, env, NOW).ok, true);
  assert.deepEqual(verifySigned(db, env, NOW), { ok: false, reason: "replayed" });
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("auth: a signature from a DIFFERENT wallet is rejected", () => {
  const { db, dir } = tmpDb();
  const env = sign(KP_A, "referral.code");
  assert.deepEqual(verifySigned(db, { ...env, wallet: KP_B.wallet }, NOW), { ok: false, reason: "bad_signature" });
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("auth: TAMPERED PARAMS invalidate the signature (params are bound in)", () => {
  const { db, dir } = tmpDb();
  const env = sign(KP_A, "referral.bind", { code: "AAAAAA" });
  const tampered = { ...env, params: { code: "ZZZZZZ" } };
  assert.deepEqual(verifySigned(db, tampered, NOW), { ok: false, reason: "bad_signature" });
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("auth: a signature for one action cannot be replayed on another", () => {
  const { db, dir } = tmpDb();
  const env = sign(KP_A, "referral.code");
  assert.deepEqual(verifySigned(db, { ...env, action: "bounty.submit" }, NOW), { ok: false, reason: "bad_signature" });
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("auth: unknown action rejected; canonicalJson is key-order stable", () => {
  const { db, dir } = tmpDb();
  assert.deepEqual(verifySigned(db, sign(KP_A, "nope" as string), NOW), { ok: false, reason: "bad_action" });
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// REFERRAL
// ---------------------------------------------------------------------------

test("referral code is idempotent", () => {
  const { db, dir } = tmpDb();
  const d = deps(db);
  const r1 = postReferralCode(d, sign(KP_A, "referral.code")) as ApiResponse;
  const r2 = postReferralCode(d, sign(KP_A, "referral.code")) as ApiResponse;
  assert.equal(r1.status, 200);
  assert.equal((r1.body as { created: boolean }).created, true);
  assert.equal((r2.body as { created: boolean }).created, false);
  assert.equal((r1.body as { code: string }).code, (r2.body as { code: string }).code);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("bind rejection matrix — all five cases", () => {
  const { db, dir } = tmpDb();
  const d = deps(db);
  const code = ((postReferralCode(d, sign(KP_A, "referral.code")) as ApiResponse).body as { code: string }).code;

  // 1. unknown code
  assert.equal((postReferralBind(d, sign(KP_B, "referral.bind", { code: "NOPEEE" })) as ApiResponse).status, 404);
  // 2. self-referral
  assert.equal((postReferralBind(d, sign(KP_A, "referral.bind", { code })) as ApiResponse).status, 400);
  // 3. happy path first, then already-bound
  assert.equal((postReferralBind(d, sign(KP_B, "referral.bind", { code })) as ApiResponse).status, 200);
  assert.equal((postReferralBind(d, sign(KP_B, "referral.bind", { code })) as ApiResponse).status, 409);
  // 4. referee already completed O1
  const KP_C = keypair();
  db.prepare("INSERT INTO quest_completions (quests_version, wallet, quest_id, period_key, completed_at, points) VALUES (?,?, 'O1','',?,50)").run(QUESTS_VERSION, KP_C.wallet, NOW);
  const r4 = postReferralBind(d, sign(KP_C, "referral.bind", { code })) as ApiResponse;
  assert.equal(r4.status, 409);
  assert.equal((r4.body as { error: string }).error, "already_active");
  // 5. internal referrer
  const INTERNAL = "5sHZETYzbbdBQnFLmDCG3gyCikew39pL8kAE5xroGfqa";
  db.prepare("INSERT INTO referral_codes (code, wallet, created_at) VALUES ('INTRNL',?,?)").run(INTERNAL, NOW);
  const KP_D = keypair();
  assert.equal((postReferralBind(d, sign(KP_D, "referral.bind", { code: "INTRNL" })) as ApiResponse).status, 403);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// SOCIAL
// ---------------------------------------------------------------------------

function fakeX(handle: string, id: string, ageSecs = 60) {
  return {
    bearer: "x",
    mentionHandle: "@optafinance",
    maxAgeSecs: 172_800,
    __fake: { handle, id, ageSecs },
  } as never;
}

test("social: daily cap enforced at the boundary", async () => {
  const { db, dir } = tmpDb();
  const d = deps(db, { socialMaxPerDay: 3 });
  // Pre-seed 3 verified posts today; the 4th must be refused BEFORE any X call.
  for (let i = 0; i < 3; i++) {
    db.prepare("INSERT INTO social_posts (tweet_id, wallet, x_handle, verified_at, points) VALUES (?,?,?,?,20)").run(
      `t${i}`, KP_A.wallet, "alice", NOW,
    );
  }
  const r = await postSocialSubmit(d, sign(KP_A, "social.submit", { tweet_url: "https://x.com/alice/status/12345678901" }));
  assert.equal(r.status, 429);
  assert.equal((r.body as { error: string }).error, "daily_cap");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("social: X upstream failure returns 502 and does NOT record the submission", async () => {
  const { db, dir } = tmpDb();
  const d = deps(db); // bearer null -> upstream
  const r = await postSocialSubmit(d, sign(KP_A, "social.submit", { tweet_url: "https://x.com/a/status/12345678901" }));
  assert.equal(r.status, 502);
  assert.equal((r.body as { error: string }).error, "verification_unavailable");
  assert.equal((db.prepare("SELECT COUNT(*) n FROM social_posts").get() as { n: number }).n, 0);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("social: handle binding is 1:1 in both directions", () => {
  const { db, dir } = tmpDb();
  db.prepare("INSERT INTO wallet_handles (wallet, x_handle, bound_at) VALUES (?,?,?)").run(KP_A.wallet, "alice", NOW);
  // same wallet, different handle
  assert.throws(() => db.prepare("INSERT INTO wallet_handles (wallet, x_handle, bound_at) VALUES (?,?,?)").run(KP_A.wallet, "bob", NOW));
  // different wallet, same handle
  assert.throws(() => db.prepare("INSERT INTO wallet_handles (wallet, x_handle, bound_at) VALUES (?,?,?)").run(KP_B.wallet, "alice", NOW));
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("social: a bad tweet url is rejected without an X call", async () => {
  const { db, dir } = tmpDb();
  const r = await postSocialSubmit(deps(db), sign(KP_A, "social.submit", { tweet_url: "https://example.com/nope" }));
  assert.equal(r.status, 400);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// BOUNTY
// ---------------------------------------------------------------------------

test("bounty: submit lands pending; approve writes points", () => {
  const { db, dir } = tmpDb();
  const d = deps(db);
  const r = postBountySubmit(d, sign(KP_A, "bounty.submit", { kind: "bug", proof_url: "https://github.com/x/y/issues/1" }));
  assert.equal(r.status, 200);
  const id = (r.body as { id: string }).id;
  assert.equal((db.prepare("SELECT status FROM bounty_submissions WHERE id = ?").get(id) as { status: string }).status, "pending");

  db.prepare("UPDATE bounty_submissions SET status = 'approved', points = 100 WHERE id = ?").run(id);
  const row = db.prepare("SELECT status, points FROM bounty_submissions WHERE id = ?").get(id) as { status: string; points: number };
  assert.equal(row.status, "approved");
  assert.equal(row.points, 100);

  // a non-http proof is refused
  assert.equal(postBountySubmit(d, sign(KP_A, "bounty.submit", { kind: "bug", proof_url: "javascript:alert(1)" })).status, 400);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// READS
// ---------------------------------------------------------------------------

test("reads: every endpoint answers against a fixture DB", () => {
  const { db, dir } = tmpDb();
  seed(db, [
    evt({ wallet: KP_A.wallet, counterparty: KP_B.wallet, amount_usdc: 50_000_000 }),
    evt({ name: "VaultExercised", wallet: KP_A.wallet, amount_usdc: 10_000_000 }),
  ]);

  const lb = getLeaderboard(db, "volume", 10);
  assert.equal(lb.status, 200);
  assert.ok(Array.isArray((lb.body as { rows: unknown[] }).rows));
  assert.ok("computed_at" in (lb.body as object));

  assert.equal(getLeaderboard(db, "nope", 10).status, 400);

  const w = getWallet(db, KP_A.wallet);
  assert.equal(w.status, 200);
  assert.equal((w.body as { wallet: string }).wallet, KP_A.wallet);
  assert.ok("multiplier" in (w.body as object));
  assert.ok("provenance" in (w.body as object));

  assert.equal(getWallet(db, "not-a-pubkey").status, 400);
  assert.equal(getWallet(db, bs58.encode(Buffer.alloc(32, 7))).status, 404);

  const q = getQuests(db);
  assert.equal(q.status, 200);
  const qb = q.body as {
    version: string;
    chain: { id: string }[];
    bonuses: { id: string }[];
    weeklies: { id: string }[];
    referral: Record<string, unknown>;
  };
  // Bound to the constant, not a literal: this line was hardcoded "v1.1" and
  // broke the whole reads test on the v1.2 amendment for no reason of its own.
  // What the endpoint must guarantee is that it SERVES the shipped version.
  assert.equal(qb.version, QUESTS_VERSION);
  // Everything the evaluator can award must be enumerated here, or a rules page
  // built off this endpoint silently omits it.
  assert.deepEqual(qb.chain.map((c) => c.id), ["O1", "O2", "O3", "O4", "O6", "O7"]);
  assert.deepEqual(qb.bonuses.map((b) => b.id), ["O5", "O5b"], "standalone bonuses must be listed");
  assert.ok(qb.weeklies.some((w) => w.id === "W3b"), "the W3 class-span bonus must be listed");
  assert.equal(qb.referral.referee_bond_points, 25);
  assert.equal(qb.referral.referrer_rate, 0.1);
  assert.equal(qb.referral.referrer_cap_fraction_of_self, 0.25);

  const s = getStats(db);
  assert.equal(s.status, 200);
  const sb = s.body as { schema_version: number; rules_frozen: Record<string, unknown> };
  assert.equal(sb.schema_version, SCHEMA_VERSION);
  assert.ok(sb.rules_frozen, "stats must publish the freeze so a hash can be cited");
  assert.equal(sb.rules_frozen.rules_version, RULES_VERSION); // /stats must publish the LIVE tag

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("reads: leaderboards exclude internal wallets", () => {
  const { db, dir } = tmpDb();
  const INTERNAL = "5sHZETYzbbdBQnFLmDCG3gyCikew39pL8kAE5xroGfqa";
  seed(db, [evt({ name: "IxSettleExpiry", source: "ix", wallet: INTERNAL, amount_usdc: null })]);
  const rows = (getLeaderboard(db, "volume", 50).body as { rows: { wallet: string }[] }).rows;
  assert.equal(rows.some((r) => r.wallet === INTERNAL), false, "crank-gas must never appear on a board");
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("end-to-end: a bind + a social post surface in recompute output", () => {
  const { db, dir } = tmpDb();
  const d = deps(db);
  seed(db, [evt({ wallet: KP_A.wallet, counterparty: KP_B.wallet, amount_usdc: 5_000_000 })]);

  const code = ((postReferralCode(d, sign(KP_A, "referral.code")) as ApiResponse).body as { code: string }).code;
  const KP_R = keypair();
  assert.equal((postReferralBind(d, sign(KP_R, "referral.bind", { code })) as ApiResponse).status, 200);
  db.prepare("INSERT INTO social_posts (tweet_id, wallet, x_handle, verified_at, points) VALUES ('t1',?,?,?,20)").run(KP_A.wallet, "alice", NOW);

  const r = recompute(db, NOW);
  assert.equal(r.referrals.bound, 1, "the bind is visible to the evaluator");
  assert.ok((r.finalPoints.get(KP_A.wallet) ?? 0) >= 20, "social points reach the total");
  const board = (getLeaderboard(db, "referrals", 10).body as { rows: { wallet: string; referees: number }[] }).rows;
  assert.equal(board.find((x) => x.wallet === KP_A.wallet)?.referees, 1);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

void fakeX;

// ---------------------------------------------------------------------------
// rules-v1.1 regression: quest_completions is VERSIONED, reads must filter.
// ---------------------------------------------------------------------------
// quest_completions' PK is (quests_version, wallet, quest_id, period_key) and
// recompute deletes only its OWN version before reinserting, so rows from every
// prior ruleset survive on purpose as an audit trail. Three read paths queried
// the table with no version filter, so the moment a second version existed (the
// 2026-08-05 v1.1 amendment) they double-counted: /wallet returned every quest
// twice and /quests reported completions at 2x (O1 34 instead of 17, W1 38, W2 12).
// Scoring was never affected — wallet_points comes from the evaluator, not from
// summing this table — but the public read surface was wrong.
test("v1.1 regression: a STALE prior-version quest row is invisible to every read path", () => {
  const { db, dir } = tmpDb();
  const d = deps(db);

  const KP = keypair();
  db.prepare("INSERT INTO wallets (pubkey, is_internal, label, first_seen, last_seen) VALUES (?,0,NULL,?,?)").run(KP.wallet, NOW, NOW);
  const ins = db.prepare(
    "INSERT INTO quest_completions (quests_version, wallet, quest_id, period_key, completed_at, points) VALUES (?,?,?,?,?,?)",
  );
  // The SAME completion recorded under a retired ruleset AND the current one —
  // exactly the shape recompute leaves behind after a version bump.
  ins.run("v0-retired", KP.wallet, "O1", "", NOW, 50);
  ins.run(QUESTS_VERSION, KP.wallet, "O1", "", NOW, 50);
  // And one that exists ONLY under the retired ruleset: it must not resurface.
  ins.run("v0-retired", KP.wallet, "W2", "2026-W27", NOW, 60);

  // 1. wallet path — each quest exactly once, and no retired-only quest.
  const w = getWallet(db, KP.wallet) as ApiResponse;
  assert.equal(w.status, 200);
  const quests = (w.body as { quests: { quest_id: string; period_key: string }[] }).quests;
  assert.equal(quests.length, 1, "one current-version row -> exactly one entry");
  assert.equal(quests[0].quest_id, "O1");
  assert.equal(
    quests.filter((q) => q.quest_id === "W2").length, 0,
    "a quest that exists only under a retired ruleset must not appear",
  );

  // 2. quests catalog — counts are single-version truth, not a sum across versions.
  const cat = getQuests(db) as ApiResponse;
  const all = [...(cat.body as { chain: QuestCount[] }).chain, ...(cat.body as { weeklies: QuestCount[] }).weeklies];
  const o1 = all.find((q) => q.id === "O1")!;
  assert.equal(o1.completions, 1, "O1 counted once, not once per version");
  assert.equal(o1.wallets, 1);
  const w2 = all.find((q) => q.id === "W2")!;
  assert.equal(w2.completions, 0, "retired-only completions must not be counted");

  // 3. referral O1 gate — must key off the CURRENT ruleset's O1.
  const KP2 = keypair();
  db.prepare("INSERT INTO wallets (pubkey, is_internal, label, first_seen, last_seen) VALUES (?,0,NULL,?,?)").run(KP2.wallet, NOW, NOW);
  ins.run("v0-retired", KP2.wallet, "O1", "", NOW, 50); // retired only
  db.prepare("INSERT INTO referral_codes (code, wallet, created_at) VALUES ('VERTST',?,?)").run(KP.wallet, NOW);
  const r = postReferralBind(d, sign(KP2, "referral.bind", { code: "VERTST" })) as ApiResponse;
  assert.notEqual(
    r.status, 409,
    "a retired-version O1 must not block a bind under the current ruleset",
  );

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// /points/rules — the no-drift contract behind the public rules page.
// ---------------------------------------------------------------------------
// The page renders live from this endpoint precisely so it cannot drift from the
// frozen weights. The gate is therefore not "does it return numbers" but "are
// they THE SAME OBJECTS as the frozen modules" — a literal copied into the
// handler would pass a value check and silently rot at the next re-freeze.
test("/rules serves the FROZEN constants, not copies", () => {
  const { db, dir } = tmpDb();
  const r = getRules(db) as ApiResponse;
  assert.equal(r.status, 200);
  const b = r.body as {
    rules_version: string; quests_version: string;
    base: Record<string, number>;
    multiplier: Record<string, number>;
    referral: Record<string, number>;
    boards: string[];
    profit_board_requires_faucet_provenance: boolean;
  };

  assert.equal(b.rules_version, RULES_VERSION);
  assert.equal(b.quests_version, QUESTS_VERSION);

  // Field-for-field against the frozen rules module.
  assert.equal(b.base.taker_pts_per_usdc, DEFAULT_RULES.takerPtsPerUsdc);
  assert.equal(b.base.maker_pts_per_usdc, DEFAULT_RULES.makerPtsPerUsdc);
  assert.equal(b.base.exercise_pts, DEFAULT_RULES.exercisePts);
  assert.equal(b.base.held_to_settle_pts, DEFAULT_RULES.heldToSettlePts);
  assert.equal(b.base.trigger_executed_pts, DEFAULT_RULES.triggerExecutedPts);
  assert.equal(b.base.settle_expiry_pts, DEFAULT_RULES.settleExpiryPts);
  assert.equal(b.base.create_market_first_pts, DEFAULT_RULES.createMarketFirstPts);
  assert.equal(b.base.create_market_floor_pts, DEFAULT_RULES.createMarketFloorPts);
  assert.equal(b.base.create_market_lifetime_cap_pts, DEFAULT_RULES.createMarketLifetimeCapPts);
  assert.equal(b.base.daily_cap_points, DEFAULT_RULES.dailyCapPoints);
  assert.equal(b.base.over_cap_multiplier, DEFAULT_RULES.overCapMultiplier);

  // EVERY key of DEFAULT_RULES must be published — a rules page that silently
  // omits a weight is exactly the drift this endpoint exists to prevent.
  assert.equal(
    Object.keys(b.base).length, Object.keys(DEFAULT_RULES).length,
    "every DEFAULT_RULES key must appear in /rules.base",
  );

  assert.equal(b.multiplier.step, MULTIPLIER_STEP);
  assert.equal(b.multiplier.cap, MULTIPLIER_CAP);
  assert.equal(b.multiplier.shield_streak_length, SHIELD_STREAK_LENGTH);
  assert.equal(b.multiplier.shield_bank_max, SHIELD_BANK_MAX);

  assert.equal(b.referral.referee_bond_points, DEFAULT_QUESTS.referral.refereeBondPoints);
  assert.equal(b.referral.referrer_rate, DEFAULT_QUESTS.referral.referrerRate);
  assert.equal(b.referral.referrer_cap_fraction_of_self, DEFAULT_QUESTS.referral.referrerCapFractionOfSelf);

  assert.deepEqual(b.boards, ["profit", "volume", "writer", "referrals", "social"]);
  assert.equal(b.profit_board_requires_faucet_provenance, true);

  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

// ===========================================================================
// SLICE 2C — listing requests
// ===========================================================================

const L_MINT = "BPxxfRCXkUVhig4HS1Lh7kZqV6SPJhzfEk4x6fVBjPCy";
const L_MINT2 = "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump";
const L_REQ = { mint: L_MINT, symbol: "BP", assetClass: 0 };
const nRows = (db: DB, sql: string, ...a: unknown[]) =>
  (db.prepare(sql).get(...(a as never[])) as { n: number }).n;

test("listing: a signed request is recorded", () => {
  const { db, dir } = tmpDb();
  const r = postListingRequest(deps(db), sign(KP_A, "listing.request", L_REQ));
  assert.equal(r.status, 200);
  assert.equal((r.body as { status: string }).status, "recorded");
  const row = db.prepare("SELECT * FROM listing_requests WHERE wallet = ?").get(KP_A.wallet) as {
    mint: string; symbol: string; asset_class: number; sig: string;
  };
  assert.equal(row.mint, L_MINT);
  assert.equal(row.symbol, "BP");
  assert.equal(row.asset_class, 0);
  assert.ok(row.sig.length > 40, "the signature is retained so demand stays re-verifiable");
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("listing: a badly-signed request is refused and writes nothing", () => {
  const { db, dir } = tmpDb();
  const good = sign(KP_A, "listing.request", L_REQ);
  const forged = { ...good, signature: bs58.encode(Buffer.alloc(64, 7)) };
  assert.equal(postListingRequest(deps(db), forged).status, 401);
  assert.equal(nRows(db, "SELECT COUNT(*) n FROM listing_requests"), 0);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("listing: params are BOUND to the signature — a swapped mint is refused", () => {
  // The property that makes this safe: canonicalMessage hashes params wholesale,
  // so a signature for BP can never be reused to request a different token.
  const { db, dir } = tmpDb();
  const env = sign(KP_A, "listing.request", L_REQ);
  const swapped = { ...env, params: { ...L_REQ, mint: L_MINT2 } };
  assert.equal(postListingRequest(deps(db), swapped).status, 401);
  assert.equal(nRows(db, "SELECT COUNT(*) n FROM listing_requests"), 0);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("listing: a REPLAYED nonce is refused (409)", () => {
  const { db, dir } = tmpDb();
  const env = sign(KP_A, "listing.request", L_REQ);
  assert.equal(postListingRequest(deps(db), env).status, 200);
  assert.equal(postListingRequest(deps(db), env).status, 409, "same nonce, second use");
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("listing: a repeat request is IDEMPOTENT — already-requested, not an error", () => {
  // A user revisiting a token they already asked for has done nothing wrong.
  const { db, dir } = tmpDb();
  const d = deps(db, { cooldownSecs: 0 });
  const first = postListingRequest(d, sign(KP_A, "listing.request", L_REQ));
  assert.equal((first.body as { status: string }).status, "recorded");
  const again = postListingRequest(d, sign(KP_A, "listing.request", L_REQ));
  assert.equal(again.status, 200, "NOT an error");
  assert.equal((again.body as { status: string }).status, "already-requested");
  assert.equal(nRows(db, "SELECT COUNT(*) n FROM listing_requests"), 1, "still one row");
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("listing: the per-wallet daily cap is enforced", () => {
  const { db, dir } = tmpDb();
  const d = deps(db, { cooldownSecs: 0 });
  // Distinct mints, so it is the CAP that stops us and not the dedupe rule.
  for (let i = 0; i < LISTING_REQUEST_DAILY_CAP; i++) {
    db.prepare(
      "INSERT INTO listing_requests (wallet, mint, symbol, asset_class, requested_at, sig) VALUES (?,?,?,?,?,?)",
    ).run(KP_A.wallet, "mint" + i, "X", 0, NOW - 10, "s");
  }
  const r = postListingRequest(d, sign(KP_A, "listing.request", L_REQ));
  assert.equal(r.status, 429);
  assert.equal((r.body as { error: string }).error, "daily_cap");
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("listing: the cap is a ROLLING 24h window, not a lifetime limit", () => {
  const { db, dir } = tmpDb();
  const d = deps(db, { cooldownSecs: 0 });
  for (let i = 0; i < LISTING_REQUEST_DAILY_CAP; i++) {
    db.prepare(
      "INSERT INTO listing_requests (wallet, mint, symbol, asset_class, requested_at, sig) VALUES (?,?,?,?,?,?)",
    ).run(KP_A.wallet, "old" + i, "X", 0, NOW - 86400 - 60, "s");
  }
  assert.equal(postListingRequest(d, sign(KP_A, "listing.request", L_REQ)).status, 200);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("listing: the cap is PER WALLET — one wallet cannot exhaust another", () => {
  const { db, dir } = tmpDb();
  const d = deps(db, { cooldownSecs: 0 });
  for (let i = 0; i < LISTING_REQUEST_DAILY_CAP; i++) {
    db.prepare(
      "INSERT INTO listing_requests (wallet, mint, symbol, asset_class, requested_at, sig) VALUES (?,?,?,?,?,?)",
    ).run(KP_A.wallet, "mint" + i, "X", 0, NOW - 10, "s");
  }
  assert.equal(postListingRequest(d, sign(KP_B, "listing.request", L_REQ)).status, 200);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("listing: malformed params are refused with distinct reasons", () => {
  const { db, dir } = tmpDb();
  const d = deps(db, { cooldownSecs: 0 });
  const bad = (params: unknown, expected: string) => {
    const r = postListingRequest(d, sign(KP_A, "listing.request", params));
    assert.equal(r.status, 400, expected);
    assert.equal((r.body as { error: string }).error, expected);
  };
  bad({ ...L_REQ, mint: "not-base58!!" }, "bad_mint");
  bad({ ...L_REQ, mint: "abc" }, "bad_mint"); // decodes, wrong length
  bad({ ...L_REQ, symbol: "" }, "bad_symbol");
  bad({ ...L_REQ, symbol: "WAY-TOO-LONG-FOR-A-TICKER" }, "bad_symbol");
  bad({ ...L_REQ, symbol: "<script>" }, "bad_symbol");
  bad({ ...L_REQ, assetClass: 9 }, "bad_asset_class");
  bad({ ...L_REQ, assetClass: -1 }, "bad_asset_class");
  bad({ ...L_REQ, assetClass: 1.5 }, "bad_asset_class");
  assert.equal(nRows(db, "SELECT COUNT(*) n FROM listing_requests"), 0);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("listing: the requested-check reports both states and needs no auth", () => {
  const { db, dir } = tmpDb();
  const before = getListingRequested(db, KP_A.wallet, L_MINT);
  assert.equal(before.status, 200);
  assert.equal((before.body as { requested: boolean }).requested, false);

  postListingRequest(deps(db), sign(KP_A, "listing.request", L_REQ));
  const after = getListingRequested(db, KP_A.wallet, L_MINT);
  assert.equal((after.body as { requested: boolean }).requested, true);
  assert.ok((after.body as { requested_at: number }).requested_at > 0);

  // A different wallet, or a different mint, is still false.
  assert.equal((getListingRequested(db, KP_B.wallet, L_MINT).body as { requested: boolean }).requested, false);
  assert.equal((getListingRequested(db, KP_A.wallet, L_MINT2).body as { requested: boolean }).requested, false);
  assert.equal(getListingRequested(db, "", L_MINT).status, 400);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test("listing: NO points are awarded — this slice never touches the quest engine", () => {
  const { db, dir } = tmpDb();
  postListingRequest(deps(db), sign(KP_A, "listing.request", L_REQ));
  assert.equal(nRows(db, "SELECT COUNT(*) n FROM quest_completions"), 0);
  assert.equal(nRows(db, "SELECT COUNT(*) n FROM scores"), 0);
  db.close(); fs.rmSync(dir, { recursive: true, force: true });
});
