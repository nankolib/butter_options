// =============================================================================
// tests/_pyth_fixtures.ts — Fake PriceUpdateV2 fixture helper
// =============================================================================
//
// Stage P2 test infrastructure. Serializes Pyth Pull PriceUpdateV2 accounts
// in their exact on-chain Borsh layout so solana-test-validator's
// --account flag can pre-load them with Pyth Receiver as the owner. The
// settle_expiry instruction's `Account<'info, PriceUpdateV2>` constraint
// then accepts them as if they came from a real post_update_atomic call.
//
// Layout reference: pythnet-sdk-2.3.1::messages::PriceFeedMessage and
// pyth-solana-receiver-sdk-1.1.0::price_update::PriceUpdateV2.
//
// Total bytes per fixture: 8 (discriminator) + 32 (write_authority) +
//   1 (verification_level=Full) + 84 (price_message) + 8 (posted_slot) = 133.
// =============================================================================

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import { PublicKey } from "@solana/web3.js";

// Pyth Solana Receiver program ID (devnet + mainnet are the same).
export const PYTH_RECEIVER_ID = "rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ";

// Anchor account discriminator: SHA-256("account:PriceUpdateV2")[..8].
function priceUpdateV2Discriminator(): Buffer {
  return crypto
    .createHash("sha256")
    .update("account:PriceUpdateV2")
    .digest()
    .subarray(0, 8);
}

export type PriceUpdateFixture = {
  feedIdHex: string;     // 64 hex chars (no 0x prefix)
  price: bigint;         // i64
  conf: bigint;          // u64
  exponent: number;      // i32
  publishTime: bigint;   // i64 (unix seconds)
  prevPublishTime: bigint; // i64
  emaPrice: bigint;      // i64
  emaConf: bigint;       // u64
};

/// Serialize a PriceUpdateV2 account body (133 bytes including discriminator).
export function serializePriceUpdateV2(f: PriceUpdateFixture): Buffer {
  const buf = Buffer.alloc(8 + 32 + 1 + 84 + 8);
  let o = 0;

  // Discriminator
  priceUpdateV2Discriminator().copy(buf, o);
  o += 8;

  // write_authority: Pubkey (any value — settle_expiry doesn't read it)
  buf.fill(0, o, o + 32);
  o += 32;

  // verification_level: Full = enum tag 1 (Borsh: 1-byte tag, no payload).
  buf.writeUInt8(1, o);
  o += 1;

  // PriceFeedMessage — declaration order in pythnet-sdk-2.3.1::messages.rs:
  //   feed_id, price, conf, exponent, publish_time, prev_publish_time,
  //   ema_price, ema_conf
  const feedId = Buffer.from(f.feedIdHex, "hex");
  if (feedId.length !== 32) {
    throw new Error(`feedIdHex must decode to 32 bytes, got ${feedId.length}`);
  }
  feedId.copy(buf, o); o += 32;
  buf.writeBigInt64LE(f.price, o); o += 8;
  buf.writeBigUInt64LE(f.conf, o); o += 8;
  buf.writeInt32LE(f.exponent, o); o += 4;
  buf.writeBigInt64LE(f.publishTime, o); o += 8;
  buf.writeBigInt64LE(f.prevPublishTime, o); o += 8;
  buf.writeBigInt64LE(f.emaPrice, o); o += 8;
  buf.writeBigUInt64LE(f.emaConf, o); o += 8;

  // posted_slot: u64 (any value — not read by settle_expiry)
  buf.writeBigUInt64LE(BigInt(0), o); o += 8;

  return buf;
}

