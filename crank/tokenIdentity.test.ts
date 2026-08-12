// ============================================================================
// crank/tokenIdentity.test.ts — SLICE 2A identity resolver unit tests
// ============================================================================
//
//   run: npx ts-node --transpile-only -r tsconfig-paths/register tokenIdentity.test.ts
//
// Everything here drives real production code with `fetch` stubbed, so no test
// touches the network. What is asserted is the behaviour the FE depends on:
// an address query never resolves to a DIFFERENT token, an icon can fail
// without taking the identity down, enrichment can fail without taking the
// lookup down, and "we could not check" never masquerades as "does not exist".
// ============================================================================

import assert from "node:assert/strict";

import {
  MAX_ICON_BYTES,
  _cacheSize,
  _clearIdentityCache,
  enrichWithTokensXyz,
  fetchIconDataUri,
  cacheKeyFor,
  mapJupiterRow,
  resolveIdentity,
  type TokenIdentity,
} from "./tokenIdentity";

// ---- Tiny runner -----------------------------------------------------------
type Test = { name: string; fn: () => void | Promise<void> };
const tests: Test[] = [];
function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

// ---- fetch stub ------------------------------------------------------------

const realFetch = globalThis.fetch;
type Route = (url: string) => { status?: number; json?: unknown; body?: Buffer; type?: string } | "throw";
let route: Route = () => ({ status: 404 });
const calls: string[] = [];

function installFetch(): void {
  (globalThis as any).fetch = async (input: any, _init?: any) => {
    const url = String(input);
    calls.push(url);
    const r = route(url);
    if (r === "throw") throw new Error("network down");
    const status = r.status ?? 200;
    const headers = new Map<string, string>();
    if (r.body) {
      headers.set("content-type", r.type ?? "image/png");
      headers.set("content-length", String(r.body.length));
    }
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
      json: async () => r.json,
      arrayBuffer: async () => (r.body ? r.body.buffer.slice(r.body.byteOffset, r.body.byteOffset + r.body.length) : new ArrayBuffer(0)),
    };
  };
}
function restoreFetch(): void {
  (globalThis as any).fetch = realFetch;
}

const MINT = "BPxxfRCXkUVhig4HS1Lh7kZqV6SPJhzfEk4x6fVBjPCy";
const OTHER = "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump";

const jupRow = (over: Record<string, unknown> = {}) => ({
  id: MINT,
  name: "Backpack",
  symbol: "BP",
  icon: "https://example.test/bp.png",
  decimals: 9,
  tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  isVerified: true,
  tags: ["verified", "defi"],
  ...over,
});

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

function reset(): void {
  _clearIdentityCache();
  calls.length = 0;
}

// ============================================================================
// Address queries must be EXACT — the core anti-mistake property.
// ============================================================================

test("an address query resolves the token with that exact mint", async () => {
  reset();
  route = (u) => (u.includes("/search") ? { json: [jupRow()] } : { body: PNG });
  const r = await resolveIdentity(MINT);
  assert.equal(r.kind, "found");
  const id = (r as any).identity as TokenIdentity;
  assert.equal(id.mint, MINT);
  assert.equal(id.symbol, "BP");
  assert.equal(id.verified, true);
});

test("an address query does NOT accept a fuzzy near-match with a different mint", async () => {
  // Jupiter's search is fuzzy. Accepting row[0] blindly would let a mistyped
  // address resolve to some OTHER token, which the user would then create a
  // market for. The mint asked for must equal the mint returned.
  reset();
  route = (u) => (u.includes("/search") ? { json: [jupRow({ id: OTHER, symbol: "ANSEM" })] } : { body: PNG });
  const r = await resolveIdentity(MINT);
  assert.equal(r.kind, "not-found", "a non-matching id must be a MISS, not a silent substitution");
});

test("a free-text query takes the best match (row 0)", async () => {
  reset();
  route = (u) => (u.includes("/search") ? { json: [jupRow({ id: OTHER, symbol: "ANSEM" }), jupRow()] } : { body: PNG });
  const r = await resolveIdentity("ansem");
  assert.equal(r.kind, "found");
  assert.equal((r as any).identity.symbol, "ANSEM");
});

test("an empty catalog response is not-found, not an error", async () => {
  reset();
  route = () => ({ json: [] });
  assert.equal((await resolveIdentity(MINT)).kind, "not-found");
});

// ============================================================================
// "Could not check" is NOT "does not exist" — the honesty split.
// ============================================================================

test("an upstream throw is upstream-error, never not-found", async () => {
  reset();
  route = () => "throw";
  const r = await resolveIdentity(MINT);
  assert.equal(r.kind, "upstream-error", "a dead catalog must not report the token as unknown");
});

test("an upstream non-2xx is upstream-error", async () => {
  reset();
  route = () => ({ status: 503 });
  assert.equal((await resolveIdentity(MINT)).kind, "upstream-error");
});

