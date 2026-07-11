// ============================================================================
// crank/triggerCrank.ts — Phase 4 Pass 2: the trigger keeper loop (off-chain)
// ============================================================================
//
// A SCHEDULER, not an authority. The on-chain execute_trigger (P1) re-reads a
// fresh Pyth EMA and re-checks the stored condition itself — the keeper only
// watches prices, decides which triggers are worth sending, and (in production)
// sends the atomic post_update_atomic + execute_trigger tx. Every fire goes
// through the on-chain re-check; the keeper's decision is never final.
//
// Mirrors volOracleCrank.ts structure (loop shell + discovery + shutdown +
// TICK_ONCE) but with a SHORT FIXED cadence (stops can't fire 5 min late), NOT
// the hour-boundary alignment the vol loop uses.
//
// IDL: the keeper reads a CRANK-LOCAL IDL (crank/idl/opta.json, synced from
// target/idl) — NOT app/src/idl, which lags behind the deployed program (it
// rides the FE arc and at P2 still lacks execute_trigger/TriggerOrder).
// Discovery uses this fresh IDL's coder (the app-side safeFetchAll hardcodes a
// stale DISCRIMINATORS map and has no "triggerOrder").
//
// Refinements baked in:
//   - BATCHED Hermes read: ONE /v2/updates/price/latest?ids[]=…&ids[]=… per
//     tick for ALL unique feeds (not one-per-trigger → 429s).
//   - AIMD backoff on Hermes 429/5xx via the shared crank/hermesBackoff helper.
//   - FIRE MARGIN: the keeper reads SPOT but the chain re-checks the EMA; only
//     fire when spot is past the threshold by TRIGGER_FIRE_MARGIN_BPS so
//     spot-vs-EMA divergence doesn't churn 6059 reverts.
//   - BUY budget pre-check: simulate get_option_price (+ vault spread) and skip
//     (trigger STAYS LIVE) if the would-be premium exceeds the escrowed ceiling
//     — never send a doomed SlippageExceeded tx (fee-burn).
//   - SELL OTM pre-skip: skip an obviously-OTM sell (spot vs strike) rather than
//     send a doomed OptionNotInTheMoney tx.
//
// DRY RUN (default ON via OPTA_TRIGGER_DRY_RUN): logs exactly what it WOULD send
// per eligible order and does NOT call the sender. P3 flips it off for the first
// real send against a seeded trigger.
// ============================================================================

