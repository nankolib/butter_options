// =============================================================================
// scripts/check-docs-visibility.mjs — visibility gate for the /docs routes
// =============================================================================
//
// Why this exists: the whitepaper docs body is wrapped in a scroll-reveal
// <Fade> (opacity 0 -> 1 on IntersectionObserver). A `threshold` that requires
// N% of the element in view NEVER fires for sections taller than the viewport,
// leaving the body permanently at opacity:0 — RENDERED IN THE DOM BUT INVISIBLE.
// A bundle grep (text present) and even a DOM-presence check (nodes present)
// both PASS on that bug. Only asserting *computed visibility* in a real browser
// catches it. That is exactly what this script does.
//
// It builds nothing — run `npm run build` in app/ first — then serves app/dist
// (static, with SPA fallback), opens every /docs/:slug route in headless
// Chrome, and asserts the article's reveal wrapper reached opacity:1 with real
// rendered height and text. Exits non-zero if any route is blank.
//
// PREREQ (one-time, not saved to package.json to avoid app/ lockfile churn):
//     cd app && npm i -D playwright-core --no-save
// playwright-core drives the system Chrome (channel: "chrome") — no browser
// download. RUN from repo root:  node scripts/check-docs-visibility.mjs
// =============================================================================

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join, extname } from "node:path";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, "..", "app");
const DIST = resolve(APP_DIR, "dist");
const PORT = 4317;
const BASE = `http://127.0.0.1:${PORT}`;

// Mirrors app/src/pages/docs/sections.ts. The length assert below fails loudly
// if the whitepaper's section set drifts from this list.
const SLUGS = [
  "executive-summary",
  "the-market-thesis",
  "why-on-chain-options-have-not-yet-worked",
  "the-living-option-token",
  "architecture",
  "pricing",
  "the-three-layer-liquidity-model",
  "security",
  "current-state-and-honest-limitations",
  "progressive-decentralisation-roadmap",
  "the-fourth-primitive-claim",
  "comparison-with-prior-art",
  "conclusion",
  "appendix-a-instruction-set",
  "appendix-b-account-structures",
  "appendix-c-references",
];

const require = createRequire(resolve(APP_DIR, "package.json"));
let chromium;
try {
  ({ chromium } = require("playwright-core"));
} catch {
  console.error(
    "playwright-core not found. Install it first:\n  cd app && npm i -D playwright-core --no-save",
  );
  process.exit(2);
}

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".map": "application/json",
};

// Static server for app/dist with SPA fallback (no-extension paths -> index.html).
const server = createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, BASE).pathname);
    let filePath = join(DIST, pathname);
    let ext = extname(filePath);
    let data;
    if (!ext) {
      filePath = join(DIST, "index.html");
      ext = ".html";
    }
    try {
      data = await readFile(filePath);
    } catch {
      filePath = join(DIST, "index.html");
      ext = ".html";
      data = await readFile(filePath);
    }
    res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  } catch (e) {
    res.writeHead(500);
    res.end(String(e));
  }
});

let browser;
const results = [];
try {
  await readFile(join(DIST, "index.html")).catch(() => {
    throw new Error(`app/dist not found — run \`cd app && npm run build\` first`);
  });
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

  for (const slug of SLUGS) {
    const url = `${BASE}/docs/${slug}`;
    let opacity = "?";
    let height = 0;
    let textLen = 0;
    let ok = false;
    let note = "";
    try {
      await page.goto(url, { waitUntil: "networkidle", timeout: 20000 });
      await page.waitForSelector("main article", { timeout: 10000 });
      // Poll the reveal wrapper's computed opacity — this is the assertion the
      // bug fails. Times out (=> fail) if the section never reveals.
      await page.waitForFunction(
        () => {
          const a = document.querySelector("main article");
          if (!a) return false;
          const fade = a.closest(".opta-fade") || a;
          return getComputedStyle(fade).opacity === "1";
        },
        { timeout: 6000 },
      );
      const m = await page.evaluate(() => {
        const a = document.querySelector("main article");
        const fade = a.closest(".opta-fade") || a;
        return {
          opacity: getComputedStyle(fade).opacity,
          height: Math.round(a.getBoundingClientRect().height),
          textLen: (a.innerText || "").trim().length,
        };
      });
      opacity = m.opacity;
      height = m.height;
      textLen = m.textLen;
      ok = opacity === "1" && height > 200 && textLen > 200;
      if (!ok) note = "opacity/height/text below threshold";
    } catch (e) {
      note = e && e.message ? e.message.split("\n")[0] : String(e);
    }
    results.push({ slug, ok, opacity, height, textLen, note });
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${slug.padEnd(42)} opacity=${opacity} h=${String(height).padStart(5)}px text=${String(textLen).padStart(5)}  ${note}`,
    );
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  server.close();
}

const failed = results.filter((r) => !r.ok);
if (results.length !== SLUGS.length) {
  console.error(`\nExpected ${SLUGS.length} routes, checked ${results.length}.`);
  process.exit(1);
}
console.log(
  `\n${results.length - failed.length}/${results.length} routes visible.` +
    (failed.length ? `  FAILED: ${failed.map((f) => f.slug).join(", ")}` : "  All green."),
);
process.exit(failed.length ? 1 : 0);