test("an upstream error is NEVER cached (one bad minute must not become ten)", async () => {
  reset();
  route = () => "throw";
  await resolveIdentity(MINT);
  assert.equal(_cacheSize(), 0, "error results must not enter the cache");
  // ...and the very next call retries rather than replaying the failure.
  route = (u) => (u.includes("/search") ? { json: [jupRow()] } : { body: PNG });
  assert.equal((await resolveIdentity(MINT)).kind, "found");
});

test("a not-found IS cached (it is a real answer)", async () => {
  reset();
  route = () => ({ json: [] });
  await resolveIdentity(MINT);
  assert.equal(_cacheSize(), 1);
  const before = calls.length;
  await resolveIdentity(MINT);
  assert.equal(calls.length, before, "second miss served from cache, no upstream call");
});

test("a hit is cached — repeat lookups cost nothing", async () => {
  reset();
  route = (u) => (u.includes("/search") ? { json: [jupRow()] } : { body: PNG });
  await resolveIdentity(MINT);
  const before = calls.length;
  const again = await resolveIdentity(MINT);
  assert.equal(again.kind, "found");
  assert.equal(calls.length, before, "no upstream call on a cache hit");
});

// ============================================================================
// Icons are decoration — they may fail, but never take the identity with them.
// ============================================================================

test("a failing icon still yields a full identity (icon null)", async () => {
  reset();
  route = (u) => (u.includes("/search") ? { json: [jupRow()] } : "throw");
  const r = await resolveIdentity(MINT);
  assert.equal(r.kind, "found");
  assert.equal((r as any).identity.iconDataUri, null);
  assert.equal((r as any).identity.symbol, "BP", "identity survives an icon failure");
});

test("a good icon is inlined as a data: URI, never a remote URL", async () => {
  reset();
  route = (u) => (u.includes("/search") ? { json: [jupRow()] } : { body: PNG, type: "image/png" });
  const id = (await resolveIdentity(MINT)) as any;
  const uri: string = id.identity.iconDataUri;
  assert.ok(uri.startsWith("data:image/png;base64,"), `expected data: URI, got ${String(uri).slice(0, 40)}`);
  assert.ok(!uri.startsWith("http"), "a remote URL would be blocked by our img-src and render broken");
});

test("a non-image content-type is refused (an HTML error page is not a logo)", async () => {
  assert.equal(await fetchIconDataUri("https://x.test/a"), null); // route default 404
  route = () => ({ body: Buffer.from("<html>login</html>"), type: "text/html" });
  assert.equal(await fetchIconDataUri("https://x.test/a"), null);
});

test("an oversize icon is refused", async () => {
  route = () => ({ body: Buffer.alloc(MAX_ICON_BYTES + 1, 7), type: "image/png" });
  assert.equal(await fetchIconDataUri("https://x.test/big.png"), null);
});

test("a non-https icon URL is refused without any fetch (SSRF guard)", async () => {
  const before = calls.length;
  assert.equal(await fetchIconDataUri("http://169.254.169.254/latest/meta-data"), null);
  assert.equal(await fetchIconDataUri(null), null);
  assert.equal(await fetchIconDataUri(undefined), null);
  assert.equal(calls.length, before, "must not even attempt the request");
});

// ============================================================================
// tokens.xyz enrichment — optional, and never load-bearing.
// ============================================================================

test("with NO api key, enrichment is skipped entirely and identity is unchanged", async () => {
  const before = calls.length;
  const base = mapJupiterRow(jupRow(), null);
  const out = await enrichWithTokensXyz(base, undefined);
  assert.deepEqual(out, base);
  assert.equal(calls.length, before, "no key → no upstream call");
  assert.equal(out.source, "jupiter");
});

test("with a key, a tokens.xyz verdict overrides `verified`", async () => {
  route = () => ({ json: { verified: false } });
  const base = mapJupiterRow(jupRow({ isVerified: true }), null);
  const out = await enrichWithTokensXyz(base, "k");
  assert.equal(out.verified, false, "the canonical directory wins when we have its answer");
  assert.equal(out.source, "jupiter+tokensxyz");
});

test("a FAILING tokens.xyz call leaves the Jupiter answer standing", async () => {
  route = () => "throw";
  const base = mapJupiterRow(jupRow({ isVerified: true }), null);
  const out = await enrichWithTokensXyz(base, "k");
  assert.equal(out.verified, true, "enrichment must never break the primary path");
  assert.equal(out.source, "jupiter");
});

test("a 401 (bad/expired key) also leaves the Jupiter answer standing", async () => {
  route = () => ({ status: 401 });
  const base = mapJupiterRow(jupRow({ isVerified: true }), null);
  assert.equal((await enrichWithTokensXyz(base, "bad")).verified, true);
});

