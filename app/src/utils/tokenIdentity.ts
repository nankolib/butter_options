// =============================================================================
// app/src/utils/tokenIdentity.ts — SLICE 2A: fast, bounded token identity
// =============================================================================
//
// THE PROBLEM THIS REPLACES. The paste path resolved a mint by walking 2-5
// sequential RPC round-trips (devnet mint → devnet metadata → mainnet mint →
// T22 extension → Metaplex PDA), each with a silent second attempt and NO
// TIMEOUT ANYWHERE. Measured against the app's own mainnet fallback RPC on
// 2026-08-11: a single BP mint read took 12,292 ms, and the same read repeated
// ran 4,676 / 215 / 1,663 ms. That is what "the spinner hangs forever" actually
// was — not a hang, an unbounded wait behind a label that never changed.
//
// Both reported dead-ends were real tokens the chain could answer for: BP is
// "Backpack" and 9cRCn9…pump is "ANSEM". Neither has a price feed, so the right
// verdict was always "identity known, not listable" — it just arrived 12+
// seconds later, if the user waited.
//
// THE CONTRACT NOW:
//   1. One HTTP GET to our own endpoint, which resolves from a token catalog
//      and inlines the logo as a data: URI (~0.4 s measured).
//   2. A HARD deadline. Whatever happens, this settles within `timeoutMs`.
//   3. On a catalog miss or an unreachable catalog, fall back to the on-chain
//      resolver — devnet-native test mints and brand-new tokens are not in any
//      catalog, and they must still work.
//   4. Three distinct outcomes, never conflated: identity found · genuinely
//      unknown · we could not check. The third is not the second.
//
// ON THE FALLBACK'S DEADLINE: `connection.getAccountInfo` accepts no
// AbortSignal, so the on-chain leg cannot be truly cancelled — the race below
// bounds what the UI WAITS for, not what the network does. The abandoned reads
// settle into a discarded promise. That is the honest limit of bounding a
// transport that has no cancellation, and it is still the difference between a
// 4-second answer and a 30-second stare.
// =============================================================================

// DEPENDENCY-FREE BY DESIGN. This module imports neither ./env nor
// ./resolveMintSymbol, and that is deliberate: ./env reads `import.meta.env`,
// which cannot compile to CommonJS (TS1343), and a module that cannot compile
// to CJS cannot be tested by this repo's runners. That is the exact trap D1
// documented when it split routeSource.ts out of liveness.ts, and the exact
// reason the most consequential function in the create path had no tests.
//
// So the endpoint and the on-chain fallback are INJECTED by the caller. The
// decision logic — which source wins, what counts as unknown vs unreachable,
// how the deadline is enforced — lives here and is fully testable.

// Type-only: erased at compile time, so it costs the CJS build nothing.
import type { PublicKey } from "@solana/web3.js";

/** Identity as served by the endpoint. `iconDataUri` is ALWAYS a data: URI or
 *  null — never a remote URL, which our CSP's img-src would block anyway. */
export interface TokenIdentity {
  mint: string;
  symbol: string;
  name: string;
  verified: boolean;
  tags: string[];
  decimals: number | null;
  tokenProgram: string | null;
  iconDataUri: string | null;
  /** Where the answer came from. Drives the "unverified / on-chain only" hint. */
  origin: "catalog" | "chain";
}

export type IdentityOutcome =
  | { kind: "found"; identity: TokenIdentity }
  /** Every source answered, and none of them know this token. */
  | { kind: "unknown" }
  /** We could not get a clean answer (timeout / transport). NOT the same as
   *  "unknown" — telling a user their token does not exist when our lookup was
   *  down is the specific lie this branch prevents. */
  | { kind: "unavailable"; reason: "timeout" | "transport" };

/** Hard deadline for the WHOLE resolution, catalog + fallback. Chosen so the
 *  typical catalog answer (~0.4 s) has an order of magnitude of headroom while
 *  the worst case stays inside human patience. */
export const IDENTITY_TIMEOUT_MS = 4000;

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** True when the input looks like a mint address rather than a name. */
export function looksLikeMint(q: string): boolean {
  return BASE58.test(q.trim());
}

class Deadline extends Error {
  constructor() {
    super("identity deadline");
    this.name = "IdentityDeadline";
  }
}

/** Resolve `promise`, or reject with Deadline at `ms`. The loser is abandoned,
 *  not cancelled — see the module header. */
function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Deadline()), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

