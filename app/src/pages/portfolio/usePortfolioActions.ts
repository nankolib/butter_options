import { useCallback, useState } from "react";
import * as anchor from "@coral-xyz/anchor";
import {
  PublicKey,
  ComputeBudgetProgram,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createBurnCheckedInstruction,
} from "@solana/spl-token";
import BN from "bn.js";
import { useWallet } from "@solana/wallet-adapter-react";
import { useProgram } from "../../hooks/useProgram";
import {
  TOKEN_2022_PROGRAM_ID,
  TRANSFER_HOOK_PROGRAM_ID,
  deriveExtraAccountMetaListPda,
  deriveHookStatePda,
} from "../../utils/constants";
import { usdcToNumber, hexFromBytes } from "../../utils/format";
import { requiredCollateralPerContract } from "../../utils/collateral";
import {
  deriveVaultResaleListing,
  deriveVaultResaleEscrow,
} from "../../hooks/useAccounts";
import {
  buildPostUpdateAndExerciseAmericanTx,
  submitWithFallback,
  fetchHermesParsedPrice,
} from "../../utils/pythPullPost";
import { decodeError, isWalletReplay } from "../../utils/errorDecoder";
import { showToast } from "../../components/Toast";
import type { Position } from "./positions";

const EXTRA_CU = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });

export type PortfolioActions = {
  /** Position id (option-mint base58) currently being acted on; `null` when idle. Drives row-level button disabled state. */
  busyId: string | null;
  exercise: (p: Position) => Promise<void>;
  /** American early exercise (pre-expiry). Posts a fresh PriceUpdateV2 + calls
   *  exercise_american. Dark until Stage I — deriveAction only emits the
   *  "exercise-american" action when AMERICAN_ENABLED_UI is true. */
  exerciseAmerican: (p: Position) => Promise<void>;
  listResale: (p: Position, premiumUsd: number, tokenAmount: number) => Promise<void>;
  cancelResale: (p: Position) => Promise<void>;
  burn: (p: Position) => Promise<void>;
};

/**
 * Bundles the four buyer-side action handlers (exercise / listResale /
 * cancelResale / burn) plus a single busyId state for in-flight tracking.
 *
 * On-chain instruction calls are lifted verbatim from the legacy
 * Portfolio.tsx (preserved at git revision 7405348~1) — only the
 * orchestration around them changed. v1 dispatches via Anchor program
 * methods on the protocol; v2 routes through `exerciseFromVault`. Burn
 * uses Token-2022's `burnChecked` SPL instruction directly since it
 * doesn't require a protocol-side state update — it's just removing
 * worthless dust from the wallet.
 *
 * Errors surface via the existing showToast pipeline through
 * decodeError, matching the legacy UX.
 */
