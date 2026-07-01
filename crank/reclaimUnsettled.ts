// ============================================================================
// crank/reclaimUnsettled.ts — dead-feed reclaim (Phase 3 D3, 2-phase)
// ============================================================================
//
// The dead-feed hatch for a vault whose SettlementRecord never landed. Two
// phases, strictly ordered:
//
//   Phase 1 — initialize_void (ONCE per vault): after the 7-day grace with no
//     SettlementRecord, atomically sweeps any writer-ask pot, seeds
//     collateral_remaining = total_collateral − early_exercise_payout, and flips
//     `voided = true`. The SOLE voided-setter.
//   Phase 2 — reclaim_unsettled (per writer): pro-rata payout to each writer's
//     USDC ATA, zeroing WriterPosition.shares. Reverts VaultNotVoided (6xxx) if
//     Phase 1 hasn't committed — so ordering is enforced BOTH on-chain and here
//     (we re-fetch and assert voided===true before firing any reclaim).
//
// Account derivations proven against real on-chain vaults by the settle/void
// sim probes (option_mint / pot seeds identical to settle_vault). reclaim's 7
// accounts are NOT yet live-proven — that happens in the synthetic once a real
// voided vault exists.
//
// Derivation sources:
//   - option_mint / writer_ask_pot(_usdc): create_series.rs / settle_vault.rs
//   - settlement_record: [SETTLEMENT_SEED, market.asset_name, expiry_le]
//   - writer_position: [WRITER_POSITION_SEED, vault, writer]
//   - treasury: protocol_state.treasury (field read)
//   - writer_usdc_account: writer's USDC ATA (owner==writer, mint==collateral_mint)
// ============================================================================

import * as anchor from "@coral-xyz/anchor";
import {
  Connection,
  PublicKey,
  Transaction,
  ComputeBudgetProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";

import type { Opta } from "@app/idl/opta";
import { fetchAllDecoded } from "./triggerCrank";
import type { LogFn } from "./autoFinalize";

// ---- Seeds (verbatim from programs/opta/src/state) --------------------------
const MARKET_SEED = "market";
const SETTLEMENT_SEED = "settlement";
const PROTOCOL_SEED = "protocol_v2";
const VAULT_OPTION_MINT_SEED = "vault_option_mint";
const WRITER_ASK_POT_SEED = "writer_ask_pot";
const WRITER_ASK_POT_USDC_SEED = "writer_ask_pot_usdc";
const WRITER_POSITION_SEED = "writer_position";

/// WriterPosition layout: 8 disc + 32 owner + 32 vault → vault @ offset 40.
const WRITER_POSITION_VAULT_OFFSET = 8 + 32;

export interface ReclaimContext {
  connection: Connection;
  program: anchor.Program<Opta>;
  log: LogFn;
}

export interface ReclaimReport {
  vault: string;
  voidSig: string | null;      // null if already voided or dryRun
  alreadyVoided: boolean;
  writersFound: number;
  reclaimSigs: string[];
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Writer enumeration — REUSES the orphan-tolerant fetchAllDecoded helper
// (coder.decode + try/catch skip), scoped by a memcmp on WriterPosition.vault.
// No hand-rolled byte parser and no `.all()` (which dies on stale-discriminator
// orphans). shares > 0 filters out already-reclaimed / empty positions.
// ---------------------------------------------------------------------------
export async function listWriterPositionsForVault(
  program: anchor.Program<Opta>,
  vaultPda: PublicKey,
): Promise<{ writer: PublicKey; writerPosition: PublicKey }[]> {
  const decoded = await fetchAllDecoded(program, "writerPosition", [
    { memcmp: { offset: WRITER_POSITION_VAULT_OFFSET, bytes: vaultPda.toBase58() } },
  ]);
  return decoded
    .filter((d) => (d.account.shares as anchor.BN).gtn(0))
    .map((d) => ({ writer: d.account.owner as PublicKey, writerPosition: d.publicKey }));
}

// ---------------------------------------------------------------------------
// Phase 1 — initialize_void (11 accounts)
// ---------------------------------------------------------------------------
export async function buildInitializeVoidIx(
  program: anchor.Program<Opta>,
  cranker: PublicKey,
  vaultPda: PublicKey,
): Promise<TransactionInstruction> {
  const v = await program.account.sharedVault.fetch(vaultPda);
  const market = await program.account.optionsMarket.fetch(v.market);

  const [marketPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(MARKET_SEED), Buffer.from(market.assetName)], program.programId);
  const [settlementPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(SETTLEMENT_SEED), Buffer.from(market.assetName), v.expiry.toArrayLike(Buffer, "le", 8)],
    program.programId);
  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from(PROTOCOL_SEED)], program.programId);
  const protocol = await program.account.protocolState.fetch(protocolStatePda);
  const treasury = protocol.treasury; // field read (source: initialize_void.rs constraint)

  const ot = "call" in v.optionType ? 0 : 1;
  const es = "european" in v.exerciseStyle ? 0 : 1;
  const [optionMint] = PublicKey.findProgramAddressSync(
    [Buffer.from(VAULT_OPTION_MINT_SEED), marketPda.toBuffer(),
     v.strikePrice.toArrayLike(Buffer, "le", 8), v.expiry.toArrayLike(Buffer, "le", 8),
     Buffer.from([ot]), Buffer.from([es])], program.programId);
  const [writerAskPot] = PublicKey.findProgramAddressSync(
    [Buffer.from(WRITER_ASK_POT_SEED), optionMint.toBuffer()], program.programId);
  const [writerAskPotUsdc] = PublicKey.findProgramAddressSync(
    [Buffer.from(WRITER_ASK_POT_USDC_SEED), optionMint.toBuffer()], program.programId);

  return program.methods.initializeVoid().accountsStrict({
    cranker,
    sharedVault: vaultPda,
    market: marketPda,
    settlementRecord: settlementPda,
    optionMint,
    writerAskPot,
    writerAskPotUsdc,
    vaultUsdcAccount: v.vaultUsdcAccount,
    protocolState: protocolStatePda,
    treasury,
    tokenProgram: TOKEN_PROGRAM_ID,
  }).instruction();
}

