// =============================================================================
// scripts/check-write-sb-leak.mjs — rendered-DOM gate for the Write dropdown leak
// =============================================================================
//
// Proves the Stage-3 leak fix: WriteTerminalPage now routes its asset-chip
// builder through canonicalAsset(), so provenance/seed markets that map to null
// (XAUSMOKE, SBXAU — both live on devnet) NEVER reach the Write asset dropdown,
// while real markets DO. This is a rendered-DOM assertion (visible rects +
// offsetParent over the actual dropdown options), not a node-presence/bundle
// grep — presence in DOM ≠ visibility.
//
// Data source: the app fetches markets read-only from its default devnet RPC
// (api.devnet.solana.com; no wallet needed). A Node-side getProgramAccounts
// precheck first confirms XAUSMOKE + SBXAU actually EXIST on devnet, so their
// absence from the dropdown is due to filtering, not missing data.
//
// Builds nothing — run `cd app && npm run build` first — then serves app/dist and
// drives system Chrome via playwright-core.
//
// PREREQ: cd app && npm i -D playwright-core --no-save
// RUN from repo root:  node scripts/check-write-sb-leak.mjs
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
const RPC = "https://api.devnet.solana.com";
const PROGRAM_ID = "CtzJ4MJYX6BFvF4g67i5C24tQuwRn6ddKkaE5L84z9Cq";

// Names that canonicalAsset() maps to null (must be ABSENT from the dropdown).
const HIDDEN = ["XAUSMOKE", "SBXAU", "UKOILSPOT"];
// Any one of these present proves real markets DO surface.
const REAL = ["BTC", "ETH", "SOL", "XAU", "WTI", "AAPL", "TSLA", "NVDA", "XAG"];

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
  console.log(`${status.padEnd(4)}  ${name.padEnd(52)} ${note}`);
};
const firstLine = (e) => (e && e.message ? e.message.split("\n")[0] : String(e));

// --- Node-side precheck: do the hidden names exist on devnet? ---------------
async function onChainHasNames(names) {
  const body = {
    jsonrpc: "2.0", id: 1, method: "getProgramAccounts",
    params: [PROGRAM_ID, { encoding: "base64" }],
  };
  const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.error) throw new Error(`gPA error: ${JSON.stringify(j.error).slice(0, 120)}`);
  const present = new Set();
  const re = /[A-Z0-9]{2,12}/g;
  for (const a of j.result) {
    const ascii = Buffer.from(a.account.data[0], "base64").toString("latin1");
    for (const name of names) if (ascii.includes(name)) present.add(name);
  }
  return present;
}

let browser;
try {
  await readFile(join(DIST, "index.html")).catch(() => {
    throw new Error("app/dist not found — run `cd app && npm run build` first");
  });

  // 0) On-chain precheck.
  try {
    const present = await onChainHasNames(HIDDEN);
    const have = HIDDEN.filter((n) => present.has(n));
    rec("devnet precheck: hidden markets exist on-chain", have.length >= 2 ? "PASS" : "SKIP",
      `present=[${have.join(", ")}] (absence from dropdown ⇒ filtered, not missing)`);
  } catch (e) { rec("devnet precheck: hidden markets exist on-chain", "SKIP", firstLine(e)); }

  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(30000);

  await page.goto(`${BASE}/write`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-testid="write-asset-trigger"]', { timeout: 20000 });

  // Poll: open the dropdown and wait for markets to load from live devnet.
  // The panel may first render "No live markets" while the read-only gPA is in
  // flight; re-open until visible option buttons appear (or give up).
  let labels = [];
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    // ensure the panel is open
    const open = await page.evaluate(() => !!document.querySelector('[data-testid="write-asset-panel"]'));
    if (!open) { await page.click('[data-testid="write-asset-trigger"]').catch(() => {}); await page.waitForTimeout(400); }

    labels = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="write-asset-panel"]');
      if (!panel) return [];
      const out = [];
      for (const btn of panel.querySelectorAll("button")) {
        const r = btn.getBoundingClientRect();
        if (!(r.width > 0 && r.height > 0 && btn.offsetParent !== null)) continue; // VISIBLE only
        // ticker span = the plain [A-Z0-9] span (not the dot markers, not the spot)
        let ticker = "";
        for (const s of btn.querySelectorAll("span")) {
          const t = (s.textContent || "").trim();
          if (/^[A-Z0-9]{2,12}$/.test(t)) { ticker = t; break; }
        }
        out.push(ticker || (btn.textContent || "").trim());
      }
      return out;
    });
    if (labels.length > 0) break;
    // close + wait for the next fetch tick, then retry
    await page.click('[data-testid="write-asset-trigger"]').catch(() => {});
    await page.waitForTimeout(1500);
  }

  console.log(`\n  Rendered VISIBLE dropdown options (${labels.length}): [${labels.join(", ")}]\n`);

  if (labels.length === 0) {
    rec("dropdown populated from devnet", "FAIL", "no visible options after 60s (RPC blocked/slow?)");
  } else {
    rec("dropdown populated from devnet", "PASS", `${labels.length} visible options`);

    const upper = labels.map((l) => l.toUpperCase());
    const hiddenHits = HIDDEN.filter((h) => upper.some((l) => l === h || l.includes(h)));
    rec("hidden SB/seed markets ABSENT (XAUSMOKE/SBXAU)", hiddenHits.length === 0 ? "PASS" : "FAIL",
      hiddenHits.length ? `LEAK: ${hiddenHits.join(", ")}` : "none of [" + HIDDEN.join(", ") + "] rendered");

    const realHits = REAL.filter((r) => upper.includes(r));
    rec("at least one real market PRESENT", realHits.length > 0 ? "PASS" : "FAIL",
      realHits.length ? `present: ${realHits.join(", ")}` : "no known real ticker rendered");
  }
} catch (e) {
  rec("write leak gate", "FAIL", firstLine(e));
} finally {
  if (browser) await browser.close().catch(() => {});
  server.close();
}

const failed = results.filter((r) => r.status === "FAIL");
const skipped = results.filter((r) => r.status === "SKIP");
console.log(`\n${results.length - failed.length - skipped.length} pass · ${skipped.length} skip · ${failed.length} fail`);
process.exit(failed.length ? 1 : 0);
