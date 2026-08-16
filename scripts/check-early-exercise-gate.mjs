// =============================================================================
// scripts/check-early-exercise-gate.mjs — RENDERED proof that the early-exercise
// gate opens on a pot-funded writer-ask series.
//
// WHY A BROWSER AND NOT A UNIT TEST: the bug this guards was never in
// earlyExerciseAvailability — that function was correct and unit-tested. It was
// in the WIRING: writerAskPot was absent from the loader's DISCRIMINATORS, so no
// loader could look a pot up, and the helper was called with one argument at all
// three call sites. A module-level probe that imports the helper and passes a pot
// by hand proves nothing about the page, and reading files off disk proves
// nothing about what the dev server is serving. Only the rendered DOM does.
//
// Drives a headless Chrome at a RUNNING dev server (default :5173) with a
// read-only stub Phantom provider reporting the holder's pubkey. The stub REFUSES
// to sign anything — this asserts a button state, it never sends a transaction.
//
// PREREQ: cd app && npm i -D playwright-core --no-save   (and a dev server up)
// RUN:    node scripts/check-early-exercise-gate.mjs
//         BASE=http://localhost:5173 HOLDER=<pubkey> ROW="SOL" STRIKE="75.2"
// =============================================================================
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, "..", "app");
const require = createRequire(resolve(APP_DIR, "package.json"));

const BASE = process.env.BASE ?? "http://localhost:5173";
const HOLDER = process.env.HOLDER ?? "Awi8u6PigydVN4XRBQzmiPEdyyVmtnwf1H7Gmrf5ARu5";
const ROW = process.env.ROW ?? "SOL";
const STRIKE = process.env.STRIKE ?? "75.2";
const SIDE = process.env.SIDE ?? "C";   // C or P — 75.2 exists as BOTH on this board

let chromium;
try { ({ chromium } = require("playwright-core")); }
catch {
  console.error("playwright-core not found:\n  cd app && npm i -D playwright-core --no-save");
  process.exit(2);
}

// Injected before any page script. Legacy window.solana is what
// PhantomWalletAdapter detects; autoConnect + a seeded walletName does the rest.
const STUB = `
(() => {
  const PUBKEY = ${JSON.stringify(HOLDER)};
  // PhantomWalletAdapter does new PublicKey(account.toBytes()) — a stub without
  // REAL 32 bytes makes connect() throw and the page stays disconnected, which
  // is indistinguishable from "the gate is closed". Decode base58 properly.
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const toBytes = (s) => {
    let n = 0n;
    for (const ch of s) n = n * 58n + BigInt(B58.indexOf(ch));
    const out = [];
    while (n > 0n) { out.unshift(Number(n & 255n)); n >>= 8n; }
    for (const ch of s) { if (ch === "1") out.unshift(0); else break; }
    while (out.length < 32) out.unshift(0);
    return new Uint8Array(out.slice(-32));
  };
  const KEYBYTES = toBytes(PUBKEY);
  const mkKey = () => ({
    toBytes: () => KEYBYTES,
    toBuffer: () => KEYBYTES,
    toBase58: () => PUBKEY,
    toString: () => PUBKEY,
    equals: (o) => String(o) === PUBKEY,
  });
  const listeners = {};
  const emit = (ev, ...a) => (listeners[ev] || []).forEach((f) => { try { f(...a); } catch {} });
  const refuse = () => { throw new Error("read-only harness wallet: signing is disabled"); };
  const provider = {
    isPhantom: true,
    publicKey: null,
    isConnected: false,
    async connect() {
      this.publicKey = mkKey();
      this.isConnected = true;
      emit("connect", this.publicKey);
      return { publicKey: this.publicKey };
    },
    async disconnect() { this.publicKey = null; this.isConnected = false; emit("disconnect"); },
    on(ev, cb) { (listeners[ev] = listeners[ev] || []).push(cb); },
    off(ev, cb) { listeners[ev] = (listeners[ev] || []).filter((f) => f !== cb); },
    removeListener(ev, cb) { this.off(ev, cb); },
    removeAllListeners() { for (const k of Object.keys(listeners)) delete listeners[k]; },
    signTransaction: refuse,
    signAllTransactions: refuse,
    signMessage: refuse,
    signAndSendTransaction: refuse,
  };
  window.solana = provider;
  window.phantom = { solana: provider };
  // REQUIRED by @solana/wallet-adapter-phantom 0.9.29 adapter.js:76 — it gates
  // readyState=Installed on window.isPhantomInstalled AND isPhantom. Without it
  // the adapter stays NotDetected, autoConnect never fires, and the page renders
  // "Connect your wallet" — which looks exactly like a closed gate.
  window.isPhantomInstalled = true;
  try { localStorage.setItem("walletName", JSON.stringify("Phantom")); } catch {}
})();
`;

const browser = await chromium.launch({ headless: true, channel: "chrome" });
const page = await browser.newPage();
await page.addInitScript(STUB);
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text().slice(0, 160)); });
page.on("pageerror", (e) => errors.push("pageerror: " + String(e.message).slice(0, 160)));

