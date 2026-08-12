// =============================================================================
// listingRequest.test.ts — SLICE 2C: the signed listing-request client
// =============================================================================
//   run: node app/scripts/run-listing-tests.mjs
//
// This module is a thin CONSUMER of epoch0Sign.buildEnvelope. The signing
// FORMAT is not re-tested here — epoch0Format.test.ts already pins it against
// indexer/src/api/auth.ts, and pinning it twice would just be two places to
// forget. What this file owns is the part that is genuinely new: outcome
// mapping, and the rule that a declined signature is a decision rather than a
// failure.
// =============================================================================

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkAlreadyRequested,
  isUserDecline,
  submitListingRequest,
  type ListingOutcome,
  type SubmitDeps,
} from "./listingRequest";

const WALLET = "Awi8u6PigydVN4XRBQzmiPEdyyVmtnwf1H7Gmrf5ARu5";
const MINT = "BPxxfRCXkUVhig4HS1Lh7kZqV6SPJhzfEk4x6fVBjPCy";
const MINT2 = "9cRCn9rGT8V2imeM2BaKs13yhMEais3ruM3rPvTGpump";
const PARAMS = { mint: MINT, symbol: "BP", assetClass: 0 };
const API = "https://opta.test";

/** A stand-in envelope builder. Records what it was asked to sign so the tests
 *  can assert the params reach it, without re-testing the signing format. */
function fakeBuild(over: { throws?: unknown } = {}) {
  const seen: { action?: string; wallet?: string; params?: unknown }[] = [];
  const impl = (async (args: { action: string; wallet: string; params?: unknown; nowUnix: number; sign: unknown }) => {
    if (over.throws) throw over.throws;
    seen.push({ action: args.action, wallet: args.wallet, params: args.params });
    return {
      wallet: args.wallet,
      action: args.action,
      nonce: "NONCE1",
      expiry: args.nowUnix + 240,
      params: (args.params ?? {}) as Record<string, unknown>,
      signature: "SIG",
    };
  }) as never;
  return { impl, seen };
}

const jsonResp = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

function deps(over: Partial<SubmitDeps> = {}): SubmitDeps {
  return {
    apiBase: API,
    wallet: WALLET,
    sign: async () => new Uint8Array(64),
    nowUnix: 1_786_000_000,
    buildEnvelopeImpl: fakeBuild().impl,
    fetchImpl: (async () => jsonResp(200, { status: "recorded" })) as unknown as typeof fetch,
    ...over,
  };
}

// ---- outcomes ---------------------------------------------------------------

test("a 200 recorded is recorded", async () => {
  const r = await submitListingRequest(PARAMS, deps());
  assert.deepEqual(r, { kind: "recorded" } as ListingOutcome);
});

test("a 200 already-requested is its OWN state, not a failure", async () => {
  const r = await submitListingRequest(PARAMS, deps({
    fetchImpl: (async () => jsonResp(200, { status: "already-requested" })) as unknown as typeof fetch,
  }));
  assert.equal(r.kind, "already-requested");
});

test("RED: a declined signature is a DECISION, never an error", async () => {
  // The user said no. Showing a red failure state for exercising a choice is
  // the specific thing this branch exists to prevent.
  for (const e of [
    { code: 4001 },
    new Error("User rejected the request"),
    new Error("user denied message signature"),
    new Error("Request rejected"),
  ]) {
    const r = await submitListingRequest(PARAMS, deps({ buildEnvelopeImpl: fakeBuild({ throws: e }).impl }));
    assert.equal(r.kind, "declined", `${String((e as Error).message ?? "code 4001")} must be a decline`);
  }
});

test("a genuine signer failure is unavailable, not declined", async () => {
  const r = await submitListingRequest(PARAMS, deps({
    buildEnvelopeImpl: fakeBuild({ throws: new Error("wallet disconnected mid-flight") }).impl,
  }));
  assert.equal(r.kind, "unavailable");
});

test("the daily cap surfaces a reason the user can act on", async () => {
  const r = await submitListingRequest(PARAMS, deps({
    fetchImpl: (async () => jsonResp(429, { error: "daily_cap", limit: 10 })) as unknown as typeof fetch,
  }));
  assert.equal(r.kind, "rejected");
  assert.match((r as { reason: string }).reason, /today/i);
});

test("a generic 429 does not claim to be the daily cap", async () => {
  const r = await submitListingRequest(PARAMS, deps({
    fetchImpl: (async () => jsonResp(429, { error: "cooldown" })) as unknown as typeof fetch,
  }));
  assert.match((r as { reason: string }).reason, /shortly/i);
});

