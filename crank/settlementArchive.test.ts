// ============================================================================
// crank/settlementArchive.test.ts — unit tests for the SB settlement archiver
// ============================================================================
//
// Vanilla TS + node:assert, no framework, no network (mirrors
// crank/ed25519SelfPack.test.ts). Run via:
//   npx tsx settlementArchive.test.ts
//   (or: ts-node --transpile-only -r tsconfig-paths/register settlementArchive.test.ts)
//
// Covers:
//   (a) archiveSbSettlement NEVER throws even when BOTH sinks fail (injected
//       failing appendFile + failing fetch) → returns {jsonlOk:false,upstashOk:false}.
//   (a2) KV-absent path: JSONL ok, Upstash skipped silently → upstashOk === true.
//   (b) i128-LE message parse → correct ÷1e12 USDC-6 spot.
//   (c) buildSbSettlementRecord shape has every required key + correct key string.
// ============================================================================

import assert from "node:assert/strict";

import {
  archiveSbSettlement,
  buildSbSettlementRecord,
  parseSpotUsdcFromMessage,
  readI128LE,
  SB_MSG_FEED_VALUE_OFFSET,
  type SbSettlementRecord,
} from "./settlementArchive";
import type { CapturedBuild } from "./switchboardQuotePost";

let passed = 0;
function ok(name: string): void {
  passed += 1;
  // eslint-disable-next-line no-console
  console.log(`  PASS  ${name}`);
}

// ---- Fixtures --------------------------------------------------------------

/** Build a synthetic 81-byte signed-quote message (header 32 || feedinfo 49)
 *  with feed_value (i128 LE, scaled 1e18) written at absolute offset 64. */