let exit = 1;
try {
  await page.goto(`${BASE}/portfolio`, { waitUntil: "domcontentloaded", timeout: 60_000 });

  // autoConnect should fire off the seeded walletName. If it hasn't after a
  // grace period, drive the real connect UI — a harness that silently proceeds
  // disconnected would report "no row" and read as a closed gate.
  const connected = async () =>
    !/connect your wallet to view/i.test(await page.evaluate(() => document.body.innerText));
  await page.waitForFunction(
    () => !/connect your wallet to view/i.test(document.body.innerText),
    null, { timeout: 25_000 },
  ).catch(() => {});
  if (!(await connected())) {
    console.log("  (autoConnect did not fire — driving the connect UI)");
    await page.locator("button", { hasText: /connect wallet/i }).first().click({ timeout: 10_000 }).catch(() => {});
    await page.locator("button", { hasText: /^phantom$/i }).first().click({ timeout: 10_000 }).catch(() => {});
    await page.waitForFunction(
      () => !/connect your wallet to view/i.test(document.body.innerText),
      null, { timeout: 30_000 },
    ).catch(() => {});
  }
  if (!(await connected())) throw new Error("wallet never connected — gate state is unknowable, not closed");

  // Row selection must disambiguate CALL from PUT and one strike from another.
  // `tr:has-text("SOL"):has-text("75.2")` matches the 75.2 PUT as readily as the
  // CALL, and the PUT's action is "—" (no button) — which reports as a false
  // CLOSED. Match the rendered row text with an anchored regex instead, and fail
  // loudly on ambiguity rather than silently taking .first().
  const wantRe = new RegExp(`\\b${ROW}\\b[\\s\\S]{0,40}?\\b${STRIKE.replace(".", "\\.")}\\s*${SIDE}\\b`, "i");
  await page.waitForFunction(
    (re) => Array.from(document.querySelectorAll("tr"))
      .some((tr) => new RegExp(re, "i").test(tr.innerText)),
    wantRe.source, { timeout: 90_000 },
  );
  const idxs = await page.evaluate((re) => {
    const r = new RegExp(re, "i");
    return Array.from(document.querySelectorAll("tr"))
      .map((tr, i) => (r.test(tr.innerText) ? i : -1)).filter((i) => i >= 0);
  }, wantRe.source);
  if (idxs.length === 0) throw new Error(`no row matched ${wantRe}`);
  if (idxs.length > 1) throw new Error(`AMBIGUOUS: ${idxs.length} rows matched ${wantRe} — refusing to guess`);
  const row = page.locator("tr").nth(idxs[0]);

  const btn = row.locator("button", { hasText: /exercise/i }).first();
  const present = await btn.count();
  const disabled = present ? await btn.isDisabled() : null;
  const blockedAttr = present ? await btn.getAttribute("data-testid") : null;
  const title = present ? await btn.getAttribute("title") : null;
  const label = present ? (await btn.innerText()).trim() : null;
  const rowText = (await row.innerText()).replace(/\s+/g, " ").trim();

  const open = present > 0 && disabled === false && blockedAttr !== "action-blocked";

  console.log("=== RENDERED GATE — /portfolio ===");
  console.log(`  row              : ${rowText.slice(0, 120)}`);
  console.log(`  button present   : ${present > 0}`);
  console.log(`  button label     : ${JSON.stringify(label)}`);
  console.log(`  disabled         : ${disabled}`);
  console.log(`  data-testid      : ${JSON.stringify(blockedAttr)}`);
  console.log(`  title (reason)   : ${JSON.stringify(title)}`);
  console.log(`  VERDICT          : ${open ? "OPEN" : "CLOSED"}`);
  if (errors.length) console.log(`  console errors   : ${errors.length}\n    ${errors.slice(0, 4).join("\n    ")}`);
  exit = open ? 0 : 1;

  // CLICK=1 additionally proves the CLIENT-SIDE TX GUARD clears. The stub wallet
  // refuses to sign, so a run that reaches a signing error has passed
  // assertExerciseTxShape — which is the thing being tested. A run that surfaces
  // the guard's own copy has not, and no transaction was ever built correctly.
  if (open && process.env.CLICK === "1") {
    console.log("\n=== GUARD (clicking Exercise; stub wallet cannot sign) ===");
    await btn.click();
    const GUARD_COPY = /did not derive|does not match this series|carries no price proof|not this instruction/i;
    const SIGN_COPY = /read-only harness wallet|sign|reject|wallet/i;
    let verdict = "TIMEOUT", seen = "";
    for (let i = 0; i < 60; i++) {
      const txt = await page.evaluate(() => document.body.innerText);
      // Capture a WINDOW, not a line — the toast puts its detail on the next
      // line, and a line-anchored match silently drops the only part that
      // distinguishes "guard refused" from "wallet refused".
      const at = txt.search(/Early exercise failed|did not derive|does not match this series|read-only harness wallet/i);
      if (at >= 0) {
        seen = txt.slice(at, at + 300).replace(/\s+/g, " ").trim();
        if (GUARD_COPY.test(seen)) { verdict = "GUARD REFUSED"; break; }
        if (SIGN_COPY.test(seen)) { verdict = "GUARD PASSED (failed at signing, as designed)"; break; }
      }
      await page.waitForTimeout(500);
    }
    console.log(`  surfaced : ${JSON.stringify(seen)}`);
    console.log(`  VERDICT  : ${verdict}`);
    if (verdict.startsWith("GUARD REFUSED") || verdict === "TIMEOUT") exit = 4;
  }
} catch (e) {
  console.error("HARNESS ERROR:", String(e.message).slice(0, 300));
  // A selector timeout is ambiguous on its own — wallet never connected, row
  // absent, or the selector is simply wrong. Dump enough to tell them apart.
  try {
    const txt = await page.evaluate(() => document.body.innerText);
    console.error("  --- diagnostics ---");
    console.error(`  wallet connected : ${txt.includes(HOLDER.slice(0, 4)) ? "YES (pubkey in DOM)" : "NO pubkey in DOM"}`);
    console.error(`  <tr> count       : ${await page.locator("tr").count()}`);
    console.error(`  body text (1200) :\n${txt.slice(0, 1200).replace(/^/gm, "    ")}`);
  } catch { /* page may be gone */ }
  if (errors.length) console.error("  console errors:\n    " + errors.slice(0, 6).join("\n    "));
  exit = 3;
} finally {
  await browser.close();
}
process.exit(exit);
