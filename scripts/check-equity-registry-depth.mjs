// =============================================================================
// scripts/check-equity-registry-depth.mjs — browser gate for the 13-ticker
// equity registry + writer-ask escrow ("book depth") in market depth.
// =============================================================================
// Sibling of check-markets-visibility.mjs; same dist-server + playwright-core
// harness. Presence in the bundle proves nothing — these are DATA-DRIVEN
// surfaces, so this drives a real browser against the built dist and asserts
// RENDERED DOM after real interaction:
//   - /markets Equities tab lists all 13 equity tickers as rows
//   - header strip shows a distinct "Book depth · resting asks" cell whose
//     value is > 0 and NOT equal to Vault TVL (the two must never be merged)
//   - /trade asset dropdown groups all 13 equities under "Equities"
//     (they previously fell through to "Other")
//
// Needs live devnet reads (the dist connects to its baked RPC).
// PREREQ: cd app && npm i -D playwright-core --no-save
// RUN from repo root, after `cd app && npm run build`:
//     node scripts/check-equity-registry-depth.mjs
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

const EQUITIES = ["AAPL", "AMD", "AMZN", "COIN", "CRCL", "GOOGL", "HOOD", "META", "MSFT", "MSTR", "NVDA", "SPCX", "TSLA"];

const require = createRequire(resolve(APP_DIR, "package.json"));
let chromium;
try { ({ chromium } = require("playwright-core")); }
catch { console.error("playwright-core not found:\n  cd app && npm i -D playwright-core --no-save"); process.exit(2); }

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript",
  ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".png": "image/png", ".ico": "image/x-icon",
};

const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, BASE).pathname);
    let filePath = join(DIST, pathname);
    let ext = extname(filePath);
    let data;
    if (!ext) { filePath = join(DIST, "index.html"); ext = ".html"; }
    try { data = await readFile(filePath); }
    catch { filePath = join(DIST, "index.html"); ext = ".html"; data = await readFile(filePath); }
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  } catch (e) { res.writeHead(500); res.end(String(e)); }
});

const checks = [];
const record = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(52)} ${detail}`);
};
const money = (s) => Number(String(s).replace(/[^0-9.]/g, "")) * (/m/i.test(s) ? 1e6 : /k/i.test(s) ? 1e3 : 1);

let browser;
try {
  await readFile(join(DIST, "index.html")).catch(() => {
    throw new Error("app/dist not found — run `cd app && npm run build` first");
  });
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });

  // ---- /markets: header book-depth cell + Equities tab rows -----------------
  await page.goto(BASE + "/markets", { waitUntil: "networkidle", timeout: 45000 });
  await page.waitForSelector('[data-testid="markets-terminal"][data-loading="0"]', { timeout: 45000 });

  const strip = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="strip-book-depth"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { text: el.innerText.replace(/\s+/g, " ").trim(), w: r.width, h: r.height, opacity: cs.opacity, display: cs.display };
  });
  record("book-depth strip cell is RENDERED", !!strip && strip.w > 0 && strip.h > 0 && strip.opacity !== "0",
    strip ? `"${strip.text}" ${Math.round(strip.w)}x${Math.round(strip.h)} op=${strip.opacity}` : "cell absent");

  const bookVal = strip ? money(strip.text.replace(/book depth[^0-9$]*/i, "")) : 0;
  record("book depth > 0 (escrow surfaced)", bookVal > 0, `parsed=${bookVal}`);

  const vaultText = await page.evaluate(() => {
    const cells = [...document.querySelectorAll("div")].filter((d) => /vault tvl/i.test(d.innerText || ""));
    return cells.length ? cells[cells.length - 1].innerText.replace(/\s+/g, " ").trim() : "";
  });
  const vaultVal = money(vaultText.replace(/vault tvl/i, ""));
  record("book depth NOT merged into Vault TVL", bookVal !== vaultVal && vaultVal >= 0,
    `vaultTvl="${vaultText}" book=${bookVal}`);

  // Equities tab -> rendered rows
  await page.getByText("Equities", { exact: true }).first().click();
  await page.waitForTimeout(1200);
  const eqFound = await page.evaluate((tickers) => {
    const txt = document.body.innerText;
    return tickers.filter((t) => new RegExp(`\\b${t}\\b`).test(txt));
  }, EQUITIES);
  record("Equities tab renders all 13 tickers", eqFound.length === 13,
    `${eqFound.length}/13 · missing=[${EQUITIES.filter((t) => !eqFound.includes(t)).join(",")}]`);

  // ---- /trade: dropdown groups all 13 under Equities -------------------------
  // NOT networkidle: /trade polls the book continuously, so the network never
  // goes idle and the nav would time out.
  await page.goto(BASE + "/trade", { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(9000);
  const opened = await page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /select asset|^[A-Z]{2,6}\s/i.test(x.innerText || ""));
    if (!b) return false;
    b.click();
    return true;
  });
  record("asset dropdown opens", opened);
  await page.waitForTimeout(900);

  const grouped = await page.evaluate((tickers) => {
    // Class headings are UPPERCASED by CSS text-transform and innerText reflects
    // the rendered casing — match case-insensitively, not on the source casing.
    const txt = document.body.innerText.toUpperCase();
    const i = txt.indexOf("EQUITIES");
    if (i < 0) return { hasGroup: false, found: [] };
    // slice from the Equities heading to whichever class heading comes next
    const rest = txt.slice(i + "EQUITIES".length);
    const nextIdx = ["COMMODITIES", "FX", "OTHER", "CRYPTO"]
      .map((h) => rest.indexOf(h)).filter((n) => n > 0).sort((a, b) => a - b)[0] ?? rest.length;
    const seg = rest.slice(0, nextIdx);
    return { hasGroup: true, found: tickers.filter((t) => new RegExp(`\\b${t}\\b`).test(seg)) };
  }, EQUITIES);
  if (!grouped.hasGroup && process.env.GATE_DEBUG === "1") {
    const dump = await page.evaluate(() => document.body.innerText.replace(/\s+/g, " ").slice(0, 1200));
    console.log("\n--- DEBUG body.innerText ---\n" + dump + "\n---\n");
  }
  record("dropdown has an Equities group", grouped.hasGroup);
  record("all 13 equities grouped under Equities", grouped.found.length === 13,
    `${grouped.found.length}/13 · missing=[${EQUITIES.filter((t) => !grouped.found.includes(t)).join(",")}]`);

  const failed = checks.filter((c) => !c.ok);
  console.log(`\n${failed.length === 0 ? "ALL GATES PASS" : `${failed.length} GATE(S) FAILED`}  (${checks.length} checks)`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} catch (e) {
  console.error("GATE ERROR:", e.message);
  process.exitCode = 2;
} finally {
  if (browser) await browser.close();
  server.close();
}
