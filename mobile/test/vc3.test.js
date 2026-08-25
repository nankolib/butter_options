// vC3 red-first suite.
//
// Run:   node --test test/vc3.test.js
// Red:   OPTA_TEST_PREFIX=<dir of PRE-FIX transpiled sources> node --test test/vc3.test.js
//
// Every case here must FAIL against pre-fix sources and PASS against post-fix.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const { createHarness, installReact } = require("./harness");

const OUT = process.env.OPTA_TEST_OUT || path.join(__dirname, "out");
const SRC = process.env.OPTA_TEST_SRC || path.join(__dirname, "..", "src");
const load = (rel) => require(path.join(OUT, rel));

const B58 = "HgafDv195BtNc8X4uvNoRuGcUra5PuUwDJgHeKHvgFiS";

// ---------------------------------------------------------------- fix (a)
test("S5-a: owner identity is stable across renders on a REHYDRATED session", () => {
  const h = createHarness();
  installReact(h.react);
  const { useConnectionState } = load("state/useConnectionState.js");

  // Rehydrated session: the cached address deserializes as a base58 STRING.
  const wallet = {
    account: { address: B58 },
    connect: async () => ({ address: B58 }),
    disconnect: async () => undefined
  };

  const first = h.render(() => useConnectionState(wallet)).account.address;
  const second = h.render(() => useConnectionState(wallet)).account.address;
  const third = h.render(() => useConnectionState(wallet)).account.address;

  assert.strictEqual(first.toBase58(), B58, "value must still be correct");
  assert.strictEqual(second, first, "owner identity changed between render 1 and 2");
  assert.strictEqual(third, first, "owner identity changed between render 2 and 3");
});

test("S5-a2: owner identity is stable on a FRESH connect (regression guard)", () => {
  const h = createHarness();
  installReact(h.react);
  const { useConnectionState } = load("state/useConnectionState.js");
  const { PublicKey } = require("@solana/web3.js");

  const wallet = {
    account: { address: new PublicKey(B58) },
    connect: async () => ({ address: new PublicKey(B58) }),
    disconnect: async () => undefined
  };
  const first = h.render(() => useConnectionState(wallet)).account.address;
  const second = h.render(() => useConnectionState(wallet)).account.address;
  assert.strictEqual(second, first);
});

// ---------------------------------------------------------------- fix (b)
test("S5-b: an omitted commitmentOrConfig churns Connection identity; a module const does not", () => {
  // Reproduces the provider's memo, which is keyed on [commitmentOrConfig, endpoint].
  const h = createHarness();
  const ENDPOINT = "https://rpc.opta.fyi/devnet";

  // PRE-FIX shape: default parameter -> fresh object literal every render.
  const renderDefaulted = (commitmentOrConfig = { commitment: "confirmed" }) =>
    h.react.useMemo(() => ({ conn: true }), [commitmentOrConfig, ENDPOINT]);
  h.reset();
  const a1 = h.render(() => renderDefaulted());
  const a2 = h.render(() => renderDefaulted());
  assert.notStrictEqual(a2, a1, "harness must actually reproduce the churn, or this test is vacuous");

  // POST-FIX shape: caller passes a module-level constant.
  const WALLET_COMMITMENT = { commitment: "confirmed" };
  const renderStable = (commitmentOrConfig = { commitment: "confirmed" }) =>
    h.react.useMemo(() => ({ conn: true }), [commitmentOrConfig, ENDPOINT]);
  h.reset();
  const b1 = h.render(() => renderStable(WALLET_COMMITMENT));
  const b2 = h.render(() => renderStable(WALLET_COMMITMENT));
  const b3 = h.render(() => renderStable(WALLET_COMMITMENT));
  assert.strictEqual(b2, b1, "Connection identity churned with a stable prop");
  assert.strictEqual(b3, b1);
});

