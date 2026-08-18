// ============================================================================
// crank/settleVaultFanout.ts — push the SECOND settle leg, for every arm
// ============================================================================
//
// WHAT WAS MISSING (measured 2026-08-14).
//
// Settlement is two legs. `settle_expiry` records the price for an
// (asset, expiry) tuple and needs a fresh oracle quote inside a 300 s window.
// `settle_vault` then sweeps the writer-ask pot into the vault, computes
// collateral_remaining, and makes holders claimable — it reads NO oracle and is
// explicitly permissionless (settle_vault.rs:235).
//
// Leg 1 runs for every arm. Leg 2 was only ever called from bot.ts's Pyth loop,
// which skips Switchboard markets outright (`oracleSource === 1 → continue`).
// The SB pass calls settle_expiry and nothing else. So on the 14-AUG expiry:
//
//     Switchboard  330 vaults  ->   0 settled
//     Pyth           2 vaults  ->   2 settled
//     backlog     3039 vaults  ->  3039 Switchboard, 0 Pyth
//
// A perfect correlation. Until now the fan-out was left to the Utilities panel —
// a PULL model, which means holders are paid only when somebody opens a page.
// That is why the backlog reached back to July. This module makes the push the
// default; the pull stays as a fallback and is untouched.
//
// ── NO ORACLE-SOURCE FILTER. EVER. ─────────────────────────────────────────
// app/src/pages/portfolio/settleTuples.ts carries an explicit warning: an
// earlier `oracleSource === 0` filter "hid every one of those 45. Do not
// reintroduce an oracle-source filter here." The same rule binds this module.
// Eligibility is decided by ONE question — does a SettlementRecord exist for
// this vault's tuple — because that is exactly what the on-chain instruction
// requires. Which oracle produced the record is none of leg 2's business.
//
// ── THE RACE, WHICH IS REAL AND WAS OBSERVED ───────────────────────────────
// While this was being written the founder was draining the backlog by hand
// through Utilities: 75 `settle_vault` instructions from their wallet inside a
// few minutes. So a vault can be settled by somebody else between our scan and
// our transaction, and `settle_vault` REVERTS with VaultAlreadySettled rather
// than no-opping.
//
// That matters more than it looks, because instructions are batched: five vaults
// per transaction, and a transaction is atomic. One already-settled vault takes
// the other four down with it. Pre-filtering narrows the window but cannot close
// it. So a failed batch is retried ONE VAULT PER TRANSACTION, which isolates the
// offender and lets its innocent neighbours land. Already-settled is then
// counted as `skipped`, never `failed` — it means somebody else did our job.
// ============================================================================

import { PublicKey } from "@solana/web3.js";

/**
 * Vaults per transaction.
 *
 * MEASURED, NOT INHERITED. The shared settle helper uses 5, and that is safe
 * THERE because it settles one tuple at a time: those vaults share a market, a
 * settlement record and a protocol state, so the account list barely grows.
 * This fan-out orders OLDEST-FIRST across the whole board, so a naive batch
 * mixes assets and each vault drags its own market + record + mint + two pot
 * accounts. Simulated 2026-08-14: a mixed batch of 5 serialised to 1241 bytes,
 * over the 1232 limit, and the RPC rejected it outright.
 *
 * Two changes fix it together: targets are grouped so same-tuple vaults sit
 * adjacent (restoring the account sharing), and the size is 4 with headroom.
 */
export const FANOUT_CHUNK_SIZE = 4;

/** Ceiling per tick so one pass cannot monopolise the crank. At 5/tx this is
 *  ~30 transactions per tick; the backlog drains over successive ticks rather
 *  than in one long blocking run. */
export const FANOUT_MAX_PER_TICK = 150;

export interface FanoutVault {
  publicKey: PublicKey;
  account: {
    market: PublicKey;
    expiry: { toNumber(): number } | number;
    isSettled: boolean;
    voided?: boolean;
  };
}

export interface FanoutMarket {
  publicKey: PublicKey;
  account: { assetName: string | Uint8Array | number[] };
}

export interface FanoutRecord {
  account: { assetName: string | Uint8Array | number[]; expiry: { toNumber(): number } | number };
}

export type SkipReason =
  | "not-expired"
  | "already-settled"
  | "voided"
  | "no-settlement-record"
  | "unknown-market";

