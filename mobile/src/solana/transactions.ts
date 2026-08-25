import { Program, BN } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  Transaction,
  TransactionMessage,
  VersionedTransaction
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync
} from "@solana/spl-token";
import {
  TOKEN_2022_PROGRAM_ID,
  TRANSFER_HOOK_PROGRAM_ID
} from "../constants";
import { toUsdcBN } from "../format";
import { sanitizeAssetDisplayName } from "../runtime/assetDisplay";
import type {
  ExerciseStyle,
  Offering,
  OptionSide,
  PendingTx,
  TransactionKind,
  WriteDraft
} from "../types";
import {
  deriveExtraAccountMetaListPda,
  deriveHookStatePda,
  deriveSharedVault,
  deriveVaultMintRecord,
  deriveVaultOptionMint,
  deriveVaultUsdc,
  deriveVaultPurchaseEscrow,
  deriveVaultResaleEscrow,
  deriveVolOracle,
  deriveWriterPosition,
  epochConfigPda,
  protocolStatePda,
  treasuryPda
} from "./pdas";
import { fetchDecodedAccount } from "./program";
import { ensureDevnetConnection } from "./cluster";

const EXTRA_CU_600K = ComputeBudgetProgram.setComputeUnitLimit({ units: 600_000 });
const EXTRA_CU_800K = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });
const EXTRA_CU_1_4M = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

async function finalizeAndSimulate(
  connection: Connection,
  feePayer: PublicKey,
  tx: Transaction,
  summary: string[],
  kind: TransactionKind,
  resultAccounts?: PendingTx["resultAccounts"]
): Promise<PendingTx> {
  await ensureDevnetConnection(connection);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = feePayer;
  // The { sigVerify, replaceRecentBlockhash } config is only valid for a
  // VersionedTransaction — passing it with a legacy Transaction makes web3.js
  // throw "Invalid arguments" before any RPC. Simulate a versioned compile of
  // the same instructions; the legacy `tx` is still what MWA signs and submits.
  const simMessage = new TransactionMessage({
    payerKey: feePayer,
    recentBlockhash: blockhash,
    instructions: tx.instructions
  }).compileToV0Message();
  const simulation = await connection.simulateTransaction(
    new VersionedTransaction(simMessage),
    { sigVerify: false, replaceRecentBlockhash: true }
  );
  const simulationError = simulation.value.err
    ? JSON.stringify(simulation.value.err)
    : null;
  return {
    transaction: tx,
    summary,
    simulationError,
    kind,
    blockhash,
    lastValidBlockHeight,
    builtAt: Date.now(),
    resultAccounts
  };
}

type ProtocolStateAccount = { usdcMint: PublicKey };

async function loadProtocolState(program: Program): Promise<{
  publicKey: PublicKey;
  account: ProtocolStateAccount;
}> {
  await ensureDevnetConnection(program.provider.connection);
  const publicKey = protocolStatePda(program.programId);
  const record = await fetchDecodedAccount<ProtocolStateAccount>(
    program,
    "protocolState",
    publicKey
  );
  if (!record) throw new Error("Protocol state is not initialized.");
  return record;
}

function optionTypeEnum(side: OptionSide): any {
  return side === "call" ? { call: {} } : { put: {} };
}

function optionTypeIndex(side: OptionSide): number {
  return side === "call" ? 0 : 1;
}

function exerciseStyleEnum(style: ExerciseStyle): any {
  return style === "american" ? { american: {} } : { european: {} };
}

function writeDerivations(draft: WriteDraft, writer: PublicKey, programId: PublicKey) {
  const strike = toUsdcBN(draft.strike);
  const expiry = new BN(draft.expiry);
  const sharedVault = deriveSharedVault(
    draft.market.publicKey,
    strike,
    expiry,
    optionTypeIndex(draft.side),
    draft.exerciseStyle,
    programId
  );
  return {
    strike,
    expiry,
    sharedVault,
    vaultUsdc: deriveVaultUsdc(sharedVault, programId),
    writerPosition: deriveWriterPosition(sharedVault, writer, programId)
  };
}

export type AtomicWriteCapability =
  | { supported: true }
  | { supported: false; reason: string };

/** Epoch-American writes use the canonical series/order rail, not per-writer direct minting. */
export function atomicWriteCapability(
  draft: Pick<WriteDraft, "vaultType" | "exerciseStyle">
): AtomicWriteCapability {
  if (draft.vaultType === "epoch" && draft.exerciseStyle === "american") {
    return {
      supported: false,
      reason: "American epoch writes require the canonical series order flow, which is not wired in mobile yet."
    };
  }
  return { supported: true };
}

