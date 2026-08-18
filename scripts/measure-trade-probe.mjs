// Follow-up probe: is "never interactive" a SLOW page or an EMPTY board?
// The distinction decides which fix matters, so it is measured rather than assumed.
import { chromium } from "../app/node_modules/playwright-core/index.mjs";

const base = process.argv[2] || "https://opta.fyi/trade";
const browser = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await browser.newContext();
const page = await ctx.newPage();

async function look(url, label) {
  const t0 = Date.now();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120_000 });

  // Watch what the user is actually shown, second by second.
  const seen = [];
  for (let i = 0; i < 24; i++) {
    await page.waitForTimeout(2500);
    const s = await page.evaluate(() => {
      const txt = document.body.innerText || "";
      // TradeChainV2 is a grid of divs, not a table — see measure-trade-load.mjs.
      const rows = document.querySelectorAll("[data-testid='chain-strike']").length
        || document.querySelectorAll("table tbody tr").length;
      const pick = (re) => (txt.match(re) || [])[0] || null;
      return {
        rows,
        noContracts: /no contracts/i.test(txt),
        loading: /loading|…/i.test(txt),
        asset: pick(/\b(AAPL|JTO|BTC|SOL|ETH|XRP|TSLA|WIF|JUP|BONK|GOOGL|META|XAU)\b/),
        skeleton: document.querySelectorAll("[class*='skeleton'],[class*='animate-pulse']").length,
      };
    });
    seen.push({ t: ((Date.now() - t0) / 1000).toFixed(1), ...s });
    if (s.rows > 0) break;
  }
  const first = seen[0], last = seen[seen.length - 1];
  console.log(`\n=== ${label} ===`);
  console.log(`  default asset shown : ${first.asset ?? "?"}`);
  console.log(`  t=${first.t}s  rows=${first.rows} noContracts=${first.noContracts} loading=${first.loading} skeleton=${first.skeleton}`);
  console.log(`  t=${last.t}s  rows=${last.rows} noContracts=${last.noContracts} loading=${last.loading} skeleton=${last.skeleton}`);
  const firstRowAt = seen.find((s) => s.rows > 0);
  console.log(`  first row at        : ${firstRowAt ? firstRowAt.t + "s" : "never within window"}`);
  // The lie: "no contracts" on screen while data is still arriving.
  const liedEarly = seen.some((s) => s.noContracts && s.rows === 0);
  console.log(`  showed "no contracts" while still loading: ${liedEarly ? "YES — loading is being rendered as empty" : "no"}`);
  return { seen, firstRowAt };
}

await look(base, "default landing");
await look(base + "?asset=JTO", "?asset=JTO (liquid board)");

await browser.close();
