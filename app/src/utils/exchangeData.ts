// =============================================================================
// app/src/utils/exchangeData.ts — Pass 0 read layer (exchange book + series)
// =============================================================================
//
// Pure, React-free data functions for the exchange Trade-page arc. Hooks
// (useBook / useSeries / useUnifiedChain) are thin wrappers over these.
//
// Account enumeration uses raw getProgramAccounts + memcmp(discriminator) +
// MANUAL byte-parse — deliberately NOT Anchor `.all()` (stale-schema orphans
// with colliding discriminators blow `.all()` up; see the .all() orphan trap).
//
// Byte layouts mirror the Rust structs (8-byte Anchor discriminator first):
//   RestingOrder : state/resting_order.rs
//   VaultMint    : state/vault_mint.rs   (series record reuses this shape, D5)
//   SharedVault  : state/shared_vault.rs (INIT_SPACE 252 + 8 disc = 260)
//   OptionsMarket: asset_name (string) then pyth_feed_id
// =============================================================================

import { Connection, PublicKey } from "@solana/web3.js";
import { utils } from "@coral-xyz/anchor";
import { Buffer } from "buffer";

// ---- Discriminators (first 8 bytes of sha256("account:<Name>")) -------------
const DISC = {
  restingOrder: [125, 151, 65, 43, 90, 207, 190, 104],
  vaultMint: [219, 139, 146, 175, 62, 90, 224, 254],
  sharedVault: [195, 36, 66, 128, 41, 62, 161, 142],
  optionsMarket: [67, 30, 90, 36, 130, 219, 166, 8],
} as const;

const ZERO32 = Buffer.alloc(32);
const MICRO = 1_000_000;

/** Raw program accounts of one type, filtered by discriminator memcmp. */
async function getByDisc(
  connection: Connection,
  programId: PublicKey,
  disc: readonly number[],
): Promise<{ pubkey: PublicKey; data: Buffer }[]> {
  const raw = await connection.getProgramAccounts(programId, {
    commitment: "confirmed",
    filters: [{ memcmp: { offset: 0, bytes: utils.bytes.bs58.encode(Buffer.from(disc)) } }],
  });
  return raw.map((r) => ({ pubkey: r.pubkey, data: Buffer.from(r.account.data) }));
}

const u64 = (d: Buffer, o: number): bigint => (d.length >= o + 8 ? d.readBigUInt64LE(o) : 0n);
const i64 = (d: Buffer, o: number): bigint => (d.length >= o + 8 ? d.readBigInt64LE(o) : 0n);
const usd = (b: bigint): number => Number(b) / MICRO;

// ---- OrderKind ---------------------------------------------------------------
export type OrderKind = "bid" | "resaleAsk" | "writerAsk" | "vaultPeg";
const ORDER_KINDS: OrderKind[] = ["bid", "resaleAsk", "writerAsk", "vaultPeg"];

// =============================================================================
// Book — RestingOrder
// =============================================================================
export interface BookOrder {
  pubkey: string;
  owner: string;
  optionMint: string;
  vault: string;
  kind: OrderKind;
  price: number;          // USDC per contract
  qty: number;            // quantity_remaining (contracts)
  qtyInitial: number;
  nonce: string;
  createdAt: number;      // unix seconds
  collateralPerContract: number; // USDC; WriterAsk only (Slice-A append @146..154). 0 for Bid/ResaleAsk & legacy 146-byte orders.
}

/** Parse one RestingOrder account (8 disc + struct). */
export function parseRestingOrder(pubkey: PublicKey, d: Buffer): BookOrder | null {
  if (d.length < 146) return null;
  return {
    pubkey: pubkey.toBase58(),
    owner: new PublicKey(d.subarray(8, 40)).toBase58(),
    optionMint: new PublicKey(d.subarray(40, 72)).toBase58(),
    vault: new PublicKey(d.subarray(72, 104)).toBase58(),
    kind: ORDER_KINDS[d[104]] ?? "bid",
    price: usd(u64(d, 105)),
    qty: Number(u64(d, 113)),
    qtyInitial: Number(u64(d, 121)),
    createdAt: Number(i64(d, 129)),
    nonce: u64(d, 137).toString(),
    // bump @145 (skipped); collateral_per_contract u64 @146..154 — the Slice-A
    // tail append. Only meaningful on 154-byte WriterAsk orders; the u64 helper
    // returns 0 for legacy 146-byte accounts, so the < 146 floor still admits both.
    collateralPerContract: usd(u64(d, 146)),
  };
}

