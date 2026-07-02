import { useCallback, useState } from "react";
import {
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import BN from "bn.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "../../hooks/useProgram";
import {
  deriveSharedVault,
  deriveVaultUsdc,
  deriveWriterPosition,
  deriveVaultOptionMint,
  deriveVaultPurchaseEscrow,
  deriveVaultMintRecord,
  deriveEpochConfig,
  deriveCanonicalSeriesMint,
} from "../../hooks/useAccounts";
import {
  buildCreateSeriesIx,
  buildCreateSharedVaultIx,
  postSeriesOrder,
  type SeriesRef,
} from "../trade/orderFlows";
import {
  TOKEN_2022_PROGRAM_ID,
  TRANSFER_HOOK_PROGRAM_ID,
  VOL_ORACLE_SEED,
  RESTING_ORDER_SEED,
  deriveExtraAccountMetaListPda,
  deriveHookStatePda,
} from "../../utils/constants";
import { toUsdcBN } from "../../utils/format";
import { decodeError, isWalletReplay } from "../../utils/errorDecoder";
import posthog from "posthog-js";

// Single compute-budget for the whole atomic bundle (one cell). Measured worst
// case ~435K CU; 600K leaves headroom. One per cell — each cell is its own tx.
const EXTRA_CU_600K = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });

// On-chain seed constant — must match Rust (programs/opta/src/state/market.rs:65).
//   MARKET_SEED = b"market"
const MARKET_SEED = "market";

/** One ladder cell = one atomic tx's worth of (expiry, contracts, collateral, premium). */
export type WriteCell = {
  expiryTs: number;
  contracts: number; // whole
  collateral: number; // human USDC
  /** Per-cell premium (USDC). Recomputed per expiry by the section (BS default)
   *  or a flat override; mint_from_vault ignores it on the American branch. */
  premiumPerContract: number;
  tenorLabels: string[]; // display only; merged tenors share a cell
};

export type WriteSubmitInput = {
  market: { publicKey: PublicKey; account: any };
  side: "call" | "put";
  exerciseStyle: "european" | "american";
  strike: number;
  vaultType: "epoch" | "custom";
  cells: WriteCell[]; // 1 = single-tenor; N = ladder
};

export type CellResult = {
  tenorLabels: string[];
  expiryTs: number;
  contracts: number;
  collateral: number;
  premiumPerContract: number;
  status: "landed" | "failed";
  txSignature?: string;
  vaultPda?: PublicKey;
  optionMint?: PublicKey;
  /** Failure reason. "Cancelled" distinguishes a wallet rejection from a real error. */
  error?: string;
};

/** Payload a section hands to WritePage on (partial) success, carrying retry. */
export type WriteSuccessPayload = {
  kind: "epoch" | "custom";
  cells: CellResult[];
  retryFailed: (cells: WriteCell[]) => Promise<CellResult[] | null>;
};

export type UseWriteSubmit = {
  submitting: boolean;
  stageLabel: string | null;
  submit: (input: WriteSubmitInput) => Promise<CellResult[] | null>;
  /** Re-run ONLY the cells passed in input.cells (the form supplies failed ones). */
  retry: (input: WriteSubmitInput) => Promise<CellResult[] | null>;
};

// Per-write derivations identical across every cell.
type SharedCtx = {
  protocolStatePda: PublicKey;
  usdcMint: PublicKey;
  writerUsdcAccount: PublicKey;
  marketPda: PublicKey;
  epochConfigPda: PublicKey;
  volOraclePda: PublicKey;
};

/**
 * Ladder-aware atomic write.
 *
 * Single-tenor is the degenerate 1-cell case — same code path. Each cell runs
 * the EXACT proven bundle: one user-signed legacy tx
 *   [ setComputeUnitLimit(600K), create_and_deposit, mint_from_vault ]
 * = one wallet approval, all-or-nothing. Cells run SEQUENTIALLY (size-bound at
 * 1 cell/tx). A cell failure is recorded and the loop CONTINUES — one failing
 * strands nothing (atomic), it just yields fewer tenors. Retry is scoped to
 * failed cells only (never blind-rerun: the bundle is not idempotent — deposit
 * is additive and the mint uses a fresh createdAt nonce).
 *
 * Premium is PER-CELL: the section recomputes the BS premium for each cell's
 * expiry (time-to-expiry differs per tenor) or applies the flat Advanced
 * override; this hook only reads `cell.premiumPerContract`.
 */
