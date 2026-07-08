// =============================================================================
// scripts/check-markets-visibility.mjs — visibility gate for the /markets terminal
// =============================================================================
//
// Sibling of check-landing-visibility.mjs / check-docs-visibility.mjs. The
// terminal Markets surface is DATA-DRIVEN (real devnet vaults) and TWO-LEVEL
// (State A assets → State B contracts → inspector), so presence in the bundle
// proves nothing. This drives a real browser against the built dist and asserts:
//   • default mode = dark; light↔dark toggle flips html[data-mode] + bg
//   • State A renders ≥1 live asset row; class tabs filter
//   • asset row → State B renders ≥1 live contract row (grouped by expiry)
//   • expiry chip filters; "Settled & expired" collapse expands (if any exist)
//   • a live contract row opens the inspector with a real premium centerpiece
//   • ORACLE PROVENANCE is absent from the rendered DOM (pyth/switchboard/hermes)
//     across State A, State B, and the inspector — in BOTH modes
//
// Needs live devnet reads (the dist connects to its baked RPC). PREREQ:
//     cd app && npm i -D playwright-core --no-save
// RUN from repo root (after `cd app && npm run build`):
//     node scripts/check-markets-visibility.mjs
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

const require = createRequire(resolve(APP_DIR, "package.json"));
let chromium;
try {
  ({ chromium } = require("playwright-core"));
} catch {
  console.error("playwright-core not found. Install it first:\n  cd app && npm i -D playwright-core --no-save");
  process.exit(2);
}

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
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(48)} ${detail}`);
};

// Oracle-provenance terms that must NEVER appear in the rendered surface.
const scanProvenance = async (page, tag) => {
  const hit = await page.evaluate(() => {
    const html = document.body.innerHTML;
    const text = document.body.innerText;
    const re = /pyth|switchboard|hermes|chainlink/i;
    const m = html.match(re) || text.match(re);
    return m ? m[0] : null;
  });
  record(`provenance clean · ${tag}`, hit === null, hit ? `FOUND "${hit}"` : "none");
};

let browser;
try {
  await readFile(join(DIST, "index.html")).catch(() => {
    throw new Error("app/dist not found — run `cd app && npm run build` first");
  });
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });

  await page.goto(BASE + "/markets", { waitUntil: "networkidle", timeout: 30000 });
  await page.waitForSelector('[data-testid="markets-terminal"]', { timeout: 15000 });

  // --- default mode = dark ---------------------------------------------------
  const readMode = () => page.evaluate(() => ({
    mode: document.documentElement.getAttribute("data-mode"),
    bg: getComputedStyle(document.documentElement).backgroundColor,
  }));
  const dark = await readMode();
  record("default mode = dark", dark.mode === "dark", `data-mode=${dark.mode} bg=${dark.bg}`);

  // --- State A: wait for live asset rows (data-driven) -----------------------
  await page.waitForFunction(
    () => {
      const t = document.querySelector('[data-testid="markets-terminal"]');
      return t?.getAttribute("data-loading") === "0" &&
        document.querySelectorAll('[data-testid="asset-row"]').length > 0;
    },
    { timeout: 30000 },
  ).catch(() => {});
  const assetCount = await page.$$eval('[data-testid="asset-row"]', (els) => els.length);
  record("State A ≥1 live asset row", assetCount > 0, `${assetCount} rows`);

  // --- class tabs filter (Crypto expected to have data) ----------------------
  const tabs = await page.$$eval('[data-testid="class-tab"]', (els) => els.map((e) => e.getAttribute("data-tab")));
  record("4 class tabs present", tabs.length === 4, tabs.join(","));
  await page.click('[data-testid="class-tab"][data-tab="Crypto"]');
  await page.waitForTimeout(200);
  const cryptoRows = await page.$$eval('[data-testid="asset-row"]', (els) => els.map((e) => e.getAttribute("data-asset")));
  record("Crypto tab shows rows", cryptoRows.length > 0, cryptoRows.join(","));

  await scanProvenance(page, "State A · dark");

  // --- asset row → State B ---------------------------------------------------
  await page.click('[data-testid="asset-row"]');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="markets-terminal"]')?.getAttribute("data-view") === "contracts",
    { timeout: 8000 },
  );
  await page.waitForSelector('[data-testid="contract-row"]', { timeout: 15000 }).catch(() => {});
  const liveContracts = await page.$$eval('[data-testid="contract-row"][data-settled="0"]', (els) => els.length);
  record("State B ≥1 live contract row", liveContracts > 0, `${liveContracts} live`);

  // --- expiry chip filter + STICKY REGRESSION --------------------------------
  // Repro: from a DEEP scroll position, clicking a chip that shrinks the list must
  // not strand a stale scrollTop (which half-clips the pulse tiles under the
  // sticky bar). Acceptance: scrollTop resets to 0 and the tile row is fully
  // visible (its top not scrolled above the scroll-body's top edge).
  const chipCount = await page.$$eval('[data-testid="expiry-chip"]', (els) => els.length);
  if (chipCount > 0) {
    // Scroll the body deep first.
    await page.evaluate(() => {
      const el = document.querySelector('[data-testid="scroll-body"]');
      if (el) el.scrollTop = el.scrollHeight;
    });
    await page.waitForTimeout(150);
    const scrolledTo = await page.$eval('[data-testid="scroll-body"]', (el) => el.scrollTop);
    const before = await page.$$eval('[data-testid="contract-row"][data-settled="0"]', (e) => e.length);
    // Click the 10 JUL chip specifically (the reported repro), fall back to first.
    await page.evaluate(() => {
      const chips = [...document.querySelectorAll('[data-testid="expiry-chip"]')];
      const jul = chips.find((c) => c.textContent.trim() === "10 JUL") || chips[0];
      jul && jul.click();
    });
    await page.waitForTimeout(250);
    const after = await page.$$eval('[data-testid="contract-row"][data-settled="0"]', (e) => e.length);
    record("expiry chip filters", after > 0 && after <= before, `${before} → ${after}`);

    const geo = await page.evaluate(() => {
      const body = document.querySelector('[data-testid="scroll-body"]');
      const tiles = document.querySelector('[data-testid="pulse-tiles"]');
      const b = body.getBoundingClientRect();
      const t = tiles.getBoundingClientRect();
      return { scrollTop: body.scrollTop, clippedBy: Math.round(b.top - t.top), tilesH: Math.round(t.height) };
    });
    // scrollTop 0 (reset) + top not clipped + tiles NOT flex-compressed (full
    // height ≥ ~120px — a tall table must not shrink the tile row).
    const stickyOk = geo.scrollTop === 0 && geo.clippedBy <= 1 && geo.tilesH >= 120;
    record("sticky: chip resets scroll, tiles unclipped", stickyOk, `scrolledTo=${scrolledTo} → scrollTop=${geo.scrollTop}, clip=${geo.clippedBy}px, tilesH=${geo.tilesH}px`);
  } else {
    record("expiry chip filters", true, "single expiry — chip row collapses to All (skip)");
    record("sticky: chip resets scroll, tiles unclipped", true, "single expiry (skip)");
  }

  // --- settled & expired collapse (conditional) ------------------------------
  const hasSettledToggle = (await page.$('[data-testid="settled-toggle"]')) !== null;
  if (hasSettledToggle) {
    await page.click('[data-testid="settled-toggle"]');
    await page.waitForTimeout(250);
    const settledRows = await page.$$eval('[data-testid="contract-row"][data-settled="1"]', (e) => e.length);
    record("settled collapse expands", settledRows > 0, `${settledRows} settled rows`);
    await page.click('[data-testid="settled-toggle"]'); // collapse back
    await page.waitForTimeout(150);
  } else {
    record("settled collapse expands", true, "no settled/expired for this asset (skip)");
  }

  await scanProvenance(page, "State B · dark");

  // --- inspector: open a LIVE contract, expect a real premium centerpiece ----
  await page.click('[data-testid="contract-row"][data-settled="0"]');
  await page.waitForSelector('[data-testid="inspector"]', { timeout: 8000 });
  const inspText = await page.$eval('[data-testid="inspector"]', (el) => el.innerText);
  record("inspector opens (live centerpiece)", /Premium \/ contract/i.test(inspText), inspText.split("\n").slice(0, 2).join(" · "));
  // Wait for the on-chain quote to resolve to a numeric premium (RFQ sim).
  const premiumOk = await page
    .waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="inspector"]');
        if (!el) return false;
        const t = el.innerText;
        if (!/Premium \/ contract/i.test(t)) return false;
        // A resolved premium prints a number before "USDC" and isn't the em-dash placeholder.
        const m = t.match(/([\d.,]+)\s*\n?\s*USDC/);
        return !!m && /\d/.test(m[1]);
      },
      { timeout: 25000 },
    )
    .then(() => true)
    .catch(() => false);
  const premiumVal = await page.$eval('[data-testid="inspector"]', (el) => {
    const m = el.innerText.match(/([\d.,]+)\s*\n?\s*USDC/);
    return m ? m[1] : "—";
  });
  record("inspector premium resolves (real)", premiumOk, `premium=${premiumVal} USDC`);

  await scanProvenance(page, "inspector · dark");

  // Close the inspector (its overlay covers the appbar, so the mode toggle isn't
  // clickable while it's open) by clicking the overlay backdrop.
  await page.evaluate(() => {
    const ov = document.querySelector('[data-testid="inspector"]')?.parentElement;
    ov?.click();
  });
  await page.waitForSelector('[data-testid="inspector"]', { state: "detached", timeout: 4000 }).catch(() => {});

  // --- toggle to light -------------------------------------------------------
  await page.click('button[aria-label*="mode"]');
  await page.waitForFunction(
    () => document.documentElement.getAttribute("data-mode") === "light",
    { timeout: 3000 },
  );
  const light = await readMode();
  record("toggle → light (bg flips)", light.mode === "light" && light.bg !== dark.bg, `data-mode=${light.mode} bg=${light.bg}`);

  // scan State B in light, then reopen the inspector in light and scan it
  await scanProvenance(page, "State B · light");
  await page.click('[data-testid="contract-row"][data-settled="0"]');
  await page.waitForSelector('[data-testid="inspector"]', { timeout: 8000 });
  await scanProvenance(page, "inspector · light");
} catch (e) {
  record("run", false, e && e.message ? e.message.split("\n")[0] : String(e));
} finally {
  if (browser) await browser.close().catch(() => {});
  server.close();
}

const failed = checks.filter((c) => !c.ok);
console.log(
  `\n${checks.length - failed.length}/${checks.length} checks passed.` +
    (failed.length ? `  FAILED: ${failed.map((f) => f.name).join(", ")}` : "  All green."),
);
process.exit(failed.length ? 1 : 0);
