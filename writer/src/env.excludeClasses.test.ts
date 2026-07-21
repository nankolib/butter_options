// Regression pin for the EXCLUDE_CLASSES parse trap.
//
// The bug: `"".split(",").map(Number).filter(Number.isFinite)` yields [0], not
// [], because Number("") === 0 and 0 is finite. OPTA_WRITER_EXCLUDE_CLASSES is
// the writer's denylist, and asset_class 0 is crypto/memes — so CLEARING the
// denylist (empty value, or removing the line entirely) silently deny-listed the
// entire live crypto board. Found 2026-07-21 while lifting the equity classes;
// the sibling `assetsExclude` never had the bug because it uses .filter(Boolean).
//   run: npx ts-node --transpile-only src/env.excludeClasses.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseClassList } from "./env";

test("EMPTY string => [] (never [0]) — the exact regression", () => {
  assert.deepEqual(parseClassList(""), []);
});

test("UNSET (undefined / null) => [] (never [0])", () => {
  assert.deepEqual(parseClassList(undefined), []);
  assert.deepEqual(parseClassList(null), []);
});

test("whitespace-only and comma-only => []", () => {
  assert.deepEqual(parseClassList("   "), []);
  assert.deepEqual(parseClassList(","), []);
  assert.deepEqual(parseClassList(" , , "), []);
});

test("the pre-fix expression really did produce [0] (documents what we fixed)", () => {
  const buggy = (v: string) => v.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
  assert.deepEqual(buggy(""), [0]);          // <- the trap
  assert.deepEqual(parseClassList(""), []);  // <- fixed
});

test("normal values still parse", () => {
  assert.deepEqual(parseClassList("2,4"), [2, 4]);
  assert.deepEqual(parseClassList("2, 4"), [2, 4]);
  assert.deepEqual(parseClassList("0"), [0]);      // explicit 0 IS a real request
  assert.deepEqual(parseClassList("99"), [99]);    // the VPS sentinel: excludes nothing real
});

test("garbage segments are dropped, valid ones kept", () => {
  assert.deepEqual(parseClassList("2,abc,4"), [2, 4]);
  assert.deepEqual(parseClassList("abc"), []);
});

test("explicit 0 is preserved — the fix must not over-filter", () => {
  assert.deepEqual(parseClassList("0,2"), [0, 2]);
});
