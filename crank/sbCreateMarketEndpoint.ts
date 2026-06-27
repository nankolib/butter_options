// ============================================================================
// crank/sbCreateMarketEndpoint.ts — SB create-market HTTP builder endpoint
// ============================================================================
//
// A minimal, CRASH-ISOLATED HTTP endpoint (Node built-in `http`, no framework)
// that builds the UNSIGNED Switchboard create-market transaction and returns it
// base64-serialized. The FE wallet signs + submits; this endpoint NEVER holds or
// signs a user key, and its own crank key never signs the returned tx — the SB
// create tx requires only the create_market `creator` signature (= the user);
// the ed25519 quote ix is oracle-signed, independent of the fee-payer (see the
// signer-split recon).
//
// STATELESS: every POST builds a FRESH tx (fresh oracle quote + fresh blockhash).
// No caching. Freshness/retry contract: the FE re-requests on stale-submit
// failure; this endpoint always builds anew. A small bounded build-retry absorbs
// the ~3/15 SB gateway flakiness — each attempt RE-FETCHES a fresh quote (still
// stateless, no cache).
//
// CRASH ISOLATION (critical): the crank's core duties (settle/vol/trigger/sb)
// MUST NOT be taken down by this endpoint. Every request runs inside a wrapper so
// any throw → 500 + log, never propagating. The server is mounted OUTSIDE the
// Promise.all loop set, and a listen() failure (EADDRINUSE/EACCES) or any socket
// error is logged and swallowed — the loops keep running without the endpoint.
//
// Env (all optional; the endpoint is OFF unless OPTA_SB_CREATE_ENABLED=1, gated
// in bot.ts):
//   OPTA_SB_CREATE_PORT           default 8787
//   OPTA_SB_CREATE_HOST           default 127.0.0.1 (front with nginx TLS)
//   OPTA_SB_CREATE_ALLOW_ORIGINS  extra CSV origins appended to the built-in list
//   OPTA_SB_CREATE_RATE_MAX       default 10 requests / window / IP
//   OPTA_SB_CREATE_RATE_WINDOW_MS default 60000
//   OPTA_SB_CREATE_BUILD_ATTEMPTS default 3 (bounded fresh-build retries)
//   OPTA_SB_CREATE_TRUST_PROXY    "1" → derive client IP from X-Forwarded-For
//
// TODO (pre-real-traffic follow-up): add a GLOBAL in-flight build-concurrency cap.
// Each request can trigger up to OPTA_SB_CREATE_BUILD_ATTEMPTS (default 3) SB
// gateway fetches, so per-IP rate limiting alone does NOT bound total upstream
// load on the Crossbar/SB gateway. A process-wide semaphore (reject 503 when
// saturated) is needed before this faces real traffic.
// ============================================================================

import * as http from "http";
import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import {
  Queue,
  AnchorUtils,
  ON_DEMAND_DEVNET_PID,
  ON_DEMAND_DEVNET_QUEUE,
} from "@switchboard-xyz/on-demand";
import { CrossbarClient } from "@switchboard-xyz/common";

import type { Opta } from "@app/idl/opta";
import { lookupSbFeedDatum, normSbFeedHash } from "@app/utils/sbFeedData";
import { isSupportedSbFeed } from "./sbFeedRegistry";
import { buildSwitchboardCreateMarketTx } from "./switchboardCreateMarket";

type LogFn = (
  level: "info" | "warn" | "error",
  msg: string,
  fields?: Record<string, unknown>,
) => void;

export interface SbCreateEndpointContext {
  connection: Connection;
  /** Crank wallet — used ONLY to load the read-only SB program for the quote
   *  fetch. NEVER signs the returned user tx. */
  wallet: anchor.Wallet;
  program: anchor.Program<Opta>;
  log: LogFn;
}

export interface SbCreateServerHandle {
  close: () => void;
  /** Bound port once listening, else null. */
  port: number | null;
}

const BUILTIN_ALLOWED_ORIGINS = [
  "https://opta-solana.vercel.app",
  "https://opta.fyi",
  "https://www.opta.fyi",
];
const CROSSBAR_URL = "https://crossbar.switchboard.xyz";
const ASSET_NAME_RE = /^[A-Z0-9]{1,16}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const MAX_BODY_BYTES = 2048;
const DEFAULT_PORT = 8787;
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_RATE_MAX = 10;
const DEFAULT_RATE_WINDOW_MS = 60_000;
const DEFAULT_BUILD_ATTEMPTS = 3;

