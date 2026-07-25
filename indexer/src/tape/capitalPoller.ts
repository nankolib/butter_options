// =============================================================================
// capitalPoller.ts — Part A: faucet provenance + external capital flows
// =============================================================================
//
// TWO LOOPS, each with its OWN cursor, both independent of the main program
// cursor so a restart resumes each where it left off:
//
//   faucetTick()  cursor `faucet_cursor_sig` in meta. Walks the faucet wallet's
//                 signatures. Every USDC/SOL transfer OUT of the faucet is a
//                 claim. Volume is tiny (45 signatures all-time at build).
//
//   ataTick()     per-ATA cursors in `ata_cursors`. D9: eligible wallets ONLY
//                 (>=1 event on the main tape), capped at OPTA_INDEXER_ATA_MAX,
//                 overflow LOGGED not silently dropped.
//
// ⚠ SCALING LIMIT, ON THE RECORD (D9). External inflow detection is O(wallets):
// a plain SPL `transfer` does not name the mint, so no single account observes
// every USDC movement. At ~500 active wallets this loop needs replacing with a
// Helius webhook or a mint-wide stream. That is a Phase 3 prerequisite for any
// launch beyond ~500 wallets, not a nice-to-have.
//
// Non-throwing by construction, like every other loop here.
// =============================================================================

import bs58 from "bs58";

import type { Config } from "../env";
import { getMeta, setMeta, type DB } from "../db";
import { log } from "../log";
import { decodeUsdcTransfers, type RawIx } from "./splDecode";
import { fullAccountKeys, type RawTx } from "./normalize";
import type { RpcClient } from "./rpc";
import type { TokenAccountResolver } from "./tokenAccounts";

export interface CapitalStats {
  faucetTxs: number;
  faucetClaims: number;
  flowsIndexed: number;
  atasPolled: number;
  atasSkippedOverCap: number;
  failures: number;
}

const LAMPORTS_TAG = 2; // SystemProgram Transfer instruction index
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

export class CapitalPoller {
  constructor(
    private readonly db: DB,
    private readonly rpc: RpcClient,
    private readonly cfg: Config,
    private readonly resolver: TokenAccountResolver,
  ) {}

  /** Vault PDAs, loaded once per tick — a per-transfer query would be O(n²). */
  private _vaults: Set<string> | null = null;
  private vaultSet(): Set<string> {
    if (!this._vaults) {
      this._vaults = new Set(
        (this.db.prepare("SELECT DISTINCT vault AS v FROM events WHERE vault IS NOT NULL").all() as {
          v: string;
        }[]).map((r) => r.v),
      );
    }
    return this._vaults;
  }
  /** Called at the start of each tick so the vault set reflects new tape rows. */
  resetCaches(): void {
    this._vaults = null;
  }

