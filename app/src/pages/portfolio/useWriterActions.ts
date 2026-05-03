// =============================================================================
// useWriterActions.ts — Writer-side action handlers for the Portfolio page.
// =============================================================================
//
// Mirrors usePortfolioActions.ts structure: each handler is a useCallback
// that builds the Anchor IX, surfaces success/error via showToast +
// decodeError, and toggles a single `busyId` (+ `busyLabel` for richer
// loading copy than the buyer side's "…").
//
// All three handlers funnel through the same orchestration:
//   beginAction → try { build IX → rpc(confirmed) → toast → onSuccess }
//                  catch { decodeError → "already confirmed" recovery → toast }
//                  finally { endAction }
//
// D5b live-update: every successful action calls onSuccess(), which
// PortfolioPage wires to refetchAll + useVaults().refetch. commitment=
// "confirmed" means the await resolves only after on-chain state is
// durable, so the post-success refetch sees the bumped premium_claimed
// (or the closed WriterPosition for withdraw_post_settlement).
//
// Handler → on-chain IX mapping:
//   claimPremium       → claim_premium             (LIVE state)
//   withdrawCollateral → withdraw_post_settlement  (SETTLED state, auto-claims premium internally)
//   burnUnsoldEscrow   → burn_unsold_from_vault    (D6 secondary link, past-expiry only)
//
// withdraw_from_vault (mid-life uncommitted-collateral redemption) is
// out of scope per D4's "single primary action per row" — Tier-3 follow-up.
// =============================================================================

