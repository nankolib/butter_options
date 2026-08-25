// vC3 Rev C red-first suite — indexer read path.
//
// Gates:
//   stale envelope        -> fallback (null)
//   lineage mismatch      -> fallback (null)
//   UNFILTERED board fetch-> refused, and no request is issued at all
//   pre-sign divergence   -> buy BLOCKS with a surfaced error
//   board-filtered path   -> exercised, market= present in the URL
//
// Run:  node --test --test-force-exit test/revc.test.js
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");

const OUT = process.env.OPTA_TEST_OUT || path.join(__dirname, "out");
const SRC = process.env.OPTA_TEST_SRC || path.join(__dirname, "..", "src");
const load = (rel) => require(path.join(OUT, rel));

const LINEAGE = "CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq:485057525";
const MARKET = "7X7AuBsKZ5i15os6e4CnYaR3PrBH1gvAGDNq392r8jdS";

/** Record every URL requested so "no request issued" is provable, not assumed. */
function stubFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    for (const [frag, body] of Object.entries(routes)) {
      if (String(url).includes(frag)) {
        return { ok: true, json: async () => body };
      }
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return calls;
}

const envelope = (rows, over = {}) =>
  Object.assign({ slot: 1, refreshedAt: 1, ageSec: 5, stale: false, count: rows.length, rows }, over);

const META_OK = { healthy: true, staleAfterSec: 110, lineage: { key: LINEAGE } };

const VAULT_ROW = {
  publicKey: "DCGoWPgyMzEdafWMatoTSd8ifTiKgcG7wbmP2bDacDLb",
  market: MARKET, optionType: 1, strikePrice: "217000", expiry: "1787904000",
  vaultType: 0, totalCollateral: "1085000", totalShares: "1085000",
  vaultUsdcAccount: "DeZU4146QPZEoBQR7dqfqyuNEVr1FGKw5YQkuxckJZNk",
  collateralMint: "AytU5HUQRew9VdUdrzQuZvZ7s14pHLiYjAF5WqdK3oxL",
  totalOptionsMinted: "5", totalOptionsSold: "0", netPremiumCollected: "0",
  premiumPerShareCumulative: "0", isSettled: false, settlementPrice: "0",
  collateralRemaining: "1085000", creator: "HgafDv195BtNc8X4uvNoRuGcUra5PuUwDJgHeKHvgFiS",
  createdAt: "1787570705", bump: 255, carryRateBps: 0, exerciseStyle: 1,
  exercisedOptions: "0", earlyExercisePayout: "0", spreadBps: 0, voided: false,
  writerAskCollateralSwept: "0", writerAskEquivShares: "0"
};

// ----------------------------------------------------------- staleness
test("RevC-stale: a stale envelope is not servable -> caller falls back", () => {
  const { isServableEnvelope } = load("solana/indexerReadPath.js");
  assert.strictEqual(isServableEnvelope(envelope([VAULT_ROW]), 110), true, "control: fresh IS servable");
  assert.strictEqual(isServableEnvelope(envelope([VAULT_ROW], { stale: true }), 110), false, "stale flag ignored");
  assert.strictEqual(isServableEnvelope(envelope([VAULT_ROW], { ageSec: 111 }), 110), false, "age over limit ignored");
  assert.strictEqual(isServableEnvelope(envelope([VAULT_ROW], { ageSec: undefined }), 110), false, "missing age accepted");
  assert.strictEqual(isServableEnvelope({ rows: "nope" }, 110), false, "malformed body accepted");
  assert.strictEqual(isServableEnvelope(null, 110), false);
});

test("RevC-stale2: fetchIndexerRows returns null on a stale envelope", async () => {
  const { fetchIndexerRows } = load("solana/indexerReadPath.js");
  stubFetch({ "/vaults": envelope([VAULT_ROW], { stale: true }) });
  assert.strictEqual(await fetchIndexerRows("sharedVault", MARKET), null);
});

