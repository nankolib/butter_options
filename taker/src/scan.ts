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
// SCOPE: the two ASK kinds a real user can post.
//   ResaleAsk (kind 1)  a holder selling contracts they already own — the exit
//                       the treasury exists to provide.
//   WriterAsk (kind 2)  a user writing new contracts against escrowed collateral
//                       (the trade ticket's Write side). Filling MINTS, so it
//                       CREATES open interest — bounded separately by maxOiUsd.
//
// Both complete quest O3 ("Make a Market"), which keys on OrderFilled where the
// wallet is the counterparty and kind != VaultPeg. Covering only ResaleAsk left
// the trade ticket's Write side a dead end for O3.
//
// Bid (kind 0) stays out of scope: filling one means SELLING, and this bot has
// no inventory policy. VaultPeg (kind 3) is the protocol's own peg, not a user.
// =============================================================================

import type { Program } from "@coral-xyz/anchor";
import { Connection, PublicKey, SystemProgram, type AccountInfo } from "@solana/web3.js";
import { PROGRAM_ID } from "./ids";
import { bnNum } from "./chain";
import { log } from "./log";

export type AskKind = "resaleAsk" | "writerAsk";

export interface UserAsk {
  pubkey: PublicKey;
  owner: PublicKey;
  optionMint: PublicKey;
  vault: PublicKey;
  kind: AskKind;
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

/**
 * Map a decoded Anchor OrderKind to the ask kinds the taker will fill, or null.
 *
 * PURE and exported ON PURPOSE. This was inline in the scan loop, which meant
 * the single most consequential line in the scanner — the one deciding whether
 * a Bid can reach the fill path — sat behind a getProgramAccounts call and no
 * test could reach it. Mutation testing caught exactly that: breaking this
 * selection left the whole suite green.
 *
 * The test is POSITIVE and exhaustive. "Not a bid" would let VaultPeg, and any
 * future OrderKind variant, fall through into the buy path by default.
 */
export function kindOf(rawKind: unknown): AskKind | null {
  if (rawKind == null || typeof rawKind !== "object") return null;
  const k = rawKind as Record<string, unknown>;
  if ("resaleAsk" in k) return "resaleAsk";
  if ("writerAsk" in k) return "writerAsk";
  return null; // bid, vaultPeg, or anything added later
}

/**
 * Every resting user ask on the book — both kinds, from any owner.
 *
 * The kind test is POSITIVE and exhaustive (`resaleAsk` or `writerAsk`), never
 * "not a bid". A future OrderKind variant must be opted in deliberately rather
 * than fall through into the fill path because it happened not to be excluded.
 */
export async function enumerateUserAsks(program: Program<any>): Promise<UserAsk[]> {
  const connection: Connection = program.provider.connection;
  const raw = await connection.getProgramAccounts(PROGRAM_ID, {
    commitment: "confirmed",
    filters: [memcmpFilter(program, "restingOrder")],
  });
  const out: UserAsk[] = [];
  for (const { pubkey, account } of raw) {
    let r: any;
    try {
      r = program.coder.accounts.decode("restingOrder", account.data);
    } catch {
      continue; // legacy / corrupt orphan
    }
    const kind = kindOf(r.kind);
    if (kind == null) continue;
    const qty = bnNum(r.quantityRemaining ?? r.quantity_remaining, 0);
    if (qty <= 0) continue;
    out.push({
      pubkey,
      owner: new PublicKey(r.owner),
      optionMint: new PublicKey(r.optionMint ?? r.option_mint),
      vault: new PublicKey(r.vault),
      kind,
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
