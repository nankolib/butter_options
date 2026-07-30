// =============================================================================
// scan.ts — enumerate fillable ResaleAsks and resolve everything needed to price
// =============================================================================
//
// Reads via raw getProgramAccounts + discriminator memcmp + per-account
// coder.decode wrapped in try/catch — NEVER Anchor's .all(), which throws
// "offset out of range" on a single legacy orphan and empties the entire scan.
// There are known corrupt vaults on devnet; a scanner that dies on them is a
// scanner that silently stops bidding.
//
// SCOPE: ResaleAsk only. A ResaleAsk is a real user selling contracts they
// already hold — the exit the treasury exists to provide. WriterAsk (mint-on-
// fill) and Bid are deliberately out of scope: buying a WriterAsk funds a writer
// rather than exiting a holder, and filling a Bid would mean SELLING, which this
// bot has no inventory policy for.
// =============================================================================

import type { Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram, type AccountInfo } from "@solana/web3.js";
import { PROGRAM_ID } from "./ids";
import { bnNum } from "./chain";
import { log } from "./log";

export interface ResaleAsk {
  pubkey: PublicKey;
  owner: PublicKey;
  optionMint: PublicKey;
  vault: PublicKey;
  priceUsdc: number;        // human USDC per contract
  quantityRemaining: number;
  createdAtSec: number;
}

export interface SeriesTerms {
  market: PublicKey;
  strikeUsd: number;
  expiryTs: number;
  side: "call" | "put";
  isEuropean: boolean;
  carryRateBps: number;
  isSettled: boolean;
  voided: boolean;
}

function memcmpFilter(program: Program<any>, accountName: string) {
  const { offset, bytes } = (program.coder.accounts as any).memcmp(accountName);
  return { memcmp: { offset, bytes } };
}

/** Every resting ResaleAsk on the book, from any owner. */
export async function enumerateResaleAsks(program: Program<any>): Promise<ResaleAsk[]> {
  const connection: Connection = program.provider.connection;
  const raw = await connection.getProgramAccounts(PROGRAM_ID, {
    commitment: "confirmed",
    filters: [memcmpFilter(program, "restingOrder")],
  });
  const out: ResaleAsk[] = [];
  for (const { pubkey, account } of raw) {
    let r: any;
    try {
      r = program.coder.accounts.decode("restingOrder", account.data);
    } catch {
      continue; // legacy / corrupt orphan
    }
    if (!r.kind || !("resaleAsk" in r.kind)) continue;
    const qty = bnNum(r.quantityRemaining ?? r.quantity_remaining, 0);
    if (qty <= 0) continue;
    out.push({
      pubkey,
      owner: new PublicKey(r.owner),
      optionMint: new PublicKey(r.optionMint ?? r.option_mint),
      vault: new PublicKey(r.vault),
      priceUsdc: bnNum(r.pricePerContract ?? r.price_per_contract, 0) / 1e6,
      quantityRemaining: qty,
      createdAtSec: bnNum(r.createdAt ?? r.created_at, 0),
    });
  }
  return out;
}

/**
 * Read the SharedVault behind each distinct series. The vault — not the mint —
 * carries strike/expiry/type/style/carry, so one batched read per series gives
 * the full pricing input set. Batched at 100 (getMultipleAccounts' limit).
 */
export async function loadSeriesTerms(
  program: Program<any>, vaults: PublicKey[],
): Promise<Map<string, SeriesTerms>> {
  const out = new Map<string, SeriesTerms>();
  if (vaults.length === 0) return out;
  const connection: Connection = program.provider.connection;

  for (let i = 0; i < vaults.length; i += 100) {
    const chunk = vaults.slice(i, i + 100);
    let infos: (AccountInfo<Buffer> | null)[];
    try {
      infos = await connection.getMultipleAccountsInfo(chunk, "confirmed");
    } catch (e: any) {
      log.warn("vault-batch-fail", { err: String(e?.message ?? e).slice(0, 160) });
      continue;
    }
    chunk.forEach((pk, j) => {
      const info = infos[j];
      if (!info) return;
      let v: any;
      try {
        v = program.coder.accounts.decode("sharedVault", info.data);
      } catch {
        return; // size-drifted / corrupt vault — never guess at the layout
      }
      out.set(pk.toBase58(), {
        market: new PublicKey(v.market),
        strikeUsd: bnNum(v.strikePrice ?? v.strike_price, 0) / 1e6,
        expiryTs: bnNum(v.expiry, 0),
        side: v.optionType && "put" in v.optionType ? "put" : "call",
        // Anything that is not explicitly American is treated as European, i.e.
        // skipped. An unrecognised style must fail CLOSED.
        isEuropean: !(v.exerciseStyle && "american" in v.exerciseStyle),
        carryRateBps: bnNum(v.carryRateBps ?? v.carry_rate_bps, 0),
        isSettled: Boolean(v.isSettled ?? v.is_settled),
        voided: Boolean(v.voided),
      });
    });
  }
  return out;
}

/**
 * Which of these pubkeys are real wallets. Chain-verified by System Program
 * ownership, the same test the indexer uses — a PDA, mint or token account is
 * owned by its program, never by 11111…
 *
 * Fails CLOSED: an account that cannot be read, or does not exist, is reported
 * NOT a wallet. Paying a pubkey we could not classify is strictly worse than
 * skipping an order that will still be there next tick.
 */
export async function classifyWallets(
  connection: Connection, pubkeys: PublicKey[],
): Promise<Set<string>> {
  const wallets = new Set<string>();
  for (let i = 0; i < pubkeys.length; i += 100) {
    const chunk = pubkeys.slice(i, i + 100);
    let infos: (AccountInfo<Buffer> | null)[];
    try {
      infos = await connection.getMultipleAccountsInfo(chunk, "confirmed");
    } catch (e: any) {
      log.warn("owner-batch-fail", { err: String(e?.message ?? e).slice(0, 160) });
      continue; // leave the whole chunk unclassified => not-a-wallet => skipped
    }
    chunk.forEach((pk, j) => {
      const info = infos[j];
      if (info && info.owner.equals(SystemProgram.programId) && info.data.length === 0) {
        wallets.add(pk.toBase58());
      }
    });
  }
  return wallets;
}
