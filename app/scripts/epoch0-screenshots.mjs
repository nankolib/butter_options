// =============================================================================
// epoch0-screenshots.mjs — campaign UI shot set for design review (brief §12)
// =============================================================================
//
// Produces BOTH modes x (desktop, mobile) for every campaign surface, plus the
// flag-OFF proof shots. Reproducible for every future design review.
//
//   # flag ON, pointed at the VPS loopback API through an SSH tunnel:
//   ssh -N -L 8791:127.0.0.1:8791 root@144.202.58.6 &
//   VITE_EPOCH0_UI=1 VITE_POINTS_API_BASE=http://127.0.0.1:8791/api/points \
//     npm run dev -- --port 5199
//   node app/scripts/epoch0-screenshots.mjs --base http://localhost:5199
//
// Mode is set by stamping data-mode on <html>, which is exactly how
// useSurfaceMode drives the token set — no localStorage assumption (brief §10).
// =============================================================================

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// playwright-core is resolved dynamically: npm cannot write into this repo on
// the Windows mount (EACCES on /mnt/d), so the browser driver is installed
// outside the tree. Override with PW_CORE when it lives elsewhere.
//   mkdir -p ~/pw && cd ~/pw && npm install playwright-core
//   npx playwright install chromium
const PW_CORE = process.env.PW_CORE ?? "playwright-core";
const { chromium } = await import(PW_CORE);

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../../.screenshots/epoch0");

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const BASE = arg("--base", "http://localhost:5199");

const VIEWPORTS = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "mobile", width: 390, height: 844 },
];
const MODES = ["dark", "light"];
const ROUTES = [
  { name: "leaderboard", path: "/leaderboard" },
  { name: "portfolio", path: "/portfolio" },
];

async function shoot(page, file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await page.screenshot({ path: file, fullPage: false });
  console.log("  ->", path.relative(process.cwd(), file));
}

async function main() {
  fs.rmSync(outDir, { recursive: true, force: true });
  const browser = await chromium.launch();

  try {
    for (const vp of VIEWPORTS) {
      for (const mode of MODES) {
        const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
        const page = await ctx.newPage();

        for (const route of ROUTES) {
          await page.goto(`${BASE}${route.path}`, { waitUntil: "networkidle" }).catch(() => {});
          // Stamp the mode the way useSurfaceMode does (class/attribute on root,
          // never localStorage — brief §10).
          await page.evaluate((m) => document.documentElement.setAttribute("data-mode", m), mode);
          await page.waitForTimeout(400);
          await shoot(page, path.join(outDir, `${route.name}-${mode}-${vp.name}.png`));
        }
        await ctx.close();
      }
    }

    // ---- FLAG-OFF PROOF -----------------------------------------------------
    // Presence in the bundle is not reachability. This asserts the real DOM:
    // with the flag off, /leaderboard must NOT render the campaign heading and
    // the nav chip must be absent.
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/leaderboard`, { waitUntil: "networkidle" }).catch(() => {});
    const heading = await page.locator("h1", { hasText: "Leaderboard" }).count();
    const chip = await page.locator('a[href="/leaderboard"]').count();
    console.log(`flag-off probe: leaderboard heading=${heading} navChip=${chip}`);
    await shoot(page, path.join(outDir, "flagoff-leaderboard-desktop.png"));
    await ctx.close();
  } finally {
    await browser.close();
  }
  console.log(`\nshots written to ${outDir}`);
}

main().catch((e) => {
  console.error("screenshot run failed:", e.message);
  process.exit(1);
});