/// Round-trip deserializer matching `serializePriceUpdateV2` byte layout.
/// Self-consistency check — catches off-by-N / endianness / int-size bugs
/// in our own serializer. Cross-side drift (the Pyth SDK changing the
/// PriceFeedMessage struct) is caught by the downstream end-to-end
/// settle_expiry tests when the program rejects the fixture.
export function deserializePriceUpdateV2(body: Buffer): {
  discriminator: Buffer;
  writeAuthority: Buffer;
  verificationLevelTag: number; // 0 = Partial, 1 = Full
  feedId: Buffer;
  price: bigint;
  conf: bigint;
  exponent: number;
  publishTime: bigint;
  prevPublishTime: bigint;
  emaPrice: bigint;
  emaConf: bigint;
  postedSlot: bigint;
} {
  if (body.length !== 133) {
    throw new Error(`expected 133 bytes, got ${body.length}`);
  }
  let o = 0;
  const discriminator = body.subarray(o, o + 8); o += 8;
  const writeAuthority = body.subarray(o, o + 32); o += 32;
  const verificationLevelTag = body.readUInt8(o); o += 1;
  const feedId = body.subarray(o, o + 32); o += 32;
  const price = body.readBigInt64LE(o); o += 8;
  const conf = body.readBigUInt64LE(o); o += 8;
  const exponent = body.readInt32LE(o); o += 4;
  const publishTime = body.readBigInt64LE(o); o += 8;
  const prevPublishTime = body.readBigInt64LE(o); o += 8;
  const emaPrice = body.readBigInt64LE(o); o += 8;
  const emaConf = body.readBigUInt64LE(o); o += 8;
  const postedSlot = body.readBigUInt64LE(o); o += 8;
  return {
    discriminator, writeAuthority, verificationLevelTag,
    feedId, price, conf, exponent, publishTime, prevPublishTime,
    emaPrice, emaConf, postedSlot,
  };
}

/// Deterministic pubkey for a fixture name. SHA-256("opta:fixture:" + name)
/// truncated to 32 bytes. Doesn't need to be a valid ed25519 point — accounts
/// can have any 32-byte address.
export function fixturePubkey(name: string): PublicKey {
  const bytes = crypto
    .createHash("sha256")
    .update("opta:fixture:" + name)
    .digest()
    .subarray(0, 32);
  return new PublicKey(bytes);
}

/// Write the JSON fixture in solana-test-validator's --account format.
/// rentEpoch=0 is safe for test fixtures: accounts are rent-exempt (5M
/// lamports for 133 bytes is well above the rent-exempt minimum), and
/// the validator never tries to collect rent on a 0-epoch account.
/// Using u64::MAX would lose precision through JSON.stringify since
/// 1.8e19 > Number.MAX_SAFE_INTEGER, breaking the validator's parser.
export function writeFixtureJson(filePath: string, pubkey: PublicKey, body: Buffer): void {
  const accountJson = {
    pubkey: pubkey.toBase58(),
    account: {
      lamports: 5_000_000,
      data: [body.toString("base64"), "base64"],
      owner: PYTH_RECEIVER_ID,
      executable: false,
      rentEpoch: 0,
      space: body.length,
    },
  };
  fs.writeFileSync(filePath, JSON.stringify(accountJson, null, 2));
}

/// Hex feed IDs for the assets we use in tests. Mainnet IDs from
/// scripts/pyth-feed-ids.csv — Stage P2 stores these verbatim, no
/// validation against Hermes (we use Option B = fake fixtures).
export const FEED_ID_HEX = {
  SOL: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  BTC: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
};

/// Stage B Step 3: deterministically derived per-test feed IDs so each
/// VolOracle test gets its own independent oracle PDA. Same SHA-256
/// scheme as `fixturePubkey` (different namespace prefix to avoid
/// collisions with the deterministic pubkey side). The feed_id only
/// needs to be a 32-byte string the program treats as opaque -- it does
/// not have to be a real Pyth feed because the proof gate checks against
/// the fixture's own price_message.feed_id which we control.
export function synthFeedIdHex(label: string): string {
  return crypto
    .createHash("sha256")
    .update("opta:vol_test:feed:" + label)
    .digest()
    .subarray(0, 32)
    .toString("hex");
}

/// Dedicated synthetic feed for the American-pricing suite
/// (tests/zzz-mint-from-vault-american-pricing.ts). Isolated from the real SOL
/// feed so that suite's cold/warm/stale oracle states don't collide with other
/// files that warm the SOL oracle (e.g. zzz-american-vault-lifecycle.ts).
export const AMER_PRICE_FEED_HEX = synthFeedIdHex("amer-price-dedicated");