const short = (e: unknown) => String((e as any)?.message ?? e).slice(0, 200);

class BodyTooLargeError extends Error {}

interface EndpointConfig {
  port: number;
  host: string;
  extraOrigins: string[];
  rateMax: number;
  rateWindowMs: number;
  buildAttempts: number;
  trustProxy: boolean;
}

function readConfig(): EndpointConfig {
  const num = (v: string | undefined, d: number) => {
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    port: num(process.env.OPTA_SB_CREATE_PORT, DEFAULT_PORT),
    host: process.env.OPTA_SB_CREATE_HOST || DEFAULT_HOST,
    extraOrigins: (process.env.OPTA_SB_CREATE_ALLOW_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    rateMax: num(process.env.OPTA_SB_CREATE_RATE_MAX, DEFAULT_RATE_MAX),
    rateWindowMs: num(process.env.OPTA_SB_CREATE_RATE_WINDOW_MS, DEFAULT_RATE_WINDOW_MS),
    buildAttempts: num(process.env.OPTA_SB_CREATE_BUILD_ATTEMPTS, DEFAULT_BUILD_ATTEMPTS),
    trustProxy: (process.env.OPTA_SB_CREATE_TRUST_PROXY ?? "") === "1",
  };
}

// ---- Per-IP fixed-window rate limiter (in-memory, self-pruning) ------------
interface RateState {
  windowStart: number;
  count: number;
}
function makeRateLimiter(maxPerWindow: number, windowMs: number) {
  const buckets = new Map<string, RateState>();
  return (ip: string, now: number): boolean => {
    const b = buckets.get(ip);
    if (!b || now - b.windowStart >= windowMs) {
      buckets.set(ip, { windowStart: now, count: 1 });
      // Opportunistic prune so the map can't grow unbounded.
      if (buckets.size > 10_000) {
        for (const [k, v] of buckets) {
          if (now - v.windowStart >= windowMs) buckets.delete(k);
        }
      }
      return true;
    }
    if (b.count >= maxPerWindow) return false;
    b.count += 1;
    return true;
  };
}

function clientIp(req: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  }
  return req.socket.remoteAddress ?? "unknown";
}

function sendJson(
  res: http.ServerResponse,
  status: number,
  echoOrigin: string | null,
  body: unknown,
): void {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (echoOrigin) {
    headers["access-control-allow-origin"] = echoOrigin;
    headers["vary"] = "Origin";
  }
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // Fast reject on a declared oversize length.
    const declared = Number(req.headers["content-length"] ?? 0);
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new BodyTooLargeError());
      req.destroy();
      return;
    }
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > maxBytes) {
        reject(new BodyTooLargeError());
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

type Validated = {
  assetName: string;
  feedHashHex: string;
  assetClass: number;
  userPk: PublicKey;
};
function validate(body: any): { ok: true; value: Validated } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null) {
    return { ok: false, error: "body must be a JSON object" };
  }
  const { assetName, feedHashHex, assetClass, userPublicKey } = body;

  if (typeof assetName !== "string" || !ASSET_NAME_RE.test(assetName)) {
    return { ok: false, error: "assetName must match /^[A-Z0-9]{1,16}$/" };
  }
  if (typeof feedHashHex !== "string") {
    return { ok: false, error: "feedHashHex must be a string" };
  }
  const norm = normSbFeedHash(feedHashHex);
  if (!HEX64_RE.test(norm)) {
    return { ok: false, error: "feedHashHex must be 64-char hex" };
  }
  if (!isSupportedSbFeed(norm)) {
    return { ok: false, error: "unsupported Switchboard feed" };
  }
  const datum = lookupSbFeedDatum(norm);
  if (!datum) {
    return { ok: false, error: "unsupported Switchboard feed" }; // defensive
  }
  if (typeof assetClass !== "number" || !Number.isInteger(assetClass)) {
    return { ok: false, error: "assetClass must be an integer" };
  }
  if (assetClass !== datum.suggestedAssetClass) {
    return {
      ok: false,
      error: `assetClass ${assetClass} does not match feed class ${datum.suggestedAssetClass}`,
    };
  }
  if (typeof userPublicKey !== "string") {
    return { ok: false, error: "userPublicKey must be a string" };
  }
  let userPk: PublicKey;
  try {
    userPk = new PublicKey(userPublicKey);
  } catch {
    return { ok: false, error: "userPublicKey is not a valid pubkey" };
  }
  return { ok: true, value: { assetName, feedHashHex: norm, assetClass, userPk } };
}

