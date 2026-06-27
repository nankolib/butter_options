import { useCallback, useState } from "react";
import {
  PublicKey,
  SystemProgram,
  ComputeBudgetProgram,
  SYSVAR_RENT_PUBKEY,
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
} from "../../hooks/useAccounts";
import {
  TOKEN_2022_PROGRAM_ID,
  TRANSFER_HOOK_PROGRAM_ID,
  VOL_ORACLE_SEED,
  deriveExtraAccountMetaListPda,
  deriveHookStatePda,
} from "../../utils/constants";
import { toUsdcBN } from "../../utils/format";
import { decodeError, isWalletReplay } from "../../utils/errorDecoder";

// Single compute-budget for the whole atomic bundle. Measured worst case is
// ~435K CU (ATM PUT: create_and_deposit + mint_from_vault, full BS-2002), so
// 600K leaves ~165K headroom. Replaces the old per-stage 400K/800K/1.4M ladder.
const EXTRA_CU_600K = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });

// On-chain seed constant — must match Rust (programs/opta/src/state/market.rs:65).
//   MARKET_SEED = b"market"
const MARKET_SEED = "market";

export type WriteSubmitInput = {
  /** Source market on chain — provides assetName for the (single-seed) market
   *  PDA derivation. The asset must already be registered via Markets. */
  market: { publicKey: PublicKey; account: any };
  side: "call" | "put";
  /** Exercise style. European (default) or American (Stage H toggle). */
  exerciseStyle: "european" | "american";
  /** Strike in USDC (human-readable, e.g. 220). */
  strike: number;
  /** Expiry as Unix seconds. */
  expiry: number;
  /** Number of contracts to mint. */
  contracts: number;
  /** Premium per contract in USDC. */
  premiumPerContract: number;
  /** Collateral to deposit in USDC. */
  collateral: number;
  vaultType: "epoch" | "custom";
};

export type WriteSubmitResult = {
  txSignature: string;
  vaultPda: PublicKey;
  optionMint: PublicKey;
};

export type UseWriteSubmit = {
  submitting: boolean;
  /** Single in-flight label (the flow is now one tx, not three stages). */
  stageLabel: string | null;
  submit: (input: WriteSubmitInput) => Promise<WriteSubmitResult | null>;
};

/**
 * Atomic single-transaction write flow (post direct-write-bundle).
 *
 * One user-signed legacy tx — one wallet approval — carrying:
 *   [ setComputeUnitLimit(600K), create_and_deposit, mint_from_vault ]
 *
 * `create_and_deposit` (Pass C) is `init_if_needed`, so it creates the vault +
 * USDC ATA + writer_position and deposits collateral in a single instruction,
 * whether or not the vault already exists. `mint_from_vault` then mints against
 * the just-deposited collateral in the SAME tx. Because it is one atomic send,
 * a failure reverts everything — no stranded collateral, no half-built vault,
 * no double-deposit-on-retry. The old three-stage scaffolding
 * (submitStageWithRecovery / vault-exists pre-check / deposit snapshot /
 * per-stage landed checks / 1·2·3 labels) is gone.
 *
 * mint_from_vault prices American options from the crank-warmed VolOracle PDA
 * (no in-tx Pyth post); callers gate submit on the oracle being seeded (W1).
 *
 * The lone retained resilience is a single wallet-replay guard: a wallet's
 * optimistic resimulate against a lagged RPC can reject a tx that actually
 * landed ("already processed"). We detect that and confirm via the
 * vault_mint_record before deciding success — see errorDecoder.isWalletReplay.
 */
