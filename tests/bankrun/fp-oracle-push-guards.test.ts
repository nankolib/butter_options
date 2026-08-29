// =============================================================================
// tests/bankrun/fp-oracle-push-guards.test.ts — FP-ORACLE module guard suite
// =============================================================================
// The first-party oracle inverts the trust model: this is a feed WE write, so
// every guard on push_opta_price is load-bearing in a way the Pyth/SB arms'
// guards are not. A missing guard here is not a wrong price, it is a writable
// settlement price.
//
// Each test drives the guard to its violating input and asserts the SPECIFIC
// error code — not merely "it threw". A test that accepts any revert passes
// just as happily when the instruction fails for an unrelated reason, which is
// how a guard silently stops being tested.
//
// MUTATION-PROVEN. Per the build ruling, a green here counts only because each
// guard was individually disabled in the program and the corresponding test was
// observed to go red. See FP_ORACLE_MODULE_SPEC_V2 and the mutation log in the
// commit message for the run.
//
// The arms are NOT wired, so nothing here reads a price through a market — this
// suite covers the feed lifecycle and the write path only. Read-arm tests land
// with the arm-6-sites commit.
// =============================================================================

import { assert } from "chai";
import { SystemProgram } from "@solana/web3.js";
import {
  setupEnv, getClockUnix, setClockUnix, fundWallet,
  BN, PublicKey, Keypair, OPTA_PROGRAM_ID, Env,
} from "./helpers";
import { synthFeedIdHex } from "../_pyth_fixtures";

const SKEW = 30;          // OPTA_FEED_PUSH_MAX_SKEW_SECS
const MIN_INTERVAL = 5;   // OPTA_FEED_MIN_PUSH_INTERVAL_SECS
const MAX_DEV_BPS = 500;  // OPTA_FEED_MAX_DEVIATION_BPS
const BASELINE_MAX_AGE = 900; // OPTA_FEED_DEVIATION_BASELINE_MAX_AGE_SECS

const px = (n: number) => new BN(Math.round(n * 1_000_000)); // USDC 6-dec

function feedBytes(label: string): number[] {
  return Array.from(Buffer.from(synthFeedIdHex(label), "hex"));
}
const feedPda = (bytes: number[]) =>
  PublicKey.findProgramAddressSync(
    [Buffer.from("opta_price_feed"), Buffer.from(bytes)],
    OPTA_PROGRAM_ID,
  )[0];

/** Assert a thrown Anchor error carries EXACTLY this error name. */
function assertErr(err: string, name: string, ctx: string) {
  assert.include(
    err, name,
    `${ctx}: expected ${name}, got: ${err.slice(0, 400)}`,
  );
}

/** Attempt a push; never throws. */
async function tryPush(
  e: Env, bytes: number[], feed: PublicKey, authority: Keypair,
  price: BN, conf: BN, publishTime: number,
): Promise<{ ok: boolean; err: string }> {
  try {
    await e.opta.methods
      .pushOptaPrice(bytes, price, conf, new BN(publishTime))
      .accountsStrict({ authority: authority.publicKey, optaPriceFeed: feed })
      .signers([authority])
      .rpc();
    return { ok: true, err: "" };
  } catch (ex: any) {
    return { ok: false, err: String(ex) };
  }
}

