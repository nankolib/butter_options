// =============================================================================
// crank/tokenIdentity.ts — SLICE 2A: server-side token identity resolution
// =============================================================================
//
// WHY THIS IS SERVER-SIDE AT ALL. The browser CAN reach Jupiter directly — its
// CORS echoes our origin, measured. The blocker is our own CSP:
// `img-src 'self' data: blob:` (app/vercel.json) permits no remote image host,
// and token icons live on arbitrary third parties (BP's is trek-labs.github.io).
// Browser-direct therefore means either wildcarding img-src — arbitrary image
// loads and tracking pixels, a real security regression — or shipping no logos.
//
// Resolving here and inlining the icon as a `data:` URI costs ZERO CSP change:
// `data:` is already allowed for images, and `sb-create.opta.fyi` is already in
// connect-src. The whole feature lands without touching the policy.
//
// Two lesser reasons, both real: Jupiter's keyless tier publishes no rate limit,
// and a shared cache collapses N users x M keystrokes into one upstream call per
// mint per TTL; and a tokens.xyz API key can only ever live server-side.
//
// WHAT REPLACES WHAT. The FE's on-chain resolver walks 2-5 sequential RPC
// round-trips (devnet mint -> devnet metadata -> mainnet mint -> T22 ext ->
// Metaplex PDA), each with a silent retry and NO timeout. Measured against the
// app's own mainnet RPC (solana-rpc.publicnode.com) on 2026-08-11: a single BP
// mint read took 12,292 ms, and the same read repeated ran 4,676 / 215 / 1,663
// ms. That is the "infinite spinner" — not a hang, an unbounded wait. One HTTP
// GET here returns the same identity in ~0.4 s.
//
// The on-chain resolver is NOT deleted: it stays as the FE's fallback for tokens
// absent from the catalog (devnet-native test mints, brand-new mints Jupiter has
// not indexed). This module is the fast path, not the only path.
//
// PROVENANCE RULE: no user-facing string here names a data provider.
// =============================================================================

import http from "node:http";

/** Upstream catalog. `lite-api` is the documented keyless tier. */
const JUPITER_BASE = "https://lite-api.jup.ag/tokens/v2";

/** tokens.xyz enrichment — OPTIONAL. Everything works with the key unset. */
const TOKENS_XYZ_BASE = "https://tokens.xyz/api/v1";

/** Upstream call budget. Comfortably above Jupiter's measured 0.22-0.89 s while
 *  still well inside the FE's own 4 s hard timeout, so the FE never waits on us
 *  longer than it waits on itself. */
export const UPSTREAM_TIMEOUT_MS = 3000;

/** Icons are inlined, so an unbounded fetch would be an unbounded response.
 *  32 KB comfortably fits a real token logo; anything larger is dropped (the
 *  identity still returns, just without an icon). */
export const MAX_ICON_BYTES = 32 * 1024;

/** Only real raster/vector image types are inlined. An upstream that answers
 *  text/html (a login wall, an error page) must never become a data: URI. */
const ALLOWED_ICON_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
  "image/svg+xml",
]);

/** Cache TTLs. Identity is near-static; a negative answer is re-checked sooner
 *  because "Jupiter has not indexed this yet" is a state that expires. */
export const CACHE_TTL_MS = 10 * 60_000;
export const NEGATIVE_TTL_MS = 60_000;
/** Hard bound on cache size so a scripted scan of random mints cannot grow the
 *  process heap without limit. LRU by insertion order. */
export const CACHE_MAX_ENTRIES = 2000;

// ---- Shape returned to the FE ----------------------------------------------

export interface TokenIdentity {
  /** Mint address (base58). */
  mint: string;
  symbol: string;
  name: string;
  /** Catalog-verified. Jupiter's isVerified, overridden by tokens.xyz when the
   *  enrichment key is configured AND answers. */
  verified: boolean;
  /** Raw catalog tags (e.g. ["verified","moonshot-verified"]). */
  tags: string[];
  decimals: number | null;
  /** Owning token program, so the FE can label Token-2022 mints. */
  tokenProgram: string | null;
  /** Inlined logo as a data: URI, or null. NEVER a remote URL — a remote URL
   *  would be blocked by our img-src and render as a broken image. */
  iconDataUri: string | null;
  /** Which catalog answered. Diagnostic only; never rendered. */
  source: "jupiter" | "jupiter+tokensxyz";
}

