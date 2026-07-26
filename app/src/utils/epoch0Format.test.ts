// Campaign UI pure-logic tests.
// run: npx ts-node --transpile-only app/src/utils/epoch0Format.test.ts
//
// The app has no test runner (adding vitest would mean an app/ reinstall on a
// live production frontend). The deal: all campaign logic lives in pure modules
// covered here; components stay thin and the screenshot gate covers render.
//
// ZERO-ROW DISCIPLINE — mirrors indexer/src/score/zeroRows.test.ts. Every
// formatter and state machine is asserted on empty / null / zero input, because
// the Phase 2b defects all hid behind fixtures that always had data.
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BOARDS,
  BOARD_LABEL,
  BOARD_METRIC,
  CHAIN_STEPS,
  EMPTY_COPY,
  UNAVAILABLE_LINE,
  chainStates,
  count,
  direction,
  freshness,
  isBoard,
  metricCell,
  multiplier,
  pct,
  points,
  surfaceState,
  truncateWallet,
  usd,
} from "./epoch0Format";
import { base58Encode, buildMessage, canonicalJson, writeErrorCopy } from "./epoch0Sign";

// ---------------------------------------------------------------------------
// Formatters — including the zero / null / negative cases
// ---------------------------------------------------------------------------

test("usd: micro-USDC formatting, incl. zero and negative", () => {
  assert.equal(usd(1_234_560_000), "$1,234.56");
  assert.equal(usd(0), "$0.00");
  assert.equal(usd(-86_411_717), "-$86.41");
  assert.equal(usd(null), "—");
  assert.equal(usd(undefined), "—");
  assert.equal(usd(NaN), "—");
});

test("pct: signed ROI, zero is not signed", () => {
  assert.equal(pct(4.8296), "+482.96%");
  assert.equal(pct(-0.1580590817), "-15.81%");
  assert.equal(pct(0), "0.00%");
  assert.equal(pct(null), "—");
});

test("direction: zero and null are flat, never coloured", () => {
  assert.equal(direction(1), "up");
  assert.equal(direction(-1), "down");
  assert.equal(direction(0), "flat");
  assert.equal(direction(null), "flat");
  assert.equal(direction(NaN), "flat");
});

test("count / points / multiplier handle zero and null", () => {
  assert.equal(count(0), "0");
  assert.equal(count(1234), "1,234");
  assert.equal(count(null), "—");
  assert.equal(points(0), "0");
  assert.equal(points(53.4345), "53.4");
  assert.equal(points(1247.6), "1,248");
  assert.equal(points(null), "—");
  assert.equal(multiplier(1), "1.0x");
  assert.equal(multiplier(1.4), "1.4x");
  assert.equal(multiplier(null), "1.0x", "absent multiplier reads as 1.0x, never blank");
});

test("truncateWallet keeps short strings intact", () => {
  assert.equal(truncateWallet("Hw8zoB12SuMbnJbMUQKq4PHHnYU68viSoQuveQ5FFDP3"), "Hw8zoB…FDP3");
  assert.equal(truncateWallet("short"), "short");
});

test("freshness: null and zero render an em dash, not 1970", () => {
  assert.equal(freshness(null), "—");
  assert.equal(freshness(0), "—");
  assert.equal(freshness(Date.parse("2026-07-26T14:23:00Z") / 1000), "14:23 UTC");
});

// ---------------------------------------------------------------------------
// Boards
// ---------------------------------------------------------------------------

test("every board has a label, a metric heading and empty copy", () => {
  assert.equal(BOARDS.length, 5);
  for (const b of BOARDS) {
    assert.ok(BOARD_LABEL[b], `${b} label`);
    assert.ok(BOARD_METRIC[b], `${b} metric`);
    assert.ok(EMPTY_COPY[b].line && EMPTY_COPY[b].action && EMPTY_COPY[b].to, `${b} empty copy`);
    // Brief §7: one line + one action. No exclamation, no hype.
    assert.equal(/[!]/.test(EMPTY_COPY[b].line), false, `${b} line has no exclamation`);
  }
  assert.equal(isBoard("profit"), true);
  assert.equal(isBoard("bogus"), false);
});

test("metricCell: profit is directional, the rest are flat", () => {
  assert.deepEqual(metricCell("profit", { roi: 0.05 }), { text: "+5.00%", dir: "up" });
  assert.deepEqual(metricCell("profit", { roi: -0.05 }), { text: "-5.00%", dir: "down" });
  assert.deepEqual(metricCell("volume", { volume_usdc: 42_806_597 }), { text: "$42.81", dir: "flat" });
  assert.deepEqual(metricCell("writer", { writer_premium: 0 }), { text: "$0.00", dir: "flat" });
  assert.deepEqual(metricCell("referrals", { referees: 3 }), { text: "3", dir: "flat" });
  assert.deepEqual(metricCell("social", { posts: 1 }), { text: "1", dir: "flat" });
});

test("metricCell on an EMPTY row degrades to em dash, never NaN or undefined", () => {
  for (const b of BOARDS) {
    const cell = metricCell(b, {});
    assert.equal(cell.text.includes("NaN"), false, `${b} no NaN`);
    assert.equal(cell.text.includes("undefined"), false, `${b} no undefined`);
    assert.equal(cell.text, "—", `${b} renders em dash`);
  }
});