export function useWriteSubmit(): UseWriteSubmit {
  const { program } = useProgram();
  const { publicKey } = useWallet();
  const [submitting, setSubmitting] = useState(false);
  const [stageLabel, setStageLabel] = useState<string | null>(null);

  const submit = useCallback(
    async (input: WriteSubmitInput): Promise<WriteSubmitResult | null> => {
      if (!program || !publicKey) return null;
      if (!input.market) {
        throw new Error(
          "No market selected. Open Markets and create one for this asset first.",
        );
      }
      setSubmitting(true);
      setStageLabel("Writing…");

      try {
        const asset = input.market.account.assetName as string;
        const optTypeEnum = input.side === "call" ? { call: {} } : { put: {} };
        const optTypeIndex = input.side === "call" ? 0 : 1;
        // ExerciseStyle Anchor enum, { european: {} } | { american: {} }.
        const isAmerican = input.exerciseStyle === "american";
        const exerciseStyleEnum = isAmerican ? { american: {} } : { european: {} };
        const vaultTypeEnum =
          input.vaultType === "epoch" ? { epoch: {} } : { custom: {} };

        const strikeBN = toUsdcBN(input.strike);
        const expiryBN = new BN(input.expiry);
        const collateralBN = toUsdcBN(input.collateral);
        const contractsBN = new BN(input.contracts);
        const premiumBN = toUsdcBN(input.premiumPerContract);
        const createdAt = new BN(Math.floor(Date.now() / 1000));

        const [protocolStatePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("protocol_v2")],
          program.programId,
        );
        const protocolState = await program.account.protocolState.fetch(protocolStatePda);
        const writerUsdcAccount = await getAssociatedTokenAddress(
          protocolState.usdcMint,
          publicKey,
        );

        // Single-seed market PDA (per-asset registry).
        const [marketPda] = PublicKey.findProgramAddressSync(
          [Buffer.from(MARKET_SEED), Buffer.from(asset)],
          program.programId,
        );

        // ---- Shared spec PDAs (vault side) ----
        const [sharedVaultPda] = deriveSharedVault(
          marketPda,
          strikeBN,
          expiryBN,
          optTypeIndex,
          input.exerciseStyle,
        );
        const [vaultUsdcPda] = deriveVaultUsdc(sharedVaultPda);
        const [writerPositionPda] = deriveWriterPosition(sharedVaultPda, publicKey);
        const [epochConfigPda] = deriveEpochConfig();

        // ---- Mint-side PDAs (per-writer per-mint) ----
        const [optionMintPda] = deriveVaultOptionMint(sharedVaultPda, publicKey, createdAt);
        const [purchaseEscrowPda] = deriveVaultPurchaseEscrow(
          sharedVaultPda,
          publicKey,
          createdAt,
        );
        const [vaultMintRecordPda] = deriveVaultMintRecord(optionMintPda);
        const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMintPda);
        const [hookState] = deriveHookStatePda(optionMintPda);

        // vol_oracle PDA — keyed on the market's Pyth feed_id. Read-only here;
        // mint_from_vault's American branch prices BS-2002 from the crank-warmed
        // oracle (no in-tx Pyth post). EUR carries it but never reads it.
        const pythFeedIdBuf = Buffer.from(input.market.account.pythFeedId);
        const [volOraclePda] = PublicKey.findProgramAddressSync(
          [Buffer.from(VOL_ORACLE_SEED), pythFeedIdBuf],
          program.programId,
        );

        // American mint IGNORES the supplied premium (prices on-chain); pass a
        // non-zero sentinel to satisfy the `> 0` arg guard. European passes the
        // TS-computed premium verbatim.
        const mintPremiumBN = isAmerican ? new BN(1) : premiumBN;

        // ---- Instruction 1: create_and_deposit (init_if_needed; one ix) ----
        const createAndDepositIx = await program.methods
          .createAndDeposit(
            strikeBN,
            expiryBN,
            optTypeEnum as any,
            vaultTypeEnum as any,
            protocolState.usdcMint,
            // carry_rate_bps: 0 for current crypto-only assets.
            0,
            exerciseStyleEnum as any,
            collateralBN,
          )
          .accountsStrict({
            writer: publicKey,
            market: marketPda,
            sharedVault: sharedVaultPda,
            vaultUsdcAccount: vaultUsdcPda,
            usdcMint: protocolState.usdcMint,
            writerPosition: writerPositionPda,
            writerUsdcAccount,
            protocolState: protocolStatePda,
            // Required for Epoch (fresh) creation; null for Custom.
            epochConfig: input.vaultType === "epoch" ? epochConfigPda : null,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .instruction();

        // ---- Instruction 2 (terminal): mint_from_vault ----
        // Whole bundle in ONE tx / ONE approval:
        //   [ EXTRA_CU_600K, createAndDepositIx, mintFromVault ]
        let txSignature: string;
        try {
          txSignature = await program.methods
            .mintFromVault(contractsBN, mintPremiumBN, createdAt)
            .accountsStrict({
              writer: publicKey,
              sharedVault: sharedVaultPda,
              writerPosition: writerPositionPda,
              market: marketPda,
              volOracle: volOraclePda,
              protocolState: protocolStatePda,
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
          // Wallet-replay artifact: an optimistic resimulate against a lagged
          // RPC pool sees the now-landed tx as "already processed". Confirm via
          // the vault_mint_record before deciding. Any other error rethrows to
          // the outer decode.
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

        return {
          txSignature,
          vaultPda: sharedVaultPda,
          optionMint: optionMintPda,
        };
      } catch (err: any) {
        throw new Error(decodeError(err));
      } finally {
        setSubmitting(false);
        setStageLabel(null);
      }
    },
    [program, publicKey],
  );

  return { submitting, stageLabel, submit };
}
