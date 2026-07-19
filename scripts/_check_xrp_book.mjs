// READ-ONLY browser check: does prod /trade render the XRP $1.09 CALL (Jul-24)
// writer-ask in the order book? Real system-Chrome via playwright-core.
//   cd app && npm i -D playwright-core --no-save
//   node ../scripts/_check_xrp_book.mjs
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(__dirname, "..", "app", "package.json"));
const { chromium } = require("playwright-core");

const URL = "https://opta.fyi/trade?asset=XRP&expiry=1784880000&strike=1.09&side=call";
const SHOT = resolve(__dirname, "..", "app", "_xrp_book.png");

const browser = await chromium.launch({ channel: "chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 120)); });
try {
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  // Polling SPA never hits networkidle — wait explicitly for the book label +
  // the unified-chain scan (~138 markets) to settle.
  await page.waitForSelector("text=/Order book/i", { timeout: 45000 }).catch(() => {});
  await page.waitForTimeout(14000);
  const selectedAsset = await page.locator("text=/XRP/i").first().isVisible().catch(() => false);
  // Grab the order-book region text (label + ladder).
  const bookText = await page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll("*"));
    const lbl = nodes.find((n) => /order book/i.test(n.textContent || "") && n.children.length < 6);
    let el = lbl; for (let i = 0; i < 4 && el; i++) el = el.parentElement;
    return (el?.innerText || document.body.innerText).slice(0, 1400);
  });
  await page.screenshot({ path: SHOT, fullPage: false });
  const hasAskPrice = /0\.0203|0\.020|\$0\.02/.test(bookText);
  const noBook = /No book/i.test(bookText);
  console.log(`URL: ${URL}`);
  console.log(`XRP visible on page: ${selectedAsset}`);
  console.log(`"No book" fallback shown: ${noBook}`);
  console.log(`ask price (~$0.0203) present in book region: ${hasAskPrice}`);
  console.log(`console errors: ${errors.length}${errors.length ? " -> " + errors.slice(0, 3).join(" | ") : ""}`);
  console.log(`--- order-book region text (truncated) ---\n${bookText}`);
  console.log(`--- screenshot: ${SHOT} ---`);
  console.log(`RESULT: ${!noBook && hasAskPrice ? "✅ BOOK RENDERS THE ASK" : noBook ? "⚠ NO-BOOK fallback (check contract focus)" : "⚠ ask price not detected — inspect screenshot"}`);
} finally {
  await browser.close();
}
