// =============================================================================
// resolveMintSymbol.ts — resolve a pasted token mint → its symbol (RPC-only).
// =============================================================================
//
// Powers the smart asset input's paste path. Given a mint pubkey, read its symbol
// from on-chain metadata WITHOUT any new endpoint or SDK, trying both metadata
// conventions in order (most real tokens are classic SPL, so the Metaplex PDA
// fallback is load-bearing — without it the feature is dead on arrival):
//
// Per cluster: (a) Token-2022 metadata extension → reuse fetchOptionTokenMetadata;
// (b) Metaplex metadata PDA → raw getAccountInfo + ~20-line borsh parse.
//
// CLUSTER-SMART: probe the app cluster first (devnet-native test tokens keep
// working); ONLY on a definitive account-not-found there, retry public mainnet-beta
// — so a mainnet CA pasted on the devnet app still resolves its symbol. Outcomes:
//   · { kind: "resolved" }    symbol read (either cluster) → anti-spoof catalog match
//   · { kind: "not-found" }   absent on every cluster we could check
//   · { kind: "no-metadata" } account exists but no readable symbol
// (INVALID and NO-FEED are the caller's — parse + catalog match.)
//
// The resolved symbol is used ONLY to look up a canonical catalog asset by ticker
// (anti-spoof): the on-chain feed a market is created against always comes from
// the matched catalog entry, never from the pasted mint. So a spoofed metadata
// symbol can at worst point at a legit catalog asset — it can never inject a feed.
//
// No provider names appear in any returned value or thrown error.
// =============================================================================

import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { METAPLEX_METADATA_PROGRAM_ID } from "./constants";
import { inferClusterFromUrl } from "./env";
import { fetchOptionTokenMetadata } from "./tokenMetadata";

// Public mainnet RPC for the cross-cluster fallback (read-only getAccountInfo +
// metadata reads, no key, ~2 reads per paste). MUST be the CSP-allowlisted host
// (connect-src in vercel.json) — api.mainnet-beta.solana.com is allowed;
// api.solana.com is NOT, so do not swap it.
const MAINNET_RPC = "https://api.mainnet-beta.solana.com";

export type MintResolution =
  | { kind: "resolved"; symbol: string; name: string; source: "t22" | "metaplex" }
  | { kind: "not-found" }
  | { kind: "no-metadata" };

/** Parse an address string into a PublicKey, or null if it isn't a valid one.
 *  Callers use a null here to render the INVALID state (distinct from no-metadata). */
export function parseMintAddress(input: string): PublicKey | null {
  const s = input.trim();
  // Base58 pubkeys are 32–44 chars; a cheap length gate avoids constructing
  // PublicKey for obvious non-addresses (and keeps the INVALID state snappy).
  if (s.length < 32 || s.length > 44) return null;
  try {
    return new PublicKey(s);
  } catch {
    return null;
  }
}

/** Derive the Metaplex Token-Metadata PDA for a mint:
 *  ["metadata", metadataProgramId, mint] under the metadata program. */
function metadataPda(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      METAPLEX_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    METAPLEX_METADATA_PROGRAM_ID,
  );
  return pda;
}

/** Read a borsh length-prefixed string at `offset`, trimming Metaplex's null
 *  padding. Returns [value, nextOffset]. Throws on an out-of-range length so a
 *  corrupt/spoofed account falls through to no-metadata rather than reading junk. */
function readBorshString(data: Buffer, offset: number): [string, number] {
  const len = data.readUInt32LE(offset);
  const start = offset + 4;
  const end = start + len;
  // Metaplex caps name=32, symbol=10, uri=200; a length past the buffer (or wildly
  // large) means a layout we don't understand — bail to the no-metadata path.
  if (len > 256 || end > data.length) {
    throw new Error("metadata string length out of range");
  }
  const raw = data.subarray(start, end).toString("utf8");
  const trimmed = raw.replace(/\0+$/, "").trim();
  return [trimmed, end];
}

/** Parse name + symbol from a Metaplex Token-Metadata account.
 *  Layout: key(1) · update_authority(32) · mint(32) · name(str) · symbol(str) · … */
function parseMetaplexMetadata(data: Buffer): { name: string; symbol: string } | null {
  try {
    let offset = 1 + 32 + 32; // past key + update_authority + mint
    const [name, afterName] = readBorshString(data, offset);
    offset = afterName;
    const [symbol] = readBorshString(data, offset);
    if (!symbol) return null;
    return { name, symbol };
  } catch {
    return null;
  }
}

/** One-cluster probe: does the mint exist here, and can we read a symbol?
 *  - "absent"     : getAccountInfo returned null (definitively not on this cluster)
 *  - "rpc-error"  : the MINT read itself threw (ambiguous — can't conclude absence)
 *  - "resolved"   : symbol read from T22 ext or Metaplex PDA
 *  - "read-error" : mint exists but the metadata read threw (transient — distinct
 *                   from a mint that genuinely carries no metadata)
 *  - "no-symbol"  : mint exists, metadata read succeeded, but no symbol present */
type Probe =
  | { kind: "absent" }
  | { kind: "rpc-error" }
  | { kind: "resolved"; symbol: string; name: string; source: "t22" | "metaplex" }
  | { kind: "read-error" }
  | { kind: "no-symbol" };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** getAccountInfo with one retry on a THROW (public mainnet RPC rate-limits a
 *  burst of rapid reads). `{ok:false}` only after both attempts throw — a clean
 *  null is `{ok:true, info:null}`. */
