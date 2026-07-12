// =============================================================================
// scripts/check-feeds-browser.mjs — REAL-browser reachability gate for feeds.opta.fyi
// =============================================================================
//
// Standing transport rule: Node/curl has no Origin header; a browser does. A
// fetch that works from Node can still be blocked in-browser by TLS chain or
// CORS. This proves feeds.opta.fyi is BROWSER-usable by issuing the fetch from
// inside a real Chrome page context (playwright-core → system Chrome), so the
// same-origin /xbar/ proxy that will front this endpoint is known-good.
//
// Records verbatim: HTTP status, resolved-vs-threw, body, readable response
// headers (esp. CORS + content-type), and any browser console error.
//
// PREREQ: cd app && npm i -D playwright-core --no-save   (already present here)
// RUN from repo root:  node scripts/check-feeds-browser.mjs
// =============================================================================

import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, "..", "app");
const FEED_HASH = "baf182b54386b4a1c0354b7d64fb33d679301087a8b509d6a397d7b4f5162ee2";
const URL = `https://feeds.opta.fyi/simulate/${FEED_HASH}`;

const require = createRequire(resolve(APP_DIR, "package.json"));
let chromium;
try {
  ({ chromium } = require("playwright-core"));
} catch {
  console.error("playwright-core not found. Install it first:\n  cd app && npm i -D playwright-core --no-save");
  process.exit(2);
}

let browser;
const consoleErrors = [];
try {
  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage();
  page.on("console", (m) => { if (m.type() === "error") consoleErrors.push(m.text()); });
  page.on("pageerror", (e) => consoleErrors.push(`pageerror: ${e.message}`));

  // A real page context WITH an Origin. about:blank has a "null" origin (opaque),
  // which is the strictest CORS case; a data: URL is also opaque. Use a real http
  // origin via a served data document so the browser sends a cross-origin request
  // exactly like the app would. We navigate to a harmless https page context is
  // not required — the fetch is what carries the Origin. about:blank sends
  // Origin: null which is the hardest test; we report the origin used.
  await page.goto("about:blank", { waitUntil: "domcontentloaded" });

  const origin = await page.evaluate(() => window.location.origin);

  const result = await page.evaluate(async (url) => {
    const out = { threw: false, error: null, status: null, statusText: null, ok: null, body: null, headers: {} };
    try {
      const resp = await fetch(url, { method: "GET" });
      out.status = resp.status;
      out.statusText = resp.statusText;
      out.ok = resp.ok;
      resp.headers.forEach((v, k) => { out.headers[k] = v; });
      out.body = await resp.text();
    } catch (e) {
      out.threw = true;
      out.error = String(e && e.message ? e.message : e);
    }
    return out;
  }, URL);

  // --- Verbatim dump ---------------------------------------------------------
  console.log("=".repeat(72));
  console.log(`URL            : ${URL}`);
  console.log(`page origin    : ${origin}  (Origin header the browser sends)`);
  console.log(`fetch resolved : ${!result.threw}`);
  if (result.threw) console.log(`fetch error    : ${result.error}`);
  console.log(`HTTP status    : ${result.status}${result.statusText ? " " + result.statusText : ""}`);
  console.log(`response.ok    : ${result.ok}`);
  console.log(`--- readable response headers (browser-visible) ---`);
  for (const [k, v] of Object.entries(result.headers)) console.log(`  ${k}: ${v}`);
  console.log(`  access-control-allow-origin: ${result.headers["access-control-allow-origin"] ?? "(not readable / not present)"}`);
  console.log(`  content-type: ${result.headers["content-type"] ?? "(none)"}`);
  console.log(`--- response body ---`);
  console.log(result.body ?? "(none)");
  console.log(`--- browser console errors (${consoleErrors.length}) ---`);
  for (const e of consoleErrors) console.log(`  ${e}`);
  console.log("=".repeat(72));

  // --- Parse + verdict -------------------------------------------------------
  let price = null;
  let parsed = null;
  try {
    parsed = JSON.parse(result.body ?? "");
    const results = Array.isArray(parsed) ? parsed[0]?.results : undefined;
    if (Array.isArray(results) && results.length) {
      const n = Number(results[0]);
      if (Number.isFinite(n)) price = n;
    }
  } catch { /* leave price null */ }

  const pass =
    !result.threw &&
    result.status === 200 &&
    price !== null &&
    consoleErrors.length === 0;

  console.log(`\nparsed results[0] : ${price === null ? "(none / non-numeric)" : price}`);
  console.log(
    pass
      ? `\nPASS — feeds.opta.fyi is browser-usable: 200, numeric price ${price}, no TLS/CORS block.`
      : `\nFAIL — status=${result.status} resolved=${!result.threw} price=${price} consoleErrors=${consoleErrors.length}`,
  );
  process.exitCode = pass ? 0 : 1;
} catch (e) {
  console.error("gate crashed:", e && e.message ? e.message : e);
  process.exitCode = 2;
} finally {
  if (browser) await browser.close().catch(() => {});
}