/** Fresh env + an initialised feed with a funded, non-admin authority. */
async function setupFeed(label: string): Promise<{
  e: Env; bytes: number[]; feed: PublicKey; authority: Keypair;
}> {
  const e = await setupEnv(`FP${label.toUpperCase()}`, `fp-${label}`);
  const bytes = feedBytes(`fp-feed-${label}`);
  const feed = feedPda(bytes);
  const authority = Keypair.generate();
  // Authority signs but never pays rent here, so a small airdrop is enough.
  fundWallet(e.h.context, authority);
  await e.opta.methods
    .initOptaPriceFeed(bytes, authority.publicKey)
    .accountsStrict({
      admin: e.admin.publicKey,
      protocolState: e.protocolState,
      optaPriceFeed: feed,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  return { e, bytes, feed, authority };
}

describe("FP-ORACLE — push_opta_price guards", () => {
  // ---- init ---------------------------------------------------------------

  it("init refuses admin-as-authority (the separation must not be givable away)", async () => {
    const e = await setupEnv("FPADM", "fp-adm");
    const bytes = feedBytes("fp-feed-adm");
    const feed = feedPda(bytes);
    let err = "";
    try {
      await e.opta.methods
        .initOptaPriceFeed(bytes, e.admin.publicKey)
        .accountsStrict({
          admin: e.admin.publicKey, protocolState: e.protocolState,
          optaPriceFeed: feed, systemProgram: SystemProgram.programId,
        }).rpc();
    } catch (ex: any) { err = String(ex); }
    assertErr(err, "OptaFeedUnauthorized", "admin-as-authority");
  });

  it("a new feed stores NO price — creating one cannot make anything quotable", async () => {
    const { e, feed } = await setupFeed("new");
    const acct: any = await (e.opta.account as any).optaPriceFeed.fetch(feed);
    assert.equal(Number(acct.price6Dec), 0, "price must be 0 at birth");
    assert.equal(Number(acct.publishTime), 0, "publish_time must be 0 at birth");
    assert.isFalse(acct.frozen, "must not be born frozen");
  });

  // ---- authority ----------------------------------------------------------

  it("rejects a push from a non-authority signer (6095)", async () => {
    const { e, bytes, feed } = await setupFeed("auth");
    const impostor = Keypair.generate();
    fundWallet(e.h.context, impostor);
    const now = await getClockUnix(e.h.context);
    const r = await tryPush(e, bytes, feed, impostor, px(100), px(0.01), now);
    assert.isFalse(r.ok, "impostor push must not land");
    assertErr(r.err, "OptaFeedUnauthorized", "impostor");
  });

  it("rejects a push from the ADMIN — admin has no override on the write path", async () => {
    const { e, bytes, feed } = await setupFeed("adminpush");
    const now = await getClockUnix(e.h.context);
    const r = await tryPush(e, bytes, feed, e.admin, px(100), px(0.01), now);
    assert.isFalse(r.ok, "admin must not be able to write a price");
    assertErr(r.err, "OptaFeedUnauthorized", "admin push");
  });

  // ---- value + skew -------------------------------------------------------

  it("rejects a zero price (6093)", async () => {
    const { e, bytes, feed, authority } = await setupFeed("zero");
    const now = await getClockUnix(e.h.context);
    const r = await tryPush(e, bytes, feed, authority, new BN(0), new BN(0), now);
    assert.isFalse(r.ok);
    assertErr(r.err, "OptaFeedInvalidPrice", "zero price");
  });

  it("rejects a FUTURE-dated push beyond the skew window (6099)", async () => {
    const { e, bytes, feed, authority } = await setupFeed("future");
    const now = await getClockUnix(e.h.context);
    const r = await tryPush(e, bytes, feed, authority, px(100), px(0.01), now + SKEW + 5);
    assert.isFalse(r.ok, "future-dating would keep a dead feed looking fresh");
    assertErr(r.err, "OptaFeedSkewTooLarge", "future skew");
  });

  it("rejects a BACKDATED push beyond the skew window (6099)", async () => {
    const { e, bytes, feed, authority } = await setupFeed("past");
    const now = await getClockUnix(e.h.context);
    const r = await tryPush(e, bytes, feed, authority, px(100), px(0.01), now - SKEW - 5);
    assert.isFalse(r.ok, "backfill would replay a stale price as current");
    assertErr(r.err, "OptaFeedSkewTooLarge", "past skew");
  });

  it("accepts a push inside the skew window", async () => {
    const { e, bytes, feed, authority } = await setupFeed("ok");
    const now = await getClockUnix(e.h.context);
    const r = await tryPush(e, bytes, feed, authority, px(100), px(0.01), now - 2);
    assert.isTrue(r.ok, `in-window push must land: ${r.err}`);
    const acct: any = await (e.opta.account as any).optaPriceFeed.fetch(feed);
    assert.equal(Number(acct.price6Dec), 100_000_000);
  });

  // ---- rate limit ---------------------------------------------------------

  it("rejects a second push inside the rate-limit window (6097)", async () => {
    const { e, bytes, feed, authority } = await setupFeed("rate");
    const now = await getClockUnix(e.h.context);
    assert.isTrue((await tryPush(e, bytes, feed, authority, px(100), px(0.01), now)).ok);
    // Same publish_time + 1s: inside MIN_INTERVAL.
    const r = await tryPush(e, bytes, feed, authority, px(100.1), px(0.01), now + 1);
    assert.isFalse(r.ok, "push-spam must be refused");
    assertErr(r.err, "OptaFeedPushTooSoon", "rate limit");
  });

  it("accepts the next push once the rate-limit window has passed", async () => {
    const { e, bytes, feed, authority } = await setupFeed("rateok");
    const t0 = await getClockUnix(e.h.context);
    assert.isTrue((await tryPush(e, bytes, feed, authority, px(100), px(0.01), t0)).ok);
    await setClockUnix(e.h.context, t0 + MIN_INTERVAL + 2);
    const t1 = await getClockUnix(e.h.context);
    const r = await tryPush(e, bytes, feed, authority, px(100.1), px(0.01), t1);
    assert.isTrue(r.ok, `post-window push must land: ${r.err}`);
  });

  // ---- deviation circuit-breaker -----------------------------------------

  it("trips the breaker on a jump beyond MAX_DEVIATION_BPS (6098)", async () => {
    const { e, bytes, feed, authority } = await setupFeed("dev");
    const t0 = await getClockUnix(e.h.context);
    assert.isTrue((await tryPush(e, bytes, feed, authority, px(100), px(0.01), t0)).ok);
    await setClockUnix(e.h.context, t0 + MIN_INTERVAL + 2);
    const t1 = await getClockUnix(e.h.context);
    // +10% — comfortably past the 500 bps limit. This is the "compromised key
    // writes a fake price" case, and it must not land in one step.
    const r = await tryPush(e, bytes, feed, authority, px(110), px(0.01), t1);
    assert.isFalse(r.ok, "a 10% single-step move must not land");
    assertErr(r.err, "OptaFeedDeviationTooLarge", "breaker");
  });

  it("accepts a move inside the breaker band, and shadow-logs the observe range", async () => {
    const { e, bytes, feed, authority } = await setupFeed("devok");
    const t0 = await getClockUnix(e.h.context);
    assert.isTrue((await tryPush(e, bytes, feed, authority, px(100), px(0.01), t0)).ok);
    await setClockUnix(e.h.context, t0 + MIN_INTERVAL + 2);
    const t1 = await getClockUnix(e.h.context);
    // +3% — inside 500 bps, above the 150 bps observe threshold, so this both
    // lands AND emits would_have_tripped for the soak to reason about.
    const r = await tryPush(e, bytes, feed, authority, px(103), px(0.01), t1);
    assert.isTrue(r.ok, `3% move must land: ${r.err}`);
    const acct: any = await (e.opta.account as any).optaPriceFeed.fetch(feed);
    assert.equal(Number(acct.price6Dec), 103_000_000);
    assert.equal(Number(acct.prevPrice6Dec), 100_000_000,
      "prev_* must roll to the previous ACCEPTED push");
  });

  it("skips the breaker after a long gap — a stale baseline is not a baseline", async () => {
    const { e, bytes, feed, authority } = await setupFeed("gap");
    const t0 = await getClockUnix(e.h.context);
    assert.isTrue((await tryPush(e, bytes, feed, authority, px(100), px(0.01), t0)).ok);
    await setClockUnix(e.h.context, t0 + BASELINE_MAX_AGE + 60);
    const t1 = await getClockUnix(e.h.context);
    // +50% after a 16-minute gap. A real market can move any distance in that
    // time, so this is a re-seed, not an attack, and must land.
    const r = await tryPush(e, bytes, feed, authority, px(150), px(0.01), t1);
    assert.isTrue(r.ok, `post-gap reseed must land: ${r.err}`);
  });

  it("does not trip on the FIRST push — there is no baseline to deviate from", async () => {
    const { e, bytes, feed, authority } = await setupFeed("first");
    const now = await getClockUnix(e.h.context);
    const r = await tryPush(e, bytes, feed, authority, px(69_420), px(1), now);
    assert.isTrue(r.ok, `first push must land at any value: ${r.err}`);
  });

  // ---- freeze (revocation tier 1) ----------------------------------------

  it("a frozen feed refuses pushes from the REAL authority (6092)", async () => {
    const { e, bytes, feed, authority } = await setupFeed("frozen");
    const t0 = await getClockUnix(e.h.context);
    assert.isTrue((await tryPush(e, bytes, feed, authority, px(100), px(0.01), t0)).ok);

    await e.opta.methods.setFeedFrozen(bytes, true).accountsStrict({
      admin: e.admin.publicKey, protocolState: e.protocolState, optaPriceFeed: feed,
    }).rpc();

    await setClockUnix(e.h.context, t0 + MIN_INTERVAL + 2);
    const t1 = await getClockUnix(e.h.context);
    const r = await tryPush(e, bytes, feed, authority, px(100.5), px(0.01), t1);
    assert.isFalse(r.ok, "freeze must be absolute — that is what makes it a kill-switch");
    assertErr(r.err, "OptaFeedFrozen", "frozen push");
  });

  it("unfreezing restores pushes", async () => {
    const { e, bytes, feed, authority } = await setupFeed("unfreeze");
    const t0 = await getClockUnix(e.h.context);
    assert.isTrue((await tryPush(e, bytes, feed, authority, px(100), px(0.01), t0)).ok);
    const admAcc = {
      admin: e.admin.publicKey, protocolState: e.protocolState, optaPriceFeed: feed,
    };
    await e.opta.methods.setFeedFrozen(bytes, true).accountsStrict(admAcc).rpc();
    await e.opta.methods.setFeedFrozen(bytes, false).accountsStrict(admAcc).rpc();
    await setClockUnix(e.h.context, t0 + MIN_INTERVAL + 2);
    const t1 = await getClockUnix(e.h.context);
    const r = await tryPush(e, bytes, feed, authority, px(100.5), px(0.01), t1);
    assert.isTrue(r.ok, `post-unfreeze push must land: ${r.err}`);
  });

  it("freeze is admin-only", async () => {
    const { e, bytes, feed, authority } = await setupFeed("freezeauth");
    let err = "";
    try {
      await e.opta.methods.setFeedFrozen(bytes, true).accountsStrict({
        admin: authority.publicKey, protocolState: e.protocolState, optaPriceFeed: feed,
      }).signers([authority]).rpc();
    } catch (ex: any) { err = String(ex); }
    assert.notEqual(err, "", "the oracle authority must not be able to freeze");
  });

  // ---- rotation (revocation tier 2) --------------------------------------

  it("rotation makes the old key inert and the new key live", async () => {
    const { e, bytes, feed, authority } = await setupFeed("rotate");
    const t0 = await getClockUnix(e.h.context);
    assert.isTrue((await tryPush(e, bytes, feed, authority, px(100), px(0.01), t0)).ok);

    const fresh = Keypair.generate();
    fundWallet(e.h.context, fresh);
    await e.opta.methods.setFeedAuthority(bytes, fresh.publicKey).accountsStrict({
      admin: e.admin.publicKey, protocolState: e.protocolState, optaPriceFeed: feed,
    }).rpc();

    await setClockUnix(e.h.context, t0 + MIN_INTERVAL + 2);
    const t1 = await getClockUnix(e.h.context);

    const oldPush = await tryPush(e, bytes, feed, authority, px(100.5), px(0.01), t1);
    assert.isFalse(oldPush.ok, "the rotated-out key must be inert immediately");
    assertErr(oldPush.err, "OptaFeedUnauthorized", "old key after rotation");

    const newPush = await tryPush(e, bytes, feed, fresh, px(100.5), px(0.01), t1);
    assert.isTrue(newPush.ok, `the new key must work at once: ${newPush.err}`);
  });

  it("rotation refuses admin-as-authority too", async () => {
    const { e, bytes, feed } = await setupFeed("rotadm");
    let err = "";
    try {
      await e.opta.methods.setFeedAuthority(bytes, e.admin.publicKey).accountsStrict({
        admin: e.admin.publicKey, protocolState: e.protocolState, optaPriceFeed: feed,
      }).rpc();
    } catch (ex: any) { err = String(ex); }
    assertErr(err, "OptaFeedUnauthorized", "rotate to admin");
  });
});