test("a tokens.xyz response with no boolean verdict is ignored", async () => {
  route = () => ({ json: { something: "else" } });
  const base = mapJupiterRow(jupRow({ isVerified: true }), null);
  const out = await enrichWithTokensXyz(base, "k");
  assert.equal(out.verified, true);
  assert.equal(out.source, "jupiter", "no verdict → do not claim enrichment");
});

// ============================================================================
// CACHE KEYS — base58 is case-SENSITIVE. (SLICE 2B, item 5.)
//
// Found during 2A's own deploy verification: the key was `q.toLowerCase()` for
// everything, so "So111…" and "so111…" shared one entry and a case-wrong address
// could be served the identity of the correct one — an identity for an address
// the user never typed. Create was never at risk (the feed always comes from the
// anti-spoofed catalog row), so this was a display lie, not a funds bug.
// ============================================================================

test("RED: two addresses differing only in case do NOT share a cache entry", async () => {
  // FIXTURE NOTE, learned the hard way: BP's address contains "L", and lowercase
  // "l" is EXCLUDED from the base58 alphabet — so BP.toLowerCase() is not an
  // address at all and correctly falls to the fuzzy NAME branch. OTHER has no
  // L/I/O, so its lowercase IS still valid base58, which is exactly the
  // collision this fix is about.
  reset();
  route = (u) =>
    u.includes("/search") ? { json: [jupRow({ id: OTHER, symbol: "ANSEM" })] } : { body: PNG };
  const r1 = await resolveIdentity(OTHER);
  assert.equal(r1.kind, "found");
  assert.equal((r1 as any).identity.mint, OTHER);

  // Same characters, wrong case → a DIFFERENT address. Jupiter's exact-id check
  // rejects it, so the honest answer is a miss — never the other token's identity.
  const r2 = await resolveIdentity(OTHER.toLowerCase());
  assert.equal(
    r2.kind,
    "not-found",
    "a case-wrong address must NOT inherit the correct address's identity",
  );
});

test("cacheKeyFor keeps addresses exact and folds names", () => {
  assert.notEqual(
    cacheKeyFor(MINT),
    cacheKeyFor(MINT.toLowerCase()),
    "base58 is case-sensitive — these are different tokens",
  );
  assert.equal(cacheKeyFor("Backpack"), cacheKeyFor("backpack"), "names are case-insensitive");
  assert.equal(cacheKeyFor("  backpack  "), cacheKeyFor("backpack"), "trimmed");
  // Namespaced so a name can never collide with an address.
  assert.ok(cacheKeyFor(MINT).startsWith("a:"));
  assert.ok(cacheKeyFor("backpack").startsWith("n:"));
});

test("a name lookup warms the mint key in ADDRESS form (exact), not folded", async () => {
  reset();
  route = (u) => (u.includes("/search") ? { json: [jupRow()] } : { body: PNG });
  await resolveIdentity("backpack"); // resolves to BP, warms the mint key
  const before = calls.length;
  const byMint = await resolveIdentity(MINT);
  assert.equal(byMint.kind, "found");
  assert.equal(calls.length, before, "the exact-case mint lookup is served from cache");
});

// ============================================================================
// Row mapping.
// ============================================================================

test("verified falls back to the tag only when isVerified is absent", () => {
  const withFlag = mapJupiterRow(jupRow({ isVerified: false, tags: ["verified"] }), null);
  assert.equal(withFlag.verified, false, "explicit boolean wins over the tag");
  const noFlag = mapJupiterRow({ id: MINT, tags: ["verified"] }, null);
  assert.equal(noFlag.verified, true, "absent boolean → degrade to the tag");
  const neither = mapJupiterRow({ id: MINT }, null);
  assert.equal(neither.verified, false, "neither → not verified");
});

test("missing optional fields degrade to null rather than throwing", () => {
  const id = mapJupiterRow({ id: MINT }, null);
  assert.equal(id.decimals, null);
  assert.equal(id.tokenProgram, null);
  assert.equal(id.symbol, "");
  assert.deepEqual(id.tags, []);
});

test("non-string tags are filtered out", () => {
  const id = mapJupiterRow(jupRow({ tags: ["verified", 42, null, "defi"] }), null);
  assert.deepEqual(id.tags, ["verified", "defi"]);
});

// ---- Runner ----------------------------------------------------------------

async function main(): Promise<void> {
  installFetch();
  let passed = 0;
  let failed = 0;
  for (const t of tests) {
    reset();
    route = () => ({ status: 404 });
    try {
      await t.fn();
      console.log(`✓ ${t.name}`);
      passed += 1;
    } catch (err) {
      console.error(`✗ ${t.name}`);
      console.error(`  ${err}`);
      failed += 1;
    }
  }
  restoreFetch();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  restoreFetch();
  console.error("test runner crashed:", err);
  process.exit(1);
});
