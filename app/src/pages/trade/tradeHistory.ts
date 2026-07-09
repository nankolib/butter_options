// =============================================================================
// app/src/pages/trade/tradeHistory.ts — Trade-dock activity/tape data (React-free)
// =============================================================================
//
// Bounded, real-data-only scans over the on-chain exchange event tape. There is
// no indexer yet, so both exported scans are DELIBERATELY bounded "recent
// activity" reads — the caller labels the surface "recent · full history pending
// indexer". Nothing here fabricates rows: every value is decoded from a real
// Anchor event emitted by the program, or the scan returns [].
//
// Primitive reused verbatim from utils/chartData.ts (fetchContractFills):
//   getSignaturesForAddress(addr, { limit })
//     → getTransaction(sig)
//     → scan meta.logMessages for "Program data: " lines
//     → program.coder.events.decode(line.slice(14))
//
// Events decoded (fields confirmed against src/idl/opta.ts):
//   orderPosted    { order, owner, optionMint, vault, kind:u8, pricePerContract:u64, quantity:u64, nonce:u64, ts:i64 }
//   orderCancelled { order, owner, optionMint, kind:u8, amountReturned:u64, ts:i64 }
//   orderFilled    { order, optionMint, vault, kind:u8, maker, taker, pricePerContract:u64, fillQuantity:u64, fee:u64, quantityRemaining:u64, ts:i64 }
//   orderSwept     { order, owner, optionMint, kind:u8, amountReturned:u64, ts:i64 }
//
// Micro-USDC scaling: pricePerContract is 6-dp fixed point (micro-USDC), divided
// by 1_000_000 exactly as chartData.ts:117 does. Contract quantities are integer
// counts (no scaling). amountReturned is a USDC/contract mix depending on side,
// so cancelled/swept rows carry price=null,qty=null (honest — we don't guess).
// =============================================================================

import { PublicKey } from "@solana/web3.js";
import type { Program } from "@coral-xyz/anchor";

const MICRO = 1_000_000;

// OrderKind u8 discriminator → variant name (Bid=0, ResaleAsk=1, WriterAsk=2,
// VaultPeg=3). Variant order is load-bearing on-chain; mirrors exchangeData.ts.
const ORDER_KINDS = ["bid", "resaleAsk", "writerAsk", "vaultPeg"] as const;

export type ActivityKind = "posted" | "cancelled" | "filled" | "swept";

export interface ActivityEvent {
  kind: ActivityKind;
  optionMint: string;
  orderKind: string;
  side: "buy" | "sell" | null;
  price: number | null;
  qty: number | null;
  ts: number;
  sig: string;
  counterparty?: string | null;
}

export interface TapeTrade {
  ts: number;
  price: number;
  qty: number;
  side: "buy" | "sell" | null;
  sig: string;
}

// ---- helpers ----------------------------------------------------------------

/** u8 order-kind → "bid"|"resaleAsk"|"writerAsk"|"vaultPeg". Defaults "bid". */
function orderKindName(kind: unknown): string {
  const n = typeof kind === "number" ? kind : Number(kind);
  return ORDER_KINDS[n] ?? "bid";
}

/** Book side: a bid is a buy; every ask flavour (resale/writer/peg) is a sell. */
function sideForKind(kind: unknown): "buy" | "sell" | null {
  const name = orderKindName(kind);
  if (name === "bid") return "buy";
  if (name === "resaleAsk" || name === "writerAsk" || name === "vaultPeg") return "sell";
  return null;
}

