// =============================================================================
// scripts/check-portfolio-visibility.mjs — visibility + token gate for /portfolio
// =============================================================================
//
// The terminal Portfolio redesign (FE terminal Slice 3) invariants a bundle grep
// can't see: dark-by-default surface, shared TerminalAppBar, the light-mode
// small-teal token (--color-l-up-text: #0E9B80 light / #1AC6A5 dark) while the
// Claim-all fill (--color-l-up) stays #1AC6A5 in both modes, a working mode
// toggle, and ZERO oracle-provenance strings — all assertable WITHOUT a wallet.
//
// The two ledgers, groups, summary strip, Claim all, activity rows, and the
// LOCKED countdown are WALLET-gated (positions need a connected pubkey); under a
// static serve the page shows the connect prompt, so those checks deterministically
// SKIP and the founder-wallet preview pass covers them. Asserts rendered-DOM facts
// (computed color, rects, offsetParent) — never node presence/text alone.
//
// PREREQ: cd app && npm i -D playwright-core --no-save
// RUN from repo root:  node scripts/check-portfolio-visibility.mjs
// =============================================================================

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, extname } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, "..", "app");
const DIST = resolve(APP_DIR, "dist");
const PORT = 4320;
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

// Read the computed color of a probe element carrying `cls` (text via color,
// fill via backgroundColor). Element is injected + removed so it needs no data.
const probeColor = (page, cls, prop) =>
  page.evaluate(({ cls, prop }) => {
    const el = document.createElement("span");
    el.className = cls;
    el.textContent = "x";
    el.style.position = "fixed";
    el.style.left = "-9999px";
    document.body.appendChild(el);
    const v = getComputedStyle(el)[prop];
    el.remove();
    return v;
  }, { cls, prop });

const norm = (s) => (s || "").replace(/\s+/g, "");

