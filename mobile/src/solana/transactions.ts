import { Program, BN } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  PublicKey,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
  Transaction
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
import type { ExerciseStyle, Offering, OptionSide, PendingTx, WriteDraft } from "../types";
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

const EXTRA_CU_400K = ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 });
const EXTRA_CU_800K = ComputeBudgetProgram.setComputeUnitLimit({ units: 800_000 });
const EXTRA_CU_1_4M = ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 });

async function finalizeAndSimulate(
  connection: Connection,
  feePayer: PublicKey,
  tx: Transaction,
  summary: string[]
): Promise<PendingTx> {
  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  tx.recentBlockhash = blockhash;
  tx.feePayer = feePayer;
  const simulation = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true
  } as any);
  const simulationError = simulation.value.err
    ? JSON.stringify(simulation.value.err)
    : null;
  return { transaction: tx, summary, simulationError };
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

export async function buildWriteDepositTx(params: {
  program: Program;
  connection: Connection;
  writer: PublicKey;
  draft: WriteDraft;
}): Promise<PendingTx> {
  const { program, connection, writer, draft } = params;
  const protocolPda = protocolStatePda(program.programId);
  const protocolState = await (program.account as any).protocolState.fetch(protocolPda);
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
  const ix = await (program.methods as any)
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

  const tx = new Transaction().add(EXTRA_CU_400K, createWriterUsdcAta, ix);
  return finalizeAndSimulate(connection, writer, tx, [
    "Writer stage 1 of 2: create/deposit",
    `${draft.market.account.assetName as string} ${draft.side.toUpperCase()} ${draft.exerciseStyle.toUpperCase()}`,
    `Strike ${draft.strike}`,
    `Expiry ${new Date(draft.expiry * 1000).toUTCString()}`,
    `Deposit ${draft.collateral.toFixed(2)} USDC collateral`,
    "Creates the vault only if it does not already exist"
  ]);
}

export async function buildWriteMintTx(params: {
  program: Program;
  connection: Connection;
  writer: PublicKey;
  draft: WriteDraft;
}): Promise<PendingTx> {
  const { program, connection, writer, draft } = params;
  const protocolPda = protocolStatePda(program.programId);
  const derived = writeDerivations(draft, writer, program.programId);
  const createdAt = new BN(Math.floor(Date.now() / 1000));
  const optionMint = deriveVaultOptionMint(derived.sharedVault, writer, createdAt, program.programId);
  const purchaseEscrow = deriveVaultPurchaseEscrow(derived.sharedVault, writer, createdAt, program.programId);
  const vaultMintRecord = deriveVaultMintRecord(optionMint, program.programId);
  const extraAccountMetaList = deriveExtraAccountMetaListPda(optionMint, TRANSFER_HOOK_PROGRAM_ID);
  const hookState = deriveHookStatePda(optionMint, TRANSFER_HOOK_PROGRAM_ID);
  const feedId = Array.from(draft.market.account.pythFeedId as number[]);
  const volOracle = deriveVolOracle(feedId, program.programId);
  const isAmerican = draft.exerciseStyle === "american";
  const premium = isAmerican ? new BN(1) : toUsdcBN(draft.premiumPerContract);
  const ix = await (program.methods as any)
    .mintFromVault(new BN(draft.contracts), premium, createdAt)
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

  const tx = new Transaction().add(isAmerican ? EXTRA_CU_1_4M : EXTRA_CU_800K, ix);
  return finalizeAndSimulate(connection, writer, tx, [
    "Writer stage 2 of 2: mint option tokens",
    `${draft.contracts} contracts`,
    isAmerican
      ? "American premium is computed on-chain during mint"
      : `Premium ${draft.premiumPerContract.toFixed(2)} USDC per contract`,
    `Option mint ${optionMint.toBase58().slice(0, 4)}_${optionMint.toBase58().slice(-4)}`,
    "Token program: Token-2022 option mint with transfer hook metadata"
  ]);
}

export async function buildPrimaryPurchaseTx(params: {
  program: Program;
  connection: Connection;
  buyer: PublicKey;
  offering: Offering;
  quantity: number;
}): Promise<PendingTx> {
  const { program, connection, buyer, offering, quantity } = params;
  const protocolPda = protocolStatePda(program.programId);
  const treasury = treasuryPda(program.programId);
  const protocolState = await (program.account as any).protocolState.fetch(protocolPda);

  const vault = offering.vault;
  const vaultMint = offering.vaultMint;
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
  ]);
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

  const protocolPda = protocolStatePda(program.programId);
  const treasury = treasuryPda(program.programId);
  const protocolState = await (program.account as any).protocolState.fetch(protocolPda);
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
  ]);
}
