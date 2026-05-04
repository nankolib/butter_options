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
  deriveExtraAccountMetaListPda,
  deriveHookStatePda,
} from "../../utils/constants";
import { toUsdcBN } from "../../utils/format";
import { decodeError } from "../../utils/errorDecoder";

const EXTRA_CU_400K = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
const EXTRA_CU_800K = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

// On-chain seed constant — must match Rust (programs/opta/src/state/market.rs:65).
//   MARKET_SEED = b"market"
const MARKET_SEED = "market";

export type WriteSubmitInput = {
  /** Source market on chain — provides assetName for the (now single-seed)
   *  market PDA derivation. createMarket itself is no longer called here;
   *  the caller is expected to register the asset via Markets first. */
  market: { publicKey: PublicKey; account: any };
  side: "call" | "put";
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
  /** Stage label visible to the UI while a submit is in flight. Cleared on completion. */
  stageLabel: string | null;
  submit: (input: WriteSubmitInput) => Promise<WriteSubmitResult | null>;
};

// Decoder-coupling note: this helper inspects the decoded error message for
// the substring "already confirmed", which is the wallet-replay sentinel
// produced by errorDecoder.ts:65-73 (raw RPC "already been processed" →
// "Transaction already confirmed."). If the decoder is ever refactored,
// update this helper in lockstep.
/**
 * Sends one stage of the 3-stage write flow with race-recovery built in.
 *
 * Happy path:  awaits sendFn, returns its tx signature.
 *
 * Recovery path: if sendFn rejects with the wallet-replay sentinel
 *   ("Transaction already confirmed."), we run landedCheckFn against the
 *   chain. If true, the stage actually landed despite the bad reject — we
 *   resolve with whatever signature we can recover from the rejection.
 *   If false, we throw a real per-stage error.
 *
 * Non-recovery path: any other rejection rethrows the original error
 *   unchanged, so the outer try/catch can decode it normally.
 */
async function submitStageWithRecovery(
  stageName: "Vault create" | "Deposit" | "Mint",
  sendFn: () => Promise<string>,
  landedCheckFn: () => Promise<boolean>,
): Promise<string> {
  try {
    return await sendFn();
  } catch (err: any) {
    const decoded = decodeError(err);
    if (!decoded.includes("already confirmed")) {
      throw err;
    }
    const landed = await landedCheckFn();
    if (!landed) {
      throw new Error(`${stageName} did not confirm — please retry.`);
    }
    // Best-effort signature extraction. Phantom's wallet-replay rejects
    // don't always carry a signature; we accept "(unrecoverable)" in those
    // cases. Stage 3 is the only consumer that exposes the sig in the
    // result toast — see WriteSubmitResult.txSignature handling below.
    const recoveredSig: string = err?.signature ?? err?.txid ?? "";
    console.warn(
      `[useWriteSubmit] ${stageName} reported 'already confirmed', ` +
        `verified on-chain — continuing.`,
      { signature: recoveredSig || "(unrecoverable)" },
    );
    return recoveredSig;
  }
}