export function usePortfolioActions(onSuccess: () => void): PortfolioActions {
  const { program, provider } = useProgram();
  const { publicKey } = useWallet();
  const [busyId, setBusyId] = useState<string | null>(null);

  const exercise = useCallback(
    async (p: Position) => {
      if (!program || !provider || !publicKey) return;
      setBusyId(p.id);
      try {
        await exerciseV2({ program, publicKey, position: p });
        onSuccess();
      } catch (err: any) {
        const msg = decodeError(err);
        if (isWalletReplay(err)) {
          showToast({
            type: "success",
            title: "Exercised",
            message: "Tx already confirmed; refreshing.",
          });
          onSuccess();
          return;
        }
        showToast({ type: "error", title: "Exercise failed", message: msg });
      } finally {
        setBusyId(null);
      }
    },
    [program, provider, publicKey, onSuccess],
  );

  const exerciseAmerican = useCallback(
    async (p: Position) => {
      if (!program || !provider || !publicKey) return;
      setBusyId(p.id);
      try {
        await exerciseAmericanV2({ program, provider, publicKey, position: p });
        onSuccess();
      } catch (err: any) {
        const msg = decodeError(err);
        if (isWalletReplay(err)) {
          showToast({
            type: "success",
            title: "Exercised early",
            message: "Tx already confirmed; refreshing.",
          });
          onSuccess();
          return;
        }
        showToast({ type: "error", title: "Early exercise failed", message: msg });
      } finally {
        setBusyId(null);
      }
    },
    [program, provider, publicKey, onSuccess],
  );

  const listResale = useCallback(
    async (p: Position, premiumUsd: number, tokenAmount: number) => {
      if (!program || !provider || !publicKey) return;
      setBusyId(p.id);
      try {
        await listResaleV2({ program, publicKey, position: p, premiumUsd, tokenAmount });
        showToast({
          type: "success",
          title: "Listed for resale",
          message: `Asking $${premiumUsd.toFixed(2)}`,
        });
        onSuccess();
      } catch (err: any) {
        const msg = decodeError(err);
        if (isWalletReplay(err)) {
          showToast({
            type: "success",
            title: "Listed for resale",
            message: "Tx already confirmed; refreshing.",
          });
          onSuccess();
          return;
        }
        showToast({ type: "error", title: "Listing failed", message: msg });
      } finally {
        setBusyId(null);
      }
    },
    [program, provider, publicKey, onSuccess],
  );

  const cancelResale = useCallback(
    async (p: Position) => {
      if (!program || !provider || !publicKey) return;
      setBusyId(p.id);
      try {
        await cancelResaleV2({ program, publicKey, position: p });
        showToast({
          type: "success",
          title: "Listing cancelled",
          message: "Tokens returned to wallet.",
        });
        onSuccess();
      } catch (err: any) {
        const msg = decodeError(err);
        if (isWalletReplay(err)) {
          showToast({
            type: "success",
            title: "Listing cancelled",
            message: "Tx already confirmed; refreshing.",
          });
          onSuccess();
          return;
        }
        showToast({ type: "error", title: "Cancel listing failed", message: msg });
      } finally {
        setBusyId(null);
      }
    },
    [program, provider, publicKey, onSuccess],
  );

  const burn = useCallback(
    async (p: Position) => {
      if (!provider || !publicKey) return;
      setBusyId(p.id);
      try {
        await burnTokens({ provider, publicKey, position: p });
        showToast({
          type: "success",
          title: "Tokens burned",
          message: `${p.contracts} contracts removed from your wallet.`,
        });
        onSuccess();
      } catch (err: any) {
        const msg = decodeError(err);
        if (isWalletReplay(err)) {
          showToast({
            type: "success",
            title: "Tokens burned",
            message: "Tx already confirmed; refreshing.",
          });
          onSuccess();
          return;
        }
        showToast({ type: "error", title: "Burn failed", message: msg });
      } finally {
        setBusyId(null);
      }
    },
    [provider, publicKey, onSuccess],
  );

  return { busyId, exercise, exerciseAmerican, listResale, cancelResale, burn };
}

// ---------------------------------------------------------------------------
// On-chain implementations
// ---------------------------------------------------------------------------

async function exerciseV2({
  program,
  publicKey,
  position,
}: {
  program: any;
  publicKey: PublicKey;
  position: Position;
}) {
  const { vault, vaultMint } = position.source;
  const v = vault.account;
  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_v2")],
    program.programId,
  );
  const protocolState = await program.account.protocolState.fetch(protocolStatePda);
  const optionMint = vaultMint.account.optionMint as PublicKey;
  const holderUsdcAccount = await getAssociatedTokenAddress(
    protocolState.usdcMint,
    publicKey,
  );
  const holderOptionAccount = getAssociatedTokenAddressSync(
    optionMint,
    publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  );

  const isCall = "call" in v.optionType;
  const settlement = usdcToNumber(v.settlementPrice);
  const strike = usdcToNumber(v.strikePrice);
  const pnl = isCall
    ? Math.max(0, settlement - strike)
    : Math.max(0, strike - settlement);
  const totalPayout = (pnl * position.contracts).toFixed(2);

  const tx = await program.methods
    .exerciseFromVault(new BN(position.contracts))
    .accountsStrict({
      holder: publicKey,
      sharedVault: vault.publicKey,
      market: v.market,
      vaultMintRecord: vaultMint.publicKey,
      optionMint,
      holderOptionAccount,
      vaultUsdcAccount: v.vaultUsdcAccount,
      holderUsdcAccount,
      protocolState: protocolStatePda,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      tokenProgram: TOKEN_PROGRAM_ID,
    })
    .preInstructions([EXTRA_CU])
    .rpc({ commitment: "confirmed" });

  showToast({
    type: "success",
    title: "Exercised!",
    message: `${position.contracts} contracts burned. Received $${totalPayout} USDC.`,
    txSignature: tx,
  });
}