async function readAccount(
  connection: Connection,
  pubkey: PublicKey,
  label: string,
): Promise<{ ok: true; info: Awaited<ReturnType<Connection["getAccountInfo"]>> } | { ok: false }> {
  for (let i = 0; i < 2; i++) {
    try {
      return { ok: true, info: await connection.getAccountInfo(pubkey) };
    } catch (e: any) {
      console.debug(`[resolveMint] ${label} read threw (attempt ${i + 1})`, e?.message ?? e);
      if (i === 0) await sleep(250);
    }
  }
  return { ok: false };
}

async function probeCluster(
  connection: Connection,
  mint: PublicKey,
  clusterLabel: string,
): Promise<Probe> {
  const mintRead = await readAccount(connection, mint, `${clusterLabel} mint`);
  if (!mintRead.ok) {
    console.debug(`[resolveMint] ${clusterLabel}: mint read failed → rpc-error`);
    return { kind: "rpc-error" };
  }
  if (mintRead.info === null) {
    console.debug(`[resolveMint] ${clusterLabel}: mint absent`);
    return { kind: "absent" };
  }

  // (a) Token-2022 metadata extension — ONLY when the mint is actually owned by
  //     the Token-2022 program (skips a redundant read for classic SPL mints,
  //     which matters on the rate-limited public mainnet RPC).
  if (mintRead.info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    try {
      const t22 = await fetchOptionTokenMetadata(connection, mint);
      if (t22 && t22.symbol) {
        console.debug(`[resolveMint] ${clusterLabel}: resolved via t22 → ${t22.symbol}`);
        return { kind: "resolved", symbol: t22.symbol, name: t22.name, source: "t22" };
      }
    } catch (e: any) {
      console.debug(`[resolveMint] ${clusterLabel}: t22 read threw`, e?.message ?? e);
    }
  }

  // (b) Classic SPL — Metaplex metadata PDA. Distinguish a read THROW (transient)
  //     from a clean "account exists but no symbol".
  const metaRead = await readAccount(connection, metadataPda(mint), `${clusterLabel} metaplex`);
  if (!metaRead.ok) {
    console.debug(`[resolveMint] ${clusterLabel}: metaplex read failed → read-error`);
    return { kind: "read-error" };
  }
  if (metaRead.info?.data) {
    const parsed = parseMetaplexMetadata(Buffer.from(metaRead.info.data));
    if (parsed && parsed.symbol) {
      console.debug(`[resolveMint] ${clusterLabel}: resolved via metaplex → ${parsed.symbol}`);
      return { kind: "resolved", symbol: parsed.symbol, name: parsed.name, source: "metaplex" };
    }
  }

  console.debug(`[resolveMint] ${clusterLabel}: exists, no readable symbol → no-symbol`);
  return { kind: "no-symbol" };
}

const asResolution = (p: Extract<Probe, { kind: "resolved" }>): MintResolution => ({
  kind: "resolved",
  symbol: p.symbol,
  name: p.name,
  source: p.source,
});

/**
 * Cluster-smart mint → symbol resolution. Try the app cluster first (keeps
 * devnet-native test tokens working); ONLY on a definitive account-not-found there
 * (and only if the app cluster isn't already mainnet) retry against public
 * mainnet-beta — so a mainnet CA pasted on the devnet app still resolves. The
 * resolved symbol only ever selects a CANONICAL catalog asset (anti-spoof); the
 * pasted mint never reaches the chain, so the cross-cluster read is safe.
 *
 * RPC-only; never throws. Failure states: not-found (absent on the cluster(s) we
 * could check) · no-metadata (exists but no readable symbol) — INVALID and NO-FEED
 * are decided by the caller (parse + catalog match).
 */
export async function resolveMintSymbol(
  connection: Connection,
  mint: PublicKey,
): Promise<MintResolution> {
  const appCluster = inferClusterFromUrl(connection.rpcEndpoint);
  const primary = await probeCluster(connection, mint, `app(${appCluster})`);
  if (primary.kind === "resolved") return asResolution(primary);

  // App cluster gave no symbol. If it's already mainnet there's nothing to fall
  // back to: absent → not-found, otherwise → no readable metadata.
  if (appCluster === "mainnet-beta") {
    return primary.kind === "absent" ? { kind: "not-found" } : { kind: "no-metadata" };
  }

  // Cross-cluster fallback — the WHOLE sequence (mint + metadata reads) runs
  // against mainnet. NOTE: we fall through on ANY non-resolve (absent, no-symbol,
  // read-error, rpc-error), not just absent: devnet routinely carries bare CLONES
  // of popular mints (BONK exists on devnet with no metadata), so a symbol-less
  // app-cluster hit must not block the real mainnet metadata. Safe by construction
  // — the resolved symbol only selects a canonical catalog asset; the pasted mint
  // never reaches the chain.
  const secondary = await probeCluster(new Connection(MAINNET_RPC, "confirmed"), mint, "mainnet");
  if (secondary.kind === "resolved") return asResolution(secondary);

  // Neither cluster produced a symbol. Not-found only if BOTH say the account is
  // absent; otherwise it exists somewhere but carries no readable metadata.
  if (primary.kind === "absent" && secondary.kind === "absent") return { kind: "not-found" };
  return { kind: "no-metadata" };
}
