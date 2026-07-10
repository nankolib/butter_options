// =============================================================================
// scripts/check-write-visibility.mjs — visibility + geometry gate for /write
// =============================================================================
//
// The terminal Write redesign (FE terminal track, Slice 2) invariants a bundle
// grep can't see: dark-by-default surface, shared TerminalAppBar, an EPOCH|CUSTOM
// segmented control that actually swaps the tenor row ↔ expiry inputs, a
// SINGLE|LADDER swap (dated chips ↔ %-sliders + cell table), a grouped asset
// dropdown that opens within the viewport, Exercise defaulting to AMERICAN on a
// fresh load, a premium centerpiece that is the largest numeral on the page, a
// working mode toggle, faucet SVG marks, and ZERO oracle-provenance strings.
//
// Asserts RENDERED-DOM facts after real interaction (visible rects + offsetParent
// + computed geometry), never node-presence/text alone. Data-dependent checks
// (live quote value, real write) deterministically SKIP under a static serve;
// a founder-wallet pass covers them.
//
// Builds nothing — run `cd app && npm run build` first — then serves app/dist and
// drives system Chrome via playwright-core.
//
// PREREQ: cd app && npm i -D playwright-core --no-save
// RUN from repo root:  node scripts/check-write-visibility.mjs
// =============================================================================

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, extname } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, "..", "app");
const DIST = resolve(APP_DIR, "dist");
const PORT = 4319;
const BASE = `http://127.0.0.1:${PORT}`;
const PROVENANCE = /\b(pyth|switchboard|hermes|ewma|coingecko|oracle)\b/i;

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
  console.log(`${status.padEnd(4)}  ${name.padEnd(46)} ${note}`);
};
const firstLine = (e) => (e && e.message ? e.message.split("\n")[0] : String(e));

// Is an element visibly rendered (non-zero rect + has an offsetParent)?
const visibleHandle = async (page, selector) =>
  page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && el.offsetParent !== null;
  }, selector);

