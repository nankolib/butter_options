// =============================================================================
// tokenIdentity.test.ts — SLICE 2A: the bounded-resolution contract
// =============================================================================
//   run: node app/scripts/run-identity-tests.mjs
//
// The property that matters most here is the DEADLINE. The bug this replaces
// was not a logic error — the old resolver returned the RIGHT answer for both
// reported "hangs" (BP is Backpack, 9cRCn9…pump is ANSEM). It simply had no
// timeout, on a transport measured at 12,292 ms for a single read. So the tests
// that earn their keep are: it always settles, and it never turns "we could not
// check" into "this does not exist".
// =============================================================================

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  looksLikeMint,
  resolveTokenIdentity,
  type ChainFallback,
  type IdentityOutcome,
} from "./tokenIdentity";

const MINT = "BPxxfRCXkUVhig4HS1Lh7kZqV6SPJhzfEk4x6fVBjPCy";
const ENDPOINT = "https://sb-create.test";
const fakeMint = { toBase58: () => MINT } as never;

const realFetch = globalThis.fetch;
function stubFetch(fn: (url: string) => unknown): void {
  (globalThis as { fetch: unknown }).fetch = async (u: unknown) => fn(String(u));
}
function restore(): void {
  (globalThis as { fetch: unknown }).fetch = realFetch;
}
const jsonResp = (status: number, body: unknown) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
});

const IDENT = {
  mint: MINT,
  symbol: "BP",
  name: "Backpack",
  verified: true,
  tags: ["verified"],
  decimals: 9,
  tokenProgram: "Tokenkeg",
  iconDataUri: "data:image/png;base64,AAAA",
};

const neverChain: ChainFallback = async () => {
  throw new Error("chain fallback must not be called here");
};
const unknownChain: ChainFallback = async () => ({ kind: "unknown" });

test("looksLikeMint separates an address from a name", () => {
  assert.equal(looksLikeMint(MINT), true);
  assert.equal(looksLikeMint(`  ${MINT} `), true);
  assert.equal(looksLikeMint("backpack"), false);
  assert.equal(looksLikeMint(""), false);
});

test("a catalog hit returns identity and never touches the chain", async () => {
  stubFetch(() => jsonResp(200, IDENT));
  const out = await resolveTokenIdentity(MINT, {
    endpoint: ENDPOINT,
    mint: fakeMint,
    chainFallback: neverChain,
  });
  restore();
  assert.equal(out.kind, "found");
  const id = (out as Extract<IdentityOutcome, { kind: "found" }>).identity;
  assert.equal(id.symbol, "BP");
  assert.equal(id.origin, "catalog");
  assert.equal(id.verified, true);
});

test("a catalog MISS on an address falls through to the chain", async () => {
  stubFetch(() => jsonResp(404, { error: "not found" }));
  let called = false;
  const out = await resolveTokenIdentity(MINT, {
    endpoint: ENDPOINT,
    mint: fakeMint,
    chainFallback: async () => {
      called = true;
      return {
        kind: "found",
        identity: { ...IDENT, verified: false, iconDataUri: null, origin: "chain" },
      } as IdentityOutcome;
    },
  });
  restore();
  assert.equal(called, true, "devnet-native mints live only on chain — the fallback must run");
  const id = (out as Extract<IdentityOutcome, { kind: "found" }>).identity;
  assert.equal(id.origin, "chain");
  assert.equal(id.verified, false, "on-chain metadata never inherits a badge");
});

test("a DOWN catalog on an address also falls through to the chain", async () => {
  stubFetch(() => jsonResp(502, {}));
  let called = false;
  const out = await resolveTokenIdentity(MINT, {
    endpoint: ENDPOINT,
    mint: fakeMint,
    chainFallback: async () => {
      called = true;
      return { kind: "unknown" };
    },
  });
  restore();
  assert.equal(called, true);
  assert.equal(out.kind, "unknown");
});

test("a NAME query with a catalog miss is unknown — nothing to look up on chain", async () => {
  stubFetch(() => jsonResp(404, {}));
  const out = await resolveTokenIdentity("backpack", {
    endpoint: ENDPOINT,
    mint: null,
    chainFallback: neverChain,
  });
  restore();
  assert.equal(out.kind, "unknown");
});

test("a NAME query with a DOWN catalog is UNAVAILABLE, never unknown", async () => {
  // The lie this prevents: telling a user no such token exists when in fact we
  // never managed to ask.
  stubFetch(() => {
    throw new Error("network down");
  });
  const out = await resolveTokenIdentity("backpack", {
    endpoint: ENDPOINT,
    mint: null,
    chainFallback: neverChain,
  });
  restore();
  assert.equal(out.kind, "unavailable");
  assert.equal((out as Extract<IdentityOutcome, { kind: "unavailable" }>).reason, "transport");
});