import * as anchor from "@coral-xyz/anchor";
import {
  Connection, PublicKey, ComputeBudgetProgram, SystemProgram, TransactionInstruction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

import { hexFromBytes } from "@app/utils/format";
import { fetchOptionPriceQuote } from "@app/utils/optionPriceQuote";
import { fetchHermesUpdate, submitWithFallback, type SignerWallet } from "@app/utils/pythPullPost";
import {
  PROTOCOL_SEED, TREASURY_SEED, VOL_ORACLE_SEED, VAULT_MINT_RECORD_SEED, VAULT_USDC_SEED,
} from "@app/utils/constants";
import {
  mkBackoff, backoffOn429, backoffOnOk, classifyHermesError, type BackoffState,
  DEFAULT_BACKOFF_BASE_MS, DEFAULT_BACKOFF_CEILING_MS,
} from "./hermesBackoff";

// ---- Trigger PDA seeds (constants.ts is FE-stale — define crank-local; these
//      MUST match programs/opta/src/state/trigger_order.rs) -------------------
const TRIGGER_ORDER_SEED = "trigger_order";
const TRIGGER_ESCROW_SEED = "trigger_escrow";

// ---- Tunables --------------------------------------------------------------
export const DEFAULT_TRIGGER_TICK_MS = 15_000; // 15s — stops can't fire 5 min late
export const DEFAULT_FIRE_MARGIN_BPS = 50; // 0.50% — headroom over measured SOL spot↔EMA gap (calm p90 ~16bps, move-peak ~33bps; P3.4 characterization)
export const DEFAULT_FEED_STALE_SECS = 120; // a Hermes price older than this = stale
export const EXECUTE_CU_LIMIT = 400_000; // BUY+BS-2002 path; the keeper IS the caller
const SHUTDOWN_CHECK_MS = 5000; // interruptible-sleep granularity

const CRANK_IDL_PATH = path.resolve(__dirname, "idl/opta.json");

// Account order in execute_trigger's context (for readable dry-run logs).
const EXECUTE_ACCOUNT_ROLES = [
  "caller", "trigger_order", "market", "shared_vault", "vault_mint_record",
  "option_mint", "price_update", "vol_oracle", "protocol_state", "treasury",
  "trigger_escrow", "holder_option_ata", "owner_usdc_account", "owner_wallet",
  "vault_usdc_account", "token_program", "token_2022_program", "system_program",
];

// ---- Types -----------------------------------------------------------------

export type TriggerCrankLogLevel = "info" | "warn" | "error" | "fatal";
export type TriggerCrankLogger = (
  level: TriggerCrankLogLevel, msg: string, fields?: Record<string, unknown>,
) => void;

export interface TriggerCrankContext {
  connection: Connection;
  wallet: SignerWallet;
  hermesBase: string;
  log: TriggerCrankLogger;
  shouldShutdown: () => boolean;
}

export interface TriggerCrankOptions {
  tickOnce?: boolean;
  dryRun?: boolean;
  tickMs?: number;
  fireMarginBps?: number;
  feedStaleSecs?: number;
}

export type TriggerKindStr = "buy" | "sell";
export type ComparatorStr = "le" | "ge";

/** Plain view of a TriggerOrder — pure-decidable, no anchor types. */
export interface TriggerView {
  pubkey: string;
  owner: string;
  market: string;
  vault: string;
  optionMint: string;
  holderOptionAta: string;
  kind: TriggerKindStr;
  comparator: ComparatorStr;
  thresholdUsdc: bigint; // 6-dec
  quantity: bigint;
  maxPremiumPerContract: bigint; // 6-dec (BUY); 0 for sells
}

export interface SpotEntry {
  priceFloat: number; // USD
  publishTime: number; // unix seconds
}

export interface VaultInfo {
  strikeUsdc: bigint; // 6-dec
  isCall: boolean;
  spreadBps: number;
  carryRateBps: number;
  expiry: number;
}

export type SkipReason =
  | "stale_feed" | "condition_not_met" | "within_margin"
  | "otm" | "over_budget" | "quote_unavailable";
export type Decision = { eligible: true } | { eligible: false; reason: SkipReason };

export interface EvalOpts {
  spot?: SpotEntry;
  nowSec: number;
  maxStaleSecs: number;
  fireMarginBps: number;
  pegPremiumTotalUsdc?: bigint; // BUY: spread-applied total (6-dec)
  strikeUsdc?: bigint; // SELL OTM pre-skip
  isCall?: boolean; // SELL OTM pre-skip
}

export interface TickReport {
  triggersFound: number;
  fired: number;
  skippedStaleFeed: number;
  skippedConditionNotMet: number;
  skippedWithinMargin: number;
  skippedOtm: number;
  skippedOverBudget: number;
  skippedQuoteUnavailable: number;
  /** Stage 3: triggers whose parent market is Switchboard-sourced
   *  (oracle_source==1) — out of keeper scope until an SB execute arm exists.
   *  Counted, not fired: a wrong-spot fill would be worse than a no-op. */
  skippedSbMarket: number;
  orderErrors: number;
  durationMs: number;
}

// ============================================================================
// PURE decision logic (unit-tested without RPC)
// ============================================================================

/** Float USD spot → USDC 6-dec integer (matches threshold_usdc units). */
export function spotToUsdc6(priceFloat: number): bigint {
  return BigInt(Math.round(priceFloat * 1_000_000));
}

/** Apply a vault spread to a per-contract premium, floored — mirrors
 *  fill_vault_peg::apply_spread (base × (10_000 + spread_bps) / 10_000). */
export function applySpreadFloor(perContractUsdc: bigint, spreadBps: number): bigint {
  return (perContractUsdc * (10_000n + BigInt(spreadBps))) / 10_000n;
}

/**
 * Decide whether the keeper should SEND an execute_trigger for this order THIS
 * tick. Pure — the impure reads (batched Hermes spot, get_option_price sim) are
 * done by the tick and passed in. The on-chain core remains the authority; this
 * only governs WHEN the keeper bothers to send (and avoids fee-burn reverts).
 */
export function evaluateTrigger(order: TriggerView, o: EvalOpts): Decision {
  // 1. Missing / stale feed — never fire on no price.
  if (!o.spot) return { eligible: false, reason: "stale_feed" };
  if (o.nowSec - o.spot.publishTime > o.maxStaleSecs) return { eligible: false, reason: "stale_feed" };

  const spotUsdc = spotToUsdc6(o.spot.priceFloat);

  // 2. Condition + fire-margin buffer (spot↔EMA divergence guard).
  const margin = (order.thresholdUsdc * BigInt(o.fireMarginBps)) / 10_000n;
  if (order.comparator === "ge") {
    if (spotUsdc < order.thresholdUsdc) return { eligible: false, reason: "condition_not_met" };
    if (spotUsdc < order.thresholdUsdc + margin) return { eligible: false, reason: "within_margin" };
  } else {
    if (spotUsdc > order.thresholdUsdc) return { eligible: false, reason: "condition_not_met" };
    if (spotUsdc > order.thresholdUsdc - margin) return { eligible: false, reason: "within_margin" };
  }

  // 3. SELL OTM pre-skip (avoid a doomed OptionNotInTheMoney tx). Only when the
  //    vault's strike + side are known; otherwise leave it to the on-chain core.
  if (order.kind === "sell" && o.strikeUsdc !== undefined && o.isCall !== undefined) {
    const itm = o.isCall ? spotUsdc > o.strikeUsdc : spotUsdc < o.strikeUsdc;
    if (!itm) return { eligible: false, reason: "otm" };
  }

  // 4. BUY budget pre-check (avoid a doomed SlippageExceeded tx; trigger STAYS
  //    LIVE — just doesn't fire this tick, fires when the peg gets cheaper).
  if (order.kind === "buy") {
    if (o.pegPremiumTotalUsdc === undefined) return { eligible: false, reason: "quote_unavailable" };
    const budget = order.maxPremiumPerContract * order.quantity;
    if (o.pegPremiumTotalUsdc > budget) return { eligible: false, reason: "over_budget" };
  }

  return { eligible: true };
}

// ---- Discovery / batched-read helpers (exported for unit tests) ------------

const normHex = (h: string) => h.replace(/^0x/, "").toLowerCase();

/**
 * Stage 3 guard (exported for unit tests): build the per-market lookup maps for
 * a tick, EXCLUDING Switchboard-sourced markets (oracle_source==1) from the
 * Hermes feed set so their feedHash never enters the batched price request.
 * Returns `sbMarkets` (their pubkeys) so the tick loop can skip their orders.
 * execute_trigger HAS an SB arm, but this keeper builds a Pyth/Hermes read + a
 * Pyth-only execute ctx — firing on an SB market would 404 the feed and assemble
 * a wrong-spot / reverting tx. A skipped trigger is honest; a wrong fill is not.
 */
export function buildTriggerMarketMaps(
  markets: { publicKey: PublicKey; account: any }[],
): {
  marketRec: Map<string, { publicKey: PublicKey; account: any }>;
  marketFeed: Map<string, string>;
  sbMarkets: Set<string>;
} {
  const marketRec = new Map<string, { publicKey: PublicKey; account: any }>();
  const marketFeed = new Map<string, string>();
  const sbMarkets = new Set<string>();
  for (const m of markets) {
    const pk = m.publicKey.toBase58();
    marketRec.set(pk, m);
    if ((m.account.oracleSource as number) === 1) { sbMarkets.add(pk); continue; }
    marketFeed.set(pk, normHex(hexFromBytes(m.account.pythFeedId as number[])));
  }
  return { marketRec, marketFeed, sbMarkets };
}

/** Unique feed-hex set across live orders (the dedupeFeedIds idea, hex-keyed). */
export function uniqueFeedHexes(
  orders: { market: string }[], marketFeed: Map<string, string>,
): string[] {
  const set = new Set<string>();
  for (const o of orders) {
    const f = marketFeed.get(o.market);
    if (f) set.add(normHex(f));
  }
  return [...set];
}

/** The batched Hermes latest-price URL: one request, N ids[]. */
export function buildHermesMultiUrl(base: string, feedHexes: string[]): string {
  const qs = feedHexes.map((h) => `ids[]=0x${normHex(h)}`).join("&");
  return `${base}/v2/updates/price/latest?${qs}&encoding=base64`;
}

// ============================================================================
// IMPURE deps (real impls; the dry-run harness + tests inject mocks)
// ============================================================================

export interface TickDeps {
  fetchTriggerOrders: () => Promise<{ publicKey: PublicKey; account: any }[]>;
  fetchMarkets: () => Promise<{ publicKey: PublicKey; account: any }[]>;
  fetchVaults: () => Promise<{ publicKey: PublicKey; account: any }[]>;
  readPrices: (feedHexes: string[]) => Promise<Map<string, SpotEntry>>;
  quotePegTotalUsdc: (
    marketRec: { publicKey: PublicKey; account: any }, vi: VaultInfo, quantity: bigint,
  ) => Promise<bigint>;
  /** Production sender. NEVER called when dryRun — kept injectable so tests can
   *  assert it stays untouched in dry-run. */
  send: (view: TriggerView, feedHex: string) => Promise<string>;
  nowSec: () => number;
}

export interface TickConfig {
  dryRun: boolean;
  fireMarginBps: number;
  feedStaleSecs: number;
  usdcMint: PublicKey;
  programId: PublicKey;
  callerPubkey: PublicKey;
}

const FETCHABLE = { triggerOrder: "triggerOrder", optionsMarket: "optionsMarket", sharedVault: "sharedVault" } as const;

/** Crank-local getProgramAccounts + fresh-IDL coder decode (orphan-tolerant).
 *  `extraFilters` are ANDed with the discriminator memcmp — e.g. a memcmp on a
 *  field offset to scope the scan (WriterPosition.vault @ offset 40). */
export async function fetchAllDecoded(
  program: anchor.Program<any>, name: string,
  extraFilters: { memcmp: { offset: number; bytes: string } }[] = [],
): Promise<{ publicKey: PublicKey; account: any }[]> {
  const { bytes } = program.coder.accounts.memcmp(name);
  const raw = await program.provider.connection.getProgramAccounts(program.programId, {
    filters: [{ memcmp: { offset: 0, bytes: bytes as string } }, ...extraFilters],
  });
  const out: { publicKey: PublicKey; account: any }[] = [];
  for (const r of raw) {
    try {
      out.push({ publicKey: r.pubkey, account: program.coder.accounts.decode(name, r.account.data) });
    } catch {
      /* stale-schema orphan — skip */
    }
  }
  return out;
}

export function toView(d: { publicKey: PublicKey; account: any }): TriggerView {
  const a = d.account;
  return {
    pubkey: d.publicKey.toBase58(),
    owner: (a.owner as PublicKey).toBase58(),
    market: (a.market as PublicKey).toBase58(),
    vault: (a.vault as PublicKey).toBase58(),
    optionMint: (a.optionMint as PublicKey).toBase58(),
    holderOptionAta: (a.holderOptionAta as PublicKey).toBase58(),
    kind: "stopEntryBuy" in a.kind ? "buy" : "sell",
    comparator: "lessOrEqual" in a.comparator ? "le" : "ge",
    thresholdUsdc: BigInt(a.thresholdUsdc.toString()),
    quantity: BigInt(a.quantity.toString()),
    maxPremiumPerContract: BigInt(a.maxPremium.toString()),
  };
}

export function toVaultInfo(d: { publicKey: PublicKey; account: any }): VaultInfo {
  const a = d.account;
  return {
    strikeUsdc: BigInt(a.strikePrice.toString()),
    isCall: "call" in a.optionType,
    spreadBps: Number(a.spreadBps ?? 0),
    carryRateBps: Number(a.carryRateBps ?? 0),
    expiry: Number(a.expiry.toString()),
  };
}

/** Assemble the 18-account execute_trigger context. `priceUpdate` is the
 *  ephemeral PriceUpdateV2 (real PDA in production; a placeholder for dry-run
 *  logging — it's posted in-tx). */
export function assembleExecuteAccounts(
  view: TriggerView, feedIdBytes: Buffer, usdcMint: PublicKey,
  caller: PublicKey, priceUpdate: PublicKey, programId: PublicKey,
): Record<string, PublicKey> {
  const triggerOrder = new PublicKey(view.pubkey);
  const optionMint = new PublicKey(view.optionMint);
  const vault = new PublicKey(view.vault);
  const owner = new PublicKey(view.owner);
  const seed = (s: string, extra: Buffer[] = []) =>
    PublicKey.findProgramAddressSync([Buffer.from(s), ...extra], programId)[0];
  return {
    caller,
    triggerOrder,
    market: new PublicKey(view.market),
    sharedVault: vault,
    vaultMintRecord: seed(VAULT_MINT_RECORD_SEED, [optionMint.toBuffer()]),
    optionMint,
    priceUpdate,
    volOracle: seed(VOL_ORACLE_SEED, [feedIdBytes]),
    protocolState: seed(PROTOCOL_SEED),
    treasury: seed(TREASURY_SEED),
    triggerEscrow: seed(TRIGGER_ESCROW_SEED, [triggerOrder.toBuffer()]),
    holderOptionAta: new PublicKey(view.holderOptionAta),
    ownerUsdcAccount: getAssociatedTokenAddressSync(usdcMint, owner, false, TOKEN_PROGRAM_ID),
    ownerWallet: owner,
    vaultUsdcAccount: seed(VAULT_USDC_SEED, [vault.toBuffer()]),
    tokenProgram: TOKEN_PROGRAM_ID,
    token2022Program: TOKEN_2022_PROGRAM_ID,
    systemProgram: SystemProgram.programId,
  };
}

/** Build the execute_trigger instruction (offline — no RPC). */
export async function buildExecuteTriggerIx(
  program: anchor.Program<any>, accounts: Record<string, PublicKey>,
): Promise<TransactionInstruction> {
  return program.methods.executeTrigger().accountsStrict(accounts).instruction();
}

// ============================================================================
// Sleep / program-load
// ============================================================================

async function sleepInterruptibly(totalMs: number, shouldStop: () => boolean): Promise<void> {
  let remaining = totalMs;
  while (remaining > 0 && !shouldStop()) {
    const chunk = Math.min(remaining, SHUTDOWN_CHECK_MS);
    await new Promise<void>((resolve) => setTimeout(resolve, chunk));
    remaining -= chunk;
  }
}

/** Build an anchor Program from the CRANK-LOCAL fresh IDL (has execute_trigger
 *  + triggerOrder). Loosely typed (Program<any>) — runtime IDL drives methods. */
export function loadTriggerProgram(connection: Connection, wallet: SignerWallet): anchor.Program<any> {
  const idl = JSON.parse(fs.readFileSync(CRANK_IDL_PATH, "utf-8"));
  const provider = new anchor.AnchorProvider(connection, wallet as any, { commitment: "confirmed" });
  return new anchor.Program(idl as anchor.Idl, provider) as anchor.Program<any>;
}

// ============================================================================
// Fire (dry-run plan vs production send)
// ============================================================================

async function fireTrigger(
  ctx: TriggerCrankContext, program: anchor.Program<any>, view: TriggerView,
  feedHex: string, cfg: TickConfig, extra: Record<string, unknown>, deps: TickDeps,
): Promise<void> {
  if (cfg.dryRun) {
    const feedIdBytes = Buffer.from(normHex(feedHex), "hex");
    const accounts = assembleExecuteAccounts(
      view, feedIdBytes, cfg.usdcMint, cfg.callerPubkey, PublicKey.default, cfg.programId,
    );
    const ix = await buildExecuteTriggerIx(program, accounts);
    ctx.log("info", "DRY-RUN would send execute_trigger", {
      event: "would-send",
      trigger: view.pubkey,
      kind: view.kind,
      owner: view.owner,
      computeUnitLimit: EXECUTE_CU_LIMIT,
      txPlan: [
        `ComputeBudget.setComputeUnitLimit(${EXECUTE_CU_LIMIT})`,
        "pyth post_update_atomic(fresh VAA)",
        "execute_trigger",
      ],
      accounts: ix.keys.map((k, i) => ({
        i, role: EXECUTE_ACCOUNT_ROLES[i] ?? "?", pubkey: k.pubkey.toBase58(),
        signer: k.isSigner, writable: k.isWritable,
      })),
      ...extra,
      note: "DRY RUN — NOT sent; price_update shown as placeholder (ephemeral, posted in-tx); on-chain execute_trigger re-checks EMA + condition",
    });
    return;
  }
  const sig = await deps.send(view, feedHex);
  ctx.log("info", "execute_trigger sent", { event: "fired", trigger: view.pubkey, kind: view.kind, sig });
}

// ============================================================================
// One tick (injectable deps)
// ============================================================================

export async function tickOnce(
  ctx: TriggerCrankContext, program: anchor.Program<any>, cfg: TickConfig,
  state: { backoff: BackoffState }, deps: TickDeps,
): Promise<TickReport> {
  const startMs = Date.now();
  const report: TickReport = {
    triggersFound: 0, fired: 0, skippedStaleFeed: 0, skippedConditionNotMet: 0,
    skippedWithinMargin: 0, skippedOtm: 0, skippedOverBudget: 0,
    skippedQuoteUnavailable: 0, skippedSbMarket: 0, orderErrors: 0, durationMs: 0,
  };

  const orders = await deps.fetchTriggerOrders();
  report.triggersFound = orders.length;
  if (orders.length === 0) {
    report.durationMs = Date.now() - startMs;
    ctx.log("info", "trigger tick: no live triggers", { ...report });
    return report;
  }

  const [markets, vaults] = await Promise.all([deps.fetchMarkets(), deps.fetchVaults()]);
  // Stage 3 guard: exclude Switchboard-sourced markets from the Hermes feed set
  // and collect their pubkeys so the loop skips their orders (see helper).
  const { marketRec, marketFeed, sbMarkets } = buildTriggerMarketMaps(markets);
  const vaultInfo = new Map<string, VaultInfo>();
  for (const v of vaults) vaultInfo.set(v.publicKey.toBase58(), toVaultInfo(v));

  const views = orders.map(toView);
  const feedHexes = uniqueFeedHexes(views, marketFeed);

  // ---- BATCHED Hermes read (one request) with AIMD backoff ----------------
  await sleepInterruptibly(state.backoff.currentMs, ctx.shouldShutdown); // pace
  if (ctx.shouldShutdown()) { report.durationMs = Date.now() - startMs; return report; }
  let prices: Map<string, SpotEntry>;
  try {
    prices = await deps.readPrices(feedHexes);
    backoffOnOk(state.backoff, DEFAULT_BACKOFF_BASE_MS);
  } catch (err) {
    const cls = classifyHermesError(err);
    if (cls === "rate-limit") backoffOn429(state.backoff, DEFAULT_BACKOFF_CEILING_MS);
    ctx.log(cls === "rate-limit" ? "warn" : "error", "trigger tick: batched price read failed", {
      class: cls, feeds: feedHexes.length, err: String(err),
      hermesBackoffMs: state.backoff.currentMs,
    });
    report.durationMs = Date.now() - startMs;
    return report; // skip the whole tick; retry next interval
  }

  const nowSec = deps.nowSec();

  for (let idx = 0; idx < views.length; idx++) {
    if (ctx.shouldShutdown()) break;
    const view = views[idx];
    // Stage 3: skip triggers whose parent market is Switchboard-sourced (see the
    // marketFeed build above). Counted so the skipped volume stays visible.
    if (sbMarkets.has(view.market)) { report.skippedSbMarket++; continue; }
    try {
      const feedHex = marketFeed.get(view.market);
      const spot = feedHex ? prices.get(feedHex) : undefined;
      const vi = vaultInfo.get(view.vault);

      // First pass WITHOUT a quote (cheap): resolves stale/condition/margin/OTM.
      // A BUY that clears those returns quote_unavailable → we then simulate the
      // peg premium and re-evaluate. This avoids a get_option_price sim on every
      // condition-not-met BUY.
      let decision = evaluateTrigger(view, {
        spot, nowSec, maxStaleSecs: cfg.feedStaleSecs, fireMarginBps: cfg.fireMarginBps,
        pegPremiumTotalUsdc: undefined, strikeUsdc: vi?.strikeUsdc, isCall: vi?.isCall,
      });
      let extra: Record<string, unknown> = {};
      if (!decision.eligible && decision.reason === "quote_unavailable" && view.kind === "buy" && vi) {
        const mrec = marketRec.get(view.market);
        if (mrec) {
          const pegTotal = await deps.quotePegTotalUsdc(mrec, vi, view.quantity);
          const budget = view.maxPremiumPerContract * view.quantity;
          extra = { premiumTotalUsdc: pegTotal.toString(), budgetUsdc: budget.toString() };
          decision = evaluateTrigger(view, {
            spot, nowSec, maxStaleSecs: cfg.feedStaleSecs, fireMarginBps: cfg.fireMarginBps,
            pegPremiumTotalUsdc: pegTotal, strikeUsdc: vi.strikeUsdc, isCall: vi.isCall,
          });
        }
      }
      if (view.kind === "sell") extra = { intrinsic: "enforced on-chain (OptionNotInTheMoney if OTM)" };

      if (decision.eligible) {
        await fireTrigger(ctx, program, view, feedHex!, cfg, extra, deps);
        report.fired++;
      } else {
        switch (decision.reason) {
          case "stale_feed": report.skippedStaleFeed++; break;
          case "condition_not_met": report.skippedConditionNotMet++; break;
          case "within_margin": report.skippedWithinMargin++; break;
          case "otm": report.skippedOtm++; break;
          case "over_budget": report.skippedOverBudget++; break;
          case "quote_unavailable": report.skippedQuoteUnavailable++; break;
        }
        ctx.log("info", "trigger skipped", {
          event: "skip", trigger: view.pubkey, kind: view.kind, reason: decision.reason, ...extra,
        });
      }
    } catch (err) {
      report.orderErrors++;
      ctx.log("error", "trigger order errored (skipped, tick continues)", {
        trigger: view.pubkey, err: String(err),
      });
    }
  }

  if (report.skippedSbMarket > 0) {
    ctx.log("info", "trigger tick: skipped Switchboard-sourced markets (out of keeper scope)", {
      skippedSbMarket: report.skippedSbMarket,
    });
  }
  report.durationMs = Date.now() - startMs;
  ctx.log("info", "trigger tick complete", { ...report });
  return report;
}

// ============================================================================
// Real deps (wired from the live program + Hermes)
// ============================================================================

/** Batched Hermes latest-price read → map(feedHex → {priceFloat, publishTime}). */
export async function readPricesBatched(
  feedHexes: string[], hermesBase: string,
): Promise<Map<string, SpotEntry>> {
  const out = new Map<string, SpotEntry>();
  if (feedHexes.length === 0) return out;
  const url = buildHermesMultiUrl(hermesBase, feedHexes);
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Hermes price HTTP ${resp.status}`);
  const json: any = await resp.json();
  for (const p of json?.parsed ?? []) {
    const id = normHex(String(p.id ?? ""));
    const px = p.price;
    if (!px || typeof px.price !== "string" || typeof px.expo !== "number") continue;
    const value = parseFloat(px.price) * Math.pow(10, px.expo);
    if (!Number.isFinite(value)) continue;
    out.set(id, { priceFloat: value, publishTime: typeof px.publish_time === "number" ? px.publish_time : 0 });
  }
  return out;
}

function realDeps(
  ctx: TriggerCrankContext, program: anchor.Program<any>, cfg: TickConfig,
): TickDeps {
  return {
    fetchTriggerOrders: () => fetchAllDecoded(program, FETCHABLE.triggerOrder),
    fetchMarkets: () => fetchAllDecoded(program, FETCHABLE.optionsMarket),
    fetchVaults: () => fetchAllDecoded(program, FETCHABLE.sharedVault),
    readPrices: (feeds) => readPricesBatched(feeds, ctx.hermesBase),
    quotePegTotalUsdc: async (mrec, vi, quantity) => {
      const q = await fetchOptionPriceQuote(program as any, mrec as any, {
        strike: Number(vi.strikeUsdc) / 1_000_000,
        expiryTs: vi.expiry,
        side: vi.isCall ? "call" : "put",
        exerciseStyle: "american",
        carryRateBps: vi.carryRateBps,
      });
      const perContract6 = BigInt(Math.round(q.premiumPerContract * 1_000_000));
      return applySpreadFloor(perContract6, vi.spreadBps) * quantity;
    },
    send: async (view, feedHex) => fireProduction(ctx, program, view, feedHex, cfg),
    nowSec: () => Math.floor(Date.now() / 1000),
  };
}

/** PRODUCTION send (P3): atomic post_update_atomic(fresh VAA) + CU + execute_trigger.
 *  Gated behind !dryRun — NOT exercised this pass. */
async function fireProduction(
  ctx: TriggerCrankContext, program: anchor.Program<any>, view: TriggerView,
  feedHex: string, cfg: TickConfig,
): Promise<string> {
  // Lazy import keeps the receiver SDK off the dry-run/test path.
  const { PythSolanaReceiver } = await import("@pythnetwork/pyth-solana-receiver");
  const vaa = await fetchHermesUpdate(feedHex, ctx.hermesBase);
  const receiver = new PythSolanaReceiver({ connection: ctx.connection, wallet: ctx.wallet as any });
  const builder = receiver.newTransactionBuilder({ closeUpdateAccounts: true });
  await builder.addPostPriceUpdates([vaa.toString("base64")]);
  await builder.addPriceConsumerInstructions(async (getPriceUpdateAccount: (k: string) => PublicKey | undefined) => {
    const priceUpdatePda = getPriceUpdateAccount(`0x${normHex(feedHex)}`);
    if (!priceUpdatePda) throw new Error(`no PriceUpdate PDA for feed ${feedHex}`);
    const accounts = assembleExecuteAccounts(
      view, Buffer.from(normHex(feedHex), "hex"), cfg.usdcMint, ctx.wallet.publicKey, priceUpdatePda, cfg.programId,
    );
    const ix = await buildExecuteTriggerIx(program, accounts);
    return [
      { instruction: ComputeBudgetProgram.setComputeUnitLimit({ units: EXECUTE_CU_LIMIT }), signers: [] },
      { instruction: ix, signers: [] },
    ];
  });
  const txs = await builder.buildVersionedTransactions({ computeUnitPriceMicroLamports: 0 });
  return submitWithFallback(ctx.connection, ctx.wallet, txs as any);
}

// ============================================================================
// Loop
// ============================================================================

function readOptions(options: TriggerCrankOptions): {
  tickMs: number; fireMarginBps: number; feedStaleSecs: number; dryRun: boolean; tickOnce: boolean;
} {
  const env = (k: string) => process.env[k];
  const intOr = (v: string | undefined, d: number) => {
    const n = v ? parseInt(v, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  const dryRunRaw = (env("OPTA_TRIGGER_DRY_RUN") ?? "1").toLowerCase();
  return {
    tickMs: options.tickMs ?? intOr(env("OPTA_TRIGGER_TICK_MS"), DEFAULT_TRIGGER_TICK_MS),
    fireMarginBps: options.fireMarginBps ?? intOr(env("OPTA_TRIGGER_FIRE_MARGIN_BPS"), DEFAULT_FIRE_MARGIN_BPS),
    feedStaleSecs: options.feedStaleSecs ?? intOr(env("OPTA_TRIGGER_FEED_STALE_SECS"), DEFAULT_FEED_STALE_SECS),
    // Dry-run is ON unless explicitly "0"/"false" (never accidentally sends).
    dryRun: options.dryRun ?? !(dryRunRaw === "0" || dryRunRaw === "false"),
    tickOnce: !!options.tickOnce,
  };
}

export async function runTriggerCrank(
  ctx: TriggerCrankContext, options: TriggerCrankOptions = {},
): Promise<void> {
  const opt = readOptions(options);
  const program = loadTriggerProgram(ctx.connection, ctx.wallet);

  // Protocol state → canonical USDC mint (for owner USDC ATA derivation).
  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from(PROTOCOL_SEED)], program.programId,
  );
  const protocolState: any = await (program.account as any).protocolState.fetch(protocolStatePda);
  const cfg: TickConfig = {
    dryRun: opt.dryRun,
    fireMarginBps: opt.fireMarginBps,
    feedStaleSecs: opt.feedStaleSecs,
    usdcMint: protocolState.usdcMint as PublicKey,
    programId: program.programId,
    callerPubkey: ctx.wallet.publicKey,
  };
  const deps = realDeps(ctx, program, cfg);
  const state = { backoff: mkBackoff() };

  ctx.log("info", "trigger crank started", {
    hermesBase: ctx.hermesBase, tickMs: opt.tickMs, fireMarginBps: opt.fireMarginBps,
    feedStaleSecs: opt.feedStaleSecs, dryRun: opt.dryRun, tickOnce: opt.tickOnce,
    usdcMint: cfg.usdcMint.toBase58(),
  });

  if (opt.tickOnce) {
    try {
      const r = await tickOnce(ctx, program, cfg, state, deps);
      ctx.log("info", "trigger crank exiting (TICK_ONCE)", { ...r });
    } catch (err) {
      ctx.log("error", "trigger TICK_ONCE crashed", { err: String(err) });
      throw err; // non-zero exit
    }
    return;
  }

  // Continuous: tick on boot, then every fixed interval.
  await runTickWithGuard(ctx, program, cfg, state, deps);
  while (!ctx.shouldShutdown()) {
    await sleepInterruptibly(opt.tickMs, ctx.shouldShutdown);
    if (ctx.shouldShutdown()) break;
    await runTickWithGuard(ctx, program, cfg, state, deps);
  }
  ctx.log("info", "trigger crank stopped cleanly");
}

async function runTickWithGuard(
  ctx: TriggerCrankContext, program: anchor.Program<any>, cfg: TickConfig,
  state: { backoff: BackoffState }, deps: TickDeps,
): Promise<void> {
  try {
    await tickOnce(ctx, program, cfg, state, deps);
  } catch (err) {
    ctx.log("error", "trigger tick crashed (will retry next interval)", {
      err: String(err), stack: (err as any)?.stack,
    });
  }
}