async function exerciseAmericanV2({
  program,
  provider,
  publicKey,
  position,
}: {
  program: any;
  provider: any;
  publicKey: PublicKey;
  position: Position;
}) {
  const { vault, vaultMint } = position.source;
  const v = vault.account;
  const marketPda = v.market as PublicKey;

  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_v2")],
    program.programId,
  );
  const protocolState = await program.account.protocolState.fetch(protocolStatePda);
  const usdcMint = protocolState.usdcMint as PublicKey;
  const optionMint = vaultMint.account.optionMint as PublicKey;

  const holderUsdcAccount = await getAssociatedTokenAddress(usdcMint, publicKey);
  const holderOptionAccount = getAssociatedTokenAddressSync(
    optionMint,
    publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  );

  // Feed hex: prefer the joined market body (present on most held positions);
  // fall back to a direct fetch if this position surfaced without its market.
  let feedIdBytes: number[];
  const mktBody = position.source.market;
  if (mktBody?.pythFeedId) {
    feedIdBytes = mktBody.pythFeedId as number[];
  } else {
    const fetched = await program.account.optionsMarket.fetch(marketPda);
    feedIdBytes = fetched.pythFeedId as number[];
  }
  const feedIdHex = hexFromBytes(feedIdBytes);

  // Atomic post fresh /latest PriceUpdateV2 + exercise_american + close, 1.4M CU.
  const txs = await buildPostUpdateAndExerciseAmericanTx(program, provider.wallet, {
    feedIdHex,
    quantity: position.contracts,
    sharedVault: vault.publicKey,
    market: marketPda,
    vaultMintRecord: vaultMint.publicKey,
    optionMint,
    holderOptionAccount,
    vaultUsdcAccount: v.vaultUsdcAccount as PublicKey,
    holderUsdcAccount,
  });
  const sig = await submitWithFallback(program.provider.connection, provider.wallet, txs);

  // Capped-intrinsic payout estimate (display only) from a live Hermes spot:
  // CALL min(spot − strike, collateral/contract), PUT strike − spot.
  const isCall = "call" in v.optionType;
  const strike = usdcToNumber(v.strikePrice);
  let payoutMsg = "";
  const parsed = await fetchHermesParsedPrice(feedIdHex).catch(() => null);
  if (parsed && parsed.price > 0) {
    const collateralPerContract = requiredCollateralPerContract(
      strike,
      isCall ? "call" : "put",
    );
    const rawIntrinsic = isCall
      ? Math.max(0, parsed.price - strike)
      : Math.max(0, strike - parsed.price);
    const cappedPerContract = isCall
      ? Math.min(rawIntrinsic, collateralPerContract)
      : rawIntrinsic;
    const total = (cappedPerContract * position.contracts).toFixed(2);
    payoutMsg = ` Received ~$${total} USDC.`;
  }

  showToast({
    type: "success",
    title: "Exercised early!",
    message: `${position.contracts} contracts burned.${payoutMsg}`,
    txSignature: sig,
  });
}

