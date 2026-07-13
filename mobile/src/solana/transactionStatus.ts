import type {
  BlockheightBasedTransactionConfirmationStrategy,
  Commitment,
  Connection,
  SignatureStatus
} from "@solana/web3.js";
import type {
  PendingTx,
  SubmittedTransaction,
  TransactionKind,
  TransactionStatusResult
} from "../types";
import { ensureDevnetConnection } from "./cluster";

export function createSubmittedTransaction(
  pending: PendingTx,
  signature: string,
  kind: TransactionKind = pending.kind ?? "buy",
  submittedAt = Date.now()
): SubmittedTransaction {
  if (!pending.blockhash || pending.lastValidBlockHeight == null) {
    throw new Error("The submitted transaction is missing its blockhash confirmation context.");
  }
  if (!signature.trim()) throw new Error("The wallet did not return a transaction signature.");
  return {
    signature: signature.trim(),
    kind,
    blockhash: pending.blockhash,
    lastValidBlockHeight: pending.lastValidBlockHeight,
    submittedAt
  };
}

export function confirmationStrategyFor(
  submitted: SubmittedTransaction
): BlockheightBasedTransactionConfirmationStrategy {
  return {
    signature: submitted.signature,
    blockhash: submitted.blockhash,
    lastValidBlockHeight: submitted.lastValidBlockHeight
  };
}

export function submittedStatus(submitted: SubmittedTransaction): TransactionStatusResult {
  return {
    signature: submitted.signature,
    state: "submitted",
    checkedAt: submitted.submittedAt,
    slot: null,
    confirmationStatus: null,
    error: null
  };
}

/** Waits for confirmation once; failures fall back to a read-only status check. */
export async function confirmSubmittedTransaction(
  connection: Connection,
  submitted: SubmittedTransaction,
  commitment: Commitment = "confirmed"
): Promise<TransactionStatusResult> {
  try {
    await ensureDevnetConnection(connection);
    const confirmation = await connection.confirmTransaction(
      confirmationStrategyFor(submitted),
      commitment
    );
    if (confirmation.value.err) {
      return result(submitted.signature, "failed", confirmation.context.slot, commitmentStatus(commitment), confirmation.value.err);
    }
    return result(submitted.signature, "confirmed", confirmation.context.slot, commitmentStatus(commitment), null);
  } catch (confirmError) {
    const checked = await checkSubmittedTransactionStatus(connection, submitted);
    if (checked.state !== "unknown" || checked.error) return checked;
    return { ...checked, error: errorText(confirmError) };
  }
}

/**
 * Rechecks only the submitted signature. It never signs, sends, rebuilds, or
 * substitutes a new blockhash, so an unknown write cannot duplicate collateral.
 */
export async function checkSubmittedTransactionStatus(
  connection: Connection,
  submitted: SubmittedTransaction
): Promise<TransactionStatusResult> {
  try {
    await ensureDevnetConnection(connection);
    const response = await connection.getSignatureStatuses(
      [submitted.signature],
      { searchTransactionHistory: true }
    );
    const status = response.value[0];
    if (!status) {
      const blockHeight = await connection.getBlockHeight("confirmed");
      if (blockHeight > submitted.lastValidBlockHeight) {
        return result(
          submitted.signature,
          "failed",
          response.context.slot,
          null,
          "Transaction expired before landing. Nothing was sent."
        );
      }
      return result(submitted.signature, "unknown", response.context.slot, null, null);
    }
    return statusResult(submitted.signature, status);
  } catch (err) {
    return result(submitted.signature, "unknown", null, null, err);
  }
}

function statusResult(signature: string, status: SignatureStatus): TransactionStatusResult {
  const confirmationStatus = status.confirmationStatus
    ?? (status.confirmations === null ? "finalized" : "processed");
  if (status.err) {
    return result(signature, "failed", status.slot, confirmationStatus, status.err);
  }
  if (confirmationStatus === "confirmed" || confirmationStatus === "finalized") {
    return result(signature, "confirmed", status.slot, confirmationStatus, null);
  }
  return result(signature, "unknown", status.slot, confirmationStatus, null);
}

function result(
  signature: string,
  state: TransactionStatusResult["state"],
  slot: number | null,
  confirmationStatus: TransactionStatusResult["confirmationStatus"],
  error: unknown
): TransactionStatusResult {
  return {
    signature,
    state,
    checkedAt: Date.now(),
    slot,
    confirmationStatus,
    error: error == null ? null : errorText(error)
  };
}

function commitmentStatus(commitment: Commitment): TransactionStatusResult["confirmationStatus"] {
  if (commitment === "finalized" || commitment === "max" || commitment === "root") return "finalized";
  if (commitment === "confirmed" || commitment === "single" || commitment === "singleGossip") return "confirmed";
  return "processed";
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return "Transaction status could not be determined.";
  }
}
