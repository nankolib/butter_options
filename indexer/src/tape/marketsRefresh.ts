// =============================================================================
// marketsRefresh.ts — market -> underlying REFERENCE projection
// =============================================================================
//
// Quest W3 needs a fill's UNDERLYING and its asset class, which the tape cannot
// supply: events carry `option_mint` and `vault`, never an asset name. The edge
// mint -> vault -> market comes from the tape (SeriesCreated / VaultCreated);
// market -> (asset_name, asset_class) needs on-chain state.
//
// gPA over OptionsMarket (464 accounts at build time — cheap). This is REFERENCE
// data, rebuildable at will, never tape.
//
// OptionsMarket layout after the 8-byte discriminator:
//   asset_name: String  (4-byte LE length + utf8 bytes)
//   ... asset_class: u8 appears later in the struct, so the record is parsed
//   positionally from the account data rather than guessed at a fixed offset.
// =============================================================================

import bs58 from "bs58";
import { createHash } from "node:crypto";

import type { DB } from "../db";
import { log } from "../log";
import type { RpcClient } from "./rpc";

export interface MarketRow {
  pubkey: string;
  assetName: string;
  assetClass: number;
}

export const ASSET_CLASS = {
  Crypto: 0,
  Commodity: 1,
  Equity: 2,
  FX: 3,
  ETF: 4,
} as const;

/**
 * D10: {Equity, ETF} are ONE bucket for the W3 class-span bonus. On-chain they
 * are distinct classes, but "trade an equity" reads the same to a user whether
 * the instrument is AAPL or SPY.
 */
export function spanBucket(assetClass: number): string {
  if (assetClass === ASSET_CLASS.Equity || assetClass === ASSET_CLASS.ETF) return "equity";
  if (assetClass === ASSET_CLASS.Crypto) return "crypto";
  if (assetClass === ASSET_CLASS.Commodity) return "commodity";
  if (assetClass === ASSET_CLASS.FX) return "fx";
  return "other";
}

function accountDiscriminator(name: string): Buffer {
  return createHash("sha256").update(`account:${name}`).digest().subarray(0, 8);
}

/**
 * Parse asset_name + asset_class out of a raw OptionsMarket account.
 *
 * Layout (programs/opta/src/state/market.rs), Borsh, after the 8-byte account
 * discriminator:
 *   asset_name    String   4-byte LE length + utf8 (max_len 16)
 *   pyth_feed_id  [u8; 32]
 *   asset_class   u8       0 crypto | 1 commodity | 2 equity | 3 forex | 4 ETF
 *   bump          u8
 *   oracle_source u8       trailing-appended; ABSENT on legacy 62-byte markets
 *
 * Note `max_len(16)` sizes the ACCOUNT, while Borsh writes the actual string
 * length — so asset_class sits at a name-dependent offset, not a fixed one.
 */
export function parseMarket(data: Buffer): { assetName: string; assetClass: number } | null {
  try {
    let o = 8;
    if (data.length < o + 4) return null;
    const nameLen = data.readUInt32LE(o);
    o += 4;
    if (nameLen === 0 || nameLen > 16 || data.length < o + nameLen) return null;
    const assetName = data.subarray(o, o + nameLen).toString("utf8");
    o += nameLen + 32; // skip pyth_feed_id
    if (data.length < o + 1) return null;
    const assetClass = data[o];
    if (assetClass > 4) return null; // not a valid class — refuse rather than guess
    return { assetName, assetClass };
  } catch {
    return null;
  }
}

export async function refreshMarkets(db: DB, rpc: RpcClient, programId: string): Promise<number> {
  let accounts: { pubkey: string; account: { data: [string, string] } }[];
  try {
    accounts = await rpc.call("getProgramAccounts", [
      programId,
      {
        encoding: "base64",
        commitment: "confirmed",
        filters: [{ memcmp: { offset: 0, bytes: bs58.encode(accountDiscriminator("OptionsMarket")) } }],
      },
    ]);
  } catch (e) {
    log.warn("markets refresh failed — keeping previous reference data", { err: (e as Error).message });
    return 0;
  }
  if (!Array.isArray(accounts)) return 0;

  const ins = db.prepare(
    `INSERT INTO markets (pubkey, asset_name, asset_class, refreshed_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(pubkey) DO UPDATE SET
       asset_name = excluded.asset_name,
       asset_class = excluded.asset_class,
       refreshed_at = excluded.refreshed_at`,
  );
  const now = Math.floor(Date.now() / 1000);
  let n = 0;
  db.transaction(() => {
    for (const a of accounts) {
      const parsed = parseMarket(Buffer.from(a.account.data[0], "base64"));
      if (!parsed) continue;
      ins.run(a.pubkey, parsed.assetName, parsed.assetClass, now);
      n += 1;
    }
  })();
  log.info("markets refreshed", { markets: n });
  return n;
}
