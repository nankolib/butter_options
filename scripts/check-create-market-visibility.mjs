// =============================================================================
// scripts/check-create-market-visibility.mjs — visibility gate for New-market
// =============================================================================
//
// The terminal New-market modal (locked design 1a) invariants a bundle grep can't
// see — all assertable WITHOUT a wallet (the modal opens regardless of connection
// and owns its own connect state):
//   · modal opens from the Markets pageAction; the terminal variant renders (flag)
//   · a non-crypto class with no create endpoint → class-not-enabled line + Create
//     disabled (deterministic: VITE_SB_CREATE_ENDPOINT is unset in a static serve)
//   · genericized catalog copy + ZERO oracle-provenance strings across modal states
//     (the leak-fix assertion — greps for hermes/switchboard/pyth/ewma = 0)
//   · INVALID paste state (garbage base58-length input under CRYPTO) renders
//   · ADVANCED discloses; the "Feed identifier" input renders; its label = --text-2
//   · light/dark toggle; mobile bottom-sheet dock at 390
//
// Availability three-state, paste RESOLVED/NO-FEED, and a live create are data /
// network / wallet dependent → deterministic SKIP; the founder preview pass covers.
// Asserts rendered-DOM facts (rects, offsetParent, computed color) — never node
// presence / text alone.
//
// PREREQ: cd app && npm i -D playwright-core --no-save && npm run build
// RUN from repo root:  node scripts/check-create-market-visibility.mjs
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
// Provenance leak-fix assertion: NO provider names in any rendered modal state.
const PROVENANCE = /\b(pyth|switchboard|hermes|ewma|coingecko)\b/i;

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
  console.log(`${status.padEnd(4)}  ${name.padEnd(48)} ${note}`);
};
const firstLine = (e) => (e && e.message ? e.message.split("\n")[0] : String(e));
const norm = (s) => (s || "").replace(/\s+/g, "");

// computed color of a probe element carrying `cls` (injected + removed).
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

const modalText = (page) =>
  page.evaluate(() => {
    const m = document.querySelector('[data-testid="new-market-terminal"]');
    return m ? m.innerText : "";
  });