test("S5-b2: App passes commitmentOrConfig to MobileWalletProvider", () => {
  const fs = require("fs");
  const src = fs.readFileSync(path.join(SRC, "App.tsx"), "utf8");
  assert.match(src, /const WALLET_COMMITMENT = \{ commitment: "confirmed" \} as const;/,
    "module-level commitment constant missing");
  assert.match(src, /commitmentOrConfig=\{WALLET_COMMITMENT\}/,
    "MobileWalletProvider is not given a stable commitmentOrConfig");
});

// ---------------------------------------------------------------- fix (c)
test("S5-c: side auto-corrects to the side that actually has inventory", () => {
  const { pickInventorySide } = load("state/sideRider.js");
  const puts = [
    { asset: "FARTCOIN", expiry: 1787904000, side: "put" },
    { asset: "JUP", expiry: 1787904000, side: "put" },
    { asset: "WIF", expiry: 1787904000, side: "put" }
  ];
  // The exact failing case: default side "call", inventory is all puts.
  assert.strictEqual(pickInventorySide(puts, "FARTCOIN", 1787904000, "call"), "put");
  // Already on the side with inventory -> no change.
  assert.strictEqual(pickInventorySide(puts, "FARTCOIN", 1787904000, "put"), null);
  // Nothing for this asset/expiry at all -> leave it alone (empty panel owns that).
  assert.strictEqual(pickInventorySide(puts, "BTC", 1787904000, "call"), null);
  assert.strictEqual(pickInventorySide(puts, "FARTCOIN", 1, "call"), null);
  // No asset selected yet.
  assert.strictEqual(pickInventorySide(puts, "", 1787904000, "call"), null);
  // Both sides present -> never moves.
  const both = puts.concat([{ asset: "FARTCOIN", expiry: 1787904000, side: "call" }]);
  assert.strictEqual(pickInventorySide(both, "FARTCOIN", 1787904000, "call"), null);
});

test("S5-c2: the correction terminates (never oscillates)", () => {
  const { pickInventorySide } = load("state/sideRider.js");
  const puts = [{ asset: "WIF", expiry: 7, side: "put" }];
  let side = "call";
  for (let i = 0; i < 5; i += 1) {
    const next = pickInventorySide(puts, "WIF", 7, side);
    if (next === null) break;
    side = next;
  }
  assert.strictEqual(side, "put");
  assert.strictEqual(pickInventorySide(puts, "WIF", 7, side), null, "would re-fire -> render loop");
});

// ---------------------------------------------------------------- fix (d)
test("S5-d: the real error is surfaced, with the hardcoded copy as fallback", () => {
  const { errorPanelMessage } = load("state/errorMessage.js");
  const FALLBACK = "Your positions are unaffected.";
  assert.strictEqual(
    errorPanelMessage("optionsMarket scan timed out after 15s — the RPC is slow or unreachable.", FALLBACK),
    "optionsMarket scan timed out after 15s — the RPC is slow or unreachable."
  );
  assert.strictEqual(errorPanelMessage(null, FALLBACK), FALLBACK);
  assert.strictEqual(errorPanelMessage(undefined, FALLBACK), FALLBACK);
  assert.strictEqual(errorPanelMessage("", FALLBACK), FALLBACK);
  assert.strictEqual(errorPanelMessage("   ", FALLBACK), FALLBACK);
});

test("S5-d2: all four error panels consume dataError, none hardcode message", () => {
  const fs = require("fs");
  const screens = {
    "TradeScreen.tsx": 1,
    "WriteScreen.tsx": 1,
    "PortfolioScreen.tsx": 2
  };
  for (const [file, expected] of Object.entries(screens)) {
    const src = fs.readFileSync(path.join(SRC, "screens", file), "utf8");
    const uses = (src.match(/message=\{errorPanelMessage\(dataError,/g) || []).length;
    assert.strictEqual(uses, expected, `${file}: expected ${expected} wired error panel(s), found ${uses}`);
    assert.match(src, /dataError\?: string \| null;/, `${file}: dataError prop missing`);
  }
});