function makeMessage(feedValueScaled1e18: bigint): Uint8Array {
  const msg = Buffer.alloc(81); // 32 header + 49 feedinfo
  // Write signed i128 LE at offset 64.
  let v = feedValueScaled1e18 < 0n ? (1n << 128n) + feedValueScaled1e18 : feedValueScaled1e18;
  for (let i = 0; i < 16; i++) {
    msg[SB_MSG_FEED_VALUE_OFFSET + i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return msg;
}

function makeCaptured(msg: Uint8Array): CapturedBuild {
  return {
    signatures: [
      { oracleIdx: 2, signature: new Uint8Array(64).fill(1), pubkey: new Uint8Array(32).fill(2), message: msg },
      { oracleIdx: 8, signature: new Uint8Array(64).fill(3), pubkey: new Uint8Array(32).fill(4), message: msg },
    ],
    instructionIndex: 1,
    recentSlot: 471620622,
    version: 1,
  };
}

function makeRecord(): SbSettlementRecord {
  const msg = makeMessage(4_053_900_000_000_000_000_000n); // 4053.9 × 1e18
  return buildSbSettlementRecord({
    asset: "XAU",
    expiry: 1893456000,
    edIxData: Buffer.from("deadbeef", "hex"),
    captured: makeCaptured(msg),
    feedHashHex: "6c3c5cc7abcdef00",
    settlementPrice: 4_053_900_000,
    recentSlot: 471620622,
    settleTxSig: "5xTESTsigTESTsigTESTsig",
    queuePubkey: "QueuePubkey1111111111111111111111111111111",
    programId: "Program11111111111111111111111111111111111",
    marketPubkey: "Market111111111111111111111111111111111111",
    settlementRecordPubkey: "Record111111111111111111111111111111111111",
    capturedAtIso: "2026-07-12T00:00:00.000Z",
  });
}

// ---- (b) i128-LE parse -----------------------------------------------------

function testSpotParse(): void {
  // Positive gold: 4053.9 × 1e18 → ÷1e12 → 4_053_900_000 USDC-6.
  const goldMsg = makeMessage(4_053_900_000_000_000_000_000n);
  assert.equal(parseSpotUsdcFromMessage(goldMsg), 4_053_900_000);

  // readI128LE round-trips a large positive value.
  assert.equal(readI128LE(goldMsg, SB_MSG_FEED_VALUE_OFFSET), 4_053_900_000_000_000_000_000n);

  // $1.00 → 1e18 → 1_000_000 USDC-6.
  assert.equal(parseSpotUsdcFromMessage(makeMessage(1_000_000_000_000_000_000n)), 1_000_000);

  // Sign handling: a negative i128 decodes negative (defensive; prices are +).
  const negMsg = makeMessage(-5_000_000_000_000_000_000n);
  assert.equal(readI128LE(negMsg, SB_MSG_FEED_VALUE_OFFSET), -5_000_000_000_000_000_000n);
  assert.equal(parseSpotUsdcFromMessage(negMsg), -5_000_000);

  ok("(b) i128-LE message parse → correct ÷1e12 USDC-6 spot (pos/unit/neg)");
}

// ---- (c) record shape ------------------------------------------------------

function testRecordShape(): void {
  const rec = makeRecord();
  const requiredKeys = [
    "key", "assetName", "expiry", "edIxData", "signatures", "feedHash",
    "spotFromMsg", "settlementPrice", "recentSlot", "settleTxSig",
    "queuePubkey", "programId", "marketPubkey", "settlementRecordPubkey",
    "capturedAtIso",
  ];
  for (const k of requiredKeys) {
    assert.ok(k in rec, `record missing key: ${k}`);
    assert.notEqual((rec as unknown as Record<string, unknown>)[k], undefined, `record key undefined: ${k}`);
  }
  assert.equal(rec.key, "sb-settle:XAU:1893456000");
  assert.equal(rec.spotFromMsg, 4_053_900_000);
  assert.equal(rec.spotFromMsg, rec.settlementPrice, "spotFromMsg must match settlementPrice");
  assert.equal(rec.signatures.length, 2);
  // Triples are broken out + base64-encoded.
  assert.equal(rec.signatures[0].oracleIdx, 2);
  assert.equal(rec.signatures[0].signature, Buffer.alloc(64, 1).toString("base64"));
  assert.equal(rec.signatures[0].pubkey, Buffer.alloc(32, 2).toString("base64"));
  assert.equal(rec.edIxData, Buffer.from("deadbeef", "hex").toString("base64"));
  // Round-trips through JSON (the helper serialises it).
  const round = JSON.parse(JSON.stringify(rec));
  assert.equal(round.key, rec.key);
  ok("(c) buildSbSettlementRecord shape has all required keys + correct key string");
}

// ---- (a) non-throwing guarantee -------------------------------------------

async function testNonThrowingBothFail(): Promise<void> {
  const rec = makeRecord();
  const failingAppend = async (): Promise<void> => {
    throw new Error("disk exploded");
  };
  const failingFetch = async (): Promise<{ ok: boolean; status: number }> => {
    throw new Error("network exploded");
  };
  let warns = 0;
  // Must NOT throw even with both sinks failing AND KV configured.
  const res = await archiveSbSettlement(rec, {
    jsonlPath: "/nonexistent/should-not-be-hit.jsonl",
    kvUrl: "https://kv.example.com",
    kvToken: "tok",
    appendFileFn: failingAppend,
    fetchFn: failingFetch,
    log: () => { warns += 1; },
  });
  assert.deepEqual(res, { jsonlOk: false, upstashOk: false });
  assert.ok(warns >= 2, "both sink failures should have warned");
  ok("(a) archiveSbSettlement never throws when JSONL + Upstash both throw");
}

async function testKvAbsentSkipsSilently(): Promise<void> {
  const rec = makeRecord();
  let appended = "";
  const goodAppend = async (_p: string, d: string): Promise<void> => { appended += d; };
  // No kvUrl/kvToken and env unset → Upstash skipped silently, upstashOk === true.
  const prevUrl = process.env.KV_REST_API_URL;
  const prevTok = process.env.KV_REST_API_TOKEN;
  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  try {
    const res = await archiveSbSettlement(rec, {
      jsonlPath: "/tmp/ignored.jsonl",
      appendFileFn: goodAppend,
      fetchFn: async () => { throw new Error("must not be called"); },
    });
    assert.deepEqual(res, { jsonlOk: true, upstashOk: true });
    assert.ok(appended.endsWith("\n"), "JSONL line must end with newline");
    assert.equal(JSON.parse(appended.trim()).key, rec.key);
  } finally {
    if (prevUrl !== undefined) process.env.KV_REST_API_URL = prevUrl;
    if (prevTok !== undefined) process.env.KV_REST_API_TOKEN = prevTok;
  }
  ok("(a2) KV absent → JSONL ok, Upstash skipped silently (upstashOk===true)");
}

async function testUpstashOkPath(): Promise<void> {
  const rec = makeRecord();
  let capturedUrl = "";
  let capturedBody = "";
  const res = await archiveSbSettlement(rec, {
    jsonlPath: "/tmp/ignored.jsonl",
    kvUrl: "https://kv.example.com/",
    kvToken: "tok",
    appendFileFn: async () => { /* ok */ },
    fetchFn: async (url: string, init: Record<string, unknown>) => {
      capturedUrl = url;
      capturedBody = init.body as string;
      return { ok: true, status: 200 };
    },
  });
  assert.deepEqual(res, { jsonlOk: true, upstashOk: true });
  assert.equal(capturedUrl, `https://kv.example.com/set/${encodeURIComponent(rec.key)}`);
  assert.equal(JSON.parse(capturedBody).key, rec.key);
  ok("(a3) Upstash SET success path: correct URL + JSON body, both sinks ok");
}

// ---- Runner ----------------------------------------------------------------

async function main(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log("settlementArchive.test.ts");
  testSpotParse();
  testRecordShape();
  await testNonThrowingBothFail();
  await testKvAbsentSkipsSilently();
  await testUpstashOkPath();
  // eslint-disable-next-line no-console
  console.log(`\nALL PASS — ${passed} assertions groups passed`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("TEST FAILURE:", err);
  process.exit(1);
});
