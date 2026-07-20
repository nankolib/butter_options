// Compute + lock the 11 Wave-2 equity feedHashes from the FROZEN quotes.opta.fyi
// URL scheme (GATE-A section C, browser-verified live). Pure function of the URL
// strings — no live proxy needed. Read-only, no network.
//   Finnhub: https://quotes.opta.fyi/finnhub/quote?symbol=X  -> $.c
//   Yahoo:   https://quotes.opta.fyi/yahoo/chart/X           -> $.chart.result[0].meta.regularMarketPrice
import { OracleFeed, OracleJob, FeedHash } from "@switchboard-xyz/common";

const norm = (h: string) => h.replace(/^0x/, "").toLowerCase();
const finnhub = (x: string) => ({ tasks: [{ httpTask: { url: `https://quotes.opta.fyi/finnhub/quote?symbol=${x}` } }, { jsonParseTask: { path: "$.c" } }] });
const yahoo = (x: string) => ({ tasks: [{ httpTask: { url: `https://quotes.opta.fyi/yahoo/chart/${x}` } }, { jsonParseTask: { path: "$.chart.result[0].meta.regularMarketPrice" } }] });

// Locked Gate-1 order (seed shown for the table).
const SEED: Record<string, string> = { MSFT: "0.30", AAPL: "0.32", GOOGL: "0.35", AMZN: "0.35", META: "0.40", NVDA: "0.55", AMD: "0.55", TSLA: "0.60", COIN: "0.75", MSTR: "0.90", CRCL: "0.95" };
const TICKERS = ["AAPL", "TSLA", "MSFT", "NVDA", "MSTR", "GOOGL", "AMZN", "AMD", "COIN", "META", "CRCL"];

function buildFeed(x: string): OracleFeed {
  return OracleFeed.fromObject({
    name: `${x}/USD`,
    jobs: [OracleJob.fromObject(finnhub(x)), OracleJob.fromObject(yahoo(x))],
    minOracleSamples: 2, minJobResponses: 2, maxJobRangePct: 5000000000,
  });
}

for (const x of TICKERS) {
  const h = norm(Buffer.from(FeedHash.computeOracleFeedId(buildFeed(x))).toString("hex"));
  console.log(JSON.stringify({ ticker: x, symbol: `${x}/USD`, seed: SEED[x], feedHash: h }));
}