test("no endpoint configured still resolves via the chain", async () => {
  stubFetch(() => {
    throw new Error("must not fetch");
  });
  const out = await resolveTokenIdentity(MINT, {
    endpoint: null,
    mint: fakeMint,
    chainFallback: async () =>
      ({ kind: "found", identity: { ...IDENT, origin: "chain" } }) as IdentityOutcome,
  });
  restore();
  assert.equal(out.kind, "found");
});

// ---- THE DEADLINE ----------------------------------------------------------

test("RED: a catalog that never answers hits the deadline, it does not hang", async () => {
  stubFetch(() => new Promise(() => {})); // never settles — the old failure mode
  const t0 = Date.now();
  const out = await resolveTokenIdentity(MINT, {
    endpoint: ENDPOINT,
    mint: fakeMint,
    chainFallback: neverChain,
    timeoutMs: 120,
  });
  const ms = Date.now() - t0;
  restore();
  assert.equal(out.kind, "unavailable");
  assert.equal((out as Extract<IdentityOutcome, { kind: "unavailable" }>).reason, "timeout");
  assert.ok(ms < 1500, `must settle at the deadline, took ${ms}ms`);
});

test("RED: a chain fallback that never answers ALSO hits the deadline", async () => {
  // The exact shape of the original bug: getAccountInfo with no timeout against
  // a 12-second RPC. It must bound the UI even though the read itself cannot be
  // cancelled.
  stubFetch(() => jsonResp(404, {}));
  const t0 = Date.now();
  const out = await resolveTokenIdentity(MINT, {
    endpoint: ENDPOINT,
    mint: fakeMint,
    chainFallback: () => new Promise(() => {}),
    timeoutMs: 120,
  });
  const ms = Date.now() - t0;
  restore();
  assert.equal((out as Extract<IdentityOutcome, { kind: "unavailable" }>).reason, "timeout");
  assert.ok(ms < 1500, `must settle at the deadline, took ${ms}ms`);
});

test("a chain fallback that THROWS is unavailable, not a crash", async () => {
  stubFetch(() => jsonResp(404, {}));
  const out = await resolveTokenIdentity(MINT, {
    endpoint: ENDPOINT,
    mint: fakeMint,
    chainFallback: async () => {
      throw new Error("rpc exploded");
    },
  });
  restore();
  assert.equal(out.kind, "unavailable");
});

// ---- Response hardening ----------------------------------------------------

test("a malformed catalog body is treated as DOWN, not as an identity", async () => {
  stubFetch(() => jsonResp(200, { nonsense: true }));
  const out = await resolveTokenIdentity(MINT, {
    endpoint: ENDPOINT,
    mint: fakeMint,
    chainFallback: unknownChain,
  });
  restore();
  assert.equal(out.kind, "unknown", "fell through to the chain rather than rendering junk");
});

test("a REMOTE icon URL is refused — only data: URIs survive", async () => {
  // A remote URL would be blocked by our img-src and render as a broken image,
  // which reads as a problem with the token rather than with our CSP.
  stubFetch(() => jsonResp(200, { ...IDENT, iconDataUri: "https://evil.test/x.png" }));
  const out = await resolveTokenIdentity(MINT, {
    endpoint: ENDPOINT,
    mint: fakeMint,
    chainFallback: neverChain,
  });
  restore();
  assert.equal((out as Extract<IdentityOutcome, { kind: "found" }>).identity.iconDataUri, null);
});

test("verified is strictly boolean-true, never truthy-coerced", async () => {
  stubFetch(() => jsonResp(200, { ...IDENT, verified: "yes" }));
  const out = await resolveTokenIdentity(MINT, {
    endpoint: ENDPOINT,
    mint: fakeMint,
    chainFallback: neverChain,
  });
  restore();
  assert.equal((out as Extract<IdentityOutcome, { kind: "found" }>).identity.verified, false);
});

test("an address query uses the mint param, a name query uses q", async () => {
  const seen: string[] = [];
  stubFetch((u) => {
    seen.push(u);
    return jsonResp(404, {});
  });
  await resolveTokenIdentity(MINT, {
    endpoint: ENDPOINT,
    mint: fakeMint,
    chainFallback: unknownChain,
  });
  await resolveTokenIdentity("backpack", {
    endpoint: ENDPOINT,
    mint: null,
    chainFallback: neverChain,
  });
  restore();
  assert.ok(seen[0].includes(`mint=${MINT}`), seen[0]);
  assert.ok(seen[1].includes("q=backpack"), seen[1]);
});
