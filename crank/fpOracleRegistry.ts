// ============================================================================
// crank/fpOracleRegistry.ts — source registry for the first-party oracle lane
// ============================================================================
//
// Two source sets per feed, and they are DISJOINT BY CONSTRUCTION:
//
//   PUSH   — medianed to produce the price we write on-chain.
//   VERIFY — medianed to produce the independent reference the soak checks
//            that price against (soak gate S10).
//
// S10 exists because a verification that reuses the push sources proves the
// arithmetic works and nothing else. If the crank medians Binance/Coinbase/OKX
// and we verify against Binance/Coinbase/OKX, a venue outage or a bad tick is
// invisible to the check — the two numbers move together by construction. The
// ruling is that the sets are disjoint FROM DAY ONE, not bolted on before the
// soak report, so `assertDisjoint()` runs at module load and throws. There is no
// configuration in which this crank can push while verifying against itself.
//
// ≥3 responders per side is a hard floor, enforced in the crank, not here: a
// two-source "median" is an average, and an average of two disagreeing venues is
// a number nobody quoted.
//
// SOAK SCOPE (ruling 3): crypto + gold first. The five feeds below also happen
// to satisfy S9 exactly — ≥5 feeds across ≥2 asset classes (crypto + commodity).
// Equity API selection proceeds in parallel and MUST NOT block soak start; when
// it lands it adds entries here and nothing else changes.
// ============================================================================

export type SourceId =
  | "binance" | "coinbase" | "okx"       // PUSH set
  | "gate" | "kucoin" | "bitget";        // VERIFY set

export interface SourceSpec {
  id: SourceId;
  url: string;
  /** Dotted path into the JSON response; `[n]` indexes arrays. */
  path: string;
}

export interface FpFeedEntry {
  symbol: string;
  /** 32-byte feed id, 64 lowercase hex chars, no 0x. Shared with the market. */
  feedHashHex: string;
  assetClass: "crypto" | "commodity" | "equity";
  push: SourceSpec[];
  verify: SourceSpec[];
}

// ---- venue URL builders ----------------------------------------------------
// Kept as builders rather than literals so a new asset cannot silently acquire a
// hand-typed URL that differs in a query param nobody notices.

const binance = (sym: string): SourceSpec => ({
  id: "binance",
  url: `https://api.binance.com/api/v3/ticker/price?symbol=${sym}`,
  path: "price",
});
const coinbase = (product: string): SourceSpec => ({
  id: "coinbase",
  url: `https://api.exchange.coinbase.com/products/${product}/ticker`,
  path: "price",
});
const okx = (inst: string): SourceSpec => ({
  id: "okx",
  url: `https://www.okx.com/api/v5/market/ticker?instId=${inst}`,
  path: "data[0].last",
});
const gate = (pair: string): SourceSpec => ({
  id: "gate",
  url: `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${pair}`,
  path: "[0].last",
});
const kucoin = (sym: string): SourceSpec => ({
  id: "kucoin",
  url: `https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${sym}`,
  path: "data.price",
});
const bitget = (sym: string): SourceSpec => ({
  id: "bitget",
  url: `https://api.bitget.com/api/v2/spot/market/tickers?symbol=${sym}`,
  path: "data[0].lastPr",
});

const PUSH_SET: readonly SourceId[] = ["binance", "coinbase", "okx"];
const VERIFY_SET: readonly SourceId[] = ["gate", "kucoin", "bitget"];

// ---- PROVENANCE: every URL + path below was probed live, 2026-08-30 ---------
// Not guessed. All 30 endpoints hit read-only; observed cross-set deltas were
// 0.1-1.4 bps against the 50 bps S3 gate, and push-side spreads 0.0-1.9 bps.
//
// The first draft of this file used mexc + bybit as verify sources and had to be
// replaced: NEITHER lists PAXG spot (mexc -1121 "invalid symbol", bybit 10001
// "Not supported symbols"), which would have left gold with a single verify
// source and silently broken S10 for the one non-crypto asset in the soak scope.
// gate/kucoin/bitget all cover all five feeds including PAXG.
//
// OKX CAVEAT: okx.com does not resolve from the Windows dev workstation (DNS
// fails outright, curl HTTP 000, time_namelookup 0.000000). It resolves and
// returns 200 from the VPS, where the crank actually runs, and the
// `data[0].last` path was confirmed against a real response body there. Do not
// "fix" the OKX entry after a local probe failure — probe from the box first.

// ---- the registry ----------------------------------------------------------
// feedHashHex values are the EXISTING ids already used by the SB markets, so an
// Opta feed for BTC and the BTC market address the same 32 bytes. That is what
// lets set_oracle_source flip a market without touching feed identity anywhere.