export async function buildAtomicWriteTx(params: {
  program: Program;
  connection: Connection;
  writer: PublicKey;
  draft: WriteDraft;
}): Promise<PendingTx> {
  const { program, connection, writer, draft } = params;
  const capability = atomicWriteCapability(draft);
  if (!capability.supported) throw new Error(capability.reason);

  const protocol = await loadProtocolState(program);
  const protocolPda = protocol.publicKey;
  const protocolState = protocol.account;
  const derived = writeDerivations(draft, writer, program.programId);
  const writerUsdcAccount = await getAssociatedTokenAddress(
    protocolState.usdcMint,
    writer,
    false,
    TOKEN_PROGRAM_ID
  );
  const createWriterUsdcAta = createAssociatedTokenAccountIdempotentInstruction(
    writer,
    writerUsdcAccount,
    writer,
    protocolState.usdcMint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const createAndDepositIx = await (program.methods as any)
    .createAndDeposit(
      derived.strike,
      derived.expiry,
      optionTypeEnum(draft.side),
      draft.vaultType === "epoch" ? { epoch: {} } : { custom: {} },
      protocolState.usdcMint,
      0,
      exerciseStyleEnum(draft.exerciseStyle),
      toUsdcBN(draft.collateral)
    )
    .accountsStrict({
      writer,
      market: draft.market.publicKey,
      sharedVault: derived.sharedVault,
      vaultUsdcAccount: derived.vaultUsdc,
      usdcMint: protocolState.usdcMint,
      writerPosition: derived.writerPosition,
      writerUsdcAccount,
      protocolState: protocolPda,
      epochConfig: draft.vaultType === "epoch" ? epochConfigPda(program.programId) : null,
      tokenProgram: TOKEN_PROGRAM_ID,
      systemProgram: SystemProgram.programId
    })
    .instruction();

  const createdAt = new BN(Math.floor(Date.now() / 1000));
  const optionMint = deriveVaultOptionMint(
    derived.sharedVault,
    writer,
    createdAt,
    program.programId
  );
  const purchaseEscrow = deriveVaultPurchaseEscrow(
    derived.sharedVault,
    writer,
    createdAt,
    program.programId
  );
  const vaultMintRecord = deriveVaultMintRecord(optionMint, program.programId);
  const extraAccountMetaList = deriveExtraAccountMetaListPda(optionMint, TRANSFER_HOOK_PROGRAM_ID);
  const hookState = deriveHookStatePda(optionMint, TRANSFER_HOOK_PROGRAM_ID);
  const volOracle = deriveVolOracle(
    Array.from(draft.market.account.pythFeedId as number[]),
    program.programId
  );
  const isAmerican = draft.exerciseStyle === "american";
  const asset = sanitizeAssetDisplayName(draft.market.account.assetName) ?? "ASSET";
  const mintPremium = isAmerican ? new BN(1) : toUsdcBN(draft.premiumPerContract);
  const mintIx = await (program.methods as any)
    .mintFromVault(new BN(draft.contracts), mintPremium, createdAt)
    .accountsStrict({
      writer,
      sharedVault: derived.sharedVault,
      writerPosition: derived.writerPosition,
      market: draft.market.publicKey,
      volOracle,
      protocolState: protocolPda,
      optionMint,
      purchaseEscrow,
      vaultMintRecord,
      transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
      extraAccountMetaList,
      hookState,
      systemProgram: SystemProgram.programId,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY
    })
    .instruction();

  const computeBudget = isAmerican ? EXTRA_CU_1_4M : EXTRA_CU_600K;
  const transaction = new Transaction().add(
    computeBudget,
    createWriterUsdcAta,
    createAndDepositIx,
    mintIx
  );
  const pending = await finalizeAndSimulate(
    connection,
    writer,
    transaction,
    [
      `Write ${draft.contracts} contracts`,
      `${asset} ${draft.side.toUpperCase()} ${draft.exerciseStyle.toUpperCase()}`,
      `Strike ${draft.strike}`,
      `Expiry ${new Date(draft.expiry * 1000).toUTCString()}`,
      `Deposits ${draft.collateral.toFixed(2)} USDC collateral · one approval`,
      "Atomic write: if any instruction fails, nothing is deposited",
      "Collateral uses classic SPL Token; option mint and escrow use Token-2022"
    ],
    "write",
    { vault: derived.sharedVault, optionMint }
  );
  pending.ctaLabel = "Sign write";
  pending.successMessage = "Write submitted";
  return pending;
}


/**
 * Rev C — pre-sign chain-direct re-read. MANDATORY.
 *
 * Display rows may come from the indexer (cache-control: max-age=10, and its own
 * refresh cadence on top). A signature must never be built from them. This
 * re-reads the two accounts the transaction actually depends on, straight from
 * chain, and BLOCKS with a surfaced error on any material divergence — it never
 * silently proceeds and never silently substitutes.
 *
 * The thrown message reaches the user through the §2b-bis error panel.
 */
/** Local mirror of marketData's private helper — BN | number | string -> number. */
function bnToNumber(value: any): number {
  if (value == null) return 0;
  if (typeof value === "number") return value;
  if (value?.toNumber) { try { return value.toNumber(); } catch { return Number(value.toString()); } }
  const n = Number(String(value));
  return Number.isFinite(n) ? n : 0;
}

export class StaleOfferingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaleOfferingError";
  }
}