// ----------------------------------------------------------- lineage
test("RevC-lineage: a mismatched deploy lineage refuses the indexer", async () => {
  const { indexerLineageOk } = load("solana/indexerReadPath.js");

  stubFetch({ "/meta": META_OK });
  assert.strictEqual(await indexerLineageOk(), true, "control: matching lineage must pass");

  stubFetch({ "/meta": { healthy: true, lineage: { key: "CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq:999999999" } } });
  assert.strictEqual(await indexerLineageOk(), false, "wrong deploySlot accepted");

  stubFetch({ "/meta": { healthy: false, lineage: { key: LINEAGE } } });
  assert.strictEqual(await indexerLineageOk(), false, "unhealthy indexer accepted");

  stubFetch({});
  assert.strictEqual(await indexerLineageOk(), false, "unreachable meta accepted");
});

// ----------------------------------------------------------- UNFILTERED BAN
test("RevC-unfiltered: board-scoped kinds REFUSE an unfiltered fetch, and issue no request", async () => {
  const { fetchIndexerRows, requiresMarketFilter } = load("solana/indexerReadPath.js");
  assert.strictEqual(requiresMarketFilter("sharedVault"), true);
  assert.strictEqual(requiresMarketFilter("vaultMint"), true);
  assert.strictEqual(requiresMarketFilter("optionsMarket"), false, "markets is 8 KB, filter not required");

  // Unfiltered vaults/series are 5.93 MB of JSON — worse than the base64 they
  // replace. This must not merely be discouraged; it must not be issued.
  const calls = stubFetch({ "/vaults": envelope([VAULT_ROW]), "/series": envelope([]) });
  assert.strictEqual(await fetchIndexerRows("sharedVault", null), null, "unfiltered vaults was allowed");
  assert.strictEqual(await fetchIndexerRows("vaultMint", null), null, "unfiltered series was allowed");
  assert.strictEqual(calls.length, 0, "a request was issued for an unfiltered board fetch: " + calls.join(", "));
});

// ----------------------------------------------------------- board path
test("RevC-board: the filtered path is exercised and carries market= in the URL", async () => {
  const { fetchIndexerRows, loadIndexerRecords } = load("solana/indexerReadPath.js");
  const calls = stubFetch({ "/vaults": envelope([VAULT_ROW]) });

  const rows = await fetchIndexerRows("sharedVault", MARKET);
  assert.ok(Array.isArray(rows) && rows.length === 1, "filtered fetch returned no rows");
  assert.strictEqual(calls.length, 1);
  assert.match(calls[0], /\/vaults\?market=/, "market filter missing from the request URL");
  assert.ok(calls[0].includes(MARKET), "wrong market in the URL");

  // And the adapter must produce the shape the existing decoders produce.
  stubFetch({ "/vaults": envelope([VAULT_ROW]) });
  const recs = await loadIndexerRecords("sharedVault", MARKET);
  assert.strictEqual(recs.length, 1);
  const a = recs[0].account;
  assert.strictEqual(recs[0].publicKey.toBase58(), VAULT_ROW.publicKey);
  assert.deepStrictEqual(a.optionType, { put: {} }, "optionType enum not adapted");
  assert.deepStrictEqual(a.vaultType, { epoch: {} }, "vaultType enum not adapted");
  assert.deepStrictEqual(a.exerciseStyle, { american: {} }, "exerciseStyle enum not adapted");
  assert.strictEqual(a.strikePrice.toString(), "217000", "u64 string not adapted to BN");
  assert.strictEqual(a.isSettled, false);
  assert.strictEqual(a.voided, false);
  assert.strictEqual(a.market.toBase58(), MARKET);
});

test("RevC-adapt-market: pythFeedId hex adapts to the byte array the decoders expect", () => {
  const { adaptMarket } = load("solana/indexerReadPath.js");
  const m = adaptMarket({
    publicKey: MARKET, assetName: "WIF",
    pythFeedId: "d0ab87e8218247d61f3b60e0d9c7e9dc93f691f30849552e0923aa8acd15fdc8",
    assetClass: 2, bump: 252, oracleSource: 1
  });
  assert.ok(Array.isArray(m.account.pythFeedId), "feed id must be a byte array");
  assert.strictEqual(m.account.pythFeedId.length, 32, "feed id must be 32 bytes");
  assert.strictEqual(m.account.pythFeedId[0], 0xd0);
  assert.strictEqual(m.account.assetName, "WIF");
});

