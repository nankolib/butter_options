// =============================================================================
// crank/settlementArchive.ts — Stage 3 Slice 3: SB settlement self-indexer
// =============================================================================
//
// Archives a fully-verifiable attestation for every REAL confirmed Switchboard
// settle (settle_expiry via the SB arm). The archive is the raw material a
// third party needs to independently re-verify that the on-chain
// SettlementRecord was produced from genuinely oracle-signed data:
//   - the self-packed ed25519 precompile instruction bytes (edIx.data)
//   - the broken-out (signature, pubkey, message, oracleIdx) triples
//   - the feedHash + the spot parsed straight out of the signed message
//   - the resulting on-chain settlement_price + recent_slot
//   - the settle tx signature, queue, quote program, market + record PDAs
//
// NON-THROWING BY CONSTRUCTION: this module NEVER throws out of
// `archiveSbSettlement`. Archiving is a best-effort side-channel; a failure to
// persist must never disrupt (or reverse) a confirmed on-chain settle.
//
// Two sinks, in priority order:
//   1. JSONL append (durable, always-available)   — the SOURCE OF TRUTH.
//      One JSON line per settle, path from OPTA_SB_ARCHIVE_JSONL
//      (default /opt/opta-crank/sb-settle-archive.jsonl).
//   2. Upstash SET (best-effort convenience)       — raw fetch, NO new dep,
//      NO TTL. Skipped SILENTLY when KV_REST_API_URL / KV_REST_API_TOKEN are
//      absent (that is NOT an error — the JSONL still wrote).
//
// The record BUILDER (`buildSbSettlementRecord`) is a PURE function: no I/O, no
// Date, no randomness. The crank stamps `capturedAtIso` and hands it in. This
// keeps the record deterministic + unit-testable.
// =============================================================================

import { appendFile } from "node:fs/promises";

import type { CapturedBuild } from "./switchboardQuotePost";

// ---- Record shape ----------------------------------------------------------

/** One broken-out ed25519 attestation triple, base64-encoded for JSON. */
export interface ArchivedTriple {
  oracleIdx: number;
  signature: string; // base64 (64 raw bytes)
  pubkey: string; //    base64 (32 raw bytes)
  message: string; //   base64 (the signed quote message)
}

/** The archived, JSON-serialisable settlement attestation. */
export interface SbSettlementRecord {
  /** Stable key: `sb-settle:{asset}:{expiry}`. */
  key: string;
  assetName: string;
  expiry: number;
  /** The correctly self-packed ed25519 precompile instruction bytes (base64). */
  edIxData: string;
  /** The verified oracle triples the ed25519 ix was packed from. */
  signatures: ArchivedTriple[];
  /** The Switchboard feed hash (hex). */
  feedHash: string;
  /** Spot parsed directly from signatures[0].message (i128 LE @ feed offset),
   *  normalised ÷1e12 → USDC 6-dec integer. Should equal `settlementPrice`. */
  spotFromMsg: number;
  /** On-chain SettlementRecord.settlement_price (USDC 6-dec). */
  settlementPrice: number;
  /** On-chain SettlementRecord.pyth_publish_time — REPURPOSED for SB markets to
   *  hold the verifier-resolved recent_slot (a SLOT, not a unix timestamp). */
  recentSlot: number;
  /** Confirmed settle tx signature. */
  settleTxSig: string;
  /** SB On-Demand queue this feed is served by (base58). */
  queuePubkey: string;
  /** SB quote program (base58). */
  programId: string;
  /** OptionsMarket PDA (base58). */
  marketPubkey: string;
  /** SettlementRecord PDA (base58). */
  settlementRecordPubkey: string;
  /** ISO timestamp stamped by the crank at archive time (impure — injected). */
  capturedAtIso: string;
}

export interface SbSettlementRecordInput {
  asset: string;
  expiry: number;
  /** edIx.data — the self-packed ed25519 precompile bytes. */
  edIxData: Uint8Array;
  /** The captured build (broken-out triples + slot/version). */
  captured: CapturedBuild;
  feedHashHex: string;
  /** On-chain SettlementRecord.settlement_price (USDC 6-dec). */
  settlementPrice: number;
  /** On-chain SettlementRecord.pyth_publish_time (= recent_slot for SB). */
  recentSlot: number;
  settleTxSig: string;
  queuePubkey: string;
  programId: string;
  marketPubkey: string;
  settlementRecordPubkey: string;
  /** ISO string stamped by the caller (keeps the builder pure). */
  capturedAtIso: string;
}