  private insClaim = this.db.prepare(
    `INSERT OR IGNORE INTO faucet_claims (sig, wallet, kind, amount, block_time)
     VALUES (?, ?, ?, ?, ?)`,
  );
  private insFlow = this.db.prepare(
    `INSERT OR IGNORE INTO capital_flows (id, wallet, direction, source, amount_usdc, counterparty, block_time)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  /** Decode SystemProgram transfers (the SOL faucet path). */
  private solTransfers(ixs: readonly RawIx[], keys: readonly string[]): { to: string; lamports: bigint }[] {
    const out: { to: string; lamports: bigint }[] = [];
    for (const ix of ixs) {
      if (keys[ix.programIdIndex] !== SYSTEM_PROGRAM) continue;
      let data: Buffer;
      try {
        data = Buffer.from(bs58.decode(ix.data));
      } catch {
        continue;
      }
      if (data.length < 12) continue;
      if (data.readUInt32LE(0) !== LAMPORTS_TAG) continue;
      const acc = ix.accounts.map((i) => keys[i]);
      if (acc.length < 2 || !acc[1]) continue;
      out.push({ to: acc[1], lamports: data.readBigUInt64LE(4) });
    }
    return out;
  }

  /** Walk the faucet wallet's signatures; record every outbound claim. */
  async faucetTick(stats: CapitalStats): Promise<void> {
    const cursor = getMeta(this.db, "faucet_cursor_sig");
    const pages: { signature: string }[][] = [];
    let before: string | undefined;
    for (;;) {
      const page = await this.rpc.getSignaturesForAddress(this.cfg.faucetWallet, {
        limit: 1000,
        before,
        until: cursor ?? undefined,
      });
      if (page.length === 0) break;
      pages.push(page);
      if (page.length < 1000) break;
      before = page[page.length - 1].signature;
    }
    if (pages.length === 0) return;
    const newest = pages[0][0].signature;

    for (const page of pages.reverse()) {
      for (let i = 0; i < page.length; i += this.cfg.batchSize) {
        const slice = page.slice(i, i + this.cfg.batchSize);
        let results: (unknown | null)[];
        try {
          results = await this.rpc.getTransactionBatch(slice.map((s) => s.signature));
        } catch (e) {
          stats.failures += slice.length;
          log.warn("faucet batch failed", { err: (e as Error).message });
          continue;
        }
        // Resolve any unseen token accounts in one pass before decoding.
        const raws = results.filter((r): r is RawTx => r != null);
        const candidateAtas = new Set<string>();
        for (const raw of raws) {
          for (const k of fullAccountKeys(raw)) candidateAtas.add(k);
        }
        await this.resolver.resolve([...candidateAtas]);

        for (const raw of raws) {
          try {
            this.ingestFaucetTx(raw, stats);
          } catch (e) {
            stats.failures += 1;
            log.warn("faucet tx decode failed", { err: (e as Error).message });
          }
        }
        stats.faucetTxs += raws.length;
      }
    }
    setMeta(this.db, "faucet_cursor_sig", newest);
  }

  private ingestFaucetTx(raw: RawTx, stats: CapitalStats): void {
    if (raw.meta?.err != null) return;
    const sig = raw.transaction.signatures[0];
    const bt = raw.blockTime ?? null;
    const keys = fullAccountKeys(raw);
    const ixs = raw.transaction.message.instructions ?? [];

    // --- USDC claims -------------------------------------------------------
    const transfers = decodeUsdcTransfers(ixs, keys, this.cfg.usdcMint, this.resolver.mintMap());
    for (const t of transfers) {
      const src = this.resolver.get(t.source);
      const dst = this.resolver.get(t.destination);
      if (src?.owner !== this.cfg.faucetWallet) continue; // outbound only
      if (!dst?.owner) continue;
      this.insClaim.run(sig, dst.owner, "usdc", Number(t.amount), bt);
      this.insFlow.run(`${sig}:${t.ordinal}`, dst.owner, "in", "faucet", Number(t.amount), this.cfg.faucetWallet, bt);
      stats.faucetClaims += 1;
      stats.flowsIndexed += 1;
    }

    // --- SOL claims (gas; no capital_flows row — not USDC) -----------------
    for (const s of this.solTransfers(ixs, keys)) {
      if (s.to === this.cfg.faucetWallet) continue;
      this.insClaim.run(sig, s.to, "sol", Number(s.lamports), bt);
      stats.faucetClaims += 1;
    }
  }

  /** Eligible wallets = anything with >=1 event on the main tape, minus PDAs. */
  private eligibleWallets(): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT w AS wallet FROM (
             SELECT wallet AS w FROM events WHERE wallet IS NOT NULL
             UNION SELECT counterparty AS w FROM events WHERE counterparty IS NOT NULL
           )
           WHERE w NOT IN (SELECT DISTINCT vault FROM events WHERE vault IS NOT NULL)
           ORDER BY w ASC`,
        )
        .all() as { wallet: string }[]
    ).map((r) => r.wallet);
  }

  /** Poll each eligible wallet's USDC ATA for non-faucet capital movement. */
  async ataTick(stats: CapitalStats): Promise<void> {
    const all = this.eligibleWallets();
    const wallets = all.slice(0, this.cfg.ataMax);
    if (all.length > wallets.length) {
      stats.atasSkippedOverCap = all.length - wallets.length;
      // NEVER silent: a truncated provenance set would read as "no external
      // funding" and wrongly qualify wallets for the profit board.
      log.warn("ATA poll cap hit — provenance INCOMPLETE for the overflow", {
        eligible: all.length,
        polled: wallets.length,
        skipped: stats.atasSkippedOverCap,
        cap: this.cfg.ataMax,
      });
    }

    // Resolve each wallet's USDC ATA by looking for a cached token account it owns.
    const ataOf = new Map<string, string>();
    const known = this.db
      .prepare("SELECT ata, owner FROM token_accounts WHERE mint = ?")
      .all(this.cfg.usdcMint) as { ata: string; owner: string }[];
    for (const k of known) if (wallets.includes(k.owner)) ataOf.set(k.owner, k.ata);

    const upsertCursor = this.db.prepare(
      `INSERT INTO ata_cursors (ata, wallet, cursor_sig, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(ata) DO UPDATE SET cursor_sig = excluded.cursor_sig, updated_at = excluded.updated_at`,
    );

    for (const wallet of wallets) {
      const ata = ataOf.get(wallet);
      if (!ata) continue; // no USDC ATA seen yet — nothing to poll
      const row = this.db.prepare("SELECT cursor_sig FROM ata_cursors WHERE ata = ?").get(ata) as
        | { cursor_sig: string | null }
        | undefined;
      try {
        const page = await this.rpc.getSignaturesForAddress(ata, {
          limit: 1000,
          until: row?.cursor_sig ?? undefined,
        });
        stats.atasPolled += 1;
        if (page.length === 0) continue;
        const newest = page[0].signature;
        for (let i = 0; i < page.length; i += this.cfg.batchSize) {
          const slice = page.slice(i, i + this.cfg.batchSize);
          const results = await this.rpc.getTransactionBatch(slice.map((s) => s.signature));
          const raws = results.filter((r): r is RawTx => r != null);
          const cand = new Set<string>();
          for (const raw of raws) for (const k of fullAccountKeys(raw)) cand.add(k);
          await this.resolver.resolve([...cand]);
          for (const raw of raws) this.ingestFlowTx(raw, wallet, stats);
        }
        upsertCursor.run(ata, wallet, newest, Math.floor(Date.now() / 1000));
      } catch (e) {
        stats.failures += 1;
        log.warn("ata poll failed", { wallet, err: (e as Error).message });
      }
    }
  }

  private ingestFlowTx(raw: RawTx, wallet: string, stats: CapitalStats): void {
    if (raw.meta?.err != null) return;
    const sig = raw.transaction.signatures[0];
    const bt = raw.blockTime ?? null;
    const keys = fullAccountKeys(raw);
    const ixs = raw.transaction.message.instructions ?? [];

    for (const t of decodeUsdcTransfers(ixs, keys, this.cfg.usdcMint, this.resolver.mintMap())) {
      const src = this.resolver.get(t.source);
      const dst = this.resolver.get(t.destination);
      const from = src?.owner ?? null;
      const to = dst?.owner ?? null;
      if (from !== wallet && to !== wallet) continue;

      // A transfer whose counterparty is the PROGRAM's own escrow/vault is
      // protocol flow, already accounted on the main tape — not external capital.
      const isProtocol = (p: string | null) => p != null && this.vaultSet().has(p);

      if (to === wallet && from !== wallet) {
        if (isProtocol(from)) continue;
        const source = from === this.cfg.faucetWallet ? "faucet" : "external";
        this.insFlow.run(`${sig}:${t.ordinal}`, wallet, "in", source, Number(t.amount), from, bt);
        stats.flowsIndexed += 1;
      } else if (from === wallet && to !== wallet) {
        if (isProtocol(to)) continue;
        this.insFlow.run(`${sig}:${t.ordinal}`, wallet, "out", "external", Number(t.amount), to, bt);
        stats.flowsIndexed += 1;
      }
    }
  }
}

export function emptyCapitalStats(): CapitalStats {
  return { faucetTxs: 0, faucetClaims: 0, flowsIndexed: 0, atasPolled: 0, atasSkippedOverCap: 0, failures: 0 };
}
