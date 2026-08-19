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
import { Buffer } from "buffer";
import { coalescedProgramAccounts, invalidateProgramAccounts } from "./programAccounts";
import { canonicalAsset } from "./assetDisplay";
import { getIndexerReader } from "./indexerRegistry";

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
  // Coalesced + timeout-bounded (see programAccounts.ts) — the Trade page scans
  // sharedVault / vaultMint / optionsMarket / restingOrder here AND via
  // safeFetchAll concurrently; sharing one in-flight request per discriminator
  // halves the mount burst that rate-limits public devnet.
  const raw = await coalescedProgramAccounts(connection, programId, disc);
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
  return accts
    .map((a) => parseRestingOrder(a.pubkey, a.data))
    .filter((o): o is BookOrder => o !== null && !isSuppressed(o.pubkey));
}

// ---- Optimistic suppression -------------------------------------------------
// A just-cancelled/filled order can still be returned by a lagging
// getProgramAccounts for a slot or two after the tx confirms. Suppressed pubkeys
// are dropped from every fetchBook result (book + unified chain, which both parse
// RestingOrder here) until the TTL, so an early reconcile can't re-introduce a
// removed order after the optimistic layer took it out.
const suppressed = new Map<string, number>(); // pubkey -> expiry (ms)
const SUPPRESS_TTL_MS = 8000;

export function suppressOrders(pubkeys: string[], ttlMs = SUPPRESS_TTL_MS): void {
  const until = Date.now() + ttlMs;
  for (const p of pubkeys) suppressed.set(p, until);
}
function isSuppressed(pubkey: string): boolean {
  const until = suppressed.get(pubkey);
  if (until == null) return false;
  if (Date.now() > until) { suppressed.delete(pubkey); return false; }
  return true;
}

/** Drop the coalesced RestingOrder scan so the next book fetch is chain-fresh. */
export function invalidateBookCache(programId: PublicKey): void {
  invalidateProgramAccounts(programId, DISC.restingOrder);
}
/** Drop the coalesced SharedVault + VaultMint scans (OI / series change on fills). */
export function invalidateVaultCache(programId: PublicKey): void {
  invalidateProgramAccounts(programId, DISC.sharedVault);
  invalidateProgramAccounts(programId, DISC.vaultMint);
}

/** Best resting bid/ask for a contract from the LIVE book. THE ONE selector the
 *  grid cells, the book panel, and the sweep all read — no parallel (staler)
 *  derivation. Asks include resaleAsk + writerAsk (vaultPeg never rests), and
 *  indexBook sorts bids high→low + asks low→high, so [0] is the best on each side
 *  → ask = min(resale, writer). Fed by useBook, so a posted/cancelled order (bus
 *  → optimistic + reconcile) updates the cell instantly. */