// ---- Spot parse (signed i128 LE) -------------------------------------------

/**
 * The signed Switchboard quote MESSAGE is:
 *   PackedQuoteHeader(32) || PackedFeedInfo(49)
 * with PackedFeedInfo = { feed_id[0..32], feed_value @ 32 (i128 LE), ...,
 * min_oracle_samples @ 48 }. So for a single-feed message the feed_value sits
 * at ABSOLUTE offset 32(header) + 32 = 64. Layout authority:
 *   programs/opta/src/utils/price_oracle.rs (sb_tests, ~:534/:548-563).
 */
export const SB_MSG_FEED_VALUE_OFFSET = 64;
/** feed_value is scaled ×1e18; USDC is 6-dec, so ÷1e12 normalises. */
const SB_FEED_VALUE_TO_USDC_DIVISOR = 1_000_000_000_000n;

/** Read a signed 16-byte little-endian i128 at `offset`. */
export function readI128LE(buf: Uint8Array, offset: number): bigint {
  if (buf.length < offset + 16) {
    throw new Error(`readI128LE: buffer too short (${buf.length} < ${offset + 16})`);
  }
  let val = 0n;
  for (let i = 15; i >= 0; i--) val = (val << 8n) | BigInt(buf[offset + i]);
  // Two's-complement sign extension for a 128-bit value.
  if ((val >> 127n) & 1n) val -= 1n << 128n;
  return val;
}

/**
 * Parse spot from a signed quote message and normalise to a USDC 6-dec integer.
 * Reads the i128 feed_value at the feed offset and integer-divides by 1e12.
 */
export function parseSpotUsdcFromMessage(
  message: Uint8Array,
  feedValueOffset: number = SB_MSG_FEED_VALUE_OFFSET,
): number {
  const raw = readI128LE(message, feedValueOffset);
  return Number(raw / SB_FEED_VALUE_TO_USDC_DIVISOR);
}

// ---- Pure record builder ---------------------------------------------------

const toB64 = (u: Uint8Array): string => Buffer.from(u).toString("base64");

/**
 * Build the JSON-serialisable settlement attestation. PURE: no I/O, no Date.
 * Throws only on structurally-impossible input (empty triples / short message)
 * — the CALLER wraps this so the crank never sees a throw on the settle path.
 */
export function buildSbSettlementRecord(input: SbSettlementRecordInput): SbSettlementRecord {
  const triples = input.captured.signatures;
  if (!Array.isArray(triples) || triples.length === 0) {
    throw new Error("buildSbSettlementRecord: captured.signatures is empty");
  }
  const signatures: ArchivedTriple[] = triples.map((t) => ({
    oracleIdx: t.oracleIdx,
    signature: toB64(t.signature),
    pubkey: toB64(t.pubkey),
    message: toB64(t.message),
  }));
  const spotFromMsg = parseSpotUsdcFromMessage(triples[0].message);

  return {
    key: `sb-settle:${input.asset}:${input.expiry}`,
    assetName: input.asset,
    expiry: input.expiry,
    edIxData: toB64(input.edIxData),
    signatures,
    feedHash: input.feedHashHex,
    spotFromMsg,
    settlementPrice: input.settlementPrice,
    recentSlot: input.recentSlot,
    settleTxSig: input.settleTxSig,
    queuePubkey: input.queuePubkey,
    programId: input.programId,
    marketPubkey: input.marketPubkey,
    settlementRecordPubkey: input.settlementRecordPubkey,
    capturedAtIso: input.capturedAtIso,
  };
}

// ---- Non-throwing archive helper -------------------------------------------

export type ArchiveLogger = (msg: string, fields?: Record<string, unknown>) => void;

/** Injectable seams so the non-throwing guarantee can be unit-tested with
 *  failing fns, and so env lookup can be overridden in tests. */
