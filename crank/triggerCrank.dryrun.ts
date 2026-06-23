// ============================================================================
// crank/triggerCrank.dryrun.ts — offline TICK_ONCE + DRY_RUN harness (P2 gate 3)
// ============================================================================
// Runs the REAL tickOnce() against MOCKED discovery + a mocked batched price,
// fully offline (no RPC, no Hermes, no send). execute_trigger is not deployed
// to devnet yet, so there are no live triggers to read — per the spec, we mock.
//
// Proves: the loop produces correct per-order decisions, logs the WOULD-SEND
// plan (CU limit + 18-account list + premium/budget) for eligible orders, and
// the dryRun gate short-circuits the sender (the injected send spy stays 0).
//
// Run: ts-node --transpile-only -r tsconfig-paths/register triggerCrank.dryrun.ts
// ============================================================================

import * as anchor from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import BN from "bn.js";

import {
  tickOnce, loadTriggerProgram, type TickDeps, type TickConfig,
  type TriggerCrankContext, type SpotEntry,
} from "./triggerCrank";
import { hexFromBytes } from "@app/utils/format";

// ---- deterministic pubkeys -------------------------------------------------
const pk = (label: string) => {
  const b = Buffer.alloc(32);
  Buffer.from(label).copy(b);
  // ensure on-curve-ish not required for these (only owner needs on-curve for
  // its ATA; use a real keypair for owners below).
  return new PublicKey(b);
};
const ownerKp = Keypair.generate(); // owner must be on-curve (ATA derivation)
const NOW = Math.floor(Date.UTC(2027, 0, 1) / 1000);

// 32-byte feeds
const feedF = Array.from({ length: 32 }, (_, i) => (i * 7 + 1) & 0xff);
const feedF2 = Array.from({ length: 32 }, (_, i) => (i * 11 + 3) & 0xff);
const feedFhex = hexFromBytes(feedF).replace(/^0x/, "").toLowerCase();

const marketM = pk("market-M");
const marketM2 = pk("market-M2");
const vaultV = pk("vault-V");
const mintMnt = pk("series-mint");
const ata = pk("holder-ata");

// ---- mock decoded accounts (anchor shapes) ---------------------------------
const usd = (n: number) => new BN(Math.round(n * 1_000_000));
const BUY = { stopEntryBuy: {} };
const SELL = { takeProfitSell: {} };
const GE = { greaterOrEqual: {} };

function order(label: string, kind: any, comparator: any, thresholdUsd: number, qty: number, maxPremiumUsd: number, market: PublicKey) {
  return {
    publicKey: pk(label),
    account: {
      owner: ownerKp.publicKey, market, vault: vaultV, optionMint: mintMnt, holderOptionAta: ata,
      kind, comparator, thresholdUsdc: usd(thresholdUsd), quantity: new BN(qty),
      maxPremium: usd(maxPremiumUsd), escrowFunded: kind === BUY, createdAt: new BN(NOW), nonce: new BN(1), bump: 255,
    },
  };
}

// T1 buy-eligible, T2 sell-eligible(ITM), T3 buy-condition-not-met,
// T4 buy-over-budget(stays live), T5 stale-feed(market with no price).
const ORDERS = [
  order("T1-buy-elig", BUY, GE, 100, 3, 5, marketM),
  order("T2-sell-elig", SELL, GE, 100, 2, 0, marketM),
  order("T3-buy-cond", BUY, GE, 200, 3, 5, marketM),
  order("T4-buy-overb", BUY, GE, 100, 3, 1, marketM), // budget $3 < premium $12
  order("T5-stale", BUY, GE, 100, 3, 5, marketM2), // M2 feed absent from price map
];
const MARKETS = [
  { publicKey: marketM, account: { pythFeedId: feedF, assetName: "MOCK" } },
  { publicKey: marketM2, account: { pythFeedId: feedF2, assetName: "MOCK2" } },
];
const VAULTS = [
  { publicKey: vaultV, account: { strikePrice: usd(100), optionType: { call: {} }, spreadBps: 0, carryRateBps: 0, expiry: new BN(NOW + 7 * 86400) } },
];
// Only feed F priced ($100.50, fresh). F2 absent → T5 stale_feed.
const PRICES = new Map<string, SpotEntry>([[feedFhex, { priceFloat: 100.5, publishTime: NOW - 10 }]]);

async function main() {
  const connection = new Connection("http://127.0.0.1:8899"); // never hit (no RPC in tickOnce path)
  const wallet = new anchor.Wallet(Keypair.generate());
  const program = loadTriggerProgram(connection, wallet);

  let sendCount = 0;
  const deps: TickDeps = {
    fetchTriggerOrders: async () => ORDERS as any,
    fetchMarkets: async () => MARKETS as any,
    fetchVaults: async () => VAULTS as any,
    readPrices: async () => PRICES,
    quotePegTotalUsdc: async (_m, _vi, quantity) => 4_000_000n * quantity, // $4/contract spread-applied
    send: async () => { sendCount += 1; return "SHOULD-NOT-HAPPEN"; },
    nowSec: () => NOW,
  };

  const cfg: TickConfig = {
    dryRun: true, fireMarginBps: 20, feedStaleSecs: 120,
    usdcMint: pk("usdc-mint"), programId: program.programId, callerPubkey: wallet.publicKey,
  };

  const logs: any[] = [];
  const ctx: TriggerCrankContext = {
    connection, wallet, hermesBase: "https://hermes.test",
    log: (level, msg, fields) => { const e = { level, msg, ...(fields ?? {}) }; logs.push(e); console.log(JSON.stringify(e)); },
    shouldShutdown: () => false,
  };

  const report = await tickOnce(ctx, program, cfg, { backoff: { currentMs: 0, consecutiveOk: 0 } }, deps);

  console.log("\n--- DRY-RUN ASSERTIONS ---");
  const wouldSend = logs.filter((l) => l.event === "would-send");
  const skips = logs.filter((l) => l.event === "skip");
  let ok = true;
  const check = (cond: boolean, label: string) => { console.log(`${cond ? "✓" : "✗"} ${label}`); ok = ok && cond; };

  check(sendCount === 0, "send() was NEVER called (dryRun short-circuits the sender)");
  check(report.fired === 2, `2 eligible would-send (got ${report.fired})`);
  check(wouldSend.length === 2, `2 WOULD-SEND log lines (got ${wouldSend.length})`);
  check(wouldSend.every((l) => l.computeUnitLimit === 400_000), "every would-send carries CU=400000");
  check(wouldSend.every((l) => Array.isArray(l.accounts) && l.accounts.length === 18), "every would-send lists 18 accounts");
  check(report.skippedConditionNotMet === 1, `1 condition_not_met (got ${report.skippedConditionNotMet})`);
  check(report.skippedOverBudget === 1, `1 over_budget — stays live (got ${report.skippedOverBudget})`);
  check(report.skippedStaleFeed === 1, `1 stale_feed (got ${report.skippedStaleFeed})`);
  check(skips.length === 3, `3 skip log lines (got ${skips.length})`);

  console.log(`\n${ok ? "DRY-RUN PASS" : "DRY-RUN FAIL"} — fired=${report.fired} skips=${skips.length} sendCount=${sendCount}`);
  process.exit(ok ? 0 : 1);
}

main().catch((err) => { console.error("dry-run harness crashed:", err); process.exit(1); });