// ---------------------------------------------------------------------------
// Phase 2 — reclaim_unsettled (7 accounts) + idempotent writer USDC ATA.
// Returns [createAtaIdempotent, reclaim] — the ATA create is a no-op if the
// writer already has a USDC ATA; cranker pays its rent. Prepending it
// unconditionally avoids a getAccountInfo round-trip per writer.
// ---------------------------------------------------------------------------
export async function buildReclaimIxs(
  program: anchor.Program<Opta>,
  cranker: PublicKey,
  vaultPda: PublicKey,
  writer: PublicKey,
): Promise<TransactionInstruction[]> {
  const v = await program.account.sharedVault.fetch(vaultPda);
  const [writerPosition] = PublicKey.findProgramAddressSync(
    [Buffer.from(WRITER_POSITION_SEED), vaultPda.toBuffer(), writer.toBuffer()], program.programId);
  const writerUsdcAccount = getAssociatedTokenAddressSync(
    v.collateralMint, writer, true, TOKEN_PROGRAM_ID);

  const createAta = createAssociatedTokenAccountIdempotentInstruction(
    cranker, writerUsdcAccount, writer, v.collateralMint, TOKEN_PROGRAM_ID);

  const reclaim = await program.methods.reclaimUnsettled().accountsStrict({
    cranker,
    writer,
    sharedVault: vaultPda,
    writerPosition,
    vaultUsdcAccount: v.vaultUsdcAccount,
    writerUsdcAccount,
    tokenProgram: TOKEN_PROGRAM_ID,
  }).instruction();

  return [createAta, reclaim];
}

