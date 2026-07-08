// =============================================================================
// scripts/check-landing-visibility.mjs — visibility gate for the "/" landing
// =============================================================================
//
// Sibling of check-docs-visibility.mjs. The one-viewport landing runs a
// staggered opacity/transform ENTRANCE — text present in the bundle (grep) or
// even present in the DOM does not prove it is VISIBLE. This asserts computed
// visibility in a real browser: the three headline lines reach opacity:1, the
// three routes render with the right targets, and the light↔dark toggle
// actually flips html[data-mode] and the document background — in BOTH modes.
//
// PREREQ (one-time, not saved to package.json):
//     cd app && npm i -D playwright-core --no-save
// RUN from repo root (after `cd app && npm run build`):
//     node scripts/check-landing-visibility.mjs
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
  ".ico": "image/x-icon",
};

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

const checks = [];
const record = (name, ok, detail = "") => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name.padEnd(46)} ${detail}`);
};

let browser;
try {
  await readFile(join(DIST, "index.html")).catch(() => {
    throw new Error("app/dist not found — run `cd app && npm run build` first");
  });
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

  browser = await chromium.launch({ channel: "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await page.goto(BASE + "/", { waitUntil: "networkidle", timeout: 20000 });
  await page.waitForSelector("h1", { timeout: 10000 });

  // --- Headline: all three lines present AND revealed to opacity:1 -----------
  await page
    .waitForFunction(
      () => {
        const spans = document.querySelectorAll("h1 > span");
        return (
          spans.length >= 3 &&
          [...spans].every((s) => getComputedStyle(s).opacity === "1")
        );
      },
      { timeout: 4000 },
    )
    .catch(() => {});
  const headline = await page.evaluate(() => {
    const h1 = document.querySelector("h1");
    const spans = [...document.querySelectorAll("h1 > span")];
    return {
      text: (h1?.innerText || "").replace(/\s+/g, " ").trim(),
      minOpacity: spans.length
        ? Math.min(...spans.map((s) => parseFloat(getComputedStyle(s).opacity)))
        : 0,
    };
  });
  const headlineOk =
    /the options/i.test(headline.text) &&
    /primitive/i.test(headline.text) &&
    /for solana/i.test(headline.text) &&
    headline.minOpacity === 1;
  record("headline visible (3 lines, opacity 1)", headlineOk, `"${headline.text}" op=${headline.minOpacity}`);

  // --- Routes: App→/markets, Docs→/docs, X→x.com (new tab, noopener) ---------
  const routes = await page.evaluate(() => {
    const wanted = { APP: "/markets", DOCS: "/docs", X: "x.com/optafinance" };
    const out = {};
    for (const a of document.querySelectorAll("nav a")) {
      const label = (a.textContent || "").replace(/[^A-Za-z]/g, "").toUpperCase();
      const rect = a.getBoundingClientRect();
      const visible = rect.height > 0 && rect.width > 0 && getComputedStyle(a).opacity !== "0";
      const href = a.getAttribute("href") || "";
      if (label in wanted) {
        out[label] = {
          hrefOk: href.includes(wanted[label]),
          visible,
          rel: a.getAttribute("rel") || "",
          target: a.getAttribute("target") || "",
          href,
        };
      }
    }
    return out;
  });
  for (const label of ["APP", "DOCS", "X"]) {
    const r = routes[label];
    let ok = !!r && r.hrefOk && r.visible;
    let detail = r ? `href=${r.href} visible=${r.visible}` : "MISSING";
    if (label === "X" && r) {
      const extOk = r.target === "_blank" && /noopener/.test(r.rel) && /noreferrer/.test(r.rel);
      ok = ok && extOk;
      detail += ` target=${r.target} rel="${r.rel}"`;
    }
    record(`route ${label}`, ok, detail);
  }

  // --- Mode: default light, toggle flips html[data-mode] + document bg -------
  const readMode = () =>
    page.evaluate(() => ({
      mode: document.documentElement.getAttribute("data-mode"),
      bg: getComputedStyle(document.documentElement).backgroundColor,
    }));
  const light = await readMode();
  record("default mode = light", light.mode === "light", `data-mode=${light.mode} bg=${light.bg}`);

  await page.click('button[aria-label*="mode"]');
  await page.waitForFunction(
    () => document.documentElement.getAttribute("data-mode") === "dark",
    { timeout: 3000 },
  );
  const dark = await readMode();
  const darkOk = dark.mode === "dark" && dark.bg !== light.bg;
  record("toggle → dark (bg flips)", darkOk, `data-mode=${dark.mode} bg=${dark.bg}`);
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
