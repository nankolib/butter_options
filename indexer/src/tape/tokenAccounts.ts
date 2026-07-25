// =============================================================================
// tokenAccounts.ts — ATA -> owner resolution, cached
// =============================================================================
//
// SPL transfers name TOKEN ACCOUNTS, but every downstream metric is per WALLET.
// Resolving the owner needs a chain read. A token account's mint and owner are
// immutable in practice for our purposes, so the mapping is cached permanently.
//
// Classic SPL Token account layout: mint(0..32) owner(32..64) amount(64..72).
// =============================================================================

/**
 * Exact size of an SPL Token account. Token-2022 accounts are this plus
 * extension bytes, so `>=` is the correct test. An SPL Mint is 82 bytes and is
 * therefore rejected — which is the whole point (see the guard below).
 */
export const TOKEN_ACCOUNT_LEN = 165;

import bs58 from "bs58";

import type { DB } from "../db";
import { log } from "../log";
import type { RpcClient } from "./rpc";

export class TokenAccountResolver {
  private readonly cache = new Map<string, { owner: string; mint: string }>();

  constructor(
    private readonly db: DB,
    private readonly rpc: RpcClient,
  ) {
    const rows = db.prepare("SELECT ata, owner, mint FROM token_accounts").all() as {
      ata: string;
      owner: string;
      mint: string;
    }[];
    for (const r of rows) this.cache.set(r.ata, { owner: r.owner, mint: r.mint });
  }

  get(ata: string): { owner: string; mint: string } | null {
    return this.cache.get(ata) ?? null;
  }

  /** ata -> mint view, for splDecode's plain-Transfer attribution. */
  mintMap(): ReadonlyMap<string, string> {
    const m = new Map<string, string>();
    for (const [ata, v] of this.cache) m.set(ata, v.mint);
    return m;
  }

  /** Resolve any unknown accounts via getMultipleAccounts, then cache them. */
  async resolve(atas: readonly string[]): Promise<void> {
    const missing = [...new Set(atas)].filter((a) => !this.cache.has(a));
    if (missing.length === 0) return;

    const ins = this.db.prepare(
      "INSERT OR IGNORE INTO token_accounts (ata, owner, mint) VALUES (?, ?, ?)",
    );

    for (let i = 0; i < missing.length; i += 100) {
      const chunk = missing.slice(i, i + 100);
      let infos: ({ data: [string, string] } | null)[];
      try {
        const res = await this.rpc.call<{ value: ({ data: [string, string] } | null)[] }>(
          "getMultipleAccounts",
          [chunk, { encoding: "base64", commitment: "confirmed" }],
        );
        infos = res?.value ?? [];
      } catch (e) {
        log.warn("token account resolve failed", { n: chunk.length, err: (e as Error).message });
        continue;
      }
      const rows: [string, string, string][] = [];
      for (let j = 0; j < chunk.length; j++) {
        const info = infos[j];
        if (!info?.data?.[0]) continue;
        const buf = Buffer.from(info.data[0], "base64");
        // MUST be >= TOKEN_ACCOUNT_LEN, not 72.
        //
        // An SPL *Mint* is 82 bytes, so a `< 72` guard let mints through and
        // parsed them as accounts: mint = bytes[0..32], owner = bytes[32..64],
        // both garbage. That is how the wrapped-SOL mint ended up in
        // wallet_metrics and on the profit board with a $10,000 faucet balance.
        // A token account is EXACTLY 165 bytes (Token-2022 adds extensions on
        // top), which no mint can satisfy.
        if (buf.length < TOKEN_ACCOUNT_LEN) continue;
        const mint = bs58.encode(buf.subarray(0, 32));
        const owner = bs58.encode(buf.subarray(32, 64));
        // A token account never owns itself and never has itself as its mint.
        if (owner === chunk[j] || mint === chunk[j]) continue;
        this.cache.set(chunk[j], { owner, mint });
        rows.push([chunk[j], owner, mint]);
      }
      if (rows.length) {
        this.db.transaction(() => {
          for (const r of rows) ins.run(r[0], r[1], r[2]);
        })();
      }
    }
  }
}