// ---------------------------------------------------------------------------
// 2-phase orchestrator — enforces void-confirmed-BEFORE-reclaim.
// ---------------------------------------------------------------------------
export async function reclaimVault(
  ctx: ReclaimContext,
  vaultPda: PublicKey,
  opts: { dryRun?: boolean; computeUnitLimit?: number } = {},
): Promise<ReclaimReport> {
  const { program, log } = ctx;
  const dryRun = opts.dryRun ?? false;
  const cuLimit = opts.computeUnitLimit ?? 400_000;
  const cranker = program.provider.publicKey!;

  const report: ReclaimReport = {
    vault: vaultPda.toBase58(), voidSig: null, alreadyVoided: false,
    writersFound: 0, reclaimSigs: [], dryRun,
  };

  // ---- Phase 1: ensure the vault is voided ----
  const before = await program.account.sharedVault.fetch(vaultPda);
  if (before.voided) {
    report.alreadyVoided = true;
    log("info", "vault already voided — skipping initialize_void", { vault: report.vault });
  } else {
    const voidIx = await buildInitializeVoidIx(program, cranker, vaultPda);
    if (dryRun) {
      log("info", "[dryRun] built initialize_void ix (11 accounts) — not sent", { vault: report.vault });
    } else {
      const tx = new Transaction()
        .add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }))
        .add(voidIx);
      report.voidSig = await program.provider.sendAndConfirm!(tx);
      log("info", "initialize_void landed", { vault: report.vault, sig: report.voidSig });
    }
  }

  // ---- Ordering barrier: reclaim ONLY after voided===true is confirmed ----
  if (!dryRun && !report.alreadyVoided) {
    const after = await program.account.sharedVault.fetch(vaultPda);
    if (!after.voided) {
      throw new Error(`initialize_void did not set voided on ${report.vault}; aborting reclaim`);
    }
  }

  // ---- Phase 2: per-writer reclaim ----
  const writers = await listWriterPositionsForVault(program, vaultPda);
  report.writersFound = writers.length;
  for (const { writer } of writers) {
    const ixs = await buildReclaimIxs(program, cranker, vaultPda, writer);
    if (dryRun) {
      log("info", "[dryRun] built reclaim_unsettled ixs (ATA + 7-acct reclaim) — not sent",
        { vault: report.vault, writer: writer.toBase58() });
      continue;
    }
    const tx = new Transaction()
      .add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }))
      .add(...ixs);
    const sig = await program.provider.sendAndConfirm!(tx);
    report.reclaimSigs.push(sig);
    log("info", "reclaim_unsettled landed", { vault: report.vault, writer: writer.toBase58(), sig });
  }

  return report;
}

// ---------------------------------------------------------------------------
// runReclaimSweep — the crank-loop pass (Phase 3). Enumerates ALREADY-FETCHED
// vaults + markets (no new gPA), filters to zero-premium dead-feed candidates,
// and 2-phases each via reclaimVault. Crash-isolated per candidate. Cluster
// time (getBlockTime) gates the 7-day grace — NEVER the local clock (~5h skew).
// ---------------------------------------------------------------------------
const RECLAIM_GRACE_WINDOW_S = 604_800; // 7 days — mirrors state/shared_vault.rs::GRACE_WINDOW

export interface ReclaimSweepResult {
  candidates: number;
  voided: number;
  writersReclaimed: number;
  usdcMoved: bigint; // vault_usdc drawn summed across candidates (0 in dry-run)
  errors: number;
}

async function usdcBalance(connection: Connection, ata: PublicKey): Promise<bigint> {
  const ai = await connection.getAccountInfo(ata);
  return ai && ai.data.length >= 72 ? ai.data.readBigUInt64LE(64) : 0n;
}

