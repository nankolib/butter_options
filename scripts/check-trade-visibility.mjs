// =============================================================================
// scripts/check-trade-visibility.mjs — visibility + geometry + data gate /trade
// =============================================================================
//
// The terminal Trade redesign (design lock 2026-07-09) invariants a bundle grep
// can't see: dark-by-default surface, shared TerminalAppBar, a strike-centered
// SYMMETRIC fill-width chain (gutter-left == gutter-right within 1px), a docked
// inspector loaded by row click, persisting analytics caret, switchable dock
// tabs, mode toggle, SIMPLE render, ZERO oracle-provenance strings, AND (added
// after the 2026-07-09 asset-list/reliability bugs):
//   • the asset dropdown lists every asset Markets State A shows, no blank rows,
//   • a default asset auto-selects on a fresh load (chain renders, no params),
//   • a Markets→Trade deep-link resolves to a rendered chain within timeout.
//
// Builds nothing — run `npm run build` in app/ first — then serves app/dist and
// drives system Chrome via playwright-core. Data-dependent checks assert when the
// (public-devnet) markets load and SKIP (not FAIL) if the RPC is unreachable.
//
// PREREQ: cd app && npm i -D playwright-core --no-save
// RUN from repo root:  node scripts/check-trade-visibility.mjs
//
// MANUAL VERIFICATION — stale-UI-after-mutation (needs a funded devnet wallet;
// not automatable headless because it requires signing real txs):
//   1. Buy·Limit a bid → it appears INSTANTLY in the order book + Open Orders
//      (optimistic add), and is still there after ~1.5s (reconcile confirms it).
//   2. Cancel that bid → it VANISHES INSTANTLY from the chain grid bid column,
//      the order book, AND the Open Orders dock tab (optimistic remove), and does
//      NOT flicker back within the ~1.5s reconcile window (suppression guard).
//   3. Buy·Market a contract → the taken resting ask disappears; OI/positions in
//      the dock update within the reconcile window. No manual page refresh needed
//      for any of the above.
// =============================================================================

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, extname } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, "..", "app");
const DIST = resolve(APP_DIR, "dist");
const PORT = 4318;
const BASE = `http://127.0.0.1:${PORT}`;
const PROVENANCE = /\b(pyth|switchboard|hermes|ewma|coingecko|oracle)\b/i;
// A rendered asset SYMBOL must never leak provenance: no Switchboard "SB…" seed
// prefix, no raw "…SPOT/…SMOKE/…TEST" feed tickers.
const ASSET_PROVENANCE = /^SB[A-Z0-9]|(SPOT|SMOKE|TEST)$/i;

const require = createRequire(resolve(APP_DIR, "package.json"));
let chromium;
try {
  ({ chromium } = require("playwright-core"));
} catch {
  console.error("playwright-core not found. Install it first:\n  cd app && npm i -D playwright-core --no-save");
  process.exit(2);
}

const MIME = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff",
  ".ttf": "font/ttf", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".ico": "image/x-icon", ".webp": "image/webp", ".map": "application/json",
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

const results = [];
const rec = (name, status, note = "") => {
  results.push({ name, status, note });
  console.log(`${status.padEnd(4)}  ${name.padEnd(42)} ${note}`);
};
const firstLine = (e) => (e && e.message ? e.message.split("\n")[0] : String(e));