// ----------------------------------------------------------- pre-sign guard
test("RevC-presign: divergence BLOCKS the buy with a surfaced error", async () => {
  const { reReadOfferingForSigning, StaleOfferingError } = load("solana/transactions.js");
  const { PublicKey } = require("@solana/web3.js");
  const BN = require("bn.js");

  const VK = new PublicKey("DCGoWPgyMzEdafWMatoTSd8ifTiKgcG7wbmP2bDacDLb");
  const MK = new PublicKey("9vxbxQqZCv9x4Rp2THEfuHsrNGRUXZkfmaxpt7sGohMx");
  const OM = new PublicKey("A5M367pUq5kN2SUPszwhXphQEqXxPKeR3icJPEoyUrjF");
  const future = Math.floor(Date.now() / 1000) + 86_400;

  const offering = {
    vault: { publicKey: VK, account: {} },
    vaultMint: { publicKey: MK, account: { premiumPerContract: new BN(20164), optionMint: OM } }
  };
  const chainVault = (over = {}) => ({ publicKey: VK, account: Object.assign(
    { isSettled: false, voided: false, expiry: new BN(future) }, over) });
  const chainMint = (over = {}) => ({ publicKey: MK, account: Object.assign(
    { premiumPerContract: new BN(20164), quantityMinted: new BN(5), quantitySold: new BN(0), optionMint: OM }, over) });

  const prog = (v, m) => ({ __v: v, __m: m });
  const md = load("solana/program.js");
  const realFetch = md.fetchDecodedAccount;
  md.fetchDecodedAccount = async (program, kind, key) =>
    kind === "sharedVault" ? program.__v : program.__m;

  try {
    // Control: matching state must be allowed through.
    const ok = await reReadOfferingForSigning(prog(chainVault(), chainMint()), offering, 1);
    assert.ok(ok.vault && ok.vaultMint, "control: a matching re-read must succeed");

    const blocks = async (label, v, m, qty = 1) => {
      await assert.rejects(
        () => reReadOfferingForSigning(prog(v, m), offering, qty),
        (e) => {
          assert.ok(e instanceof StaleOfferingError, label + ": wrong error type");
          assert.ok(typeof e.message === "string" && e.message.length > 0,
            label + ": error must carry a surfaced message");
          return true;
        },
        label + ": buy was NOT blocked"
      );
    };

    await blocks("settled vault", chainVault({ isSettled: true }), chainMint());
    await blocks("voided vault", chainVault({ voided: true }), chainMint());
    await blocks("expired vault", chainVault({ expiry: new BN(1) }), chainMint());
    await blocks("price moved", chainVault(), chainMint({ premiumPerContract: new BN(99999) }));
    await blocks("sold out", chainVault(), chainMint({ quantitySold: new BN(5) }));
    await blocks("vault gone", null, chainMint());
    await blocks("series gone", chainVault(), null);
    await blocks("not enough left", chainVault(), chainMint(), 6);
  } finally {
    md.fetchDecodedAccount = realFetch;
  }
});

// ----------------------------------------------------------- source guards
test("RevC-src: the read path is wired and the ban is in code, not just prose", () => {
  const fs = require("fs");
  const md = fs.readFileSync(path.join(SRC, "solana", "marketData.ts"), "utf8");
  assert.match(md, /indexerLineageOk/, "lineage probe not wired into the snapshot load");
  assert.match(md, /loadIndexerRecords/, "indexer records not wired into the snapshot load");
  assert.match(md, /vaultResaleListing/, "listings must stay chain-direct");

  const irp = fs.readFileSync(path.join(SRC, "solana", "indexerReadPath.ts"), "utf8");
  assert.match(irp, /if \(requiresMarketFilter\(kind\) && !marketKey\) return null;/,
    "the unfiltered ban must be enforced in code");

  const tx = fs.readFileSync(path.join(SRC, "solana", "transactions.ts"), "utf8");
  assert.match(tx, /const fresh = await reReadOfferingForSigning\(/,
    "purchase builder does not re-read chain-direct before signing");

  const ums = fs.readFileSync(path.join(SRC, "state", "useMarketState.ts"), "utf8");
  assert.match(ums, /AUTO_REFRESH_MS = 300_000/, "refresh interval not raised to 300s");

  const prog = fs.readFileSync(path.join(SRC, "solana", "program.ts"), "utf8");
  assert.match(prog, /Skipped \$\{skipped\} unreadable/, "per-account warns not aggregated");
});