export async function runReclaimSweep(
  ctx: ReclaimContext,
  vaults: { publicKey: PublicKey; account: any }[],
  markets: { publicKey: PublicKey; account: any }[],
  opts: { dryRun: boolean; computeUnitLimit?: number },
): Promise<ReclaimSweepResult> {
  const { connection, program, log } = ctx;
  const res: ReclaimSweepResult = { candidates: 0, voided: 0, writersReclaimed: 0, usdcMoved: 0n, errors: 0 };

  // Cluster time — NEVER the local clock (devnet ~5h skew would mis-gate the grace).
  let clusterNow: number | null = null;
  try {
    clusterNow = await connection.getBlockTime(await connection.getSlot());
  } catch (err) {
    log("warn", "reclaim sweep: cluster-time fetch failed — skipping this tick", { err: String(err) });
  }
  if (clusterNow === null) return res;

  const marketByPda = new Map<string, { publicKey: PublicKey; account: any }>();
  for (const m of markets) marketByPda.set(m.publicKey.toBase58(), m);

  for (const v of vaults) {
    const acct = v.account;
    if (acct.isSettled || acct.voided) continue;
    const expiry = typeof acct.expiry === "number" ? acct.expiry : acct.expiry.toNumber();
    if (expiry + RECLAIM_GRACE_WINDOW_S >= clusterNow) continue;
    const ppsc = acct.premiumPerShareCumulative;
    const ppscZero = typeof ppsc?.isZero === "function" ? ppsc.isZero() : String(ppsc) === "0";
    if (!ppscZero) continue; // zero-premium ONLY — premium-bearing left writer-gated by design

    const market = marketByPda.get((acct.market as PublicKey).toBase58());
    if (!market) continue;
    const asset = market.account.assetName as string;
    if (!asset) continue;

    // One getAccountInfo: SettlementRecord present ⇒ NOT a dead feed ⇒ skip.
    const expiryBn = typeof acct.expiry === "number" ? new anchor.BN(acct.expiry) : acct.expiry;
    const [settlementPda] = PublicKey.findProgramAddressSync(
      [Buffer.from(SETTLEMENT_SEED), Buffer.from(asset), expiryBn.toArrayLike(Buffer, "le", 8)],
      program.programId,
    );
    let settlementExists: boolean;
    try {
      settlementExists = (await connection.getAccountInfo(settlementPda)) !== null;
    } catch (err) {
      log("warn", "reclaim sweep: settlement probe failed — skipping candidate", {
        vault: v.publicKey.toBase58(), err: String(err),
      });
      continue;
    }
    if (settlementExists) continue;

    res.candidates += 1;
    const vaultUsdc = acct.vaultUsdcAccount as PublicKey;
    const preBal = opts.dryRun ? 0n : await usdcBalance(connection, vaultUsdc);

    try {
      const report = await reclaimVault(ctx, v.publicKey, {
        dryRun: opts.dryRun,
        computeUnitLimit: opts.computeUnitLimit,
      });
      const drawn = opts.dryRun ? 0n : preBal - (await usdcBalance(connection, vaultUsdc));
      if (drawn > 0n) res.usdcMoved += drawn;
      if (!opts.dryRun && (report.voidSig || report.alreadyVoided)) res.voided += 1;
      res.writersReclaimed += report.reclaimSigs.length;
      log("info", "reclaim candidate processed", {
        vault: report.vault, asset, expiry,
        daysPastGrace: Math.floor((clusterNow - expiry - RECLAIM_GRACE_WINDOW_S) / 86_400),
        dryRun: report.dryRun,
        voidAction: report.dryRun ? "[dryRun]" : report.alreadyVoided ? "already-voided"
          : report.voidSig ? "initialize_void" : "none",
        voidSig: report.voidSig,
        writersFound: report.writersFound,
        writersReclaimed: report.reclaimSigs.length,
        reclaimSigs: report.reclaimSigs,
        usdcDrawn: drawn.toString(),
      });
    } catch (err) {
      res.errors += 1;
      log("error", "reclaim candidate crashed", { vault: v.publicKey.toBase58(), asset, err: String(err) });
      continue;
    }
  }

  if (res.candidates > 0) {
    log("info", "reclaim sweep summary", {
      candidates: res.candidates, voided: res.voided,
      writersReclaimed: res.writersReclaimed, usdcMoved: res.usdcMoved.toString(),
      errors: res.errors, dryRun: opts.dryRun,
    });
  }
  return res;
}