/**
 * Bundles the three-step write sequence (post-Stage-P4c, post-Stage-2):
 *   1. createSharedVault        (skip if PDA exists)
 *   2. depositToVault
 *   3. mintFromVault
 *
 * createMarket is no longer part of this flow — markets are per-asset
 * registry rows now (Stage 2), and the user is expected to register an
 * asset via the Markets page before writing options on it. If
 * `input.market` is missing, we surface a clear error pointing back there.
 *
 * createSharedVault gained a 5th positional arg `collateral_mint: Pubkey`
 * in Stage 3 (USDC-only validation lives on the vault, not the market).
 * We pass `protocolState.usdcMint` for that arg.
 *
 * Each step is a separate RPC submitted sequentially. On any failure
 * the caller receives `null` and we throw the decoded error string for
 * the toaster to display.
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
      setStageLabel("Preparing…");

      try {
        const asset = input.market.account.assetName as string;
        const optTypeEnum = input.side === "call" ? { call: {} } : { put: {} };
        const optTypeIndex = input.side === "call" ? 0 : 1;

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

        // Single-seed market PDA — strike/expiry/side moved to SharedVault
        // in Stage 2, so the market is per-asset only.
        const [marketPda] = PublicKey.findProgramAddressSync(
          [Buffer.from(MARKET_SEED), Buffer.from(asset)],
          program.programId,
        );

        // ---- Step 1: createSharedVault (skip if exists) ----
        const [sharedVaultPda] = deriveSharedVault(
          marketPda,
          strikeBN,
          expiryBN,
          optTypeIndex,
        );
        const [vaultUsdcPda] = deriveVaultUsdc(sharedVaultPda);

        let vaultExists = false;
        try {
          await program.account.sharedVault.fetch(sharedVaultPda);
          vaultExists = true;
        } catch {
          // not yet created
        }

        if (!vaultExists) {
          setStageLabel("1/3 · Creating vault");
          const [epochConfigPda] = deriveEpochConfig();
          await submitStageWithRecovery(
            "Vault create",
            () =>
              program.methods
                .createSharedVault(
                  strikeBN,
                  expiryBN,
                  optTypeEnum as any,
                  input.vaultType === "epoch" ? { epoch: {} } : ({ custom: {} } as any),
                  protocolState.usdcMint,
                )
                .accountsStrict({
                  creator: publicKey,
                  market: marketPda,
                  sharedVault: sharedVaultPda,
                  vaultUsdcAccount: vaultUsdcPda,
                  usdcMint: protocolState.usdcMint,
                  protocolState: protocolStatePda,
                  epochConfig: input.vaultType === "epoch" ? epochConfigPda : null,
                  tokenProgram: TOKEN_PROGRAM_ID,
                  systemProgram: SystemProgram.programId,
                })
                .preInstructions([EXTRA_CU_400K])
                .rpc({ commitment: "confirmed" }),
            async () => {
              try {
                await program.account.sharedVault.fetch(sharedVaultPda);
                return true;
              } catch {
                return false;
              }
            },
          );
        }

        // ---- Step 2: depositToVault ----
        setStageLabel("2/3 · Depositing collateral");
        const [writerPositionPda] = deriveWriterPosition(sharedVaultPda, publicKey);

        // Snapshot deposited_collateral before sending — used by the
        // race-recovery landed-check to confirm THIS deposit landed (vs a
        // prior deposit by the same writer to the same vault).
        let depositSnapshot: BN = new BN(0);
        try {
          const existingPosition = await program.account.writerPosition.fetch(writerPositionPda);
          depositSnapshot = existingPosition.depositedCollateral as BN;
        } catch {
          // first deposit — no WriterPosition yet; snapshot stays at 0.
        }

        await submitStageWithRecovery(
          "Deposit",
          () =>
            program.methods
              .depositToVault(collateralBN)
              .accountsStrict({
                writer: publicKey,
                sharedVault: sharedVaultPda,
                writerPosition: writerPositionPda,
                writerUsdcAccount,
                vaultUsdcAccount: vaultUsdcPda,
                protocolState: protocolStatePda,
                tokenProgram: TOKEN_PROGRAM_ID,
                systemProgram: SystemProgram.programId,
              })
              .preInstructions([EXTRA_CU_400K])
              .rpc({ commitment: "confirmed" }),
          async () => {
            try {
              const after = await program.account.writerPosition.fetch(writerPositionPda);
              return (after.depositedCollateral as BN).gte(depositSnapshot.add(collateralBN));
            } catch {
              return false;
            }
          },
        );

        // ---- Step 3: mintFromVault ----
        setStageLabel("3/3 · Minting contracts");
        const [optionMintPda] = deriveVaultOptionMint(
          sharedVaultPda,
          publicKey,
          createdAt,
        );
        const [purchaseEscrowPda] = deriveVaultPurchaseEscrow(
          sharedVaultPda,
          publicKey,
          createdAt,
        );
        const [vaultMintRecordPda] = deriveVaultMintRecord(optionMintPda);
        const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMintPda);
        const [hookState] = deriveHookStatePda(optionMintPda);

        const tx = await submitStageWithRecovery(
          "Mint",
          () =>
            program.methods
              .mintFromVault(contractsBN, premiumBN, createdAt)
              .accountsStrict({
                writer: publicKey,
                sharedVault: sharedVaultPda,
                writerPosition: writerPositionPda,
                market: marketPda,
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
              .preInstructions([EXTRA_CU_800K])
              .rpc({ commitment: "confirmed" }),
          async () => {
            try {
              await program.account.vaultMint.fetch(vaultMintRecordPda);
              return true;
            } catch {
              return false;
            }
          },
        );

        return {
          txSignature: tx,
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
