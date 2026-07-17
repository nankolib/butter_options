// ============================================================================
// opta-quotes — honest-stale equity quote proxy (loopback 127.0.0.1:8090)
// ============================================================================
// Fronted by nginx (quotes.opta.fyi, TLS). Server-side ONLY — SB On-Demand
// oracles + the crank fetch this; never a browser (no CORS).
//
// HONEST-STALE (load-bearing): both legs return 503 when the upstream print is
// stale (off-hours), so the crossbar median (minJobResponses=2) produces NO
// value rather than pushing a flat tape. On fresh, the UPSTREAM body is passed
// through verbatim so the locked jsonParseTask paths work:
//   /finnhub/quote?symbol=X  -> $.c
//   /yahoo/chart/X           -> $.chart.result[0].meta.regularMarketPrice
//
// Finnhub key: read from FINNHUB_KEY env (systemd EnvironmentFile
// /opt/opta-quotes/.env). NEVER logged, NEVER in the response, NEVER in the URL
// path (injected only on the server->Finnhub request). Error strings are
// key-redacted defensively.
//
// Node 18+ (global fetch). Run: node quotes-svc.js
// ============================================================================
"use strict";
const http = require("http");

const HOST = "127.0.0.1";
const PORT = 8090;
const FRESH_MAX = 180;      // seconds: a print older than this = stale
const CACHE_TTL = parseInt(process.env.QUOTES_CACHE_TTL || "15000", 10); // ms: cache FRESH 200s only (503s never cached); QUOTES_CACHE_TTL-overridable
const FETCH_MS = 8000;
const FINNHUB_KEY = process.env.FINNHUB_KEY || "";

const cache = new Map();                       // "leg:SYMBOL" -> { at, status, body }
const nowS = () => Math.floor(Date.now() / 1000);
const redact = (s) => (FINNHUB_KEY ? String(s).split(FINNHUB_KEY).join("<KEY>") : String(s));
const log = (o) => console.log(JSON.stringify({ ts: new Date().toISOString(), ...o }));

async function getJson(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), FETCH_MS);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "user-agent": "opta-quotes/1.0" } });
    const text = await r.text();
    return { ok: r.ok, status: r.status, text };
  } finally { clearTimeout(t); }
}

// Each returns { status, body }: 200 fresh passthrough / 503 stale / 502 upstream.
async function finnhub(symbol) {
  if (!FINNHUB_KEY) return { status: 500, body: '{"error":"key unset"}' };
  let r;
  try { r = await getJson(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_KEY}`); }
  catch (e) { log({ leg: "finnhub", symbol, err: redact(e && e.message || e).slice(0, 120) }); return { status: 502, body: '{"error":"upstream"}' }; }
  if (!r.ok) return { status: 502, body: '{"error":"upstream","status":' + r.status + '}' };
  let d; try { d = JSON.parse(r.text); } catch { return { status: 502, body: '{"error":"parse"}' }; }
  const age = nowS() - (d.t || 0);
  const fresh = d.c > 0 && d.t > 0 && age <= FRESH_MAX;
  log({ leg: "finnhub", symbol, c: d.c, ageS: age, fresh });
  return fresh ? { status: 200, body: r.text } : { status: 503, body: `{"stale":true,"ageS":${age}}` };
}

async function yahoo(symbol) {
  let r;
  try { r = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`); }
  catch (e) { log({ leg: "yahoo", symbol, err: redact(e && e.message || e).slice(0, 120) }); return { status: 502, body: '{"error":"upstream"}' }; }
  if (!r.ok) return { status: 502, body: '{"error":"upstream","status":' + r.status + '}' };
  let d; try { d = JSON.parse(r.text); } catch { return { status: 502, body: '{"error":"parse"}' }; }
  // Yahoo's /v8/chart meta has NO marketState field — gate on the exchange's
  // currentTradingPeriod.regular [start,end] window (market-open signal) PLUS the
  // print-age (holiday/gap backstop: off-session the regular price freezes so age
  // grows). Both must hold for fresh.
  const m = (d && d.chart && d.chart.result && d.chart.result[0] && d.chart.result[0].meta) || {};
  const reg = m.currentTradingPeriod && m.currentTradingPeriod.regular;
  const s = nowS();
  const inRegular = !!(reg && reg.start && reg.end && s >= reg.start && s <= reg.end);
  const age = s - (m.regularMarketTime || 0);
  const fresh = m.regularMarketPrice > 0 && m.regularMarketTime > 0 && inRegular && age <= FRESH_MAX;
  log({ leg: "yahoo", symbol, price: m.regularMarketPrice, inRegular, ageS: age, fresh });
  return fresh ? { status: 200, body: r.text } : { status: 503, body: `{"stale":true,"inRegular":${inRegular},"ageS":${age}}` };
}

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://${HOST}`);
    if (u.pathname === "/healthz") { res.writeHead(200, { "content-type": "text/plain" }).end("ok"); return; }

    let leg, symbol;
    if (u.pathname === "/finnhub/quote") { leg = "finnhub"; symbol = (u.searchParams.get("symbol") || "").toUpperCase(); }
    else if (u.pathname.startsWith("/yahoo/chart/")) { leg = "yahoo"; symbol = decodeURIComponent(u.pathname.slice("/yahoo/chart/".length)).toUpperCase(); }
    else { res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}'); return; }

    if (!/^[A-Z.\-]{1,10}$/.test(symbol)) { res.writeHead(400, { "content-type": "application/json" }).end('{"error":"bad symbol"}'); return; }

    const ck = leg + ":" + symbol;
    const c = cache.get(ck);
    if (c && Date.now() - c.at < CACHE_TTL) { res.writeHead(c.status, { "content-type": "application/json", "x-cache": "hit" }).end(c.body); return; }

    const out = leg === "finnhub" ? await finnhub(symbol) : await yahoo(symbol);
    if (out.status === 200) cache.set(ck, { at: Date.now(), status: 200, body: out.body }); // cache FRESH only
    res.writeHead(out.status, { "content-type": "application/json", "x-cache": "miss" }).end(out.body);
  } catch (e) {
    log({ err: redact(e && e.message || e).slice(0, 120) });
    res.writeHead(502, { "content-type": "application/json" }).end('{"error":"internal"}');
  }
});

server.listen(PORT, HOST, () => log({ msg: "opta-quotes listening", host: HOST, port: PORT, freshMaxS: FRESH_MAX, keySet: !!FINNHUB_KEY }));
