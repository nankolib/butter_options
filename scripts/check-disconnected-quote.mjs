// =============================================================================
// scripts/check-disconnected-quote.mjs — regression gate for the disconnected
// on-chain quote (FE bug: payer fell back to PublicKey.default → the RPC loads
// it → InvalidAccountForFee → every NOT-connected visitor saw "—"/"No live
// quote" on the American Protocol-quote centerpiece even with a fresh oracle).
//
// ContractInspector auto-fires fetchOptionPriceQuote on row focus regardless of
// wallet; the fix routes the disconnected sim through SIMULATION_FEE_PAYER (a
// real funded account). This drives a DISCONNECTED headless Chrome to /trade,
// focuses an American SOL row, and asserts the Protocol-quote centerpiece
// resolves to a $ premium (not "—").
//
// PREREQ: cd app && npm run build && npm i -D playwright-core --no-save
// RUN from repo root:  node scripts/check-disconnected-quote.mjs
// Data-dependent: SKIPs (not FAILs) if devnet markets don't load in the static
// serve (RPC unreachable from the harness).
// =============================================================================
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, extname } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, "..", "app");
const DIST = resolve(APP_DIR, "dist");
const PORT = 4321;
const BASE = `http://127.0.0.1:${PORT}`;
const require = createRequire(resolve(APP_DIR, "package.json"));
let chromium;
try { ({ chromium } = require("playwright-core")); }
catch { console.error("playwright-core not found:\n  cd app && npm i -D playwright-core --no-save"); process.exit(2); }

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff",
  ".ttf": "font/ttf", ".png": "image/png", ".ico": "image/x-icon", ".webp": "image/webp", ".map": "application/json" };
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, BASE).pathname);
    let filePath = join(DIST, pathname); let ext = extname(filePath); let data;
    if (!ext) { filePath = join(DIST, "index.html"); ext = ".html"; }
    try { data = await readFile(filePath); }
    catch { filePath = join(DIST, "index.html"); ext = ".html"; data = await readFile(filePath); }
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" }); res.end(data);
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});

const firstLine = (e) => (e && e.message ? e.message.split("\n")[0] : String(e));
let browser, exitCode = 0;
try {
  await readFile(join(DIST, "index.html")).catch(() => { throw new Error("app/dist not found — run `cd app && npm run build` first"); });
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20000);

  // DISCONNECTED (no wallet injected). SOL = reborn-SB American w/ fresh vol oracle.
  await page.goto(`${BASE}/trade?asset=SOL`, { waitUntil: "domcontentloaded" });
  let haveChain = false;
  try { await page.waitForSelector('[data-testid="trade-chain"]', { timeout: 20000 }); haveChain = true; } catch {}
  if (!haveChain) { console.log("SKIP  disconnected quote — devnet markets didn't load in static serve"); process.exit(0); }

  // Focus an American row → docked ContractInspector auto-fires the RFQ.
  const cell = await page.$('[data-testid="trade-chain"] .cursor-pointer');
  if (!cell) { console.log("SKIP  disconnected quote — no clickable chain cell (thin board)"); process.exit(0); }
  await cell.click();
  await page.waitForSelector('[data-testid="trade-inspector"]', { timeout: 8000 });

  // The Protocol-quote centerpiece: the 30px premium sits directly under the
  // "Protocol quote" label. On the BUG it stays "—" (+ "Request on-chain quote");
  // fixed, it resolves to a $ value. Poll up to ~15s (auto-RFQ + sim round-trip).
  const readPremium = async () => page.evaluate(() => {
    const labels = [...document.querySelectorAll("span")].filter((s) => /^Protocol quote$/i.test(s.textContent?.trim() || ""));
    for (const lab of labels) {
      const box = lab.closest("div")?.parentElement; // label row → centerpiece block
      const big = box?.querySelector(".tabular-nums");
      const txt = big?.textContent?.trim();
      if (txt) return txt;
    }
    return null;
  });
  let premium = null;
  for (let i = 0; i < 30; i++) {
    premium = await readPremium();
    if (premium && premium !== "—" && /\d/.test(premium)) break;
    await page.waitForTimeout(500);
  }
  const ok = !!premium && premium !== "—" && /[\d.]/.test(premium);
  console.log(`${ok ? "PASS" : "FAIL"}  disconnected American quote resolves    premium=${premium ?? "(none)"}`);
  exitCode = ok ? 0 : 1;
} catch (e) {
  console.log("FAIL  disconnected quote — " + firstLine(e));
  exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  server.close();
}
process.exit(exitCode);