// ---------------------------------------------------------------------------
// Chain — strict sequencing (indexer D12)
// ---------------------------------------------------------------------------

test("chainStates: exactly one 'next', everything after it locked", () => {
  const s0 = chainStates(0);
  assert.deepEqual(s0, ["next", "locked", "locked", "locked", "locked", "locked", "locked"]);

  const s3 = chainStates(3);
  assert.deepEqual(s3.slice(0, 3), ["done", "done", "done"]);
  assert.equal(s3[3], "next");
  assert.deepEqual(s3.slice(4), ["locked", "locked", "locked"]);

  assert.equal(s3.filter((x) => x === "next").length, 1, "strictly one reachable step");
});

test("chainStates: a complete chain has no 'next'", () => {
  const s7 = chainStates(7);
  assert.equal(s7.length, CHAIN_STEPS.length);
  assert.equal(s7.every((x) => x === "done"), true);
  assert.equal(s7.includes("next"), false);
});

test("chainStates: out-of-range input is clamped, never throws", () => {
  assert.deepEqual(chainStates(-5), chainStates(0));
  assert.deepEqual(chainStates(99), chainStates(7));
  assert.deepEqual(chainStates(NaN), chainStates(0));
  assert.equal(chainStates(2.7).filter((x) => x === "done").length, 2, "truncated, not rounded");
});

test("chain labels are terse and verb-first (brief §8)", () => {
  for (const s of CHAIN_STEPS) {
    assert.ok(s.label.length <= 20, `${s.id} label is terse`);
    // Word boundaries matter: an unanchored /XP/i matches "e-XP-iry".
    assert.equal(/XP|level up|prize|reward/i.test(s.label), false, `${s.id} avoids game language`);
  }
});

// ---------------------------------------------------------------------------
// Degradation — empty and unavailable must never be confused
// ---------------------------------------------------------------------------

test("surfaceState distinguishes loading / empty / unavailable / ready", () => {
  assert.equal(surfaceState({ loading: true, failed: false, rowCount: 0 }), "loading");
  assert.equal(surfaceState({ loading: true, failed: true, rowCount: 0 }), "loading", "loading wins");
  assert.equal(surfaceState({ loading: false, failed: true, rowCount: 0 }), "unavailable");
  assert.equal(surfaceState({ loading: false, failed: true, rowCount: 5 }), "unavailable", "stale rows do not mask a failure");
  assert.equal(surfaceState({ loading: false, failed: false, rowCount: 0 }), "empty");
  assert.equal(surfaceState({ loading: false, failed: false, rowCount: 1 }), "ready");
});

test("an unreachable API reads as unavailable, not as an empty board", () => {
  assert.notEqual(surfaceState({ loading: false, failed: true, rowCount: 0 }), "empty");
  assert.equal(UNAVAILABLE_LINE, "Points unavailable.");
});

// ---------------------------------------------------------------------------
// Signing
// ---------------------------------------------------------------------------

test("canonicalJson is key-order stable and matches the server contract", () => {
  assert.equal(canonicalJson({ b: 1, a: 2 }), canonicalJson({ a: 2, b: 1 }));
  assert.equal(canonicalJson({}), "{}");
  assert.equal(canonicalJson({ code: "ABC" }), '{"code":"ABC"}');
  assert.equal(canonicalJson([2, 1]), "[2,1]", "arrays keep order");
});

test("base58Encode matches known vectors and preserves leading zeros", () => {
  assert.equal(base58Encode(new Uint8Array([])), "");
  assert.equal(base58Encode(new Uint8Array([0])), "1");
  assert.equal(base58Encode(new Uint8Array([0, 0, 1])), "112");
  // "hello world" -> StV1DL6CwTryKyV (canonical Bitcoin-alphabet vector)
  assert.equal(base58Encode(new TextEncoder().encode("hello world")), "StV1DL6CwTryKyV");
  // A 32-byte key encodes to the 43-44 char range Solana pubkeys occupy.
  const len = base58Encode(new Uint8Array(32).fill(255)).length;
  assert.ok(len >= 43 && len <= 44, `32 bytes -> ${len} chars`);
});

test("buildMessage matches the indexer's canonical format exactly", () => {
  assert.equal(
    buildMessage("referral.bind", "WALLET", "HASH", "NONCE", 1785000000),
    "opta-epoch0|referral.bind|WALLET|HASH|NONCE|1785000000",
  );
});

test("writeErrorCopy is terse, blame-free, and covers every server reason", () => {
  const reasons = [
    "unknown_code", "self_referral", "already_bound", "already_active", "internal_referrer",
    "duplicate_tweet", "handle_mismatch", "handle_taken", "daily_cap", "too_old",
    "no_mention", "not_found", "verification_unavailable", "cooldown",
    "expired", "bad_signature", "replayed",
  ];
  for (const r of reasons) {
    const copy = writeErrorCopy(r, 400);
    assert.ok(copy.length > 0 && copy.length < 60, `${r} is terse`);
    assert.equal(/!/.test(copy), false, `${r} has no exclamation`);
    assert.equal(/XP|level up|prize/i.test(copy), false, `${r} avoids game language`);
  }
  assert.equal(writeErrorCopy(undefined), "Points unavailable.");
});