export async function reReadOfferingForSigning(
  program: Program,
  offering: Offering,
  quantity: number
): Promise<{ vault: any; vaultMint: any }> {
  const [vault, vaultMint] = await Promise.all([
    fetchDecodedAccount<any>(program, "sharedVault", offering.vault.publicKey),
    fetchDecodedAccount<any>(program, "vaultMint", offering.vaultMint.publicKey)
  ]);
  if (!vault) throw new StaleOfferingError("This vault no longer exists on-chain. Refresh and try again.");
  if (!vaultMint) throw new StaleOfferingError("This offer no longer exists on-chain. Refresh and try again.");

  if (vault.account.isSettled) throw new StaleOfferingError("This vault has settled. Refresh to see current offers.");
  if (vault.account.voided) throw new StaleOfferingError("This vault has been voided. Refresh to see current offers.");
  const nowSec = Math.floor(Date.now() / 1000);
  if (bnToNumber(vault.account.expiry) <= nowSec) {
    throw new StaleOfferingError("This option has expired. Refresh to see current offers.");
  }

  const freshPremium = bnToNumber(vaultMint.account.premiumPerContract);
  const shownPremium = bnToNumber(offering.vaultMint.account.premiumPerContract);
  if (freshPremium !== shownPremium) {
    throw new StaleOfferingError("The price changed while you were reviewing. Refresh and try again.");
  }

  const unsold = bnToNumber(vaultMint.account.quantityMinted) - bnToNumber(vaultMint.account.quantitySold);
  if (unsold < quantity) {
    throw new StaleOfferingError(`Only ${Math.max(0, unsold)} contract(s) remain. Refresh and try again.`);
  }

  if (!(vaultMint.account.optionMint as PublicKey).equals(offering.vaultMint.account.optionMint as PublicKey)) {
    throw new StaleOfferingError("This offer changed on-chain. Refresh and try again.");
  }
  return { vault, vaultMint };
}

