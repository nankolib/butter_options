import type { PendingTx, SubmittedTransaction } from "../types";
import type { ExerciseStyle, OptionSide } from "../types";

export type AppTab = "trade" | "write" | "portfolio";

export type ConnectionPhase =
  | "disconnected"
  | "connecting"
  | "connected"
  | "rejected";

export type DataPhase = "loading" | "loaded" | "empty" | "error";
export type PricePhase = "live" | "stale";

export type ToastTone = "success" | "info" | "error";

export type ToastMessage = {
  id: number;
  tone: ToastTone;
  title: string;
  message?: string;
  signature?: string;
};

export type TradeSelection = {
  asset: string;
  expiry: number;
  side: OptionSide;
  quantity: number;
  offeringId: string | null;
};

export type EpochTenor = "weekly" | "monthly" | "quarterly";

export type WriteFormState = {
  asset: string;
  side: OptionSide;
  exerciseStyle: ExerciseStyle;
  vaultType: "epoch" | "custom";
  strike: string;
  contracts: number;
  tenor: EpochTenor;
  customExpiry: string;
};

export type TxKind = "buy" | "write";

export type TxUiPhase =
  | "idle"
  | "review"
  | "simulating"
  | "awaitingWallet"
  | "sending"
  | "confirming"
  | "confirmed"
  | "failed"
  | "unknown"
  | "checking";

export type TxReviewRow = {
  label: string;
  value: string;
};

export type TxIntent = {
  kind: TxKind;
  contractCount: number;
  title: string;
  rows: TxReviewRow[];
  submitLabel: string;
  confirmedMessage: string;
  build: () => Promise<PendingTx>;
};

export type TxFlowState = {
  phase: TxUiPhase;
  intent: TxIntent | null;
  pending: PendingTx | null;
  submitted: SubmittedTransaction | null;
  signature: string | null;
  error: string | null;
};