async function handleRequest(
  ctx: SbCreateEndpointContext,
  sb: { qObj: Queue; crossbar: CrossbarClient },
  cfg: EndpointConfig,
  allowedOrigins: Set<string>,
  rateLimit: (ip: string, now: number) => boolean,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : null;
  const originAllowed = origin !== null && allowedOrigins.has(origin);
  const echoOrigin = originAllowed ? origin : null;

  // CORS preflight.
  if (req.method === "OPTIONS") {
    const headers: Record<string, string> = {
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "600",
    };
    if (echoOrigin) {
      headers["access-control-allow-origin"] = echoOrigin;
      headers["vary"] = "Origin";
    }
    res.writeHead(echoOrigin ? 204 : 403, headers);
    res.end();
    return;
  }

  // Browser requests (Origin present) must be from an allowed origin.
  if (origin !== null && !originAllowed) {
    sendJson(res, 403, null, { error: "origin not allowed" });
    return;
  }

  const path = (req.url ?? "").split("?")[0];
  if (req.method !== "POST" || path !== "/sb-create-market") {
    sendJson(res, 404, echoOrigin, { error: "not found" });
    return;
  }

  // Per-IP rate limit.
  const ip = clientIp(req, cfg.trustProxy);
  if (!rateLimit(ip, Date.now())) {
    sendJson(res, 429, echoOrigin, { error: "rate limit exceeded, try again shortly" });
    return;
  }

  // Size-capped body read.
  let raw: string;
  try {
    raw = await readBody(req, MAX_BODY_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      sendJson(res, 413, echoOrigin, { error: "request too large" });
      return;
    }
    throw e; // → wrapper → 500
  }

  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(res, 400, echoOrigin, { error: "invalid JSON body" });
    return;
  }

  const v = validate(parsed);
  if (!v.ok) {
    sendJson(res, 400, echoOrigin, { error: v.error });
    return;
  }
  const { assetName, feedHashHex, assetClass, userPk } = v.value;

  // Stateless build with a bounded fresh-build retry (each attempt re-fetches a
  // fresh quote — the SB gateway is ~3/15 clean).
  // UN-APPLY ON IDL SYNC: `ctx.program as any` — buildSwitchboardCreateMarketTx
  // calls the 4-arg create_market via an `any` cast because the app IDL the crank
  // loads is still the pre-sync shape here. Matches the seed-vol cast convention;
  // drop the cast when the IDL syncs to the 4-arg (oracle_source) signature.
  let build: Awaited<ReturnType<typeof buildSwitchboardCreateMarketTx>> | undefined;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= cfg.buildAttempts; attempt++) {
    try {
      build = await buildSwitchboardCreateMarketTx(
        ctx.program as any,
        userPk,
        sb.qObj,
        sb.crossbar,
        { assetName, feedHashHex, assetClass },
      );
      break;
    } catch (e) {
      lastErr = e;
      ctx.log("warn", "sb-create build attempt failed", { attempt, err: short(e) });
    }
  }
  if (!build) {
    ctx.log("warn", "sb-create build exhausted", { err: short(lastErr) });
    sendJson(res, 502, echoOrigin, {
      error: "could not fetch a fresh Switchboard quote, please retry",
    });
    return;
  }

  // FRESHNESS INVARIANT (response-contract safety). The response carries only
  // `lastValidBlockHeight` — the FE has NO quote deadline. That is safe ONLY
  // because the blockhash validity bound is TIGHTER than the SB quote bound:
  //
  //     blockhash validity (~150 slots / ~60-90s)
  //         <  SB create-quote window (CREATE_SB_PROOF_MAX_AGE_SECS = 300s / 750 slots)
  //
  // i.e. the tx's blockhash expires BEFORE the embedded oracle quote does, so a
  // tx that is still landable (blockhash valid) necessarily carries a still-valid
  // quote. Quote-expiry is thus IMPLIED by blockhash-validity and needs no
  // separate deadline in the response.
  //
  // INVARIANT ASSERTION (documented, not an accident): if this EVER inverts —
  // Switchboard tightens the create quote window below the blockhash bound, OR
  // the blockhash validity bound loosens above 300s — this contract becomes
  // UNSAFE (the FE could hold a blockhash-valid tx whose quote already expired,
  // failing on submit with no way to know why). In that case the endpoint MUST
  // also return an explicit quote deadline (e.g. a `quoteExpiresAtSlot`) and the
  // FE must gate on the tighter of the two. Until then: blockhash is the binding
  // deadline; do not remove this comment without re-checking both bounds.
  const { blockhash, lastValidBlockHeight } =
    await ctx.connection.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(
    new TransactionMessage({
      payerKey: userPk,
      recentBlockhash: blockhash,
      instructions: build.instructions,
    }).compileToV0Message(),
  );
  const transactionBase64 = Buffer.from(tx.serialize()).toString("base64");

  ctx.log("info", "sb-create tx built", {
    asset: assetName,
    marketPda: build.marketPda.toBase58(),
  });
  sendJson(res, 200, echoOrigin, {
    transactionBase64,
    marketPda: build.marketPda.toBase58(),
    lastValidBlockHeight,
  });
}