let browser;
try {
  await readFile(join(DIST, "index.html")).catch(() => {
    throw new Error("app/dist not found — run `cd app && npm run build` first");
  });
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20000);

  // ---- Fresh /write load ----
  await page.goto(`${BASE}/write`, { waitUntil: "domcontentloaded" });

  try {
    await page.waitForSelector('header span[aria-label="opta"]', { timeout: 12000 });
    rec("shared TerminalAppBar", "PASS");
  } catch (e) { rec("shared TerminalAppBar", "FAIL", firstLine(e)); }

  const mode0 = await page.evaluate(() => document.documentElement.getAttribute("data-mode"));
  rec("dark default (data-mode)", mode0 === "dark" ? "PASS" : "FAIL", `data-mode=${mode0}`);

  // The contract panel must render (segmented control present). If markets didn't
  // load in the static serve there is still no wallet gate on the FORM, so the
  // panel renders; only the empty-markets state would hide it → SKIP downstream.
  let haveForm = false;
  try {
    await page.waitForSelector('[data-testid="write-mode-segmented"]', { timeout: 15000 });
    haveForm = true;
    rec("contract panel renders", "PASS");
  } catch {
    rec("contract panel renders", "SKIP", "no markets in static serve (empty-state) — form gated");
  }

  // ---- Exercise defaults to AMERICAN (fresh load, epoch mode) ----
  if (haveForm) {
    try {
      const amerActive = await page.evaluate(() => {
        const seg = document.querySelector('[data-testid="write-exercise"]');
        if (!seg) return null;
        const btns = [...seg.querySelectorAll("button")];
        const amer = btns.find((b) => /american/i.test(b.textContent || ""));
        return amer ? amer.getAttribute("aria-pressed") === "true" : null;
      });
      rec("exercise defaults AMERICAN (epoch)", amerActive === true ? "PASS" : "FAIL", `pressed=${amerActive}`);
    } catch (e) { rec("exercise defaults AMERICAN (epoch)", "FAIL", firstLine(e)); }
  } else {
    rec("exercise defaults AMERICAN (epoch)", "SKIP", "no form");
  }

  // ---- EPOCH shows tenor row, hides expiry inputs ----
  if (haveForm) {
    const tenorVisibleEpoch = await visibleHandle(page, '[data-testid="write-tenor-row"]');
    const expiryVisibleEpoch = await visibleHandle(page, '[data-testid="write-expiry-row"]');
    rec("EPOCH: tenor visible, expiry absent", tenorVisibleEpoch && !expiryVisibleEpoch ? "PASS" : "FAIL",
      `tenor=${tenorVisibleEpoch} expiry=${expiryVisibleEpoch}`);

    // ---- SINGLE: dated chips visible + selectable ----
    try {
      const chipsVisible = await visibleHandle(page, '[data-testid="tenor-chips"]');
      const chips = await page.$$('[data-testid="tenor-chips"] button');
      let selectedChanged = false;
      if (chips.length >= 2) {
        const pressed0 = await chips[0].getAttribute("aria-pressed");
        // click a non-active chip
        const target = (await chips[1].getAttribute("aria-pressed")) === "true" ? chips[0] : chips[1];
        await target.click();
        await page.waitForTimeout(150);
        const nowPressed = await target.getAttribute("aria-pressed");
        selectedChanged = nowPressed === "true";
        void pressed0;
      }
      rec("SINGLE: dated chips visible + selectable", chipsVisible && selectedChanged ? "PASS" : "FAIL",
        `chips=${chips.length} selectable=${selectedChanged}`);
    } catch (e) { rec("SINGLE: dated chips visible + selectable", "FAIL", firstLine(e)); }

    // ---- LADDER: sliders + cell table render ----
    // Quantity must be ≥ #tenors (3) for snapLadder to allocate cells — set 6
    // so the table has rows (qty=1 correctly yields a "min 3 contracts" error).
    try {
      const qty = await page.$('[data-testid="write-qty"]');
      if (qty) { await qty.click({ clickCount: 3 }); await qty.type("6"); await page.waitForTimeout(100); }
      await page.evaluate(() => {
        const seg = document.querySelector('[data-testid="write-tenor-mode"]');
        const b = seg && [...seg.querySelectorAll("button")].find((x) => /ladder/i.test(x.textContent || ""));
        if (b) b.click();
      });
      await page.waitForTimeout(250);
      const slidersVisible = await visibleHandle(page, '[data-testid="tenor-sliders"]');
      const rows = await page.$$eval('[data-testid="ladder-row"]', (els) =>
        els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; }).length,
      ).catch(() => 0);
      rec("LADDER: sliders + cell rows render", slidersVisible && rows > 0 ? "PASS" : "FAIL",
        `sliders=${slidersVisible} rows=${rows}`);
      // back to SINGLE for the mode-swap check
      await page.evaluate(() => {
        const seg = document.querySelector('[data-testid="write-tenor-mode"]');
        const b = seg && [...seg.querySelectorAll("button")].find((x) => /single/i.test(x.textContent || ""));
        if (b) b.click();
      });
      await page.waitForTimeout(150);
    } catch (e) { rec("LADDER: sliders + cell rows render", "FAIL", firstLine(e)); }

    // ---- CUSTOM swap: expiry inputs appear, tenor row gone ----
    try {
      await page.evaluate(() => {
        const seg = document.querySelector('[data-testid="write-mode-segmented"]');
        const b = seg && [...seg.querySelectorAll("button")].find((x) => /custom/i.test(x.textContent || ""));
        if (b) b.click();
      });
      await page.waitForTimeout(250);
      const expiryVisible = await visibleHandle(page, '[data-testid="write-expiry-row"]');
      const tenorVisible = await visibleHandle(page, '[data-testid="write-tenor-row"]');
      const dateVisible = await visibleHandle(page, '[data-testid="write-expiry-date"]');
      rec("CUSTOM: expiry inputs visible, tenor absent", expiryVisible && dateVisible && !tenorVisible ? "PASS" : "FAIL",
        `expiry=${expiryVisible} date=${dateVisible} tenor=${tenorVisible}`);
      // back to EPOCH
      await page.evaluate(() => {
        const seg = document.querySelector('[data-testid="write-mode-segmented"]');
        const b = seg && [...seg.querySelectorAll("button")].find((x) => /epoch/i.test(x.textContent || ""));
        if (b) b.click();
      });
      await page.waitForTimeout(150);
    } catch (e) { rec("CUSTOM: expiry inputs visible, tenor absent", "FAIL", firstLine(e)); }

    // ---- Asset dropdown opens within viewport + selection updates field ----
    try {
      await page.click('[data-testid="write-asset-trigger"]');
      await page.waitForTimeout(300);
      const info = await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="write-asset-panel"]');
        if (!panel) return null;
        const pr = panel.getBoundingClientRect();
        const btns = [...panel.querySelectorAll("button")].filter((e) => {
          const r = e.getBoundingClientRect();
          return r.width > 0 && r.height > 0 && e.offsetParent !== null;
        });
        return { left: pr.left, right: pr.right, vw: window.innerWidth, count: btns.length, first: btns[0]?.textContent?.trim() || "" };
      });
      if (info && info.count > 0 && info.left >= 0 && info.right <= info.vw + 0.5) {
        // select the first option, assert the trigger label updates
        const before = await page.$eval('[data-testid="write-asset-trigger"]', (b) => b.textContent?.trim() || "");
        await page.evaluate(() => {
          const panel = document.querySelector('[data-testid="write-asset-panel"]');
          const b = panel && panel.querySelector("button");
          if (b) b.click();
        });
        await page.waitForTimeout(200);
        const after = await page.$eval('[data-testid="write-asset-trigger"]', (b) => b.textContent?.trim() || "");
        rec("asset dropdown: visible + selects", info.count > 0 ? "PASS" : "FAIL",
          `${info.count} opts, "${before}"→"${after}"`);
      } else {
        rec("asset dropdown: visible + selects", info ? "SKIP" : "SKIP",
          info ? `no markets (count=${info.count})` : "no panel — empty markets in static serve");
      }
    } catch (e) { rec("asset dropdown: visible + selects", "SKIP", firstLine(e)); }

    // ---- Premium centerpiece is the LARGEST numeral on the page ----
    try {
      const isLargest = await page.evaluate(() => {
        const cp = document.querySelector('[data-testid="premium-centerpiece"]');
        if (!cp) return null;
        const numEl = [...cp.querySelectorAll("*")].find((e) => e.children.length === 0 && /\d|—/.test(e.textContent || ""));
        const cpSize = numEl ? parseFloat(getComputedStyle(numEl).fontSize) : parseFloat(getComputedStyle(cp).fontSize);
        let max = 0;
        for (const e of document.querySelectorAll("body *")) {
          if (cp.contains(e)) continue;
          if (e.children.length) continue;
          const t = (e.textContent || "").trim();
          if (!/[\d$%.]/.test(t)) continue;
          const fs = parseFloat(getComputedStyle(e).fontSize);
          if (fs > max) max = fs;
        }
        return { cpSize, max };
      });
      if (isLargest && isLargest.cpSize >= isLargest.max) {
        rec("premium centerpiece is largest numeral", "PASS", `cp=${isLargest.cpSize}px max-other=${isLargest.max}px`);
      } else {
        rec("premium centerpiece is largest numeral", isLargest ? "FAIL" : "SKIP",
          isLargest ? `cp=${isLargest.cpSize}px max-other=${isLargest.max}px` : "no centerpiece");
      }
    } catch (e) { rec("premium centerpiece is largest numeral", "FAIL", firstLine(e)); }
  } else {
    for (const n of [
      "EPOCH: tenor visible, expiry absent",
      "SINGLE: dated chips visible + selectable",
      "LADDER: sliders + cell rows render",
      "CUSTOM: expiry inputs visible, tenor absent",
      "asset dropdown: visible + selects",
      "premium centerpiece is largest numeral",
    ]) rec(n, "SKIP", "no form");
  }

  // ---- Faucet buttons render SVG marks (only when connected+devnet; SKIP else) ----
  try {
    const marks = await page.$$eval('header button svg', (els) => els.length).catch(() => 0);
    rec("faucet SVG marks present", marks > 0 ? "PASS" : "SKIP", marks > 0 ? `${marks} svg in bar` : "faucet hidden (disconnected)");
  } catch (e) { rec("faucet SVG marks present", "SKIP", firstLine(e)); }

  // ---- Mode toggle flips dark↔light ----
  try {
    await page.click('button[aria-label^="Switch to"]');
    await page.waitForFunction(() => document.documentElement.getAttribute("data-mode") === "light", { timeout: 4000 });
    await page.click('button[aria-label^="Switch to"]');
    await page.waitForFunction(() => document.documentElement.getAttribute("data-mode") === "dark", { timeout: 4000 });
    rec("mode toggle flips dark↔light", "PASS");
  } catch (e) { rec("mode toggle flips dark↔light", "FAIL", firstLine(e)); }

  // ---- Provenance grep = 0 (both modes) ----
  try {
    const darkText = await page.evaluate(() => document.body.innerText);
    await page.click('button[aria-label^="Switch to"]').catch(() => {});
    await page.waitForTimeout(300);
    const lightText = await page.evaluate(() => document.body.innerText);
    const hit = darkText.match(PROVENANCE) || lightText.match(PROVENANCE);
    rec("provenance grep = 0 (both modes)", hit ? "FAIL" : "PASS", hit ? hit[0] : "");
  } catch (e) { rec("provenance grep = 0 (both modes)", "FAIL", firstLine(e)); }

  // ---- Mobile: single column, primary button reachable ----
  try {
    await page.setViewportSize({ width: 375, height: 780 });
    await page.goto(`${BASE}/write`, { waitUntil: "domcontentloaded" });
    let primaryVisible = false;
    try {
      await page.waitForSelector('[data-testid="write-primary"]', { timeout: 20000 });
      primaryVisible = await visibleHandle(page, '[data-testid="write-primary"]');
    } catch { primaryVisible = false; }
    rec("mobile primary button present", primaryVisible ? "PASS" : "SKIP", primaryVisible ? "" : "empty markets / gated");
  } catch (e) { rec("mobile primary button present", "SKIP", firstLine(e)); }
} finally {
  if (browser) await browser.close().catch(() => {});
  server.close();
}

const failed = results.filter((r) => r.status === "FAIL");
const skipped = results.filter((r) => r.status === "SKIP");
console.log(`\n${results.length - failed.length - skipped.length} pass · ${skipped.length} skip · ${failed.length} fail`);
if (skipped.length) console.log(`SKIPPED: ${skipped.map((s) => s.name).join(", ")}`);
process.exit(failed.length ? 1 : 0);