export const FP_FEEDS: FpFeedEntry[] = [
  {
    symbol: "BTC/USD",
    feedHashHex: "baf182b54386b4a1c0354b7d64fb33d679301087a8b509d6a397d7b4f5162ee2",
    assetClass: "crypto",
    push: [binance("BTCUSDT"), coinbase("BTC-USD"), okx("BTC-USDT")],
    verify: [gate("BTC_USDT"), kucoin("BTC-USDT"), bitget("BTCUSDT")],
  },
  {
    symbol: "ETH/USD",
    feedHashHex: "1d8f55a03da760d0f322bc1d066427e95573f651d506e0e31a5499659349caa3",
    assetClass: "crypto",
    push: [binance("ETHUSDT"), coinbase("ETH-USD"), okx("ETH-USDT")],
    verify: [gate("ETH_USDT"), kucoin("ETH-USDT"), bitget("ETHUSDT")],
  },
  {
    symbol: "SOL/USD",
    feedHashHex: "e01fe3bb1d659e5957296b2637658defd1f8b42fc87dd9f16e8fff16fcaeb463",
    assetClass: "crypto",
    push: [binance("SOLUSDT"), coinbase("SOL-USD"), okx("SOL-USDT")],
    verify: [gate("SOL_USDT"), kucoin("SOL-USDT"), bitget("SOLUSDT")],
  },
  {
    symbol: "XRP/USD",
    feedHashHex: "a1c4ce28a9a4abd471fb2eb11236c299a3b02cad72f3f93437aa01578405f736",
    assetClass: "crypto",
    push: [binance("XRPUSDT"), coinbase("XRP-USD"), okx("XRP-USDT")],
    verify: [gate("XRP_USDT"), kucoin("XRP-USDT"), bitget("XRPUSDT")],
  },
  {
    // Gold via PAXG, exactly as the SB lane does it — same proxy, same feed id.
    symbol: "XAU/USD",
    feedHashHex: "6c3c5cc720d1ffd8108aca22bf7834d659612b7e1a4e5f623b76846d1167355e",
    assetClass: "commodity",
    push: [binance("PAXGUSDT"), coinbase("PAXG-USD"), okx("PAXG-USDT")],
    verify: [gate("PAXG_USDT"), kucoin("PAXG-USDT"), bitget("PAXGUSDT")],
  },
];

// ---- S10 DISJOINTNESS GUARD (fail-loud, module load) -----------------------
// The whole point of S10, enforced where it cannot be forgotten. Also asserts
// the per-side floor of 3 and that every entry's sources come from the declared
// side — a copy-paste that put `gate` in a push list would otherwise pass every
// other check in this file.

export function assertDisjoint(): { checked: number } {
  const problems: string[] = [];
  for (const f of FP_FEEDS) {
    const pushIds = f.push.map((s) => s.id);
    const verifyIds = f.verify.map((s) => s.id);

    const overlap = pushIds.filter((id) => verifyIds.includes(id));
    if (overlap.length > 0) {
      problems.push(`${f.symbol}: push and verify share [${overlap.join(", ")}] — S10 violated`);
    }
    if (new Set(pushIds).size !== pushIds.length) problems.push(`${f.symbol}: duplicate push source`);
    if (new Set(verifyIds).size !== verifyIds.length) problems.push(`${f.symbol}: duplicate verify source`);
    if (pushIds.length < 3) problems.push(`${f.symbol}: ${pushIds.length} push sources, need >= 3`);
    if (verifyIds.length < 3) problems.push(`${f.symbol}: ${verifyIds.length} verify sources, need >= 3`);

    for (const id of pushIds) {
      if (!PUSH_SET.includes(id)) problems.push(`${f.symbol}: '${id}' is not a declared PUSH source`);
    }
    for (const id of verifyIds) {
      if (!VERIFY_SET.includes(id)) problems.push(`${f.symbol}: '${id}' is not a declared VERIFY source`);
    }
  }
  const setOverlap = PUSH_SET.filter((id) => (VERIFY_SET as readonly string[]).includes(id));
  if (setOverlap.length > 0) {
    problems.push(`PUSH_SET and VERIFY_SET overlap at [${setOverlap.join(", ")}] — S10 violated globally`);
  }
  if (problems.length > 0) {
    throw new Error(
      `fpOracleRegistry S10 FAILURE — ${problems.length} problem(s):\n  ${problems.join("\n  ")}`,
    );
  }
  return { checked: FP_FEEDS.length };
}
assertDisjoint();

// ---- helpers ---------------------------------------------------------------

export const normFeedHash = (hex: string): string => hex.replace(/^0x/, "").toLowerCase();

export function lookupFpFeed(feedHashHex: string): FpFeedEntry | undefined {
  const k = normFeedHash(feedHashHex);
  return FP_FEEDS.find((f) => normFeedHash(f.feedHashHex) === k);
}

/** Resolve a dotted/indexed path out of a parsed JSON body. */
export function resolvePath(body: unknown, path: string): unknown {
  let cur: any = body;
  for (const seg of path.split(".")) {
    // Split "list[0]" / "[0]" into a key plus any number of indices.
    const m = seg.match(/^([^[\]]*)((?:\[\d+\])*)$/);
    if (!m) return undefined;
    const [, key, idx] = m;
    if (key) cur = cur?.[key];
    for (const i of idx.match(/\d+/g) ?? []) cur = cur?.[Number(i)];
    if (cur === undefined || cur === null) return cur;
  }
  return cur;
}

/** Median of a numeric array. Even counts average the middle pair. */
export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return NaN;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** Max pairwise spread across a sample set, in bps of the median. */
export function spreadBps(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = median(xs);
  if (!(m > 0)) return Number.POSITIVE_INFINITY;
  return ((Math.max(...xs) - Math.min(...xs)) / m) * 10_000;
}