/** Anchor i64/u64 fields decode as BN (sometimes number). Coerce to number. */
function toNum(v: any): number {
  if (typeof v === "number") return v;
  if (v && typeof v.toNumber === "function") {
    try {
      return v.toNumber();
    } catch {
      /* overflow — fall through */
    }
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Pubkey field → base58, tolerant of already-string or missing values. */
function toBase58(v: any): string | null {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (typeof v.toBase58 === "function") return v.toBase58();
  return null;
}

/** Decode every Anchor event on one transaction's logs. Never throws. */
function decodeEvents(
  program: Program<any>,
  logs: string[],
): { name: string; data: any }[] {
  const out: { name: string; data: any }[] = [];
  for (const l of logs) {
    if (!l.startsWith("Program data: ")) continue;
    try {
      const ev: any = (program.coder as any).events.decode(l.slice(14));
      if (ev?.name) out.push({ name: ev.name, data: ev.data });
    } catch {
      /* not an anchor event line — skip */
    }
  }
  return out;
}

// ---- scanRecentActivity -----------------------------------------------------

/**
 * Bounded scan of ONE wallet's recent exchange activity.
 *
 * Fetches up to `limit` recent signatures that reference `wallet`, pulls each
 * transaction (at most `limit` getTransaction calls — the hard RPC bound), and
 * decodes the four order events. Keeps events where the wallet is the party:
 *   - posted / cancelled / swept : owner == wallet
 *   - filled                     : maker == wallet || taker == wallet
 *
 * Returns newest-first, deduped by (sig + order). Robust to decode/RPC
 * failures — bad lines are skipped, an RPC hiccup returns whatever was
 * gathered so far. Never throws to the caller.
 */
export async function scanRecentActivity(
  program: Program<any>,
  wallet: PublicKey,
  limit = 40,
): Promise<ActivityEvent[]> {
  const conn = program.provider.connection;
  const walletB58 = wallet.toBase58();
  const out: ActivityEvent[] = [];
  const seen = new Set<string>(); // dedupe key: `${sig}|${order}`

  try {
    // Bound 1: at most `limit` signatures.
    const sigs = await conn.getSignaturesForAddress(wallet, { limit });
    for (const s of sigs) {
      if (s.err) continue;
      // Bound 2: at most `limit` getTransaction round-trips (one per sig).
      let tx;
      try {
        tx = await conn.getTransaction(s.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
      } catch {
        continue; // transient RPC failure on one tx — skip it, keep going
      }
      const logs = tx?.meta?.logMessages ?? [];
      const fallbackTs = tx?.blockTime ?? s.blockTime ?? 0;

      for (const { name, data } of decodeEvents(program, logs)) {
        const optionMint = toBase58(data?.optionMint);
        const order = toBase58(data?.order);
        if (!optionMint || !order) continue;

        const ts = toNum(data?.ts) || fallbackTs;
        const orderKind = orderKindName(data?.kind);
        const side = sideForKind(data?.kind);

        let evt: ActivityEvent | null = null;

        if (name === "orderPosted" || name === "orderCancelled" || name === "orderSwept") {
          const owner = toBase58(data?.owner);
          if (owner !== walletB58) continue;
          if (name === "orderPosted") {
            evt = {
              kind: "posted",
              optionMint,
              orderKind,
              side,
              price: toNum(data?.pricePerContract) / MICRO,
              qty: toNum(data?.quantity),
              ts,
              sig: s.signature,
              counterparty: null,
            };
          } else {
            // cancelled / swept: amountReturned mixes USDC vs contracts by side,
            // so we don't publish a misleading price/qty here.
            evt = {
              kind: name === "orderCancelled" ? "cancelled" : "swept",
              optionMint,
              orderKind,
              side,
              price: null,
              qty: null,
              ts,
              sig: s.signature,
              counterparty: null,
            };
          }
        } else if (name === "orderFilled") {
          const maker = toBase58(data?.maker);
          const taker = toBase58(data?.taker);
          const isMaker = maker === walletB58;
          const isTaker = taker === walletB58;
          if (!isMaker && !isTaker) continue;
          evt = {
            kind: "filled",
            optionMint,
            orderKind,
            side,
            price: toNum(data?.pricePerContract) / MICRO,
            qty: toNum(data?.fillQuantity),
            ts,
            sig: s.signature,
            counterparty: isTaker ? maker : taker,
          };
        }

        if (!evt) continue;
        const dedupeKey = `${s.signature}|${order}|${name}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        out.push(evt);
      }
    }
  } catch {
    /* RPC hiccup enumerating signatures — return whatever we gathered */
  }

  return out.sort((a, b) => b.ts - a.ts); // newest-first
}

// ---- fetchRecentTrades ------------------------------------------------------

/**
 * Focused-contract fills tape for ONE option series mint. Mirrors
 * chartData.ts:fetchContractFills but widened to carry `side` (from the order
 * kind) and the transaction `sig`, and returned newest-first for a tape view.
 *
 * Bounded to `limit` getTransaction calls. Never throws.
 */
export async function fetchRecentTrades(
  program: Program<any>,
  optionMint: string,
  limit = 30,
): Promise<TapeTrade[]> {
  const conn = program.provider.connection;
  const out: TapeTrade[] = [];
  const seen = new Set<string>();

  try {
    const sigs = await conn.getSignaturesForAddress(new PublicKey(optionMint), { limit });
    for (const s of sigs) {
      if (s.err) continue;
      let tx;
      try {
        tx = await conn.getTransaction(s.signature, {
          commitment: "confirmed",
          maxSupportedTransactionVersion: 0,
        });
      } catch {
        continue;
      }
      const logs = tx?.meta?.logMessages ?? [];
      const fallbackTs = tx?.blockTime ?? s.blockTime ?? 0;

      for (const { name, data } of decodeEvents(program, logs)) {
        if (name !== "orderFilled") continue;
        if (toBase58(data?.optionMint) !== optionMint) continue;
        const order = toBase58(data?.order);
        const dedupeKey = `${s.signature}|${order}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        out.push({
          ts: toNum(data?.ts) || fallbackTs,
          price: toNum(data?.pricePerContract) / MICRO,
          qty: toNum(data?.fillQuantity),
          side: sideForKind(data?.kind),
          sig: s.signature,
        });
      }
    }
  } catch {
    /* RPC hiccup — return whatever we gathered */
  }

  return out.sort((a, b) => b.ts - a.ts); // newest-first
}
