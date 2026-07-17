// =============================================================================
// discovery.ts — source-agnostic chain enumeration (safeFetchAll pattern).
// =============================================================================
// Markets and orders are read via raw getProgramAccounts + discriminator memcmp
// + per-account coder.decode wrapped in try/catch — NEVER Anchor's .all(), which
// throws "offset out of range" on legacy orphans and empties the whole scan.
// Discovery is pure enumeration: any market on-chain (incl. Monday's equities)
// auto-appears with zero code change. Per-asset pricing tier is a display
// classification (asset_class + a meme override), not a discovery gate.
// =============================================================================

import type { Program } from "@coral-xyz/anchor";
import { Connection, PublicKey } from "@solana/web3.js";
import { PROGRAM_ID, volOraclePda } from "./ids";
import type { AssetClass } from "./marketHours";
import { log } from "./log";

const VOL_WARMUP_SAMPLES = 168;
const VOL_STALE_SECS = 6 * 3600;

export interface MarketInfo {
  publicKey: PublicKey;
  assetName: string;
  assetClass: AssetClass;
  pythFeedId: Uint8Array;
  oracleSource: number; // 0 Pyth, 1 Switchboard
}

export interface OracleState {
  ready: boolean;   // fresh AND (warm OR seeded)
  reason: string;   // when !ready
  spot: number;     // coarse spot (human USD), for strike selection
  samples: number;
  seedVol: number;
  ageSecs: number;
}

export interface MyOrder {
  pubkey: PublicKey;
  optionMint: PublicKey;
  vault: PublicKey;
  priceMicro: bigint;
  quantityRemaining: bigint;
  nonce: bigint;
  createdAtMs: number; // best-effort from on-chain created_at (secs -> ms)
}

function memcmpFilter(program: Program<any>, accountName: string) {
  const { offset, bytes } = (program.coder.accounts as any).memcmp(accountName);
  return { memcmp: { offset, bytes } };
}

/** Enumerate live markets, applying the strict validator (drops corrupt/legacy). */
export async function enumerateMarkets(program: Program<any>): Promise<MarketInfo[]> {
  const connection = program.provider.connection;
  const raw = await connection.getProgramAccounts(PROGRAM_ID, {
    commitment: "confirmed",
    filters: [memcmpFilter(program, "optionsMarket")],
  });
  const out: MarketInfo[] = [];
  const seen = new Set<string>();
  for (const { pubkey, account } of raw) {
    let m: any;
    try {
      m = program.coder.accounts.decode("optionsMarket", account.data);
    } catch {
      continue; // corrupt / legacy orphan — skip (safeFetchAll semantics)
    }
    if (typeof m.assetName !== "string" || !m.assetName) continue;
    if (typeof m.assetClass !== "number" || m.assetClass < 0 || m.assetClass > 4) continue;
    const key = pubkey.toBase58();
    if (seen.has(key)) continue;
    seen.add(key);
    const feed = m.pythFeedId instanceof Uint8Array ? m.pythFeedId : Uint8Array.from(m.pythFeedId as number[]);
    out.push({
      publicKey: pubkey,
      assetName: m.assetName,
      assetClass: m.assetClass as AssetClass,
      pythFeedId: feed,
      oracleSource: typeof m.oracleSource === "number" ? m.oracleSource : 0,
    });
  }
  return out;
}

const bnNum = (v: any): number => {
  if (v == null) return NaN;
  if (typeof v === "number") return v;
  if (typeof v.toNumber === "function") { try { return v.toNumber(); } catch { return Number(v.toString()); } }
  return Number(v.toString?.() ?? v);
};

/** Read the per-feed VolOracle: quote-ready iff fresh (<6h) AND (warm OR seeded). */
export async function readOracle(
  program: Program<any>, feedId: Uint8Array, nowSec: number, debug = false,
): Promise<OracleState> {
  const pda = volOraclePda(feedId);
  let o: any;
  try {
    o = await (program.account as any).volOracle.fetch(pda);
  } catch {
    return { ready: false, reason: "oracle-not-initialized", spot: 0, samples: 0, seedVol: 0, ageSecs: Infinity };
  }
  if (debug) log.info("oracle-debug", { keys: Object.keys(o) });
  const samples = bnNum(o.sampleCount ?? o.samples ?? 0);
  const seedVol = bnNum(o.seedVol ?? o.seed_vol ?? 0);
  const lastTs = bnNum(o.lastSampleTs ?? o.lastTs ?? o.last_sample_ts ?? 0);
  const spotScaled = o.lastSpotPrice ?? o.lastSpot ?? o.spot ?? o.last_spot_price;
  const spot = spotScaled != null ? bnNum(spotScaled) / 1e12 : 0;
  const ageSecs = lastTs > 0 ? nowSec - lastTs : Infinity;
  const fresh = ageSecs < VOL_STALE_SECS;
  const warm = samples >= VOL_WARMUP_SAMPLES;
  const seeded = seedVol !== 0;
  const ready = fresh && (warm || seeded) && spot > 0;
  const reason = !fresh ? "oracle-stale" : !(warm || seeded) ? "oracle-warmup" : spot <= 0 ? "no-spot" : "ok";
  return { ready, reason, spot, samples, seedVol, ageSecs };
}

/** Enumerate the bot's own resting orders (memcmp on discriminator + owner@8). */
export async function enumerateMyOrders(
  program: Program<any>, owner: PublicKey,
): Promise<MyOrder[]> {
  const connection: Connection = program.provider.connection;
  const disc = memcmpFilter(program, "restingOrder");
  const raw = await connection.getProgramAccounts(PROGRAM_ID, {
    commitment: "confirmed",
    filters: [disc, { memcmp: { offset: 8, bytes: owner.toBase58() } }], // owner is first field after discriminator
  });
  const out: MyOrder[] = [];
  for (const { pubkey, account } of raw) {
    let r: any;
    try {
      r = program.coder.accounts.decode("restingOrder", account.data);
    } catch {
      continue;
    }
    // Only WriterAsks belong to this bot's flow; ignore anything else defensively.
    if (!r.kind || !("writerAsk" in r.kind)) continue;
    const createdAtSec = bnNum(r.createdAt ?? r.created_at ?? 0);
    out.push({
      pubkey,
      optionMint: new PublicKey(r.optionMint ?? r.option_mint),
      vault: new PublicKey(r.vault),
      priceMicro: BigInt(String(r.pricePerContract ?? r.price_per_contract ?? 0)),
      quantityRemaining: BigInt(String(r.quantityRemaining ?? r.quantity_remaining ?? 0)),
      nonce: BigInt(String(r.nonce ?? 0)),
      createdAtMs: createdAtSec > 0 ? createdAtSec * 1000 : 0,
    });
  }
  return out;
}