export interface FanoutPlan {
  /** Vaults to settle, OLDEST EXPIRY FIRST. */
  targets: FanoutVault[];
  /** Why everything else was left alone — counted, so a heartbeat can show it. */
  skipped: Record<SkipReason, number>;
  /** Targets before the per-tick ceiling was applied. */
  eligibleTotal: number;
}

const num = (v: { toNumber(): number } | number): number =>
  typeof v === "number" ? v : v.toNumber();

/** Asset names are fixed-width on chain; trim NULs and padding so a record key
 *  and a market key compare equal. */
export function cleanAssetName(v: string | Uint8Array | number[]): string {
  const s = typeof v === "string" ? v : Buffer.from(v as any).toString();
  return s.replace(/\0+$/, "").replace(/\s+$/, "");
}

/**
 * Decide what leg 2 should do right now. PURE — no RPC, no clock unless passed —
 * so every eligibility rule is testable against fixtures.
 *
 * Ordering is OLDEST EXPIRY FIRST, deliberately. The oldest vaults are the ones
 * whose holders have been waiting longest and whose funds have been unreachable
 * longest; a current-first order would keep the tail permanently starved, which
 * is how the July backlog formed in the first place.
 */
export function planSettleFanout(args: {
  vaults: readonly FanoutVault[];
  markets: readonly FanoutMarket[];
  records: readonly FanoutRecord[];
  nowSecs: number;
  maxPerTick?: number;
}): FanoutPlan {
  const { vaults, markets, records, nowSecs } = args;
  const maxPerTick = args.maxPerTick ?? FANOUT_MAX_PER_TICK;

  const assetByMarket = new Map<string, string>();
  for (const m of markets) {
    assetByMarket.set(m.publicKey.toBase58(), cleanAssetName(m.account.assetName));
  }
  const haveRecord = new Set<string>();
  for (const r of records) {
    haveRecord.add(`${cleanAssetName(r.account.assetName)}|${num(r.account.expiry)}`);
  }

  const skipped: Record<SkipReason, number> = {
    "not-expired": 0,
    "already-settled": 0,
    voided: 0,
    "no-settlement-record": 0,
    "unknown-market": 0,
  };

  const eligible: FanoutVault[] = [];
  for (const v of vaults) {
    const expiry = num(v.account.expiry);
    if (expiry > nowSecs) { skipped["not-expired"]++; continue; }
    if (v.account.isSettled) { skipped["already-settled"]++; continue; }
    // A voided vault must never be settled — settle_vault.rs blocks it, and
    // attempting one would burn a transaction to learn what we already know.
    if (v.account.voided) { skipped.voided++; continue; }
    const asset = assetByMarket.get(v.account.market.toBase58());
    if (asset === undefined) { skipped["unknown-market"]++; continue; }
    // THE ONLY ELIGIBILITY QUESTION. Not the oracle source — see the header.
    if (!haveRecord.has(`${asset}|${expiry}`)) { skipped["no-settlement-record"]++; continue; }
    eligible.push(v);
  }

  // Oldest expiry first — the anti-starvation property. Ties broken by MARKET so
  // same-tuple vaults land in the same batch and share their market /
  // settlement-record / protocol-state accounts, which is what keeps a
  // transaction inside 1232 bytes (see FANOUT_CHUNK_SIZE).
  eligible.sort((a, b) => {
    const d = num(a.account.expiry) - num(b.account.expiry);
    if (d !== 0) return d;
    return a.account.market.toBase58().localeCompare(b.account.market.toBase58());
  });

  return { targets: eligible.slice(0, maxPerTick), skipped, eligibleTotal: eligible.length };
}

/** Split targets into transaction-sized batches. */
export function chunkTargets<T>(targets: readonly T[], size = FANOUT_CHUNK_SIZE): T[][] {
  if (size < 1) throw new Error("chunk size must be >= 1");
  const out: T[][] = [];
  for (let i = 0; i < targets.length; i += size) out.push(targets.slice(i, i + size));
  return out;
}

/**
 * Did this failure mean "somebody already settled it"?
 *
 * VaultAlreadySettled is Opta error 6019 (0x1783) — read from the IDL, not
 * assumed. It is a SKIP, not a failure: the work we wanted done is done.
 * Matched on the code AND on the Anchor variant name, so an SDK that decodes
 * the error before we see it is handled too.
 */
export const VAULT_ALREADY_SETTLED_CODE = 6019;

