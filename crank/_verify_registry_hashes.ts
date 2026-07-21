// Verify every registry feed's buildOracleFeed → computeOracleFeedId === its key.
// Proves sbFeedRegistry.ts (incl. the 4 new memes) is self-consistent with the
// on-chain feedHashes. Read-only, no network.
import { FeedHash } from "@switchboard-xyz/common";
import { listSupportedFeeds, buildOracleFeed, lookupSbFeed } from "./sbFeedRegistry";

const norm = (h: string) => h.replace(/^0x/, "").toLowerCase();
let bad = 0;
for (const entry of listSupportedFeeds()) {
  const computed = norm(Buffer.from(FeedHash.computeOracleFeedId(buildOracleFeed(entry))).toString("hex"));
  const ok = computed === norm(entry.feedHashHex);
  if (!ok) bad++;
  console.log(`${ok ? "OK " : "MISMATCH"} ${entry.symbol.padEnd(14)} key=${entry.feedHashHex.slice(0, 12)} computed=${computed.slice(0, 12)}`);
}
console.log(`\n${bad === 0 ? "ALL CONSISTENT" : bad + " MISMATCH"} (${listSupportedFeeds().length} feeds)`);

// ---- Wave-2 equity RESOLUTION gate -----------------------------------------
// Registration is a PREREQUISITE of the equity migrations: _cutover_rebirth's
// create path throws "not in SB registry" (switchboardCreateMarket.ts:80) AFTER
// the close has landed -> asset goes MARKETLESS (found live on MSFT 2026-07-20).
// All 13 must resolve here before any migration resumes.
const EQUITIES: Array<[string, string]> = [
  ["MSFT", "b13e5f030af9a49150591b6cbce83810184331e5b6a0eae8b303a49153496c56"],
  ["AAPL", "d0ab87e8218247d61f3b60e0d9c7e9dc93f691f30849552e0923aa8acd15fdc8"],
  ["GOOGL", "c47268fa603180997ab954702ef058dcf56d97f597085d095278dfffd37c9103"],
  ["AMZN", "bf3190ce3b040d25d1af35c66461fe8fee2f7dd4c83e72e5c13dcc89929abf3f"],
  ["META", "56bb4c5863ad44b5c59d75cce27d170f8c05e50b9698c9a27480bc7c47f11570"],
  ["NVDA", "5378913080bd823885beb8cc37d55842d438e2198f8ce711b7385b527a542bdf"],
  ["AMD", "28fcb07fb1301a399cbe35b809cd8ffa45a22f5bd4e3a15845b4fca219846668"],
  ["TSLA", "24f5404db181873fead6fd9ad15c7edc2265e8b7a494b3168055fa3bfbb3ced3"],
  ["COIN", "60e0a2d31235e2e3c7414635f3bf0c14c671098ef953b0823d380913d627c868"],
  ["MSTR", "5dc7af42f5237fb2d39aa65374c91234da9a92ba940ac9a5613b51d59d9a830a"],
  ["CRCL", "077acbc9a679e4660b8ace50be067bd08a443f1ea7c0a48b4b6e444c23c17040"],
  // ---- Wave-2b (2026-07-21) ----
  ["SPCX", "fd7a0b9ea922e14e18944f8105b151df922487da9b1b2ed5ad52150924ed413f"],
  ["HOOD", "9801bc9a0cc3eceb1ec4dfb964186a426883bb89a670c5968879b6e2c31b7c8b"],
];
let missing = 0;
console.log("");
for (const [t, h] of EQUITIES) {
  const e = lookupSbFeed(h);
  if (!e) { console.log(`MISSING  ${t} ${h.slice(0, 12)} NOT resolvable`); missing++; continue; }
  const shapeOk = e.symbol === `${t}/USD` && e.jobs.length === 2 && e.minOracleSamples === 2;
  if (!shapeOk) missing++;
  console.log(`${shapeOk ? "OK " : "SHAPE-BAD"} ${t.padEnd(6)} symbol=${e.symbol.padEnd(11)} jobs=${e.jobs.length} minOracleSamples=${e.minOracleSamples}`);
}
console.log(`\nlookupSbFeed: ${EQUITIES.length - missing}/${EQUITIES.length} equity feeds resolvable`);
const failed = bad > 0 || missing > 0;
console.log(failed ? "GATE FAILED — do NOT resume migrations" : "GATE PASSED — equity migrations may resume");
process.exit(failed ? 1 : 0);