async function listResaleV2({
  program,
  publicKey,
  position,
  premiumUsd,
  tokenAmount,
}: {
  program: any;
  publicKey: PublicKey;
  position: Position;
  premiumUsd: number;
  tokenAmount: number;
}) {
  const { vault, vaultMint } = position.source;
  const optionMint = vaultMint.account.optionMint as PublicKey;
  const marketPda = vault.account.market as PublicKey;

  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_v2")],
    program.programId,
  );
  const protocolState = await program.account.protocolState.fetch(protocolStatePda);
  const usdcMint = protocolState.usdcMint as PublicKey;

  const [listingPda] = deriveVaultResaleListing(optionMint, publicKey);
  const [resaleEscrowPda] = deriveVaultResaleEscrow(listingPda);
  const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMint);
  const [hookState] = deriveHookStatePda(optionMint);

  const sellerOptionAccount = getAssociatedTokenAddressSync(
    optionMint,
    publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  );
  const sellerUsdcAccount = getAssociatedTokenAddressSync(
    usdcMint,
    publicKey,
    false,
    TOKEN_PROGRAM_ID,
  );

  // Floor at the lamport level so the on-chain total never exceeds the user's
  // typed input. Worst case: user receives up to (tokenAmount - 1) micro-USDC
  // less than they intended (e.g. $9.999999 instead of $10.00 on a $10/3
  // listing). Rounding direction matters: an overcharged listing would
  // confuse buyers and break the modal's "Total: $X" preview math.
  const totalMicros = Math.floor(premiumUsd * 1_000_000);
  const perContractMicros = Math.floor(totalMicros / tokenAmount);
  const pricePerContract = new BN(perContractMicros);

  // CRITICAL per V2_SECONDARY_FRONTEND_PLAN.md §10: buy_v2_resale reverts if
  // the seller's USDC ATA is missing (it's not pre-created by the buy flow
  // per the on-chain plan's OQ#6). The list flow MUST always pre-create it,
  // idempotent — otherwise the first buy attempt against this listing fails
  // and the seller has no in-app recovery path.
  const createSellerUsdcAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    publicKey,
    sellerUsdcAccount,
    publicKey,
    usdcMint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  await program.methods
    .listV2ForResale(pricePerContract, new BN(tokenAmount))
    .accountsStrict({
      seller: publicKey,
      sharedVault: vault.publicKey,
      market: marketPda,
      vaultMintRecord: vaultMint.publicKey,
      optionMint,
      sellerOptionAccount,
      listing: listingPda,
      resaleEscrow: resaleEscrowPda,
      protocolState: protocolStatePda,
      transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
      extraAccountMetaList,
      hookState,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      rent: anchor.web3.SYSVAR_RENT_PUBKEY,
    })
    .preInstructions([EXTRA_CU, createSellerUsdcAtaIx])
    .rpc({ commitment: "confirmed" });
}

async function cancelResaleV2({
  program,
  publicKey,
  position,
}: {
  program: any;
  publicKey: PublicKey;
  position: Position;
}) {
  const { vault, vaultMint } = position.source;
  const optionMint = vaultMint.account.optionMint as PublicKey;

  const [protocolStatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("protocol_v2")],
    program.programId,
  );
  const [listingPda] = deriveVaultResaleListing(optionMint, publicKey);
  const [resaleEscrowPda] = deriveVaultResaleEscrow(listingPda);
  const [extraAccountMetaList] = deriveExtraAccountMetaListPda(optionMint);
  const [hookState] = deriveHookStatePda(optionMint);

  const sellerOptionAccount = getAssociatedTokenAddressSync(
    optionMint,
    publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  );

  // Defensive: the seller had to have an option ATA at list time, but they
  // may have closed it afterward (rare). Idempotent re-create is free if it
  // already exists and prevents a "destination ATA not found" revert.
  const createSellerOptionAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    publicKey,
    sellerOptionAccount,
    publicKey,
    optionMint,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  );

  await program.methods
    .cancelV2Resale()
    .accountsStrict({
      seller: publicKey,
      sharedVault: vault.publicKey,
      optionMint,
      listing: listingPda,
      resaleEscrow: resaleEscrowPda,
      sellerOptionAccount,
      protocolState: protocolStatePda,
      transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
      extraAccountMetaList,
      hookState,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .preInstructions([EXTRA_CU, createSellerOptionAtaIx])
    .rpc({ commitment: "confirmed" });
}

async function burnTokens({
  provider,
  publicKey,
  position,
}: {
  provider: any;
  publicKey: PublicKey;
  position: Position;
}) {
  // Token-2022 burn. Doesn't update on-chain state; just removes
  // worthless tokens from the wallet so they stop appearing in
  // heldBalances.
  const optionMint = position.source.vaultMint.account.optionMint as PublicKey;

  const ata = getAssociatedTokenAddressSync(
    optionMint,
    publicKey,
    false,
    TOKEN_2022_PROGRAM_ID,
  );

  const tx = new Transaction();
  tx.add(EXTRA_CU);
  tx.add(
    createBurnCheckedInstruction(
      ata,
      optionMint,
      publicKey,
      BigInt(position.contracts),
      0, // option tokens use 0 decimals — each token = 1 contract
      [],
      TOKEN_2022_PROGRAM_ID,
    ),
  );

  await provider.sendAndConfirm(tx, [], { commitment: "confirmed" });
}