export interface ArchiveOpts {
  /** JSONL path override (else OPTA_SB_ARCHIVE_JSONL, else the /opt default). */
  jsonlPath?: string;
  /** Upstash REST URL override (else KV_REST_API_URL). */
  kvUrl?: string;
  /** Upstash REST token override (else KV_REST_API_TOKEN). */
  kvToken?: string;
  /** fs appendFile seam (default node:fs/promises appendFile). */
  appendFileFn?: (path: string, data: string) => Promise<void>;
  /** fetch seam (default globalThis.fetch). */
  fetchFn?: (url: string, init: Record<string, unknown>) => Promise<{ ok: boolean; status: number }>;
  /** Warn logger (default no-op). */
  log?: ArchiveLogger;
}

export interface ArchiveResult {
  /** JSONL append succeeded — the durable source of truth landed. */
  jsonlOk: boolean;
  /** Upstash SET succeeded OR was not configured (skip == not an error). */
  upstashOk: boolean;
}

const DEFAULT_JSONL_PATH = "/opt/opta-crank/sb-settle-archive.jsonl";

/**
 * Persist one settlement attestation. NEVER throws.
 *   Step 1 (durable): append ONE JSON line to the JSONL file.
 *   Step 2 (best-effort): raw-fetch Upstash SET (no TTL, no new dep). Skipped
 *   silently when KV env is absent.
 * Returns {jsonlOk, upstashOk}. `upstashOk` is `true` when KV is unconfigured
 * (nothing to do is NOT a failure — the JSONL remains the source of truth).
 */
export async function archiveSbSettlement(
  record: SbSettlementRecord,
  opts: ArchiveOpts = {},
): Promise<ArchiveResult> {
  const log: ArchiveLogger = opts.log ?? (() => {});

  // Serialise once. JSON.stringify on this flat record cannot realistically
  // throw, but guard anyway so the helper is total.
  let json: string;
  try {
    json = JSON.stringify(record);
  } catch (err) {
    log("sb-archive: JSON.stringify failed (record dropped)", { err: String(err).slice(0, 140) });
    return { jsonlOk: false, upstashOk: false };
  }

  const jsonlOk = await appendJsonl(json, record.key, opts, log);
  const upstashOk = await upstashSet(record.key, json, opts, log);
  return { jsonlOk, upstashOk };
}

async function appendJsonl(
  json: string,
  key: string,
  opts: ArchiveOpts,
  log: ArchiveLogger,
): Promise<boolean> {
  const path = opts.jsonlPath ?? process.env.OPTA_SB_ARCHIVE_JSONL ?? DEFAULT_JSONL_PATH;
  const append = opts.appendFileFn ?? ((p: string, d: string) => appendFile(p, d));
  try {
    await append(path, json + "\n");
    return true;
  } catch (err) {
    log("sb-archive: JSONL append failed", { key, path, err: String(err).slice(0, 140) });
    return false;
  }
}

async function upstashSet(
  key: string,
  json: string,
  opts: ArchiveOpts,
  log: ArchiveLogger,
): Promise<boolean> {
  const url = opts.kvUrl ?? process.env.KV_REST_API_URL;
  const token = opts.kvToken ?? process.env.KV_REST_API_TOKEN;
  if (!url || !token) return true; // not configured → skip silently (NOT an error)

  const fetchFn =
    opts.fetchFn ??
    (globalThis.fetch as unknown as ArchiveOpts["fetchFn"]) ??
    undefined;
  if (!fetchFn) {
    log("sb-archive: no fetch available (Upstash skipped)", { key });
    return false;
  }

  try {
    // Upstash REST: POST {base}/set/{key} with the JSON string as the body,
    // no TTL. Raw fetch — DO NOT add @upstash/redis.
    const res = await fetchFn(`${url.replace(/\/$/, "")}/set/${encodeURIComponent(key)}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: json,
    });
    if (!res || !res.ok) {
      log("sb-archive: Upstash SET non-ok", { key, status: res ? res.status : "no-response" });
      return false;
    }
    return true;
  } catch (err) {
    log("sb-archive: Upstash SET threw", { key, err: String(err).slice(0, 140) });
    return false;
  }
}