export type IdentityResult =
  | { kind: "found"; identity: TokenIdentity }
  | { kind: "not-found" }
  | { kind: "upstream-error"; detail: string };

// ---- Cache ------------------------------------------------------------------

type Entry = { at: number; value: IdentityResult };
const cache = new Map<string, Entry>();

function cacheGet(key: string, now: number): IdentityResult | null {
  const e = cache.get(key);
  if (!e) return null;
  const ttl = e.value.kind === "found" ? CACHE_TTL_MS : NEGATIVE_TTL_MS;
  if (now - e.at > ttl) {
    cache.delete(key);
    return null;
  }
  // Refresh recency (Map preserves insertion order → re-insert = most recent).
  cache.delete(key);
  cache.set(key, e);
  return e.value;
}

function cacheSet(key: string, value: IdentityResult, now: number): void {
  // An upstream ERROR is never cached — caching it would turn one bad minute
  // into ten. "not-found" IS cached (briefly): it is a real answer.
  if (value.kind === "upstream-error") return;
  cache.set(key, { at: now, value });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** Test seam. */
export function _clearIdentityCache(): void {
  cache.clear();
}
export function _cacheSize(): number {
  return cache.size;
}

// ---- Upstream ---------------------------------------------------------------

async function fetchJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal, headers });
    if (!resp.ok) throw new Error(`http ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(t);
  }
}

/**
 * Fetch an icon and inline it as a data: URI.
 *
 * NEVER throws — an icon is decoration. Every failure path (timeout, non-2xx,
 * wrong content-type, oversize) returns null and the identity is served without
 * it. A token that resolves without a logo is a good outcome; a token that fails
 * to resolve because its logo 404'd is not.
 *
 * SSRF note: the URL is not caller-supplied — it comes from the catalog
 * response. We still refuse non-https and non-image content types, so a
 * compromised catalog entry cannot make this process fetch an internal address
 * over http or inline a text document.
 */
export async function fetchIconDataUri(url: string | null | undefined): Promise<string | null> {
  if (typeof url !== "string" || !url.startsWith("https://")) return null;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return null;
    const type = (resp.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!ALLOWED_ICON_TYPES.has(type)) return null;
    const declared = Number(resp.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > MAX_ICON_BYTES) return null;
    const buf = Buffer.from(await resp.arrayBuffer());
    // Re-check after download: content-length is a hint, not a guarantee.
    if (buf.length === 0 || buf.length > MAX_ICON_BYTES) return null;
    return `data:${type};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Map one Jupiter search row onto our shape. Exported for tests. */
export function mapJupiterRow(row: any, iconDataUri: string | null): TokenIdentity {
  const tags = Array.isArray(row?.tags) ? row.tags.filter((t: unknown) => typeof t === "string") : [];
  return {
    mint: String(row?.id ?? ""),
    symbol: String(row?.symbol ?? ""),
    name: String(row?.name ?? ""),
    // Trust the explicit boolean; fall back to the tag only when it is absent,
    // so a future schema that drops `isVerified` degrades rather than lying.
    verified: typeof row?.isVerified === "boolean" ? row.isVerified : tags.includes("verified"),
    tags,
    decimals: typeof row?.decimals === "number" ? row.decimals : null,
    tokenProgram: typeof row?.tokenProgram === "string" ? row.tokenProgram : null,
    iconDataUri,
    source: "jupiter",
  };
}

/**
 * tokens.xyz enrichment — OPTIONAL, and deliberately non-fatal.
 *
 * If `TOKENS_XYZ_API_KEY` is unset the whole function is skipped and the
 * Jupiter answer stands. If it IS set but the call fails, times out or 401s,
 * the Jupiter answer ALSO stands — an enrichment that can break the primary
 * path is not an enrichment. The only thing it may do is override `verified`
 * (tokens.xyz is the Foundation's canonical directory, so its verdict wins when
 * we have one) and record that it contributed via `source`.
 */
export async function enrichWithTokensXyz(
  identity: TokenIdentity,
  apiKey: string | undefined,
): Promise<TokenIdentity> {
  if (!apiKey) return identity;
  try {
    const j: any = await fetchJson(`${TOKENS_XYZ_BASE}/tokens/${identity.mint}`, {
      authorization: `Bearer ${apiKey}`,
    });
    const v = j?.verified ?? j?.isVerified ?? j?.data?.verified;
    if (typeof v !== "boolean") return identity;
    return { ...identity, verified: v, source: "jupiter+tokensxyz" };
  } catch {
    return identity; // never let enrichment fail the request
  }
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/**
 * Resolve identity for a mint address (exact) or a free-text query (best match).
 *
 * For an address query we require the returned row's `id` to EQUAL the address
 * asked for. Jupiter's search is fuzzy, and accepting a near-match would let a
 * typo'd address silently resolve to a different token — which then gets shown
 * as the thing the user is about to create a market for.
 */
export async function resolveIdentity(
  query: string,
  opts: { apiKey?: string; now?: number } = {},
): Promise<IdentityResult> {
  const q = query.trim();
  if (!q) return { kind: "not-found" };
  const now = opts.now ?? Date.now();
  const key = q.toLowerCase();

  const hit = cacheGet(key, now);
  if (hit) return hit;

  let rows: any[];
  try {
    const j = await fetchJson(`${JUPITER_BASE}/search?query=${encodeURIComponent(q)}`);
    rows = Array.isArray(j) ? j : [];
  } catch (e) {
    return { kind: "upstream-error", detail: String((e as Error)?.message ?? e).slice(0, 120) };
  }

  const isAddress = BASE58.test(q);
  const row = isAddress ? rows.find((r) => String(r?.id ?? "") === q) : rows[0];
  if (!row) {
    const miss: IdentityResult = { kind: "not-found" };
    cacheSet(key, miss, now);
    return miss;
  }

  const icon = await fetchIconDataUri(row?.icon);
  let identity = mapJupiterRow(row, icon);
  identity = await enrichWithTokensXyz(identity, opts.apiKey);

  const found: IdentityResult = { kind: "found", identity };
  cacheSet(key, found, now);
  // An address lookup also warms the cache under the mint key, so a subsequent
  // name search that resolves to the same token is free.
  if (!isAddress && identity.mint) cacheSet(identity.mint.toLowerCase(), found, now);
  return found;
}

// ---- HTTP handler (mounted by sbCreateMarketEndpoint) -----------------------

/**
 * GET /token-identity?mint=<base58>  |  ?q=<free text>
 *
 * Always answers JSON. Status codes are deliberately coarse: the FE renders
 * three states (identity / no-identity / could-not-check) and does not need
 * more resolution than that.
 */
export async function handleTokenIdentity(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  echoOrigin: string | null,
  apiKey: string | undefined,
  log: (
    level: "info" | "warn" | "error",
    msg: string,
    fields?: Record<string, unknown>,
  ) => void,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const q = (url.searchParams.get("mint") ?? url.searchParams.get("q") ?? "").trim();

  const send = (status: number, body: unknown, cacheSecs: number) => {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "cache-control": `public, max-age=${cacheSecs}`,
    };
    if (echoOrigin) {
      headers["access-control-allow-origin"] = echoOrigin;
      headers["vary"] = "Origin";
    }
    res.writeHead(status, headers);
    res.end(JSON.stringify(body));
  };

  if (!q || q.length > 64) {
    send(400, { error: "mint or q required" }, 0);
    return;
  }

  const started = Date.now();
  const result = await resolveIdentity(q, { apiKey });
  const ms = Date.now() - started;

  if (result.kind === "upstream-error") {
    // 502, NOT 404 — "we could not check" and "it does not exist" are different
    // answers and the FE renders them differently. Conflating them would tell a
    // user their token is unknown when in fact our lookup was down.
    log("warn", "token-identity upstream error", { q: q.slice(0, 12), ms, detail: result.detail });
    send(502, { error: "catalog unavailable" }, 0);
    return;
  }
  if (result.kind === "not-found") {
    log("info", "token-identity miss", { q: q.slice(0, 12), ms });
    send(404, { error: "not found" }, 30);
    return;
  }
  log("info", "token-identity hit", {
    q: q.slice(0, 12),
    ms,
    symbol: result.identity.symbol,
    verified: result.identity.verified,
    icon: result.identity.iconDataUri ? "inlined" : "none",
  });
  send(200, result.identity, 300);
}