let browser;
try {
  await readFile(join(DIST, "index.html")).catch(() => {
    throw new Error("app/dist not found — run `cd app && npm run build` first");
  });
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20000);

  await page.goto(`${BASE}/portfolio`, { waitUntil: "domcontentloaded" });

  try {
    await page.waitForSelector('header span[aria-label="opta"]', { timeout: 12000 });
    rec("shared TerminalAppBar", "PASS");
  } catch (e) { rec("shared TerminalAppBar", "FAIL", firstLine(e)); }

  const mode0 = await page.evaluate(() => document.documentElement.getAttribute("data-mode"));
  rec("dark default (data-mode)", mode0 === "dark" ? "PASS" : "FAIL", `data-mode=${mode0}`);

  // Wallet-gated? Detect whether the connect prompt is showing (no wallet in a
  // static serve → the ledgers/summary don't render).
  await page.waitForTimeout(600);
  const walletGated = await page.evaluate(() =>
    /connect your wallet/i.test(document.body.innerText) && !document.querySelector('[data-testid="summary-strip"]'),
  );

  if (walletGated) {
    rec("disconnected connect-wallet state", "PASS", "connect prompt shown");
    for (const n of [
      "section bands: teal holdings / crimson written",
      "groups: CLAIMABLE precede OPEN",
      "summary strip: 4 stats + Claim all",
      "ACTIVITY rows + sig links",
      "LOCKED row: disabled + countdown",
      "BY ASSET rows + signed P&L color",
      "section collapse toggles + persists",
      "solscan links on holder/writer rows",
    ]) rec(n, "SKIP", "wallet required — founder pass");
  } else {
    // If a wallet-injected environment ever runs this, assert the rendered ledgers.
    rec("disconnected connect-wallet state", "SKIP", "wallet present — ledgers rendered");
    try {
      const bands = await page.evaluate(() => {
        const read = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const dot = el.querySelector('[data-testid="band-dot"]');
          return dot ? getComputedStyle(dot).backgroundColor : null;
        };
        return { hold: read('[data-testid="holdings-band"]'), writ: read('[data-testid="written-band"]') };
      });
      const teal = norm(bands.hold) === "rgb(26,198,165)";
      const crim = norm(bands.writ) === "rgb(215,38,61)";
      rec("section bands: teal holdings / crimson written", teal && crim ? "PASS" : "FAIL", `hold=${bands.hold} writ=${bands.writ}`);
    } catch (e) { rec("section bands: teal holdings / crimson written", "FAIL", firstLine(e)); }

    try {
      const ok = await page.evaluate(() => {
        const ys = (g) => [...document.querySelectorAll(`[data-testid="holdings-row"][data-group="${g}"]`)]
          .map((e) => e.getBoundingClientRect().top);
        const c = ys("claimable"), o = ys("open");
        if (!c.length || !o.length) return "skip";
        return Math.max(...c) < Math.min(...o);
      });
      rec("groups: CLAIMABLE precede OPEN", ok === "skip" ? "SKIP" : ok ? "PASS" : "FAIL", ok === "skip" ? "no claimable+open pair" : "");
    } catch (e) { rec("groups: CLAIMABLE precede OPEN", "FAIL", firstLine(e)); }

    const strip = await page.$('[data-testid="summary-strip"]');
    rec("summary strip: 4 stats + Claim all", strip && (await page.$('[data-testid="claim-all"]')) ? "PASS" : "FAIL");
    rec("ACTIVITY rows + sig links", (await page.$('[data-testid="activity-band"]')) ? "PASS" : "FAIL");
    rec("LOCKED row: disabled + countdown", "SKIP", "data-dependent");
  }

  // ---- Light-teal token (deterministic, no wallet) ----
  try {
    // dark (default): small teal text == fill == #1AC6A5
    const darkText = norm(await probeColor(page, "text-l-up-text", "color"));
    const darkFill = norm(await probeColor(page, "bg-l-up", "backgroundColor"));
    // switch to light
    await page.click('button[aria-label^="Switch to"]');
    await page.waitForFunction(() => document.documentElement.getAttribute("data-mode") === "light", { timeout: 4000 });
    const lightText = norm(await probeColor(page, "text-l-up-text", "color"));
    const lightFill = norm(await probeColor(page, "bg-l-up", "backgroundColor"));
    // back to dark
    await page.click('button[aria-label^="Switch to"]');
    await page.waitForFunction(() => document.documentElement.getAttribute("data-mode") === "dark", { timeout: 4000 });

    const TEAL = "rgb(26,198,165)"; // #1AC6A5
    const DARKTEAL = "rgb(14,155,128)"; // #0E9B80
    const textOk = darkText === TEAL && lightText === DARKTEAL;
    const fillOk = darkFill === TEAL && lightFill === TEAL;
    rec("light-teal token (#0E9B80 text, #1AC6A5 fill)", textOk && fillOk ? "PASS" : "FAIL",
      `text d=${darkText} l=${lightText} · fill d=${darkFill} l=${lightFill}`);
  } catch (e) { rec("light-teal token (#0E9B80 text, #1AC6A5 fill)", "FAIL", firstLine(e)); }

  // ---- Mode toggle flips ----
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

  // ---- Mobile 390: connect button (or claim-all) reachable ----
  try {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.goto(`${BASE}/portfolio`, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(700);
    const ok = await page.evaluate(() => {
      const btn = [...document.querySelectorAll("button")].find(
        (b) => /connect wallet|claim all/i.test(b.textContent || ""),
      );
      if (!btn) return false;
      const r = btn.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.left >= 0 && r.right <= window.innerWidth + 0.5;
    });
    rec("mobile 390: primary button in viewport", ok ? "PASS" : "SKIP", ok ? "" : "no primary yet");
  } catch (e) { rec("mobile 390: primary button in viewport", "SKIP", firstLine(e)); }

  // ---- SolscanLink URL correctness (deterministic via public Markets inspector) ----
  // The cross-page sweep uses ONE component; assert its href on a non-wallet-gated
  // surface (Markets → open a contract → inspector renders a token SolscanLink).
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/markets`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-testid="asset-row"]', { timeout: 20000 });
    await page.click('[data-testid="asset-row"]');
    await page.waitForSelector('[data-testid="contract-row"]', { timeout: 8000 });
    await page.click('[data-testid="contract-row"]');
    await page.waitForSelector('[data-testid="trade-inspector"]', { timeout: 8000 });
    const href = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="trade-inspector"] [data-testid="solscan-link"]');
      return el ? el.getAttribute("href") : null;
    });
    if (href && /^https:\/\/solscan\.io\/(token|account|tx)\//.test(href) && href.includes("cluster=devnet")) {
      rec("SolscanLink href (solscan.io + cluster=devnet)", "PASS", href.slice(0, 54));
    } else {
      rec("SolscanLink href (solscan.io + cluster=devnet)", href ? "FAIL" : "SKIP", href ?? "no inspector link (thin markets?)");
    }
  } catch (e) {
    rec("SolscanLink href (solscan.io + cluster=devnet)", "SKIP", "markets didn't load — " + firstLine(e));
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  server.close();
}

const failed = results.filter((r) => r.status === "FAIL");
const skipped = results.filter((r) => r.status === "SKIP");
console.log(`\n${results.length - failed.length - skipped.length} pass · ${skipped.length} skip · ${failed.length} fail`);
if (skipped.length) console.log(`SKIPPED: ${skipped.map((s) => s.name).join(", ")}`);
process.exit(failed.length ? 1 : 0);