/// Dedicated synthetic feed for the American lifecycle suite
/// (tests/zzz-american-vault-lifecycle.ts). Isolated so warming it doesn't
/// pollute the real SOL oracle that zzz-vol-oracle.ts initializes + inspects.
export const AMER_LIFE_FEED_HEX = synthFeedIdHex("amer-life-dedicated");

/// Dedicated synthetic feed for the Stage E metadata suite
/// (tests/zzz-metadata-exercise-style.ts). Isolated so warming it (American
/// case) doesn't collide with the other American suites' oracle states.
export const AMER_META_FEED_HEX = synthFeedIdHex("amer-meta-dedicated");

/// Per-test synthetic feed IDs (computed at module load).
export const VOL_TEST_FEED_HEX = {
  T1_SEED: synthFeedIdHex("t1-seed"),
  T2_RATE_LIMIT: synthFeedIdHex("t2-rate-limit"),
  T3_REAL_PUSH: synthFeedIdHex("t3-real-push"),
  T5_MISMATCH_HOST: synthFeedIdHex("t5-mismatch-host"),
  T6_STALE: synthFeedIdHex("t6-stale"),
  T7_ZERO_SPOT: synthFeedIdHex("t7-zero-spot"),
  T4_LONG_RING_WRAP: synthFeedIdHex("t4-long-ring-wrap"),
};

// ---------------------------------------------------------------------------
// baseTime persistence (D2-only — 2026-05-03)
// ---------------------------------------------------------------------------
//
// settle_expiry's new EXPIRY_WINDOW_SECS check (publish_time within 60s of
// expiry) requires the 3 D2 tests to compute their expiry as baseTime + N
// matching the fixture's hardcoded publishTimeOffsetSec, NOT as
// `Date.now()/1000 + N` like older tests.
//
// To bridge fixture-write time and test runtime, we persist the `now` used
// by writeAllFixtures to /tmp/pyth_meta.json. Tests read that via
// getFixtureBaseTime(). Sidecar file approach matches how fixture JSONs
// are already passed (file-on-disk).
//
// Only the 3 D2 tests in opta.ts use this. Older tests that drive settle
// remain on the Date.now()-based pattern (and thus break under the new
// on-chain check; per the test-suite-delta migration log entry, those
// will be re-enabled in a separate refactor arc).
//
// Path resolution mirrors `_write_fixtures.ts`'s convention:
//   getFixtureBaseTime: process.env.OPTA_FIXTURE_DIR ?? "./.test-fixtures"
//   writeAllFixtures:   outDir param (caller's responsibility — typically
//                       "./.test-fixtures" passed by run-tests.sh).
// The two endpoints align as long as the runner passes the same dir.
const META_FILE = "pyth_meta.json";
const DEFAULT_FIXTURE_DIR = "./.test-fixtures";

declare const process: { env: Record<string, string | undefined> };

function getFixtureDir(): string {
  return process.env.OPTA_FIXTURE_DIR ?? DEFAULT_FIXTURE_DIR;
}

export function getFixtureBaseTime(): number {
  const metaPath = path.join(getFixtureDir(), META_FILE);
  try {
    const raw = fs.readFileSync(metaPath, "utf-8");
    const parsed = JSON.parse(raw) as { baseTime?: number };
    if (typeof parsed.baseTime !== "number" || !Number.isFinite(parsed.baseTime)) {
      throw new Error("invalid baseTime in meta file");
    }
    return parsed.baseTime;
  } catch (err) {
    throw new Error(
      `getFixtureBaseTime: failed to read ${metaPath}. Did writeAllFixtures run before tests started? (${String(err)})`,
    );
  }
}

/// The 5 fixtures the P2 test suite needs. Names map to scenarios and
/// must stay stable — test code looks them up by name via fixturePubkey().
export type FixtureSpec = {
  name: string;
  feedIdHex: string;
  /// Price as a u128-ish number (TS bigint). Pyth uses (price × 10^expo).
  price: bigint;
  exponent: number;
  /// Offset from now (negative = in the past). 0 = "right now".
  publishTimeOffsetSec: number;
  /// Optional override for emaConf. Defaults to 1_000_000 (well below
  /// any realistic threshold for SOL/BTC at typical prices). The CRIT-2
  /// conf-gate tests dial this above/at/below the MAX_CONF_BPS=200
  /// boundary to exercise the new check in settle_expiry.
  emaConf?: bigint;
  /// Optional override for emaPrice. Defaults to `price`. Used by the
  /// Stage B Step 3 zero-spot fixture (price=0) to keep emaPrice
  /// nonzero, so the upstream EMA-conf gate is permissive and the
  /// downstream VolOracleInvalidSpot check is the one that fires. Keeps
  /// the test robust against future handler reordering.
  emaPrice?: bigint;
};

