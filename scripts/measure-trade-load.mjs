// =============================================================================
// scripts/measure-trade-load.mjs — where /trade actually spends its time
// =============================================================================
//
// MEASURE BEFORE FIXING. The founder reports "minutes to interactive" on /trade;
// the plausible causes (5.93MB getProgramAccounts scans, a 74-series fan-out, the
// HTTP/1.1 six-socket cap, render loops) are all plausible, which is exactly why
// guessing is the wrong move — a fix aimed at the wrong one costs a night and
// changes nothing.
//
// Runs real Chrome via playwright-core, records EVERY request with size and
// timing, and reports:
//   - wall-clock to first contract row (the honest "interactive" for this page)
//   - RPC calls, grouped by JSON-RPC method, with bytes and total time
//   - concurrency over time, which is what exposes a serial waterfall
//   - the slowest single chains
//
// COLD  = fresh profile, no cache, no localStorage.
// WARM  = same context, second navigation.
//
// PREREQ: cd app && npm i -D playwright-core --no-save
// RUN:    node scripts/measure-trade-load.mjs [url]
// =============================================================================
import { chromium } from "../app/node_modules/playwright-core/index.mjs";

const URL = process.argv[2] || "https://opta.fyi/trade";
const INTERACTIVE_TIMEOUT = 180_000;

/** The page is "interactive" when a contract row exists — not when React mounts,
 *  and not when the spinner appears. Anything earlier is a claim about the app
 *  rather than about what the user can do. */
// The LIVE page is TradePageV2 -> TradeChainV2, a CSS GRID of divs. The <table>
// belongs to the older TradePage, which is not what /trade renders. A table
// selector here measures nothing and reports "never interactive" for a page that
// may be rendering fine — which is exactly what the first run of this script did.
const READY_SELECTORS = [
  "[data-testid='chain-strike']",   // one per strike row in TradeChainV2
  "[data-testid='trade-chain'] [data-testid='chain-cell']",
  "table tbody tr",                 // legacy TradePage, kept as a fallback
];

function bodyMethod(req) {
  try {
    const d = req.postData();
    if (!d) return null;
    const j = JSON.parse(d);
    if (Array.isArray(j)) return `BATCH(${j.length}):` + (j[0]?.method ?? "?");
    return j.method ?? null;
  } catch { return null; }
}

async function measure(page, label) {
  const reqs = [];
  const started = new Map();

  const onReq = (r) => started.set(r, Date.now());
  const onDone = async (resp) => {
    const r = resp.request();
    const t0 = started.get(r);
    if (t0 == null) return;
    let size = 0;
    try { size = Number((await resp.headerValue("content-length")) ?? 0); } catch {}
    if (!size) { try { size = (await resp.body()).length; } catch {} }
    reqs.push({
      url: r.url(), method: bodyMethod(r), status: resp.status(),
      start: t0, end: Date.now(), ms: Date.now() - t0, size,
    });
  };
  page.on("request", onReq);
  page.on("response", onDone);

  const t0 = Date.now();
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: INTERACTIVE_TIMEOUT });

  let interactiveMs = null;
  try {
    await page.waitForSelector(READY_SELECTORS.join(", "), { timeout: INTERACTIVE_TIMEOUT });
    interactiveMs = Date.now() - t0;
  } catch { interactiveMs = null; }

  // Let stragglers land so the waterfall is complete.
  await page.waitForTimeout(4000);
  page.off("request", onReq);
  page.off("response", onDone);

  return { label, t0, interactiveMs, reqs, totalMs: Date.now() - t0 };
}

function report(m) {
  const { label, reqs, interactiveMs, t0 } = m;
  console.log(`\n${"=".repeat(66)}\n${label}\n${"=".repeat(66)}`);
  console.log(`  time to first contract row : ${interactiveMs == null ? "NEVER (timed out)" : (interactiveMs / 1000).toFixed(2) + " s"}`);
  console.log(`  requests                   : ${reqs.length}`);
  const bytes = reqs.reduce((a, r) => a + r.size, 0);
  console.log(`  bytes                      : ${(bytes / 1e6).toFixed(2)} MB`);

  const rpc = reqs.filter((r) => r.method);
  const byMethod = new Map();
  for (const r of rpc) {
    const e = byMethod.get(r.method) ?? { n: 0, ms: 0, size: 0 };
    e.n++; e.ms += r.ms; e.size += r.size;
    byMethod.set(r.method, e);
  }
  console.log(`\n  RPC calls: ${rpc.length}`);
  console.log(`  ${"method".padEnd(34)} ${"n".padStart(4)} ${"totalMs".padStart(8)} ${"MB".padStart(7)}`);
  [...byMethod.entries()].sort((a, b) => b[1].ms - a[1].ms).slice(0, 12).forEach(([k, v]) => {
    console.log(`  ${k.padEnd(34)} ${String(v.n).padStart(4)} ${String(v.ms).padStart(8)} ${(v.size / 1e6).toFixed(2).padStart(7)}`);
  });

  // Concurrency: a serial waterfall shows as a long tail at depth 1-2.
  const end = Math.max(...reqs.map((r) => r.end), t0);
  const buckets = [];
  for (let t = t0; t < end; t += 500) {
    buckets.push(reqs.filter((r) => r.start <= t && r.end >= t).length);
  }
  const maxC = Math.max(0, ...buckets);
  const serialish = buckets.filter((b) => b > 0 && b <= 2).length;
  console.log(`\n  peak concurrency           : ${maxC}`);
  console.log(`  500ms slices with <=2 in flight : ${serialish} of ${buckets.length}  (high => serial waterfall)`);

  console.log(`\n  slowest single requests:`);
  [...reqs].sort((a, b) => b.ms - a.ms).slice(0, 6).forEach((r) => {
    const u = r.url.length > 58 ? r.url.slice(0, 55) + "..." : r.url;
    console.log(`    ${String(r.ms).padStart(6)}ms ${(r.size / 1e6).toFixed(2).padStart(6)}MB ${r.method ?? ""} ${u}`);
  });
  return { interactiveMs, requests: reqs.length, bytes, rpc: rpc.length };
}

const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

const cold = await measure(page, `COLD — ${URL}`);
const c = report(cold);

const warm = await measure(page, `WARM — ${URL} (same context, second load)`);
const w = report(warm);

console.log(`\n${"=".repeat(66)}\nSUMMARY\n${"=".repeat(66)}`);
console.log(`  cold interactive : ${c.interactiveMs == null ? "NEVER" : (c.interactiveMs / 1000).toFixed(2) + " s"}   ${c.rpc} RPC, ${(c.bytes / 1e6).toFixed(2)} MB`);
console.log(`  warm interactive : ${w.interactiveMs == null ? "NEVER" : (w.interactiveMs / 1000).toFixed(2) + " s"}   ${w.rpc} RPC, ${(w.bytes / 1e6).toFixed(2)} MB`);
console.log(`  targets          : warm < 2s, cold single-digit seconds`);

await browser.close();