export function bestRestingBidAsk(
  byOptionMint: Map<string, { bids: BookOrder[]; asks: BookOrder[] }>,
  optionMint: string | null,
): { bid: number | null; ask: number | null } {
  const side = optionMint ? byOptionMint.get(optionMint) : undefined;
  return {
    bid: side && side.bids.length ? side.bids[0].price : null,
    ask: side && side.asks.length ? side.asks[0].price : null,
  };
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

/** Pubkey::default(), the sentinel writer on a canonical series record. */
const DEFAULT_PUBKEY = "11111111111111111111111111111111";

/**
 * The index-served form of isSeriesSentinel, from rehydrated fields rather than
 * raw bytes. Kept beside its byte-offset twin ON PURPOSE: the two must agree, and
 * the grid-migration harness asserts exactly that against live accounts
 * (4,581 compared, 0 disagreements).
 */
function isSeriesSentinelRow(a: any): boolean {
  return a.writer?.toBase58?.() === DEFAULT_PUBKEY
    && a.premiumPerContract?.toString?.() === "0"
    && a.createdAt?.toString?.() === "0";
}

export async function fetchSeries(
  connection: Connection,
  programId: PublicKey,
  market?: string,
): Promise<SeriesRecord[]> {
  // INDEX FIRST when the FE has registered a reader. The crank never registers
  // one, so it keeps scanning chain — correct, since a keeper must not act on an
  // index. Any failure returns null and falls through to the scan below.
  const indexer = getIndexerReader();
  if (indexer) {
    const res = await indexer("vaultMint", market ? { market } : undefined);
    if (res) {
      return res.rows
        .filter((r) => isSeriesSentinelRow(r.account))
        .map((r) => {
          const a = r.account as any;
          return {
            recordPubkey: r.publicKey.toBase58(),
            vault: a.vault.toBase58(),
            optionMint: a.optionMint.toBase58(),
            quantityMinted: Number(a.quantityMinted.toString()),
            quantitySold: Number(a.quantitySold.toString()),
          };
        });
    }
  }
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

/** Exported as a TEST SEAM for the grid-migration divergence harness, which
 *  compares this byte-offset parse against the indexer's JSON on the same slot.
 *  Behaviour is unchanged; only its visibility is. */
/** The ONLY accepted SharedVault length. See the length gate below. */
const SHARED_VAULT_LEN = 276;

export function parseSharedVault(pubkey: PublicKey, d: Buffer): SharedVaultLite | null {
  // EXACT LENGTH, not >= 260.
  //
  // This used to accept anything from 260 bytes up, so 14 pre-Stage-2 vaults
  // rendered on the grid with their fields read at the CURRENT layout's offsets
  // — which is to say, read from the wrong places. One of them decodes
  // collateral_remaining as 4,118,276,548,812,483,240. Rendering that is the
  // silent-wrong-number failure mode, not a kindness.
  //
  // Dropping them is a PRODUCT DECISION, taken deliberately and paired with a
  // ledger rather than made quietly by a decoder: those 14 hold 261,863.58
  // devnet USDC across 13 funded accounts, recorded in ClickUp 86eyp4hem with
  // per-vault balances. Token-account balances are authoritative there; struct
  // fields are not decodable under any current layout.
  //
  // This also aligns with the indexer, which has always required exactly 276, so
  // both decoders now agree and the grid-migration divergence harness stays
  // clean.
  if (d.length !== SHARED_VAULT_LEN) return null;
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
/** Exported as a TEST SEAM (see parseSharedVault). */
export async function fetchMarketAssetMap(connection: Connection, programId: PublicKey): Promise<Map<string, string>> {
  const indexer = getIndexerReader();
  if (indexer) {
    const res = await indexer("optionsMarket");
    if (res) {
      const m = new Map<string, string>();
      for (const r of res.rows) {
        const asset = (r.account as any).assetName;
        if (asset) m.set(r.publicKey.toBase58(), asset);
      }
      return m;
    }
  }
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
export async function fetchUnifiedChain(
  connection: Connection,
  programId: PublicKey,
  market?: string,
): Promise<UnifiedChainRow[]> {
  // The vault side may come from the index, market-filtered. fetchBook is
  // DELIBERATELY untouched and always reads chain: a stale book shows a filled
  // order as live, and the whole point of the boundary is that the book never
  // moves off chain.
  const indexer = getIndexerReader();
  const vaultsFromIndex = indexer
    ? await indexer("sharedVault", market ? { market } : undefined)
    : null;

  const [vaultAcctsRaw, series, orders, assetMap] = await Promise.all([
    vaultsFromIndex ? Promise.resolve(null) : getByDisc(connection, programId, DISC.sharedVault),
    fetchSeries(connection, programId, market),
    fetchBook(connection, programId),
    fetchMarketAssetMap(connection, programId),
  ]);

  /** One shape for the loop below, whichever source produced it. */
  const vaultAccts: { pubkey: PublicKey; data: Buffer }[] | null = vaultAcctsRaw;
  const indexRows = vaultsFromIndex?.rows ?? null;

  const seriesByVault = new Map<string, SeriesRecord>();
  for (const s of series) seriesByVault.set(s.vault, s);
  const book = indexBook(orders);

  /** Index rows arrive already decoded; chain rows need the byte parse. Both
   *  produce the identical SharedVaultLite — asserted on live accounts by
   *  crank/gridMigration.divergence.ts (4,665 compared, 0 mismatches). */
  const lite: (SharedVaultLite | null)[] = indexRows
    ? indexRows.map((r) => {
        const a = r.account as any;
        return {
          pubkey: r.publicKey.toBase58(),
          market: a.market.toBase58(),
          optionType: Object.keys(a.optionType)[0] === "call" ? "call" : "put",
          strike: Number(a.strikePrice.toString()) / MICRO,
          expiry: Number(a.expiry.toString()),
          vaultType: Object.keys(a.vaultType)[0] === "epoch" ? "epoch" : "custom",
          totalOptionsSold: Number(a.totalOptionsSold.toString()),
          isSettled: a.isSettled,
          exerciseStyle: Object.keys(a.exerciseStyle)[0] === "american" ? "american" : "european",
          voided: a.voided,
        } as SharedVaultLite;
      })
    : (vaultAccts ?? []).map((a) => parseSharedVault(a.pubkey, a.data));

  const rows: UnifiedChainRow[] = [];
  for (const v of lite) {
    if (!v) continue;
    // Canonical display symbol (hides Switchboard "SB…" seeds + raw "…SPOT" feeds
    // at the data layer, so provenance never reaches ANY surface). null = drop.
    const asset = canonicalAsset(assetMap.get(v.market));
    if (!asset) continue;
    const ser = seriesByVault.get(v.pubkey);
    const side = ser ? book.get(ser.optionMint) : undefined;
    const bestBid = side && side.bids.length ? side.bids[0].price : null;
    const bestAsk = side && side.asks.length ? side.asks[0].price : null;
    rows.push({
      key: `${asset}|${v.strike}|${v.expiry}|${v.optionType}`,
      // series = canonical book/peg mint; epoch/custom per-writer vaults both
      // trade the classic path (routing keys on "series" only) — label-only split.
      provenance: ser ? "series" : v.vaultType === "epoch" ? "epoch" : "legacy",
      asset,
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