export function isAlreadySettled(err: unknown): boolean {
  const msg = String((err as any)?.message ?? err ?? "");
  if (/VaultAlreadySettled/i.test(msg)) return true;
  const hex = msg.match(/custom program error:\s*0x([0-9a-f]+)/i);
  if (hex && parseInt(hex[1], 16) === VAULT_ALREADY_SETTLED_CODE) return true;
  const dec = msg.match(/error number:\s*(\d+)/i);
  if (dec && parseInt(dec[1], 10) === VAULT_ALREADY_SETTLED_CODE) return true;
  return false;
}

// ============================================================================
// Execution
// ============================================================================

import * as anchor from "@coral-xyz/anchor";
import {
  Connection, TransactionMessage, VersionedTransaction, ComputeBudgetProgram,
  type TransactionInstruction, type Keypair,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { assertPotSlots, POT_SLOTS } from "./potSlotGuard";

const PROTOCOL_SEED = "protocol_v2";
const VAULT_OPTION_MINT_SEED = "vault_option_mint";
const WRITER_ASK_POT_SEED = "writer_ask_pot";
const WRITER_ASK_POT_USDC_SEED = "writer_ask_pot_usdc";
const SETTLEMENT_SEED = "settlement";

/**
 * CU budget per vault. MEASURED on devnet 2026-08-14: a 4-vault batch consumed
 * 68,761 CU total (~17.2K/vault) for vaults whose pot sweep is $0 — the common
 * case. A vault WITH a funded pot additionally does a token-transfer CPI, so
 * this carries ~4x headroom over the measured figure rather than sitting on it.
 * A 4-vault batch requests 320K, comfortably inside the 1.4M ceiling.
 */
const CU_PER_VAULT = 80_000;

export interface FanoutReport {
  attempted: number;
  settled: number;
  /** Someone else settled it between our scan and our transaction, or between
   *  building the batch and landing it. Success by another route — never a
   *  failure. */
  skippedAlreadySettled: number;
  failed: number;
  txsSent: number;
  /** Depth still outstanding after this pass, for the heartbeat. */
  remaining: number;
  errors: string[];
}

/** Build the settle_vault instruction for one vault. Account derivation mirrors
 *  the shared settle helper exactly — same seeds, same order. */
async function buildSettleVaultIx(
  program: anchor.Program<any>,
  authority: anchor.web3.PublicKey,
  v: FanoutVault & { account: any },
  assetName: string,
): Promise<TransactionInstruction> {
  const a = v.account;
  const otByte = "call" in a.optionType ? 0 : 1;
  const esByte = "european" in a.exerciseStyle ? 0 : 1;
  const [protocolState] = PublicKey.findProgramAddressSync(
    [Buffer.from(PROTOCOL_SEED)], program.programId);
  const [settlementRecord] = PublicKey.findProgramAddressSync(
    [Buffer.from(SETTLEMENT_SEED), Buffer.from(assetName),
     a.expiry.toArrayLike(Buffer, "le", 8)], program.programId);
  const [optionMint] = PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_OPTION_MINT_SEED), a.market.toBuffer(),
     a.strikePrice.toArrayLike(Buffer, "le", 8), a.expiry.toArrayLike(Buffer, "le", 8),
     Buffer.from([otByte]), Buffer.from([esByte])], program.programId);
  const [writerAskPot] = PublicKey.findProgramAddressSync(
    [Buffer.from(WRITER_ASK_POT_SEED), optionMint.toBuffer()], program.programId);
  const [writerAskPotUsdc] = PublicKey.findProgramAddressSync(
    [Buffer.from(WRITER_ASK_POT_USDC_SEED), optionMint.toBuffer()], program.programId);

  const ix = await program.methods
    .settleVault()
    .accountsStrict({
      authority,
      sharedVault: v.publicKey,
      market: a.market,
      settlementRecord,
      vaultUsdcAccount: a.vaultUsdcAccount,
      optionMint,
      writerAskPot,
      writerAskPotUsdc,
      protocolState,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .instruction();

  // This path was UNGUARDED until 2026-08-17. accountsStrict does not protect it:
  // measured that day, a stale IDL made this exact call emit 8 accounts instead of
  // 10, dropping both pot keys without a word. On chain it would be rejected
  // (require_keys_eq against the mint-derived PDA, and NotEnoughAccountKeys before
  // that), so the money was never at risk — but the failure arrived after the fee,
  // as an opaque revert in a batch of vaults, instead of here with a cause.
  assertPotSlots(
    ix,
    [
      { slot: POT_SLOTS.settle_vault.pot, expected: writerAskPot, name: "writer_ask_pot" },
      {
        slot: POT_SLOTS.settle_vault.potUsdc,
        expected: writerAskPotUsdc,
        name: "writer_ask_pot_usdc",
      },
    ],
    { instruction: "settle_vault", optionMint },
  );

  return ix;
}

async function sendBatch(
  conn: Connection, payer: Keypair, ixs: TransactionInstruction[],
): Promise<string> {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
  const tx = new VersionedTransaction(new TransactionMessage({
    payerKey: payer.publicKey,
    recentBlockhash: blockhash,
    instructions: [
      ComputeBudgetProgram.setComputeUnitLimit({ units: CU_PER_VAULT * ixs.length }),
      ...ixs,
    ],
  }).compileToV0Message());
  tx.sign([payer]);
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false, maxRetries: 3,
  });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
  return sig;
}