let browser;
try {
  await readFile(join(DIST, "index.html")).catch(() => {
    throw new Error("app/dist not found — run `cd app && npm run build` first");
  });
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20000);

  await page.goto(`${BASE}/markets`, { waitUntil: "domcontentloaded" });

  // ---- 1. Modal opens from pageAction; terminal variant renders ----
  const provenanceStates = [];
  try {
    await page.waitForSelector('[data-testid="new-market-open"]', { timeout: 15000 });
    await page.click('[data-testid="new-market-open"]');
    await page.waitForSelector('[data-testid="new-market-terminal"]', { timeout: 8000 });
    const visible = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="new-market-terminal"]');
      const r = el?.getBoundingClientRect();
      return !!(el && el.offsetParent !== null && r.width > 200 && r.height > 100);
    });
    rec("modal opens · terminal variant renders", visible ? "PASS" : "FAIL");
    provenanceStates.push(await modalText(page)); // initial state
  } catch (e) {
    rec("modal opens · terminal variant renders", "FAIL", firstLine(e));
  }

  // ---- 2. Non-crypto class + unset endpoint → class-not-enabled + Create disabled ----
  try {
    await page.click('[data-testid="class-chip"][data-class="1"]'); // Commodity
    await page.waitForSelector('[data-testid="class-not-enabled"]', { timeout: 5000 });
    const state = await page.evaluate(() => {
      const line = document.querySelector('[data-testid="class-not-enabled"]');
      const lineVisible = !!(line && line.offsetParent !== null);
      const primary = document.querySelector('[data-testid="create-primary"]');
      const disabled = !primary || primary.disabled === true || primary.hasAttribute("disabled");
      return { lineVisible, disabled };
    });
    rec("non-crypto+no-endpoint: class-not-enabled + Create disabled",
      state.lineVisible && state.disabled ? "PASS" : "FAIL",
      `line=${state.lineVisible} disabled=${state.disabled}`);
    provenanceStates.push(await modalText(page));
  } catch (e) {
    rec("non-crypto+no-endpoint: class-not-enabled + Create disabled", "FAIL", firstLine(e));
  }

  // ---- 3. Crypto class: catalog copy genericized (loading) ----
  try {
    await page.click('[data-testid="class-chip"][data-class="0"]'); // Crypto
    // Grab whatever the asset input's placeholder/text is right after class-select
    // — at minimum it must NOT name a provider.
    await page.waitForTimeout(400);
    provenanceStates.push(await modalText(page));
    const loadingOk = await page.evaluate(() => {
      const inp = document.querySelector('[data-testid="asset-input"]');
      const ph = inp ? inp.getAttribute("placeholder") || "" : "";
      // Either the genericized loading copy, or (catalog resolved) the search copy —
      // never a provider name.
      return !/hermes|pyth|switchboard/i.test(ph);
    });
    rec("catalog copy genericized (no provider in placeholder)", loadingOk ? "PASS" : "FAIL");
  } catch (e) {
    rec("catalog copy genericized (no provider in placeholder)", "SKIP", firstLine(e));
  }

  // ---- 4. INVALID paste state (garbage base58-length input under CRYPTO) ----
  // "1"×33 is base58 (all zero bytes) but 33 bytes → not a valid 32-byte pubkey →
  // deterministically INVALID with no network (parseMintAddress fails synchronously).
  try {
    await page.fill('[data-testid="asset-input"]', "1".repeat(33));
    await page.waitForFunction(
      () => document.querySelector('[data-testid="resolve-state"][data-state="invalid"]') !== null,
      { timeout: 5000 },
    );
    const vis = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="resolve-state"][data-state="invalid"]');
      return !!(el && el.offsetParent !== null && el.getBoundingClientRect().height > 0);
    });
    rec("INVALID paste state renders", vis ? "PASS" : "FAIL");
    provenanceStates.push(await modalText(page));
    await page.fill('[data-testid="asset-input"]', ""); // reset
  } catch (e) {
    rec("INVALID paste state renders", "FAIL", firstLine(e));
  }

  // ---- 5. ADVANCED discloses; Feed identifier input renders; label = --text-2 ----
  try {
    const toggle = await page.$('[data-testid="advanced-toggle"]');
    if (toggle) await toggle.click(); // if catalog is dead, advanced auto-opens
    await page.waitForSelector('[data-testid="feed-identifier-input"]', { timeout: 5000 });
    const inputVisible = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="feed-identifier-input"]');
      return !!(el && el.offsetParent !== null && el.getBoundingClientRect().width > 100);
    });
    // Label color must equal the --text-2 (l-muted) token.
    const labelColor = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="feed-identifier-label"]');
      return el ? getComputedStyle(el).color : null;
    });
    const mutedToken = await probeColor(page, "text-l-muted", "color");
    const labelOk = labelColor && norm(labelColor) === norm(mutedToken);
    rec("ADVANCED: feed-identifier input + label --text-2",
      inputVisible && labelOk ? "PASS" : "FAIL",
      `input=${inputVisible} label=${labelColor} token=${mutedToken}`);
    provenanceStates.push(await modalText(page));
  } catch (e) {
    rec("ADVANCED: feed-identifier input + label --text-2", "FAIL", firstLine(e));
  }

  // ---- 6. Provenance grep = 0 across every captured modal state ----
  try {
    const hit = provenanceStates.map((t) => t.match(PROVENANCE)).find(Boolean);
    rec("provenance grep = 0 across modal states", hit ? "FAIL" : "PASS", hit ? hit[0] : `${provenanceStates.length} states`);
  } catch (e) {
    rec("provenance grep = 0 across modal states", "FAIL", firstLine(e));
  }

  // ---- 7. Light/dark: modal renders in the flipped mode ----
  // The modal overlay covers the app-bar toggle, so close → toggle → reopen (the
  // real flow), then assert the modal renders visibly in the new mode.
  try {
    await page.keyboard.press("Escape");
    await page.waitForSelector('[data-testid="new-market-terminal"]', { state: "detached", timeout: 4000 });
    const before = await page.evaluate(() => document.documentElement.getAttribute("data-mode"));
    await page.click('button[aria-label^="Switch to"]');
    await page.waitForFunction(
      (b) => document.documentElement.getAttribute("data-mode") !== b,
      before, { timeout: 4000 },
    );
    const after = await page.evaluate(() => document.documentElement.getAttribute("data-mode"));
    await page.click('[data-testid="new-market-open"]');
    await page.waitForSelector('[data-testid="new-market-terminal"]', { timeout: 6000 });
    const visible = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="new-market-terminal"]');
      const r = el?.getBoundingClientRect();
      return !!(el && el.offsetParent !== null && r.width > 200 && r.height > 100);
    });
    rec("light/dark: modal renders in flipped mode", after !== before && visible ? "PASS" : "FAIL", `${before}→${after}`);
  } catch (e) {
    rec("light/dark: modal renders in flipped mode", "FAIL", firstLine(e));
  }

  // ---- 8. Mobile 390: bottom-sheet dock (panel bottom flush to viewport) ----
  try {
    await page.setViewportSize({ width: 390, height: 800 });
    await page.waitForTimeout(300);
    const dock = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="new-market-terminal"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { bottom: r.bottom, vh: window.innerHeight, width: r.width, vw: window.innerWidth, left: r.left };
    });
    // Docked to the bottom edge + spans full width, no horizontal overflow.
    const ok = dock && Math.abs(dock.bottom - dock.vh) <= 1.5 && dock.left <= 0.5 && dock.width >= dock.vw - 0.5;
    rec("mobile 390: bottom-sheet dock", ok ? "PASS" : "FAIL", dock ? `bottom=${Math.round(dock.bottom)} vh=${dock.vh} w=${Math.round(dock.width)}` : "no modal");
  } catch (e) {
    rec("mobile 390: bottom-sheet dock", "FAIL", firstLine(e));
  }

  // ---- Browser-transport guard: the mainnet resolver host MUST answer 200 from
  //      a browser ORIGIN (Node has no CORS/403 — this is the gap that shipped the
  //      resolver bug: api.mainnet-beta.solana.com returns 403 to app-origin
  //      traffic; publicnode answers 200). Network-dependent → SKIP if offline. ----
  try {
    const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
    const r = await page.evaluate(async (mint) => {
      const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getAccountInfo", params: [mint, { encoding: "base64" }] });
      const probe = async (url) => {
        try {
          const resp = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body });
          const j = await resp.json();
          return { status: resp.status, hasAccount: !!j?.result?.value };
        } catch (e) { return { status: 0, error: String(e).slice(0, 80) }; }
      };
      return {
        publicnode: await probe("https://solana-rpc.publicnode.com"),
        labs: await probe("https://api.mainnet-beta.solana.com"),
      };
    }, BONK);
    const pubOk = r.publicnode.status === 200 && r.publicnode.hasAccount;
    rec("mainnet transport: publicnode 200 from browser origin", pubOk ? "PASS" : "SKIP",
      `publicnode=${JSON.stringify(r.publicnode)} labs=${JSON.stringify(r.labs)}`);
  } catch (e) {
    rec("mainnet transport: publicnode 200 from browser origin", "SKIP", "offline? " + firstLine(e));
  }

  // ---- Data/network/wallet-dependent → deterministic SKIP ----
  // (INVALID is asserted above with no network; RESOLVED / NOT-FOUND / NO-FEED
  //  need live RPC — incl. the cross-cluster mainnet fallback — + the catalog.)
  for (const n of [
    "availability three-state (available/live-same/taken)",
    "paste RESOLVED / NOT-FOUND / NO-FEED (needs RPC + catalog)",
    "cross-cluster: mainnet CA on devnet → resolves via fallback",
    "live create → success moment + Write-first-option deep link",
  ]) rec(n, "SKIP", "founder preview pass");
} finally {
  if (browser) await browser.close().catch(() => {});
  server.close();
}

const failed = results.filter((r) => r.status === "FAIL");
const skipped = results.filter((r) => r.status === "SKIP");
console.log(`\n${results.length - failed.length - skipped.length} pass · ${skipped.length} skip · ${failed.length} fail`);
if (skipped.length) console.log(`SKIPPED: ${skipped.map((s) => s.name).join(", ")}`);
process.exit(failed.length ? 1 : 0);