export const ALL_FIXTURES: FixtureSpec[] = [
  // SOL @ $180, fresh — used by opta happy/pre-expiry/unregistered/double-settle
  { name: "sol-180-fresh", feedIdHex: FEED_ID_HEX.SOL, price: BigInt("18000000000"), exponent: -8, publishTimeOffsetSec: -30 },
  // SOL @ $180 but stale — used by opta stale-rejection test
  { name: "sol-180-stale", feedIdHex: FEED_ID_HEX.SOL, price: BigInt("18000000000"), exponent: -8, publishTimeOffsetSec: -400 },
  // BTC fresh — used by opta wrong-feed test (asset is SOL but fixture is BTC feed)
  { name: "btc-fresh", feedIdHex: FEED_ID_HEX.BTC, price: BigInt("90000000000000"), exponent: -8, publishTimeOffsetSec: -30 },
  // SOL @ $250 fresh — zzz CRITICAL-ITM
  { name: "sol-250-fresh", feedIdHex: FEED_ID_HEX.SOL, price: BigInt("25000000000"), exponent: -8, publishTimeOffsetSec: -30 },
  // SOL @ $50 fresh — zzz CRITICAL-OTM, HIGH-01, DUST
  { name: "sol-50-fresh", feedIdHex: FEED_ID_HEX.SOL, price: BigInt("5000000000"), exponent: -8, publishTimeOffsetSec: -30 },
  // -- D2 expiry-window fixtures (2026-05-03) ----------------------------------
  // Pinned to baseTime: each is paired with a specific test expiry in opta.ts
  // such that the gap publish_time - expiry is exactly the value the test
  // exercises. Tests compute their expiry via getFixtureBaseTime() + N to
  // match these offsets exactly.
  //
  // sol-180-window-future-5: publish_time=baseTime+55, paired expiry=baseTime+50, gap=+5s (HAPPY)
  { name: "sol-180-window-future-5", feedIdHex: FEED_ID_HEX.SOL, price: BigInt("18000000000"), exponent: -8, publishTimeOffsetSec: 55 },
  // sol-180-window-before-5: publish_time=baseTime+46, paired expiry=baseTime+51, gap=-5s (PriceUpdateBeforeExpiry)
  { name: "sol-180-window-before-5", feedIdHex: FEED_ID_HEX.SOL, price: BigInt("18000000000"), exponent: -8, publishTimeOffsetSec: 46 },
  // sol-180-window-too-late-120: publish_time=baseTime+172, paired expiry=baseTime+52, gap=+120s (PriceUpdateTooFarFromExpiry)
  { name: "sol-180-window-too-late-120", feedIdHex: FEED_ID_HEX.SOL, price: BigInt("18000000000"), exponent: -8, publishTimeOffsetSec: 172 },
  // -- CRIT-2 conf-gate fixtures (audit Run-6, 2026-05-03) ---------------------
  // Threshold: conf * 10_000 <= |ema_price| * MAX_CONF_BPS (=200). For
  // SOL @ 180 (ema_price scaled = 18_000_000_000), boundary is conf =
  // 360_000_000. Each fixture is paired with a distinct expiry to avoid
  // SettlementRecord PDA collision; all three use a +5s window-gate gap.
  // sol-180-conf-just-under: emaConf=359_999_999, paired expiry=baseTime+100, gap=+5 → PASS
  { name: "sol-180-conf-just-under", feedIdHex: FEED_ID_HEX.SOL, price: BigInt("18000000000"), exponent: -8, publishTimeOffsetSec: 105, emaConf: BigInt(359_999_999) },
  // sol-180-conf-at-edge:    emaConf=360_000_000 (boundary inclusive), expiry=baseTime+101, gap=+5 → PASS
  { name: "sol-180-conf-at-edge",    feedIdHex: FEED_ID_HEX.SOL, price: BigInt("18000000000"), exponent: -8, publishTimeOffsetSec: 106, emaConf: BigInt(360_000_000) },
  // sol-180-conf-just-over:  emaConf=360_000_001, expiry=baseTime+102, gap=+5 → REVERT (PriceConfidenceTooWide)
  { name: "sol-180-conf-just-over",  feedIdHex: FEED_ID_HEX.SOL, price: BigInt("18000000000"), exponent: -8, publishTimeOffsetSec: 107, emaConf: BigInt(360_000_001) },
  // -- CRIT-1 holders-first gate fixtures (audit Run-6, 2026-05-03) ------------
  // Two fixtures used by tests/zzz-crit1-holders-first-gate.ts. Test expiries
  // are baseTime + 60/90/120/150 (30s spacing — minimum 60s buffer for fresh
  // validator bootstrap on Test 1, comfortable buffers thereafter). The 90s
  // spread between Test 1 and Test 4 exceeds the 60s settle_expiry
  // publish-time window, so we use TWO fixtures — each serves two tests:
  //
  //   Fixture A (sol-250-window-future-90, publish_time = baseTime + 90):
  //     Test 1 (sole-writer ITM, BEFORE window):    expiry=baseTime+60, gap=+30
  //     Test 2 (sole-writer no-buyer):              expiry=baseTime+90, gap= 0
  //
  //   Fixture B (sol-250-window-future-180, publish_time = baseTime + 180):
  //     Test 3 (multi-writer ITM, BEFORE window):   expiry=baseTime+120, gap=+60
  //     Test 4 (multi-writer no-buyer):             expiry=baseTime+150, gap=+30
  //
  // Both fixtures use default emaConf (1_000_000), which passes the CRIT-2
  // 200bps confidence-interval gate at SOL @ $250 by a wide margin
  // (threshold = 25e9 * 200 / 10_000 = 5e8; 1e6 << 5e8).
  //
  // gap math verification: gap = publish_time - expiry, must be in [0, 60].
  //   Fixture A: 90-60=+30 ✓, 90-90=0 ✓
  //   Fixture B: 180-120=+60 ✓ (boundary inclusive), 180-150=+30 ✓
  { name: "sol-250-window-future-90", feedIdHex: FEED_ID_HEX.SOL, price: BigInt("25000000000"), exponent: -8, publishTimeOffsetSec: 90 },
  { name: "sol-250-window-future-180", feedIdHex: FEED_ID_HEX.SOL, price: BigInt("25000000000"), exponent: -8, publishTimeOffsetSec: 180 },
  // -- Stage B Step 3 VolOracle fixtures (2026-05-17) --------------------------
  // One per-test feed_id keeps push tests independent. Most fixtures pin
  // publishTime *far in the future* (offset = +1500 = 25 min ahead of
  // baseTime) so they remain fresh (publish_time + 60 >= now) even when
  // run as part of the full alphabetical suite, where `zzz-vol-oracle.ts`
  // fires 5-10 wall-clock minutes after fixtures are written. The T6
  // stale fixture is the intentional exception (negative offset).
  //
  // Freshness gate is one-sided in push_vol_sample (matches
  // settle_expiry); Pyth Receiver verification is also one-sided, so a
  // future publishTime passes both. We never test "future publishTime
  // rejection" because no such reject exists -- consistent with the
  // settle_expiry precedent.
  //
  // For T7 (zero spot): price = 0 triggers VolOracleInvalidSpot in
  // push_vol_sample, but emaPrice = 1 keeps the upstream ema-conf gate
  // permissive so the test sees the spot-positivity error first
  // (handler order: spot > 0 then conf then freshness).
  { name: "vol-t1-fresh", feedIdHex: VOL_TEST_FEED_HEX.T1_SEED, price: BigInt("18000000000"), exponent: -8, publishTimeOffsetSec: 1500 },
  { name: "vol-t2-fresh", feedIdHex: VOL_TEST_FEED_HEX.T2_RATE_LIMIT, price: BigInt("18000000000"), exponent: -8, publishTimeOffsetSec: 1500 },
  { name: "vol-t3-180",   feedIdHex: VOL_TEST_FEED_HEX.T3_REAL_PUSH, price: BigInt("18000000000"), exponent: -8, publishTimeOffsetSec: 1500 },
  { name: "vol-t3-250",   feedIdHex: VOL_TEST_FEED_HEX.T3_REAL_PUSH, price: BigInt("25000000000"), exponent: -8, publishTimeOffsetSec: 1530 },
  { name: "vol-t5-host",  feedIdHex: VOL_TEST_FEED_HEX.T5_MISMATCH_HOST, price: BigInt("18000000000"), exponent: -8, publishTimeOffsetSec: 1500 },
  { name: "vol-t6-stale", feedIdHex: VOL_TEST_FEED_HEX.T6_STALE, price: BigInt("18000000000"), exponent: -8, publishTimeOffsetSec: -400 },
  { name: "vol-t7-zero",  feedIdHex: VOL_TEST_FEED_HEX.T7_ZERO_SPOT, price: BigInt(0), exponent: -8, publishTimeOffsetSec: 1500, emaPrice: BigInt(1) },
  { name: "vol-t4-long-future", feedIdHex: VOL_TEST_FEED_HEX.T4_LONG_RING_WRAP, price: BigInt("9000000000000"), exponent: -8, publishTimeOffsetSec: 1500 },
  // Dedicated American-pricing feed ($100 spot, far-future publish_time so it
  // stays a valid proof-of-feed for create_market / initialize_vol_oracle even
  // when that suite runs late). Oracle warmth is controlled per-test via the
  // synth_warm_vol_oracle (test-synth-vol) instruction, not this fixture.
  { name: "amer-price-fresh", feedIdHex: AMER_PRICE_FEED_HEX, price: BigInt("10000000000"), exponent: -8, publishTimeOffsetSec: 1500 },
  { name: "amer-life-fresh", feedIdHex: AMER_LIFE_FEED_HEX, price: BigInt("10000000000"), exponent: -8, publishTimeOffsetSec: 1500 },
  { name: "amer-meta-fresh", feedIdHex: AMER_META_FEED_HEX, price: BigInt("10000000000"), exponent: -8, publishTimeOffsetSec: 1500 },
];