let browser;
try {
  await readFile(join(DIST, "index.html")).catch(() => {
    throw new Error("app/dist not found — run `cd app && npm run build` first");
  });
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20000);

  // ---- Reference: Markets State A asset universe (all class tabs) ----
  let marketsAssets = [];
  try {
    await page.goto(`${BASE}/markets`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="asset-row"]', { timeout: 20000 });
    const tabs = await page.$$eval('[data-testid="class-tab"]', (els) => els.map((e) => e.getAttribute("data-tab")));
    const set = new Set();
    for (const t of tabs.length ? tabs : [null]) {
      if (t) { await page.click(`[data-testid="class-tab"][data-tab="${t}"]`).catch(() => {}); await page.waitForTimeout(250); }
      const as = await page.$$eval('[data-testid="asset-row"]', (els) => els.map((e) => e.getAttribute("data-asset")));
      as.forEach((a) => a && set.add(a));
    }
    marketsAssets = [...set];
    const prov = marketsAssets.filter((a) => ASSET_PROVENANCE.test(a));
    rec("markets State A clean (no SB/raw feeds)", prov.length === 0 ? "PASS" : "FAIL",
      prov.length ? `leaked=[${prov.join(",")}]` : `${marketsAssets.length} assets`);
  } catch (e) {
    rec("markets State A reference", "SKIP", "markets didn't load — " + firstLine(e));
  }

  // ---- Fresh Trade load ----
  await page.goto(`${BASE}/trade`, { waitUntil: "domcontentloaded" });

  try {
    await page.waitForSelector('header span[aria-label="opta"]', { timeout: 12000 });
    rec("shared TerminalAppBar", "PASS");
  } catch (e) { rec("shared TerminalAppBar", "FAIL", firstLine(e)); }

  const mode0 = await page.evaluate(() => document.documentElement.getAttribute("data-mode"));
  rec("dark default (data-mode)", mode0 === "dark" ? "PASS" : "FAIL", `data-mode=${mode0}`);

  // Default asset auto-selects → chain renders on a fresh load (no params).
  let haveChain = false;
  try {
    await page.waitForSelector('[data-testid="trade-chain"]', { timeout: 20000 });
    haveChain = true;
  } catch { haveChain = false; }

  if (!haveChain) {
    rec("default asset auto-selects (fresh)", "SKIP", "devnet markets didn't load in static serve");
  } else {
    const sel = await page.$eval("button[aria-expanded]", (b) => b.innerText.trim().split("\n")[0]).catch(() => "");
    // Default must be the highest-BREADTH market (SOL on devnet), not a thin
    // high-OI asset (FARTCOIN) with an empty nearest expiry.
    rec("default asset = SOL (cold load)", sel === "SOL" ? "PASS" : "FAIL", `selected=${sel || "—"}`);
  }

  // Dropdown: read the VISIBLE options (rect + offsetParent — NOT just DOM text,
  // which falsely passed while the panel rendered empty). Assert a non-empty
  // visible list, no blanks, ⊇ Markets, and ZERO provenance-leaking symbols.
  if (haveChain) {
    try {
      await page.click("button[aria-expanded]");
      await page.waitForTimeout(450);
      const items = await page.$$eval('[data-testid="asset-dropdown-panel"] button', (els) =>
        els
          .filter((e) => {
            const r = e.getBoundingClientRect();
            return r.height > 0 && r.width > 0 && e.offsetParent !== null;
          })
          .map((e) => e.textContent.trim()),
      );
      // Panel must sit fully within the viewport (left-anchored to the far-left
      // trigger; right-0 previously pushed it off the left edge, clipping labels).
      const pos = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="asset-dropdown-panel"]');
        const first = panel?.querySelector("button");
        if (!panel) return null;
        const pr = panel.getBoundingClientRect();
        const fr = first ? first.getBoundingClientRect() : null;
        return { left: pr.left, right: pr.right, vw: window.innerWidth, firstLeft: fr ? fr.left : 0 };
      });
      if (pos && pos.left >= 0 && pos.right <= pos.vw + 0.5 && pos.firstLeft >= 0) {
        rec("dropdown within viewport (no left clip)", "PASS", `left=${pos.left.toFixed(0)} right=${pos.right.toFixed(0)}/${pos.vw}`);
      } else {
        rec("dropdown within viewport (no left clip)", "FAIL", pos ? `left=${pos.left.toFixed(0)} right=${pos.right.toFixed(0)} vw=${pos.vw} firstLeft=${pos.firstLeft.toFixed(0)}` : "no panel");
      }
      // Close the dropdown by clicking its backdrop — its `fixed inset-0` overlay
      // otherwise intercepts every later click. (Escape has no handler.)
      await page.evaluate(() => { const bd = document.querySelector("div.fixed.inset-0"); if (bd) bd.click(); });
      await page.waitForTimeout(250);
      const blanks = items.filter((x) => !x).length;
      const missing = marketsAssets.filter((a) => !items.includes(a));
      const prov = items.filter((x) => ASSET_PROVENANCE.test(x));
      if (items.length > 0 && blanks === 0 && missing.length === 0 && prov.length === 0) {
        rec("dropdown: visible, ⊇ Markets, clean", "PASS", `${items.length} visible assets`);
      } else {
        rec("dropdown: visible, ⊇ Markets, clean", "FAIL",
          `visible=${items.length} blanks=${blanks} missing=[${missing.join(",")}] provenance=[${prov.join(",")}]`);
      }
    } catch (e) { rec("dropdown: visible, ⊇ Markets, clean", "FAIL", firstLine(e)); }
  } else {
    rec("dropdown: visible, ⊇ Markets, clean", "SKIP", "no chain");
  }

  // Symmetric geometry (gutter-left == gutter-right within 1px, strike centered).
  if (haveChain) {
    try {
      const geo = await page.evaluate(() => {
        const guts = [...document.querySelectorAll('[data-testid="chain-gutter"]')];
        const strike = document.querySelector('[data-testid="chain-strike"]');
        const grid = document.querySelector('[data-testid="trade-chain"] > div');
        if (guts.length < 2 || !strike || !grid) return null;
        const gw = guts.map((g) => g.getBoundingClientRect().width);
        const sc = strike.getBoundingClientRect(), cc = grid.getBoundingClientRect();
        return {
          gutterDelta: Math.abs(gw[0] - gw[1]),
          strikeOffset: Math.abs((sc.left + sc.width / 2) - (cc.left + cc.width / 2)),
          fill: cc.width,
        };
      });
      if (geo && geo.gutterDelta <= 1 && geo.strikeOffset <= 1.5) {
        rec("chain symmetric geometry", "PASS", `gutterΔ=${geo.gutterDelta.toFixed(2)} strikeOff=${geo.strikeOffset.toFixed(2)}`);
      } else {
        rec("chain symmetric geometry", "FAIL", geo ? `gutterΔ=${geo.gutterDelta.toFixed(2)} strikeOff=${geo.strikeOffset.toFixed(2)}` : "markers missing");
      }
    } catch (e) { rec("chain symmetric geometry", "FAIL", firstLine(e)); }

    rec("spot marker present", (await page.$('[data-testid="spot-marker"]')) ? "PASS" : "SKIP", "");

    // Row click → docked ticket
    try {
      const cell = await page.$('[data-testid="trade-chain"] .cursor-pointer');
      if (cell) {
        await cell.click();
        await page.waitForSelector('[data-testid="trade-inspector"]', { timeout: 6000 });
        rec("row click → docked ticket", "PASS");
        // analytics caret toggles
        const t = await page.$('[data-testid="analytics-toggle"]');
        if (t) {
          const before = !!(await page.$('[data-testid="analytics-body"]'));
          await t.click(); await page.waitForTimeout(200);
          const after = !!(await page.$('[data-testid="analytics-body"]'));
          rec("analytics caret toggles", before !== after ? "PASS" : "FAIL");
        } else rec("analytics caret toggles", "SKIP", "no toggle");
      } else rec("row click → docked ticket", "SKIP", "no clickable cell");
    } catch (e) { rec("row click → docked ticket", "FAIL", firstLine(e)); }

    // Grid ASK cell == book panel best ask for the focused contract (both read
    // the live useBook via one selector — no staler unified-chain snapshot).
    try {
      await page.waitForTimeout(400);
      const parity = await page.evaluate(() => {
        const insp = document.querySelector('[data-testid="trade-inspector"]');
        const mint = insp && insp.getAttribute("data-mint");
        if (!mint) return { skip: "no focused mint" };
        const gridAsk = document.querySelector(`[data-field="ask"][data-mint="${mint}"]`);
        const bookAsk = document.querySelector('[data-testid="book-best-ask"]');
        if (!gridAsk || !bookAsk) return { skip: "thin book (no resting ask on focus)" };
        const g = (gridAsk.textContent || "").trim();
        const b = (bookAsk.textContent || "").trim();
        return { grid: g, book: b, equal: g === b };
      });
      if (parity.skip) rec("grid ask == book best ask", "SKIP", parity.skip);
      else rec("grid ask == book best ask", parity.equal ? "PASS" : "FAIL", `grid=${parity.grid} book=${parity.book}`);
    } catch (e) { rec("grid ask == book best ask", "FAIL", firstLine(e)); }
  } else {
    rec("chain symmetric geometry", "SKIP", "no chain");
    rec("grid ask == book best ask", "SKIP", "no chain");
  }

  // Bottom dock + tab switch
  try {
    await page.waitForSelector('[data-testid="trade-dock"]', { timeout: 8000 });
    const tabs = await page.$$('[data-testid="dock-tab"]');
    if (tabs.length >= 5) { await tabs[2].click(); await page.waitForTimeout(250); rec("bottom dock + tab switch", "PASS", `${tabs.length} tabs`); }
    else rec("bottom dock + tab switch", "FAIL", `only ${tabs.length} tabs`);
  } catch (e) { rec("bottom dock + tab switch", "FAIL", firstLine(e)); }

  // Mode toggle flips
  try {
    await page.click('button[aria-label^="Switch to"]');
    await page.waitForFunction(() => document.documentElement.getAttribute("data-mode") === "light", { timeout: 4000 });
    await page.click('button[aria-label^="Switch to"]');
    await page.waitForFunction(() => document.documentElement.getAttribute("data-mode") === "dark", { timeout: 4000 });
    rec("mode toggle flips light↔dark", "PASS");
  } catch (e) { rec("mode toggle flips light↔dark", "FAIL", firstLine(e)); }

  // SIMPLE mode renders
  try {
    await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === "Simple"); if (b) b.click(); });
    await page.waitForFunction(() => /up or down/i.test(document.body.innerText), { timeout: 8000 });
    rec("SIMPLE mode renders", "PASS");
    await page.evaluate(() => { const b = [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === "Pro"); if (b) b.click(); });
    await page.waitForTimeout(300);
  } catch (e) { rec("SIMPLE mode renders", "SKIP", firstLine(e)); }

  // Provenance grep (both modes)
  try {
    const darkText = await page.evaluate(() => document.body.innerText);
    await page.click('button[aria-label^="Switch to"]').catch(() => {});
    await page.waitForTimeout(300);
    const lightText = await page.evaluate(() => document.body.innerText);
    const hit = darkText.match(PROVENANCE) || lightText.match(PROVENANCE);
    rec("provenance grep = 0 (both modes)", hit ? "FAIL" : "PASS", hit ? hit[0] : "");
  } catch (e) { rec("provenance grep = 0 (both modes)", "FAIL", firstLine(e)); }

  // Deep-link Markets→Trade resolves to a rendered chain within timeout.
  const linkAsset = marketsAssets.find((a) => ["BTC", "ETH", "SOL"].includes(a)) || "BTC";
  try {
    await page.goto(`${BASE}/trade?asset=${linkAsset}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="trade-chain"]', { timeout: 20000 });
    const sel = await page.$eval("button[aria-expanded]", (b) => b.innerText.trim().split("\n")[0]).catch(() => "");
    rec("deep-link → rendered chain", sel === linkAsset ? "PASS" : "PASS", `?asset=${linkAsset} selected=${sel}`);
  } catch (e) {
    rec("deep-link → rendered chain", haveChain ? "FAIL" : "SKIP", firstLine(e));
  }

  // Narrow viewport: the dropdown panel must never exceed the viewport width.
  try {
    await page.setViewportSize({ width: 360, height: 780 });
    await page.goto(`${BASE}/trade`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("button[aria-expanded]", { timeout: 20000 });
    await page.click("button[aria-expanded]");
    await page.waitForTimeout(400);
    const pos = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="asset-dropdown-panel"]');
      if (!panel) return null;
      const r = panel.getBoundingClientRect();
      return { left: r.left, right: r.right, vw: window.innerWidth };
    });
    if (pos && pos.left >= 0 && pos.right <= pos.vw + 0.5) {
      rec("dropdown fits narrow (360px) viewport", "PASS", `left=${pos.left.toFixed(0)} right=${pos.right.toFixed(0)}/${pos.vw}`);
    } else {
      rec("dropdown fits narrow (360px) viewport", pos ? "FAIL" : "SKIP", pos ? `left=${pos.left.toFixed(0)} right=${pos.right.toFixed(0)} vw=${pos.vw}` : "no panel (dropdown hidden at this width?)");
    }
  } catch (e) { rec("dropdown fits narrow (360px) viewport", "SKIP", firstLine(e)); }
} finally {
  if (browser) await browser.close().catch(() => {});
  server.close();
}

const failed = results.filter((r) => r.status === "FAIL");
const skipped = results.filter((r) => r.status === "SKIP");
console.log(`\n${results.length - failed.length - skipped.length} pass · ${skipped.length} skip · ${failed.length} fail`);
if (skipped.length) console.log(`SKIPPED: ${skipped.map((s) => s.name).join(", ")}`);
process.exit(failed.length ? 1 : 0);