test("5xx is unavailable (retryable); 4xx is rejected (repeating will not help)", async () => {
  const at = async (status: number) =>
    (await submitListingRequest(PARAMS, deps({
      fetchImpl: (async () => jsonResp(status, { error: "x" })) as unknown as typeof fetch,
    }))).kind;
  assert.equal(await at(500), "unavailable");
  assert.equal(await at(502), "unavailable");
  assert.equal(await at(400), "rejected");
  assert.equal(await at(401), "rejected");
  assert.equal(await at(409), "rejected");
});

test("a network throw is unavailable, never rejected", async () => {
  const r = await submitListingRequest(PARAMS, deps({
    fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch,
  }));
  assert.equal(r.kind, "unavailable");
});

test("a non-JSON 200 body still reads as recorded", async () => {
  const r = await submitListingRequest(PARAMS, deps({
    fetchImpl: (async () => ({
      ok: true, status: 200, json: async () => { throw new Error("not json"); },
    })) as unknown as typeof fetch,
  }));
  assert.equal(r.kind, "recorded");
});

// ---- what actually gets sent ------------------------------------------------

test("the params reach the signer — the mint is bound, not decorative", async () => {
  const b = fakeBuild();
  await submitListingRequest(PARAMS, deps({ buildEnvelopeImpl: b.impl }));
  assert.equal(b.seen.length, 1);
  assert.equal(b.seen[0].action, "listing.request");
  assert.equal(b.seen[0].wallet, WALLET);
  assert.deepEqual(b.seen[0].params, PARAMS);
});

test("a different mint produces a different signed payload", async () => {
  const b = fakeBuild();
  const d = deps({ buildEnvelopeImpl: b.impl });
  await submitListingRequest(PARAMS, d);
  await submitListingRequest({ ...PARAMS, mint: MINT2 }, d);
  assert.notDeepEqual(b.seen[0].params, b.seen[1].params);
});

test("the POST carries the whole envelope to the right route", async () => {
  let url = "";
  let body: Record<string, unknown> = {};
  await submitListingRequest(PARAMS, deps({
    fetchImpl: (async (u: string, init: RequestInit) => {
      url = u;
      body = JSON.parse(String(init.body));
      return jsonResp(200, { status: "recorded" });
    }) as unknown as typeof fetch,
  }));
  assert.equal(url, `${API}/api/points/listing/request`);
  assert.deepEqual(
    Object.keys(body).sort(),
    ["action", "expiry", "nonce", "params", "signature", "wallet"],
  );
  assert.equal(body.action, "listing.request");
  assert.deepEqual(body.params, PARAMS);
});

// ---- already-requested check ------------------------------------------------

test("checkAlreadyRequested reports true/false, and NULL when it cannot tell", async () => {
  const f = (status: number, body: unknown) => (async () => jsonResp(status, body)) as unknown as typeof fetch;
  assert.equal(await checkAlreadyRequested(API, WALLET, MINT, f(200, { requested: true })), true);
  assert.equal(await checkAlreadyRequested(API, WALLET, MINT, f(200, { requested: false })), false);
  // Unknown must be NULL, not false: the caller then SHOWS the button. Offering
  // an action twice is a far smaller failure than hiding one never taken.
  assert.equal(await checkAlreadyRequested(API, WALLET, MINT, f(500, {})), null);
  assert.equal(
    await checkAlreadyRequested(API, WALLET, MINT, (async () => { throw new Error("x"); }) as unknown as typeof fetch),
    null,
  );
});

test("checkAlreadyRequested never coerces a truthy value into true", async () => {
  const f = (body: unknown) => (async () => jsonResp(200, body)) as unknown as typeof fetch;
  assert.equal(await checkAlreadyRequested(API, WALLET, MINT, f({ requested: "yes" })), false);
  assert.equal(await checkAlreadyRequested(API, WALLET, MINT, f({})), false);
});

test("checkAlreadyRequested url-encodes both parameters", async () => {
  let url = "";
  await checkAlreadyRequested(API, WALLET, MINT, (async (u: string) => {
    url = u;
    return jsonResp(200, { requested: false });
  }) as unknown as typeof fetch);
  assert.ok(url.includes(`wallet=${WALLET}`));
  assert.ok(url.includes(`mint=${MINT}`));
});

// ---- misc -------------------------------------------------------------------

test("isUserDecline matches the wallet phrasings and nothing else", () => {
  assert.equal(isUserDecline({ code: 4001 }), true);
  assert.equal(isUserDecline(new Error("User rejected the request")), true);
  assert.equal(isUserDecline(new Error("Request rejected")), true);
  assert.equal(isUserDecline(new Error("network error")), false);
  assert.equal(isUserDecline(new Error("500 internal")), false);
  assert.equal(isUserDecline(null), false);
});