/**
 * Fan leg 2 out over a plan's targets.
 *
 * BATCH-THEN-ISOLATE. Five vaults ride one atomic transaction, so a single
 * already-settled vault would drop four innocent ones with it. On any batch
 * failure the batch is retried ONE VAULT PER TRANSACTION: the offender is
 * isolated and its neighbours still land. Costlier on the rare failing batch,
 * and it means a race with the Utilities panel — observed live, 75 manual
 * settles in minutes — costs one vault rather than five.
 */
export async function runSettleFanout(args: {
  program: anchor.Program<any>;
  connection: Connection;
  payer: Keypair;
  plan: FanoutPlan;
  assetByMarket: Map<string, string>;
  log: (level: "info" | "warn" | "error", msg: string, fields?: Record<string, unknown>) => void;
  shouldStop?: () => boolean;
}): Promise<FanoutReport> {
  const { program, connection, payer, plan, assetByMarket, log } = args;
  const rep: FanoutReport = {
    attempted: 0, settled: 0, skippedAlreadySettled: 0, failed: 0,
    txsSent: 0, remaining: plan.eligibleTotal, errors: [],
  };
  if (plan.targets.length === 0) return rep;

  for (const batch of chunkTargets(plan.targets)) {
    if (args.shouldStop?.()) break;
    const built: Array<{ v: FanoutVault; ix: TransactionInstruction }> = [];
    for (const v of batch) {
      const asset = assetByMarket.get(v.account.market.toBase58());
      if (!asset) continue;
      try {
        built.push({ v, ix: await buildSettleVaultIx(program, payer.publicKey, v as any, asset) });
      } catch (e) {
        rep.failed++;
        rep.errors.push(`build ${v.publicKey.toBase58()}: ${String((e as any)?.message ?? e).slice(0, 120)}`);
      }
    }
    if (built.length === 0) continue;
    rep.attempted += built.length;

    try {
      const sig = await sendBatch(connection, payer, built.map((b) => b.ix));
      rep.txsSent++;
      rep.settled += built.length;
      log("info", "settle_vault batch landed", { vaults: built.length, sig });
    } catch (batchErr) {
      // ISOLATE. One bad vault must not cost the other four.
      log("warn", "settle_vault batch failed — isolating", {
        vaults: built.length, err: String((batchErr as any)?.message ?? batchErr).slice(0, 160),
      });
      for (const b of built) {
        if (args.shouldStop?.()) break;
        try {
          const sig = await sendBatch(connection, payer, [b.ix]);
          rep.txsSent++;
          rep.settled++;
          log("info", "settle_vault landed (isolated)", { vault: b.v.publicKey.toBase58(), sig });
        } catch (e) {
          if (isAlreadySettled(e)) {
            rep.skippedAlreadySettled++;
            log("info", "settle_vault skipped — already settled by someone else", {
              vault: b.v.publicKey.toBase58(),
            });
          } else {
            rep.failed++;
            const m = String((e as any)?.message ?? e).slice(0, 160);
            rep.errors.push(`${b.v.publicKey.toBase58()}: ${m}`);
            log("warn", "settle_vault failed", { vault: b.v.publicKey.toBase58(), err: m });
          }
        }
      }
    }
  }
  rep.remaining = Math.max(0, plan.eligibleTotal - rep.settled - rep.skippedAlreadySettled);
  return rep;
}
