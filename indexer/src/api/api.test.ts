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
import { recompute } from "../score/recompute";
import { canonicalJson, canonicalMessage, verifySigned, type SignedEnvelope } from "./auth";
import {
  getLeaderboard,
  getQuests,
  getStats,
  getWallet,
  postBountySubmit,
  postReferralBind,
  postReferralCode,
  postSocialSubmit,
  type ApiDeps,
  type ApiResponse,
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
  db.prepare("INSERT INTO quest_completions (quests_version, wallet, quest_id, period_key, completed_at, points) VALUES ('v1',?, 'O1','',?,50)").run(KP_C.wallet, NOW);
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
  assert.equal((q.body as { version: string }).version, "v1");

  const s = getStats(db);
  assert.equal(s.status, 200);
  assert.equal((s.body as { schema_version: number }).schema_version, 5);

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