/**
 * Start the crash-isolated SB create-market HTTP server. Returns a handle whose
 * close() stops the listener. Mount OUTSIDE the crank's Promise.all loop set so
 * its failures never crash the core duties.
 */
export function startSbCreateMarketServer(
  ctx: SbCreateEndpointContext,
): SbCreateServerHandle {
  const cfg = readConfig();
  const allowedOrigins = new Set<string>([
    ...BUILTIN_ALLOWED_ORIGINS,
    ...cfg.extraOrigins,
  ]);
  const rateLimit = makeRateLimiter(cfg.rateMax, cfg.rateWindowMs);
  const handle: SbCreateServerHandle = { close: () => {}, port: null };

  // SB clients bootstrapped lazily on first request (a Crossbar/SB-program
  // hiccup at boot must not block startup); cached for the process lifetime,
  // re-attempted on the next request if the first bootstrap fails.
  let sbPromise: Promise<{ qObj: Queue; crossbar: CrossbarClient }> | null = null;
  const getSb = () => {
    if (!sbPromise) {
      sbPromise = (async () => {
        const sbProgram = await AnchorUtils.loadProgramFromConnection(
          ctx.connection,
          ctx.wallet,
          ON_DEMAND_DEVNET_PID,
        );
        return {
          qObj: new Queue(sbProgram, ON_DEMAND_DEVNET_QUEUE),
          crossbar: new CrossbarClient(CROSSBAR_URL),
        };
      })().catch((e) => {
        sbPromise = null; // allow a retry on the next request
        throw e;
      });
    }
    return sbPromise;
  };

  const server = http.createServer((req, res) => {
    // CRASH ISOLATION: nothing from a request may escape to crash the process.
    (async () => {
      const sb = await getSb();
      await handleRequest(ctx, sb, cfg, allowedOrigins, rateLimit, req, res);
    })().catch((err) => {
      ctx.log("error", "sb-create request handler error", { err: short(err) });
      try {
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal error" }));
        } else {
          res.end();
        }
      } catch {
        /* response already destroyed — swallow */
      }
    });
  });

  server.on("error", (err) => {
    // listen() failures (EADDRINUSE/EACCES) AND post-listen socket errors.
    // NEVER exit: the crank's core duties matter more than this endpoint.
    ctx.log("error", "sb-create server error (endpoint unavailable, crank continues)", {
      err: short(err),
    });
  });

  server.listen(cfg.port, cfg.host, () => {
    handle.port = cfg.port;
    ctx.log("info", "sb-create endpoint listening", {
      host: cfg.host,
      port: cfg.port,
      origins: [...allowedOrigins],
    });
  });

  handle.close = () => {
    try {
      server.close();
    } catch {
      /* ignore */
    }
  };
  return handle;
}