export async function fetchBook(connection: Connection, programId: PublicKey): Promise<BookOrder[]> {
  const accts = await getByDisc(connection, programId, DISC.restingOrder);
  return accts.map((a) => parseRestingOrder(a.pubkey, a.data)).filter((o): o is BookOrder => o !== null);
}

/** Group orders by series option-mint, split into sorted bid/ask sides. */
export function indexBook(orders: BookOrder[]): Map<string, { bids: BookOrder[]; asks: BookOrder[] }> {
  const m = new Map<string, { bids: BookOrder[]; asks: BookOrder[] }>();
  for (const o of orders) {
    if (!m.has(o.optionMint)) m.set(o.optionMint, { bids: [], asks: [] });
    const side = m.get(o.optionMint)!;
    if (o.kind === "bid") side.bids.push(o);
    else side.asks.push(o); // resaleAsk / writerAsk / vaultPeg are all asks
  }
  for (const s of m.values()) {
    s.bids.sort((a, b) => b.price - a.price); // best (highest) bid first
    s.asks.sort((a, b) => a.price - b.price); // best (lowest) ask first
  }
  return m;
}

// =============================================================================
// Series — sentineled VaultMint records
// =============================================================================
export interface SeriesRecord {
  recordPubkey: string;
  vault: string;          // backing SharedVault PDA
  optionMint: string;     // canonical series mint
  quantityMinted: number;
  quantitySold: number;
}

/** True iff a VaultMint record is a canonical series record (D5 sentinels). */
export function isSeriesSentinel(d: Buffer): boolean {
  return d.length >= 137
    && d.subarray(40, 72).equals(ZERO32)   // writer == Pubkey::default()
    && u64(d, 104) === 0n                   // premium_per_contract == 0
    && i64(d, 128) === 0n;                  // created_at == 0
}

export function parseSeriesRecord(pubkey: PublicKey, d: Buffer): SeriesRecord {
  return {
    recordPubkey: pubkey.toBase58(),
    vault: new PublicKey(d.subarray(8, 40)).toBase58(),
    optionMint: new PublicKey(d.subarray(72, 104)).toBase58(),
    quantityMinted: Number(u64(d, 112)),
    quantitySold: Number(u64(d, 120)),
  };
}

export async function fetchSeries(connection: Connection, programId: PublicKey): Promise<SeriesRecord[]> {
  const accts = await getByDisc(connection, programId, DISC.vaultMint);
  return accts.filter((a) => isSeriesSentinel(a.data)).map((a) => parseSeriesRecord(a.pubkey, a.data));
}

// =============================================================================
// Unified chain — exchange-spec Pass F data collapse (shape only)
// =============================================================================
export type OptionType = "call" | "put";
export type ExerciseStyle = "american" | "european";

export type Provenance = "series" | "epoch" | "legacy";

export interface UnifiedChainRow {
  key: string;                        // asset|strike|expiry|type
  provenance: Provenance;             // series (book/peg) | epoch (scheduled per-writer) | legacy (custom per-writer)
  asset: string;
  strike: number;
  expiry: number;                     // unix seconds
  optionType: OptionType;
  exerciseStyle: ExerciseStyle;
  vault: string;
  optionMint: string | null;          // series mint (series rows only)
  oi: number;                         // open interest (contracts outstanding)
  bestBid: number | null;             // from the book (series rows)
  bestAsk: number | null;             // from the book (series rows)
  bidQty: number;
  askQty: number;
  isSettled: boolean;
  voided: boolean;
}