import { useCallback, useState } from "react";
import {
  PublicKey,
  ComputeBudgetProgram,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountIdempotentInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "../../hooks/useProgram";
import { TOKEN_2022_PROGRAM_ID } from "../../utils/constants";
import {
  deriveWriterPosition,
  deriveVaultPurchaseEscrow,
} from "../../hooks/useAccounts";
import { decodeError } from "../../utils/errorDecoder";
import { showToast } from "../../components/Toast";
import type { WriterRow } from "./writerRows";

// 800K CU mirrors usePortfolioActions; needed for Token-2022 paths
// (burn_unsold_from_vault) and harmless for SPL Token paths.
const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

interface AccountWrapper {
  publicKey: PublicKey;
  account: any;
}

export type WriterActions = {
  /** WriterRow.id currently being acted on; null when idle. Drives row-level button disable. */
  busyId: string | null;
  /** User-visible loading label, e.g. "Claiming accrued premium…". Null when idle. */
  busyLabel: string | null;
  claimPremium: (row: WriterRow) => Promise<void>;
  withdrawCollateral: (row: WriterRow) => Promise<void>;
  burnUnsoldEscrow: (row: WriterRow) => Promise<void>;
};

export type UseWriterActionsArgs = {
  /**
   * Active SharedVault snapshots from useVaults(). Handlers look up the
   * vault body by row.vaultPda to read vaultUsdcAccount + (for burn)
   * to derive purchase_escrow seeds. Passed in (rather than fetched per
   * action) so we get the same stale-tolerant view the rows were built
   * from — and so each click doesn't add an RPC roundtrip.
   */
  vaults: AccountWrapper[];
  /**
   * Active VaultMint snapshots. Used by burnUnsoldEscrow to find the
   * (vault, writer) record and derive the purchase_escrow PDA.
   */
  vaultMints: AccountWrapper[];
  /**
   * Refetch callback for D5b live update. PortfolioPage wires
   * refetchAll + useVaults().refetch so post-action UI reflects the
   * fresh on-chain state within ~2 seconds.
   */
  onSuccess: () => void;
};

export function useWriterActions(args: UseWriterActionsArgs): WriterActions {
  const { vaults, vaultMints, onSuccess } = args;
  const { program } = useProgram();
  const { publicKey } = useWallet();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);

  // ---------------------------------------------------------------------------
  // claim_premium — LIVE state primary action
  // ---------------------------------------------------------------------------
  const claimPremium = useCallback(
    async (row: WriterRow) => {
      if (!program || !publicKey) return;
      const vault = vaults.find((v) => v.publicKey.equals(row.vaultPda));
      if (!vault) {
        showToast({
          type: "error",
          title: "Claim failed",
          message: "Vault account not found in current snapshot.",
        });
        return;
      }

      setBusyId(row.id);
      setBusyLabel("Claiming accrued premium…");
      try {
        const [protocolStatePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("protocol_v2")],
          program.programId,
        );
        const protocolState = await program.account.protocolState.fetch(protocolStatePda);
        const usdcMint = protocolState.usdcMint as PublicKey;

        const [writerPositionPda] = deriveWriterPosition(row.vaultPda, publicKey);
        const writerUsdcAccount = await getAssociatedTokenAddress(usdcMint, publicKey);

        // Defensive idempotent ATA creation. The writer almost certainly
        // has this ATA from the original deposit_to_vault flow, but if
        // they ever closed it the IX would revert with "AccountNotInitialized".
        // Idempotent instruction is a no-op when the account exists.
        const createWriterUsdcAtaIx = createAssociatedTokenAccountIdempotentInstruction(
          publicKey,
          writerUsdcAccount,
          publicKey,
          usdcMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        );

        const tx = await program.methods
          .claimPremium()
          .accountsStrict({
            writer: publicKey,
            sharedVault: row.vaultPda,
            writerPosition: writerPositionPda,
            vaultUsdcAccount: vault.account.vaultUsdcAccount as PublicKey,
            writerUsdcAccount,
            protocolState: protocolStatePda,
            tokenProgram: TOKEN_PROGRAM_ID,
          })
          .preInstructions([EXTRA_CU, createWriterUsdcAtaIx])
          .rpc({ commitment: "confirmed" });

        showToast({
          type: "success",
          title: "Premium claimed",
          message: "USDC credited to your wallet.",
          txSignature: tx,
        });
        onSuccess();
      } catch (err: any) {
        const msg = decodeError(err);
        // Wallet replay race — same fingerprint usePortfolioActions handles
        // (memory: project_post_tx_polling_false_error_gap.md). The tx did
        // land; we just can't tell from this side. Treat as success and
        // refetch so the UI reflects the truth.
        if (msg.includes("already confirmed")) {
          showToast({
            type: "success",
            title: "Premium claimed",
            message: "Tx already confirmed; refreshing.",
          });
          onSuccess();
          return;
        }
        showToast({ type: "error", title: "Claim failed", message: msg });
      } finally {
        setBusyId(null);
        setBusyLabel(null);
      }
    },
    [program, publicKey, vaults, onSuccess],
  );

  // ---------------------------------------------------------------------------
  // withdraw_post_settlement — SETTLED state primary action
  //
  // The on-chain handler auto-claims unclaimed premium AND transfers the
  // writer's pro-rata of collateral_remaining in a single tx (April 12
  // audit HIGH-01 fix). Closes the WriterPosition account on success
  // (rent returned to writer). Per D9 + the plan's edge-case note, the
  // row will simply vanish from myPositions after this completes.
  // ---------------------------------------------------------------------------
  const withdrawCollateral = useCallback(
    async (row: WriterRow) => {
      if (!program || !publicKey) return;
      const vault = vaults.find((v) => v.publicKey.equals(row.vaultPda));
      if (!vault) {
        showToast({
          type: "error",
          title: "Withdraw failed",
          message: "Vault account not found in current snapshot.",
        });
        return;
      }

      setBusyId(row.id);
      setBusyLabel("Claiming premium and withdrawing…");
      try {
        const [protocolStatePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("protocol_v2")],
          program.programId,
        );
        const protocolState = await program.account.protocolState.fetch(protocolStatePda);
        const usdcMint = protocolState.usdcMint as PublicKey;

        const [writerPositionPda] = deriveWriterPosition(row.vaultPda, publicKey);
        const writerUsdcAccount = await getAssociatedTokenAddress(usdcMint, publicKey);

        const createWriterUsdcAtaIx = createAssociatedTokenAccountIdempotentInstruction(
          publicKey,
          writerUsdcAccount,
          publicKey,
          usdcMint,
          TOKEN_PROGRAM_ID,
          ASSOCIATED_TOKEN_PROGRAM_ID,
        );

        const tx = await program.methods
          .withdrawPostSettlement()
          .accountsStrict({
            writer: publicKey,
            sharedVault: row.vaultPda,
            writerPosition: writerPositionPda,
            vaultUsdcAccount: vault.account.vaultUsdcAccount as PublicKey,
            writerUsdcAccount,
            protocolState: protocolStatePda,
            tokenProgram: TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .preInstructions([EXTRA_CU, createWriterUsdcAtaIx])
          .rpc({ commitment: "confirmed" });

        showToast({
          type: "success",
          title: "Withdrawn",
          message: "Collateral and accrued premium credited to your wallet.",
          txSignature: tx,
        });
        onSuccess();
      } catch (err: any) {
        const msg = decodeError(err);
        if (msg.includes("already confirmed")) {
          showToast({
            type: "success",
            title: "Withdrawn",
            message: "Tx already confirmed; refreshing.",
          });
          onSuccess();
          return;
        }
        showToast({ type: "error", title: "Withdraw failed", message: msg });
      } finally {
        setBusyId(null);
        setBusyLabel(null);
      }
    },
    [program, publicKey, vaults, onSuccess],
  );

  // ---------------------------------------------------------------------------
  // burn_unsold_from_vault — D6 secondary action
  //
  // Writer burns unsold tokens from their purchase_escrow, freeing up
  // committed collateral and closing the escrow account (rent → writer).
  // Per memory feedback_burn_unsold_sequence.md, this must run BEFORE
  // auto-finalize closes the WriterPosition. writerRows.ts gates the
  // showBurnUnsold flag on isPastExpiry + unsoldCount > 0 + ownVaultMint
  // existence; the Section/Table layer additionally hides the link when
  // showBurnUnsold is false.
  // ---------------------------------------------------------------------------
  const burnUnsoldEscrow = useCallback(
    async (row: WriterRow) => {
      if (!program || !publicKey) return;
      // Lookup must match (vault, writer) pair. mint_from_vault enforces
      // at-most-one VaultMint per pair, so the find() result is unique.
      const vaultMint = vaultMints.find(
        (vm) =>
          (vm.account.vault as PublicKey).equals(row.vaultPda) &&
          (vm.account.writer as PublicKey).equals(publicKey),
      );
      if (!vaultMint) {
        showToast({
          type: "error",
          title: "Burn failed",
          message: "Vault mint record not found — auto-finalize may have already cleaned up.",
        });
        return;
      }

      setBusyId(row.id);
      setBusyLabel("Burning unsold contracts…");
      try {
        const [protocolStatePda] = PublicKey.findProgramAddressSync(
          [Buffer.from("protocol_v2")],
          program.programId,
        );

        const [writerPositionPda] = deriveWriterPosition(row.vaultPda, publicKey);

        // purchase_escrow PDA: [VAULT_PURCHASE_ESCROW_SEED, vault, writer, created_at]
        // — created_at lives on the VaultMint record (not WriterPosition),
        // matching the on-chain seed at burn_unsold_from_vault.rs:160-167.
        const [purchaseEscrowPda] = deriveVaultPurchaseEscrow(
          row.vaultPda,
          publicKey,
          vaultMint.account.createdAt,
        );

        const tx = await program.methods
          .burnUnsoldFromVault()
          .accountsStrict({
            writer: publicKey,
            sharedVault: row.vaultPda,
            writerPosition: writerPositionPda,
            vaultMintRecord: vaultMint.publicKey,
            protocolState: protocolStatePda,
            optionMint: vaultMint.account.optionMint as PublicKey,
            purchaseEscrow: purchaseEscrowPda,
            token2022Program: TOKEN_2022_PROGRAM_ID,
          })
          .preInstructions([EXTRA_CU])
          .rpc({ commitment: "confirmed" });

        showToast({
          type: "success",
          title: "Unsold burned",
          message: `${row.unsoldCount} contracts removed; escrow rent returned.`,
          txSignature: tx,
        });
        onSuccess();
      } catch (err: any) {
        const msg = decodeError(err);
        if (msg.includes("already confirmed")) {
          showToast({
            type: "success",
            title: "Unsold burned",
            message: "Tx already confirmed; refreshing.",
          });
          onSuccess();
          return;
        }
        showToast({ type: "error", title: "Burn failed", message: msg });
      } finally {
        setBusyId(null);
        setBusyLabel(null);
      }
    },
    [program, publicKey, vaultMints, onSuccess],
  );

  return { busyId, busyLabel, claimPremium, withdrawCollateral, burnUnsoldEscrow };
}