export async function buildPrimaryPurchaseTx(params: {
  program: Program;
  connection: Connection;
  buyer: PublicKey;
  offering: Offering;
  quantity: number;
}): Promise<PendingTx> {
  const { program, connection, buyer, offering, quantity } = params;
  const protocol = await loadProtocolState(program);
  const protocolPda = protocol.publicKey;
  const treasury = treasuryPda(program.programId);
  const protocolState = protocol.account;

  // Rev C: chain-direct re-read BEFORE anything is built or signed. Throws on
  // divergence rather than proceeding with index-derived inputs.
  const fresh = await reReadOfferingForSigning(program, offering, quantity);
  const vault = fresh.vault;
  const vaultMint = fresh.vaultMint;
  const optionMint = vaultMint.account.optionMint as PublicKey;
  const writer = vaultMint.account.writer as PublicKey;
  const createdAt = vaultMint.account.createdAt as BN;

  const writerPosition = deriveWriterPosition(vault.publicKey, writer, program.programId);
  const purchaseEscrow = deriveVaultPurchaseEscrow(
    vault.publicKey,
    writer,
    createdAt,
    program.programId
  );
  const extraAccountMetaList = deriveExtraAccountMetaListPda(
    optionMint,
    TRANSFER_HOOK_PROGRAM_ID
  );
  const hookState = deriveHookStatePda(optionMint, TRANSFER_HOOK_PROGRAM_ID);
  const buyerOptionAccount = getAssociatedTokenAddressSync(
    optionMint,
    buyer,
    false,
    TOKEN_2022_PROGRAM_ID
  );
  const buyerUsdcAccount = await getAssociatedTokenAddress(
    protocolState.usdcMint,
    buyer,
    false,
    TOKEN_PROGRAM_ID
  );

  const createOptionAta = createAssociatedTokenAccountIdempotentInstruction(
    buyer,
    buyerOptionAccount,
    buyer,
    optionMint,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const maxPremium = toUsdcBN(offering.premium * quantity * 1.05);
  const ix = await (program.methods as any)
    .purchaseFromVault(new BN(quantity), maxPremium)
    .accountsStrict({
      buyer,
      sharedVault: vault.publicKey,
      writerPosition,
      vaultMintRecord: vaultMint.publicKey,
      protocolState: protocolPda,
      market: vault.account.market,
      optionMint,
      purchaseEscrow,
      buyerOptionAccount,
      buyerUsdcAccount,
      vaultUsdcAccount: vault.account.vaultUsdcAccount,
      treasury,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
      extraAccountMetaList,
      hookState,
      systemProgram: SystemProgram.programId
    })
    .instruction();

  const tx = new Transaction().add(EXTRA_CU_800K, createOptionAta, ix);
  return finalizeAndSimulate(connection, buyer, tx, [
    "Primary vault purchase",
    `${quantity} ${offering.asset} ${offering.side.toUpperCase()}`,
    `Strike ${offering.strike}`,
    `Max premium ${(offering.premium * quantity * 1.05).toFixed(2)} USDC`,
    "Token program: SPL USDC plus Token-2022 option mint"
  ], "buy");
}

export async function buildResalePurchaseTx(params: {
  program: Program;
  connection: Connection;
  buyer: PublicKey;
  offering: Offering;
  quantity: number;
}): Promise<PendingTx> {
  const { program, connection, buyer, offering, quantity } = params;
  if (!offering.listing || !offering.seller) {
    throw new Error("Resale offering is missing listing data");
  }
  if (offering.seller.equals(buyer)) {
    throw new Error("You cannot buy your own listing");
  }

  const protocol = await loadProtocolState(program);
  const protocolPda = protocol.publicKey;
  const treasury = treasuryPda(program.programId);
  const protocolState = protocol.account;
  const optionMint = offering.vaultMint.account.optionMint as PublicKey;
  const resaleEscrow = deriveVaultResaleEscrow(offering.listing.publicKey, program.programId);
  const extraAccountMetaList = deriveExtraAccountMetaListPda(
    optionMint,
    TRANSFER_HOOK_PROGRAM_ID
  );
  const hookState = deriveHookStatePda(optionMint, TRANSFER_HOOK_PROGRAM_ID);

  const buyerOptionAccount = getAssociatedTokenAddressSync(
    optionMint,
    buyer,
    false,
    TOKEN_2022_PROGRAM_ID
  );
  const buyerUsdcAccount = await getAssociatedTokenAddress(
    protocolState.usdcMint,
    buyer,
    false,
    TOKEN_PROGRAM_ID
  );
  const sellerUsdcAccount = getAssociatedTokenAddressSync(
    protocolState.usdcMint,
    offering.seller,
    false,
    TOKEN_PROGRAM_ID
  );

  const createBuyerOptionAta = createAssociatedTokenAccountIdempotentInstruction(
    buyer,
    buyerOptionAccount,
    buyer,
    optionMint,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const createBuyerUsdcAta = createAssociatedTokenAccountIdempotentInstruction(
    buyer,
    buyerUsdcAccount,
    buyer,
    protocolState.usdcMint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  const maxTotalPrice = toUsdcBN(offering.premium * quantity);
  const ix = await (program.methods as any)
    .buyV2Resale(new BN(quantity), maxTotalPrice)
    .accountsStrict({
      buyer,
      sharedVault: offering.vault.publicKey,
      market: offering.vault.account.market,
      vaultMintRecord: offering.vaultMint.publicKey,
      listing: offering.listing.publicKey,
      seller: offering.seller,
      optionMint,
      resaleEscrow,
      buyerOptionAccount,
      buyerUsdcAccount,
      sellerUsdcAccount,
      treasury,
      protocolState: protocolPda,
      transferHookProgram: TRANSFER_HOOK_PROGRAM_ID,
      extraAccountMetaList,
      hookState,
      tokenProgram: TOKEN_PROGRAM_ID,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId
    })
    .instruction();

  const tx = new Transaction().add(EXTRA_CU_800K, createBuyerUsdcAta, createBuyerOptionAta, ix);
  return finalizeAndSimulate(connection, buyer, tx, [
    "Secondary listing purchase",
    `${quantity} ${offering.asset} ${offering.side.toUpperCase()}`,
    `Seller ${offering.seller.toBase58().slice(0, 4)}_${offering.seller.toBase58().slice(-4)}`,
    `Exact premium ${(offering.premium * quantity).toFixed(2)} USDC`,
    "Token program: SPL USDC plus Token-2022 option mint"
  ], "buy");
}