interface SharedVaultLite {
  pubkey: string;
  market: string;
  optionType: OptionType;
  strike: number;
  expiry: number;
  vaultType: "epoch" | "custom";
  exerciseStyle: ExerciseStyle;
  totalOptionsSold: number;
  isSettled: boolean;
  voided: boolean;
}

function parseSharedVault(pubkey: PublicKey, d: Buffer): SharedVaultLite | null {
  if (d.length < 260) return null;
  return {
    pubkey: pubkey.toBase58(),
    market: new PublicKey(d.subarray(8, 40)).toBase58(),
    optionType: d[40] === 0 ? "call" : "put",
    strike: usd(u64(d, 41)),
    expiry: Number(i64(d, 49)),
    // vault_type u8 @57 (after expiry i64 @49..57): 0 = Epoch, 1 = Custom.
    vaultType: d[57] === 0 ? "epoch" : "custom",
    totalOptionsSold: Number(u64(d, 146)),
    isSettled: d[178] === 1,
    exerciseStyle: d[240] === 1 ? "american" : "european",
    voided: d[259] === 1,
  };
}

/** market pubkey -> asset symbol, from OptionsMarket accounts. */
async function fetchMarketAssetMap(connection: Connection, programId: PublicKey): Promise<Map<string, string>> {
  const accts = await getByDisc(connection, programId, DISC.optionsMarket);
  const m = new Map<string, string>();
  for (const a of accts) {
    const d = a.data;
    if (d.length < 12) continue;
    const nameLen = d.readUInt32LE(8);
    if (nameLen > 16 || d.length < 12 + nameLen) continue;
    const asset = d.subarray(12, 12 + nameLen).toString("utf8");
    if (asset) m.set(a.pubkey.toBase58(), asset);
  }
  return m;
}

/**
 * Build the unified chain: one row per SharedVault, provenance-marked.
 * Series rows (backed by a sentineled series record) are enriched with the
 * book's best bid/ask and series OI; legacy per-event vaults carry no book
 * (their secondary liquidity is the old resale path, out of Pass-0 scope).
 */
export async function fetchUnifiedChain(connection: Connection, programId: PublicKey): Promise<UnifiedChainRow[]> {
  const [vaultAccts, series, orders, assetMap] = await Promise.all([
    getByDisc(connection, programId, DISC.sharedVault),
    fetchSeries(connection, programId),
    fetchBook(connection, programId),
    fetchMarketAssetMap(connection, programId),
  ]);

  const seriesByVault = new Map<string, SeriesRecord>();
  for (const s of series) seriesByVault.set(s.vault, s);
  const book = indexBook(orders);

  const rows: UnifiedChainRow[] = [];
  for (const a of vaultAccts) {
    const v = parseSharedVault(a.pubkey, a.data);
    if (!v) continue;
    const ser = seriesByVault.get(v.pubkey);
    const side = ser ? book.get(ser.optionMint) : undefined;
    const bestBid = side && side.bids.length ? side.bids[0].price : null;
    const bestAsk = side && side.asks.length ? side.asks[0].price : null;
    rows.push({
      key: `${assetMap.get(v.market) ?? "?"}|${v.strike}|${v.expiry}|${v.optionType}`,
      // series = canonical book/peg mint; epoch/custom per-writer vaults both
      // trade the classic path (routing keys on "series" only) — label-only split.
      provenance: ser ? "series" : v.vaultType === "epoch" ? "epoch" : "legacy",
      asset: assetMap.get(v.market) ?? "?",
      strike: v.strike,
      expiry: v.expiry,
      optionType: v.optionType,
      exerciseStyle: v.exerciseStyle,
      vault: v.pubkey,
      optionMint: ser ? ser.optionMint : null,
      oi: ser ? ser.quantitySold : v.totalOptionsSold,
      bestBid,
      bestAsk,
      bidQty: side ? side.bids.reduce((n, o) => n + o.qty, 0) : 0,
      askQty: side ? side.asks.reduce((n, o) => n + o.qty, 0) : 0,
      isSettled: v.isSettled,
      voided: v.voided,
    });
  }
  return rows;
}
