import type { PublicKey, Transaction } from "@solana/web3.js";

export type AccountRecord<T = any> = {
  publicKey: PublicKey;
  account: T;
};

export type OptionSide = "call" | "put";
export type ExerciseStyle = "european" | "american";
export type OfferingKind = "vault" | "resale";

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
  offerings: Offering[];
  assets: string[];
  expiriesByAsset: Record<string, number[]>;
  fetchedAt: number;
};

export type WalletPosition = {
  id: string;
  asset: string;
  side: OptionSide;
  strike: number;
  expiry: number;
  balance: number;
  premiumPaid: number;
  currentMark: number | null;
};

export type PendingTx = {
  transaction: Transaction;
  summary: string[];
  simulationError: string | null;
  ctaLabel?: string;
  successMessage?: string;
  afterSignature?: (signature: string) => Promise<void>;
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