export function useWriteSubmit(): UseWriteSubmit {
  const { program } = useProgram();
  const { publicKey } = useWallet();
  const [submitting, setSubmitting] = useState(false);
  const [stageLabel, setStageLabel] = useState<string | null>(null);

  const submit = useCallback(
    async (input: WriteSubmitInput): Promise<CellResult[] | null> => {
      if (!program || !publicKey) return null;
      if (!input.market) {
        throw new Error(
          "No market selected. Open Markets and create one for this asset first.",
        );
      }
      if (!input.cells || input.cells.length === 0) return null;

      setSubmitting(true);
      setStageLabel(input.cells.length > 1 ? `Writing 1/${input.cells.length}…` : "Writing…");
      try {
        // ---- Shared derivations (once for the whole write) ----
        const optTypeIndex = input.side === "call" ? 0 : 1;
        const isAmerican = input.exerciseStyle === "american";
        const asset = input.market.account.assetName as string;

        const [protocolStatePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("protocol_v2")],
          program.programId,
        );
        const protocolState = await program.account.protocolState.fetch(protocolStatePda);
        const usdcMint = protocolState.usdcMint as PublicKey;
        const writerUsdcAccount = await getAssociatedTokenAddress(usdcMint, publicKey);
        const [marketPda] = PublicKey.findProgramAddressSync(
          [Buffer.from(MARKET_SEED), Buffer.from(asset)],
          program.programId,
        );
        const [epochConfigPda] = deriveEpochConfig();
        const pythFeedIdBuf = Buffer.from(input.market.account.pythFeedId);
        const [volOraclePda] = PublicKey.findProgramAddressSync(
          [Buffer.from(VOL_ORACLE_SEED), pythFeedIdBuf],
          program.programId,
        );
        const shared: SharedCtx = {
          protocolStatePda,
          usdcMint,
          writerUsdcAccount,
          marketPda,
          epochConfigPda,
          volOraclePda,
        };

        const results: CellResult[] = [];
        for (let i = 0; i < input.cells.length; i++) {
          const cell = input.cells[i];
          if (input.cells.length > 1) setStageLabel(`Writing ${i + 1}/${input.cells.length}…`);
          try {
            const r = await sendCell(program, publicKey, input, cell, shared, optTypeIndex, isAmerican);
            results.push({
              tenorLabels: cell.tenorLabels,
              expiryTs: cell.expiryTs,
              contracts: cell.contracts,
              collateral: cell.collateral,
              premiumPerContract: cell.premiumPerContract,
              status: "landed",
              ...r,
            });
          } catch (err: any) {
            // Distinguish a wallet rejection from a real on-chain/network error so
            // the retry banner reads cleanly.
            const cancelled = String(err?.message ?? err).includes("User rejected");
            results.push({
              tenorLabels: cell.tenorLabels,
              expiryTs: cell.expiryTs,
              contracts: cell.contracts,
              collateral: cell.collateral,
              premiumPerContract: cell.premiumPerContract,
              status: "failed",
              error: cancelled ? "Cancelled" : decodeError(err),
            });
            // DO NOT abort — continue to the next tenor.
          }
        }
        const landed = results.filter((r) => r.status === "landed").length;
        if (landed > 0) {
          posthog.capture(input.vaultType === "epoch" ? "epoch_write" : "custom_write", {
            asset, side: input.side, strike: input.strike, exerciseStyle: input.exerciseStyle,
            cells: input.cells.length, cellsLanded: landed, ladder: input.cells.length > 1,
          });
        }
        return results;
      } finally {
        setSubmitting(false);
        setStageLabel(null);
      }
    },
    [program, publicKey],
  );

  // retry === submit (the form passes input.cells = the failed cells only).
  return { submitting, stageLabel, submit, retry: submit };
}

/**
 * Send ONE cell as the proven atomic bundle. The instruction assembly here is
 * byte-identical to the pre-ladder single-tenor hook (verified on-chain at
 * 433K CU) — only the (expiry, contracts, collateral, premium) + fresh
 * createdAt vary.
 */
