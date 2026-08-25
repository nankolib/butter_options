import type { PublicKey, Transaction } from "@solana/web3.js";

export type AccountRecord<T = any> = {
  publicKey: PublicKey;
  account: T;
};

export type OptionSide = "call" | "put";
export type ExerciseStyle = "european" | "american";
export type OfferingKind = "vault" | "resale";
export type PositionState =
  | "live"
  | "settledITM"
  | "settledOTM"
  | "expired"
  | "metaUnavailable";
export type TransactionKind = "buy" | "write";
export type SubmittedTransactionState = "submitted" | "confirmed" | "failed" | "unknown";
export type EpochTenor = "weekly" | "monthly" | "quarterly";

export type OptaMarket = AccountRecord;
export type OptaVault = AccountRecord;
export type OptaVaultMint = AccountRecord;
export type OptaListing = AccountRecord;

export type Offering = {
  id: string;
  kind: OfferingKind;
  side: OptionSide;
  asset: string;
  strike: number;
  expiry: number;
  premium: number;
  quantityAvailable: number;
  exerciseStyle: ExerciseStyle;
  market: OptaMarket;
  vault: OptaVault;
  vaultMint: OptaVaultMint;
  listing?: OptaListing;
  seller?: PublicKey;
};

export type MarketSnapshot = {
  markets: OptaMarket[];
  vaults: OptaVault[];
  vaultMints: OptaVaultMint[];
  listings: OptaListing[];
  spotByAsset: Record<string, number>;
  spotStatusByAsset: Record<string, "live" | "stale">;
  /** FIX C: false until the deferred spot stage has run for this snapshot. */
  spotResolved: boolean;
  offerings: Offering[];
  assets: string[];
  expiriesByAsset: Record<string, number[]>;
  fetchedAt: number;
};

export type WalletPosition = {
  id: string;
  mint: PublicKey;
  vault?: PublicKey;
  asset: string;
  side: OptionSide;
  exerciseStyle: ExerciseStyle;
  strike: number;
  expiry: number;
  balance: number;
  premiumPaid: number | null;
  currentMark: number | null;
  settlementPrice: number | null;
  state: PositionState;
  metadataError?: string;
};

export type WalletWriterPosition = {
  id: string;
  position: PublicKey;
  vault: PublicKey;
  asset: string;
  side: OptionSide;
  exerciseStyle: ExerciseStyle;
  strike: number;
  expiry: number;
  shares: number;
  collateralDeposited: number;
  optionsMinted: number;
  optionsSold: number;
  premiumClaimed: number;
  claimablePremium: number | null;
  currentMark: number | null;
  settlementPrice: number | null;
  state: PositionState;
  metadataError?: string;
};

export type WalletPortfolio = {
  holdings: WalletPosition[];
  written: WalletWriterPosition[];
  fetchedAt: number;
};

export type PendingTx = {
  transaction: Transaction;
  summary: string[];
  simulationError: string | null;
  kind?: TransactionKind;
  blockhash?: string;
  lastValidBlockHeight?: number;
  builtAt?: number;
  resultAccounts?: {
    vault?: PublicKey;
    optionMint?: PublicKey;
  };
  ctaLabel?: string;
  successMessage?: string;
  afterSignature?: (signature: string) => Promise<void>;
};

export type SubmittedTransaction = {
  signature: string;
  kind: TransactionKind;
  blockhash: string;
  lastValidBlockHeight: number;
  submittedAt: number;
};

export type TransactionStatusResult = {
  signature: string;
  state: SubmittedTransactionState;
  checkedAt: number;
  slot: number | null;
  confirmationStatus: "processed" | "confirmed" | "finalized" | null;
  error: string | null;
};

export type EpochConfigSnapshot = {
  publicKey: PublicKey;
  authority: PublicKey;
  weeklyExpiryDay: number;
  weeklyExpiryHour: number;
  monthlyEnabled: boolean;
  minEpochDurationDays: number;
  bump: number;
};

export type EpochTenorCandidate = {
  tenor: EpochTenor;
  expiry: number;
};

export type EpochTenorSchedule = {
  config: EpochConfigSnapshot;
  candidates: EpochTenorCandidate[];
  fetchedAt: number;
};

export type WriteDraft = {
  market: OptaMarket;
  side: OptionSide;
  exerciseStyle: ExerciseStyle;
  strike: number;
  expiry: number;
  contracts: number;
  premiumPerContract: number;
  collateral: number;
  vaultType: "epoch" | "custom";
};