type CatalogResult =
  | { kind: "found"; identity: TokenIdentity }
  | { kind: "miss" }
  | { kind: "down" };

/**
 * Ask our endpoint. Distinguishes a clean 404 (the catalog genuinely does not
 * know this token) from any other failure (we could not ask) — the FE renders
 * those differently, so collapsing them here would destroy the distinction
 * before it reaches the user.
 */
async function fromCatalog(
  query: string,
  base: string | null,
  signal: AbortSignal,
): Promise<CatalogResult> {
  if (!base) return { kind: "down" };
  const param = looksLikeMint(query) ? "mint" : "q";
  let resp: Response;
  try {
    resp = await fetch(`${base}/token-identity?${param}=${encodeURIComponent(query.trim())}`, {
      signal,
    });
  } catch {
    return { kind: "down" };
  }
  if (resp.status === 404) return { kind: "miss" };
  if (!resp.ok) return { kind: "down" };
  try {
    const j = (await resp.json()) as Partial<TokenIdentity>;
    if (typeof j?.symbol !== "string" || typeof j?.mint !== "string") return { kind: "down" };
    return {
      kind: "found",
      identity: {
        mint: j.mint,
        symbol: j.symbol,
        name: typeof j.name === "string" ? j.name : "",
        verified: j.verified === true,
        tags: Array.isArray(j.tags) ? j.tags : [],
        decimals: typeof j.decimals === "number" ? j.decimals : null,
        tokenProgram: typeof j.tokenProgram === "string" ? j.tokenProgram : null,
        // Defensive: only ever accept a data: URI. A remote URL slipping through
        // would render as a broken image under our img-src policy, which looks
        // like a bug in the token rather than in us.
        iconDataUri:
          typeof j.iconDataUri === "string" && j.iconDataUri.startsWith("data:")
            ? j.iconDataUri
            : null,
        origin: "catalog",
      },
    };
  } catch {
    return { kind: "down" };
  }
}

/**
 * The on-chain fallback, supplied by the caller.
 *
 * Only ever consulted for an ADDRESS (a name cannot be looked up on chain), and
 * only when the catalog missed or was unreachable — which keeps devnet-native
 * test mints and tokens too new to be indexed working. A catalog-only design
 * would silently drop exactly those.
 *
 * Whatever it resolves MUST be `verified: false`: on-chain metadata is
 * self-asserted and trivially spoofable, so it can never inherit a badge.
 */
export type ChainFallback = (mint: PublicKey) => Promise<IdentityOutcome>;

/**
 * Resolve a pasted address or a typed name to a token identity, within a hard
 * deadline. NEVER throws, NEVER hangs.
 *
 * `mint` is the parsed address when the input is one; pass null for a name
 * query (the chain fallback is then skipped, because there is nothing to look
 * up on chain).
 */
export async function resolveTokenIdentity(
  query: string,
  opts: {
    /** Base URL of our identity endpoint; null disables the catalog leg. */
    endpoint: string | null;
    /** Parsed address when the input is one; null for a name query. */
    mint: PublicKey | null;
    /** On-chain resolver, used only when the catalog cannot answer. */
    chainFallback: ChainFallback;
    timeoutMs?: number;
    /** Aborts the in-flight catalog request when the caller moves on. */
    signal?: AbortSignal;
  },
): Promise<IdentityOutcome> {
  const timeoutMs = opts.timeoutMs ?? IDENTITY_TIMEOUT_MS;
  const ctrl = new AbortController();
  if (opts.signal) {
    if (opts.signal.aborted) ctrl.abort();
    else opts.signal.addEventListener("abort", () => ctrl.abort(), { once: true });
  }

  const work = (async (): Promise<IdentityOutcome> => {
    const cat = await fromCatalog(query, opts.endpoint, ctrl.signal);
    if (cat.kind === "found") return { kind: "found", identity: cat.identity };

    // Catalog missed or was unreachable. A name query has nowhere else to go.
    if (!opts.mint) {
      return cat.kind === "miss" ? { kind: "unknown" } : { kind: "unavailable", reason: "transport" };
    }
    return await opts.chainFallback(opts.mint);
  })();

  try {
    return await withDeadline(work, timeoutMs);
  } catch (e) {
    ctrl.abort(); // stop the catalog leg; the chain leg cannot be cancelled
    if ((e as Error)?.name === "IdentityDeadline") return { kind: "unavailable", reason: "timeout" };
    return { kind: "unavailable", reason: "transport" };
  }
}