async function sendCell(
  program: any,
  publicKey: PublicKey,
  input: WriteSubmitInput,
  cell: WriteCell,
  shared: SharedCtx,
  optTypeIndex: number,
  isAmerican: boolean,
): Promise<{ txSignature: string; vaultPda: PublicKey; optionMint: PublicKey }> {
  // Epoch + American → canonical fungible SERIES path (create_series + 0-pool
  // vault + WriterAsk). Custom vaults AND European-epoch stay on the legacy
  // per-writer create_and_deposit + mint_from_vault path below.
  if (input.vaultType === "epoch" && isAmerican) {
    return sendEpochSeriesCell(program, publicKey, input, cell, shared, optTypeIndex);
  }

  const optTypeEnum = input.side === "call" ? { call: {} } : { put: {} };
  const exerciseStyleEnum = isAmerican ? { american: {} } : { european: {} };
  const vaultTypeEnum = input.vaultType === "epoch" ? { epoch: {} } : { custom: {} };

  const strikeBN = toUsdcBN(input.strike);
  const expiryBN = new BN(cell.expiryTs);
  const collateralBN = toUsdcBN(cell.collateral);
  const contractsBN = new BN(cell.contracts);
  const premiumBN = toUsdcBN(cell.premiumPerContract);
  const createdAt = new BN(Math.floor(Date.now() / 1000));

  const [sharedVaultPda] = deriveSharedVault(
    shared.marketPda,
    strikeBN,
    expiryBN,
    optTypeIndex,
    input.exerciseStyle,
  );
  const [vaultUsdcPda] = deriveVaultUsdc(sharedVaultPda);
  const [writerPositionPda] = deriveWriterPosition(sharedVaultPda, publicKey);
  const [optionMintPda] = deriveVaultOptionMint(sharedVaultPda, publicKey, createdAt);
  const [purchaseEscrowPda] = deriveVaultPurchaseEscrow(sharedVaultPda, publicKey, createdAt);
  const [vaultMintRecordPda] = deriveVaultMintRecord(optionMintPda);
  const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMintPda);
  const [hookState] = deriveHookStatePda(optionMintPda);

  // American mint IGNORES the supplied premium (prices on-chain); pass a non-zero
  // sentinel to satisfy the `> 0` arg guard. European passes the per-cell premium.
  const mintPremiumBN = isAmerican ? new BN(1) : premiumBN;

  const createAndDepositIx = await program.methods
    .createAndDeposit(
      strikeBN,
      expiryBN,
      optTypeEnum as any,
      vaultTypeEnum as any,
      shared.usdcMint,
      // carry_rate_bps: 0 for current crypto-only assets.
      0,
      exerciseStyleEnum as any,
      collateralBN,
    )
    .accountsStrict({
      writer: publicKey,
      market: shared.marketPda,
      sharedVault: sharedVaultPda,
      vaultUsdcAccount: vaultUsdcPda,
      usdcMint: shared.usdcMint,
      writerPosition: writerPositionPda,
      writerUsdcAccount: shared.writerUsdcAccount,
      protocolState: shared.protocolStatePda,
      // Required for Epoch (fresh) creation; null for Custom.
      epochConfig: input.vaultType === "epoch" ? shared.epochConfigPda : null,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .instruction();

  let txSignature: string;
  try {
    txSignature = await program.methods
      .mintFromVault(contractsBN, mintPremiumBN, createdAt)
      .accountsStrict({
        writer: publicKey,
        sharedVault: sharedVaultPda,
        writerPosition: writerPositionPda,
        market: shared.marketPda,
        volOracle: shared.volOraclePda,
        protocolState: shared.protocolStatePda,
        optionMint: optionMintPda,
        purchaseEscrow: purchaseEscrowPda,
        vaultMintRecord: vaultMintRecordPda,
        transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
        extraAccountMetaList,
        hookState,
        systemProgram: SystemProgram.programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .preInstructions([EXTRA_CU_600K, createAndDepositIx])
      .rpc({ commitment: "confirmed" });
  } catch (err: any) {
    // Wallet-replay artifact: an optimistic resimulate against a lagged RPC pool
    // sees the now-landed tx as "already processed". Confirm via the
    // vault_mint_record before deciding. Any other error rethrows to the caller.
    if (!isWalletReplay(err)) throw err;
    const landed = await program.account.vaultMint
      .fetch(vaultMintRecordPda)
      .then(() => true)
      .catch(() => false);
    if (!landed) {
      throw new Error("Write did not confirm — please retry.");
    }
    txSignature = err?.signature ?? err?.txid ?? "";
  }

  return { txSignature, vaultPda: sharedVaultPda, optionMint: optionMintPda };
}

/**
 * Epoch + American cell → canonical fungible SERIES via already-deployed rails.
 * Sequence (≤2 txs, idempotent skip-if-exists):
 *   1. ensure infra (ONE tx, only the missing ixs): create_series (if the series
 *      record is absent) + create_shared_vault 0-pool (if the vault is absent).
 *   2. post_order(WriterAsk) at the writer's premium — escrows strike×qty into a
 *      per-order, cancellable escrow; buyers mint the fungible series on fill.
 * Steady state (series+vault already exist): a single WriterAsk tx.
 * Replaces the per-writer mint_from_vault path for epoch American writes.
 */
async function sendEpochSeriesCell(
  program: any,
  publicKey: PublicKey,
  input: WriteSubmitInput,
  cell: WriteCell,
  shared: SharedCtx,
  optTypeIndex: number,
): Promise<{ txSignature: string; vaultPda: PublicKey; optionMint: PublicKey }> {
  const strikeBN = toUsdcBN(input.strike);
  const expiryBN = new BN(cell.expiryTs);
  const optTypeEnum = input.side === "call" ? { call: {} } : { put: {} };
  const asset = input.market.account.assetName as string;

  const [vaultPda] = deriveSharedVault(shared.marketPda, strikeBN, expiryBN, optTypeIndex, "american");
  const [seriesMint] = deriveCanonicalSeriesMint(shared.marketPda, strikeBN, expiryBN, optTypeIndex);
  const [recordPda] = deriveVaultMintRecord(seriesMint);
  const conn = program.provider.connection;

  // ---- 1. Ensure infra (only the missing pieces) — ONE tx if anything's absent ----
  const [recordInfo, vaultInfo] = await Promise.all([
    conn.getAccountInfo(recordPda),
    conn.getAccountInfo(vaultPda),
  ]);
  const infraIxs: TransactionInstruction[] = [];
  if (!recordInfo) {
    infraIxs.push(await buildCreateSeriesIx(
      program, publicKey, shared.marketPda, shared.protocolStatePda, seriesMint, recordPda,
      strikeBN, expiryBN, optTypeEnum));
  }
  if (!vaultInfo) {
    infraIxs.push(await buildCreateSharedVaultIx(
      program, publicKey, shared.marketPda, shared.protocolStatePda, vaultPda, shared.usdcMint,
      shared.epochConfigPda, strikeBN, expiryBN, optTypeEnum));
  }
  if (infraIxs.length > 0) {
    try {
      await program.provider.sendAndConfirm(
        new Transaction().add(EXTRA_CU_600K, ...infraIxs), [], { commitment: "confirmed" });
    } catch (err: any) {
      // Idempotent: a concurrent write (or a wallet-replay) may have created them.
      // Re-check both before failing; only rethrow if still missing.
      if (!isWalletReplay(err)) {
        const [r2, v2] = await Promise.all([conn.getAccountInfo(recordPda), conn.getAccountInfo(vaultPda)]);
        if (!r2 || !v2) throw err;
      }
    }
  }

  // ---- 2. Post the WriterAsk at the writer's premium (reuses T2) ----
  const ref: SeriesRef = { asset, vault: vaultPda.toBase58(), optionMint: seriesMint.toBase58() };
  const nonce = new BN(Math.floor(Date.now() / 1000));
  let txSignature: string;
  try {
    txSignature = await postSeriesOrder(
      program, ref, "writerAsk", toUsdcBN(cell.premiumPerContract), cell.contracts, nonce);
  } catch (err: any) {
    if (!isWalletReplay(err)) throw err;
    // Replay → the order likely landed; confirm via the order PDA before deciding
    // (never re-post: a fresh nonce would create a DUPLICATE ask).
    const [order] = PublicKey.findProgramAddressSync(
      [Buffer.from(RESTING_ORDER_SEED), seriesMint.toBuffer(), publicKey.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)],
      program.programId);
    const landed = await conn.getAccountInfo(order);
    if (!landed) throw new Error("Write did not confirm — please retry.");
    txSignature = err?.signature ?? err?.txid ?? "";
  }

  return { txSignature, vaultPda, optionMint: seriesMint };
}