/// Write all fixtures to /tmp and return the (name → pubkey) map plus the
/// list of `--account <PUBKEY> <FILE>` argument pairs the launcher needs.
export function writeAllFixtures(outDir: string = "/tmp"): {
  pubkeys: Record<string, PublicKey>;
  launcherArgs: string[];
} {
  const now = Math.floor(Date.now() / 1000);
  // Persist baseTime so D2 tests in opta.ts can compute expiries that
  // match these fixtures' hardcoded publishTimeOffsetSec values. Sidecar
  // lives in the same outDir as the fixture JSONs themselves, so
  // getFixtureBaseTime() resolves to the same place via OPTA_FIXTURE_DIR.
  fs.writeFileSync(path.join(outDir, META_FILE), JSON.stringify({ baseTime: now }));
  const pubkeys: Record<string, PublicKey> = {};
  const launcherArgs: string[] = [];

  for (const spec of ALL_FIXTURES) {
    const fixture: PriceUpdateFixture = {
      feedIdHex: spec.feedIdHex,
      price: spec.price,
      conf: BigInt(1_000_000),
      exponent: spec.exponent,
      publishTime: BigInt(now + spec.publishTimeOffsetSec),
      prevPublishTime: BigInt(now + spec.publishTimeOffsetSec - 1),
      emaPrice: spec.emaPrice ?? spec.price,
      emaConf: spec.emaConf ?? BigInt(1_000_000),
    };
    const body = serializePriceUpdateV2(fixture);
    const pk = fixturePubkey(spec.name);
    const filePath = path.join(outDir, `pyth_${spec.name}.json`);
    writeFixtureJson(filePath, pk, body);

    pubkeys[spec.name] = pk;
    launcherArgs.push("--account", pk.toBase58(), filePath);
  }

  return { pubkeys, launcherArgs };
}
